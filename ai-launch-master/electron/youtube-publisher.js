'use strict';
// Rokit · YouTube 视频发布服务（v1.6 新增）
//
// 设计目标：
//   - 完全独立于 BrowserWindow / webContents / event.sender
//   - 进度通过 onProgress 回调传出；调用方决定如何转发到 renderer
//   - 使用 Resumable Upload（POST 创建 session → 分块 PUT）
//   - 复用 oauth.getValidAccessToken('youtube') 取得 / 自动刷新 access_token
//   - 失败分类明确，renderer 可以做友好提示
//
// 错误分类（reason 字段）：
//   'VIDEO_FILE_NOT_FOUND'         本地视频文件不存在
//   'VIDEO_FILE_NOT_READABLE'      文件无读权限或 stat 失败
//   'NOT_CONNECTED'                尚未完成 YouTube OAuth
//   'YOUTUBE_REAUTH_REQUIRED'      refresh_token 失效，需要重新授权
//   'TOKEN_REFRESH_FAILED'         token 刷新失败
//   'SCOPE_INSUFFICIENT'           scope 不含 youtube.upload
//   'NO_UPLOAD_URL'                resumable session 创建后未返回 Location
//   'API_4XX'                      YouTube API 返回 4xx（不含 401/403/429）
//   'API_5XX'                      YouTube API 返回 5xx（已重试耗尽）
//   'NETWORK'                      网络错误（已重试耗尽）
//   'ABORTED'                      用户主动中止
//   'INVALID_METADATA'             标题等元数据非法
//
// 不抛出错误给调用方。所有错误以返回值 {ok:false, reason, message, status} 表达。
// 不打印 access_token / refresh_token / filePath（progress 回调中只含字节数）。

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// 复用现有的 OAuth 模块（不重新实现 token 流程）
const oauth = require('./oauth');

// 复用 logger（fail-soft：如果加载失败用空对象）
const logger = (() => {
  try { return require('./logger'); } catch (_e) {
    return { info() {}, warn() {}, error() {} };
  }
})();

const UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3/videos';
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB / chunk（Google 推荐区间）

// 最大重试次数（仅针对 408 / 429 / 5xx / 网络错误）
const MAX_RETRIES = 3;
// 401 refresh-then-retry 仅尝试一次（refresh_token 失效时返回 YOUTUBE_REAUTH_REQUIRED）

// ------------------------------------------------------------------
// 内部工具
// ------------------------------------------------------------------

function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  return {
    title: String(meta.title || '').slice(0, 100),         // YT 限制 100
    description: String(meta.description || '').slice(0, 5000), // YT 限制 5000
    tags: Array.isArray(meta.tags) ? meta.tags.map(t => String(t).slice(0, 100)).slice(0, 500) : [],
    categoryId: meta.categoryId ? String(meta.categoryId) : undefined
  };
}

// 把任意 unknown 错误对象转成可读 message（绝不打印 token / filePath）
function errMessage(e) {
  if (!e) return 'unknown';
  if (typeof e === 'string') return e.slice(0, 500);
  return String((e && e.message) || e).slice(0, 500);
}

