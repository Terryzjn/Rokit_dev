'use strict';
// Rokit · 视频来源抽象（VideoSource / VideoAsset）
//
// 目的：
//   当前阶段：仅支持 LOCAL_FILE（用户主动选择本地视频）。
//   未来阶段：保留扩展空间，恢复 AI_GENERATED / SCREEN_RECORDING / REMOTE_VIDEO 时，
//   YouTube 上传模块只需要接收统一的 VideoAsset，不需要关心视频来源。
//
// 设计要点：
//   1. VideoSource 是枚举字符串（不是 class），便于 JSON 持久化和跨 IPC 传输
//   2. VideoAsset 是上传模块的输入；由各个 Source Factory 构造
//   3. 所有 IPC handler 都在 main process；Renderer 只能通过 IPC 拿到「非敏感元数据」
//      （不含视频二进制、不含路径以外的安全相关字段）
//   4. 不复制视频文件到 Renderer 目录；只把路径交给 main（YouTube 上传模块在 main 读取）
//
// YouTube 上传（未来阶段）将只依赖 VideoAsset 的 filePath / mimeType / fileSize / duration：
//   const uploader = new YouTubeUploader();
//   await uploader.uploadResumable(videoAsset);   // ← 不关心来源类型
//
// 已有但**保留不动**的模块（spec 第七节要求）：
//   - electron/recorder.js        录屏模块
//   - electron/video.js           ffmpeg 视频处理
//   - electron/publisher-extensions.js / publishers.js   发布器
//   AI 视频生成的所有代码都保留；只是不在主流程中调用。

const fs = require('fs');
const path = require('path');
const { dialog, app } = require('electron');
const crypto = require('crypto');

const logger = require('./logger');

// ---------- VideoSource 枚举 ----------
// 当前已实现的来源类型；保留 AI_GENERATED / SCREEN_RECORDING 给未来恢复
const VideoSource = Object.freeze({
  LOCAL_FILE: 'LOCAL_FILE',           // 用户选择本地视频（当前阶段）
  AI_GENERATED: 'AI_GENERATED',       // 预留：AI 视频生成器
  SCREEN_RECORDING: 'SCREEN_RECORDING', // 预留：录屏模块
  REMOTE_VIDEO: 'REMOTE_VIDEO'        // 预留：远端 URL
});

// 支持的视频 MIME（MIME）
const SUPPORTED_VIDEO_MIME = new Set([
  'video/mp4',
  'video/quicktime',   // .mov
  'video/webm',
  'video/x-matroska',  // .mkv
  'video/x-msvideo'    // .avi
]);

// 文件后缀 → MIME
const EXT_TO_MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo'
};

const SUPPORTED_EXTENSIONS = Object.keys(EXT_TO_MIME);

// 简易 MIME 探测（后缀 → MIME），不读取文件内容（保留性能）
function inferMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] || 'application/octet-stream';
}

/**
 * 构造一个标准化的 VideoAsset。
 * 设计原则：字段尽量少且稳定，未来 YouTube uploader 只依赖 filePath / mimeType / fileSize / duration。
 *
 * @typedef {Object} VideoAsset
 * @property {string} id             内部 UUID（不上传到 YouTube；用于 state 关联）
 * @property {string} sourceType     VideoSource 枚举值
 * @property {string} filePath       绝对路径（仅 main process 使用）
 * @property {string} fileName       basename
 * @property {number} fileSize       文件字节数
 * @property {string} mimeType       视频 MIME（推断）
 * @property {number} [duration]     时长（秒）；可选，由 metadata IPC 异步填入
 * @property {number} [width]        分辨率宽；可选
 * @property {number} [height]       分辨率高；可选
 * @property {number} createdAt      ms 时间戳
 */

function newAssetId() {
  return 'va-' + crypto.randomBytes(8).toString('hex');
}

