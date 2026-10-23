// Rokit · 敏感凭据管理（v1.5）
// 把 API Key、GitHub PAT 等敏感字符串从 SQLite 明文存储迁出，
// 写入操作系统原生凭据管理器（Windows = Credential Manager via DPAPI）。
//
// 设计目标：
//   - 主路径：keytar.setPassword / getPassword / deletePassword
//   - 降级：keytar 加载失败（无原生构建 / Linux 无 libsecret / macOS 钥匙串拒绝）→
//     退化为进程内存单例 + 警告日志；UI 上提示用户安装系统组件
//   - 一次性明文迁移：检测到 store.settings.api_key 仍有值时，
//     弹窗询问用户 → 用户同意后写入凭据管理器并清空 SQLite 字段
//
// 所有调用都通过 Promise 包装，确保 main 进程可以 await。

'use strict';

const logger = (() => {
  try { return require('./logger'); } catch (_e) { return { info() {}, warn() {}, error() {} }; }
})();

const SERVICE = 'Rokit';
const ACCOUNT_API_KEY = 'llm-api-key';
const ACCOUNT_GITHUB_PAT = 'github-pat';
const ACCOUNT_YOUTUBE_API_KEY = 'youtube-api-key';
// v1.21：线上语音引擎凭据（OpenAI TTS / ElevenLabs TTS）。
//   与本地 API Key 一样只进 OS 凭据管理器，**绝不**写入 SQLite / settings JSON / 日志。
const ACCOUNT_OPENAI_TTS_KEY = 'openai-tts-api-key';
const ACCOUNT_ELEVENLABS_TTS_KEY = 'elevenlabs-tts-api-key';

// 模块级缓存（避免每次 LLM 调用都走 keytar）
const cache = { apiKey: null, githubPat: null };

let keytar = null;
let keytarLoadError = null;
try {
  keytar = require('keytar');
} catch (e) {
  keytarLoadError = e;
  logger.warn('[secrets] keytar 模块加载失败，敏感字段降级为内存单例', { error: String(e && e.message || e) });
}

function hasNative() {
  return !!keytar;
}

// 通用读写
async function setSecret(account, value) {
  if (!value) {
    return deleteSecret(account);
  }
  if (keytar) {
    try {
      await keytar.setPassword(SERVICE, account, value);
      cache[account] = value;
      return true;
    } catch (e) {
      logger.warn('[secrets] keytar.setPassword 失败，降级为内存', { account, error: String(e && e.message || e) });
    }
  }
  // 降级：仅写入内存（重启即丢；提示用户安装系统组件）
  cache[account] = value;
  return false; // false = 没真正持久化
}

async function getSecret(account) {
  if (cache[account] != null) return cache[account];
  if (!keytar) return null;
  try {
    const v = await keytar.getPassword(SERVICE, account);
    if (v != null) cache[account] = v;
    return v;
  } catch (e) {
    logger.warn('[secrets] keytar.getPassword 失败', { account, error: String(e && e.message || e) });
    return null;
  }
}

async function deleteSecret(account) {
  if (keytar) {
    try { await keytar.deletePassword(SERVICE, account); } catch (_e) { /* 不存在则忽略 */ }
  }
  cache[account] = null;
  return true;
}

// API Key 专属接口
async function getApiKey() {
  return getSecret(ACCOUNT_API_KEY);
}
async function setApiKey(value) {
  return setSecret(ACCOUNT_API_KEY, value);
}
async function clearApiKey() {
  return deleteSecret(ACCOUNT_API_KEY);
}

// v1.21：线上语音引擎（OpenAI TTS / ElevenLabs TTS）专属凭据接口。
//   - 密钥只落 OS 凭据管理器（keytar）；渲染层永远拿不到明文，只拿到「是否已配置」布尔值。
//   - 清除后 getXxx 返回 null，后续请求自然不再携带旧密钥。
async function getOpenaiTtsKey() {
  return getSecret(ACCOUNT_OPENAI_TTS_KEY);
}
async function setOpenaiTtsKey(value) {
  return setSecret(ACCOUNT_OPENAI_TTS_KEY, value);
}
async function clearOpenaiTtsKey() {
  return deleteSecret(ACCOUNT_OPENAI_TTS_KEY);
}
async function getElevenlabsTtsKey() {
  return getSecret(ACCOUNT_ELEVENLABS_TTS_KEY);
}
async function setElevenlabsTtsKey(value) {
  return setSecret(ACCOUNT_ELEVENLABS_TTS_KEY, value);
}
async function clearElevenlabsTtsKey() {
  return deleteSecret(ACCOUNT_ELEVENLABS_TTS_KEY);
}