// 指数退避 sleep
function backoffSleep(attempt) {
  const ms = Math.min(8000, 500 * Math.pow(2, attempt));
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// 验证 access_token 的 scope 是否含 youtube.upload
function hasUploadScope(scope) {
  if (!scope || typeof scope !== 'string') return false;
  return /youtube\.upload/.test(scope);
}

// ------------------------------------------------------------------
// 主入口
// ------------------------------------------------------------------

/**
 * 用 Resumable Upload 上传本地视频到 YouTube
 *
 * @param {Object} opts
 * @param {string} opts.videoPath     本地视频绝对路径（仅 Main 内使用，Renderer 不可达）
 * @param {string} [opts.title]       标题
 * @param {string} [opts.description] 简介
 * @param {string[]} [opts.tags]      标签
 * @param {string} [opts.categoryId]  YouTube categoryId（如 '22' People & Blogs）
 * @param {string} [opts.privacyStatus] 'private' | 'unlisted' | 'public'（默认 'private'）
 * @param {string} [opts.mimeType]    MIME（默认从文件后缀推断）
 * @param {Function} [opts.onProgress] (info: {uploadedBytes, totalBytes, percentage, phase}) => void
 *
 * @returns {Promise<{ok:true, videoId:string, url:string, mimeType:string, fileSize:number}
 *                   | {ok:false, reason:string, message:string, status?:number, hint?:string}>}
 */
async function uploadResumable(opts) {
  opts = opts || {};
  const videoPath = opts.videoPath;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  // 1) 输入校验
  if (!videoPath || typeof videoPath !== 'string') {
    return {
      ok: false,
      reason: 'VIDEO_FILE_NOT_FOUND',
      message: '未提供视频文件路径'
    };
  }
  if (!path.isAbsolute(videoPath)) {
    return {
      ok: false,
      reason: 'VIDEO_FILE_NOT_FOUND',
      message: '视频文件路径必须是绝对路径（出于安全仅 Main 内可达）'
    };
  }

  let stat;
  try {
    stat = fs.statSync(videoPath);
  } catch (_e) {
    return {
      ok: false,
      reason: 'VIDEO_FILE_NOT_FOUND',
      message: '视频文件不存在：' + path.basename(videoPath)
    };
  }
  if (!stat.isFile() || stat.size <= 0) {
    return {
      ok: false,
      reason: 'VIDEO_FILE_NOT_FOUND',
      message: '视频文件不可读或为空：' + path.basename(videoPath)
    };
  }

  // 2) OAuth：拿有效 access_token（自动 refresh 一次）
  let accessToken;
  try {
    accessToken = await oauth.getValidAccessToken('youtube');
  } catch (e) {
    logger.warn('[youtube-publisher] getValidAccessToken threw', { error: errMessage(e) });
    accessToken = null;
  }
  if (!accessToken) {
    // 区分：完全未授权 vs refresh 失效
    const cur = await oauth.getTokenForInternal('youtube').catch(function () { return null; });
    if (!cur) {
      return {
        ok: false,
        reason: 'NOT_CONNECTED',
        message: '尚未完成 YouTube 授权，请先在推广渠道页完成 Google 账号授权'
      };
    }
    if (cur.needs_reconnect) {
      return {
        ok: false,
        reason: 'YOUTUBE_REAUTH_REQUIRED',
        message: 'YouTube 授权已失效（refresh_token 无效），请重新授权账号',
        hint: 'reauth'
      };
    }
    return {
      ok: false,
      reason: 'TOKEN_REFRESH_FAILED',
      message: 'YouTube token 刷新失败，请稍后重试或重新授权'
    };
  }

  // scope 检查
  const tokenRec = await oauth.getTokenForInternal('youtube').catch(function () { return null; });
  if (tokenRec && !hasUploadScope(tokenRec.scope || '')) {
    return {
      ok: false,
      reason: 'SCOPE_INSUFFICIENT',
      message: '当前 YouTube 授权 scope 不含 youtube.upload，请重新授权（包含上传权限）'
    };
  }

  // 3) 构造 metadata
  const meta = safeMeta(opts);
  if (!meta || !meta.title) {
    return {
      ok: false,
      reason: 'INVALID_METADATA',
      message: '视频标题不能为空（YouTube 必填字段）'
    };
  }

  const privacyStatus = ['private', 'unlisted', 'public'].indexOf(opts.privacyStatus) >= 0
    ? opts.privacyStatus
    : 'private';

  const mimeType = opts.mimeType || inferMimeFromPath(videoPath);

  const metadata = {
    snippet: {
      title: meta.title,
      description: meta.description,
      tags: meta.tags.length ? meta.tags : undefined,
      categoryId: meta.categoryId
    },
    status: {
      privacyStatus: privacyStatus,
      selfDeclaredMadeForKids: false
    }
  };

  const fileSize = stat.size;

  // 4) 创建 resumable upload session（POST + 元数据）
  const createUrl = UPLOAD_BASE + '?uploadType=resumable&part=snippet,status';
  const sessionUrl = await createResumableSession(createUrl, accessToken, metadata, mimeType, fileSize);

  if (!sessionUrl.ok) return sessionUrl;

  const uploadUrl = sessionUrl.uploadUrl;

  // 进度：开始上传
  if (onProgress) {
    try { onProgress({ uploadedBytes: 0, totalBytes: fileSize, percentage: 0, phase: 'uploading' }); } catch (_e) {}
  }

  // 5) 分块 PUT
  const uploadResult = await uploadChunks(uploadUrl, videoPath, fileSize, UPLOAD_CHUNK_SIZE, accessToken, onProgress);

  if (!uploadResult.ok) return uploadResult;

  const videoId = uploadResult.videoId;

  // 进度：完成
  if (onProgress) {
    try { onProgress({ uploadedBytes: fileSize, totalBytes: fileSize, percentage: 100, phase: 'done' }); } catch (_e) {}
  }

  return {
    ok: true,
    videoId: videoId,
    url: 'https://www.youtube.com/watch?v=' + videoId,
    mimeType: mimeType,
    fileSize: fileSize
  };
}

// ------------------------------------------------------------------
// 步骤 1：创建 resumable upload session
// ------------------------------------------------------------------

async function createResumableSession(url, accessToken, metadata, mimeType, totalBytes) {
  let resp;
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(totalBytes),
          'Accept': 'application/json',
          'User-Agent': 'Rokit-YouTubePublisher/1.0'
        },
        body: JSON.stringify(metadata)
      });
    } catch (e) {
      lastErr = errMessage(e);
      logger.warn('[youtube-publisher] createResumableSession network error', { attempt, error: lastErr });
      if (attempt < MAX_RETRIES) { await backoffSleep(attempt); continue; }
      return {
        ok: false,
        reason: 'NETWORK',
        message: '网络异常：创建上传会话失败（' + lastErr + '）'
      };
    }
    if (resp.status === 401) {
      // 401：refresh token 后重试一次
      const refreshed = await tryRefreshAndGetToken();
      if (refreshed.ok) {
        accessToken = refreshed.token;
        continue;
      }
      return refreshed.result;
    }
    if (resp.status === 403) {
      const body = await safeReadText(resp);
      logger.warn('[youtube-publisher] createResumableSession 403', { body: body.slice(0, 200) });
      return {
        ok: false,
        reason: 'SCOPE_INSUFFICIENT',
        message: '403 Forbidden：YouTube API 权限不足。' + extractYouTubeError(body),
        status: 403
      };
    }
    if (resp.status === 429) {
      if (attempt < MAX_RETRIES) {
        logger.warn('[youtube-publisher] createResumableSession 429, retrying', { attempt });
        await backoffSleep(attempt);
        continue;
      }
      return {
        ok: false,
        reason: 'API_5XX',
        message: '请求过于频繁（429），请稍后重试',
        status: 429
      };
    }
    if (resp.status >= 500) {
      if (attempt < MAX_RETRIES) {
        logger.warn('[youtube-publisher] createResumableSession 5xx, retrying', { status: resp.status, attempt });
        await backoffSleep(attempt);
        continue;
      }
      return {
        ok: false,
        reason: 'API_5XX',
        message: 'YouTube API 服务异常（HTTP ' + resp.status + '），请稍后重试',
        status: resp.status
      };
    }
    if (!resp.ok) {
      const body = await safeReadText(resp);
      logger.warn('[youtube-publisher] createResumableSession 4xx', { status: resp.status, body: body.slice(0, 200) });
      return {
        ok: false,
        reason: 'API_4XX',
        message: '创建上传会话失败（HTTP ' + resp.status + '）：' + extractYouTubeError(body),
        status: resp.status
      };
    }

    // 200/201/202：读取 Location header
    const loc = resp.headers.get('location') || resp.headers.get('Location');
    if (!loc) {
      return {
        ok: false,
        reason: 'NO_UPLOAD_URL',
        message: 'YouTube 未返回上传 URL（响应头缺失 Location）'
      };
    }
    return { ok: true, uploadUrl: loc };
  }
  return {
    ok: false,
    reason: 'NETWORK',
    message: '网络异常：创建上传会话失败（' + (lastErr || 'unknown') + '）'
  };
}

