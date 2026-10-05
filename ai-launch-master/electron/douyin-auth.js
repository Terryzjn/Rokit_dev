'use strict';
// Rokit · 抖音开放平台 OAuth 2.0 授权（PC 端扫码模式）
//
// 实现策略：
//   1. 在 BrowserWindow 中加载抖音授权页 https://open.douyin.com/platform/oauth/connect/
//   2. 监听窗口导航事件，识别回调 URL（含 redirect_uri 前缀）
//   3. 解析出 code → 用 clientKey + clientSecret 换 access_token / refresh_token
//   4. 保存到 douyin-credentials，加载成功页面，1s 后关闭
//
// 关键设计：
//   - redirectUri 解析为独立函数 extractRedirectUrl()，便于后续切换方案（spec 要求）
//   - 默认 redirect_uri 用的是 https://www.example.com 这种假回调 —— 抖音 PC 端扫码模式
//     不依赖 loopback，需要用户**复制 redirect_uri 到授权后的回调 URL 解析 code**
//   - 如果用户已经配置了真实的回调域名（如自有网站），可改用 startAuthFlowWithRedirectUri()

const { BrowserWindow } = require('electron');
const credentials = require('./douyin-credentials');
const tokenManager = require('./douyin-token-manager');

const AUTHORIZE_ENDPOINT = 'https://open.douyin.com/platform/oauth/connect/';
const ACCESS_TOKEN_ENDPOINT = 'https://open.douyin.com/oauth/access_token/';

// 抖音 PC 端扫码模式的官方默认 redirect_uri（不可变的占位）
// 用户在抖音开放平台「授权回调页」配置同样值才能通过校验
const DEFAULT_REDIRECT_URI = 'https://www.example.com/';

// 抽象出 redirect_uri 解析函数，便于后续切换实现方案
// 默认是抖音官方推荐的占位回调页；如果用户配置了自有回调域名，可以替换为：
//   1. 真实回调地址（如 https://myapp.com/douyin/callback）
//   2. 自建 loopback HTTP server（与 GitHub OAuth 相同的 oauth-loopback.js 模式）
function extractRedirectUrl() {
  return DEFAULT_REDIRECT_URI;
}

// 从 URL 提取 code（回调命中后调用）
function extractCodeFromUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('code');
  } catch (_e) {
    return null;
  }
}