// v1.21：getGithubPat / getYoutubeApiKey 一并删除——
//   GitHub Token 统一走 getOauthToken('github')（发布链路已全部改读该路径）；
//   YouTube Data API Key 改由环境变量 ROKIT_YOUTUBE_API_KEY 提供。
//   两个旧槽位（github-pat / youtube-api-key）的读写仅供 purgeLegacySecretSlots
//   一次性清理使用，内部直接调 getSecret / deleteSecret，不再对外暴露。

// 一次性明文迁移：把 store.settings.api_key 写入凭据管理器后清空 SQLite 字段
// 返回 { migrated: boolean, reason?: string }
async function migratePlaintextApiKey(store) {
  if (!store) return { migrated: false, reason: 'no-store' };
  const current = store.getSettings ? store.getSettings() : null;
  const plaintext = current && current.api_key ? String(current.api_key) : '';
  if (!plaintext) return { migrated: false, reason: 'no-plaintext-key' };
  // 先看凭据管理器里是否已有（避免覆盖用户已有的加密 Key）
  const existing = await getApiKey();
  if (existing && existing === plaintext) {
    // 同值，直接清空 SQLite 字段即可
    store.clearPlaintextApiKey && store.clearPlaintextApiKey();
    return { migrated: true, reason: 'already-in-keytar' };
  }
  await setApiKey(plaintext);
  store.clearPlaintextApiKey && store.clearPlaintextApiKey();
  logger.info('[secrets] API Key 已迁移到 OS 凭据管理器，SQLite 字段已清空');
  return { migrated: true };
}

// v1.21 一次性清理：迁移并删除旧版的独立凭据槽位。
//   背景：GitHub Token 已改由 oauth:save-credential 统一写入 oauth-github record，
//         YouTube 改用 Google 官方 OAuth —— 设置页不再有这两个独立输入框，
//         因此 ACCOUNT_GITHUB_PAT / ACCOUNT_YOUTUBE_API_KEY 槽位成为遗留数据。
//   安全约束：**绝不能直接删 github-pat**。老用户可能从未走过 OAuth 绑定，
//         该槽位里的 PAT 是其唯一可用的 GitHub 凭据（github:put-file 与
//         连通性测试都把它当兜底）。所以先迁移进 oauth-github 再删。
//   幂等：迁移后 oauth-github 记录存在，下次启动直接走"已有"分支删槽位，无副作用。
//   返回 { githubPat: 'migrated'|'dropped'|'absent', youtubeApiKey: 'dropped'|'absent' }
async function purgeLegacySecretSlots() {
  const result = { githubPat: 'absent', youtubeApiKey: 'absent' };

  // --- GitHub PAT 槽位 ---
  try {
    const legacyPat = await getSecret(ACCOUNT_GITHUB_PAT);
    if (legacyPat) {
      const existing = await getOauthToken('github');
      if (existing && existing.access_token) {
        // 已有 oauth-github 记录，PAT 槽位纯属冗余，直接删
        await deleteSecret(ACCOUNT_GITHUB_PAT);
        result.githubPat = 'dropped';
      } else {
        // 老用户从未绑定过 oauth：把 PAT 搬进 oauth-github，避免发布功能失效。
        // token_type 用 'pat' 以示来源；account 留空——真实账号信息需联网调 /user
        // 才能拿到，这里不做同步网络请求，交由用户在设置页「更换 Token」时补全。
        await setOauthToken('github', {
          access_token: legacyPat,
          refresh_token: null,
          token_type: 'pat',
          scope: '',
          expires_at: null,
          account: null,
          migrated_from: 'github-pat'
        });
        await deleteSecret(ACCOUNT_GITHUB_PAT);
        result.githubPat = 'migrated';
      }
      logger.info('[secrets] legacy github-pat slot purged', { action: result.githubPat });
    }
  } catch (e) {
    logger.warn('[secrets] 清理 github-pat 槽位失败', { error: String(e && e.message || e) });
  }

  // --- YouTube Data API Key 槽位 ---
  // 播放量统计已支持环境变量 ROKIT_YOUTUBE_API_KEY 兜底（见 main.js resolveYoutubeApiKey），
  // 且 oauth-youtube（Google 官方授权）不读这个槽位，直接删安全。
  try {
    const legacyKey = await getSecret(ACCOUNT_YOUTUBE_API_KEY);
    if (legacyKey) {
      await deleteSecret(ACCOUNT_YOUTUBE_API_KEY);
      result.youtubeApiKey = 'dropped';
      logger.info('[secrets] legacy youtube-api-key slot purged');
    }
  } catch (e) {
    logger.warn('[secrets] 清理 youtube-api-key 槽位失败', { error: String(e && e.message || e) });
  }

  return result;
}