// ------------------------------------------------------------------
// 步骤 2：分块 PUT 上传
// ------------------------------------------------------------------

async function uploadChunks(uploadUrl, filePath, totalBytes, chunkSize, accessToken, onProgress) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    return {
      ok: false,
      reason: 'VIDEO_FILE_NOT_READABLE',
      message: '无法打开视频文件：' + errMessage(e)
    };
  }

  let uploaded = 0;
  let buf = Buffer.allocUnsafe(chunkSize);
  let lastReportedPct = -1;

  try {
    while (uploaded < totalBytes) {
      const end = Math.min(uploaded + chunkSize, totalBytes);
      const len = end - uploaded;
      const slice = buf.slice(0, len);
      try {
        fs.readSync(fd, slice, 0, len, uploaded);
      } catch (e) {
        return {
          ok: false,
          reason: 'VIDEO_FILE_NOT_READABLE',
          message: '读取视频分块失败：' + errMessage(e)
        };
      }

      const range = 'bytes ' + uploaded + '-' + (end - 1) + '/' + totalBytes;
      const chunkResult = await putChunk(uploadUrl, slice, range, accessToken);

      if (!chunkResult.ok) return chunkResult;

      uploaded = end;

      // 进度回调（去抖动：每 1% 触发一次，最多 ~100 次）
      if (onProgress) {
        const pct = Math.floor(uploaded * 100 / totalBytes);
        if (pct !== lastReportedPct) {
          lastReportedPct = pct;
          try {
            onProgress({
              uploadedBytes: uploaded,
              totalBytes: totalBytes,
              percentage: pct,
              phase: 'uploading'
            });
          } catch (_e) {}
        }
      }

      // 308 = Resume Incomplete（说明还有更多）
      if (chunkResult.status === 200 || chunkResult.status === 201) {
        // 完成（HTTP 200/201 才返回 videoId）
        const final = chunkResult.body;
        try {
          const j = JSON.parse(final);
          if (j && j.id) {
            return { ok: true, videoId: String(j.id) };
          }
        } catch (_e) {}
        return {
          ok: false,
          reason: 'API_4XX',
          message: 'YouTube 返回 200/201 但响应体不含 id'
        };
      }
      // 308 继续；204/200/201 已处理
    }

    // 循环结束（理论上最后一个 chunk 命中 200/201）；若 uploaded===total 但未拿到 id，再 PUT 一次
    // 罕见：服务端可能在最后一个 chunk 返回 308 但其实已完成。保险起见：再发一次 final 0-byte 请求探测
    const probe = await putChunk(uploadUrl, Buffer.alloc(0), 'bytes */' + totalBytes, accessToken);
    if (probe.ok && probe.status === 200 || probe.status === 201) {
      try {
        const j = JSON.parse(probe.body);
        if (j && j.id) return { ok: true, videoId: String(j.id) };
      } catch (_e) {}
    }
    return {
      ok: false,
      reason: 'API_4XX',
      message: '上传完成后未拿到 videoId'
    };
  } finally {
    try { fs.closeSync(fd); } catch (_e) {}
  }
}

