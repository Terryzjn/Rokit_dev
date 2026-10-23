// Rokit · Product Hunt 媒体上传 IIFE 脚本（v1）
// ----------------------------------------------------------------
// 职责：在 Product Hunt 提交页找到 file input（图片或视频）；
//       通过 fetch + File + DataTransfer 设置文件并触发 change 事件。
//
// 与 Jike 版差异：
//   - Product Hunt 表单以「图片」为主；视频不是必填。
//   - 必须打印每个 input[type=file] 的 accept / multiple / visible，
//     便于出错时人工核实（按用户规范第八条）。
//   - 支持三种 media.src：https URL / data URL / 文件 data URL。
//
// 输入（payload）：
//   p.media = { type: 'image'|'video', src: 'https://...' | 'data:...',
//               name?: string, mime?: string }
//   p.timeoutMs   - 最长等待 input 出现的时间
//
// 输出：
//   {
//     ok, found, fileInputs (probe),
//     fileName, fileSize, fileType, mime,
//     inputMethod, attempts, elapsedMs, error?
//   }
'use strict';

function buildProductHuntMediaUploadScript(opts) {
  var o = opts || {};
  var media = o.media || null;
  var timeoutMs = Number(o.timeoutMs) || 15000;

  var payload = JSON.stringify({
    media: media,
    timeoutMs: timeoutMs
  });

  var FN =
    'function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    'function log(msg, extra){ try{ console.log("[ProductHunt][media] " + msg + (extra ? " " + JSON.stringify(extra) : "")); }catch(_e){} }\n' +
    // ---- 探查所有 file input，按用户要求打印 accept/multiple/visible ----
    'function probeFileInputs(){\n' +
    '  var inputs = document.querySelectorAll("input[type=\\"file\\"]");\n' +
    '  log("file input count: " + inputs.length);\n' +
    '  var report = [];\n' +
    '  var imagePicked = null;\n' +
    '  var videoPicked = null;\n' +
    '  var anyPicked   = null;\n' +
    '  for(var i=0; i<inputs.length; i++){\n' +
    '    var inp = inputs[i]; if(!inp) continue;\n' +
    '    var accept   = inp.getAttribute("accept") || "";\n' +
    '    var multiple = inp.hasAttribute("multiple");\n' +
    '    var style    = window.getComputedStyle(inp);\n' +
    '    var visible  = style.visibility !== "hidden" && style.display !== "none";\n' +
    '    var disabled = inp.disabled === true;\n' +
    '    var type     = inp.getAttribute("type") || "";\n' +
    '    var name     = inp.getAttribute("name") || "";\n' +
    '    var rec = { index:i, accept:accept, multiple:multiple, visible:visible, disabled:disabled, type:type, name:name };\n' +
    '    report.push(rec);\n' +
    '    log("file input #" + i, rec);\n' +
    '    if(disabled) continue;\n' +
    '    if(!anyPicked) anyPicked = inp;\n' +
    '    if(!imagePicked && /image/i.test(accept)) imagePicked = inp;\n' +
    '    if(!videoPicked && /video/i.test(accept)) videoPicked = inp;\n' +
    '  }\n' +
    '  return { inputs: report, imagePicked: imagePicked, videoPicked: videoPicked, anyPicked: anyPicked };\n' +
    '}\n' +
    // ---- 等待 file input 出现 ----
    'async function waitFileInput(timeoutMs){\n' +
    '  var start = Date.now();\n' +
    '  var poll  = 400;\n' +
    '  var attempts = 0;\n' +
    '  while(Date.now() - start < timeoutMs){\n' +
    '    attempts++;\n' +
    '    var p = probeFileInputs();\n' +
    '    if(p.imagePicked || p.videoPicked || p.anyPicked){\n' +
    '      return { probe: p, attempts: attempts };\n' +
    '    }\n' +
    '    await sleep(poll);\n' +
    '  }\n' +
    '  var last = probeFileInputs();\n' +
    '  return { probe: last, attempts: attempts };\n' +
    '}\n' +
    // ---- fetch + File + DataTransfer ----
    'async function fetchToFile(media){\n' +
    '  if(!media || !media.src) throw new Error("media.src 缺失");\n' +
    '  var src = String(media.src);\n' +
    '  if(/^data:/i.test(src)){\n' +
    '    var m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(src);\n' +
    '    if(!m) throw new Error("data URL 解析失败");\n' +
    '    var mime = (m[1] || "application/octet-stream").toLowerCase();\n' +
    '    var isBase64 = !!m[2];\n' +
    '    var body = m[3] || "";\n' +
    '    var blob;\n' +
    '    if(isBase64){\n' +
    '      var bin = atob(body);\n' +
    '      var bytes = new Uint8Array(bin.length);\n' +
    '      for(var i=0; i<bin.length; i++) bytes[i] = bin.charCodeAt(i);\n' +
    '      blob = new Blob([bytes], { type: mime });\n' +
    '    } else {\n' +
    '      blob = new Blob([decodeURIComponent(body)], { type: mime });\n' +
    '    }\n' +
    '    return { blob: blob, mime: mime, hintName: media.name || "image" };\n' +
    '  }\n' +
    '  // http(s) URL\n' +
    '  var res = await fetch(src, { credentials: "omit", mode: "cors" });\n' +
    '  if(!res.ok) throw new Error("fetch " + res.status + " " + res.statusText);\n' +
    '  var blob2 = await res.blob();\n' +
    '  var mime2 = String(blob2.type || media.type || "application/octet-stream").toLowerCase();\n' +
    '  var hintName = media.name || (src.split("?")[0].split("#")[0].split("/").pop() || "media");\n' +
    '  return { blob: blob2, mime: mime2, hintName: hintName };\n' +
    '}\n' +
    // ---- 选择 input：video 优先 videoPicked；否则 imagePicked；否则 anyPicked ----
    'function pickInput(probe, mediaType){\n' +
    '  if(!probe) return null;\n' +
    '  if(mediaType === "video" && probe.videoPicked) return { el: probe.videoPicked, matchedBy: "video" };\n' +
    '  if(mediaType === "image" && probe.imagePicked) return { el: probe.imagePicked, matchedBy: "image" };\n' +
    '  // fallback：接受 image 和 video 的 input\n' +
    '  if(probe.imagePicked) return { el: probe.imagePicked, matchedBy: "image-fallback" };\n' +
    '  if(probe.videoPicked) return { el: probe.videoPicked, matchedBy: "video-fallback" };\n' +
    '  if(probe.anyPicked)   return { el: probe.anyPicked,   matchedBy: "any-file" };\n' +
    '  return null;\n' +
    '}\n';

  var BODY =
    'var p2 = p;\n' +
    'var media = p2.media;\n' +
    'var result = {\n' +
    '  ok:false, found:false, fileInputs:[],\n' +
    '  fileName:"", fileSize:0, fileType:"", mime:"",\n' +
    '  inputMethod:"", attempts:0, elapsedMs:0, error:""\n' +
    '};\n' +
    'if(!media){ result.error="no-media"; log("no media to upload"); return result; }\n' +
    'var startedAt = Date.now();\n' +
    'try{\n' +
    '  var w = await waitFileInput(p2.timeoutMs);\n' +
    '  result.fileInputs = w.probe.inputs;\n' +
    '  result.attempts   = w.attempts;\n' +
    '  if(!w.probe.imagePicked && !w.probe.videoPicked && !w.probe.anyPicked){\n' +
    '    result.error = "no-file-input";\n' +
    '    result.elapsedMs = Date.now() - startedAt;\n' +
    '    log("file input NOT FOUND", { attempts: w.attempts });\n' +
    '    return result;\n' +
    '  }\n' +
    '  result.found = true;\n' +
    '  var picked = pickInput(w.probe, media.type || "");\n' +
    '  if(!picked){ result.error="picker-empty"; result.elapsedMs = Date.now() - startedAt; return result; }\n' +
    '  result.inputMethod = picked.matchedBy;\n' +
    '  var f = await fetchToFile(media);\n' +
    '  var fileName = (f.hintName || "media").replace(/[^\\w.\\-\u4e00-\u9fa5]+/g, "_");\n' +
    '  if(f.mime.indexOf("video/") === 0 && !/\\.\\w{2,4}$/.test(fileName)) fileName += ".mp4";\n' +
    '  if(f.mime.indexOf("image/") === 0 && !/\\.\\w{2,4}$/.test(fileName)) fileName += ".jpg";\n' +
    '  var file = new File([f.blob], fileName, { type: f.mime, lastModified: Date.now() });\n' +
    '  var dt = new DataTransfer();\n' +
    '  dt.items.add(file);\n' +
    '  picked.el.files = dt.files;\n' +
    '  picked.el.dispatchEvent(new Event("input",  { bubbles:true, cancelable:true }));\n' +
    '  picked.el.dispatchEvent(new Event("change", { bubbles:true, cancelable:true }));\n' +
    '  result.ok = true;\n' +
    '  result.fileName = file.name;\n' +
    '  result.fileSize = file.size;\n' +
    '  result.fileType = file.type;\n' +
    '  result.mime     = file.type;\n' +
    '  result.elapsedMs = Date.now() - startedAt;\n' +
    '  log("media upload dispatched", { fileName: file.name, size: file.size, type: file.type, matchedBy: picked.matchedBy });\n' +
    '}catch(e){\n' +
    '  result.error = String((e&&e.message)||e);\n' +
    '  result.elapsedMs = Date.now() - startedAt;\n' +
    '  log("media upload FAILED", { error: result.error });\n' +
    '}\n' +
    'return result;\n';

  return '(async function(p){\n' + FN + BODY + '})(' + payload + ')';
}

module.exports = {
  buildProductHuntMediaUploadScript: buildProductHuntMediaUploadScript
};