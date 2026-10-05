// Rokit · 内置浏览器自动填充通用脚本（v1.7）
// ----------------------------------------------------------------
// 设计原则（与需求文档第十一条对应）：
//   1. 不依赖容易变化的 CSS class，优先使用 id / name / aria-label / placeholder / data-* /
//      [contenteditable] 等语义化选择器。
//   2. 对 <input> / <textarea> / [contenteditable] 分别提供独立填充函数，
//      每种都触发 input + change + keydown + keyup + blur，让 React/Vue
//      这种基于事件驱动 state 更新的框架能正确识别"用户输入了内容"。
//   3. 不在任何路径下自动点击 submit / 发布 / 提交 按钮（仅在调用方显式
//      调用 triggerClick 时才会点击；测试平台默认不调用）。
//   4. 所有函数都是**在目标网页中执行**的字符串，由 BrowserManager 通过
//      executeJavaScript 注入；payload 通过 JSON.stringify 安全序列化。
//
// 本文件**只导出字符串与工厂函数**，避免把 Node 端对象意外暴露到 Web。
'use strict';

// 通用：把 (fnBody, payload) 拼成一个 IIFE 字符串，payload 已 JSON 序列化
// 注意：浏览器端没有 JSON.parse 限制，此处直接 eval 即可
function wrap(fnBody, payload) {
  return '(' + fnBody + ')(' + JSON.stringify(payload || {}) + ')';
}

// ----------------------------------------------------------------
// 1) fillInput — 填写 <input type=text|search|email|url|...>，
//    React 16+ 的受控 input 会拒绝简单赋值，必须使用 native setter。
// ----------------------------------------------------------------
var FILL_INPUT_FN = "function filter(resolved){\n" +
"  var el = resolved.el;\n" +
"  if(!el) return { ok:false, error:'input-not-found' };\n" +
"  if(typeof el.focus === 'function') el.focus();\n" +
"  // 兼容 React 16+ 的 value tracking\n" +
"  var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;\n" +
"  var setter = Object.getOwnPropertyDescriptor(proto, 'value');\n" +
"  if(setter && setter.set) setter.set.call(el, String(resolved.value || ''));\n" +
"  else el.value = String(resolved.value || '');\n" +
"  // 触发一系列事件，让 React / Vue 的 state 同步\n" +
"  el.dispatchEvent(new InputEvent('input', { bubbles:true, cancelable:true, data:String(resolved.value||''), inputType:'insertText' }));\n" +
"  el.dispatchEvent(new Event('change', { bubbles:true }));\n" +
"  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, cancelable:true }));\n" +
"  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles:true, cancelable:true }));\n" +
"  if(typeof el.blur === 'function') el.blur();\n" +
"  return { ok:true, value: el.value, name: el.name || el.id || '' };\n" +
"}\n";

// ----------------------------------------------------------------
// 2) fillContentEditable — 填写 <div contenteditable> / 富文本编辑器
//    用 execCommand('insertText') 模拟粘贴，能触发框架事件。
// ----------------------------------------------------------------
var FILL_CONTENTEDITABLE_FN = "function fillce(resolved){\n" +
"  var el = resolved.el;\n" +
"  if(!el) return { ok:false, error:'editable-not-found' };\n" +
"  if(typeof el.focus === 'function') el.focus();\n" +
"  // 先清空（保留一个换行，避免某些编辑器进入空态异常）\n" +
"  try { document.execCommand('selectAll', false, null); } catch(_e) {}\n" +
"  var text = String(resolved.value || '');\n" +
"  var ok = false;\n" +
"  try {\n" +
"    ok = document.execCommand('insertText', false, text);\n" +
"  } catch(_e) { ok = false; }\n" +
"  if(!ok){\n" +
"    // 兜底：直接修改 textContent（仅对部分不使用框架的页面有效）\n" +
"    el.textContent = text;\n" +
"    el.dispatchEvent(new InputEvent('input', { bubbles:true, cancelable:true }));\n" +
"    el.dispatchEvent(new Event('change', { bubbles:true }));\n" +
"  }\n" +
"  el.dispatchEvent(new Event('blur', { bubbles:true }));\n" +
"  return { ok:true, length: (el.textContent || el.innerText || '').length };\n" +
"}\n";

