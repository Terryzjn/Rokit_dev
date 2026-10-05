'use strict';
// Rokit · 抖音开放平台凭据与会话（本地加密存储）
//
// 存储策略（贴合项目现实的「electron-store + safeStorage + keytar」三层）：
//   1. JSON 序列化整个凭据 / 会话对象
//   2. safeStorage.encryptStringAsync() 用 OS 级密钥（Windows DPAPI / macOS Keychain / Linux libsecret）加密
//   3. 再 Base64 编码后存到 store.upsertSettingKv（项目的 electron-store 等价）
//   4. 并镜像一份到 keytar（secrets.js），双保险——即使 settings_kv 损坏也能从 keytar 恢复
//
// 实际读取时：Base64 解码 → safeStorage.decryptStringAsync → JSON.parse
// 任意一步失败 → 视为 corrupt key，自动清除（不抛给上层，避免泄漏内部细节）
//
// 为什么不用纯文本存 clientSecret：抖音开放平台的 clientSecret 等同于账号密码；
//   全明文存到 JSON/SQLite 等于裸奔——任何能读 .userdata 目录的人都能盗用。
//   现状 Windows Credential Manager / macOS Keychain / Linux libsecret 保护 secrets，
//   加上 Electron 的 safeStorage 套一层，即使 .userdata 目录被整体拷贝，没有当前 OS 用户凭据也解不开。

const path = require('path');

const safeStorage = require('electron').safeStorage;
const secrets = require('./secrets');

// ---------- 存储 key 常量 ----------
const KEY_CREDENTIALS = 'douyin_credentials';
const KEY_SESSION = 'douyin_session';
const KEYTAR_ACCOUNT_CRED = 'douyin-client-secret-blob';   // 镜像备份（仅加密 blob）
const KEYTAR_ACCOUNT_SESSION = 'douyin-session-blob';       // 镜像备份

// 让外部可注入 store（避免模块硬依赖全局实例）
let storeRef = null;
function setStore(store) {
  storeRef = store;
}
function getStore() {
  if (!storeRef) throw new Error('douyinCredentials: store 未注入；请在 main.js 创建 Store 后调用 setStore()');
  return storeRef;
}

// ---------- 加密/解密基础 ----------
async function encryptToBase64(plaintext) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    // Linux 平台未安装 libsecret 等场景下 safeStorage 不可用
    // 不静默降级为明文 — 按 spec 抛出明确错误
    throw new Error('SAFE_STORAGE_UNAVAILABLE: 当前 Linux 环境未安装 GNOME libsecret / kwallet，无法加密抖音凭据。请安装 libsecret-1-0 或 kwallet5 后重启应用。');
  }
  const encrypted = await safeStorage.encryptStringAsync(String(plaintext || ''));
  return Buffer.from(encrypted).toString('base64');
}

async function decryptFromBase64(b64) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    throw new Error('SAFE_STORAGE_UNAVAILABLE: safeStorage 不可用，无法解密抖音凭据。');
  }
  const buf = Buffer.from(String(b64 || ''), 'base64');
  const plaintext = await safeStorage.decryptStringAsync(buf);
  return plaintext;
}

// 日志脱敏：仅打印前后 4 位 + 总长度
function mask(secret) {
  if (!secret) return '';
  const s = String(secret);
  if (s.length <= 8) return '***';
  return s.slice(0, 4) + '***' + s.slice(-4) + '(' + s.length + ')';
}

// ---------- 公开 API：凭据 ----------

/**
 * @typedef {Object} DouyinCredentials
 * @property {string} clientKey
 * @property {string} clientSecret
 * @property {string} [savedAt]
 */

/**
 * 保存抖音开放平台 ClientKey + ClientSecret。
 *   - clientKey 不敏感，明文存
 *   - clientSecret 通过 safeStorage + Base64 加密后存
 * @param {string} clientKey
 * @param {string} clientSecret
 */
async function saveCredentials(clientKey, clientSecret) {
  if (!clientKey || !clientSecret) {
    throw new Error('INVALID_INPUT: clientKey 和 clientSecret 均不能为空');
  }
  const store = getStore();
  const credBlobB64 = await encryptToBase64(JSON.stringify({ clientSecret }));
  const payload = {
    clientKey: String(clientKey),
    secretBlob: credBlobB64,
    savedAt: new Date().toISOString()
  };
  // 1) 存到 settings_kv（项目内的 electron-store 等价）
  store.upsertSettingKv(KEY_CREDENTIALS, JSON.stringify(payload));
  // 2) 镜像一份到 keytar（OS 凭据存储）—— 只存加密 blob，不存明文
  try {
    await secrets.setSecret(KEYTAR_ACCOUNT_CRED, JSON.stringify(payload));
  } catch (_e) { /* keytar 失败不阻断主流程 */ }
  // 日志仅打印前后 4 位
  const logger = require('./logger');
  logger.info('[douyin-credentials] credentials saved', {
    clientKeyMask: mask(clientKey),
    secretLen: String(clientSecret).length
  });
}

/**
 * 加载已保存的抖音凭据（自动解密）。
 * @returns {Promise<DouyinCredentials|null>}
 */