// ---------- 第三方平台 OAuth Token ----------
// account 前缀：oauth-<providerId>（如 oauth-github）。存的是 JSON 字符串，
// 内含 {access_token, refresh_token, expires_at, scope, token_type, account, connected_at}
// 严禁在任何日志里打印 access_token / refresh_token / client_secret。

const OAUTH_ACCOUNT_PREFIX = 'oauth-';

function oauthAccount(providerId) {
  if (!providerId) throw new Error('providerId required');
  // 防注入：只允许 [a-z0-9_-]
  if (!/^[a-z0-9_-]+$/i.test(providerId)) throw new Error('invalid providerId');
  return OAUTH_ACCOUNT_PREFIX + providerId;
}

async function setOauthToken(providerId, data) {
  if (!data || !data.access_token) {
    throw new Error('access_token required');
  }
  const account = oauthAccount(providerId);
  const record = Object.assign({}, data, { connected_at: new Date().toISOString() });
  const value = JSON.stringify(record);
  if (keytar) {
    try {
      await keytar.setPassword(SERVICE, account, value);
      return true;
    } catch (e) {
      logger.warn('[secrets] keytar.setPassword(oauth) 失败，降级为内存', { providerId, error: String(e && e.message || e) });
    }
  }
  // 降级：仅内存（重启即丢）
  cache[account] = value;
  return false; // false = 未真正持久化
}

async function getOauthToken(providerId) {
  const account = oauthAccount(providerId);
  // 优先用 keytar 拿最新；再退到内存缓存
  let raw = cache[account] || null;
  if (keytar) {
    try {
      const v = await keytar.getPassword(SERVICE, account);
      if (v != null) { raw = v; cache[account] = v; }
    } catch (e) {
      logger.warn('[secrets] keytar.getPassword(oauth) 失败', { providerId, error: String(e && e.message || e) });
    }
  }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

async function clearOauthToken(providerId) {
  const account = oauthAccount(providerId);
  cache[account] = null;
  if (keytar) {
    try { await keytar.deletePassword(SERVICE, account); } catch (_e) { /* 不存在则忽略 */ }
  }
  return true;
}

// 列出已连接的平台 ID（仅前缀 oauth- 的 account）
async function listOauthProviders() {
  const out = [];
  if (keytar) {
    try {
      const creds = await keytar.findCredentials(SERVICE);
      for (const c of creds || []) {
        if (c && c.account && c.account.indexOf(OAUTH_ACCOUNT_PREFIX) === 0) {
          out.push(c.account.slice(OAUTH_ACCOUNT_PREFIX.length));
        }
      }
      return out;
    } catch (e) {
      logger.warn('[secrets] keytar.findCredentials 失败', { error: String(e && e.message || e) });
    }
  }
  // 降级走内存 cache
  for (const k of Object.keys(cache)) {
    if (k.indexOf(OAUTH_ACCOUNT_PREFIX) === 0) out.push(k.slice(OAUTH_ACCOUNT_PREFIX.length));
  }
  return out;
}

module.exports = {
  // 通用
  setSecret,
  getSecret,
  deleteSecret,
  hasNative,
  // API Key
  getApiKey,
  setApiKey,
  clearApiKey,
  // v1.21：线上语音引擎凭据
  getOpenaiTtsKey,
  setOpenaiTtsKey,
  clearOpenaiTtsKey,
  getElevenlabsTtsKey,
  setElevenlabsTtsKey,
  clearElevenlabsTtsKey,
  // OAuth Token（Phase 1：GitHub）
  setOauthToken,
  getOauthToken,
  clearOauthToken,
  listOauthProviders,
  // 迁移
  migratePlaintextApiKey,
  purgeLegacySecretSlots,
  // 调试 / 测试
  _cache: cache,
  _keytarError: () => keytarLoadError
};