function buildAsset(filePath, sourceType) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error('路径不是文件：' + filePath);
  }
  if (stat.size <= 0) {
    throw new Error('文件为空：' + filePath);
  }
  // 文件可读性
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch (e) {
    throw new Error('文件不可读：' + filePath + ' (' + (e && e.message || e) + ')');
  }
  const mimeType = inferMime(filePath);
  if (!SUPPORTED_VIDEO_MIME.has(mimeType)) {
    throw new Error('不支持的视频格式：' + mimeType + '（支持：' + SUPPORTED_EXTENSIONS.join(', ') + '）');
  }
  return {
    id: newAssetId(),
    sourceType: sourceType,
    filePath: filePath,
    fileName: path.basename(filePath),
    fileSize: stat.size,
    mimeType: mimeType,
    createdAt: Date.now()
  };
}

/**
 * 把 VideoAsset 中**可以暴露给 Renderer 的非敏感字段**返回。
 * 注意：不返回 filePath（spec 第十七节：Renderer 不应拥有任意文件系统访问权限）。
 * YouTube 上传时由 main process 读 filePath。
 */
function toRendererAsset(a) {
  if (!a) return null;
  return {
    id: a.id,
    sourceType: a.sourceType,
    fileName: a.fileName,
    fileSize: a.fileSize,
    mimeType: a.mimeType,
    duration: a.duration,
    width: a.width,
    height: a.height,
    createdAt: a.createdAt
  };
}

