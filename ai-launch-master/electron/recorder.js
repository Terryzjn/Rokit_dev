// Rokit · 屏幕录制层（v1.5 MVP）
// 录制流程：
//   1) renderer 调 ipcRecorder.listSources() 拿到屏幕 / 窗口列表（用 desktopCapturer）
//   2) renderer 用 navigator.mediaDevices.getUserMedia + chromeMediaSourceId 拿到 MediaStream
//   3) renderer 用 MediaRecorder 录成 WebM，通过 ipcRecorder.appendChunk(sessionId, buffer) 推上来
//   4) recorder.js 把 buffer 顺序追加到临时文件
//   5) renderer 调 ipcRecorder.stop(sessionId) 关闭文件，返回 { path, durationMs }
//   6) video.js 后续用 ffmpeg-static 转封装 / 转码
//
// 约束：
//   - 主进程不直接读 desktopCapturer 之外的浏览器 API（保持模块边界清晰）
//   - 不引入第三方包：fs + os + path 原生足够
//   - 单实例：每次 start 返回新 sessionId；旧的若未 stop 会在新 start 时强制 finalize

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

// 默认临时目录：userData / recorder / <sessionId>.webm
function tempDir() {
  try {
    return path.join(app.getPath('userData'), 'recorder');
  } catch (_e) {
    // app 未就绪 / 非 electron 环境：降级到系统临时
    return path.join(os.tmpdir(), 'rokit-recorder');
  }
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_e) {}
}

function nowIso() { return new Date().toISOString(); }

// ---------- session 管理 ----------
const sessions = new Map(); // sessionId -> { path, startedAt, bytes, finalized }

function createSession(opts) {
  opts = opts || {};
  const id = 'rec_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  const dir = tempDir();
  ensureDir(dir);
  const file = path.join(dir, id + (opts.ext ? '.' + opts.ext : '.webm'));
  const session = {
    id: id,
    path: file,
    ext: opts.ext || 'webm',
    startedAt: Date.now(),
    bytes: 0,
    finalized: false,
    meta: opts.meta || {},
    fps: typeof opts.fps === 'number' && opts.fps > 0 ? opts.fps : 30,
    sourceId: opts.sourceId || '',
    sourceName: opts.sourceName || ''
  };
  // 立即创建一个空文件（避免某些 ffmpeg 流程对不存在文件报错）
  try { fs.writeFileSync(file, ''); } catch (_e) {}
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  return sessions.get(id) || null;
}

function appendChunk(id, buf) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'session-not-found' };
  if (s.finalized) return { ok: false, error: 'session-finalized' };
  if (!buf) return { ok: false, error: 'empty-chunk' };
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    fs.appendFileSync(s.path, b);
    s.bytes += b.length;
    return { ok: true, bytes: s.bytes };
  } catch (e) {
    return { ok: false, error: 'fs-write:' + (e && e.message ? e.message : String(e)) };
  }
}

function stopSession(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'session-not-found' };
  if (s.finalized) {
    return { ok: true, path: s.path, bytes: s.bytes, durationMs: Date.now() - s.startedAt, alreadyFinalized: true };
  }
  s.finalized = true;
  // 文件可能为空：若 < 1KB，标记可疑但不删除
  const suspicious = s.bytes < 1024;
  return {
    ok: true,
    path: s.path,
    bytes: s.bytes,
    durationMs: Date.now() - s.startedAt,
    suspicious: suspicious,
    finishedAt: nowIso()
  };
}

function discardSession(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  sessions.delete(id);
  try { if (fs.existsSync(s.path)) fs.unlinkSync(s.path); } catch (_e) {}
  return { ok: true };
}

function listSessions() {
  const arr = [];
  for (const s of sessions.values()) {
    arr.push({
      id: s.id, path: s.path, bytes: s.bytes, ext: s.ext,
      startedAt: new Date(s.startedAt).toISOString(),
      finalized: s.finalized,
      sourceName: s.sourceName
    });
  }
  return arr;
}

// ---------- 工具 ----------
function readFinalFile(id) {
  const s = sessions.get(id);
  if (!s || !s.finalized) return null;
  try { return fs.readFileSync(s.path); } catch (_e) { return null; }
}

// 用 ffmpeg-static 探测文件时长（同步 spawn 返回码）
function probeDurationMs(filePath, ffmpegPath) {
  return new Promise(function (resolve) {
    if (!ffmpegPath || !fs.existsSync(filePath)) return resolve(0);
    const { spawn } = require('child_process');
    let stdout = '';
    let stderr = '';
    try {
      const p = spawn(ffmpegPath, ['-i', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.on('data', function (b) { stdout += b.toString(); });
      p.stderr.on('data', function (b) { stderr += b.toString(); });
      p.on('error', function () { resolve(0); });
      p.on('close', function () {
        const txt = stdout + stderr;
        const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/i.exec(txt);
        if (!m) return resolve(0);
        const h = parseInt(m[1], 10) || 0;
        const mi = parseInt(m[2], 10) || 0;
        const se = parseFloat(m[3]) || 0;
        resolve(Math.round((h * 3600 + mi * 60 + se) * 1000));
      });
    } catch (_e) { resolve(0); }
  });
}

// 暴露给 main.js 安装 IPC 桥接
function attachIpc(ipcMain) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return;
  ipcMain.handle('recorder:list-sources', async function () {
    // 注意：desktopCapturer 实际在 renderer 调用更方便，这里只是占位
    // 真要列出 sources，应在 renderer 用 desktopCapturer.getSources()
    return [];
  });
  ipcMain.handle('recorder:start', async function (_e, opts) {
    const s = createSession(opts || {});
    return {
      sessionId: s.id, path: s.path, startedAt: new Date(s.startedAt).toISOString()
    };
  });
  ipcMain.handle('recorder:append-chunk', async function (_e, payload) {
    if (!payload || !payload.sessionId) return { ok: false, error: 'no-session-id' };
    return appendChunk(payload.sessionId, payload.chunk);
  });
  ipcMain.handle('recorder:stop', async function (_e, payload) {
    if (!payload || !payload.sessionId) return { ok: false, error: 'no-session-id' };
    return stopSession(payload.sessionId);
  });
  ipcMain.handle('recorder:discard', async function (_e, payload) {
    if (!payload || !payload.sessionId) return { ok: false };
    return discardSession(payload.sessionId);
  });
  ipcMain.handle('recorder:list-sessions', async function () {
    return listSessions();
  });
  ipcMain.handle('recorder:probe', async function (_e, payload) {
    let ffmpegPath = '';
    try { ffmpegPath = require('ffmpeg-static'); } catch (_e) { ffmpegPath = ''; }
    if (!payload || !payload.path) return { ok: false, error: 'no-path' };
    if (!fs.existsSync(payload.path)) return { ok: false, error: 'file-not-found' };
    const ms = await probeDurationMs(payload.path, ffmpegPath);
    return { ok: true, durationMs: ms };
  });
}

module.exports = {
  // 会话管理
  createSession,
  getSession,
  appendChunk,
  stopSession,
  discardSession,
  listSessions,
  // 文件读取 + 探测
  readFinalFile,
  probeDurationMs,
  // 路径
  tempDir,
  // IPC 桥接
  attachIpc
};
