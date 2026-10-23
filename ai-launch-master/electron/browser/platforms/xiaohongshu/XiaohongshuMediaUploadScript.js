// Rokit · 小红书媒体上传 IIFE 脚本（v1.0）
// ----------------------------------------------------------------
// 职责：在小红书「发布笔记」页面找到 file input，按 accept / multiple 判断
//       是「图文」还是「视频」入口；通过 fetch + File + DataTransfer 设置文件
//       并触发 change 事件。
//
// 与 JikeMediaUploadScript 同源；新增功能：
//   - 探查 file input 时按以下优先级挑选：
//       1) accept 包含 video/*（视频笔记）
//       2) accept 包含 image/* 或 image/*,video/*（图文笔记）
//       3) 任意未禁用的 input[type="file"]
//   - 支持 multiple（图文笔记可一次拖入 1～9 张）。
//   - 支持"等待 videoFileInput / imageFileInput 出现后再上传"，避免页面
//     在切换发布模式时 file input 重建。
//
// 入参：
//   p.media = {
//     type: 'video' | 'image' | 'images',
//     items: [{ src:'data:...|https://...', name:'a.png', mime:'image/png' }, ...]
//   }
//   p.timeoutMs = 最长等待 file input 出现的时间（默认 15000ms）
//   p.platform = 'xiaohongshu'
//
// 输出：plain object { ok, found, mode, pickedCount, fileInputs,
//                     attempts, elapsedMs, error? }
'use strict';

