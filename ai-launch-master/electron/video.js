// Rokit · 视频后处理（v1.5 MVP）
// 职责：拿到 recorder.js 产出的 WebM，做下列转换（通过 ffmpeg-static）：
//   1) transcodeWebmToMp4()：WebM → MP4（H.264 + AAC），便于上传 GitHub Releases / 微信 / 飞书
//   2) generateThumbnail()：从 WebM 在 t=2s 取一张封面图（默认 1280x720）
//   3) trim()：掐头去尾（-ss + -t）
//   4) getMetadata()：读时长 / 分辨率 / 编码
//
// 设计：
//   - 所有 ffmpeg 调用统一走 spawn + Promise，避免阻塞主进程
//   - 单文件串行排队（避免同时跑多个 ffmpeg 把 CPU 打满）
//   - 失败时 stderr 头 600 字回传，便于 UI 显示给用户
//   - v1.20.1：路径解析与 spawn 失败处理统一交给 ffmpeg-resolver.js
//     （修复 EFTYPE / spawn-failed / corrupt-binary 的根因）

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { app } = require('electron');
const ffmpegResolver = require('./ffmpeg-resolver');

// 兼容旧接口：video.js 之外的调用方（recorder.js / ai-demo.js）仍可用 `require('./video').ffmpegPath()`
function ffmpegPath() {
  return ffmpegResolver.ffmpegPath();
}
function ffmpegAvailable() {
  return ffmpegResolver.ffmpegAvailable();
}

// 详细诊断信息：路径、来源、是否可执行
function ffmpegDiagnostic() {
  const r = ffmpegResolver.resolveFfmpegPath();
  if (!r.ok) {
    return {
      ok: false,
      error: r.reason || 'no-runnable-ffmpeg',
      tried: (r.tried || []).map(function(t){ return { source: t.source, path: t.path, reason: t.reason || '' }; })
    };
  }
  return { ok: true, path: r.path, source: r.source };
}

function outputDir(sub) {
  try {
    return path.join(app.getPath('userData'), 'video', sub || '');
  } catch (_e) {
    return path.join(os.tmpdir(), 'rokit-video', sub || '');
  }
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_e) {}
}

// 串行队列：避免并发 ffmpeg
let queue = Promise.resolve();
function enqueue(fn) {
  const next = queue.then(function () { return fn(); }, function () { return fn(); });
  // 永不 reject 整个队列（单个任务失败不影响后续）
  queue = next.catch(function () { return null; });
  return next;
}

// v1.20.1：构造可诊断的 ffmpeg 不可用错误（含完整 tried 链），替代裸 'ffmpeg-missing'
function ffmpegUnavailableError() {
  const r = ffmpegResolver.resolveFfmpegPath();
  const tried = (r.tried || []).map(function (t) {
    return t.source + (t.path ? '(' + t.path + ')' : '') + (t.reason ? ':' + t.reason : '');
  }).join(' | ');
  return new Error('ffmpeg-unavailable:' + (r.reason || 'no-runnable-ffmpeg') + ' | tried=' + (tried || 'none'));
}

// 把 spawn 包成 Promise（v1.20.1：明确捕获 EFTYPE / ENOENT 等 spawn error）
function runFfmpeg(args, timeoutMs) {
  // v1.20.1：先解析一次可执行路径，校验合法后再 spawn
  const r = ffmpegResolver.resolveFfmpegPath();
  if (!r.ok) {
    return Promise.reject(ffmpegUnavailableError());
  }
  const exe = r.path;
  // v1.20.1：兜底 fs.accessSync X_OK（即便 Windows 上也算软校验）
  try { fs.accessSync(exe, fs.constants.X_OK); } catch (_e) {}
  if (!Array.isArray(args)) {
    return Promise.reject(new Error('ffmpeg-args-not-array'));
  }
  // 过滤空字符串参数（避免 ['-i', '', output] 这种无意义调用）
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] !== 'string') {
      return Promise.reject(new Error('ffmpeg-args-not-string-at-' + i));
    }
  }
  timeoutMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120000;
  return new Promise(function (resolve, reject) {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let proc;
    try {
      proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // Node 在某些平台对非法可执行抛同步 EFTYPE；这里捕到后映射为可读错误
      return reject(new Error('ffmpeg-spawn-sync:' + (e && e.code ? e.code + ':' : '') + ((e && e.message) || String(e))));
    }
    const t = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch (_e) {}
      reject(new Error('ffmpeg-timeout:' + timeoutMs + 'ms'));
    }, timeoutMs);
    proc.stdout.on('data', function (b) { stdout += b.toString(); });
    proc.stderr.on('data', function (b) { stderr += b.toString(); });
    proc.on('error', function (e) {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      // v1.20.1：把 Node 的 spawn error 完整暴露（含 code / errno / syscall）
      const code = (e && e.code) || 'unknown';
      const errno = (e && e.errno);
      const extra = errno ? '/errno=' + errno : '';
      reject(new Error('ffmpeg-spawn-error:code=' + code + extra + ':' + ((e && e.message) || String(e))));
    });
    proc.on('close', function (code) {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (code === 0) return resolve({ stdout: stdout, stderr: stderr });
      reject(new Error('ffmpeg-exit-' + code + ':' + stderr.slice(-600)));
    });
  });
}

