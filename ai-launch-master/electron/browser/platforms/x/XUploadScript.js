// Rokit · X (Twitter) Compose Post 媒体上传 IIFE（v1.0 phase 2）
// ----------------------------------------------------------------
// 职责：在 X 的 /compose/post 弹窗中寻找媒体 input[type="file"]，
//       通过 DataTransfer + File + change 事件把媒体文件附给编辑框。
//
// 关键设计：
//   1) X 当前媒体上传采用「先把文件附给 input[type=file] 再等 React 走 XHR」的模式。
//      input 可能藏在 dialog 内，但仍在 light DOM。
//   2) 支持 video / image（多图 1~4 张 / 视频 1 个）。这里按 main 传入的 mediaItems 数组依次喂入。
//      React 在 single change 事件内会同时处理多个 file。
//   3) 上传完成后检测媒体"已附上"的 DOM 信号：
//      - data-testid="tweetPhoto" (image)
//      - img[src*="twimg.com/media"] 或 video[src] 预览
//      - [data-testid="previewCard"] 等
//      检测方式：找到任何带媒体容器 / 包含预览节点，即视为已附加完成。
//
// 不做：
//   - 不点击 Post。
//   - 不修改已经成功的登录 / 跳转 / 找编辑器逻辑。
//   - 不重复上传。
//
// 入参：
//   {
//     mediaItems: [{
//       type: 'video' | 'image',
//       src:  'data:...' | 'https://...',   // dataURL 直接 base64 解码；http 由 fetch 拿
//       name: string                        // 可选，文件提示名
//     }],
//     timeoutMs: number  // 找 input 的超时；默认 15000
//   }
//
// 输出：
//   {
//     ok:                boolean,
//     error:             string?,
//     items:             [{ n: string, size: number, type: string, mime: string, status: 'dispatched'|'failed', error: string }],
//     totalFound:        number,        // 1 = 找到了 input
//     inputMethod:       string,        // selector that matched the file input
//     attempts:          number,
//     elapsedMs:         number,
//     postUploadMarker:  boolean        // 是否检测到媒体预览已渲染
//   }
'use strict';