async function putChunk(uploadUrl, bodyBuf, contentRange, accessToken) {
  let resp;
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      resp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/octet-stream',
          'Content-Range': contentRange,
          'Accept': 'application/json',
          'User-Agent': 'Rokit-YouTubePublisher/1.0'
        },
        body: bodyBuf
      });
    } catch (e) {
      lastErr = errMessage(e);
      logger.warn('[youtube-publisher] putChunk network error', { contentRange, attempt, error: lastErr });
      if (attempt < MAX_RETRIES) { await backoffSleep(attempt); continue; }
      return {
        ok: false,
        reason: 'NETWORK',
        message: '网络异常：上传分块失败（' + contentRange + '）'
      };
    }
    if (resp.status === 401) {
      const refreshed = await tryRefreshAndGetToken();
      if (refreshed.ok) {
        accessToken = refreshed.token;
        continue;
      }
      return refreshed.result;
    }
    if (resp.status === 403) {
      const bodyTxt = await safeReadText(resp);
      logger.warn('[youtube-publisher] putChunk 403', { contentRange, body: bodyTxt.slice(0, 200) });
      return {
        ok: false,
        reason: 'SCOPE_INSUFFICIENT',
        message: '403 Forbidden：YouTube API 权限不足。' + extractYouTubeError(bodyTxt),
        status: 403
      };
    }
    if (resp.status === 308) {
      // Resume Incomplete：还有更多；服务端返回 Range header 表示已接收范围
      return { ok: true, status: 308 };
    }
    if (resp.status === 429) {
      if (attempt < MAX_RETRIES) {
        await backoffSleep(attempt);
        continue;
      }
      return {
        ok: false,
        reason: 'API_5XX',
        message: '请求过于频繁（429），请稍后重试',
        status: 429
      };
    }
    if (resp.status === 408 || resp.status >= 500) {
      if (attempt < MAX_RETRIES) {
        await backoffSleep(attempt);
        continue;
      }
      return {
        ok: false,
        reason: 'API_5XX',
        message: '上传分块失败（HTTP ' + resp.status + '）：服务端或网络异常',
        status: resp.status
      };
    }
    if (!resp.ok) {
      const bodyTxt = await safeReadText(resp);
      logger.warn('[youtube-publisher] putChunk 4xx', { status: resp.status, contentRange, body: bodyTxt.slice(0, 200) });
      return {
        ok: false,
        reason: 'API_4XX',
        message: '上传分块失败（HTTP ' + resp.status + '）：' + extractYouTubeError(bodyTxt),
        status: resp.status
      };
    }
    // 200/201：完成
    const bodyTxt = await safeReadText(resp);
    return { ok: true, status: resp.status, body: bodyTxt };
  }
  return {
    ok: false,
    reason: 'NETWORK',
    message: '网络异常：上传分块失败（' + (lastErr || 'unknown') + '）'
  };
}

