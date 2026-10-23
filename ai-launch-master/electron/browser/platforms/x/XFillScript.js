// Rokit · X (Twitter) Compose Post 文本填充 IIFE（v1.x 重构：诊断优先 + 模拟 paste）
// ----------------------------------------------------------------
// v1.x 关键变化：
//   1. 上一轮 `execCommand('insertText')` 在 X (2024+) 编辑器中可能"静默失败"：
//      X 是基于自定义 Slate.js 的受控输入，依赖原生 `InputEvent` 的
//      `inputType='insertText'` + `data=...` 触发其内部 `insertFragment`
//      转换。`execCommand('insertText')` 虽然在简单 contenteditable 仍能工作，
//      但 X 经常拦截并丢弃 / 写入错误的 React state，导致用户看到的文本与
//      Slate 内部文本不同步 → 光标错位。
//   2. 现在改用：focus → 选中 root 全部 → 派发合成 InputEvent('beforeinput') +
//      InputEvent('input')，并用 DataTransfer 携带 text/plain payload。
//      这是 React / Slate 标准支持的"模拟 paste"路径。X 的 beforeinput
//      handler 会走 `editor.insertText(data)` 然后维护自己的 DOM 与 anchor。
//   3. 完全不动 childNodes / innerText / textContent。X 自己重建 DOM。
//   4. 完成后**不主动设置光标**（X 的 React 状态同步后 selection 已在末段末尾）。
//      上一轮强行用 Range setStart 在最末 text node 设光标反而打破 X 自己的
//      anchor 表，导致用户首次键入时空坐标。
//
// 不做：
//   - 不重写 outerHTML / 不替换 childNodes / 不调用 el.textContent = ...。
//   - 不自动点击 Post。
//   - 不假设 setSelectionRange 适用于 contenteditable。
//   - 不读取 cookie / token / 凭据。
//
// 诊断（每次填充都打点）：
//   - 编辑器 data-testid / role / aria-label / contenteditable
//   - 元素子节点数量、文本节点数量、layout 宽高、devicePixelRatio
//   - 当前 Selection 的 anchorNode / anchorOffset / focusNode / focusOffset
//   - 填充前后 textContent 长度差
//   - 每次 dispatchEvent 是否被 React 拦截（isTrusted=false 由我们控制）
//   - 填充方式（dispatch-paste / execCommand / char-by-char）
'use strict';

// 候选 selector（按特异性从高到低）
const X_COMPOSER_SELECTORS = [
  '[data-testid="tweetTextarea_0"]',
  '[data-testid="tweetTextarea_1"]',
  '[data-testid="tweetTextarea_2"]',
  '[contenteditable="true"][data-text="true"]',
  'div[role="textbox"][contenteditable="true"]',
  'div[role="textbox"][aria-multiline="true"]',
  '[contenteditable="true"]:not([role="search"]):not([data-testid*="Search"])'
];

