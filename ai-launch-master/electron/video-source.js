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
const os = require('os');
const path = require('path');
const { dialog, app } = require('electron');
const crypto = require('crypto');

const logger = require('./logger');

// ---------- 受管成品视频目录（v1.22.3） ----------
//
// 「成品视频」= 字幕 + AI 配音合成出的最终 MP4。它有两个合法落点：
//   1) <userData>/temp/videos/final/   合成产出（临时产物）
//   2) <userData>/work-videos/         与作品关联的成品视频（归档目录）
//
// 安全约束：**只接受这两个目录里的文件**，渲染层无法借此读取 / 复制任意本地文件。
//   判定规则与 electron/main.js 的同名逻辑完全一致：
//     · 相对路径非空（目录本身不算合法文件）
//     · 不能以 '..' 开头（路径穿越）
//     · 不能是绝对路径
function managedFinalVideoRoots() {
  const roots = [];
  try {
    const ud = app.getPath('userData');
    if (ud) {
      roots.push(path.resolve(path.join(ud, 'temp', 'videos', 'final')));
      roots.push(path.resolve(path.join(ud, 'work-videos')));
    }
  } catch (_e) { /* 非 Electron 环境 / app 未就绪 → 无根 */ }
  return roots;
}

function isInsideManagedFinalDir(resolvedPath, roots) {
  const list = roots || managedFinalVideoRoots();
  for (let i = 0; i < list.length; i++) {
    const rel = path.relative(list[i], resolvedPath);
    if (!rel || rel.indexOf('..') === 0 || path.isAbsolute(rel)) continue;
    return true;
  }
  return false;
}

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

// ---------- 原视频工作副本 ----------
// v1.22（目录统一）：用户从电脑选择的外部视频，其**原文件始终留在用户原位置**
//   （不移动、不覆盖、不删除）。Rokit 复制一份到 <userData>/temp/videos/source/
//   作为工作副本，后续预览 / 字幕合成 / 冻结帧提取 / 各平台读取统一走副本；
//   所有平台共用**同一份**副本（按 assetId 唯一命名，复制一次后不再重复复制）。
//
//   只对 VideoSource.LOCAL_FILE 生效；手动录屏等其它来源（ai-demo.js 走
//   stashInternalAsset）不受影响，仍直接使用它们自己的落盘路径。
function _sourceWorkingCopyDir() {
  try {
    const dir = path.join(app.getPath('userData'), 'temp', 'videos', 'source');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) {}
    return dir;
  } catch (_e) {
    // 非 Electron 环境（单元测试）回退
    const dir = path.join(os.tmpdir(), 'rokit-temp', 'videos', 'source');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) {}
    return dir;
  }
}