function buildXUploadScript(opts) {
  var o = opts || {};
  var mediaItems = Array.isArray(o.mediaItems) ? o.mediaItems : [];
  var timeoutMs = Number(o.timeoutMs) || 30000;
  var pollIntervalMs = Number(o.pollIntervalMs) || 600;
  var verifyDelayMs = Number(o.verifyDelayMs) || 4000;
  var maxVideoBytes = Number(o.maxVideoBytes) || (80 * 1024 * 1024); // 与 main 同源

  var payload = JSON.stringify({
    mediaItems: mediaItems,
    timeoutMs: timeoutMs,
    pollIntervalMs: pollIntervalMs,
    verifyDelayMs: verifyDelayMs,
    maxVideoBytes: maxVideoBytes
  });

  var FN =
    'function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    'function log(msg, extra){ try{ console.log("[X-publish][upload] " + msg + (extra ? " " + JSON.stringify(extra) : "")); }catch(_e){} }\n' +
    // v1.x：扩展选择器，把 hidden file inputs 也找到；优先匹配 accept 含视频的 input。
    'function findFileInput(){\n' +
    '  var all = Array.from(document.querySelectorAll("input[type=\\"file\\"]"));\n' +
    '  log("file input probe (n=" + all.length + ")");\n' +
    '  if(!all.length) return null;\n' +
    '  var best = null;\n' +
    '  for(var i=0;i<all.length;i++){\n' +
    '    var n = all[i]; if(!n || n.disabled) continue;\n' +
    '    var accept = String(n.accept||"");\n' +
    '    var hasVideo = /video/i.test(accept);\n' +
    '    var hasImage = /image/i.test(accept);\n' +
    '    var visible = (function () {\n' +
    '      var st = (typeof getComputedStyle === "function") ? getComputedStyle(n) : null;\n' +
    '      var rect = n.getBoundingClientRect ? n.getBoundingClientRect() : { width: 0, height: 0 };\n' +
    '      var widthOk = rect && rect.width > 0;\n' +
    '      var heightOk = rect && rect.height > 0;\n' +
    '      var visOk = !st || (st.visibility !== "hidden" && st.display !== "none");\n' +
    '      return widthOk && heightOk && visOk;\n' +
    '    } () );\n' +
    '    log("file input #" + i, { accept: accept, hasVideo: hasVideo, hasImage: hasImage, visible: visible, multiple: n.multiple });\n' +
    '    // 优先：含 video 的；再退：含 image 的；最后：任意 file\n' +
    '    if(hasVideo && !best) best = n;\n' +
    '  }\n' +
    '  if(best) return { el: best, selector: "input[type=file][accept*=video]" };\n' +
    '  for(var j=0;j<all.length;j++){\n' +
    '    var n2 = all[j]; if(!n2 || n2.disabled) continue;\n' +
    '    var acc2 = String(n2.accept||"");\n' +
    '    if(/image/.test(acc2)) return { el: n2, selector: "input[type=file][accept*=image]" };\n' +
    '  }\n' +
    '  for(var k=0;k<all.length;k++){\n' +
    '    var n3 = all[k]; if(!n3 || n3.disabled) continue;\n' +
    '    return { el: n3, selector: "input[type=file]" };\n' +
    '  }\n' +
    '  return null;\n' +
    '}\n' +
    // fetch + base64 -> File。增加 size 校验：超过 maxBytes 则抛错（自带文件大小保护）。
    'async function fetchToFile(media, maxBytes){\n' +
    '  if(!media || !media.src) throw new Error("media.src 缺失");\n' +
    '  var src = String(media.src);\n' +
    '  var hintName = (media.name && String(media.name)) || (src.split("?")[0].split("#")[0].split("/").pop() || "media");\n' +
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
    '      for(var i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);\n' +
    '      blob = new Blob([bytes], { type: mime });\n' +
    '    } else {\n' +
    '      blob = new Blob([decodeURIComponent(body)], { type: mime });\n' +
    '    }\n' +
    '    if(maxBytes && blob.size > maxBytes){\n' +
    '      log("fetchToFile: skip oversized blob", { size: blob.size, max: maxBytes, mime: mime });\n' +
    '      throw new Error("media 超过 size 上限：" + blob.size + " > " + maxBytes);\n' +
    '    }\n' +
    '    return { blob: blob, mime: mime, hintName: hintName, size: blob.size };\n' +
    '  }\n' +
    '  var res = await fetch(src, { credentials: "omit", mode: "cors" });\n' +
    '  if(!res.ok) throw new Error("fetch " + res.status + " " + res.statusText);\n' +
    '  var blob2 = await res.blob();\n' +
    '  var mime2 = String(blob2.type || media.type || "application/octet-stream").toLowerCase();\n' +
    '  if(maxBytes && blob2.size > maxBytes){\n' +
    '    log("fetchToFile: skip oversized blob (http)", { size: blob2.size, max: maxBytes, mime: mime2 });\n' +
    '    throw new Error("media 超过 size 上限：" + blob2.size + " > " + maxBytes);\n' +
    '  }\n' +
    '  return { blob: blob2, mime: mime2, hintName: hintName, size: blob2.size };\n' +
    '}\n' +
    // 上传完成后检测"媒体已附上"的 DOM 信号（更多 selector 兜底，避免被改版命中漏）
    'function detectMediaAttached(){\n' +
    '  try{\n' +
    '    var sels = [\n' +
    '      "[data-testid=\\"tweetPhoto\\"]",\n' +
    '      "[data-testid=\\"tweetVideo\\"]",\n' +
    '      "[data-testid=\\"videoThumbnail\\"]",\n' +
    '      "[data-testid=\\"previewCard\\"]",\n' +
    '      "[data-testid=\\"mediaContainer\\"]",\n' +
    '      "[data-testid=\\"RichText\\"] img[src*=twimg]" ,\n' +
    '      "[data-testid=\\"RichText\\"] video[src]" \n' +
    '    ];\n' +
    '    for(var i=0;i<sels.length;i++){\n' +
    '      try{\n' +
    '        var nodes = document.querySelectorAll(sels[i]);\n' +
    '        if(nodes && nodes.length > 0) return { found: true, selector: sels[i], count: nodes.length };\n' +
    '      }catch(_se){}\n' +
    '    }\n' +
    '    return { found: false };\n' +
    '  }catch(_e){ return { found: false, error: String(_e&&_e.message||_e) }; }\n' +
    '}\n';

  var BODY =
    'var p3 = p;\n' +
    'var mediaItems = Array.isArray(p3.mediaItems) ? p3.mediaItems : [];\n' +
    'var result = {\n' +
    '  ok: false, error: "",\n' +
    '  items: [],\n' +
    '  totalFound: 0, inputMethod: "",\n' +
    '  attempts: 0, elapsedMs: 0,\n' +
    '  postUploadMarker: false\n' +
    '};\n' +
    'if(!mediaItems.length){ result.error = "no-media"; log("no media items"); return result; }\n' +
    'var startedAt = Date.now();\n' +
    'var input = null;\n' +
    'var attempt = 0;\n' +
    'var maxAttempts = Math.max(1, Math.floor(p3.timeoutMs / p3.pollIntervalMs));\n' +
    'log("media upload start", { items: mediaItems.length, timeoutMs: p3.timeoutMs, pollIntervalMs: p3.pollIntervalMs });\n' +
    'try{\n' +
    '  for(attempt=1; attempt<=maxAttempts; attempt++){\n' +
    '    result.attempts = attempt;\n' +
    '    var f = findFileInput();\n' +
    '    if(f){ input = f; result.totalFound = 1; result.inputMethod = f.selector; log("file input found", { selector: f.selector, attempt: attempt }); break; }\n' +
    '    await sleep(p3.pollIntervalMs);\n' +
    '  }\n' +
    '  result.elapsedMs = Date.now() - startedAt;\n' +
    '  if(!input){ result.error = "no-file-input"; log("file input NOT FOUND", { attempts: result.attempts }); return result; }\n' +
    '  // 构造 DataTransfer + 多个 File，一次性触发 change\n' +
    '  var dt = new DataTransfer();\n' +
    '  var dispatchedAny = false;\n' +
    '  for(var i=0;i<mediaItems.length;i++){\n' +
    '    var m = mediaItems[i];\n' +
    '    try{\n' +
    '      var f2 = await fetchToFile(m, p3.maxVideoBytes);\n' +
    '      var fileName = (f2.hintName || "media").replace(/[^\\w.\\-\u4e00-\u9fa5]+/g, "_");\n' +
    '      if(f2.mime.indexOf("video/") === 0 && !/\\.\\w{2,4}$/.test(fileName)) fileName += ".mp4";\n' +
    '      if(f2.mime.indexOf("image/") === 0 && !/\\.\\w{2,4}$/.test(fileName)) fileName += ".jpg";\n' +
    '      var file = new File([f2.blob], fileName, { type: f2.mime, lastModified: Date.now() });\n' +
    '      dt.items.add(file);\n' +
    '      result.items.push({ n: file.name, size: file.size, type: file.type, mime: file.type, status: "dispatched", error: "" });\n' +
    '      dispatchedAny = true;\n' +
    '    }catch(e){\n' +
    '      var err = String((e&&e.message)||e);\n' +
    '      log("fetchToFile skipped item #" + i, { error: err });\n' +
    '      result.items.push({ n: (m && m.name) || "", size: 0, type: (m && m.type) || "", mime: (m && m.type) || "", status: "failed", error: err });\n' +
    '    }\n' +
    '  }\n' +
    '  if(!dispatchedAny){ result.error = "all-fetch-failed"; log("all fetchToFile failed"); return result; }\n' +
    '  input.el.files = dt.files;\n' +
    '  input.el.dispatchEvent(new Event("input",  { bubbles: true, cancelable: true }));\n' +
    '  input.el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));\n' +
    '  log("media upload dispatched", { itemCount: result.items.length });\n' +
    '  // 给 React / X 后台一点时间渲染预览（视频上传更慢 → 最多轮询 verify）\n' +
    '  var verifyStart = Date.now();\n' +
    '  var verifyTimeoutMs = Math.max(p3.verifyDelayMs, p3.timeoutMs - (Date.now() - startedAt));\n' +
    '  var det = { found: false };\n' +
    '  while(Date.now() - verifyStart < verifyTimeoutMs){\n' +
    '    det = detectMediaAttached();\n' +
    '    if(det.found) break;\n' +
    '    await sleep(500);\n' +
    '  }\n' +
    '  result.postUploadMarker = !!det.found;\n' +
    '  log("media upload verify", { postUploadMarker: result.postUploadMarker, markerInfo: det, dispatched: result.items.length, expected: mediaItems.length });\n' +
    '  result.ok = true;\n' +
    '}catch(e){\n' +
    '  result.error = String((e&&e.message)||e);\n' +
    '  log("media upload EXCEPTION", { error: result.error });\n' +
    '}\n' +
    'return result;\n';

  return '(async function(p){\n' + FN + BODY + '})(' + payload + ')';
}

module.exports = {
  buildXUploadScript: buildXUploadScript
};