// ---------- 核心：转封装 / 转码 ----------
// v1.20.1：opts 支持 outputPath 指定输出位置；也兼容第二参直接传字符串路径
//   （历史调用方 ai-demo.js exportMp4 曾误把字符串当 opts 传入，这里统一收口）
function transcodeWebmToMp4(input, opts) {
  if (typeof opts === 'string') opts = { outputPath: opts };
  opts = opts || {};
  if (!input || !fs.existsSync(input)) return Promise.reject(new Error('input-not-found'));
  if (!ffmpegAvailable()) return Promise.reject(ffmpegUnavailableError());
  // v1.20.2：限制**导出 MP4**的最大帧率为 60 FPS（与"保存为视频样本"统一）。
  //   - maxFps=60 是上限；若源 WebM 帧率 ≤ 60，保留源帧率（不复制帧）。
  //     探测源 fps 走 ffmpeg -i stderr 解析（grep "Stream.*Video.*([0-9.]+ fps)"）。
  //     解析失败时按"源 ≤ 60"假设（最保守）。
  //   - opts.maxFps 可被调用方覆盖（测试 / 转码其他不相关场景）；默认 60。
  //   - fps 滤镜 ffmpeg 内部 drop 帧而非复制帧，故不增加文件体积。
  const MAX_FPS_DEFAULT = 60;
  const maxFps = (typeof opts.maxFps === 'number' && opts.maxFps > 0 && opts.maxFps <= 240) ? opts.maxFps : MAX_FPS_DEFAULT;
  let out;
  if (opts.outputPath && typeof opts.outputPath === 'string') {
    out = opts.outputPath;
    ensureDir(path.dirname(out));
  } else {
    const outDir = outputDir('mp4');
    ensureDir(outDir);
    const baseName = path.basename(input, path.extname(input));
    out = path.join(outDir, baseName + '.mp4');
  }
  const crf = typeof opts.crf === 'number' ? String(opts.crf) : '23';
  const preset = opts.preset || 'veryfast';
  // v1.20.2：固定把**导出 MP4** 的帧率上限锁为 maxFps（默认 60）。
  //   - 永远强制 `-vf fps=N` + `-r N` —— 不论探测源 fps 多少。
  //     原因：用户实测 120 fps webm → 导出 mp4 仍是 120 fps；
  //     探测 -i stderr 的 `Stream ... fps=...` 在某些 webm/vp9 容器里**报为静默 fps=60 / 30 / 59.94**
  //     但**实际**时间戳序列可达 100+ fps（NV12 120Hz 高刷屏录制），条件式判断不可靠。
  //     ffmpeg `fps` filter + output `-r N` 双重保险：drop 帧 + 重写输出 fps 标签。
  //   - 源帧率本身 ≤ N 时，`fps=N` 是**恒等**映射（没有任何 drop），**不**复制帧。
  //   - 音频不动：`-c:a aac -b:a 128k` 保持。
  const fpsArgs = ['-vf', 'fps=' + maxFps, '-r', String(maxFps)];
  const args = [
    '-y',
    '-i', input,
    ...fpsArgs,
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', crf,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    out
  ];
  return enqueue(function () {
    return runFfmpeg(args, opts.timeoutMs).then(function () {
      const stat = fs.statSync(out);
      // v1.20.1：同时返回 path / outputPath，兼容两类调用方
      return { ok: true, path: out, outputPath: out, bytes: stat.size };
    });
  });
}

