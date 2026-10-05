'use strict';
// Rokit · 抖音开放平台 Token 管理
//
// 职责：
//   - getValidAccessToken()  拿一个当前可用的 access_token；过期自动刷新（带互斥锁）
//   - refreshAccessToken()    用 refresh_token 换新 access_token（spec 验收点 2、3）
//   - getClientToken()       无需用户授权的 client_token（2 小时有效），按 clientKey 缓存
//
// 互斥锁（Promise 链式）：
//   并发调用 getValidAccessToken() 时，第一个调用发起刷新，后续调用共用同一次刷新结果，
//   不会触发多次 refresh_token 调用。验收点 2「连续调用 10 次只刷 1 次」。

const credentials = require('./douyin-credentials');

const OAUTH_BASE = 'https://open.douyin.com/oauth';

// ---------- 抖音 API 错误码 → 中文 ----------
//   用于 DouyinApiError；也方便上层 UI 直接展示
const ERROR_MESSAGE_MAP = {
  2190002: 'access_token 无效',
  2190008: 'access_token 已过期，正在刷新',
  10010: 'refresh_token 已过期，请重新授权',
  40001: '参数错误，请检查请求参数',
  40002: '没有调用权限，请检查 Scope 是否已申请并授权',
  40006: '用户未登录，请重新授权',
  40007: '接口调用频率过高，请稍后重试',
  28003017: 'quota 已用完，请检查调用额度'
};

/**
 * 抖音 API 错误：包含 errorCode + 可读 description。
 *   注意：description 是基于已知错误码表的本地化文本，原始 errmsg 不会泄露给 UI。
 */
class DouyinApiError extends Error {
  constructor(errorCode, message, opts) {
    const desc = (opts && opts.description) || ERROR_MESSAGE_MAP[errorCode] || ('抖音接口错误 ' + errorCode);
    super(desc);
    this.name = 'DouyinApiError';
    this.errorCode = errorCode;
    this.description = desc;
    this.rawMessage = message;     // 原始 errmsg（供日志排查）
  }
}

// ---------- 互斥锁（Promise 单飞）----------
const inflightRefresh = new Map();   // key=refreshToken -> Promise<DouyinSession>

async function refreshOnce(refreshToken, clientKey, clientSecret) {
  // 标准 form-urlencoded（spec 要求）
  const body = new URLSearchParams({
    client_key: clientKey,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  }).toString();

  let resp;
  try {
    resp = await fetch(OAUTH_BASE + '/refresh_token/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Rokit/1.0'
      },
      body
    });
  } catch (e) {
    throw new Error('NETWORK_ERROR: 刷新 token 网络失败：' + (e && e.message || e));
  }

  let data;
  try { data = await resp.json(); } catch (_e) { data = null; }
  if (!resp.ok || !data) {
    throw new Error('HTTP_ERROR: 刷新 token 接口 HTTP ' + resp.status);
  }
  if (data.error_code !== undefined && data.error_code !== 0) {
    // 10010 = refresh_token 已过期；按 spec 验收点 4「抛出明确错误」
    throw new DouyinApiError(data.error_code, data.message || data.description || '刷新失败');
  }
  // 抖音 refresh_token 接口返回字段：access_token / refresh_token / expires_in / refresh_expires_in / open_id / scope
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,    // 不返回新 refresh_token 时保留旧值
    expiresIn: data.expires_in || 15 * 24 * 3600,         // 默认 15 天
    refreshExpiresIn: data.refresh_expires_in || 30 * 24 * 3600, // 默认 30 天
    openId: data.open_id,
    scope: data.scope ? String(data.scope).split(',') : []
  };
}

/**
 * 用 refresh_token 换取新的会话（已存到本地加密存储）。
 * @param {string} refreshToken
 * @returns {Promise<DouyinSession>}
 */