// ----------------------------------------------------------------
// 3) resolveSelector — 在多个备选选择器中找到第一个可见且可编辑的元素
// ----------------------------------------------------------------
var RESOLVE_SELECTOR_FN =
"function resolveOne(selectors, opts){\n" +
"  opts = opts || {};\n" +
"  var allowInvisible = !!opts.allowInvisible;\n" +
"  if(!Array.isArray(selectors)) selectors = [selectors];\n" +
"  for(var i=0;i<selectors.length;i++){\n" +
"    var sel = selectors[i];\n" +
"    if(!sel) continue;\n" +
"    var nodes = document.querySelectorAll(sel);\n" +
"    for(var j=0;j<nodes.length;j++){\n" +
"      var el = nodes[j];\n" +
"      if(!el) continue;\n" +
"      if(allowInvisible) return el;\n" +
"      // 可见性粗略判断\n" +
"      var rect = el.getBoundingClientRect();\n" +
"      if(rect.width<=0 || rect.height<=0) continue;\n" +
"      var style = window.getComputedStyle(el);\n" +
"      if(style.visibility === 'hidden' || style.display === 'none') continue;\n" +
"      return el;\n" +
"    }\n" +
"  }\n" +
"  return null;\n" +
"}\n";

// ----------------------------------------------------------------
// 4) detectLogin — 给定一组「登录态指示器」和「未登录指示器」，
//    返回 'logged_in' / 'logged_out' / 'unknown'。
//    指示器可以是选择器数组或文本匹配函数（但函数无法序列化，只能传选择器）。
// ----------------------------------------------------------------
var DETECT_LOGIN_FN =
"function detectLogin(cfg){\n" +
"  cfg = cfg || {};\n" +
"  var inSelectors = cfg.inSelectors || [];\n" +
"  var outSelectors = cfg.outSelectors || [];\n" +
"  // 未登录指示器优先：看到登录按钮 / 登录表单 → 明确未登录\n" +
"  for(var i=0;i<outSelectors.length;i++){\n" +
"    var nodes = document.querySelectorAll(outSelectors[i]);\n" +
"    for(var j=0;j<nodes.length;j++){\n" +
"      var el = nodes[j];\n" +
"      if(!el) continue;\n" +
"      var rect = el.getBoundingClientRect();\n" +
"      if(rect.width>0 && rect.height>0){\n" +
"        var s = window.getComputedStyle(el);\n" +
"        if(s.visibility !== 'hidden' && s.display !== 'none'){\n" +
"          return { status:'logged_out' };\n" +
"        }\n" +
"      }\n" +
"    }\n" +
"  }\n" +
"  // 已登录指示器\n" +
"  for(var k=0;k<inSelectors.length;k++){\n" +
"    if(document.querySelector(inSelectors[k])){\n" +
"      return { status:'logged_in' };\n" +
"    }\n" +
"  }\n" +
"  return { status:'unknown' };\n" +
"}\n";

// ----------------------------------------------------------------
// 5) extractFillData — 从 publish task 中提取标题 / 正文
// ----------------------------------------------------------------
function extractFillData(payload) {
  var p = payload || {};
  var title = (p.title || '').toString();
  var content = (p.content != null ? p.content : (p.body || '')).toString();
  var images = Array.isArray(p.images) ? p.images.map(function (x) { return String(x); }) : [];
  var videoPath = p.videoPath ? String(p.videoPath) : null;
  return { title: title, content: content, images: images, videoPath: videoPath };
}

