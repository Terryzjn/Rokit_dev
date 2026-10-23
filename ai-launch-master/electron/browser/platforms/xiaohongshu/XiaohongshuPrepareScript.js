// Rokit · 小红书填写阶段 IIFE 脚本（v1.0）
// ----------------------------------------------------------------
// 职责：在小红书「发布笔记」页面分析实际 DOM，找到标题输入框与正文富文本编辑器，
//         填写用户的 title + body，返回实际写入情况。
//
// 关键策略（与 JikePrepareScript 同源）：
//   - 800ms × 最多 15 次（最长 12s）轮询查找标题与正文元素。
//   - 节流文案（"操作过于频繁" 等）仅作环境信号记录，不再 abort。
//   - 真实输入事件：
//       <input>/<textarea>: React 16+ 受控组件必须用 HTMLInputElement 原生 setter，
//                            否则 value 被静默回滚。
//       [contenteditable]:   focus + Range + execCommand('insertText')，
//                            触发原生 beforeinput/input/change。
//   - 校验：填后等 800ms 读 actual，对比 target 前 20 字。
//   - 不点击 Submit / 发布 / 完成。程序永远不会触发最终发布。
//
// 输出：plain object { ok, throttled, throttleSample, pageMode,
//             title?, content?, fileInputs?, attempts, elapsedMs, error? }
'use strict';

// 节流文案（与 JikePrepareScript 同源）；仅记录，不影响 ok
const THROTTLE_MARKERS = [
  '操作过于频繁', '操作频繁', '请求过于频繁',
  'rate limit', 'too many requests',
  '稍后再试', '限流', '限速',
  '验证码', '安全验证', '账号异常', '登录已失效', '请重新登录'
];

