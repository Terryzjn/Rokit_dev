// Rokit · 录屏基础设施（共享主进程桥接）
//
// 范围：为「手动录屏」提供主进程桥接：
//   - 把 recorder.js 产出的临时 WebM 移入 userData/videos/<id>.webm
//   - 通过 ffmpeg-static 把 WebM 转为真正可播放的 MP4（不修改扩展名）
//   - 列出可用于录制的"窗口"源 + 返回 Rokit 主窗口的真实屏幕坐标
//     （capture:list-sources / capture:probe / capture:get-rokit-bounds）
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

// v1.22（录屏生命周期）：手动录屏的**临时**保存目录。
//   停止录屏后自动写入这里（临时保存）；只有用户主动点「保留录屏」才移动到 videos/。
//   非 Electron 环境（单元测试）也保持独立目录，不与 videos/ 混用。
function recorderTempDir(app) {
  try { return path.join(app.getPath('userData'), 'temp', 'videos', 'recorder'); }
  catch (_e) { return path.join(__dirname, '_fallback_videos', 'temp', 'recorder'); }
}

// -------- 保存录制产物：支持两种入参
//   1) { tempPath, ext, id? }：把已有的临时文件 rename 到临时录屏目录
//   2) { blobBase64, ext, id? }：直接把 base64 写到临时录屏目录（适配 renderer FileReader）
// v1.19：把 capture region / 来源信息一并写入 .meta.json 同名 sidecar，方便后续审计
// v1.22（录屏生命周期）：默认落盘到**临时**目录 <userData>/temp/videos/recorder/
//   —— 停止录屏即自动保存（无额外确认），但只是"临时保存"；
//   只有用户主动点「保留录屏」才移动到 <userData>/videos/（见 retainRecording）。
// sourceType：资产来源标记，默认 'MANUAL_RECORDING'（手动录屏）。
//   白名单校验：只接受已知枚举值，非法值一律回退默认（不写入任意字符串）。
const SOURCE_TYPES = Object.freeze({
  MANUAL_RECORDING: 'MANUAL_RECORDING'
});
function normalizeSourceType(v) {
  const s = String(v || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(SOURCE_TYPES, s) ? SOURCE_TYPES[s] : SOURCE_TYPES.MANUAL_RECORDING;
}
function writeCaptureMeta(target, opts) {
  try {
    const meta = {
      filePath: target,
      capturedAt: new Date().toISOString(),
      captureType: opts.captureType || 'unknown',
      captureSource: opts.captureSource || '',
      captureRegion: opts.captureRegion || null,
      captureSize: opts.captureSize || null,
      recorder: opts.recorder || 'ai-demo v1.19',
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
  // v1.22：默认落到临时录屏目录（临时保存，非永久保留）
  const dir = recorderTempDir(_app);
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
    sourceType: normalizeSourceType(opts.sourceType),
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

// -------- 保留录屏：把临时录屏移动到 <userData>/videos/（用户主动操作）
//
// 安全约束：
//   1. 只接受 assetId —— 真实路径**一律**从主进程 videoSource._internalStore 取，
//      绝不信任 Renderer 传入的绝对路径（否则渲染层可借此移动任意本地文件）。
//   2. **移动**原文件，不创建第二份副本。
//   3. 主文件与 sidecar（<file>.meta.json）一起移动；sidecar 内的 filePath 同步更新。
//   4. 目标重名 → 自动编号（-1 / -2 …），绝不覆盖已有文件。
//   5. 任何一步失败都回滚，绝不留下「主文件与 sidecar 分处两个目录」的半完成状态。
//   6. 成功后用**原 assetId** 重新登记（stashInternalAsset 是 Map.set，同 id 覆盖）。
function _moveFileSync(src, dest) {
  try {
    fs.renameSync(src, dest);
    return true;
  } catch (_e) {
    // 跨卷时 rename 失败 → 复制 + 删源
    try {
      fs.copyFileSync(src, dest);
      try { fs.unlinkSync(src); } catch (_e2) {}
      return true;
    } catch (_e3) {
      return false;
    }
  }
}

async function retainRecording(opts) {
  opts = opts || {};
  const assetId = String(opts.assetId || '').trim();
  if (!assetId) return { ok: false, error: 'no-asset-id' };

  // 从主进程内部存储取真实资产（不信任 Renderer 传入的路径）
  let vs = null;
  try { vs = require('./video-source'); } catch (_e) { vs = null; }
  if (!vs || typeof vs.getInternalAsset !== 'function') {
    return { ok: false, error: 'video-source-unavailable' };
  }
  const asset = vs.getInternalAsset(assetId);
  if (!asset || !asset.filePath) {
    return { ok: false, error: 'asset-not-found' };
  }
  const srcPath = String(asset.filePath);
  const srcMeta = String(asset.metaPath || (srcPath + '.meta.json'));
  if (!fs.existsSync(srcPath)) {
    return { ok: false, error: 'file-missing' };
  }
  // 源必须位于临时录屏目录（只允许把"临时录屏"提升为"保留"）
  const tempRoot = recorderTempDir(_app);
  const rel = path.relative(tempRoot, srcPath);
  if (!rel || rel.indexOf('..') === 0 || path.isAbsolute(rel)) {
    // 已经在 videos/ 或其它位置 → 视为已保留，幂等返回当前资产
    if (path.dirname(srcPath) === path.resolve(videosDir(_app))) {
      return { ok: true, asset: asset, alreadyRetained: true };
    }
    return { ok: false, error: 'not-a-temp-recording' };
  }

  // 目标：<userData>/videos/；重名自动编号，绝不覆盖
  const keepDir = videosDir(_app);
  safeDir(keepDir);
  const baseName = path.basename(srcPath);
  const stem = baseName.replace(/\.[^.]*$/, '');
  const ext = path.extname(baseName);
  let dest = path.join(keepDir, baseName);
  if (fs.existsSync(dest)) {
    let n = 1;
    for (;;) {
      const candidate = path.join(keepDir, stem + '-' + n + ext);
      if (!fs.existsSync(candidate)) { dest = candidate; break; }
      n++;
      if (n > 9999) return { ok: false, error: 'too-many-same-name' };
    }
  }
  const destMeta = dest + '.meta.json';

  // ---- 移动主文件 ----
  if (!_moveFileSync(srcPath, dest)) {
    return { ok: false, error: 'move-failed' };
  }
  // ---- 移动 sidecar（没有 sidecar 也算正常：不是失败）----
  let metaMoved = false;
  if (fs.existsSync(srcMeta)) {
    if (!_moveFileSync(srcMeta, destMeta)) {
      // sidecar 移动失败 → 回滚主文件（放回临时目录），不留半完成状态
      try { _moveFileSync(dest, srcPath); } catch (_e) {}
      return { ok: false, error: 'sidecar-move-failed' };
    }
    metaMoved = true;
  }
  // ---- 更新 sidecar 内的 filePath ----
  if (metaMoved) {
    try {
      const meta = JSON.parse(fs.readFileSync(destMeta, 'utf8'));
      meta.filePath = dest;
      fs.writeFileSync(destMeta, JSON.stringify(meta, null, 2));
    } catch (e) {
      // sidecar 内容更新失败 → 回滚两个文件（主文件 + sidecar 一起放回临时目录）
      //   注意顺序：先回滚 sidecar（它还在 destMeta），再回滚主文件。
      //   早期实现先 unlink(destMeta) 再判断 srcMeta 是否存在 —— 此时 srcMeta 已被移走，
      //   判断恒为 false → sidecar 丢失（半完成状态）。
      try { _moveFileSync(destMeta, srcMeta); } catch (_e) {}
      try { _moveFileSync(dest, srcPath); } catch (_e) {}
      return { ok: false, error: 'sidecar-update-failed' };
    }
  }

  // ---- 用原 assetId 重新登记（Map.set 覆盖，id 不变）----
  const updated = Object.assign({}, asset, {
    fileName: path.basename(dest),
    filePath: dest,
    metaPath: metaMoved ? destMeta : (dest + '.meta.json')
  });
  try {
    if (typeof vs.stashInternalAsset === 'function') vs.stashInternalAsset(updated);
  } catch (_e) {
    // 登记失败：文件已移动但登记没更新 → 回滚文件，避免 _internalStore 指向旧路径
    try { _moveFileSync(dest, srcPath); } catch (_e) {}
    if (metaMoved) { try { _moveFileSync(destMeta, srcMeta); } catch (_e) {} }
    return { ok: false, error: 'restake-failed' };
  }
  return { ok: true, asset: updated, retained: true };
}

// -------- WebM -> MP4（只做容器/编码转换，不上传、不修改内容）
//
// v1.22.1（导出路径统一）：未显式指定 outputPath 时，转码产物落到
//   <userData>/temp/videos/work/ —— 与 video.js 的 outputDir('work') 完全同口径。
//   · work/ 是「可再生成的中间产物」目录（转码 MP4 · 缩略图 · 裁剪）。
//   · 显式传入 opts.outputPath 时**仍按调用方给定的路径输出**（行为不变）。
//   · 非 Electron 环境（单元测试）回退到 os.tmpdir()/rokit-temp/videos/work/
//     （与 video.js outputDir() 的 fallback 完全一致）。
function _transcodeMp4Dir(app) {
  try {
    return path.join(app.getPath('userData'), 'temp', 'videos', 'work');
  } catch (_e) {
    return path.join(require('os').tmpdir(), 'rokit-temp', 'videos', 'work');
  }
}

async function exportMp4(opts) {
  opts = opts || {};
  if (!_video) return { ok: false, error: 'video-module-missing' };
  const src = opts.inputPath || opts.filePath;
  if (!src || !fs.existsSync(src)) return { ok: false, error: 'input-not-found' };
  // 用户显式传入 path 时保留；未指定时落到临时转码目录 temp/videos/work/
  let out = opts.outputPath;
  if (!out) {
    const dir = _transcodeMp4Dir(_app);
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

// -------- IPC 安装
function attachIpc(ipcMain, ctx) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return;
  if (_ipcMain) return; // 幂等
  _ipcMain = ipcMain;
  _app = (ctx && ctx.app) || require('electron').app;
  try { _video = require('./video'); } catch (_e) { _video = null; }

  // 注：recorder.js 的 IPC（recorder:*）已由 main.js 单独注册，
  //   这里**不再**重复调用 recorder.attachIpc（重复注册会被 ipcMain 拒绝）。

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

  // 保留录屏：把临时录屏移动到 <userData>/videos/（用户主动操作）。
  //   Renderer 只传 assetId；真实路径由主进程从 _internalStore 取。
  ipcMain.handle('demo:retain-recording', async function (_e, payload) {
    return await retainRecording(payload || {});
  });

  ipcMain.handle('demo:export-mp4', async function (_e, payload) {
    return await exportMp4(payload || {});
  });

  // 不允许删除 / 列举：只输出；删除由"删除样本"统一在 voice.js 内做
}

module.exports = {
  attachIpc: attachIpc,
  // 单测 / 调试用
  saveRecording: saveRecording,
  retainRecording: retainRecording,
  exportMp4: exportMp4,
  videosDir: videosDir,
  // v1.22：手动录屏的临时保存目录（停止即存；主动保留才移动到 videos/）
  recorderTempDir: recorderTempDir,
  // 资产来源枚举（手动录屏用 MANUAL_RECORDING）
  SOURCE_TYPES: SOURCE_TYPES,
  normalizeSourceType: normalizeSourceType
};
