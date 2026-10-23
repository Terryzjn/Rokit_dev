// Rokit · 「AI 自动演示」基础设施（v1.15）
//
// 范围：只在第一版交付"AI 自动演示项目"工作区需要的主进程桥接：
//   - 屏幕 / 窗口源列表（用 desktopCapturer）
//   - 把 recorder.js 产出的临时 WebM 移入 userData/videos/<id>.webm
//   - 通过 ffmpeg-static 把 WebM 转为真正可播放的 MP4（不修改扩展名）
//   - 用 ffmpeg-static 探测视频时长
//
// 设计原则：
//   - 不发布、不上传：纯本地文件 IO
//   - 文件名使用安全 ID（同 voice.js 的策略）
//   - 失败原因透传 UI；不抛裸 stack
//   - 不打日志输出任何视频二进制

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _app = null;
let _ipcMain = null;
let _recorder = null;
let _video = null;

function newSafeId() {
  return crypto.randomBytes(12).toString('hex');
}

function safeDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_e) {}
}

function videosDir(app) {
  try { return path.join(app.getPath('userData'), 'videos'); }
  catch (_e) { return path.join(__dirname, '_fallback_videos'); }
}

// -------- 屏幕 / 窗口源列表（renderer 端通常自己拿，但 main 提供端备份）
async function listSources() {
  // 兼容：在 main 进程里，desktopCapturer.getSources 必须等到 app.whenReady 后才能用
  // v1.20：仅枚举 window 类型（不再暴露整个屏幕/桌面，避免被误捕获桌面）
  try {
    const electron = require('electron');
    if (!electron || !electron.desktopCapturer) return { ok: false, error: 'desktopCapturer-not-available', sources: [] };
    const raw = await electron.desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    // 返回精简版（不把缩略图搬到 IPC 通道）：仅 sourceId + name + type
    const sources = (raw || []).map(function (s) {
      return { id: s.id, name: s.name || '(未命名)', type: 'window' };
    });
    return { ok: true, sources: sources };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), sources: [] };
  }
}

// -------- 保存录制产物：支持两种入参
//   1) { tempPath, ext, id? }：把 recorder 产出的临时文件 rename 到 userData/videos
//   2) { blobBase64, ext, id? }：直接把 base64 写到 userData/videos（适配 renderer FileReader）
// v1.19：把 capture region / 来源信息一并写入 .meta.json 同名 sidecar，方便后续审计
function writeCaptureMeta(target, opts) {
  try {
    const meta = {
      filePath: target,
      capturedAt: new Date().toISOString(),
      captureType: opts.captureType || 'unknown',
      captureSource: opts.captureSource || '',
      captureRegion: opts.captureRegion || null,
      captureSize: opts.captureSize || null,
      recorder: 'ai-demo v1.19',
      notes: 'Capture from Rokit AI demo. Privacy-bound — only the listed source/region is recorded.'
    };
    fs.writeFileSync(target + '.meta.json', JSON.stringify(meta, null, 2));
  } catch (_e) { /* sidecar 写入失败不影响主文件保存 */ }
}

