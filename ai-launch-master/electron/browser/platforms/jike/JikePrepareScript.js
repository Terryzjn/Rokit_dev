// Rokit · 即刻填写阶段 IIFE 脚本（v3 精简版）
// ----------------------------------------------------------------
// 唯一职责：把传入的 content 写到即刻动态框，然后报告写入结果。
//
// 关键变更（v3）：
//   - 节流关键字（"操作过于频繁" 等）不再中断流程。
//     即刻自身可能在动态主页上长期显示该文案，即便真人浏览器也会出现。
//     这里只把它当作"环境信号"，记录到 result.throttled / throttleSource /
//     throttleSample，不 abort。继续填表 + 校验。
//
// 阶段日志（4 段）：
//   [Jike][diag] composer search start   - 开始找 composer
//   [Jike][diag] composer found          - 命中，记录 selector / tag / role
//   [Jike][diag] content length before   - 填前长度
//   [Jike][diag] fill dispatched / FILL SUCCESS / FILL FAILED - 填后状态
//
// 等待策略：
//   - 800ms × 最多 15 次（最长 12s）找 composer
//   - 节流检测在每次 attempt 后做一次（限速不影响填表）
//
// 填表策略（满足"使用真实输入事件"要求）：
//   - textarea / input：Object.getOwnPropertyDescriptor 取原生 setter
//     → setter.set(el, text) → 触发原生 input 事件（InputEvent + change）
//     （这是触发 React/Vue 受控组件同步的唯一稳定办法）
//   - contenteditable：focus + Range.selectNodeContents + execCommand('insertText')
//     → execCommand 走浏览器原生 contenteditable 引擎，会自动派发
//       beforeinput/input/change 事件，对 React 友好
//
// 校验：
//   - 填后等 800ms 读 actual，对比 target 前 20 字
//
// 输出：plain object { ok, throttled, throttleSource, throttleSample,
//                     composer, fillMethod,
//                     contentBeforeLen, contentAfterLen,
//                     targetPreview, actualPreview,
//                     attempts, elapsedMs }
'use strict';

// 节流关键字视作"环境信号"（不再 abort）
var THROTTLE_MARKERS = [
  '操作过于频繁', '操作频繁', '请求过于频繁',
  'rate limit', 'too many requests',
  '稍后再试', '限流', '限速'
];

