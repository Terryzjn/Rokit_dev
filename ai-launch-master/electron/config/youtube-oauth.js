'use strict';
// Rokit · YouTube / Google OAuth 应用配置 — **仅 Main Process 可见**的 loader
//
// 这个文件是 OAuth 模块读 Client ID / Client Secret 的**唯一**入口。
// Renderer / preload / index.html **永远拿不到** ClientSecret ——
// 因为这个 loader 只在 Electron Main 进程被 require，
// 不暴露任何 IPC，DOM 中也不显示。
//
// 配置来源优先级：
//   1. electron/config/youtube-oauth.local.js   （本地覆盖；开发阶段首选；已 gitignore）
//   2. 环境变量 ROKIT_YOUTUBE_CLIENT_ID / ROKIT_YOUTUBE_CLIENT_SECRET  （CI / 自动化）
//   3. electron/config/youtube-oauth.example.js  （占位，clientId/clientSecret 为空字符串）
//
// 设计依据：
//   - Client ID 和 Client Secret 是**应用级开发者凭据**，不是用户私钥
//   - 不应当让最终用户在 UI 里输入；也不应当每次都走 safeStorage 加密
//   - 真实值由开发者填到 youtube-oauth.local.js，打包时不会进 asar（已 gitignore）
//     —— 实际部署用 .env 或 electron-builder extraResources 把 local.js 放到 app 目录
//
// 安全约束：
//   - 严禁 IPC / contextBridge 导出本模块
//   - 严禁 console.log 真实 clientSecret（仅日志 boolean + clientIdMask）
//   - 严禁把 clientSecret 写进 electron-store / SQLite

const fs = require('fs');
const path = require('path');

const LOCAL_FILENAME = 'youtube-oauth.local.js';
const EXAMPLE_FILENAME = 'youtube-oauth.example.js';

let _cache = null; // { clientId, clientSecret, source, error }

/** 安全地清掉 local.js 的 require 缓存（开发时修改后无需重启进程） */
function _tryClearRequireCache(filepath) {
  try { delete require.cache[require.resolve(filepath)]; } catch (_e) {}
}

/** 读取指定文件并返回 normalized config。文件不存在 / require 失败返回 null。 */
function _loadFromFile(filepath) {
  if (!filepath || !fs.existsSync(filepath)) return null;
  try {
    const mod = require(filepath);
    const cfg = (mod && mod.youtube) ? mod.youtube : mod;
    if (!cfg || typeof cfg !== 'object') return null;
    return {
      clientId: String(cfg.clientId || '').trim(),
      clientSecret: String(cfg.clientSecret || '').trim()
    };
  } catch (e) {
    return { __loadError: String(e && e.message || e) };
  }
}

function _loadFromEnv() {
  const id = String(process.env.ROKIT_YOUTUBE_CLIENT_ID || '').trim();
  const secret = String(process.env.ROKIT_YOUTUBE_CLIENT_SECRET || '').trim();
  if (!id || !secret) return null;
  return { clientId: id, clientSecret: secret };
}

/**
 * 同步读取 YouTube OAuth 客户端凭据。
 * @returns {{clientId:string, clientSecret:string, source:('local'|'env'|'example'|'none'), error?:string, configured:boolean}}
 */
function loadConfig() {
  if (_cache) return _cache;

  // 1. local.js（开发者本地覆盖）
  const localPath = path.join(__dirname, LOCAL_FILENAME);
  const localCfg = _loadFromFile(localPath);
  if (localCfg && !localCfg.__loadError && localCfg.clientId && localCfg.clientSecret) {
    _cache = Object.assign({}, localCfg, { source: 'local', configured: true });
    return _cache;
  }
  if (localCfg && localCfg.__loadError) {
    // local.js 存在但 require 失败：明确告知开发者，避免静默 fallback
    _cache = {
      clientId: '', clientSecret: '', source: 'none', configured: false,
      error: 'youtube-oauth.local.js 存在但加载失败：' + localCfg.__loadError
    };
    return _cache;
  }

  // 2. 环境变量（CI / 自动化部署）
  const envCfg = _loadFromEnv();
  if (envCfg && envCfg.clientId && envCfg.clientSecret) {
    _cache = Object.assign({}, envCfg, { source: 'env', configured: true });
    return _cache;
  }

  // 3. example.js 占位（必然存在的兜底，保证 require 不报错）
  const examplePath = path.join(__dirname, EXAMPLE_FILENAME);
  const exampleCfg = _loadFromFile(examplePath);
  if (exampleCfg && !exampleCfg.__loadError) {
    _cache = {
      clientId: exampleCfg.clientId || '',
      clientSecret: exampleCfg.clientSecret || '',
      source: 'example',
      configured: !!(exampleCfg.clientId && exampleCfg.clientSecret),
      error: (exampleCfg.clientId && exampleCfg.clientSecret)
        ? undefined
        : 'YouTube OAuth 凭据未配置：请创建 electron/config/youtube-oauth.local.js 并填入真实 Client ID / Client Secret（模板见 youtube-oauth.example.js）。'
    };
    return _cache;
  }
  if (exampleCfg && exampleCfg.__loadError) {
    _cache = {
      clientId: '', clientSecret: '', source: 'none', configured: false,
      error: 'youtube-oauth.example.js 加载失败：' + exampleCfg.__loadError
    };
    return _cache;
  }

  // 4. 极端兜底（连 example.js 都不存在 —— 不应该发生）
  _cache = { clientId: '', clientSecret: '', source: 'none', configured: false };
  return _cache;
}

/**
 * 重置缓存（开发者修改 local.js 后调一次，让下次 loadConfig() 重读）。
 * 仅在 Main 进程内调用。
 */
function reload() {
  _tryClearRequireCache(path.join(__dirname, LOCAL_FILENAME));
  _tryClearRequireCache(path.join(__dirname, EXAMPLE_FILENAME));
  _cache = null;
  return loadConfig();
}

// ===== 仅诊断用的脱敏函数 =====
/** 把 clientId 输出成 '前 6 + *** + 后 4 + 长度' 形式，绝不输出 client_secret */
function maskClientId(cid) {
  if (!cid) return '';
  const s = String(cid);
  if (s.length <= 10) return s.length <= 4 ? '***' : (s.slice(0, 2) + '***' + s.slice(-2) + '(' + s.length + ')');
  return s.slice(0, 6) + '***' + s.slice(-4) + '(' + s.length + ')';
}

module.exports = {
  loadConfig,
  reload,
  maskClientId,
  // 文件名常量（暴露给 electron-builder 配置 / 文档使用）
  __LOCAL_FILENAME: LOCAL_FILENAME,
  __EXAMPLE_FILENAME: EXAMPLE_FILENAME
};