function generateThumbnail(input, opts) {
  opts = opts || {};
  if (!input || !fs.existsSync(input)) return Promise.reject(new Error('input-not-found'));
  if (!ffmpegAvailable()) return Promise.reject(ffmpegUnavailableError());
  const outDir = outputDir('thumbs');
  ensureDir(outDir);
  const baseName = path.basename(input, path.extname(input));
  const ts = typeof opts.atSeconds === 'number' && opts.atSeconds >= 0 ? String(opts.atSeconds) : '2';
  const width = typeof opts.width === 'number' && opts.width > 0 ? String(opts.width) : '1280';
  const out = path.join(outDir, baseName + '_t' + ts.replace('.', '_') + '.jpg');
  const args = [
    '-y',
    '-ss', ts,
    '-i', input,
    '-frames:v', '1',
    '-vf', 'scale=' + width + ':-2',
    '-q:v', '3',
    out
  ];
  return enqueue(function () {
    return runFfmpeg(args, opts.timeoutMs || 30000).then(function () {
      const stat = fs.statSync(out);
      return { ok: true, path: out, bytes: stat.size };
    });
  });
}

function trim(input, opts) {
  opts = opts || {};
  if (!input || !fs.existsSync(input)) return Promise.reject(new Error('input-not-found'));
  if (!ffmpegAvailable()) return Promise.reject(ffmpegUnavailableError());
  if (typeof opts.startSeconds !== 'number' || typeof opts.durationSeconds !== 'number') {
    return Promise.reject(new Error('trim-needs-start-and-duration'));
  }
  const outDir = outputDir('trim');
  ensureDir(outDir);
  const baseName = path.basename(input, path.extname(input));
  const out = path.join(outDir, baseName + '_trim.mp4');
  const args = [
    '-y',
    '-ss', String(opts.startSeconds),
    '-i', input,
    '-t', String(opts.durationSeconds),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    out
  ];
  return enqueue(function () {
    return runFfmpeg(args, opts.timeoutMs).then(function () {
      return { ok: true, path: out };
    });
  });
}

// 容器级时长兜底探测（仅在 `ffmpeg -i` 报不出 Duration 时才走）。
//   背景：浏览器 MediaRecorder 产出的 WebM 是「流式」容器，尾部不写 Segment Duration、
//         也没有 Cues 索引，纯探测（ffmpeg -i）会把 Duration 报成 `N/A`。
//   方案：`-c copy -f null -` 走一遍 —— `-c copy` 只读包不解码，速度接近磁盘 IO；
//         取 progress 行里**最大**的 `time=`（最后一条即总时长）。
//   返回毫秒数；失败返回 0。
function probeDurationByScan(input, timeoutMs) {
  return new Promise(function (resolve) {
    const exe = ffmpegPath();
    if (!exe || !fs.existsSync(input)) return resolve(0);
    let stderr = '';
    let settled = false;
    let proc;
    let timer = null;
    const finish = function (ms) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ms);
    };
    try {
      proc = spawn(exe, ['-i', input, '-c', 'copy', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (_e) { return resolve(0); }
    timer = setTimeout(function () {
      try { proc.kill('SIGKILL'); } catch (_e) {}
      finish(0);
    }, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30000);
    proc.stderr.on('data', function (b) { stderr += b.toString(); });
    proc.on('error', function () { finish(0); });
    proc.on('close', function () {
      // progress 会反复打印 time=，取最大值即最终时长
      const re = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g;
      let maxMs = 0;
      let m;
      while ((m = re.exec(stderr)) !== null) {
        const ms = Math.round((parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3])) * 1000);
        if (ms > maxMs) maxMs = ms;
      }
      finish(maxMs);
    });
  });
}