async function saveRecording(opts) {
  opts = opts || {};
  const ext = (opts.ext || 'webm').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'webm';
  if (!/^(webm|mp4|mov|mkv)$/.test(ext)) return { ok: false, error: 'unsupported-ext' };
  const id = opts.id && /^[a-f0-9]{8,32}$/i.test(String(opts.id)) ? String(opts.id) : newSafeId();
  const dir = videosDir(_app);
  safeDir(dir);
  const target = path.join(dir, id + '.' + ext);
  if (opts.blobBase64 && typeof opts.blobBase64 === 'string') {
    let buf;
    try {
      const cleaned = opts.blobBase64.replace(/^data:[^;]+;base64,/i, '');
      buf = Buffer.from(cleaned, 'base64');
    } catch (e) {
      return { ok: false, error: 'base64-decode:' + ((e && e.message) || String(e)) };
    }
    if (!buf || !buf.length) return { ok: false, error: 'empty-buffer' };
    try { fs.writeFileSync(target, buf); }
    catch (e) { return { ok: false, error: 'write-failed:' + ((e && e.message) || String(e)) }; }
  } else if (opts.tempPath && fs.existsSync(opts.tempPath)) {
    try {
      fs.renameSync(opts.tempPath, target);
    } catch (_e) {
      try {
        fs.copyFileSync(opts.tempPath, target);
        try { fs.unlinkSync(opts.tempPath); } catch (__e) {}
      } catch (e2) {
        return { ok: false, error: 'save-failed:' + ((e2 && e2.message) || String(e2)) };
      }
    }
  } else {
    return { ok: false, error: 'no-content' };
  }
  let bytes = 0;
  try { bytes = fs.statSync(target).size; } catch (_e) {}
  // v1.19：写入 capture 元信息 sidecar（无 capture 参数时也写一个空模板，便于审计 grep）
  try { writeCaptureMeta(target, opts); } catch (_e) {}
  const asset = {
    id: id,
    sourceType: 'AI_RECORDING',
    fileName: id + '.' + ext,
    filePath: target,
    metaPath: target + '.meta.json',
    mimeType: ext === 'mp4' ? 'video/mp4' : (ext === 'mov' ? 'video/quicktime' : (ext === 'mkv' ? 'video/x-matroska' : 'video/webm')),
    fileSize: bytes,
    captureType: opts.captureType || '',
    captureSource: opts.captureSource || '',
    captureRegion: opts.captureRegion || null,
    createdAt: new Date().toISOString()
  };
  // 与 video:pick-local 的 stash 语义一致：让发布链路（YouTube / 小红书等）
  // 能用 videoAssetId 通过 videoSource.getInternalAsset(id) 反查到 filePath。
  // 失败不影响保存结果本身。
  try {
    const vs = require('./video-source');
    if (vs && typeof vs.stashInternalAsset === 'function') vs.stashInternalAsset(asset);
  } catch (_e) {}
  return { ok: true, asset: asset };
}