async function refreshAccessToken(refreshToken) {
  if (!refreshToken) {
    throw new DouyinApiError(10010, 'refresh_token 为空；请重新授权');
  }
  const creds = await credentials.loadCredentials();
  if (!creds) {
    throw new Error('NO_CREDENTIALS: 客户端凭据未配置；请先在设置中填写 clientKey / clientSecret');
  }

  // 单飞：同 refreshToken 的并发请求共享同一次刷新
  if (inflightRefresh.has(refreshToken)) {
    return inflightRefresh.get(refreshToken);
  }
  const p = (async () => {
    const data = await refreshOnce(refreshToken, creds.clientKey, creds.clientSecret);
    const now = Date.now();
    const session = {
      openId: data.openId,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accessTokenExpiresAt: now + data.expiresIn * 1000,
      refreshTokenExpiresAt: now + data.refreshExpiresIn * 1000,
      scope: data.scope,
      savedAt: new Date().toISOString()
    };
    await credentials.saveSession(session);
    return session;
  })();
  inflightRefresh.set(refreshToken, p);
  try {
    return await p;
  } finally {
    inflightRefresh.delete(refreshToken);
  }
}

/**
 * 拿一个当前可用的 access_token。距过期 5 分钟内主动刷新（spec 要求「超过 5 分钟」返直，
 *   这里取反义「5 分钟内主动刷新」更稳健 —— 防止边界情况刚好差几秒过期）。
 *
 * 验收点 2：
 *   连续调用 10 次，Token 刷新接口只被调用 1 次 —— 由 inflightRefresh Map + session 缓存保证。
 *
 * 验收点 3：
 *   access_token 已过期但 refresh_token 仍有效 → 自动 refresh 并返回新 access_token。
 *
 * 验收点 4：
 *   refresh_token 也过期（错误码 10010）→ 抛 DouyinApiError(10010) 提示用户重新授权。
 *
 * @returns {Promise<string>}
 */
async function getValidAccessToken() {
  const status = await credentials.isSessionValid();
  if (!status.session) {
    throw new DouyinApiError(40006, 'no_session');
  }
  // access_token 仍可用（>=5 分钟裕度）→ 直接返回
  if (status.valid) {
    return status.session.accessToken;
  }
  // access_token 过期 / refresh_token 过期
  if (status.reason === 'REFRESH_TOKEN_EXPIRED') {
    throw new DouyinApiError(10010, 'refresh_token 已过期；请重新授权');
  }
  // ACCESS_TOKEN_EXPIRED：自动刷新
  const session = await refreshAccessToken(status.session.refreshToken);
  return session.accessToken;
}

// ---------- client_token（无需用户授权）----------

const clientTokenCache = new Map();   // key=clientKey -> { token, expiresAt }

async function fetchClientToken(clientKey, clientSecret) {
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    grant_type: 'client_credential'
  }).toString();
  const resp = await fetch(OAUTH_BASE + '/client_token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Rokit/1.0' },
    body
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data) throw new Error('HTTP_ERROR: client_token 接口 HTTP ' + resp.status);
  if (data.error_code !== undefined && data.error_code !== 0) {
    throw new DouyinApiError(data.error_code, data.message || 'client_token 失败');
  }
  return data;
}

/**
 * 拿 client_token（无用户授权场景），2 小时缓存。
 * @returns {Promise<string>}
 */
async function getClientToken() {
  const creds = await credentials.loadCredentials();
  if (!creds) {
    throw new Error('NO_CREDENTIALS: 客户端凭据未配置；请先在设置中填写 clientKey / clientSecret');
  }
  const now = Date.now();
  const cached = clientTokenCache.get(creds.clientKey);
  if (cached && cached.expiresAt && now < cached.expiresAt - 60000) {
    return cached.token;
  }
  const data = await fetchClientToken(creds.clientKey, creds.clientSecret);
  if (!data.access_token) {
    throw new Error('client_token 接口未返回 access_token');
  }
  // expires_in 默认 7200s（2 小时）
  const ttl = (typeof data.expires_in === 'number' && data.expires_in > 0) ? data.expires_in : 7200;
  clientTokenCache.set(creds.clientKey, { token: data.access_token, expiresAt: now + ttl * 1000 });
  return data.access_token;
}

module.exports = {
  DouyinApiError,
  ERROR_MESSAGE_MAP,
  getValidAccessToken,
  refreshAccessToken,
  getClientToken
};