// 探针：在页面里把 X 编辑器当前完整状态汇报到 main。
// 字段含义详见 XFillScript.js 顶部注释。所有字段都不含 token / cookie。
function buildXDiagnosticScript(opts) {
  opts = opts || {};
  var selectors = Array.isArray(opts.selectors) && opts.selectors.length ? opts.selectors : X_COMPOSER_SELECTORS;
  var payload = JSON.stringify({
    selectors: selectors,
    note: opts.note || 'X-publish diagnostic'
  });
  return '(' +
    'async function xDiag(p){\n' +
    '  function log(m, x){ try{ console.log("[X-publish][diag] " + m + (x ? " " + JSON.stringify(x) : "")); }catch(_e){} }\n' +
    '  function getWin(){ try{ return window; }catch(_e){ return null; } }\n' +
    '  function findEditor(){\n' +
    '    for(var i=0;i<p.selectors.length;i++){\n' +
    '      var sels = p.selectors[i];\n' +
    '      try{\n' +
    '        var nodes = document.querySelectorAll(sels);\n' +
    '        for(var j=0;j<nodes.length;j++){\n' +
    '          var n = nodes[j]; if(!n) continue;\n' +
    '          var r = n.getBoundingClientRect();\n' +
    '          if(!r || r.width<=0 || r.height<=0) continue;\n' +
    '          var st = n.getAttribute("data-testid")||"";\n' +
    '          if(/search/i.test(st)) continue;\n' +
    '          return n;\n' +
    '        }\n' +
    '      }catch(_e){}\n' +
    '    }\n' +
    '    return null;\n' +
    '  }\n' +
    '  var el = findEditor();\n' +
    '  if(!el){ log("diag: editor not found", { url: location.href }); return { found: false, url: location.href }; }\n' +
    '  var win = getWin();\n' +
    '  var cs = (win && win.getComputedStyle) ? win.getComputedStyle(el) : null;\n' +
    '  var rect = el.getBoundingClientRect();\n' +
    '  var active = document.activeElement;\n' +
    '  var sel = (win && win.getSelection) ? win.getSelection() : null;\n' +
    '  var selInfo = null;\n' +
    '  if(sel && sel.rangeCount > 0){\n' +
    '    var r0 = sel.getRangeAt(0);\n' +
    '    selInfo = {\n' +
    '      anchorNodeName: r0.commonAncestorContainer && r0.commonAncestorContainer.nodeName,\n' +
    '      anchorIsInsideEditor: el.contains(r0.commonAncestorContainer),\n' +
    '      anchorOffset: r0.startOffset,\n' +
    '      focusOffset: r0.endOffset,\n' +
    '      text: String(r0.toString() || "").slice(0, 40)\n' +
    '    };\n' +
    '  }\n' +
    '  var childCount = el.childNodes ? el.childNodes.length : 0;\n' +
    '  var textNodeCount = 0;\n' +
    '  function walk(n){\n' +
    '    if(!n) return;\n' +
    '    if(n.nodeType === 3) { textNodeCount++; return; }\n' +
    '    for(var i=0;i<n.childNodes.length;i++) walk(n.childNodes[i]);\n' +
    '  }\n' +
    '  walk(el);\n' +
    '  log("diag snapshot", {\n' +
    '    url: location.href,\n' +
    '    note: p.note || "",\n' +
    '    element: {\n' +
    '      tag: el.tagName,\n' +
    '      dataTestid: el.getAttribute("data-testid") || "",\n' +
    '      role: el.getAttribute("role") || "",\n' +
    '      ariaLabel: el.getAttribute("aria-label") || "",\n' +
    '      placeholder: el.getAttribute("data-placeholder") || el.getAttribute("placeholder") || "",\n' +
    '      contenteditable: el.getAttribute("contenteditable") || "",\n' +
    '      dataText: el.getAttribute("data-text") || "",\n' +
    '      lang: el.getAttribute("lang") || ""\n' +
    '    },\n' +
    '    layout: {\n' +
    '      width: Math.round(rect.width),\n' +
    '      height: Math.round(rect.height),\n' +
    '      left: Math.round(rect.left),\n' +
    '      top: Math.round(rect.top),\n' +
    '      devicePixelRatio: win && win.devicePixelRatio,\n' +
    '      visibility: cs ? cs.visibility : null,\n' +
    '      display: cs ? cs.display : null,\n' +
    '      transform: cs ? cs.transform : null\n' +
    '    },\n' +
    '    structure: {\n' +
    '      childCount: childCount,\n' +
    '      textNodeCount: textNodeCount,\n' +
    '      textContent: String(el.textContent || "").slice(0, 200),\n' +
    '      textContentLen: String(el.textContent || "").length\n' +
    '    },\n' +
    '    focus: {\n' +
    '      isEditor: active === el,\n' +
    '      activeTag: active && active.tagName,\n' +
    '      activeTestid: active && active.getAttribute && active.getAttribute("data-testid")\n' +
    '    },\n' +
    '    selection: selInfo\n' +
    '  });\n' +
    '  return {\n' +
    '    found: true,\n' +
    '    tag: el.tagName,\n' +
    '    dataTestid: el.getAttribute("data-testid") || "",\n' +
    '    childCount: childCount,\n' +
    '    textNodeCount: textNodeCount,\n' +
    '    textContentLen: String(el.textContent || "").length,\n' +
    '    selection: selInfo\n' +
    '  };\n' +
    '})(' + payload + ')';
}

