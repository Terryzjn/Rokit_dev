// Rokit · 即刻媒体上传 IIFE 脚本（v1）
// ----------------------------------------------------------------
// 职责：在即刻动态框中找到文件 input（通常被页面隐藏），
//       通过 fetch + File + DataTransfer 设置文件并触发 change 事件。
//
// 入参：p.media = { type: 'video'|'image', src: 'https://...' | 'data:...' }
//       p.timeoutMs = 最长等待 input 出现的时间（默认 15000ms）
//
// 输出：plain object { ok, found, fileName, fileSize, fileType, mime,
//                     inputMethod, attempts, elapsedMs, error? }
//
// 注意：
//   - 不调 location.reload / history.pushState。
//   - 走一次 fetch，无重试：媒体是用户上传的资源，失败就如实报失败。
//   - file input 可能藏在 Shadow DOM 下；这里只在 light DOM 找（够即刻用）。
'use strict';

function buildJikeMediaUploadScript(opts) {
  var o = opts || {};
  var media = o.media || null;
  var timeoutMs = Number(o.timeoutMs) || 15000;
  var payload = JSON.stringify({
    media: media,
    timeoutMs: timeoutMs
  });

  var FN =
    'function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    'function log(msg, extra){ try{ console.log("[Jike][media] " + msg + (extra ? " " + JSON.stringify(extra) : "")); }catch(_e){} }\n' +
    // 找上传 input（多种形态：accept=image/* / video/* / file / hidden）
    'function findFileInput(){\n' +
    '  var sels = [\n' +
    '    "input[type=\\"file\\"][accept*=\\"video\\"]",\n' +
    '    "input[type=\\"file\\"][accept*=\\"image\\"]",\n' +
    '    "input[type=\\"file\\"][accept*=\\"image/video\\"]",\n' +
    '    "input[type=\\"file\\"]:not([accept])",\n' +
    '    "input[type=\\"file\\"]"\n' +
    '  ];\n' +
    '  for(var i=0;i<sels.length;i++){\n' +
    '    var nodes = document.querySelectorAll(sels[i]);\n' +
    '    for(var j=0;j<nodes.length;j++){\n' +
    '      var n = nodes[j]; if(!n) continue;\n' +
    '      // 跳过带 disabled 的；但允许 hidden（display:none）的，页面常用 hidden file input\n' +
    '      if(n.disabled) continue;\n' +
    '      return { el: n, selector: sels[i] };\n' +
    '    }\n' +
    '  }\n' +
    '  return null;\n' +
    '}\n' +
    // fetch + File + DataTransfer
    'async function fetchToFile(media){\n' +
    '  if(!media || !media.src) throw new Error("media.src 缺失");\n' +
    '  var src = String(media.src);\n' +
    '  // data URL 直接 base64 解码\n' +
    '  if(/^data:/i.test(src)){\n' +
    '    var m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(src);\n' +
    '    if(!m) throw new Error("data URL 解析失败");\n' +
    '    var mime = (m[1] || "application/octet-stream").toLowerCase();\n' +
    '    var isBase64 = !!m[2];\n' +
    '    var body = m[3] || "";\n' +
    '    if(isBase64){\n' +
    '      var bin = atob(body);\n' +
    '      var bytes = new Uint8Array(bin.length);\n' +
    '      for(var i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);\n' +
    '      var blob = new Blob([bytes], { type: mime });\n' +
    '    } else {\n' +
    '      var blob = new Blob([decodeURIComponent(body)], { type: mime });\n' +
    '    }\n' +
    '    return { blob: blob, mime: mime, hintName: media.name || "image" };\n' +
    '  }\n' +
    '  // http(s) URL：fetch + content-type\n' +
    '  var res = await fetch(src, { credentials: "omit", mode: "cors" });\n' +
    '  if(!res.ok) throw new Error("fetch " + res.status + " " + res.statusText);\n' +
    '  var blob = await res.blob();\n' +
    '  var mime = String(blob.type || media.type || "application/octet-stream").toLowerCase();\n' +
    '  // 从 URL 抽 filename\n' +
    '  var hintName = media.name || (src.split("?")[0].split("#")[0].split("/").pop() || "media");\n' +
    '  return { blob: blob, mime: mime, hintName: hintName };\n' +
    '}\n';

  var BODY =
    'var p2 = p;\n' +
    'var media = p2.media;\n' +
    'var result = { ok: false, found: false, fileName: "", fileSize: 0, fileType: "", mime: "", inputMethod: "", attempts: 0, elapsedMs: 0, error: "" };\n' +
    'if(!media){ result.error = "no-media"; log("no media to upload"); return result; }\n' +
    'var startedAt = Date.now();\n' +
    'var input = null;\n' +
    'var attempt = 0;\n' +
    'var pollInterval = 500;\n' +
    'var maxAttempts = Math.max(1, Math.floor(p2.timeoutMs / pollInterval));\n' +
    'log("media upload start", { mediaType: media.type || "", srcLen: String(media.src || "").length, timeoutMs: p2.timeoutMs });\n' +
    'try {\n' +
    '  for(attempt=1; attempt<=maxAttempts; attempt++){\n' +
    '    result.attempts = attempt;\n' +
    '    var found = findFileInput();\n' +
    '    if(found){ input = found; result.found = true; result.inputMethod = found.selector; log("file input found", { selector: found.selector }); break; }\n' +
    '    await sleep(pollInterval);\n' +
    '  }\n' +
    '  result.elapsedMs = Date.now() - startedAt;\n' +
    '  if(!input){\n' +
    '    result.error = "no-file-input";\n' +
    '    log("file input NOT FOUND", { attempts: result.attempts });\n' +
    '    return result;\n' +
    '  }\n' +
    '  var f = await fetchToFile(media);\n' +
    '  var fileName = (f.hintName || "media").replace(/[^\\w.\\-\u4e00-\u9fa5]+/g, "_");\n' +
    '  // 即刻对扩展名是动态的（video/mp4 → .mp4）\n' +
    '  if(f.mime.indexOf("video/") === 0 && !/\\.\\w{2,4}$/.test(fileName)) fileName += ".mp4";\n' +
    '  if(f.mime.indexOf("image/") === 0 && !/\\.\\w{2,4}$/.test(fileName)) fileName += ".jpg";\n' +
    '  var file = new File([f.blob], fileName, { type: f.mime, lastModified: Date.now() });\n' +
    '  var dt = new DataTransfer();\n' +
    '  dt.items.add(file);\n' +
    '  input.el.files = dt.files;\n' +
    '  input.el.dispatchEvent(new Event("input",  { bubbles: true, cancelable: true }));\n' +
    '  input.el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));\n' +
    '  result.ok = true;\n' +
    '  result.fileName = file.name;\n' +
    '  result.fileSize = file.size;\n' +
    '  result.fileType = file.type;\n' +
    '  result.mime = file.type;\n' +
    '  log("media upload dispatched", { fileName: file.name, size: file.size, type: file.type });\n' +
    '} catch(e){\n' +
    '  result.error = String((e && e.message) || e);\n' +
    '  log("media upload FAILED", { error: result.error });\n' +
    '}\n' +
    'return result;\n';

  return '(async function(p){\n' + FN + BODY + '})(' + payload + ')';
}

module.exports = {
  buildJikeMediaUploadScript: buildJikeMediaUploadScript
};