function buildJikePrepareScript(opts) {
  var o = opts || {};
  var contentSelectors = Array.isArray(o.contentSelectors) ? o.contentSelectors : [];
  var fillData = o.fillData || {};
  var pollIntervalMs = Number(o.pollIntervalMs) || 800;
  var maxAttempts = Number(o.maxAttempts) || 15;
  var verifyDelayMs = Number(o.verifyDelayMs) || 800;
  var payload = JSON.stringify({
    contentSelectors: contentSelectors,
    fillData: { content: String((fillData && fillData.content) || '') },
    pollIntervalMs: pollIntervalMs,
    maxAttempts: maxAttempts,
    verifyDelayMs: verifyDelayMs,
    markers: THROTTLE_MARKERS
  });

  var FN_HEAD =
    'var markers = p.markers || ["操作过于频繁"];\n' +
    'var re = new RegExp("(" + markers.map(function(s){return String(s).replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&");}).join("|")+")","i");\n' +
    'var log = function(msg, extra){ try{ console.log("[Jike][diag] " + msg + (extra ? " " + JSON.stringify(extra) : "")); }catch(_e){} };\n' +
    'function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    // 节流检测：仅记录环境信号，不再 abort
    'function detectThrottle(){\n' +
    '  try{\n' +
    '    var nodes = document.querySelectorAll("div,span,p,li,section,article,h1,h2,h3,h4,h5,h6");\n' +
    '    for(var i=0;i<nodes.length;i++){\n' +
    '      var n=nodes[i]; if(!n) continue;\n' +
    '      if(n.children && n.children.length>0) continue;\n' +
    '      var rect=n.getBoundingClientRect();\n' +
    '      if(!rect||rect.width<=0||rect.height<=0) continue;\n' +
    '      var s=window.getComputedStyle(n);\n' +
    '      if(s.visibility==="hidden"||s.display==="none") continue;\n' +
    '      var t=String(n.textContent||"").trim();\n' +
    '      if(t && t.length<=200 && re.test(t)){\n' +
    '        return { throttled: true, source: "dom-leaf", sample: t };\n' +
    '      }\n' +
    '    }\n' +
    '    if(re.test(String(document.title||""))){\n' +
    '      return { throttled: true, source: "dom-title", sample: String(document.title) };\n' +
    '    }\n' +
    '    return { throttled: false };\n' +
    '  }catch(_e){ return { throttled: false, error: String(_e && _e.message || _e) }; }\n' +
    '}\n' +
    // 排除"评论/回复/搜索/私信"等非发布框
    'function isExcluded(el){\n' +
    '  try{\n' +
    '    var role = (el.getAttribute && el.getAttribute("role")) || "";\n' +
    '    var type = (el.getAttribute && el.getAttribute("type")) || "";\n' +
    '    var ph = String((el.getAttribute && el.getAttribute("placeholder")) || "").trim();\n' +
    '    var al = String((el.getAttribute && el.getAttribute("aria-label")) || "").trim();\n' +
    '    if(/search/i.test(role)) return "search-by-role";\n' +
    '    if(/search/i.test(type)) return "search-by-type";\n' +
    '    if(/搜索|search/i.test(ph)) return "search-by-placeholder";\n' +
    '    if(/评论|回复|留言/i.test(ph)) return "comment-by-placeholder";\n' +
    '    if(/评论|回复|留言/i.test(al)) return "comment-by-aria";\n' +
    '    if(/私信|发送消息|聊天/i.test(ph)) return "dm-by-placeholder";\n' +
    '    if(/私信|发送消息|聊天/i.test(al)) return "dm-by-aria";\n' +
    '    return null;\n' +
    '  }catch(_e){ return null; }\n' +
    '}\n' +
    'function looksLikeComposer(el){\n' +
    '  try{\n' +
    '    var tag = (el.tagName||"").toUpperCase();\n' +
    '    if(tag === "TEXTAREA") return true;\n' +
    '    if(tag !== "DIV" && tag !== "SECTION" && tag !== "SPAN") return false;\n' +
    '    var ce = el.getAttribute && el.getAttribute("contenteditable");\n' +
    '    if(ce && String(ce).toLowerCase() !== "false") return true;\n' +
    '    var rect = el.getBoundingClientRect();\n' +
    '    if(rect && rect.height >= 60) return true;\n' +
    '    return false;\n' +
    '  }catch(_e){ return false; }\n' +
    '}\n' +
    'function detectComposer(selectors){\n' +
    '  if(!Array.isArray(selectors)) selectors = [selectors];\n' +
    '  for(var i=0;i<selectors.length;i++){\n' +
    '    var sel = selectors[i]; if(!sel) continue;\n' +
    '    var nodes = document.querySelectorAll(sel);\n' +
    '    for(var j=0;j<nodes.length;j++){\n' +
    '      var el = nodes[j]; if(!el) continue;\n' +
    '      var rect = el.getBoundingClientRect();\n' +
    '      if(!rect||rect.width<=0||rect.height<=0) continue;\n' +
    '      var style = window.getComputedStyle(el);\n' +
    '      if(style.visibility==="hidden"||style.display==="none") continue;\n' +
    '      var ex = isExcluded(el);\n' +
    '      if(ex) continue;\n' +
    '      if(!looksLikeComposer(el)) continue;\n' +
    '      return {\n' +
    '        el: el, selectorMatched: sel,\n' +
    '        tagName: el.tagName,\n' +
    '        contenteditable: el.getAttribute && el.getAttribute("contenteditable"),\n' +
    '        role: (el.getAttribute && el.getAttribute("role")) || "",\n' +
    '        ariaMultiline: (el.getAttribute && el.getAttribute("aria-multiline")) || "",\n' +
    '        ariaLabel: (el.getAttribute && el.getAttribute("aria-label")) || "",\n' +
    '        placeholder: (el.getAttribute && el.getAttribute("placeholder")) || "",\n' +
    '        height: rect.height, width: rect.width, visible: true\n' +
    '      };\n' +
    '    }\n' +
    '  }\n' +
    '  return null;\n' +
    '}\n' +
    'function readContent(el){\n' +
    '  if(!el) return "";\n' +
    '  var tag = (el.tagName||"").toUpperCase();\n' +
    '  if(tag === "TEXTAREA" || tag === "INPUT") return String(el.value||"");\n' +
    '  return String(el.textContent || el.innerText || "");\n' +
    '}\n' +
    // 填表：textarea 走原生 setter；contenteditable 走 Range + execCommand('insertText')
    // 两者都派发真实 InputEvent + change 事件，**满足"使用真实输入事件"要求**
    'function fillComposer(el, text){\n' +
    '  try{\n' +
    '    if(typeof el.focus === "function") el.focus();\n' +
    '    var tag = (el.tagName||"").toUpperCase();\n' +
    '    if(tag === "TEXTAREA" || tag === "INPUT"){\n' +
    '      var proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;\n' +
    '      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;\n' +
    '      if(setter) setter.call(el, String(text||""));\n' +
    '      else el.value = String(text||"");\n' +
    '      el.dispatchEvent(new InputEvent("input",  {bubbles:true, cancelable:true, data:String(text||""), inputType:"insertText"}));\n' +
    '      el.dispatchEvent(new Event("change", {bubbles:true}));\n' +
    '      return { ok: true, method: "native-setter" };\n' +
    '    }\n' +
    '    var sel = window.getSelection();\n' +
    '    if(sel && document.createRange){\n' +
    '      try{\n' +
    '        var range = document.createRange();\n' +
    '        range.selectNodeContents(el);\n' +
    '        sel.removeAllRanges();\n' +
    '        sel.addRange(range);\n' +
    '      }catch(_e){}\n' +
    '    }\n' +
    '    var ok = false;\n' +
    '    try { ok = document.execCommand("insertText", false, String(text||"")); } catch(_e) { ok = false; }\n' +
    '    var method = ok ? "execCommand-insertText-range" : "fallback-textContent";\n' +
    '    if(!ok){\n' +
    '      el.textContent = String(text||"");\n' +
    '      el.dispatchEvent(new InputEvent("input", {bubbles:true, cancelable:true, inputType:"insertText"}));\n' +
    '      el.dispatchEvent(new Event("change", {bubbles:true}));\n' +
    '    }\n' +
    '    return { ok: true, method: method };\n' +
    '  }catch(e){\n' +
    '    return { ok: false, method: "exception", error: String((e&&e.message)||e) };\n' +
    '  }\n' +
    '}\n' +
    'function snapshot(el){\n' +
    '  if(!el) return null;\n' +
    '  var rect = el.getBoundingClientRect();\n' +
    '  var style = window.getComputedStyle(el);\n' +
    '  return {\n' +
    '    tagName: el.tagName,\n' +
    '    role: (el.getAttribute && el.getAttribute("role")) || "",\n' +
    '    ariaLabel: (el.getAttribute && el.getAttribute("aria-label")) || "",\n' +
    '    placeholder: (el.getAttribute && el.getAttribute("placeholder")) || "",\n' +
    '    contenteditable: (el.getAttribute && el.getAttribute("contenteditable")) || "",\n' +
    '    ariaMultiline: (el.getAttribute && el.getAttribute("aria-multiline")) || "",\n' +
    '    visible: !!(rect && rect.width>0 && rect.height>0 && style.visibility!=="hidden" && style.display!=="none"),\n' +
    '    height: rect ? Math.round(rect.height) : 0,\n' +
    '    width: rect ? Math.round(rect.width) : 0,\n' +
    '    readonly: (el.getAttribute && el.getAttribute("readonly")) || false,\n' +
    '    disabled: el.disabled === true\n' +
    '  };\n' +
    '}\n';

  return '(async function(p){\n' + FN_HEAD +
    'var target = String((p.fillData && p.fillData.content) || "");\n' +
    'var targetLen = target.length;\n' +
    'var targetPreview = target.slice(0, 50);\n' +
    // 注意：throttled 字段在这里只是"环境信号"标志，**不再 abort**
    'var result = {\n' +
    '  ok: false, throttled: false, throttleSource: null, throttleSample: "",\n' +
    '  composer: null, fillMethod: null,\n' +
    '  contentBeforeLen: 0, contentAfterLen: 0,\n' +
    '  targetPreview: targetPreview, actualPreview: "",\n' +
    '  attempts: 0, elapsedMs: 0\n' +
    '};\n' +
    'var startedAt = Date.now();\n' +
    'log("composer search start", { selectors: (p.contentSelectors||[]).length, maxAttempts: p.maxAttempts, pollIntervalMs: p.pollIntervalMs });\n' +
    'try {\n' +
    '  var composer = null;\n' +
    '  for(var attempt=1; attempt<=p.maxAttempts; attempt++){\n' +
    '    result.attempts = attempt;\n' +
    '    var th = detectThrottle();\n' +
    '    if(th && th.throttled){\n' +
    '      result.throttled = true;\n' +
    '      result.throttleSource = th.source;\n' +
    '      result.throttleSample = th.sample || "";\n' +
    '      log("throttle detected (informational, NOT aborting)", th);\n' +
    '    }\n' +
    '    composer = detectComposer(p.contentSelectors);\n' +
    '    if(composer){ log("composer found", { attempt: attempt, tag: composer.tagName, role: composer.role, ce: composer.contenteditable }); break; }\n' +
    '    await sleep(p.pollIntervalMs);\n' +
    '  }\n' +
    '  result.elapsedMs = Date.now() - startedAt;\n' +
    '  if(!composer){\n' +
    '    result.ok = false;\n' +
    '    result.error = "composer-not-found";\n' +
    '    log("composer NOT FOUND", { attempts: result.attempts });\n' +
    '    return result;\n' +
    '  }\n' +
    '  result.composer = snapshot(composer.el);\n' +
    '  log("composer snapshot", result.composer);\n' +
    '  var beforeLen = readContent(composer.el).length;\n' +
    '  result.contentBeforeLen = beforeLen;\n' +
    '  log("content length before = " + beforeLen + ", targetLen = " + targetLen);\n' +
    '  var fr = fillComposer(composer.el, target);\n' +
    '  result.fillMethod = fr && fr.method;\n' +
    '  if(!fr || !fr.ok){\n' +
    '    result.ok = false;\n' +
    '    result.error = (fr && fr.error) || "fill-returned-not-ok";\n' +
    '    log("FILL FAILED at fill step", fr);\n' +
    '    return result;\n' +
    '  }\n' +
    '  log("fill dispatched", { method: fr.method });\n' +
    '  await sleep(p.verifyDelayMs || 800);\n' +
    '  var afterText = readContent(composer.el);\n' +
    '  var afterLen = afterText.length;\n' +
    '  result.contentAfterLen = afterLen;\n' +
    '  result.actualPreview = afterText.slice(0, 50);\n' +
    '  if(afterLen === 0){\n' +
    '    result.ok = false;\n' +
    '    result.error = "actual-content-empty";\n' +
    '    log("FILL FAILED: actual content is empty", { method: result.fillMethod });\n' +
    '    return result;\n' +
    '  }\n' +
    '  if(targetLen > 0 && afterText.indexOf(target.slice(0, Math.min(20, targetLen))) === -1){\n' +
    '    result.ok = false;\n' +
    '    result.error = "preview-not-found";\n' +
    '    log("FILL FAILED: target preview not found in actual", { targetPreview: result.targetPreview, actualPreview: result.actualPreview, method: result.fillMethod });\n' +
    '    return result;\n' +
    '  }\n' +
    '  result.ok = true;\n' +
    '  log("FILL SUCCESS", { method: result.fillMethod, contentBeforeLen: result.contentBeforeLen, contentAfterLen: result.contentAfterLen, actualPreview: result.actualPreview });\n' +
    '} catch(e){\n' +
    '  result.ok = false; result.error = String((e&&e.message)||e);\n' +
    '  try{ console.log("[Jike][diag] prepare EXCEPTION " + result.error); }catch(_e){}\n' +
    '}\n' +
    'return result;\n' +
    '})(' + payload + ')';
}

module.exports = {
  buildJikePrepareScript: buildJikePrepareScript,
  THROTTLE_MARKERS: THROTTLE_MARKERS
};