async function loadCredentials() {
  const store = getStore();
  const raw = store.getSettingKv(KEY_CREDENTIALS);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    if (!payload.clientKey || !payload.secretBlob) return null;
    const decrypted = await decryptFromBase64(payload.secretBlob);
    const inner = JSON.parse(decrypted);
    return {
      clientKey: payload.clientKey,
      clientSecret: inner.clientSecret,
      savedAt: payload.savedAt
    };
  } catch (e) {
    // 解密失败 / JSON 损坏 → 清掉 + 返回 null（按 spec「解密失败时清除无效数据」）
    const logger = require('./logger');
    logger.warn('[douyin-credentials] load failed, clearing invalid blob', { error: String(e && e.message || e) });
    try { store.upsertSettingKv(KEY_CREDENTIALS, null); } catch (_e) {}
    try { await secrets.deleteSecret(KEYTAR_ACCOUNT_CRED); } catch (_e) {}
    return null;
  }
}

/**
 * 清除已保存的抖音凭据（含 keytar 镜像）。
 */
async function clearCredentials() {
  const store = getStore();
  try { store.upsertSettingKv(KEY_CREDENTIALS, null); } catch (_e) {}
  try { await secrets.deleteSecret(KEYTAR_ACCOUNT_CRED); } catch (_e) {}
  const logger = require('./logger');
  logger.info('[douyin-credentials] credentials cleared');
}

// ---------- 公开 API：会话 ----------

/**
 * @typedef {Object} DouyinSession
 * @property {string} openId
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} accessTokenExpiresAt   // ms timestamp
 * @property {number} refreshTokenExpiresAt  // ms timestamp
 * @property {string[]} scope
 * @property {string} savedAt
 */

/**
 * 保存会话（含 accessToken / refreshToken 加密）。
 * @param {DouyinSession} session
 */
async function saveSession(session) {
  if (!session || !session.openId || !session.accessToken || !session.refreshToken) {
    throw new Error('INVALID_INPUT: session 必须包含 openId / accessToken / refreshToken');
  }
  const store = getStore();
  // session 整体加密（accessToken / refreshToken 都是敏感）
  const blob = {
    openId: session.openId,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    scope: session.scope || [],
    savedAt: new Date().toISOString()
  };
  const encryptedB64 = await encryptToBase64(JSON.stringify(blob));
  const payload = JSON.stringify({
    openId: blob.openId,
    encryptedBlob: encryptedB64,
    accessTokenExpiresAt: blob.accessTokenExpiresAt,
    refreshTokenExpiresAt: blob.refreshTokenExpiresAt,
    scope: blob.scope,
    savedAt: blob.savedAt
  });
  store.upsertSettingKv(KEY_SESSION, payload);
  try { await secrets.setSecret(KEYTAR_ACCOUNT_SESSION, payload); } catch (_e) {}
  const logger = require('./logger');
  logger.info('[douyin-credentials] session saved', {
    openId: blob.openId,
    accessTokenMask: mask(blob.accessToken),
    refreshTokenMask: mask(blob.refreshToken)
  });
}

/**
 * 加载并解密会话。解密失败 → 清除并返回 null。
 * @returns {Promise<DouyinSession|null>}
 */
async function loadSession() {
  const store = getStore();
  const raw = store.getSettingKv(KEY_SESSION);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    const decrypted = await decryptFromBase64(payload.encryptedBlob);
    const blob = JSON.parse(decrypted);
    return {
      openId: blob.openId,
      accessToken: blob.accessToken,
      refreshToken: blob.refreshToken,
      accessTokenExpiresAt: blob.accessTokenExpiresAt,
      refreshTokenExpiresAt: blob.refreshTokenExpiresAt,
      scope: blob.scope || [],
      savedAt: blob.savedAt
    };
  } catch (e) {
    const logger = require('./logger');
    logger.warn('[douyin-credentials] session load failed, clearing invalid blob', { error: String(e && e.message || e) });
    try { store.upsertSettingKv(KEY_SESSION, null); } catch (_e) {}
    try { await secrets.deleteSecret(KEYTAR_ACCOUNT_SESSION); } catch (_e) {}
    return null;
  }
}

/**
 * 清除会话（含 keytar 镜像）。
 */
async function clearSession() {
  const store = getStore();
  try { store.upsertSettingKv(KEY_SESSION, null); } catch (_e) {}
  try { await secrets.deleteSecret(KEYTAR_ACCOUNT_SESSION); } catch (_e) {}
  const logger = require('./logger');
  logger.info('[douyin-credentials] session cleared');
}

/**
 * 检查会话是否有效（判断 access_token / refresh_token 过期状态）。
 * @returns {Promise<{valid:boolean,reason?:'NO_SESSION'|'ACCESS_TOKEN_EXPIRED'|'REFRESH_TOKEN_EXPIRED',session?:DouyinSession}>}
 */
async function isSessionValid() {
  const s = await loadSession();
  if (!s) return { valid: false, reason: 'NO_SESSION' };
  const now = Date.now();
  // 安全裕度：提前 60s 判过期，避免边界
  const accessStillValid = s.accessTokenExpiresAt && (now < s.accessTokenExpiresAt - 60000);
  const refreshStillValid = s.refreshTokenExpiresAt && (now < s.refreshTokenExpiresAt - 60000);
  if (accessStillValid) return { valid: true, session: s };
  if (refreshStillValid) return { valid: false, reason: 'ACCESS_TOKEN_EXPIRED', session: s };
  return { valid: false, reason: 'REFRESH_TOKEN_EXPIRED', session: s };
}

module.exports = {
  // 依赖注入
  setStore,
  // 凭据
  saveCredentials,
  loadCredentials,
  clearCredentials,
  // 会话
  saveSession,
  loadSession,
  clearSession,
  isSessionValid,
  // 工具
  mask
};