// ------------------------------------------------------------------
// token refresh helper（401 重试用）
// ------------------------------------------------------------------

async function tryRefreshAndGetToken() {
  try {
    const r = await oauth.refresh('youtube');
    if (r && r.ok) {
      const fresh = await oauth.getValidAccessToken('youtube');
      if (fresh) return { ok: true, token: fresh };
    }
    if (r && r.reason === 'invalid_grant') {
      return {
        ok: false,
        result: {
          ok: false,
          reason: 'YOUTUBE_REAUTH_REQUIRED',
          message: 'YouTube 授权已失效（refresh_token 无效），请重新授权账号',
          hint: 'reauth'
        }
      };
    }
    return {
      ok: false,
      result: {
        ok: false,
        reason: 'TOKEN_REFRESH_FAILED',
        message: 'YouTube token 刷新失败，请稍后重试或重新授权'
      }
    };
  } catch (e) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: 'TOKEN_REFRESH_FAILED',
        message: 'YouTube token 刷新异常：' + errMessage(e)
      }
    };
  }
}

// ------------------------------------------------------------------
// 辅助：读 response body / 提取 YouTube 错误
// ------------------------------------------------------------------

async function safeReadText(resp) {
  try { return await resp.text(); } catch (_e) { return ''; }
}

function extractYouTubeError(body) {
  if (!body) return '';
  try {
    const j = JSON.parse(body);
    if (j && j.error) {
      const e = j.error;
      const msg = (e.message || '').slice(0, 200);
      const reasons = Array.isArray(e.errors) ? e.errors.map(function (x) {
        return (x.reason || '') + (x.message ? '(' + x.message.slice(0, 80) + ')' : '');
      }).join('; ') : '';
      return (msg ? (msg + ' ') : '') + (reasons ? ('[' + reasons + ']') : '');
    }
  } catch (_e) {}
  return body.slice(0, 200);
}

function inferMimeFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.mkv': return 'video/x-matroska';
    case '.avi': return 'video/x-msvideo';
    default: return 'application/octet-stream';
  }
}

module.exports = {
  uploadResumable,
  // 暴露给单测 / 调试
  inferMimeFromPath,
  UPLOAD_BASE,
  UPLOAD_CHUNK_SIZE
};
