// Rokit · Product Hunt 填写阶段 IIFE 脚本（v1）
// ----------------------------------------------------------------
// 职责：把传入的 product name / tagline / description / website 写入
//       Product Hunt 提交页对应字段；记录每个字段是否成功；输出结果。
//
// 设计原则：
//   - **不**依赖容易变化的 CSS class；优先 id / name / aria-label /
//     placeholder / data-* / contenteditable。
//   - **真实输入事件**：textarea / input 走原生 setter + InputEvent + change，
//     contenteditable 走 Range + execCommand('insertText')，让 React/Vue
//     受控组件的 state 同步更新。
//   - **永不**自动点击 Product Hunt 的「Next / Submit / Publish」按钮。
//
// 输入（payload）：
//   p.fillData.name        - Product name（短）
//   p.fillData.tagline     - 一句话说明（≤ 60 字符）
//   p.fillData.description - 完整描述（可换行）
//   p.fillData.url         - 产品网站 URL
//   p.selectors.name       - 候选 selector 列表
//   p.selectors.tagline
//   p.selectors.description
//   p.selectors.url
//   p.pollIntervalMs / maxAttempts / verifyDelayMs
//
// 输出：
//   {
//     ok, fields: { name, tagline, description, url },
//     contentBeforeLen, contentAfterLen（基于 description 字段）,
//     targetPreview, actualPreview,
//     attempts, elapsedMs
//   }
'use strict';

// 工具方法：把 selector 列表的可见元素（排除 type=hidden / display:none / visibility:hidden）
function detectVisible(selectors) {
  if (!Array.isArray(selectors)) selectors = [selectors];
  for (var i = 0; i < selectors.length; i++) {
    var sel = selectors[i];
    if (!sel) continue;
    var nodes;
    try { nodes = document.querySelectorAll(sel); }
    catch (_e) { continue; }  // 无效 selector 跳过
    for (var j = 0; j < nodes.length; j++) {
      var el = nodes[j];
      if (!el) continue;
      if (el.disabled === true) continue;
      if (el.type === 'hidden') continue;
      var rect = el.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      var style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      return { el: el, selectorMatched: sel, indexInList: j };
    }
  }
  return null;
}

// 工具方法：读取 input/textarea/contenteditable 的实际内容
function readValue(el) {
  if (!el) return '';
  var tag = (el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'INPUT') return String(el.value || '');
  return String(el.textContent || el.innerText || '');
}