function buildXiaohongshuMediaUploadScript(opts) {
  var o = opts || {};
  var media = o.media || null;
  var timeoutMs = Number(o.timeoutMs) || 15000;
  var payload = JSON.stringify({
    media: media,
    timeoutMs: timeoutMs
  });

  var FN =
    'function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    'function log(msg, extra){ try{ console.log("[Xiaohongshu][media] " + msg + (extra ? " " + JSON.stringify(extra) : "")); }catch(_e){} }\n' +
    // 探查所有 file input：accept / multiple / disabled / visible
    'function probeFileInputs(){\n' +
    '  var inputs=document.querySelectorAll("input[type=\\"file\\"]");\n' +
    '  log("file input count: " + inputs.length);\n' +
    '  var all=[];\n' +
    '  for(var i=0;i<inputs.length;i++){\n' +
    '    var inp=inputs[i]; if(!inp) continue;\n' +
    '    var accept=inp.getAttribute("accept")||"";\n' +
    '    var multiple=inp.hasAttribute("multiple");\n' +
    '    var style=window.getComputedStyle(inp);\n' +
    '    var visible=style.visibility!=="hidden" && style.display!=="none";\n' +
    '    var disabled=inp.disabled===true;\n' +
    '    all.push({ accept: accept, multiple: multiple, visible: visible, disabled: disabled });\n' +
    '  }\n' +
    '  if(all.length) log("file input list", all);\n' +
    '  return all;\n' +
    '}\n' +
    // 选 file input：根据 media.type 选择 video/image 通配
    'function pickFileInput(type){\n' +
    '  var inputs=document.querySelectorAll("input[type=\\"file\\"]");\n' +
    '  function isCandidate(inp){\n' +
    '    if(!inp || inp.disabled===true) return false;\n' +
    '    var accept=(inp.getAttribute("accept")||"").toLowerCase();\n' +
    '    if(type==="video"){\n' +
    '      return /video/i.test(accept) || /\\*\\/\\*|image\\|video|image,video|video,image/.test(accept) || accept==="";\n' +
    '    } else {\n' +
    '      return /image/i.test(accept) || /\\*\\/\\*|image\\|video|image,video|video,image/.test(accept) || accept==="";\n' +
    '    }\n' +
    '  }\n' +
    '  // 第一轮：accept 严格匹配 type\n' +
    '  for(var i=0;i<inputs.length;i++){\n' +
    '    var inp=inputs[i]; if(!isCandidate(inp)) continue;\n' +
    '    var accept=(inp.getAttribute("accept")||"").toLowerCase();\n' +
    '    if(type==="video" && /video/i.test(accept)) return inp;\n' +
    '    if(type==="image" && (/image/i.test(accept) && !/video/i.test(accept))) return inp;\n' +
    '  }\n' +
    '  // 第二轮：accept 含 image+video（含通配）\n' +
    '  for(var j=0;j<inputs.length;j++){\n' +
    '    var inp2=inputs[j]; if(!isCandidate(inp2)) continue;\n' +
    '    var a2=(inp2.getAttribute("accept")||"").toLowerCase();\n' +
    '    if(/image\\*\\s*,\\s*video|image\\/\\*|video\\/\\*|\\*\\/\\*/.test(a2)) return inp2;\n' +
    '  }\n' +
    '  // 第三轮：任何未禁用的 file input\n' +
    '  for(var k=0;k<inputs.length;k++){\n' +
    '    var inp3=inputs[k]; if(inp3 && !inp3.disabled) return inp3;\n' +
    '  }\n' +
    '  return null;\n' +
    '}\n' +
    'async function fetchToBlob(item){\n' +
    '  if(!item || !item.src) throw new Error("media.src 缺失");\n' +
    '  var src=String(item.src);\n' +
    '  var hintName=item.name || "media";\n' +
    '  if(/^data:/i.test(src)){\n' +
    '    var m=/^data:([^;,]+)?(;base64)?,(.*)$/i.exec(src);\n' +
    '    if(!m) throw new Error("data URL 解析失败");\n' +
    '    var mime=(m[1]||"application/octet-stream").toLowerCase();\n' +
    '    var isBase64=!!m[2];\n' +
    '    var body=m[3]||"";\n' +
    '    if(isBase64){\n' +
    '      var bin=atob(body);\n' +
    '      var bytes=new Uint8Array(bin.length);\n' +
    '      for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);\n' +
    '      var blob=new Blob([bytes], { type: mime });\n' +
    '    } else {\n' +
    '      var blob=new Blob([decodeURIComponent(body)], { type: mime });\n' +
    '    }\n' +
    '    return { blob: blob, mime: mime, hintName: hintName };\n' +
    '  }\n' +
    '  var res=await fetch(src, { credentials:"omit", mode:"cors" });\n' +
    '  if(!res.ok) throw new Error("fetch " + res.status + " " + res.statusText);\n' +
    '  var blob=await res.blob();\n' +
    '  var mime=String(blob.type||item.mime||"application/octet-stream").toLowerCase();\n' +
    '  var nm=hintName || (src.split("?")[0].split("#")[0].split("/").pop()) || "media";\n' +
    '  return { blob: blob, mime: mime, hintName: nm };\n' +
    '}\n' +
    // 等待 file input 出现（maxAttempts × pollIntervalMs）
    'async function waitFileInput(type, timeoutMs){\n' +
    '  var start=Date.now();\n' +
    '  var poll=400;\n' +
    '  var attempts=0;\n' +
    '  while(Date.now()-start<timeoutMs){\n' +
    '    attempts++;\n' +
    '    var inp=pickFileInput(type);\n' +
    '    if(inp){ return { input: inp, attempts: attempts }; }\n' +
    '    await sleep(poll);\n' +
    '  }\n' +
    '  return { input: null, attempts: attempts };\n' +
    '}\n' +
    // 等待上传完成指示器：图片预览 / 视频缩略图 / 上传进度条 消失
    'async function waitUploadDone(timeoutMs){\n' +
    '  var start=Date.now();\n' +
    '  var poll=400;\n' +
    '  while(Date.now()-start<timeoutMs){\n' +
    '    var progress=document.querySelectorAll("[class*=\\"progress\\" i],[class*=\\"uploading\\" i],[class*=\\"loading\\" i]");\n' +
    '    var busy=0;\n' +
    '    for(var i=0;i<progress.length;i++){\n' +
    '      var n=progress[i];if(!n) continue;\n' +
    '      var r=n.getBoundingClientRect();\n' +
    '      if(r.width>0 && r.height>0){ busy++; }\n' +
    '    }\n' +
    '    if(busy===0){\n' +
    '      // 额外探测：图片预览 img 数 ≥ 期望 / video 元素出现\n' +
    '      var imgs=document.querySelectorAll("img[class*=\\"preview\\" i],img[class*=\\"thumbnail\\" i]");\n' +
    '      return { done: true, attempts: 1, busyCount: 0, previewImgCount: imgs.length };\n' +
    '    }\n' +
    '    await sleep(poll);\n' +
    '  }\n' +
    '  return { done: false, attempts: 1, busyCount: 0 };\n' +
    '}\n';

  var BODY =
    'var p2 = p;\n' +
    'var media = p2.media;\n' +
    'var result = { ok: false, found: false, mode: "", pickedCount: 0, fileInputs: [], attempts: 0, elapsedMs: 0, error: "" };\n' +
    'if(!media || !(media.items && media.items.length)){\n' +
    '  result.error="no-media";\n' +
    '  log("no media to upload");\n' +
    '  return result;\n' +
    '}\n' +
    'var startedAt=Date.now();\n' +
    'try{\n' +
    '  result.fileInputs = probeFileInputs();\n' +
    '  var type = (media.type==="video") ? "video" : "image";\n' +
    '  result.mode = type;\n' +
    '  log("media upload start", { type: type, items: media.items.length, timeoutMs: p2.timeoutMs });\n' +
    '  var fw = await waitFileInput(type, p2.timeoutMs);\n' +
    '  result.attempts = fw.attempts;\n' +
    '  if(!fw.input){\n' +
    '    result.error = "no-file-input:"+type;\n' +
    '    log("file input NOT FOUND", { type: type, attempts: result.attempts });\n' +
    '    return result;\n' +
    '  }\n' +
    '  result.found = true;\n' +
    '  var input = fw.input;\n' +
    '  var files = [];\n' +
    '  for(var i=0;i<media.items.length;i++){\n' +
    '    var item = media.items[i]; if(!item || !item.src) continue;\n' +
    '    try{\n' +
    '      var f = await fetchToBlob(item);\n' +
    '      var fname = (f.hintName || "media").replace(/[^\\w.\\-\u4e00-\u9fa5]+/g, "_");\n' +
    '      if(f.mime.indexOf("video/")===0 && !/\\.\\w{2,4}$/.test(fname)) fname += ".mp4";\n' +
    '      if(f.mime.indexOf("image/")===0 && !/\\.\\w{2,4}$/.test(fname)) fname += ".jpg";\n' +
    '      var file = new File([f.blob], fname, { type: f.mime, lastModified: Date.now() });\n' +
    '      files.push(file);\n' +
    '    }catch(e){\n' +
    '      log("fetchToBlob FAILED", { index: i, error: String((e&&e.message)||e) });\n' +
    '    }\n' +
    '  }\n' +
    '  if(!files.length){\n' +
    '    result.error = "all-items-failed";\n' +
    '    log("all media items failed to convert");\n' +
    '    return result;\n' +
    '  }\n' +
    '  var dt = new DataTransfer();\n' +
    '  for(var j=0;j<files.length;j++) dt.items.add(files[j]);\n' +
    '  input.files = dt.files;\n' +
    '  input.dispatchEvent(new Event("input",  { bubbles: true, cancelable: true }));\n' +
    '  input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));\n' +
    '  result.pickedCount = files.length;\n' +
    '  // v3.0：dispatchEvent 已经触发，小红书开始接收上传任务。\n' +
    '  //   立即发 [XHS-UPLOAD] upload-started + [XHS-UPLOAD] set-file-result=success 信号，\n' +
    '  //   让 a.fill 编排器在 upload-started 后立即 fill title/content（不等上传完成）。\n' +
    '  //   waitUploadDone 的职责搬到 a.fill IIFE，由编排器决定何时等待。\n' +
    '  //   注意：这里"小红书开始上传"的判断是基于 dispatchEvent 已触发，而不是基于 DOM 上传\n' +
    '  //   完成信号 —— 这与用户新需求一致（upload-started 后立即 fill content）。\n' +
    '  result.uploadStartedAt = Date.now();\n' +
    '  result.fileNames = files.map(function(f){ return f.name; });\n' +
    '  result.totalSize = files.reduce(function(s, f){ return s + (f.size||0); }, 0);\n' +
    '  result.ok = true;\n' +
    '  result.elapsedMs = Date.now()-startedAt;\n' +
    '  try{ console.log("[XHS-UPLOAD] set-file-result=success"); }catch(_e){}\n' +
    '  try{ console.log("[XHS-UPLOAD] upload-started"); }catch(_e){}\n' +
    '  log("media upload dispatched (upload-started signal sent)", { type: type, count: result.pickedCount, totalSize: result.totalSize });\n' +
    '}catch(e){\n' +
    '  result.error = String((e&&e.message)||e);\n' +
    '  result.elapsedMs = Date.now()-startedAt;\n' +
    '  log("media upload FAILED", { error: result.error });\n' +
    '}\n' +
    'return result;\n';

  return '(async function(p){\n' + FN + BODY + '})(' + payload + ')';
}

module.exports = {
  buildXiaohongshuMediaUploadScript: buildXiaohongshuMediaUploadScript
};