// HTML 渲染：授权成功 / 失败 / 取消
function createResultPage(kind, title, body) {
  const color = kind === 'success' ? '#2E8B33' : '#C0392B';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
    <title>${title}</title>
    <style>
      body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
             padding: 40px; text-align: center; background: #f7f7f7; margin: 0; }
      .card { background: #fff; border-radius: 12px; padding: 32px;
              box-shadow: 0 2px 12px rgba(0,0,0,0.06); max-width: 480px; margin: 60px auto; }
      h1 { color: ${color}; font-size: 22px; margin: 0 0 12px; }
      p { color: #555; line-height: 1.6; margin: 8px 0; }
    </style></head><body><div class="card">
      <h1>${title}</h1>
      <p>${body}</p>
      <p style="color:#888;font-size:13px;margin-top:20px">本窗口将在 1 秒后自动关闭。</p>
    </div>
    <script>setTimeout(function(){window.close()}, 1000);</script>
    </body></html>`;
}

// 把授权 code 换 access_token
async function exchangeCodeForToken(clientKey, clientSecret, code) {
  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    code: code,
    grant_type: 'authorization_code'
  }).toString();
  const resp = await fetch(ACCESS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Rokit/1.0' },
    body
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data) {
    throw new Error('HTTP_ERROR: access_token 换取接口 HTTP ' + resp.status);
  }
  if (data.error_code !== undefined && data.error_code !== 0) {
    const Err = tokenManager.DouyinApiError;
    throw new Err(data.error_code, data.message || '换取 access_token 失败');
  }
  if (!data.access_token) {
    throw new Error('抖音未返回 access_token，请检查抖音开放平台的 client_key / client_secret 配置');
  }
  return data;
}

// 核心授权流程
async function startAuthFlowInternal() {
  const creds = await credentials.loadCredentials();
  if (!creds) {
    return { success: false, error: 'NO_CREDENTIALS: 请先在设置中配置 clientKey / clientSecret' };
  }
  const state = require('crypto').randomBytes(16).toString('hex');
  const redirectUri = extractRedirectUrl();

  const authUrl = new URL(AUTHORIZE_ENDPOINT);
  authUrl.searchParams.set('client_key', creds.clientKey);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'user_info,video.publish');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);

  const logger = require('./logger');
  logger.info('[douyin-auth] auth flow start', {
    clientKeyMask: credentials.mask(creds.clientKey),
    statePrefix: state.slice(0, 8),
    redirectHost: (() => { try { return new URL(redirectUri).host; } catch (_e) { return 'invalid'; } })()
  });

  return new Promise((resolve) => {
    let resolved = false;
    const win = new BrowserWindow({
      width: 880,
      height: 720,
      title: '抖音账号授权',
      parent: undefined,    // 不强制 parent，避免模态阻塞
      modal: false,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,        // 安全要求：禁用 node 集成
        contextIsolation: true,        // 安全要求：contextIsolation 开启
        sandbox: true,                 // 多一层沙箱
        // 注意：抖音授权页是第三方域，不需要 preload 脚本
        // 不要使用 remote 模块（spec 安全要求）
        webSecurity: true
      }
    });

    function done(result) {
      if (resolved) return;
      resolved = true;
      try { if (!win.isDestroyed()) win.close(); } catch (_e) {}
      resolve(result);
    }

    // 用户手动关闭窗口 → USER_CANCELLED
    win.on('closed', () => {
      if (!resolved) {
        resolved = true;
        resolve({ success: false, error: 'USER_CANCELLED' });
      }
    });

    // 监听导航：命中 redirect_uri 前缀 → 解析 code → 换 token
    function handleNavigation(targetUrl) {
      if (!targetUrl) return;
      let parsed;
      try { parsed = new URL(targetUrl); } catch (_e) { return; }
      // 比对 host + path 前缀（兼容 ?code= 与 /?code= 形式）
      const basePrefix = redirectUri.replace(/\/$/, '');
      if (targetUrl === redirectUri || targetUrl.startsWith(basePrefix + '?') || targetUrl.startsWith(basePrefix + '/?') || targetUrl.startsWith(basePrefix + '#')) {
        const code = parsed.searchParams.get('code');
        const errParam = parsed.searchParams.get('error');
        if (errParam) {
          logger.warn('[douyin-auth] provider returned error', { error: errParam });
          win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(createResultPage('error', '授权失败', '抖音拒绝授权：' + errParam)));
          setTimeout(() => done({ success: false, error: 'PROVIDER_ERROR:' + errParam }), 1200);
          return;
        }
        if (!code) {
          win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(createResultPage('error', '回调异常', '回调 URL 中没有 code 参数')));
          setTimeout(() => done({ success: false, error: 'NO_CODE_IN_CALLBACK' }), 1200);
          return;
        }
        // 立即在窗口里展示「授权成功」页（不要让用户继续操作授权页）
        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(createResultPage('success', '授权成功', '正在关闭...')));
        // 异步换 token + 关闭窗口
        (async () => {
          try {
            const token = await exchangeCodeForToken(creds.clientKey, creds.clientSecret, code);
            const now = Date.now();
            const session = {
              openId: token.open_id,
              accessToken: token.access_token,
              refreshToken: token.refresh_token,
              accessTokenExpiresAt: now + (token.expires_in || 15 * 24 * 3600) * 1000,
              refreshTokenExpiresAt: now + (token.refresh_expires_in || 30 * 24 * 3600) * 1000,
              scope: token.scope ? String(token.scope).split(',') : ['user_info', 'video.publish'],
              savedAt: new Date().toISOString()
            };
            await credentials.saveSession(session);
            logger.info('[douyin-auth] auth flow success', { openId: session.openId });
            done({ success: true, session });
          } catch (e) {
            const msg = e && e.description ? e.description : (e && e.message || String(e));
            logger.warn('[douyin-auth] token exchange failed', { error: String(e && e.message || e) });
            done({ success: false, error: msg });
          }
        })();
      }
    }

    // will-redirect 在导航发生前触发，did-finish-load 在加载完成后触发 —— 两个都监听确保不漏
    win.webContents.on('will-navigate', (e, url) => {
      // 不拦截，让浏览器按抖音的逻辑跳转
    });
    win.webContents.on('will-redirect', (e, url) => {
      e.preventDefault();
      handleNavigation(url);
    });
    win.webContents.on('did-redirect-navigation', (e, url) => {
      handleNavigation(url);
    });
    win.webContents.on('did-navigate', (e, url) => {
      handleNavigation(url);
    });

    win.loadURL(authUrl.toString()).catch((e) => {
      done({ success: false, error: 'LOAD_URL_FAILED: ' + (e && e.message || e) });
    });
  });
}

/**
 * 启动授权流程；返回 Promise<{ success, session?, error? }>
 * @returns {Promise<{success:boolean, session?:object, error?:string}>}
 */
async function startAuthFlow() {
  return startAuthFlowInternal();
}

module.exports = {
  startAuthFlow,
  // 便于测试 / 后续切换方案
  extractRedirectUrl,
  extractCodeFromUrl,
  DEFAULT_REDIRECT_URI
};