// 真实输入事件填表：textarea/input 走原生 setter；contenteditable 走 Range+execCommand
function fillField(el, text) {
  try {
    if (typeof el.focus === 'function') el.focus();
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      var proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(el, String(text || ''));
      else el.value = String(text || '');
      el.dispatchEvent(new InputEvent('input',  { bubbles: true, cancelable: true, data: String(text || ''), inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, method: 'native-setter' };
    }
    // contenteditable
    var sel = window.getSelection();
    if (sel && document.createRange) {
      try {
        var range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_e) {}
    }
    var ok = false;
    try { ok = document.execCommand('insertText', false, String(text || '')); } catch (_e) { ok = false; }
    var method = ok ? 'execCommand-insertText-range' : 'fallback-textContent';
    if (!ok) {
      el.textContent = String(text || '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, method: method };
  } catch (e) {
    return { ok: false, method: 'exception', error: String((e && e.message) || e) };
  }
}

function buildProductHuntPrepareScript(opts) {
  var o = opts || {};
  var selectors = o.selectors || {};
  var fillData = o.fillData || {};
  var pollIntervalMs = Number(o.pollIntervalMs) || 800;
  var maxAttempts = Number(o.maxAttempts) || 15;
  var verifyDelayMs = Number(o.verifyDelayMs) || 800;

  var payload = JSON.stringify({
    selectors: {
      name:        Array.isArray(selectors.name)        ? selectors.name        : [],
      tagline:     Array.isArray(selectors.tagline)     ? selectors.tagline     : [],
      description: Array.isArray(selectors.description) ? selectors.description : [],
      url:         Array.isArray(selectors.url)         ? selectors.url         : []
    },
    fillData: {
      name:        String((fillData && fillData.name)        || ''),
      tagline:     String((fillData && fillData.tagline)     || ''),
      description: String((fillData && fillData.description) || ''),
      url:         String((fillData && fillData.url)         || '')
    },
    pollIntervalMs: pollIntervalMs,
    maxAttempts: maxAttempts,
    verifyDelayMs: verifyDelayMs
  });

  var FN =
    'var log = function(msg, extra){ try{ console.log("[ProductHunt][diag] " + msg + (extra ? " " + JSON.stringify(extra) : "")); }catch(_e){} };\n' +
    'function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    'function detectVisible(selectors){\n' +
    '  if(!Array.isArray(selectors)) selectors = [selectors];\n' +
    '  for(var i=0;i<selectors.length;i++){\n' +
    '    var sel=selectors[i]; if(!sel) continue;\n' +
    '    var nodes;\n' +
    '    try{ nodes=document.querySelectorAll(sel); }catch(_e){ continue; }\n' +
    '    for(var j=0;j<nodes.length;j++){\n' +
    '      var el=nodes[j]; if(!el) continue;\n' +
    '      if(el.disabled===true) continue;\n' +
    '      if(el.type==="hidden") continue;\n' +
    '      var rect=el.getBoundingClientRect();\n' +
    '      if(!rect||rect.width<=0||rect.height<=0) continue;\n' +
    '      var style=window.getComputedStyle(el);\n' +
    '      if(style.visibility==="hidden"||style.display==="none") continue;\n' +
    '      return { el:el, selectorMatched:sel, indexInList:j };\n' +
    '    }\n' +
    '  }\n' +
    '  return null;\n' +
    '}\n' +
    'function readValue(el){\n' +
    '  if(!el) return "";\n' +
    '  var tag=(el.tagName||"").toUpperCase();\n' +
    '  if(tag==="TEXTAREA"||tag==="INPUT") return String(el.value||"");\n' +
    '  return String(el.textContent||el.innerText||"");\n' +
    '}\n' +
    'function fillField(el, text){\n' +
    '  try{\n' +
    '    if(typeof el.focus==="function") el.focus();\n' +
    '    var tag=(el.tagName||"").toUpperCase();\n' +
    '    if(tag==="TEXTAREA"||tag==="INPUT"){\n' +
    '      var proto=tag==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;\n' +
    '      var setter=Object.getOwnPropertyDescriptor(proto,"value").set;\n' +
    '      if(setter) setter.call(el, String(text||""));\n' +
    '      else el.value=String(text||"");\n' +
    '      el.dispatchEvent(new InputEvent("input", { bubbles:true, cancelable:true, data:String(text||""), inputType:"insertText" }));\n' +
    '      el.dispatchEvent(new Event("change", { bubbles:true }));\n' +
    '      return { ok:true, method:"native-setter" };\n' +
    '    }\n' +
    '    var sel=window.getSelection();\n' +
    '    if(sel && document.createRange){\n' +
    '      try{\n' +
    '        var range=document.createRange();\n' +
    '        range.selectNodeContents(el);\n' +
    '        sel.removeAllRanges();\n' +
    '        sel.addRange(range);\n' +
    '      }catch(_e){}\n' +
    '    }\n' +
    '    var ok=false;\n' +
    '    try{ ok=document.execCommand("insertText", false, String(text||"")); }catch(_e){ ok=false; }\n' +
    '    var method=ok?"execCommand-insertText-range":"fallback-textContent";\n' +
    '    if(!ok){\n' +
    '      el.textContent=String(text||"");\n' +
    '      el.dispatchEvent(new InputEvent("input", { bubbles:true, cancelable:true, inputType:"insertText" }));\n' +
    '      el.dispatchEvent(new Event("change", { bubbles:true }));\n' +
    '    }\n' +
    '    return { ok:true, method:method };\n' +
    '  }catch(e){\n' +
    '    return { ok:false, method:"exception", error:String((e&&e.message)||e) };\n' +
    '  }\n' +
    '}\n' +
    'function snapshot(el){\n' +
    '  if(!el) return null;\n' +
    '  var rect=el.getBoundingClientRect();\n' +
    '  var style=window.getComputedStyle(el);\n' +
    '  return {\n' +
    '    tagName:el.tagName,\n' +
    '    name:(el.getAttribute&&el.getAttribute("name"))||"",\n' +
    '    id:el.id||"",\n' +
    '    type:(el.getAttribute&&el.getAttribute("type"))||"",\n' +
    '    ariaLabel:(el.getAttribute&&el.getAttribute("aria-label"))||"",\n' +
    '    placeholder:(el.getAttribute&&el.getAttribute("placeholder"))||"",\n' +
    '    visible:!!(rect && rect.width>0 && rect.height>0 && style.visibility!=="hidden" && style.display!=="none"),\n' +
    '    height:rect?Math.round(rect.height):0,\n' +
    '    width:rect?Math.round(rect.width):0\n' +
    '  };\n' +
    '}\n';

  var BODY =
    'var p2 = p;\n' +
    'var result = {\n' +
    '  ok:false,\n' +
    '  fields: { name:null, tagline:null, description:null, url:null },\n' +
    '  contentBeforeLen:0, contentAfterLen:0,\n' +
    '  targetPreview:"", actualPreview:"",\n' +
    '  attempts:0, elapsedMs:0\n' +
    '};\n' +
    'var startedAt=Date.now();\n' +
    'log("prepare start", { maxAttempts: p2.maxAttempts, pollIntervalMs: p2.pollIntervalMs });\n' +
    'try{\n' +
    '  var fields = [\n' +
    '    { key:"name",        sels:p2.selectors.name        || [], text:p2.fillData.name        || "" },\n' +
    '    { key:"tagline",     sels:p2.selectors.tagline     || [], text:p2.fillData.tagline     || "" },\n' +
    '    { key:"description", sels:p2.selectors.description || [], text:p2.fillData.description || "" },\n' +
    '    { key:"url",         sels:p2.selectors.url         || [], text:p2.fillData.url         || "" }\n' +
    '  ];\n' +
    // ---- 第一遍：仅探测，记录每个字段命中哪个 selector ----
    '  for(var fi=0; fi<fields.length; fi++){\n' +
    '    var f = fields[fi];\n' +
    '    if(!f.text){ log("field skipped (empty)", { key:f.key }); continue; }\n' +
    '    var found = null;\n' +
    '    for(var attempt=1; attempt<=p2.maxAttempts; attempt++){\n' +
    '      result.attempts = attempt;\n' +
    '      found = detectVisible(f.sels);\n' +
    '      if(found){ break; }\n' +
    '      await sleep(p2.pollIntervalMs);\n' +
    '    }\n' +
    '    if(!found){\n' +
    '      result.fields[f.key] = { ok:false, error:"selector-not-found", selectorTried:f.sels.length, attempts:result.attempts };\n' +
    '      log("field selector NOT FOUND", { key:f.key, tried: f.sels.length, attempts: result.attempts });\n' +
    '      continue;\n' +
    '    }\n' +
    '    log("field found", { key:f.key, selector: found.selectorMatched, tag: found.el.tagName });\n' +
    // 记录 description 字段的 before 长度（用于 readBack 校验）
    '    var beforeLen = (f.key === "description") ? readValue(found.el).length : 0;\n' +
    '    var fr = fillField(found.el, f.text);\n' +
    '    if(!fr || !fr.ok){\n' +
    '      result.fields[f.key] = { ok:false, error:(fr&&fr.error)||"fill-returned-not-ok", selectorMatched: found.selectorMatched, snapshot: snapshot(found.el) };\n' +
    '      log("field fill FAILED", { key:f.key, error: (fr&&fr.error) });\n' +
    '      continue;\n' +
    '    }\n' +
    '    await sleep(p2.verifyDelayMs);\n' +
    '    var actual = readValue(found.el);\n' +
    '    var afterLen = actual.length;\n' +
    '    if(f.key === "description"){\n' +
    '      result.contentBeforeLen = beforeLen;\n' +
    '      result.contentAfterLen  = afterLen;\n' +
    '      result.targetPreview    = f.text.slice(0, 50);\n' +
    '      result.actualPreview    = actual.slice(0, 50);\n' +
    '    }\n' +
    '    var preview = f.text.slice(0, Math.min(20, f.text.length));\n' +
    '    var previewFound = (preview.length === 0) || (actual.indexOf(preview) !== -1);\n' +
    '    result.fields[f.key] = {\n' +
    '      ok: previewFound,\n' +
    '      fillMethod: fr.method,\n' +
    '      selectorMatched: found.selectorMatched,\n' +
    '      beforeLen: beforeLen,\n' +
    '      afterLen:  afterLen,\n' +
    '      snapshot:  snapshot(found.el)\n' +
    '    };\n' +
    '    if(previewFound){\n' +
    '      log("field fill success", { key:f.key, method: fr.method, beforeLen: beforeLen, afterLen: afterLen });\n' +
    '    } else {\n' +
    '      result.fields[f.key].error = "preview-not-found-in-actual";\n' +
    '      log("field fill FAILED: preview not found", { key:f.key, actual: actual.slice(0,50) });\n' +
    '    }\n' +
    '  }\n' +
    '  result.elapsedMs = Date.now() - startedAt;\n' +
    // ---- 汇总 ----
    // 至少 description 字段成功；name 字段也建议成功（缺一可软警告但不阻塞整体 ok）
    '  var filled = 0; var failed = 0;\n' +
    '  for(var k in result.fields){\n' +
    '    if(!result.fields[k]) continue;\n' +
    '    if(result.fields[k].ok) filled++;\n' +
    '    else if(result.fields[k].error) failed++;\n' +
    '  }\n' +
    '  if(filled > 0 && result.fields.description && result.fields.description.ok){\n' +
    '    result.ok = true;\n' +
    '    log("PREPARE SUCCESS", { filled: filled, failed: failed });\n' +
    '  } else {\n' +
    '    result.ok = false;\n' +
    '    result.error = "no-field-filled-or-description-missing";\n' +
    '    log("PREPARE FAILED", { filled: filled, failed: failed });\n' +
    '  }\n' +
    '}catch(e){\n' +
    '  result.ok = false; result.error = String((e&&e.message)||e);\n' +
    '  try{ console.log("[ProductHunt][diag] prepare EXCEPTION " + result.error); }catch(_e){}\n' +
    '}\n' +
    'return result;\n';

  return '(async function(p){\n' + FN + BODY + '})(' + payload + ')';
}

module.exports = {
  buildProductHuntPrepareScript: buildProductHuntPrepareScript
};