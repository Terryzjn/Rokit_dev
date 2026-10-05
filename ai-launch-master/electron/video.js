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

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { app } = require('electron');

function ffmpegPath() {
  try { return require('ffmpeg-static'); } catch (_e) { return ''; }
}

function ffmpegAvailable() {
  const p = ffmpegPath();
  return !!(p && fs.existsSync(p));
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

// 把 spawn 包成 Promise
function runFfmpeg(args, timeoutMs) {
  const exe = ffmpegPath();
  if (!exe) return Promise.reject(new Error('ffmpeg-static 未安装或不可用'));
  timeoutMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120000;
  return new Promise(function (resolve, reject) {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error('spawn-failed:' + (e && e.message ? e.message : String(e))));
    }
    const t = setTimeout(function () {
      try { proc.kill('SIGKILL'); } catch (_e) {}
      reject(new Error('ffmpeg-timeout:' + timeoutMs + 'ms'));
    }, timeoutMs);
    proc.stdout.on('data', function (b) { stdout += b.toString(); });
    proc.stderr.on('data', function (b) { stderr += b.toString(); });
    proc.on('error', function (e) {
      clearTimeout(t);
      reject(new Error('ffmpeg-spawn:' + (e && e.message ? e.message : String(e))));
    });
    proc.on('close', function (code) {
      clearTimeout(t);
      if (code === 0) return resolve({ stdout: stdout, stderr: stderr });
      reject(new Error('ffmpeg-exit-' + code + ':' + stderr.slice(-600)));
    });
  });
}

// ---------- 核心：转封装 / 转码 ----------
function transcodeWebmToMp4(input, opts) {
  opts = opts || {};
  if (!input || !fs.existsSync(input)) return Promise.reject(new Error('input-not-found'));
  if (!ffmpegAvailable()) return Promise.reject(new Error('ffmpeg-missing'));
  const outDir = outputDir('mp4');
  ensureDir(outDir);
  const baseName = path.basename(input, path.extname(input));
  const out = path.join(outDir, baseName + '.mp4');
  const crf = typeof opts.crf === 'number' ? String(opts.crf) : '23';
  const preset = opts.preset || 'veryfast';
  const args = [
    '-y',
    '-i', input,
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
      return { ok: true, path: out, bytes: stat.size };
    });
  });
}

function generateThumbnail(input, opts) {
  opts = opts || {};
  if (!input || !fs.existsSync(input)) return Promise.reject(new Error('input-not-found'));
  if (!ffmpegAvailable()) return Promise.reject(new Error('ffmpeg-missing'));
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
  if (!ffmpegAvailable()) return Promise.reject(new Error('ffmpeg-missing'));
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

function getMetadata(input) {
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
      resolve(out);
    });
  });
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
    return { ok: true, available: ffmpegAvailable(), path: ffmpegPath() };
  });
}

module.exports = {
  ffmpegAvailable,
  ffmpegPath,
  // 主入口
  transcodeWebmToMp4,
  generateThumbnail,
  trim,
  getMetadata,
  processRecording,
  // IPC
  attachIpc
};