// ----------------------------------------------------------------
// 6) 给 Publisher 用的「在页面里运行」的填充脚本：
//    把 selectors 与填充数据合并成一个 IIFE
// ----------------------------------------------------------------
function buildFillScript(platformSelects, fillData) {
  var payload = {
    titleSelectors: platformSelects.title || [],
    contentSelectors: platformSelects.content || [],
    imagesSelectors: platformSelects.images || [],
    fillData: fillData
  };
  return wrap(
    '(async function(p){\n' +
      RESOLVE_SELECTOR_FN + '\n' +
      FILL_INPUT_FN + '\n' +
      FILL_CONTENTEDITABLE_FN + '\n' +
      'var result = { ok: true, filled: {} };\n' +
      'if(p.titleSelectors && p.titleSelectors.length){\n' +
      '  var te = resolveOne(p.titleSelectors);\n' +
      '  var tr = fillData({ el: te, value: p.fillData.title || "" });\n' +
      '  result.filled.title = tr;\n' +
      '  if(!tr.ok) result.ok = false;\n' +
      '}\n' +
      'if(p.contentSelectors && p.contentSelectors.length){\n' +
      '  var ce = resolveOne(p.contentSelectors);\n' +
      '  var cr;\n' +
      '  if(ce && ce.tagName === "TEXTAREA"){\n' +
      '    cr = fillData({ el: ce, value: p.fillData.content || "" });\n' +
      '  } else if(ce){\n' +
      '    cr = fillce({ el: ce, value: p.fillData.content || "" });\n' +
      '  } else {\n' +
      '    cr = { ok: false, error: "content-not-found" };\n' +
      '  }\n' +
      '  result.filled.content = cr;\n' +
      '  if(!cr.ok) result.ok = false;\n' +
      '}\n' +
      'return result;\n' +
    '})',
    payload
  );
}

// ----------------------------------------------------------------
// 7) 登录检测脚本（可直接 executeJavaScript 运行）
// ----------------------------------------------------------------
function buildLoginScript(loginConfig) {
  return wrap(DETECT_LOGIN_FN, loginConfig || {});
}

// ----------------------------------------------------------------
// 8) 标记「内容已自动填充，请手动确认」横幅
//    不会自动点击任何 submit / 发布 / 提交 按钮。
// ----------------------------------------------------------------
var SHOW_BANNER_FN =
"function showBanner(opts){\n" +
"  try{\n" +
"    var id='rokit-fill-banner';\n" +
"    var old=document.getElementById(id);if(old&&old.parentNode)old.parentNode.removeChild(old);\n" +
"    var bar=document.createElement('div');\n" +
"    bar.id=id;\n" +
"    bar.setAttribute('data-rokit','autofill-banner');\n" +
"    bar.style.cssText='position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0E7C7B;color:#fff;padding:10px 14px;font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.15);';\n" +
"    bar.textContent='Rokit：内容已自动填充，请检查后手动点击「发布/投稿/提交」按钮确认。';\n" +
"    if(opts && opts.platformName){ bar.textContent='Rokit ['+opts.platformName+']：内容已自动填充，请手动点击「发布」按钮确认。'; }\n" +
"    document.body.appendChild(bar);\n" +
"  }catch(_e){}\n" +
"}\n";

function buildBannerScript(platformName) {
  return wrap(SHOW_BANNER_FN, { platformName: platformName || '' });
}

module.exports = {
  extractFillData: extractFillData,
  buildFillScript: buildFillScript,
  buildLoginScript: buildLoginScript,
  buildBannerScript: buildBannerScript,
  wrap: wrap,
  // 内部函数常量（导出供平台 publisher 在自定义 IIFE 里复用，例如 ZhihuPublisher /
  // V2EXPublisher 走"等待 + 填 + 验证"复合脚本时直接拼入这些字符串。
  // 调用方需用 buildFillScript / buildLoginScript / buildBannerScript 包装 payload。
  RESOLVE_SELECTOR_FN: RESOLVE_SELECTOR_FN,
  FILL_INPUT_FN: FILL_INPUT_FN,
  FILL_CONTENTEDITABLE_FN: FILL_CONTENTEDITABLE_FN,
  DETECT_LOGIN_FN: DETECT_LOGIN_FN,
  SHOW_BANNER_FN: SHOW_BANNER_FN
};