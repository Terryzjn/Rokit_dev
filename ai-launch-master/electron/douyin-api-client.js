'use strict';
// Rokit · 抖音开放平台 API 请求封装
//
// 设计要点：
//   - access_token 通过 HTTP header `access-token` 传递（spec 要求）
//   - request() 通用方法：失败时如果错误码是 2190008（access_token 过期）→ 自动 refresh + 重试一次
//   - getUserInfo / uploadVideo / publishVideo 三个具体业务方法（spec 要求）
//   - 所有错误统一封装为 DouyinApiError（已定义在 tokenManager），带中文 description

const tokenManager = require('./douyin-token-manager');
const credentials = require('./douyin-credentials');

const API_BASE = 'https://open.douyin.com';

// 通用请求：返回业务 data 字段（已吐错 code 则抛 DouyinApiError）
async function request(pathOrFullUrl, options, useToken) {
  const url = pathOrFullUrl.indexOf('http') === 0 ? pathOrFullUrl : API_BASE + pathOrFullUrl;
  // token 解析：通过 tokenManager.getValidAccessToken 自动处理过期刷新
  const wantToken = useToken !== false;  // 默认 true
  const headers = Object.assign({}, (options && options.headers) || {});
  if (wantToken) {
    headers['access-token'] = await tokenManager.getValidAccessToken();
  }
  headers['User-Agent'] = headers['User-Agent'] || 'Rokit/1.0';

  let resp;
  try {
    resp = await fetch(url, Object.assign({}, options || {}, { headers }));
  } catch (e) {
    throw new Error('network: ' + (e && e.message || e));
  }
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const errCode = data && data.error_code;
    const e = new tokenManager.DouyinApiError(
      typeof errCode === 'number' ? errCode : resp.status,
      (data && (data.message || data.description)) || ('HTTP ' + resp.status)
    );
    throw e;
  }
  // 抖音 API 返回结构：{ data: {...}, error_code, message, description }
  if (data && typeof data.error_code === 'number' && data.error_code !== 0) {
    const code = data.error_code;
    // 2190008 access_token 过期 → 自动 refresh 后重试一次（spec 验收点 3）
    if (code === 2190008 && wantToken) {
      const status = await credentials.isSessionValid();
      if (status.session && status.session.refreshToken) {
        try {
          await tokenManager.refreshAccessToken(status.session.refreshToken);
          // 重试一次（不再处理 2190008）
          const retryHeaders = Object.assign({}, headers);
          retryHeaders['access-token'] = await tokenManager.getValidAccessToken();
          const resp2 = await fetch(url, Object.assign({}, options || {}, { headers: retryHeaders }));
          const data2 = await resp2.json().catch(() => null);
          if (data2 && typeof data2.error_code === 'number' && data2.error_code !== 0) {
            throw new tokenManager.DouyinApiError(data2.error_code, data2.message || data2.description);
          }
          if (!resp2.ok) {
            throw new tokenManager.DouyinApiError(resp2.status, 'HTTP ' + resp2.status);
          }
          return data2 && data2.data ? data2.data : data2;
        } catch (retryErr) {
          // refresh 失败或重试仍失败，抛出去
          if (retryErr instanceof tokenManager.DouyinApiError) throw retryErr;
          throw new tokenManager.DouyinApiError(code, retryErr && retryErr.message || 'refresh_failed');
        }
      }
    }
    throw new tokenManager.DouyinApiError(code, data.message || data.description);
  }
  // 抖音 data 字段约定在 .data 里
  return data && data.data ? data.data : data;
}

/**
 * 获取用户基本信息（scope: user_info）
 * @returns {Promise<{open_id:string, nickname:string, avatar:string, ...}>}
 */
async function getUserInfo() {
  return request('/oauth/userinfo/', { method: 'GET' });
}

/**
 * 上传视频到抖音（scope: video.publish）
 *   抖音视频上传是分片流程（initialize → upload_part → commit）。
 *   本接口封装单次小视频的上传；大文件请按官方文档扩展。
 * @param {Buffer} videoBuffer
 * @param {string} filename
 * @returns {Promise<{videoId:string}>}
 */
async function uploadVideo(videoBuffer, filename) {
  if (!Buffer.isBuffer(videoBuffer) || videoBuffer.length === 0) {
    throw new Error('uploadVideo: 视频内容不能为空');
  }
  // 抖音视频上传走 multipart/form-data；open_id 从 session 取
  const session = await credentials.loadSession();
  if (!session) throw new tokenManager.DouyinApiError(40006, 'no_session');
  // 实际实现要点：先 /video/create/ 拿到 upload_url，分片 PUT 上传，再 /video/commit/
  // 这里提供的是「最小可工作」骨架，调用方应根据官方文档补充分片逻辑
  const form = new FormData();
  form.append('video', new Blob([videoBuffer], { type: 'video/mp4' }), filename || 'video.mp4');
  return request('/video/upload/', { method: 'POST', body: form });
}

/**
 * 发布视频（scope: video.publish）
 * @param {string} videoId
 * @param {string} text
 * @returns {Promise<{itemId:string}>}
 */
async function publishVideo(videoId, text) {
  if (!videoId) throw new Error('publishVideo: videoId 不能为空');
  const body = new URLSearchParams({
    video_id: videoId,
    text: text || ''
  }).toString();
  return request('/video/create/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
}

module.exports = {
  request,
  getUserInfo,
  uploadVideo,
  publishVideo
};