// -------- WebM -> MP4（只做容器/编码转换，不上传、不修改内容）
async function exportMp4(opts) {
  opts = opts || {};
  if (!_video) return { ok: false, error: 'video-module-missing' };
  const src = opts.inputPath || opts.filePath;
  if (!src || !fs.existsSync(src)) return { ok: false, error: 'input-not-found' };
  // 用户显式传入 path 时保留；未指定时落到 videosDir
  let out = opts.outputPath;
  if (!out) {
    const dir = videosDir(_app);
    safeDir(dir);
    const baseName = path.basename(src, path.extname(src));
    out = path.join(dir, baseName + '.mp4');
  }
  try {
    // v1.20.1：显式传 opts（历史 bug：直接传 out 字符串被当作 opts 对象，outputPath 丢失）
    const r = await _video.transcodeWebmToMp4(src, { outputPath: out });
    return { ok: true, outputPath: r && (r.outputPath || r.path) ? (r.outputPath || r.path) : out };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// -------- 探测 mp4 文件时长
async function probeDurationMs(opts) {
  opts = opts || {};
  if (!_recorder) return { ok: false, error: 'recorder-missing' };
  try {
    // v1.20.1：走统一 resolver（不再直接信任 require('ffmpeg-static') 的裸路径）
    let ffmpegPath = '';
    try { ffmpegPath = require('./ffmpeg-resolver').ffmpegPath(); } catch (_e) { ffmpegPath = ''; }
    const ms = await _recorder.probeDurationMs(opts.path, ffmpegPath);
    return { ok: true, durationMs: ms || 0 };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// -------- IPC 安装
function attachIpc(ipcMain, ctx) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return;
  if (_ipcMain) return; // 幂等
  _ipcMain = ipcMain;
  _app = (ctx && ctx.app) || require('electron').app;
  try { _recorder = require('./recorder'); } catch (_e) { _recorder = null; }
  try { _video = require('./video'); } catch (_e) { _video = null; }

  // 让 renderer 用的录制 IPC（之前 preload 暴露了但 main 未挂载，这里补上）
  if (_recorder && typeof _recorder.attachIpc === 'function') {
    try { _recorder.attachIpc(ipcMain); } catch (_e) {}
  }

  ipcMain.handle('demo:list-sources', async function () { return await listSources(); });

  // v1.19：列出可用于录制的"窗口 / 屏幕"源（renderer 选择 Rokit 主窗口时使用）
  // v1.20：默认仅枚举"窗口"类型源，不主动暴露整个屏幕/桌面，避免误捕获桌面
  //        同时返回 Rokit 主窗口的真实屏幕坐标（getBounds），用于 preview 与录制元数据。
  // v1.20：使用 win.getMediaSourceId()（Electron 官方推荐 API）匹配 desktopCapturer 的 source.id
  ipcMain.handle('capture:list-sources', async function () {
    try {
      const electron = require('electron');
      if (!electron || !electron.desktopCapturer) return { ok: false, error: 'desktopCapturer-not-available', sources: [] };
      const wins = (electron.BrowserWindow && electron.BrowserWindow.getAllWindows()) || [];
      // 取 Rokit 主窗口（标题包含 Rokit / productName）—— 不取 pubWin
      let mainWin = null;
      for (let i = 0; i < wins.length; i++) {
        const w = wins[i];
        if (!w || w.isDestroyed()) continue;
        const title = (typeof w.getTitle === 'function' ? w.getTitle() : '') || '';
        if (/rokit/i.test(title)) { mainWin = w; break; }
      }
      if (!mainWin) mainWin = wins[0] || null;
      // 用 getMediaSourceId()（Electron 官方接口，返回与 desktopCapturer 一致的格式）
      //   这才是匹配 source.id 的正确方式（旧代码用 BrowserWindow.id 是错的）
      let mainSourceId = '';
      if (mainWin && typeof mainWin.getMediaSourceId === 'function') {
        try { mainSourceId = mainWin.getMediaSourceId() || ''; } catch (_e) {}
      }
      const raw = await electron.desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 240, height: 160 } });
      const sources = (raw || []).map(function (s) {
        // 优先用 getMediaSourceId 匹配；保留对老 BrowserWindow.id 的兜底匹配
        const isOwnWindow = mainWin && (s.id === mainSourceId || s.id === ('window:' + mainWin.id));
        const thumbData = s.thumbnail && s.thumbnail.toDataURL ? s.thumbnail.toDataURL() : '';
        let region = null;
        if (isOwnWindow && mainWin && typeof mainWin.getBounds === 'function') {
          try {
            const b = mainWin.getBounds();
            let cb = null;
            try { if (typeof mainWin.getContentBounds === 'function') cb = mainWin.getContentBounds(); } catch (_e) {}
            region = {
              x: cb ? cb.x : b.x,
              y: cb ? cb.y : b.y,
              width: cb ? cb.width : b.width,
              height: cb ? cb.height : b.height,
              isMaximized: typeof mainWin.isMaximized === 'function' ? !!mainWin.isMaximized() : false,
              isMinimized: typeof mainWin.isMinimized === 'function' ? !!mainWin.isMinimized() : false
            };
          } catch (_e) {}
        }
        return {
          id: s.id,
          name: s.name || '(未命名)',
          type: 'window',
          isRokitWindow: !!isOwnWindow,
          thumbnail: thumbData,
          width: (s.thumbnail && s.thumbnail.getSize && s.thumbnail.getSize().width) || 0,
          height: (s.thumbnail && s.thumbnail.getSize && s.thumbnail.getSize().height) || 0,
          region: region
        };
      });
      return { ok: true, sources: sources };
    } catch (e) {
      return { ok: false, error: 'capture-list-failed:' + ((e && e.message) || String(e)), sources: [] };
    }
  });

  // v1.20：新增 IPC —— 直接返回 Rokit 主窗口的实时屏幕边界（不依赖 desktopCapturer）
  //   用于：preview 实时坐标、MediaRecorder 校验窗口是否仍在屏、录制边界日志
  ipcMain.handle('capture:get-rokit-bounds', async function () {
    try {
      const electron = require('electron');
      if (!electron || !electron.BrowserWindow) return { ok: false, error: 'no-BrowserWindow' };
      const wins = electron.BrowserWindow.getAllWindows() || [];
      let mainWin = null;
      for (let i = 0; i < wins.length; i++) {
        const w = wins[i];
        if (!w || w.isDestroyed()) continue;
        const title = (typeof w.getTitle === 'function' ? w.getTitle() : '') || '';
        if (/rokit/i.test(title)) { mainWin = w; break; }
      }
      if (!mainWin) return { ok: false, error: 'no-rokit-window' };
      const b = (typeof mainWin.getBounds === 'function') ? mainWin.getBounds() : null;
      const cb = (typeof mainWin.getContentBounds === 'function') ? mainWin.getContentBounds() : null;
      if (!b) return { ok: false, error: 'no-bounds' };
      const screen = (typeof electron.screen === 'object') ? electron.screen : null;
      const disp = screen && typeof screen.getDisplayMatching === 'function'
        ? screen.getDisplayMatching(cb || b)
        : null;
      const dsf = disp && typeof disp.scaleFactor === 'number' ? disp.scaleFactor : 1.0;
      let mediaSourceId = '';
      try { mediaSourceId = mainWin.getMediaSourceId ? (mainWin.getMediaSourceId() || '') : ''; } catch (_e) {}
      return {
        ok: true,
        bounds: b,
        contentBounds: cb || b,
        isMaximized: typeof mainWin.isMaximized === 'function' ? !!mainWin.isMaximized() : false,
        isMinimized: typeof mainWin.isMinimized === 'function' ? !!mainWin.isMinimized() : false,
        isVisible: typeof mainWin.isVisible === 'function' ? !!mainWin.isVisible() : true,
        displayScaleFactor: dsf,
        cssToPhysicalScale: dsf,
        mediaSourceId: mediaSourceId
      };
    } catch (e) {
      return { ok: false, error: 'rokit-bounds-failed:' + ((e && e.message) || String(e)) };
    }
  });

  // v1.19：renderer 拿到 source id 后，主进程不再返回 stream
  //   Electron 渲染层可以直接通过 navigator.mediaDevices.getUserMedia + chromeMediaSourceId 拿到流
  //   这里只返回 sanitize 后的大小，便于 preview / 元数据
  ipcMain.handle('capture:probe', async function (_e, payload) {
    payload = payload || {};
    if (!payload.sourceId) return { ok: false, error: 'no-source-id' };
    try {
      const electron = require('electron');
      if (!electron || !electron.desktopCapturer) return { ok: false, error: 'no-desktopCapturer' };
      const raw = await electron.desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 200 } });
      const match = (raw || []).find(function (s) { return s.id === payload.sourceId; });
      if (!match) return { ok: false, error: 'source-not-found' };
      const ts = match.thumbnail && match.thumbnail.getSize ? match.thumbnail.getSize() : { width: 0, height: 0 };
      let region = null;
      try {
        const wins = (electron.BrowserWindow && electron.BrowserWindow.getAllWindows()) || [];
        let mainWin = null;
        for (let i = 0; i < wins.length; i++) {
          const w = wins[i];
          if (!w || w.isDestroyed()) continue;
          const title = (typeof w.getTitle === 'function' ? w.getTitle() : '') || '';
          if (/rokit/i.test(title)) { mainWin = w; break; }
        }
        if (mainWin && typeof mainWin.getBounds === 'function') {
          // v1.20：用 getMediaSourceId 匹配 source.id
          let matchMedia = '';
          try { matchMedia = mainWin.getMediaSourceId ? (mainWin.getMediaSourceId() || '') : ''; } catch (_e) {}
          if (matchMedia && matchMedia === match.id) {
            const b = mainWin.getBounds();
            let cb = b;
            try { if (typeof mainWin.getContentBounds === 'function') cb = mainWin.getContentBounds(); } catch (_e) {}
            region = {
              x: cb.x, y: cb.y, width: cb.width, height: cb.height,
              isMaximized: !!mainWin.isMaximized && mainWin.isMaximized(),
              isMinimized: !!mainWin.isMinimized && mainWin.isMinimized()
            };
          }
        }
      } catch (_e) {}
      return {
        ok: true,
        sourceId: match.id,
        sourceName: match.name || '(未命名)',
        type: 'window',
        width: ts.width || 0,
        height: ts.height || 0,
        region: region || { x: 0, y: 0, width: ts.width || 0, height: ts.height || 0 }
      };
    } catch (e) {
      return { ok: false, error: 'probe-failed:' + ((e && e.message) || String(e)) };
    }
  });

  ipcMain.handle('demo:save-recording', async function (_e, payload) {
    return await saveRecording(payload || {});
  });

  ipcMain.handle('demo:export-mp4', async function (_e, payload) {
    return await exportMp4(payload || {});
  });

  ipcMain.handle('demo:probe-duration', async function (_e, payload) {
    return await probeDurationMs(payload || {});
  });

  // 不允许删除 / 列举：v1.15 只输出；删除由"删除样本"统一在 voice.js 内做
}

module.exports = {
  attachIpc: attachIpc,
  // 单测 / 调试用
  listSources: listSources,
  saveRecording: saveRecording,
  exportMp4: exportMp4,
  probeDurationMs: probeDurationMs,
  videosDir: videosDir
};