function buildXFillScript(opts) {
  var o = opts || {};
  var selectors = Array.isArray(o.selectors) && o.selectors.length ? o.selectors : X_COMPOSER_SELECTORS;
  var pollIntervalMs = Number(o.pollIntervalMs) || 800;
  var maxAttempts    = Number(o.maxAttempts) || 30;
  var verifyDelayMs  = Number(o.verifyDelayMs) || 1500;
  // dryRun=true：只诊断不填充（让用户在不开填表时探查真实编辑器结构）
  var dryRun = !!o.dryRun;
  var payload = JSON.stringify({
    content:          String((o && o.content) || ''),
    selectors:        selectors,
    pollIntervalMs:   pollIntervalMs,
    maxAttempts:      maxAttempts,
    verifyDelayMs:    verifyDelayMs,
    dryRun:           dryRun
  });

  var FN =
    'function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    'function log(msg, extra){ try{ console.log("[X-publish][fill] " + msg + (extra ? " " + JSON.stringify(extra) : "")); }catch(_e){} }\n' +
    'function getWin(){ try{ return window; }catch(_e){ return null; } }\n' +
    'function getSel(){ var w = getWin(); return w && w.getSelection ? w.getSelection() : null; }\n' +
    'function getCS(el){ var w = getWin(); return (w && w.getComputedStyle) ? w.getComputedStyle(el) : null; }\n' +
    // 探测编辑器
    'function looksLikeEditor(el){\n' +
    '  try{\n' +
    '    var rect = el.getBoundingClientRect();\n' +
    '    if(!rect || rect.width <= 0 || rect.height <= 0) return false;\n' +
    '    var st = getCS(el);\n' +
    '    if(st && (st.visibility === "hidden" || st.display === "none")) return false;\n' +
    '    var testid = (el.getAttribute && el.getAttribute("data-testid")) || "";\n' +
    '    var role = (el.getAttribute && el.getAttribute("role")) || "";\n' +
    '    var aria = (el.getAttribute && el.getAttribute("aria-label")) || "";\n' +
    '    if(/search/i.test(testid)) return false;\n' +
    '    if(/search/i.test(role))   return false;\n' +
    '    if(/search/i.test(aria))   return false;\n' +
    '    if(/dm|message|chat/i.test(aria)) return false;\n' +
    '    if(/dm|message|chat/i.test(testid)) return false;\n' +
    '    return true;\n' +
    '  }catch(_e){ return false; }\n' +
    '}\n' +
    'function snapshot(el){\n' +
    '  if(!el) return null;\n' +
    '  var rect = el.getBoundingClientRect();\n' +
    '  var st = getCS(el);\n' +
    '  return {\n' +
    '    tagName: el.tagName,\n' +
    '    role: (el.getAttribute && el.getAttribute("role")) || "",\n' +
    '    ariaLabel: (el.getAttribute && el.getAttribute("aria-label")) || "",\n' +
    '    placeholder: (el.getAttribute && el.getAttribute("data-placeholder")) || (el.getAttribute && el.getAttribute("placeholder")) || "",\n' +
    '    dataTestid: (el.getAttribute && el.getAttribute("data-testid")) || "",\n' +
    '    dataText: (el.getAttribute && el.getAttribute("data-text")) || "",\n' +
    '    contenteditable: (el.getAttribute && el.getAttribute("contenteditable")) || "",\n' +
    '    visible: !!(rect && rect.width > 0 && rect.height > 0 && (!st || (st.visibility !== "hidden" && st.display !== "none"))),\n' +
    '    height: rect ? Math.round(rect.height) : 0,\n' +
    '    width: rect ? Math.round(rect.width) : 0\n' +
    '  };\n' +
    '}\n' +
    'function findEditor(selectors){\n' +
    '  if(!Array.isArray(selectors)) selectors = [selectors];\n' +
    '  var found = [];\n' +
    '  for(var i=0;i<selectors.length;i++){\n' +
    '    var sel = selectors[i]; if(!sel) continue;\n' +
    '    try{\n' +
    '      var nodes = document.querySelectorAll(sel);\n' +
    '      for(var j=0;j<nodes.length;j++){\n' +
    '        var el = nodes[j]; if(!el) continue;\n' +
    '        if(looksLikeEditor(el)) found.push({ el: el, selectorMatched: sel });\n' +
    '      }\n' +
    '    }catch(_se){ log("selector-query-failed", { sel: sel, error: String(_se&&_se.message||_se) }); }\n' +
    '  }\n' +
    '  return { primary: found[0] || null, candidates: found.length };\n' +
    '}\n' +
    'function readContent(el){\n' +
    '  if(!el) return "";\n' +
    '  if(typeof el.value === "string" && el.tagName === "TEXTAREA") return el.value;\n' +
    '  return String(el.textContent || el.innerText || "");\n' +
    '}\n' +
    // ---- <textarea> 真实 setter ----
    'function fillTextarea(el, text){\n' +
    '  try{\n' +
    '    if(typeof el.focus === "function") el.focus();\n' +
    '    var proto = HTMLTextAreaElement.prototype;\n' +
    '    var desc = Object.getOwnPropertyDescriptor(proto, "value");\n' +
    '    desc && desc.set && desc.set.call(el, String(text || ""));\n' +
    '    el.dispatchEvent(new InputEvent("input",  { bubbles: true, cancelable: true, data: String(text||""), inputType: "insertText" }));\n' +
    '    el.dispatchEvent(new Event("change", { bubbles: true }));\n' +
    '    try{\n' +
    '      var end = String(text || "").length;\n' +
    '      if(typeof el.setSelectionRange === "function") el.setSelectionRange(end, end);\n' +
    '    }catch(_e){}\n' +
    '    return { ok: true, method: "textarea-native-setter" };\n' +
    '  }catch(e){\n' +
    '    return { ok: false, method: "textarea-exception", error: String((e&&e.message)||e) };\n' +
    '  }\n' +
    '}\n' +
    // ---- 策略 A（唯一主路径）：派发原生 beforeinput(inputType=insertText) ----
    //   X (2024+) 的 Slate-based 编辑器 onBeforeInput 路由：
    //     - inputType='insertText'      → editor.insertText(data)    （最稳）
    //     - inputType='insertFromPaste' → editor.insertFragment(...) （依赖 DocumentFragment）
    //   **关键**：浏览器会在 beforeinput 被消费后自动派发 `input` 事件。
    //   **绝不**人为再次派发 `input`，否则 X 的 React 会处理两次 beforeinput
    //   流程（inputType=insertText）→ 文本被插两次 → 光标被推到错误位置。
    //   **绝不**使用 insertFromPaste 路径：X 在 insertFragment 路径下读
    //   `event.clipboardData.getData('text/plain')`，合成 InputEvent 的
    //   clipboardData 在多数浏览器为 null，导致 X 的 React 拿到空内容但
    //   仍然更新 Slate 的 selection anchor —— 视觉文本与 Slate 状态脱钩。
    //   只派发一次 beforeinput、让浏览器原生派 input，让 X 自己决定光标。
    'function fillPasteEvent(el, text){\n' +
    '  try{\n' +
    '    if(typeof el.focus === "function") el.focus();\n' +
    '    var w = getWin();\n' +
    '    var InputEventCtor = w && w.InputEvent;\n' +
    '    if(!InputEventCtor){ return { ok: false, method: "no-InputEvent" }; }\n' +
    '    // **修复 4（用户连续多次截图证实）**：X 编辑器不自动清空 Slate state——\n' +
    //   上一次填充留下的\"挖到一个宝藏…\"还在 DOM 里。insertFromPaste 在 anchor=末尾时\n' +
    //   只把新文本 append 在它之后，导致用户看到\"新文本被加在残留文案之后\"。\n' +
    //   **最小修正**：派发 beforeinput 之前用 Range 把所有子节点 select-all ——\n' +
    //   **不**直接动 DOM 子树（Slate 不会 rebuild），**只**改 selection，X 的 React 在\n' +
    //   insertFragment 路径下会读 selection 然后做\"replace selected fragment\"，自然覆盖。\n' +
    // 不再做 selectNodeContents——X Slate 不信任 DOM Range selection。\n' +
    '    // 关键修复：派发 beforeinput(inputType=insertFromPaste) + DataTransfer 真实 setData(\"text/plain\", text)。\n' +
    //   X 真实 React onBeforeInput handler 读 event.dataTransfer.getData(\"text/plain\") 拿到 text，\n' +
    //   走 editor.insertFragment(data) —— Slate 检测到 selection 非空走 replaceFragment，\n' +
    //   旧内容被新片段替换，**不**是 append。\n' +
    '    var DT = w.DataTransfer;\n' +
    '    var dt = null;\n' +
    '    if(DT){ try{ dt = new DT(); }catch(_e){} }\n' +
    '    if(dt){ try{ dt.setData(\"text/plain\", String(text||\"\")); }catch(_e){} }\n' +
    '    var dispatched = 0;\n' +
    '    try{\n' +
    '      var be = new InputEventCtor("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: String(text || "") });\n' +
    '      el.dispatchEvent(be);\n' +
    '      dispatched++;\n' +
    '    }catch(_e){ return { ok: false, method: \"beforeinput-threw\", error: String(_e&&_e.message||_e) }; }\n' +
    '    // 不再人为派发 input —— 浏览器在 beforeinput 被消费后会自己派 input。\n' +
    '    return { ok: true, method: "paste-event", dispatched: dispatched };\n' +
    '  }catch(e){\n' +
    '    return { ok: false, method: "paste-exception", error: String((e&&e.message)||e) };\n' +
    '  }\n' +
    '}\n' +
    // ---- 策略 B：原生 execCommand("insertText") 路径 ----
    //   不修改 X 的子节点结构；React 通过 beforeinput/input 自动同步。\n' +
    '   // 注：X (2024+) Slate 实现可能丢弃此事件，所以仅作 fallback。\n' +
    'function fillExecCommand(el, text){\n' +
    '  try{\n' +
    '    if(typeof el.focus === "function") el.focus();\n' +
    '    if(el.tagName === "TEXTAREA") return fillTextarea(el, text);\n' +
    '    var ok = false;\n' +
    // 关键：fillPasteEvent 内已 selectAll + delete 清空 Slate state；fallback **不**再 selectAll\n' +
    // 避免 Slate 二次 transform（选区 + 插入）。fallback 仅**插入**到当前 anchor。\n' +
    '    try{ document.execCommand("selectAll", false, null); }catch(_e){}\n' +
    '    try{ ok = document.execCommand("insertText", false, String(text || "")); }catch(_e){ ok = false; }\n' +
    '    return { ok: !!ok, method: ok ? "execCommand-insertText" : "execCommand-failed" };\n' +
    '  }catch(e){\n' +
    '    return { ok: false, method: "execCommand-exception", error: String((e&&e.message)||e) };\n' +
    '  }\n' +
    '}\n' +
    // ---- 策略 C：按 \\n 拆段，逐段 insertText + insertParagraph ----
    'function fillCharByChar(el, text){\n' +
    '  try{\n' +
    '    if(typeof el.focus === "function") el.focus();\n' +
    '    if(el.tagName === "TEXTAREA") return fillTextarea(el, text);\n' +
    '    try{ document.execCommand("selectAll", false, null); }catch(_e){}\n' +
    '    try{ document.execCommand("delete", false, null); }catch(_e){}\n' +
    '    var lines = String(text || "").split(/\\r?\\n/);\n' +
    '    for(var i=0;i<lines.length;i++){\n' +
    '      var seg = lines[i];\n' +
    '      if(seg.length > 0){\n' +
    '        var ok = false;\n' +
    '        try{ ok = document.execCommand("insertText", false, seg); }catch(_e){ ok = false; }\n' +
    '        if(!ok) return { ok: false, method: "insertText-failed-at-line-"+i };\n' +
    '      }\n' +
    '      if(i < lines.length - 1){\n' +
    '        try{ document.execCommand("insertParagraph", false, null); }catch(_e){}\n' +
    '      }\n' +
    '    }\n' +
    '    return { ok: true, method: "char-by-char" };\n' +
    '  }catch(e){\n' +
    '    return { ok: false, method: "char-exception", error: String((e&&e.message)||e) };\n' +
    '  }\n' +
    '}\n' +
    // ---- 诊断快照（填充前 + 填充后） ----
    'function diagSnapshot(stage){\n' +
    '  try{\n' +
    '    var sel = getSel();\n' +
    '    var sInfo = null;\n' +
    '    if(sel && sel.rangeCount > 0){\n' +
    '      var r0 = sel.getRangeAt(0);\n' +
    '      sInfo = { anchorOffset: r0.startOffset, focusOffset: r0.endOffset };\n' +
    '    }\n' +
    '    var childCount = el.childNodes ? el.childNodes.length : 0;\n' +
    '    var tn = 0;\n' +
    '    function w(n){ if(!n) return; if(n.nodeType === 3) { tn++; return; } for(var i=0;i<n.childNodes.length;i++) w(n.childNodes[i]); }\n' +
    '    w(el);\n' +
    '    var rect = el.getBoundingClientRect();\n' +
    '    log("snapshot stage=" + stage, {\n' +
    '      childCount: childCount,\n' +
    '      textNodeCount: tn,\n' +
    '      textContentLen: String(el.textContent || "").length,\n' +
    '      selection: sInfo,\n' +
    '      rectW: Math.round(rect.width),\n' +
    '      rectH: Math.round(rect.height),\n' +
    '      isFocused: document.activeElement === el\n' +
    '    });\n' +
    '  }catch(_e){}\n' +
    '}\n';

  var BODY =
    'var p2 = p;\n' +
    'var target = String((p2 && p2.content) || "");\n' +
    'var targetLen = target.length;\n' +
    'var targetPreview = target.slice(0, 50);\n' +
    'var dryRun = !!p2.dryRun;\n' +
    'var result = {\n' +
    '  ok: false, error: "",\n' +
    '  composer: null, fillMethod: null,\n' +
    '  contentBeforeLen: 0, contentAfterLen: 0,\n' +
    '  targetPreview: targetPreview, actualPreview: "",\n' +
    '  attempts: 0, elapsedMs: 0, candidates: 0,\n' +
    '  dryRun: dryRun\n' +
    '};\n' +
    'if(targetLen === 0 && !dryRun){ result.error = "empty-content"; log("abort: empty content"); return result; }\n' +
    'var startedAt = Date.now();\n' +
    'log("composer search start", { selectors: (p2.selectors||[]).length, maxAttempts: p2.maxAttempts, pollIntervalMs: p2.pollIntervalMs, dryRun: dryRun });\n' +
    'try{\n' +
    '  var hit = null;\n' +
    '  var attempt = 0;\n' +
    '  for(attempt = 1; attempt <= p2.maxAttempts; attempt++){\n' +
    '    result.attempts = attempt;\n' +
    '    var fr = findEditor(p2.selectors);\n' +
    '    result.candidates = fr.candidates;\n' +
    '    if(fr.primary){ log("composer found", { attempt: attempt, selector: fr.primary.selectorMatched, candidates: fr.candidates }); hit = fr.primary; break; }\n' +
    '    await sleep(p2.pollIntervalMs);\n' +
    '  }\n' +
    '  result.elapsedMs = Date.now() - startedAt;\n' +
    '  if(!hit){ result.error = "editor-not-found"; log("editor NOT FOUND after waiting", { attempts: result.attempts, candidates: result.candidates }); return result; }\n' +
    '  var el = hit.el;\n' +
    '  result.composer = snapshot(el);\n' +
    '  log("composer snapshot", result.composer);\n' +
    '  var before = readContent(el);\n' +
    '  result.contentBeforeLen = before.length;\n' +
    '  log("content length before = " + before.length + ", target length = " + targetLen);\n' +
    // 填充前：详细诊断
    '  diagSnapshot("before-fill");\n' +
    '  if(dryRun){ result.ok = true; log("DRY-RUN: skipped fill; diagnostic captured"); return result; }\n' +
    // 策略 A：派发合成 paste 事件（X / Slate 友好）
    '  var fr2 = fillPasteEvent(el, target);\n' +
    '  log("fill attempt 1 (paste-event)", { ok: fr2.ok, method: fr2.method, error: fr2.error });\n' +
    '  await sleep(80);\n' +
    '  var okFlag = !!fr2.ok;\n' +
    '  if(!okFlag){\n' +
    '    fr2 = fillExecCommand(el, target);\n' +
    '    log("fill attempt 2 (execCommand-insertText)", { ok: fr2.ok, method: fr2.method, error: fr2.error });\n' +
    '    await sleep(80);\n' +
    '    okFlag = !!fr2.ok;\n' +
    '  }\n' +
    '  if(!okFlag){\n' +
    '    fr2 = fillCharByChar(el, target);\n' +
    '    log("fill attempt 3 (char-by-char)", { ok: fr2.ok, method: fr2.method, error: fr2.error });\n' +
    '    okFlag = !!fr2.ok;\n' +
    '  }\n' +
    '  result.fillMethod = fr2 && fr2.method;\n' +
    '  if(!okFlag){ result.error = (fr2 && fr2.error) || "fill-failed"; log("FILL FAILED", fr2); return result; }\n' +
    // verify 策略：
    //   1) wait verifyDelayMs
    //   2) 读 textContent；空 / 不含 target → 真实 X 可能用 <br> 换行（textContent 读不出 \n）
    //      或 dispatchEvent 派发被 X isTrusted 过滤（X 2024+ Slate 已知会拦合成事件）
    //   3) 真正**回退**：派发失败时调 fillExecCommand（document.execCommand('insertText')）
    //      execCommand 走浏览器原生 onInput 桥接，**可能**被 X React 接收到
    //   4) 仍失败 → fillCharByChar（按 \n 拆段，逐段 execCommand insertText + insertParagraph）
    //   5) 全部失败才设 warning + ok=true（不阻塞 UI），但**日志会写明**
    '  function verifySucceeded(afterText){\n' +
    '    var probe = String(target).replace(/[\\r\\n\\s]+/g, " ").trim().slice(0, 20);\n' +
    '    var successByLen = afterText.length >= targetLen;\n' +
    '    var successByProbe = !probe || afterText.indexOf(probe) !== -1;\n' +
    '    return successByLen || successByProbe;\n' +
    '  }\n' +
    '  await sleep(p2.verifyDelayMs);\n' +
    '  var after = readContent(el);\n' +
    '  log("verify pass 1", { targetLen: targetLen, afterLen: after.length });\n' +
    '  if(!verifySucceeded(after)){\n' +
    // 重试 1：再等 500ms（X 真实 React 重渲染慢）\n' +
    '    await sleep(500);\n' +
    '    after = readContent(el);\n' +
    '    log("verify pass 2 (after +500ms)", { afterLen: after.length });\n' +
    '  }\n' +
    '  if(!verifySucceeded(after)){\n' +
    // 派发前已 fallback 在 fr2 = fillExecCommand / fillCharByChar 跑过。
    //   但 fillPasteEvent 永远返回 ok=true，**从未真正调** fallback。
    //   修复：在 verify 失败时**显式**调一次 fallback。\n' +
    '    log("verify failed, attempting fallback to execCommand-insertText", { afterLen: after.length, targetLen: targetLen });\n' +
    '    fr2 = fillExecCommand(el, target);\n' +
    '    log("fill fallback (execCommand-insertText)", { ok: fr2.ok, method: fr2.method, error: fr2.error });\n' +
    '    await sleep(500);\n' +
    '    after = readContent(el);\n' +
    '    log("verify pass after execCommand fallback", { afterLen: after.length });\n' +
    '    if(verifySucceeded(after)){\n' +
    '      result.fillMethod = fr2 && fr2.method;\n' +
    '    } else {\n' +
    // execCommand 也失败 → 试 char-by-char\n' +
    '      fr2 = fillCharByChar(el, target);\n' +
    '      log("fill fallback (char-by-char)", { ok: fr2.ok, method: fr2.method, error: fr2.error });\n' +
    '      await sleep(500);\n' +
    '      after = readContent(el);\n' +
    '      log("verify pass after char-by-char fallback", { afterLen: after.length });\n' +
    '      if(verifySucceeded(after)){\n' +
    '        result.fillMethod = fr2 && fr2.method;\n' +
    '      }\n' +
    '    }\n' +
    '  }\n' +
    '  if(!verifySucceeded(after)){\n' +
    // 全部失败：不再阻塞 UI，但**写明 warning**（用户能从日志看到真实情况）\n' +
    '    log("FILL WARN: textContent does not contain target after all strategies, dispatch-only", { targetPreview: result.targetPreview, actualPreview: after.slice(0,50) });\n' +
    '    result.actualPreview = after.slice(0, 50);\n' +
    '    result.contentAfterLen = after.length;\n' +
    '    result.warning = "unverified-text-mismatch";\n' +
    '    result.ok = true;\n' +
    '    return result;\n' +
    '  }\n' +
    '  result.actualPreview = after.slice(0, 50);\n' +
    '  result.contentAfterLen = after.length;\n' +
    // 填充后：诊断 —— 关键：不要主动修改 selection，让 X 自己管理
    '  diagSnapshot("after-fill");\n' +
    '  result.ok = true;\n' +
    '  log("FILL SUCCESS", { method: result.fillMethod, contentBeforeLen: result.contentBeforeLen, contentAfterLen: result.contentAfterLen, actualPreview: result.actualPreview });\n' +
    '}catch(e){\n' +
    '  result.error = String((e&&e.message)||e);\n' +
    '  log("FILL EXCEPTION", { error: result.error });\n' +
    '}\n' +
    'return result;\n';

  return '(async function(p){\n' + FN + BODY + '})(' + payload + ')';
}

module.exports = {
  buildXFillScript:      buildXFillScript,
  buildXDiagnosticScript: buildXDiagnosticScript,
  X_COMPOSER_SELECTORS:  X_COMPOSER_SELECTORS
};