// 复制一份工作副本。
//   成功 → 返回副本绝对路径（副本已校验存在且与源同尺寸）
//   失败 → 抛错；调用方**不得**登记资产（避免出现指向不存在副本的资产）
function _createSourceWorkingCopy(srcPath, assetId) {
  const dir = _sourceWorkingCopyDir();
  // 文件名用唯一 assetId（'va-<hex16>'），保留原视频扩展名
  const ext = path.extname(srcPath).toLowerCase() || '.mp4';
  const dest = path.join(dir, assetId + ext);
  fs.copyFileSync(srcPath, dest);
  // 校验：副本必须是有效文件且与源同尺寸；不合格则删掉副本并抛错
  let st;
  try { st = fs.statSync(dest); } catch (e) {
    try { fs.unlinkSync(dest); } catch (_e2) {}
    throw new Error('工作副本创建失败：目标文件未生成');
  }
  if (!st.isFile() || st.size <= 0) {
    try { fs.unlinkSync(dest); } catch (_e2) {}
    throw new Error('工作副本创建失败：目标文件无效');
  }
  const srcStat = fs.statSync(srcPath);
  if (st.size !== srcStat.size) {
    try { fs.unlinkSync(dest); } catch (_e2) {}
    throw new Error('工作副本创建失败：文件大小不一致（源 ' + srcStat.size + ' / 副本 ' + st.size + '）');
  }
  return dest;
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
  // v1.22（原视频工作副本）：原文件保留在用户原位置，这里复制一份工作副本，
  //   内部资产的 filePath 改指向副本 —— 之后所有读取（预览 / 字幕合成 / 冻结帧 / 平台）
  //   都通过 getInternalAsset() 拿到同一份副本。
  //   复制失败 → 直接返回错误，**不登记资产**（不留下指向不存在副本的资产）。
  let _workingCopy = '';
  try {
    _workingCopy = _createSourceWorkingCopy(filePath, asset.id);
  } catch (e) {
    logger.warn('[video-source] working copy failed', { filePath, error: String(e && e.message || e) });
    return { ok: false, error: '工作副本创建失败：' + String((e && e.message) || e) };
  }
  asset.filePath = _workingCopy;
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
    height: asset.height || null,
    workingCopy: true
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
      if (!m) return null;
      // getMetadata 实际返回 { durationMs, resolution:{width,height}, videoCodec, audioCodec, fps }
      const meta = {};
      if (typeof m.durationMs === 'number' && m.durationMs > 0) meta.duration = m.durationMs / 1000;
      if (m.resolution && typeof m.resolution.width === 'number') meta.width = m.resolution.width;
      if (m.resolution && typeof m.resolution.height === 'number') meta.height = m.resolution.height;
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
  //   安全约束：只允许读 **受管成品视频目录** 里的文件（见 managedFinalVideoRoots），
  //   避免渲染层借这条 IPC 读取任意本地文件。
  //   v1.22.3：受管目录有两个 —— temp/videos/final（合成产出）与 work-videos（作品关联归档）。
  ipcMain.handle('caption:read-final', function (_e, filePath) {
    try {
      if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'no-path' };
      const resolved = path.resolve(filePath);
      const allowedRoots = managedFinalVideoRoots();
      if (!allowedRoots.length) return { ok: false, error: 'no-allowed-root' };
      // 必须在某个 allowedRoot 之内（不能是 .. 开头，也不能是绝对路径，也不能是目录本身）
      if (!isInsideManagedFinalDir(resolved, allowedRoots)) {
        return { ok: false, error: 'path-not-allowed' };
      }
      if (!fs.existsSync(resolved)) return { ok: false, error: 'file-missing' };
      const buf = fs.readFileSync(resolved);
      return { ok: true, mime: 'video/mp4', b64: buf.toString('base64'), size: buf.length };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // 「保存视频」：把已合成的最终成品 MP4 复制到固定目录 <userData>/saved-videos/。
  //   - 只接受**受管成品视频目录**里的文件（与 read-final 同一白名单），
  //     渲染层无法借此复制任意本地文件。
  //   - 只做文件复制，不重新执行视频合成，**不移动**原成品（源目录里的原件仍在）。
  //   - v1.22（目录统一）：不再弹系统保存位置对话框，固定写入 saved-videos/。
  //     saved-videos/ 是用户主动保留的成品目录，**不参与**任何临时文件自动清理。
  //   - 同名文件不覆盖：自动追加 -1 / -2 … 生成不冲突的文件名。
  ipcMain.handle('caption:save-final', async function (_e, payload) {
    try {
      const p = payload || {};
      if (!p.filePath || typeof p.filePath !== 'string') {
        return { ok: false, error: 'no-source-path:尚未生成成品视频' };
      }
      const resolved = path.resolve(p.filePath);
      const allowedRoots = managedFinalVideoRoots();
      if (!allowedRoots.length) return { ok: false, error: 'no-allowed-root' };
      // v1.22.3：源文件白名单同样接受两个受管目录（temp/videos/final 与 work-videos）
      if (!isInsideManagedFinalDir(resolved, allowedRoots)) {
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

      // 目标目录固定：<userData>/saved-videos/（不存在则自动创建）
      let savedDir = '';
      try { savedDir = path.join(app.getPath('userData'), 'saved-videos'); } catch (_e) {}
      if (!savedDir) return { ok: false, error: 'no-saved-dir:无法确定保存目录' };
      try { fs.mkdirSync(savedDir, { recursive: true }); } catch (e) {
        return { ok: false, error: '保存目录创建失败：' + String((e && e.message) || e) };
      }

      // 文件名：沿用 Renderer 传入的名称（defaultPath）；只取 basename，杜绝路径穿越。
      //   缺省或非法时回退到源文件名。
      const rawName = (typeof p.defaultPath === 'string' && p.defaultPath.trim())
        ? path.basename(p.defaultPath.trim())
        : '';
      let fileName = rawName || path.basename(resolved);
      // 扩展名固定 .mp4（成品就是 mp4；用户传入的名字若没有 .mp4 则补上）
      if (!/\.mp4$/i.test(fileName)) {
        fileName = fileName.replace(/\.[^.]*$/, '') + '.mp4';
        if (!/\.mp4$/i.test(fileName)) fileName = fileName + '.mp4';
      }

      // 同名不覆盖：追加 -1 / -2 … 直到找到未占用的文件名
      let dest = path.join(savedDir, fileName);
      if (fs.existsSync(dest)) {
        const base = fileName.replace(/\.mp4$/i, '');
        let n = 1;
        for (;;) {
          const candidate = path.join(savedDir, base + '-' + n + '.mp4');
          if (!fs.existsSync(candidate)) { dest = candidate; break; }
          n++;
          if (n > 9999) return { ok: false, error: '保存失败：同名文件过多，无法生成新文件名' };
        }
      }

      // 只复制，不移动；目标不存在时 fs.copyFileSync 直接写入（不会覆盖既有文件）
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

// v1.22：原 ensureDirForFile 已无调用方（保存目标目录固定为 <userData>/saved-videos/，
//   由 caption:save-final 内部直接 mkdirSync），此处移除以免留下死代码。

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