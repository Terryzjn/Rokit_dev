// Rokit · OAuth provider 注册表（Phase 1：GitHub；Phase 2：YouTube）
// 每个 provider 含：端点 / 客户端凭据 / scope / 是否启用 PKCE / 账号信息映射
//
// 凭据加载规则（**应用级开发者凭据，不是用户私钥**）：
//   1. Google OAuth（YouTube）：electron/config/youtube-oauth.local.js（开发者本地覆盖；已 gitignore）
//      —— 配置加载器：electron/config/youtube-oauth.js loadConfig()
//      —— 备选：环境变量 ROKIT_YOUTUBE_CLIENT_ID / ROKIT_YOUTUBE_CLIENT_SECRET（CI / 自动化）
//      —— 兜底：electron/config/youtube-oauth.example.js（占位，clientId/secret 为空字符串）
//      —— **仅在 Electron Main Process 被 require；Renderer / preload / contextBridge 永远拿不到 client_secret**
//   2. GitHub：仅支持环境变量（公开 client + PKCE，不需要 secret）
//
// 日志严禁打印 access_token / refresh_token / client_secret；
// 配置加载器仅暴露 boolean / source / clientIdMask 用于诊断。
'use strict';

// YouTube OAuth 应用级凭据加载器（仅 Main 可见）
const youtubeOAuthConfig = require('./config/youtube-oauth');

function envClient(providerId) {
  return process.env['ROKIT_OAUTH_CLIENT_' + providerId.toUpperCase()] || '';
}
function envSecret(providerId) {
  return process.env['ROKIT_OAUTH_SECRET_' + providerId.toUpperCase()] || '';
}

// 取 youtube 的 clientId / clientSecret：从应用配置加载器读取
function youtubeCredentials() {
  const cfg = youtubeOAuthConfig.loadConfig();
  // 失败 / 未配置时 loadConfig() 会设置 .error；这里原样透传给调用方用于诊断
  return {
    clientId: cfg.clientId || '',
    clientSecret: cfg.clientSecret || '',
    source: cfg.source || 'none',
    configured: !!cfg.configured,
    error: cfg.error || ''
  };
}

// ---------- GitHub ----------
// 注册地址（用户自行注册一个 OAuth App）：
//   https://github.com/settings/applications/new
//   Authorization callback URL：http://127.0.0.1:0/oauth-callback（任意空闲端口均可）
//   Client ID 写到环境变量 ROKIT_OAUTH_CLIENT_GITHUB；公开 client + PKCE 不需要 secret。
const github = {
  id: 'github',
  name: 'GitHub',
  // OAuth 2.0 standard endpoints
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  callbackPath: '/oauth-callback',
  // 用户信息（用 access_token 拉）
  accountUrl: 'https://api.github.com/user',
  accountIdField: 'id',
  accountLoginField: 'login',
  accountNameField: 'name',
  accountAvatarField: 'avatar_url',
  // 默认 scope：repo（创建 release / 写仓库）+ read:user（取账号信息）
  defaultScopes: ['repo', 'read:user'],
  // 总是显示同意页，避免复用旧 token
  extraAuthParams: { allow_signup: 'true' },
  // 公开 client + PKCE，不要求 client_secret
  requireClientSecret: false,
  // 强制 PKCE
  usePKCE: true,
  // GitHub 默认不返回 refresh_token；vibed token 不过期，只刷新一次
  supportsRefresh: false
};

// ---------- YouTube / Google ----------
// 配置位置：Google Cloud Console → APIs & Services → Credentials → Create OAuth Client
//   Application type: Desktop app（公开 client + PKCE，不需要 client_secret）
//   Authorized redirect URIs（每个用户启动时拿到的随机端口不同，Google 接受范围通配）：
//     推荐注册为 http://127.0.0.1/oauth2callback（实际端口由 loopback 动态注入）
//   Client ID 在「推广渠道 → YouTube 卡片」填写并自动走 safeStorage；env 仍可作为 CI 覆盖
//
// 启用 API：APIs & Services → Library → YouTube Data API v3 → Enable
//
// Scope 选择（最小权限）：
//   - youtube.upload    后续上传视频用（本阶段不实际使用，但申请以备用）
//   - youtube.readonly  用于读取 channels.list?mine=true 获取频道元信息
const youtube = {
  id: 'youtube',
  name: 'YouTube',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  callbackPath: '/oauth2callback', // Google Desktop OAuth 约定路径
  // 频道信息（用 access_token 拉 channels.list?mine=true）
  accountUrl: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
  // YouTube 的 channel 资源结构是 items[0].snippet；用 parser 自定义解析（见 oauth.js）
  accountParser: 'youtube',
  accountIdField: 'id',
  accountLoginField: 'snippet.title', // 频道名
  accountNameField: 'snippet.title',
  accountAvatarField: 'snippet.thumbnails.default.url',
  defaultScopes: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly'
  ],
  // 关键参数：access_type=offline 让 Google 返回 refresh_token；
  //           prompt=consent 强制每次都显示同意页（确保 refresh_token 一定被颁发）
  extraAuthParams: {
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent'
  },
  // 注意：即使 PKCE 能让 Google 允许 public client（不需要 client_secret），
  //       但 Google Cloud Console 默认创建的 "Desktop app" OAuth Client
  //       在启用 client_secret 后会变成 confidential client —— 此时
  //       token endpoint 强制校验 client_secret，缺失则 400 invalid_request。
  //       因此本项目保留 clientSecret 字段：YouTube 用户必须在卡片里填上 Client Secret。
  requireClientSecret: false,
  usePKCE: true,
  supportsRefresh: true,
  // refresh_token 失效时希望 UI 提示文案
  humanLabel: 'YouTube 账号'
};

function getProvider(providerId) {
  if (providerId === 'github') {
    return Object.assign({}, github, {
      clientId: envClient('github'),
      clientSecret: envSecret('github')
    });
  }
  if (providerId === 'youtube') {
    const creds = youtubeCredentials();
    return Object.assign({}, youtube, {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      __credentialsSource: creds.source,        // 给 oauth.js 打诊断日志用
      __credentialsConfigured: creds.configured, // 是否真正配置了凭据
      __credentialsError: creds.error || ''      // 加载失败时的明确错误（开发诊断用）
    });
  }
  return null;
}

function listProviders() {
  return ['github', 'youtube'];
}

module.exports = { getProvider, listProviders };