// ---------- IPC handler：pick-local ----------
// 调用 dialog.showOpenDialog 让用户选择本地视频；构造 VideoAsset；
// （异步）通过 ffprobe 或 metadata 模块给视频补上 duration / width / height。
async function handlePickLocal(event) {
  const win = event && event.sender && event.sender.getOwnerBrowserWindow && event.sender.getOwnerBrowserWindow();
  const opts = {
    title: '选择本地视频',
    properties: ['openFile'],
    filters: [
      { name: '视频文件', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  };
  let r;
  try {
    r = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
  } catch (e) {
    logger.warn('[video-source] dialog.showOpenDialog failed', { error: String(e && e.message || e) });
    return { ok: false, error: 'DIALOG_FAILED: ' + (e && e.message || String(e)) };
  }
  if (r.canceled || !r.filePaths || !r.filePaths.length) {
    return { ok: false, canceled: true };
  }
  const filePath = r.filePaths[0];
  let asset;
  try {
    asset = buildAsset(filePath, VideoSource.LOCAL_FILE);
  } catch (e) {
    logger.warn('[video-source] buildAsset failed', { filePath, error: String(e && e.message || e) });
    return { ok: false, error: e && e.message || String(e) };
  }
  // 尝试异步补 metadata（ffprobe）。失败也不阻断；UI 显示「—」。
  try {
    const meta = await probeMetadata(asset.filePath);
    if (meta && typeof meta.duration === 'number') asset.duration = meta.duration;
    if (meta && typeof meta.width === 'number') asset.width = meta.width;
    if (meta && typeof meta.height === 'number') asset.height = meta.height;
  } catch (_e) { /* 不阻断主流程；后续可由 renderer 重新探测 */ }

  logger.info('[video-source] picked local video', {
    assetId: asset.id,
    fileName: asset.fileName,
    sizeMB: Math.round(asset.fileSize / 1024 / 1024 * 10) / 10,
    duration: asset.duration || null,
    width: asset.width || null,
    height: asset.height || null
  });
  return { ok: true, asset: toRendererAsset(asset), _internalFilePath: asset.filePath };
}

/**
 * 异步探测视频 metadata（duration / width / height）。
 * 复用现有 video.js 的 getMetadata（ffmpeg / ffprobe）；失败时返回 null（不阻断）。
 */
async function probeMetadata(filePath) {
  try {
    const videoModule = require('./video');
    if (typeof videoModule.getMetadata === 'function') {
      const m = await videoModule.getMetadata(filePath);
      // m 形如 { duration: '00:01:23.45', width: 1920, height: 1080, ... }
      const meta = {};
      if (m.duration && typeof m.duration === 'string') {
        const parts = m.duration.split(':').map(Number);
        if (parts.length === 3 && parts.every(function (n) { return isFinite(n); })) {
          meta.duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
      }
      if (typeof m.width === 'number') meta.width = m.width;
      if (typeof m.height === 'number') meta.height = m.height;
      return meta;
    }
  } catch (_e) { /* 失败兜底 */ }
  return null;
}

/**
 * 把 IPC 返回的 asset 重新量化成「main process 内部 asset」（带 filePath）。
 * Renderer 没有 filePath；下一次上传时需要从 main process 内部 storage 反查。
 * 暂存策略：在 main 进程的内存里保存最近一份 VideoAsset（按 assetId 索引）。
 */
const _internalStore = new Map(); // assetId -> VideoAsset (含 filePath)
function stashInternalAsset(asset) {
  _internalStore.set(asset.id, asset);
}
function getInternalAsset(assetId) {
  return _internalStore.get(assetId) || null;
}
function clearInternalAsset(assetId) {
  if (assetId) _internalStore.delete(assetId);
}

/**
 * 你可以注册一个 IPC handler 让 renderer 在「重新选择」时清掉旧的内部 stash。
 * 但这不是必须的——内存中泄露的 _internalStore 只在 main 进程生命周期有效。
 */

// ---------- IPC 注册（在 main.js 调用） ----------
// 注意：必须注册 handlePickLocalWithStash（带 filePath 的内部 stash 版本），
// 否则 _internalStore 永远是空的，pubExecYouTube 在 getInternalAsset(assetId) 时
// 拿不到本地路径，会立刻返回 VIDEO_FILE_NOT_FOUND。
function registerVideoSourceIpc(ipcMain) {
  ipcMain.handle('video:pick-local', handlePickLocalWithStash);
  // 视频是否配置/已选择（供 publisher 在 upload 时检查；当前未启用 YouTube 上传，留接口）
  ipcMain.handle('video:get-internal-asset', function (_e, assetId) {
    const a = getInternalAsset(assetId);
    return a ? toRendererAsset(a) : null;
  });
  ipcMain.handle('video:clear-internal-asset', function (_e, assetId) {
    clearInternalAsset(assetId);
    return { ok: true };
  });
  // v1.20.10：step 14 字幕编辑器需要预览本地视频；renderer 没拿到 filePath，
  //   由 main 读取字节、转 base64 后回传（v1：保守实现，不搞 Range 分片）。
  //   返回结构 {ok, mime, b64}；前端用 URL.createObjectURL(new Blob(...)) 即可。
  ipcMain.handle('video:read-stream', function (_e, assetId) {
    try {
      const a = getInternalAsset(assetId);
      if (!a || !a.filePath) return { ok: false, error: 'asset-not-found' };
      if (!fs.existsSync(a.filePath)) return { ok: false, error: 'file-missing' };
      const buf = fs.readFileSync(a.filePath);
      return {
        ok: true,
        mime: a.mimeType || 'video/mp4',
        b64: buf.toString('base64'),
        size: buf.length
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  // v1.20.10：冻结画面帧提取。给定 assetId + atSeconds，在 main 端用 ffmpeg
  //   抽一张 JPEG，返回 base64 给 renderer（renderer 拼 blob URL 预览）。
  //   返回结构 {ok, mime, b64, fileSize}。
  ipcMain.handle('video:extract-frame', async function (_e, payload) {
    try {
      if (!payload || !payload.assetId) return { ok: false, error: 'no-asset' };
      const a = getInternalAsset(payload.assetId);
      if (!a || !a.filePath) return { ok: false, error: 'asset-not-found' };
      if (!fs.existsSync(a.filePath)) return { ok: false, error: 'file-missing' };
      const at = Math.max(0, Number(payload.atSeconds) || 0);
      const width = (typeof payload.width === 'number' && payload.width > 0) ? payload.width : 640;
      const videoModule = require('./video');
      if (!videoModule || typeof videoModule.generateThumbnail !== 'function') {
        return { ok: false, error: 'thumb-helper-missing' };
      }
      const r = await videoModule.generateThumbnail(a.filePath, { atSeconds: at, width: width });
      if (!r || !r.ok || !r.path || !fs.existsSync(r.path)) {
        return { ok: false, error: 'thumb-extract-failed' };
      }
      const buf = fs.readFileSync(r.path);
      return {
        ok: true,
        mime: 'image/jpeg',
        b64: buf.toString('base64'),
        fileSize: buf.length,
        at: at,
        path: r.path
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  // 给 handlePickLocal 的 stash 逻辑写一个独立 IPC，让 renderer 在拿到 ok=true 后通知 main 缓存
  ipcMain.handle('video:stash-asset', function (_e, asset) {
    if (!asset || !asset.id) return { ok: false };
    // asset 是 renderer 看到的简化版；从 renderer 拿不到 filePath
    // 因此 stash 必须在 handlePickLocal 内部完成；这里只对外暴露 OK 接口（无副作用）
    return { ok: true };
  });

  // 成品视频合成：冻结插入 + 字幕烧录 + AI 配音混音（一次 ffmpeg 完成）。
  //   renderer 只传 assetId + 字幕轨道数据，绝不接触 filePath；
  //   字幕文字唯一来源是调用方传入的 segments[].text（字幕轨道上的真实片段）。
  //   返回 { ok, path, bytes, subtitlesBurned, voiceTracks, finalDuration } 或 { ok:false, error }。
  ipcMain.handle('caption:burn-final', async function (_e, payload) {
    try {
      const p = payload || {};
      const assetId = p.assetId;
      const a = getInternalAsset(assetId);
      if (!a || !a.filePath) return { ok: false, error: 'asset-not-found' };
      if (!fs.existsSync(a.filePath)) return { ok: false, error: 'file-missing' };

      // 输入形状校验：segments 必须是带 text + outStart/outEnd 的数组
      const segments = Array.isArray(p.segments) ? p.segments : [];
      const frozen = Array.isArray(p.frozen) ? p.frozen : [];
      if (p.burnSubtitle !== false && !segments.length) {
        return { ok: false, error: 'no-segments:字幕轨道上没有任何有效字幕片段' };
      }

      let duration = Number(p.duration) || 0;
      if (!(duration > 0) || !isFinite(duration)) {
        // renderer 没给可信时长时在 main 侧实测
        const videoModule = require('./video');
        const meta = await videoModule.getMetadata(a.filePath);
        if (meta && typeof meta.durationMs === 'number' && meta.durationMs > 0) {
          duration = meta.durationMs / 1000;
        }
      }
      if (!(duration > 0)) return { ok: false, error: 'duration-unknown:无法确定原视频时长' };

      const captionBurn = require('./caption-burn');
      const r = await captionBurn.burnFinalVideo(a.filePath, segments, frozen, {
        duration: duration,
        width: Number(p.width) || 0,
        height: Number(p.height) || 0,
        burnSubtitle: p.burnSubtitle !== false,
        withVoice: p.withVoice !== false,
        originalAudio: p.originalAudio || 'mute',
        preset: p.preset,
        crf: p.crf,
        timeoutMs: p.timeoutMs
      });
      logger.info('[caption-burn] final video ready', {
        bytes: r.bytes,
        subtitlesBurned: r.subtitlesBurned,
        voiceTracks: r.voiceTracks,
        finalDuration: r.finalDuration
      });
      return r;
    } catch (e) {
      logger.warn('[caption-burn] failed', { error: String((e && e.message) || e) });
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // 读取已合成成品视频的字节，供渲染层 <video> 播放。
  //   安全约束：只允许读 caption-burn 自己产出的目录（userData/video/final），
  //   避免渲染层借这条 IPC 读取任意本地文件。
  ipcMain.handle('caption:read-final', function (_e, filePath) {
    try {
      if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'no-path' };
      const resolved = path.resolve(filePath);
      let allowedRoot = '';
      try { allowedRoot = path.resolve(path.join(app.getPath('userData'), 'video', 'final')); } catch (_e) {}
      if (!allowedRoot) return { ok: false, error: 'no-allowed-root' };
      const rel = path.relative(allowedRoot, resolved);
      // 必须在 allowedRoot 之内（不能是 .. 开头，也不能是绝对路径）
      if (!rel || rel.indexOf('..') === 0 || path.isAbsolute(rel)) {
        return { ok: false, error: 'path-not-allowed' };
      }
      if (!fs.existsSync(resolved)) return { ok: false, error: 'file-missing' };
      const buf = fs.readFileSync(resolved);
      return { ok: true, mime: 'video/mp4', b64: buf.toString('base64'), size: buf.length };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // 「保存视频」：把已合成的最终成品 MP4 复制到用户自选目录。
  //   - 只接受 caption-burn 自己产出的目录（与 read-final 同一白名单），
  //     渲染层无法借此复制任意本地文件。
  //   - 只做文件复制，不重新执行视频合成。
  //   - 用户取消对话框 → { ok:false, canceled:true }，渲染层安静返回不报错。
  ipcMain.handle('caption:save-final', async function (_e, payload) {
    try {
      const p = payload || {};
      if (!p.filePath || typeof p.filePath !== 'string') {
        return { ok: false, error: 'no-source-path:尚未生成成品视频' };
      }
      const resolved = path.resolve(p.filePath);
      let allowedRoot = '';
      try { allowedRoot = path.resolve(path.join(app.getPath('userData'), 'video', 'final')); } catch (_e) {}
      if (!allowedRoot) return { ok: false, error: 'no-allowed-root' };
      const rel = path.relative(allowedRoot, resolved);
      if (!rel || rel.indexOf('..') === 0 || path.isAbsolute(rel)) {
        return { ok: false, error: 'path-not-allowed' };
      }
      // 成品必须真实存在且非空，否则明确报错，绝不生成空文件
      if (!fs.existsSync(resolved)) {
        return { ok: false, error: '成品文件不存在，可能已被删除，请重新生成成品视频' };
      }
      const srcStat = fs.statSync(resolved);
      if (!srcStat.isFile() || srcStat.size <= 0) {
        return { ok: false, error: '成品文件为空，无法保存' };
      }

      const win = _e && _e.sender && _e.sender.getOwnerBrowserWindow && _e.sender.getOwnerBrowserWindow();
      const opts = {
        title: '保存成品视频',
        defaultPath: p.defaultPath || undefined,
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
      };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (!r || r.canceled || !r.filePath) {
        return { ok: false, canceled: true };
      }

      const dest = r.filePath;
      ensureDirForFile(dest);
      // 覆盖已有文件：先尝试删除（Windows 下 fs.copyFile 不会自动覆盖）
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_e) {}
      fs.copyFileSync(resolved, dest);

      // 保存后校验：目标必须存在且与源同尺寸
      if (!fs.existsSync(dest)) return { ok: false, error: '保存失败：目标文件未生成' };
      const destStat = fs.statSync(dest);
      if (destStat.size !== srcStat.size) {
        return { ok: false, error: '保存校验失败：文件大小不一致（源 ' + srcStat.size + ' / 目标 ' + destStat.size + '）' };
      }
      logger.info('[caption-burn] final video saved', { dest: dest, bytes: destStat.size });
      return { ok: true, path: dest, bytes: destStat.size };
    } catch (e) {
      logger.warn('[caption-burn] save failed', { error: String((e && e.message) || e) });
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

// 确保目标文件的父目录存在
function ensureDirForFile(filePath) {
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch (_e) {}
}

// 给 handlePickLocal 增加 stash 副作用
const _origHandle = handlePickLocal;
async function handlePickLocalWithStash(event) {
  const r = await _origHandle(event);
  if (r && r.ok && r._internalFilePath && r.asset && r.asset.id) {
    // 构造内部完整 asset（带 filePath）
    const internal = {
      id: r.asset.id,
      sourceType: r.asset.sourceType,
      filePath: r._internalFilePath,
      fileName: r.asset.fileName,
      fileSize: r.asset.fileSize,
      mimeType: r.asset.mimeType,
      duration: r.asset.duration,
      width: r.asset.width,
      height: r.asset.height,
      createdAt: r.asset.createdAt
    };
    stashInternalAsset(internal);
    // 不暴露 filePath
    delete r._internalFilePath;
  }
  return r;
}

module.exports = {
  VideoSource,
  SUPPORTED_VIDEO_MIME,
  SUPPORTED_EXTENSIONS,
  buildAsset,
  toRendererAsset,
  handlePickLocal: handlePickLocalWithStash,
  registerVideoSourceIpc,
  // 暴露给未来模块（如 YouTube uploader）使用
  getInternalAsset,
  clearInternalAsset,
  stashInternalAsset
};