function getMetadata(input, opts) {
  return new Promise(function (resolve) {
    const exe = ffmpegPath();
    if (!exe || !fs.existsSync(input)) return resolve(null);
    let stderr = '';
    let proc;
    try {
      proc = spawn(exe, ['-i', input], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (_e) { return resolve(null); }
    proc.stderr.on('data', function (b) { stderr += b.toString(); });
    proc.on('error', function () { resolve(null); });
    proc.on('close', function () {
      const out = {};
      const dm = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/i.exec(stderr);
      if (dm) {
        const h = parseInt(dm[1], 10) || 0;
        const mi = parseInt(dm[2], 10) || 0;
        const se = parseFloat(dm[3]) || 0;
        out.durationMs = Math.round((h * 3600 + mi * 60 + se) * 1000);
      }
      const rm = /Stream.*Video.*?(\d{2,5})x(\d{2,5})/i.exec(stderr);
      if (rm) out.resolution = { width: parseInt(rm[1], 10), height: parseInt(rm[2], 10) };
      const vcm = /Video:\s*([\w]+)/i.exec(stderr);
      if (vcm) out.videoCodec = vcm[1];
      const acm = /Audio:\s*([\w]+)/i.exec(stderr);
      if (acm) out.audioCodec = acm[1];
      // v1.20.2：从 ffmpeg -i stderr 末尾 Stream 标签的 `(TAG:language=...)` 之前
      //   抓 `(\d+(?:\.\d+)?)\s*fps`（ffmpeg 输出 "29.97 fps" 或 "60 fps"）。
      //   多视频流时取第一条。
      const fm = /Stream\b[^\n]*?\b(\d+(?:\.\d+)?)\s*fps\b/i.exec(stderr);
      if (fm) {
        const fpsNum = parseFloat(fm[1]);
        if (isFinite(fpsNum) && fpsNum > 0 && fpsNum <= 1000) out.fps = fpsNum;
      }
      // 容器报不出时长（MediaRecorder 产出的流式 WebM）时兜底扫一遍拿真实时长。
      if (!(out.durationMs > 0)) {
        probeDurationByScan(input, (opts && opts.durationScanTimeoutMs) || 0).then(function (ms) {
          if (ms > 0) out.durationMs = ms;
          resolve(out);
        });
        return;
      }
      resolve(out);
    });
  });
}

// v1.20.2：同步探测 fps（仅在 transcodeWebmToMp4 内部用，不暴露给其他模块）。
//   用 spawnSync + timeout 防止 ffmpeg 卡住整个转码队列。
function getMetadataSync(input) {
  const exe = ffmpegPath();
  if (!exe || !fs.existsSync(input)) return null;
  let stderr = '';
  let proc;
  try {
    proc = spawnSync(exe, ['-i', input], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 4000 });
  } catch (_e) { return null; }
  if (!proc) return null;
  stderr = String((proc.stderr && proc.stderr.toString && proc.stderr.toString()) || (proc[2] || ''));
  const fm = /Stream\b[^\n]*?\b(\d+(?:\.\d+)?)\s*fps\b/i.exec(stderr);
  if (fm) {
    const fpsNum = parseFloat(fm[1]);
    if (isFinite(fpsNum) && fpsNum > 0 && fpsNum <= 1000) return { fps: fpsNum };
  }
  return null;
}

// 一站式：把 WebM 产物转 MP4 + 抽封面 + 读元数据
async function processRecording(input, opts) {
  opts = opts || {};
  const meta = await getMetadata(input);
  const tasks = [];
  let mp4 = null; let thumb = null;
  if (opts.transcode !== false) {
    tasks.push(transcodeWebmToMp4(input, opts.transcodeOpts || {}).then(function (r) { mp4 = r; }).catch(function (e) { mp4 = { error: String(e.message || e) }; }));
  }
  if (opts.thumb !== false) {
    tasks.push(generateThumbnail(input, opts.thumbOpts || {}).then(function (r) { thumb = r; }).catch(function (e) { thumb = { error: String(e.message || e) }; }));
  }
  await Promise.all(tasks);
  return { meta: meta, mp4: mp4, thumb: thumb };
}

function attachIpc(ipcMain) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return;
  ipcMain.handle('video:process', async function (_e, payload) {
    if (!payload || !payload.input) return { ok: false, error: 'no-input' };
    try {
      const r = await processRecording(payload.input, payload.opts || {});
      return Object.assign({ ok: true }, r);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('video:metadata', async function (_e, payload) {
    if (!payload || !payload.input) return null;
    return getMetadata(payload.input);
  });
  ipcMain.handle('video:transcode', async function (_e, payload) {
    if (!payload || !payload.input) return { ok: false, error: 'no-input' };
    try {
      return await transcodeWebmToMp4(payload.input, payload.opts || {});
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('video:thumb', async function (_e, payload) {
    if (!payload || !payload.input) return { ok: false, error: 'no-input' };
    try {
      return await generateThumbnail(payload.input, payload.opts || {});
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('video:available', async function () {
    // v1.20.1：附带可诊断信息（解析失败的 tried 链 / 版本探测）
    const diag = ffmpegDiagnostic();
    const r = { ok: true, available: ffmpegAvailable(), path: ffmpegPath() };
    if (diag.ok) {
      r.source = diag.source;
      try {
        const v = await ffmpegResolver.probeFfmpegVersion();
        if (v && v.ok) r.version = v.version;
        else if (v) r.probeError = v.error || 'unknown';
      } catch (_e) {}
    } else {
      r.error = diag.error;
      r.tried = diag.tried;
    }
    return r;
  });
}

module.exports = {
  ffmpegAvailable,
  ffmpegPath,
  ffmpegDiagnostic,
  // 主入口
  transcodeWebmToMp4,
  generateThumbnail,
  trim,
  getMetadata,
  processRecording,
  // IPC
  attachIpc
};