function buildXiaohongshuPrepareScript(opts) {
  var o = opts || {};
  var titleSelectors   = Array.isArray(o.titleSelectors)   ? o.titleSelectors   : [];
  var contentSelectors = Array.isArray(o.contentSelectors) ? o.contentSelectors : [];
  var fillData         = o.fillData || {};
  var pollIntervalMs   = Number(o.pollIntervalMs) || 800;
  var maxAttempts      = Number(o.maxAttempts)    || 15;
  var verifyDelayMs    = Number(o.verifyDelayMs)   || 800;
  var payload = JSON.stringify({
    titleSelectors:   titleSelectors,
    contentSelectors: contentSelectors,
    fillData: {
      title:       String((fillData && fillData.title)   || ''),
        content: String((fillData && fillData.content) || '')
      },
      pollIntervalMs: pollIntervalMs,
      maxAttempts:    maxAttempts,
      verifyDelayMs:  verifyDelayMs,
      markers:        THROTTLE_MARKERS
  });

  var FN_HEAD =
    'var markers = p.markers || ["操作过于频繁"];\n' +
    'var re = new RegExp("(" + markers.map(function(s){return String(s).replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&");}).join("|")+")","i");\n' +
    'var log = function(msg, extra){ try{ console.log("[Xiaohongshu][diag] " + msg + (extra ? " " + JSON.stringify(extra) : "")); }catch(_e){} };\n' +
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
    // 1) 探查当前页面实际 DOM（input / textarea / contenteditable / file input）
    'function probeDom(){\n' +
    '  var inputs = document.querySelectorAll("input");\n' +
    '  var textareas = document.querySelectorAll("textarea");\n' +
    '  var editables = document.querySelectorAll("[contenteditable=\\"true\\"]");\n' +
    '  var files = document.querySelectorAll("input[type=\\"file\\"]");\n' +
    '  function summarize(nodes){\n' +
    '    var out=[];\n' +
    '    for(var i=0;i<nodes.length;i++){\n' +
    '      var n=nodes[i];if(!n) continue;\n' +
    '      var r=n.getBoundingClientRect();\n' +
    '      var v=r.width>0 && r.height>0;\n' +
    '      var s=window.getComputedStyle(n);\n' +
    '      var hidden = (s.visibility==="hidden"||s.display==="none");\n' +
    '      if(hidden) continue;\n' +
    '      out.push({\n' +
    '        tag: n.tagName,\n' +
    '        type: (n.getAttribute&&n.getAttribute("type"))||"",\n' +
    '        accept: (n.getAttribute&&n.getAttribute("accept"))||"",\n' +
    '        multiple: n.hasAttribute("multiple"),\n' +
    '        name: (n.getAttribute&&n.name)||"",\n' +
    '        placeholder: (n.getAttribute&&n.getAttribute("placeholder"))||"",\n' +
    '        ariaLabel: (n.getAttribute&&n.getAttribute("aria-label"))||"",\n' +
    '        role: (n.getAttribute&&n.getAttribute("role"))||"",\n' +
    '        maxLength: n.getAttribute ? n.getAttribute("maxlength") : null,\n' +
    '        contenteditable: (n.getAttribute&&n.getAttribute("contenteditable"))||"",\n' +
    '        visible: v && !hidden,\n' +
    '        disabled: n.disabled===true,\n' +
    '        width: Math.round(r.width||0), height: Math.round(r.height||0)\n' +
    '      });\n' +
    '    }\n' +
    '    return out;\n' +
    '  }\n' +
    '  var inputsArr  = summarize(inputs);\n' +
    '  var textArr    = summarize(textareas);\n' +
    '  var editArr    = summarize(editables);\n' +
    '  var fileArr    = summarize(files);\n' +
    '  log("DOM probe", { inputCount: inputsArr.length, textareaCount: textArr.length, editableCount: editArr.length, fileInputCount: fileArr.length });\n' +
    '  if(inputsArr.length)  log("input samples",   inputsArr.slice(0, 5));\n' +
    '  if(textArr.length)    log("textarea samples", textArr.slice(0, 5));\n' +
    '  if(editArr.length)    log("editable samples", editArr.slice(0, 5));\n' +
    '  if(fileArr.length)    log("file input samples", fileArr);\n' +
    '  return {\n' +
    '    inputs: inputsArr, textareas: textArr,\n' +
    '    editables: editArr, fileInputs: fileArr\n' +
    '  };\n' +
    '}\n' +
    // 2) 在多个备选选择器里找第一个**可见 + 可编辑**的元素
    'function resolveOne(selectors){\n' +
    '  if(!Array.isArray(selectors)) selectors=[selectors];\n' +
    '  for(var i=0;i<selectors.length;i++){\n' +
    '    var sel=selectors[i];if(!sel) continue;\n' +
    '    var nodes=document.querySelectorAll(sel);\n' +
    '    for(var j=0;j<nodes.length;j++){\n' +
    '      var el=nodes[j];if(!el) continue;\n' +
    '      var r=el.getBoundingClientRect();\n' +
    '      if(r.width<=0||r.height<=0) continue;\n' +
    '      var s=window.getComputedStyle(el);\n' +
    '      if(s.visibility==="hidden"||s.display==="none") continue;\n' +
    '      if(el.disabled===true) continue;\n' +
    '      return { el: el, selectorMatched: sel };\n' +
    '    }\n' +
    '  }\n' +
    '  return null;\n' +
    '}\n' +
    'function readContent(el){\n' +
    '  if(!el) return "";\n' +
    '  var tag=(el.tagName||"").toUpperCase();\n' +
    '  if(tag==="TEXTAREA"||tag==="INPUT") return String(el.value||"");\n' +
    '  return String(el.textContent||el.innerText||"");\n' +
    '}\n' +
    // 填表：textarea / input 走原生 setter；contenteditable 走 Range+execCommand('insertText')
    'function fillField(el, text){\n' +
    '  try{\n' +
    '    if(typeof el.focus==="function") el.focus();\n' +
    '    var tag=(el.tagName||"").toUpperCase();\n' +
    '    if(tag==="TEXTAREA"||tag==="INPUT"){\n' +
    '      var proto=tag==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;\n' +
    '      var setter=Object.getOwnPropertyDescriptor(proto,"value").set;\n' +
    '      if(setter) setter.call(el, String(text||""));\n' +
    '      else el.value=String(text||"");\n' +
    '      el.dispatchEvent(new InputEvent("input",  {bubbles:true, cancelable:true, data:String(text||""), inputType:"insertText"}));\n' +
    '      el.dispatchEvent(new Event("change", {bubbles:true}));\n' +
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
    '    try { ok=document.execCommand("insertText", false, String(text||"")); } catch(_e){ ok=false; }\n' +
    '    var method=ok?"execCommand-insertText-range":"fallback-textContent";\n' +
    '    if(!ok){\n' +
    '      el.textContent=String(text||"");\n' +
    '      el.dispatchEvent(new InputEvent("input", {bubbles:true, cancelable:true, inputType:"insertText"}));\n' +
    '      el.dispatchEvent(new Event("change", {bubbles:true}));\n' +
    '    }\n' +
    '    return { ok:true, method:method };\n' +
    '  }catch(e){\n' +
    '    return { ok:false, method:"exception", error:String((e&&e.message)||e) };\n' +
    '  }\n' +
    '}\n' +
    'function snapshot(el){\n' +
    '  if(!el) return null;\n' +
    '  var r=el.getBoundingClientRect();\n' +
    '  var s=window.getComputedStyle(el);\n' +
    '  return {\n' +
    '    tagName: el.tagName,\n' +
    '    role: (el.getAttribute&&el.getAttribute("role"))||"",\n' +
    '    ariaLabel: (el.getAttribute&&el.getAttribute("aria-label"))||"",\n' +
    '    placeholder: (el.getAttribute&&el.getAttribute("placeholder"))||"",\n' +
    '    contenteditable: (el.getAttribute&&el.getAttribute("contenteditable"))||"",\n' +
    '    visible: !!(r && r.width>0 && r.height>0 && s.visibility!=="hidden" && s.display!=="none"),\n' +
    '    height: r ? Math.round(r.height) : 0,\n' +
    '    width:  r ? Math.round(r.width)  : 0,\n' +
    '    readonly: (el.getAttribute&&el.getAttribute("readonly"))||false,\n' +
    '    disabled: el.disabled===true,\n' +
    '    maxLength: el.getAttribute ? el.getAttribute("maxlength") : null\n' +
    '  };\n' +
    '}\n' +
    // 页面状态推断：根据 URL + DOM 文本判断当前在「首页 / 登录 / 草稿 / 其他」
    'function detectPageMode(){\n' +
    '  try{\n' +
    '    var url=String(location.href||"");\n' +
    '    var p=/\\/login|\\/signin|登录|login/i;\n' +
    '    if(p.test(url)) return "login";\n' +
    '    if(/creator\\.xiaohongshu\\.com\\/publish|\\/new-post|create\\?type|note\\/create/i.test(url)) return "publish";\n' +
    '    if(/\\/(discover|explore|home|recommend)/i.test(url)) return "discover";\n' +
    '    var body=String(document.body ? document.body.innerText : "").slice(0, 4000);\n' +
    '    if(/请先登录|扫码登录|手机号登录|未登录|登录以继续/i.test(body)) return "login";\n' +
    '    if(/发布笔记|写笔记|创作中心|图文|视频|标题|正文/.test(body)) return "publish";\n' +
    '    return "unknown";\n' +
    '  }catch(_e){ return "unknown"; }\n' +
    '}\n';

  return '(async function(p){\n' + FN_HEAD +
    'var targetTitle    = String((p.fillData && p.fillData.title)   || "");\n' +
    'var targetContent  = String((p.fillData && p.fillData.content) || "");\n' +
    'var targetTitleLen    = targetTitle.length;\n' +
    'var targetContentLen  = targetContent.length;\n' +
    'var targetTitlePreview   = targetTitle.slice(0, 50);\n' +
    'var targetContentPreview = targetContent.slice(0, 50);\n' +
    'var result = {\n' +
    '  ok: false,\n' +
    '  throttled: false, throttleSource: null, throttleSample: "",\n' +
    '  pageMode: null,\n' +
    '  domProbe: null,\n' +
    '  title: null, content: null,\n' +
    '  titleTargetLen: targetTitleLen,   titleActualLen: 0,\n' +
    '  contentTargetLen: targetContentLen, contentActualLen: 0,\n' +
    '  titleActualPreview: "",   contentActualPreview: "",\n' +
    '  titleMethod: null,        contentMethod: null,\n' +
    '  fileInputs: [],\n' +
    '  attempts: 0, elapsedMs: 0,\n' +
    '  error: ""\n' +
    '};\n' +
    'var startedAt=Date.now();\n' +
    'log("prepare start", { selectors: { title: (p.titleSelectors||[]).length, content: (p.contentSelectors||[]).length }, maxAttempts: p.maxAttempts, pollIntervalMs: p.pollIntervalMs });\n' +
    'try {\n' +
    '  // 1) 先做一次 DOM 探查（满足「先记录实际 DOM」要求）\n' +
    '  result.domProbe = probeDom();\n' +
    '  result.fileInputs = result.domProbe.fileInputs;\n' +
    '  result.pageMode = detectPageMode();\n' +
    '  log("page mode", { pageMode: result.pageMode, url: String(location.href||"") });\n' +
    // 节流检测：仅作环境日志
    '  var th=detectThrottle();\n' +
    '  if(th && th.throttled){\n' +
    '    result.throttled=true;\n' +
    '    result.throttleSource=th.source;\n' +
    '    result.throttleSample=th.sample||"";\n' +
    '    log("throttle detected (informational, NOT aborting)", th);\n' +
    '  }\n' +
    // 2) 找标题
    '  var titleEl=null;\n' +
    '  for(var attempt=1; attempt<=p.maxAttempts; attempt++){\n' +
    '    result.attempts=attempt;\n' +
    '    if(targetTitle){\n' +
    '      titleEl=resolveOne(p.titleSelectors);\n' +
    '      if(titleEl){ log("title element found", { attempt: attempt, selector: titleEl.selectorMatched, tag: titleEl.el.tagName, maxLength: titleEl.el.getAttribute?titleEl.el.getAttribute("maxlength"):null }); break; }\n' +
    '    } else { log("no target title, skipping title fill"); break; }\n' +
    '    await sleep(p.pollIntervalMs);\n' +
    '  }\n' +
    // 3) 找正文
    '  var contentEl=null;\n' +
    '  if(targetContent){\n' +
    '    for(var attempt2=1; attempt2<=p.maxAttempts; attempt2++){\n' +
    '      result.attempts=Math.max(result.attempts, attempt2);\n' +
    '      contentEl=resolveOne(p.contentSelectors);\n' +
    '      if(contentEl){ log("content element found", { attempt: attempt2, selector: contentEl.selectorMatched, tag: contentEl.el.tagName, ce: (contentEl.el.getAttribute&&contentEl.el.getAttribute("contenteditable"))||"" }); break; }\n' +
    '      await sleep(p.pollIntervalMs);\n' +
    '    }\n' +
    '  } else { log("no target content, skipping content fill"); }\n' +
    '  result.elapsedMs=Date.now()-startedAt;\n' +
    // 4) 填标题（如果找到了）
    '  if(targetTitle){\n' +
    '    if(!titleEl){\n' +
    '      result.error="title-not-found";\n' +
    '      log("title NOT FOUND", { attempts: result.attempts, domSample: { inputs: (result.domProbe.inputs||[]).slice(0,3), textareas: (result.domProbe.textareas||[]).slice(0,3) } });\n' +
    '      // 不直接 return：标题失败时仍尝试填正文（让用户至少能保存部分内容）\n' +
    '    } else {\n' +
    '      var beforeTitle=readContent(titleEl.el).length;\n' +
    '      var tr=fillField(titleEl.el, targetTitle);\n' +
    '      result.titleMethod=tr && tr.method;\n' +
    '      if(!tr || !tr.ok){\n' +
    '        result.error="title-fill-failed: "+(tr&&tr.error||"unknown");\n' +
    '        log("title FILL FAILED", tr);\n' +
    '      } else {\n' +
    '        await sleep(p.verifyDelayMs||800);\n' +
    '        var afterTitleText=readContent(titleEl.el);\n' +
    '        var afterTitleLen=afterTitleText.length;\n' +
    '        result.titleActualLen=afterTitleLen;\n' +
    '        result.titleActualPreview=afterTitleText.slice(0,50);\n' +
    '        result.title=snapshot(titleEl.el);\n' +
    '        if(afterTitleLen===0){\n' +
    '          result.error="title-actual-empty";\n' +
    '          log("title FILL FAILED: actual empty", { method: result.titleMethod });\n' +
    '        } else if(targetTitleLen>0 && afterTitleText.indexOf(targetTitle.slice(0, Math.min(20, targetTitleLen)))===-1){\n' +
    '          result.error="title-preview-not-found";\n' +
    '          log("title FILL FAILED: preview not found", { targetPreview: targetTitlePreview, actualPreview: result.titleActualPreview, method: result.titleMethod });\n' +
    '        } else {\n' +
    '          log("title FILL SUCCESS", { method: result.titleMethod, before: beforeTitle, after: afterTitleLen, preview: result.titleActualPreview });\n' +
    '        }\n' +
    '      }\n' +
    '    }\n' +
    '  }\n' +
    // 5) 填正文
    '  if(targetContent){\n' +
    '    if(!contentEl){\n' +
    '      var prevErr=result.error;\n' +
    '      result.error=(prevErr?prevErr+"; ":"")+"content-not-found";\n' +
    '      log("content NOT FOUND", { attempts: result.attempts, domSample: { editables: (result.domProbe.editables||[]).slice(0,3), textareas: (result.domProbe.textareas||[]).slice(0,3) } });\n' +
    '    } else {\n' +
    '      var beforeContent=readContent(contentEl.el).length;\n' +
    '      var cr=fillField(contentEl.el, targetContent);\n' +
    '      result.contentMethod=cr && cr.method;\n' +
    '      if(!cr || !cr.ok){\n' +
    '        var prevErr2=result.error;\n' +
    '        result.error=(prevErr2?prevErr2+"; ":"")+"content-fill-failed: "+(cr&&cr.error||"unknown");\n' +
    '        log("content FILL FAILED", cr);\n' +
    '      } else {\n' +
    '        await sleep(p.verifyDelayMs||800);\n' +
    '        var afterContentText=readContent(contentEl.el);\n' +
    '        var afterContentLen=afterContentText.length;\n' +
    '        result.contentActualLen=afterContentLen;\n' +
    '        result.contentActualPreview=afterContentText.slice(0,50);\n' +
    '        result.content=snapshot(contentEl.el);\n' +
    '        if(afterContentLen===0){\n' +
    '          var prevErr3=result.error;\n' +
    '          result.error=(prevErr3?prevErr3+"; ":"")+"content-actual-empty";\n' +
    '          log("content FILL FAILED: actual empty", { method: result.contentMethod });\n' +
    '        } else if(targetContentLen>0 && afterContentText.indexOf(targetContent.slice(0, Math.min(20, targetContentLen)))===-1){\n' +
    '          var prevErr4=result.error;\n' +
    '          result.error=(prevErr4?prevErr4+"; ":"")+"content-preview-not-found";\n' +
    '          log("content FILL FAILED: preview not found", { targetPreview: targetContentPreview, actualPreview: result.contentActualPreview, method: result.contentMethod });\n' +
    '        } else {\n' +
    '          log("content FILL SUCCESS", { method: result.contentMethod, before: beforeContent, after: afterContentLen, preview: result.contentActualPreview });\n' +
    '        }\n' +
    '      }\n' +
    '    }\n' +
    '  }\n' +
    // 6) 判定成功
    '  var titleOk   = !targetTitle    || (result.titleActualLen    > 0 && (result.error||"").indexOf("title-") === -1);\n' +
    '  var contentOk = !targetContent  || (result.contentActualLen  > 0 && (result.error||"").indexOf("content-") === -1);\n' +
    '  if(titleOk && contentOk){ result.ok=true; }\n' +
    '  if(!result.error) result.error="";\n' +
    '  log("prepare end", { ok: result.ok, error: result.error, title: result.titleActualLen, content: result.contentActualLen, attempts: result.attempts, elapsedMs: result.elapsedMs });\n' +
    '} catch(e){\n' +
    '  result.ok=false;\n' +
    '  result.error=String((e&&e.message)||e);\n' +
    '  try{ log("PREPARE EXCEPTION " + result.error); }catch(_e){}\n' +
    '}\n' +
    'return result;\n' +
    '})(' + payload + ')';
}

module.exports = {
  buildXiaohongshuPrepareScript: buildXiaohongshuPrepareScript,
  THROTTLE_MARKERS: THROTTLE_MARKERS
};