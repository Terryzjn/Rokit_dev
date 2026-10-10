// Rokit · OAuth 主流程（Phase 1：GitHub）
// 负责：构造 authorize URL → 启动 loopback → 等回调 → 换 token → 取账号信息 → 写 keytar
// 错误分类（reason 字段，便于 Renderer 文案）：
//   'missing_client_id'        客户端未配置 client_id
//   'provider_not_found'       未知 provider
//   'user_cancelled'           用户关闭浏览器标签 / 点拒绝
//   'timeout'                  5 分钟内无回调
//   'state_mismatch'           state 与发起时不匹配（CSRF 防护）
//   'token_exchange_failed'    code 换 token 失败（provider 返回非 200）
//   'token_response_invalid'   provider 返回的 JSON 缺 access_token
//   'account_fetch_failed'     已拿到 token 但拉账号信息失败（仍保存 token）
//   'no_native_keytar'         keytar 加载失败，且未走内存兜底（用户需重启）
//
// 日志原则：绝不打印 access_token / refresh_token / client_secret；只打 providerId / state 前 8 位 / 错误码。
'use strict';

const { shell } = require('electron');
const { URLSearchParams } = require('url');

const providers = require('./oauth-providers');
const pkce = require('./oauth-pkce');
const loopback = require('./oauth-loopback');
const secrets = require('./secrets');
const platformContext = require('./platform-context');
const oauthNet = require('./oauth-net');

const logger = (() => {
  try { return require('./logger'); } catch (_e) { return { info() {}, warn() {}, error() {} }; }
})();

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

// 把 token 响应（含 expires_in）转成内部记录
function normalizeToken(providerId, raw) {
  if (!raw || typeof raw !== 'object' || !raw.access_token) {
    return null;
  }
  let expiresAt = null;
  if (typeof raw.expires_in === 'number' && raw.expires_in > 0) {
    expiresAt = Date.now() + raw.expires_in * 1000;
  }
  return {
    access_token: String(raw.access_token),
    refresh_token: raw.refresh_token ? String(raw.refresh_token) : null,
    token_type: raw.token_type ? String(raw.token_type) : 'bearer',
    scope: raw.scope ? String(raw.scope) : '',
    expires_at: expiresAt,
    raw_keys: Object.keys(raw) // 仅记录字段名，便于排错
  };
}

// 拿到 token 后，从 provider.accountUrl 拉账号信息；不阻断主流程
async function fetchAccount(provider, accessToken) {
  if (!provider.accountUrl) return null;
  try {
    // 不同 provider 的 Accept 头不同：GitHub 走 vnd.github+json；Google 默认 JSON
    const accept = provider.id === 'github' ? 'application/vnd.github+json' : 'application/json';
    // 用 googleOAuthFetch 让 YouTube 的 accountUrl（www.googleapis.com）走强制 IPv4 路径；
    // GitHub 等非 Google host 自动 fallback 到原生 fetch（oauth-net 不修改其它请求）。
    const resp = await oauthNet.googleOAuthFetch(provider.accountUrl, {
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Accept': accept,
        'User-Agent': 'Rokit-OAuth/1.0'
      }
    });
    if (!resp.ok) {
      logger.warn('[oauth] account fetch failed', { providerId: provider.id, status: resp.status });
      return null;
    }
    const data = await resp.json();
    return parseAccount(provider, data);
  } catch (e) {
    logger.warn('[oauth] account fetch error', {
      providerId: provider.id,
      name: e && e.name,
      message: e && e.message,
      network: oauthNet.extractNetworkError(e)
    });
    return null;
  }
}

// 把 provider 配置化到 account 结构。YouTube channels.list 返回的是 {items:[{id, snippet:{...}}]}
// GitHub /user 是扁平的 {id, login, name, avatar_url}。
function parseAccount(provider, data) {
  if (!data) return null;
  if (provider.accountParser === 'youtube') {
    const item = (data.items && data.items[0]) || null;
    if (!item) return null;
    const snip = item.snippet || {};
    return {
      id: item.id || null,
      login: snip.title || null,         // 频道名当作 login
      name: snip.title || null,
      avatar_url: (snip.thumbnails && (snip.thumbnails.default && snip.thumbnails.default.url)) || null
    };
  }
  // 默认：扁平结构（GitHub 风格）
  return {
    id: provider.accountIdField ? data[provider.accountIdField] : data.id,
    login: provider.accountLoginField ? data[provider.accountLoginField] : (data.login || data.username),
    name: provider.accountNameField ? data[provider.accountNameField] : data.name,
    avatar_url: provider.accountAvatarField ? data[provider.accountAvatarField] : data.avatar_url
  };
}

// 只输出 URL 的 host + path（不含 query / fragment），便于排错又不暴露 code / state。
function safeUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol + '//' + parsed.host + parsed.pathname;
  } catch (_e) { return ''; }
}

// 用 authorization code 换 token
async function exchangeCode(provider, code, codeVerifier) {
  // 诊断日志（不打印真实值，只打 has* 标志）：用于诊断「HTTP 400 invalid_request — client_secret is missing」
  logger.info('[oauth] exchangeCode config check', {
    providerId: provider.id,
    hasClientId: !!provider.clientId,
    hasClientSecret: !!provider.clientSecret,
    hasCode: !!code,
    hasRedirectUri: !!(provider.__redirect_uri),
    hasCodeVerifier: !!(provider.usePKCE && codeVerifier),
    usePKCE: !!provider.usePKCE,
    credentialsSource: provider.__credentialsSource || 'unknown',
    credentialsConfigured: !!provider.__credentialsConfigured,
    credentialsError: provider.__credentialsError || undefined
  });

  // 配置未就绪 → 直接抛错，不向 oauth2.googleapis.com 发请求
  if (!provider.clientId || !provider.clientSecret) {
    const reason = provider.__credentialsError || (
      provider.__credentialsSource === 'none'
        ? 'YouTube OAuth Client 凭据未配置。请创建 electron/config/youtube-oauth.local.js 并填入真实 Client ID / Client Secret（模板见 youtube-oauth.example.js）。'
        : 'YouTube OAuth Client 凭据不完整（clientId / clientSecret 至少有一项为空）。'
    );
    const err = new Error('token_exchange_failed');
    err.detail = reason;
    err.code = 'OAUTH_CONFIG_MISSING';
    throw err;
  }

  const params = new URLSearchParams();
  params.set('client_id', provider.clientId);
  params.set('code', code);
  params.set('redirect_uri', provider.__redirect_uri);
  params.set('grant_type', 'authorization_code');
  if (provider.usePKCE && codeVerifier) {
    params.set('code_verifier', codeVerifier);
  }
  // Google 在 OAuth Client 是 confidential client 时**强制**校验 client_secret
  // （缺失会返回 400 invalid_request）。只要 provider.clientSecret 存在就发送，
  // 不做"安全地删除"这种错误处理。如果为空，上面的诊断日志会暴露出来，
  // 用户需在「推广渠道 → YouTube 卡片」填写 Client ID + Client Secret 后重试。
  if (provider.clientSecret) {
    params.set('client_secret', provider.clientSecret);
  }

  const url = provider.tokenEndpoint;
  const method = 'POST';
  const safeReqUrl = safeUrl(url);

  // 1) 网络层异常：DNS / IPv4 全部 connect timeout / TLS 失败 —— googleOAuthFetch 会抛
  //    带 .network 字段的 Error。区分文案：
  //      A. 网络异常（连接未建立） → "YouTube OAuth 网络连接失败"
  //      B. HTTP 4xx / 5xx（连接已建立） → "YouTube OAuth Token 请求失败"
  //      C. 200 → 继续
  const fetchInit = {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Rokit-OAuth/1.0'
    },
    body: params.toString()
  };
  let resp;
  try {
    resp = await oauthNet.googleOAuthFetch(url, fetchInit);
  } catch (e) {
    // 自动修复尝试：如果是 Windows + 探测到 IE 代理但 WinHTTP 是 direct，
    // 调一次 netsh winhttp import proxy source=ie 让 Node 走系统代理，然后重试。
    // 这是"浏览器能开 Google、Node 不能"的典型修复。
    const fix = await oauthNet.tryAutoFixAndRetry(url, fetchInit).catch(() => null);
    if (fix && fix.fixed && fix.response) {
      resp = fix.response;
      logger.warn('[oauth] token exchange succeeded after auto-fix (WinHTTP proxy imported from IE)', {
        providerId: provider.id,
        fixReason: fix.reason
      });
    } else {
      // googleOAuthFetch / pickReachableIPv4 抛出的错误已经带 .network / .detail / .attempts
      const network = e && e.network ? e.network : oauthNet.extractNetworkError(e);
      const attempts = e && e.attempts ? e.attempts : null;
      logger.error('[oauth] token exchange network error', {
        providerId: provider.id,
        url: safeReqUrl,
        method,
        topLevelName: e && e.name,
        topLevelMessage: e && e.message,
        network,
        attempts: attempts ? attempts.map((a) => ({ ip: a.ip, code: a.network && a.network.code })) : null,
        autoFixAttempt: fix ? fix.reason : 'no_attempt'
      });
      const err = new Error('token_exchange_failed');
      // 文案明确：未建立连接 → "YouTube OAuth 网络连接失败"
      let humanDetail = 'YouTube OAuth 网络连接失败：' + (e && e.detail || e && e.message || 'unknown');
      if (network && network.code) humanDetail += '（code=' + network.code + '）';
      if (attempts && attempts.length) {
        const codes = attempts.map((a) => a.network && a.network.code).filter(Boolean);
        if (codes.length && !humanDetail.includes(codes[0])) {
          humanDetail += '，尝试过的 IPv4 地址：' + attempts.map((a) => a.ip + '(' + (a.network && a.network.code || 'fail') + ')').join(', ');
        }
      }
      // 追加 actionable 提示：诊断/代理配置
      if (fix && fix.reason === 'no_ie_proxy_enabled') {
        humanDetail += '。当前电脑未配置 Windows 系统代理（IE 代理未启用）。如使用 Clash / V2Ray / sing-box，请把代理切换到「系统代理」或「TUN 模式」，或在启动 Rokit 前设置 HTTPS_PROXY 环境变量。';
      } else if (fix && fix.reason === 'netsh_import_failed') {
        humanDetail += '。已尝试自动启用 WinHTTP 系统代理（netsh winhttp import proxy source=ie）但失败（' + (fix.detail || '').slice(0, 100) + '）。请以管理员权限运行 Rokit，或手动在 PowerShell 执行：netsh winhttp import proxy source=ie';
      } else if (fix && fix.reason === 'retry_still_failed') {
        humanDetail += '。已自动启用 WinHTTP 系统代理但仍无法连接，请确认代理软件（TUN / 系统代理）已运行并允许该端口出站。';
      }
      err.detail = humanDetail;
      err.network = network;
      err.attempts = attempts;
      err.endpoint = safeReqUrl;
      err.method = method;
      err.autoFixAttempt = fix ? fix.reason : 'no_attempt';
      throw err;
    }
  }

  // 2) HTTP 层异常：Google 在参数错（redirect_uri / code_verifier / 已用过的 code 等）时返回
  //    4xx + JSON { error, error_description }；GitHub 可能 200 + { error: ... }。
  //    把 Google 返回的 error / error_description 一并保留在 err.http 便于上层展示。
  if (!resp.ok) {
    let body = '';
    try { body = await resp.text(); } catch (_e) {}
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (_e) {}
    const googleError = parsed && typeof parsed.error === 'string' ? parsed.error : '';
    const googleErrorDesc = parsed && typeof parsed.error_description === 'string'
      ? parsed.error_description : '';
    // 极少数情况下 provider 用非 JSON body（如 HTML / 空），把 statusText 也带上
    const fallbackDesc = parsed ? '' : (body || resp.statusText || '').slice(0, 200);
    logger.error('[oauth] token exchange HTTP failed', {
      providerId: provider.id,
      url: safeReqUrl,
      method,
      status: resp.status,
      statusText: resp.statusText,
      googleError,
      googleErrorDesc: googleErrorDesc.slice(0, 200),
      bodyPreview: body.slice(0, 200)
    });
    const err = new Error('token_exchange_failed');
    // 文案明确：连接已建立，Google 返回 HTTP 错误 → "YouTube OAuth Token 请求失败"
    let detail = 'YouTube OAuth Token 请求失败：HTTP ' + resp.status + (googleError ? ' ' + googleError : '');
    if (googleErrorDesc) detail += ' — ' + googleErrorDesc;
    else if (fallbackDesc) detail += ' — ' + fallbackDesc;
    err.detail = detail;
    err.http = {
      status: resp.status,
      statusText: resp.statusText,
      googleError,
      googleErrorDesc
    };
    err.endpoint = safeReqUrl;
    err.method = method;
    throw err;
  }

  // 3) 解析 JSON
  let data;
  try { data = await resp.json(); } catch (_e) {
    const err = new Error('token_response_invalid');
    err.detail = '非 JSON 响应：' + ((typeof _e.message === 'string') ? _e.message : 'parse failed');
    throw err;
  }
  return normalizeToken(provider.id, data);
}

// 暴露给 main.js 的 IPC handler
async function start(providerId) {
  const provider = providers.getProvider(providerId);
  if (!provider) return { ok: false, reason: 'provider_not_found' };
  if (!provider.clientId) return { ok: false, reason: 'missing_client_id' };

  // 1) PKCE + state
  const codeVerifier = provider.usePKCE ? pkce.generateVerifier() : null;
  const codeChallenge = codeVerifier ? pkce.challengeFromVerifier(codeVerifier) : null;
  const state = pkce.generateState();

  // 2) loopback
  const cbPath = provider.callbackPath || loopback.CALLBACK_PATH;
  const lb = loopback.createLoopback({ timeoutMs: FLOW_TIMEOUT_MS, callbackPath: cbPath });
  let port;
  try {
    port = await lb.port;
  } catch (e) {
    return { ok: false, reason: 'loopback_listen_failed', detail: String(e && e.message || e) };
  }
  const redirectUri = 'http://127.0.0.1:' + port + cbPath;

  // 3) 构造 authorize URL
  const url = new URL(provider.authorizationEndpoint);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', (provider.defaultScopes || []).join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const k in provider.extraAuthParams || {}) {
    url.searchParams.set(k, provider.extraAuthParams[k]);
  }
  const authUrl = url.toString();

  logger.info('[oauth] flow start', {
    providerId,
    statePrefix: state.slice(0, 8),
    pkce: !!codeChallenge,
    port
  });
  // 注意：authUrl 包含 state / code_challenge 等敏感参数，**只输出长度和 host 前缀**
  logger.info('[oauth] authUrl generated', {
    providerId,
    host: 'accounts.google.com',
    length: authUrl.length,
    startsWith: authUrl.slice(0, 41) + '...'
  });

  // 4) 打开用户默认浏览器
  // 多策略容错：
  //   a. shell.openExternal    —— Electron 官方 API，Promise resolve 即视为成功
  //   b. cmd /c start ""       —— Windows shell start 命令（走 ShellExecute）
  //   c. rundll32 url.dll,FileProtocolHandler —— 走 ShellExecute handler 注册表
  //   d. explorer.exe "url"    —— Explorer 已在运行时由它代为调起
  //   e. 剪贴板兜底             —— 把 URL 复制到剪贴板，UI 提示用户手动粘贴到地址栏
  //
  // 判定方式（v0.1.6 修正）：**只看调用本身是否成功，不再拿浏览器进程数当判据**。
  // 旧实现要求「调度后 1.5s 内浏览器进程数必须增长」才算成功，有两个致命缺陷：
  //   1. 浏览器已经在运行时，新标签页常复用已有进程 → 进程数不变 → 真开成功也被判成失败；
  //   2. tasklist 一旦调用失败（受限令牌 / PATH 不全）会静默返回 0，
  //      调用方无法区分"这次没测出来"和"一个浏览器都没有" → 4 种策略被依次判失败。
  // 后果：浏览器其实已经打开，UI 仍提示"浏览器启动失败，URL 已复制到剪贴板"，
  //       而且 4 种策略会各弹一次，重复打开多个相同标签页。
  const child_process = require('child_process');
  const { clipboard } = require('electron');

  // 仅用于日志观测，**不参与成功判定**。
  // 返回 null 表示"这次测量不可信"（所有查询都失败）；调用方必须把 null 与 0 严格区分开。
  async function countBrowserProcs() {
    return new Promise((resolve) => {
      try {
        // 用 tasklist.exe 数指定浏览器进程数
        // 注意：tasklist 的多个 /FI 是 AND 语义，必须分别查询后相加
        const targets = ['msedge.exe', 'chrome.exe', 'firefox.exe', 'brave.exe'];
        // 绝对路径优先：Electron 是 GUI subsystem，PATH 可能不完整（main.js 里的 whoami 同理）
        const tasklist = process.env.SystemRoot
          ? process.env.SystemRoot + '\\System32\\tasklist.exe'
          : 'tasklist.exe';
        let total = 0;
        let okCount = 0;
        for (const t of targets) {
          const r = child_process.spawnSync(tasklist, [
            '/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq ' + t
          ], {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            encoding: 'utf8'
          });
          if (r.error || r.status !== 0) continue;
          okCount++;
          const out = (r.stdout || '').toString();
          // 没有匹配进程时 tasklist 输出的是本地化提示行（非 CSV），下面的 CSV 行过滤会自然得到 0
          const rows = out.split(/\r?\n/).filter(l => /^"/.test(l.trim()) && /","/.test(l)).length;
          total += rows;
        }
        resolve(okCount === 0 ? null : total);
      } catch (_e) { resolve(null); }
    });
  }

  function spawnDetached(cmd, args, label) {
    try {
      const p = child_process.spawn(cmd, args, {
        detached: true, stdio: 'ignore', windowsHide: true
      });
      p.on('error', (e) => { /* swallow */ });
      p.unref();
      return true;
    } catch (e) {
      logger.warn('[oauth] spawn failed', { cmd: label, error: String(e && e.message || e) });
      return false;
    }
  }

  // 把新打开的浏览器窗口提到最前（best effort；解决"窗口被遮挡/缩到后台"问题）
  // 实现：通过 PowerShell + Win32 SetForegroundWindow 找到包含目标 URL 的窗口并激活
  function focusNewestBrowserWindow() {
    return new Promise((resolve) => {
      try {
        // 用 PowerShell 调用 Win32 API；搜索 msedge/chrome/firefox/brave 顶层窗口，
        // 找标题或 URL 含 google.com 的，SetForegroundWindow
        // 用 tasklist 找出最近 3 秒内创建的浏览器进程（CreationDate），逐一 ShowWindow + SetForegroundWindow
        const psScript = `
          Add-Type @"
            using System;
            using System.Runtime.InteropServices;
            public class Win32 {
              [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
              [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
            }
          "@ -ErrorAction SilentlyContinue;
          $procs = Get-Process -Name msedge,chrome,firefox,brave -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } |
            Sort-Object -Property StartTime -Descending;
          if ($procs) {
            foreach ($p in $procs) {
              [Win32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null;  # SW_RESTORE
              [Win32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;
              break;
            }
          }
        `;
        const p = child_process.spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command', psScript
        ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      } catch (_e) { resolve(); }
    });
  }

  const launchStrategies = [
    {
      name: 'shell.openExternal',
      run: async () => {
        try {
          await shell.openExternal(authUrl);
          // 浏览器进程可能不会自动 focus 到最前（特别是在 elevated 上下文启动时）。
          // 1.5s 后尝试用 PowerShell 找到最新创建的浏览器窗口并 SetForegroundWindow。
          // 这只是 best-effort，失败不影响 OAuth 流程本身。
          setTimeout(() => focusNewestBrowserWindow().catch(() => {}), 1200);
          return { dispatched: true };
        } catch (e) {
          return { dispatched: false, error: e };
        }
      }
    },
    {
      name: 'cmd /c start',
      run: async () => ({ dispatched: spawnDetached('cmd.exe', ['/c', 'start', '""', authUrl], 'cmd /c start') })
    },
    {
      name: 'rundll32 url.dll',
      run: async () => ({ dispatched: spawnDetached('rundll32.exe', ['url.dll,FileProtocolHandler', authUrl], 'rundll32') })
    },
    {
      name: 'explorer.exe',
      run: async () => ({ dispatched: spawnDetached('explorer.exe', [authUrl], 'explorer.exe') })
    }
  ];

  // 判定原则：以「调用本身是否成功」为准。
  // shell.openExternal 的 Promise resolve 即成功（真正失败会 reject）；
  // 只有 reject 时才降级到下一种策略，全部失败才走剪贴板兜底。
  const browserCountBefore = await countBrowserProcs();

  let openedVia = null;
  let lastError = null;

  for (const strat of launchStrategies) {
    const r = await strat.run();
    if (!r.dispatched) {
      lastError = r.error ? String(r.error.message || r.error) : 'unknown';
      logger.warn('[oauth] strategy dispatch failed', { providerId, strategy: strat.name, error: lastError });
      continue;
    }
    openedVia = strat.name;
    logger.info('[oauth] browser launched', { providerId, via: strat.name });
    break;
  }

  // Low 完整性（受限 / 沙箱上下文）下 Windows 会拒绝把 URL 交给已运行的浏览器：
  // msedge.exe 会被启动但立刻退出，ShellExecute 仍返回成功 —— shell.openExternal 会
  // "假成功"（不报错、也不开标签页）。实测：本地 HTTP 服务收不到任何请求；
  // 用独立 user-data-dir 直接起新实例同样无效。所以此处绝不能谎报成功，
  // 必须改走剪贴板兜底，让 UI 如实提示用户手动粘贴（用户自己从任务栏打开的浏览器
  // 是 Medium 完整性，粘贴能正常工作）。
  if (openedVia && platformContext.isRestrictedContext()) {
    logger.warn('[oauth] restricted context (Low integrity): Windows blocks handing the URL to the running browser; falling back to clipboard', { providerId, attempted: openedVia });
    lastError = 'restricted_context_low_integrity';
    openedVia = null;
  }

  if (openedVia) {
    // 仅日志线索：1.5s 后记一次浏览器进程数，便于日后排查。
    // **不参与任何判定**——进程数既受"浏览器是否已在运行 / 新标签是否复用进程"影响，
    // 也曾因 tasklist 调用失败而静默变成 0。这次修正就是把它从判据降级为纯观测。
    setTimeout(() => {
      Promise.resolve(countBrowserProcs()).then((n) => {
        logger.info('[oauth] browser process count (diagnostic only)', {
          providerId,
          via: openedVia,
          procsBefore: browserCountBefore,
          procsAfter: n
        });
      }).catch(() => {});
    }, 1500);
  } else {
    // 兜底：复制 URL 到剪贴板
    // **不立即返回**，继续等 loopback ——用户可能手动粘贴到浏览器完成授权
    let clipboardOk = false;
    try {
      clipboard.writeText(authUrl);
      clipboardOk = true;
      logger.warn('[oauth] all launch strategies failed, auth URL copied to clipboard as fallback; loopback still listening for manual callback', { providerId, lastError: lastError || '' });
    } catch (_e) {
      logger.error('[oauth] all launch strategies failed and clipboard also failed', { providerId });
    }
    if (!clipboardOk) {
      return {
        ok: false,
        reason: 'browser_open_failed',
        detail: '所有启动浏览器策略均失败；剪贴板也不可用，请手动复制授权链接到系统浏览器打开'
      };
    }
    // 标记 renderer：浏览器没打开，但 URL 已复制
    // 继续往下走 loopback —— 用户手动打开并完成 OAuth 后 callback 仍能回来
    openedVia = 'clipboard';
  }
  logger.info('[oauth] browser launch dispatched', { providerId, via: openedVia });

  // 5) 等回调
  const cb = await lb.awaitCallback();
  // awaitCallback finally 已关掉 server

  if (cb.error === 'timeout') {
    logger.warn('[oauth] flow timeout', { providerId });
    return { ok: false, reason: 'timeout' };
  }
  if (cb.error) {
    logger.warn('[oauth] provider returned error', { providerId, error: cb.error });
    return { ok: false, reason: 'user_cancelled', detail: cb.error, description: cb.errorDescription };
  }
  if (cb.state !== state) {
    logger.warn('[oauth] state mismatch', { providerId });
    return { ok: false, reason: 'state_mismatch' };
  }
  if (!cb.code) {
    return { ok: false, reason: 'token_exchange_failed', detail: 'no_code_in_callback' };
  }

  // 6) 换 token
  let tokenRecord;
  try {
    provider.__redirect_uri = redirectUri;
    tokenRecord = await exchangeCode(provider, cb.code, codeVerifier);
  } catch (e) {
    // exchangeCode 已把网络异常 / HTTP 错误分别拼好 detail；这里只补兜底
    const reason = (e && e.message) || 'token_exchange_failed';
    let detail = (e && e.detail) || '';
    if (!detail) {
      if (e && e.network && e.network.message) {
        detail = 'YouTube OAuth 网络连接失败：' + e.network.message +
          (e.network.code ? '（code=' + e.network.code + '）' : '');
      } else if (e && e.message) {
        detail = 'YouTube OAuth Token 请求失败：' + e.message;
      } else {
        detail = 'YouTube OAuth 授权失败';
      }
    }
    logger.error('[oauth] exchangeCode failed', {
      providerId,
      reason,
      detail,
      network: e && e.network,
      http: e && e.http ? { status: e.http.status, googleError: e.http.googleError } : undefined,
      endpoint: e && e.endpoint,
      method: e && e.method
    });
    return { ok: false, reason, detail };
  }
  if (!tokenRecord) {
    return { ok: false, reason: 'token_response_invalid' };
  }

  // 7) 拉账号信息（不阻断）
  const account = await fetchAccount(provider, tokenRecord.access_token);

  // 8) 持久化到 keytar
  const payload = Object.assign({}, tokenRecord, { account });
  const persisted = await secrets.setOauthToken(providerId, payload);
  if (!persisted) {
    return { ok: false, reason: 'no_native_keytar' };
  }

  logger.info('[oauth] flow success', { providerId, hasAccount: !!account });
  return {
    ok: true,
    account,
    scope: tokenRecord.scope,
    expiresAt: tokenRecord.expires_at,
    via: openedVia || null,  // 'shell.openExternal' / 'cmd /c start' / 'rundll32' / 'explorer.exe' / 'clipboard'
    // 受限（Low 完整性）上下文：Windows 会拦截把链接交给浏览器的动作，
    // 此时 via 必然是 'clipboard'，Renderer 据此说明"为什么没能自动弹窗"。
    restricted: platformContext.isRestrictedContext()
  };
}

async function status(providerId) {
  const token = await secrets.getOauthToken(providerId);
  if (!token) return { connected: false };
  return {
    connected: true,
    account: token.account || null,
    scope: token.scope || '',
    expiresAt: token.expires_at || null,
    tokenType: token.token_type || 'bearer',
    connectedAt: token.connected_at || null,
    needsReconnect: !!token.needs_reconnect,
    // v1.10：发布仓库配置（仅 GitHub 有意义；其它 provider 返回 null 即可）
    publishRepo: token.publishRepo || null
  };
}

// 用 refresh_token 换取新 access_token。
// 成功：更新 keytar 中存储的 token 记录（含新 expires_at），返回 {ok:true, access_token}
// 失败（如 invalid_grant）：标记 needs_reconnect=true，Renderer 据此提示重新授权
async function refresh(providerId) {
  const provider = providers.getProvider(providerId);
  if (!provider) return { ok: false, reason: 'provider_not_found' };
  if (!provider.supportsRefresh) return { ok: false, reason: 'refresh_not_supported' };

  const cur = await secrets.getOauthToken(providerId);
  if (!cur || !cur.refresh_token) return { ok: false, reason: 'no_refresh_token' };

  const params = new URLSearchParams();
  params.set('client_id', provider.clientId);
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', cur.refresh_token);
  // 同 exchangeCode：confidential client 必须发送 client_secret
  if (provider.clientSecret) params.set('client_secret', provider.clientSecret);

  logger.info('[oauth] refresh config check', {
    providerId: provider.id,
    hasClientId: !!provider.clientId,
    hasClientSecret: !!provider.clientSecret,
    hasRefreshToken: !!cur.refresh_token,
    credentialsSource: provider.__credentialsSource || 'unknown',
    credentialsConfigured: !!provider.__credentialsConfigured,
    credentialsError: provider.__credentialsError || undefined
  });

  // 同 exchangeCode：未配置时不向 oauth2.googleapis.com 发请求
  if (!provider.clientId || !provider.clientSecret) {
    const err = new Error('refresh_failed');
    err.detail = provider.__credentialsError || 'YouTube OAuth Client 凭据未配置，无法 refresh token。';
    err.code = 'OAUTH_CONFIG_MISSING';
    throw err;
  }

  const refreshInit = {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Rokit-OAuth/1.0'
    },
    body: params.toString()
  };
  let resp;
  try {
    resp = await oauthNet.googleOAuthFetch(provider.tokenEndpoint, refreshInit);
  } catch (e) {
    // 自动修复尝试：同 exchangeCode
    const fix = await oauthNet.tryAutoFixAndRetry(provider.tokenEndpoint, refreshInit).catch(() => null);
    if (fix && fix.fixed && fix.response) {
      resp = fix.response;
      logger.warn('[oauth] refresh succeeded after auto-fix (WinHTTP proxy imported from IE)', {
        providerId,
        fixReason: fix.reason
      });
    } else {
      // googleOAuthFetch / pickReachableIPv4 抛出的错误已经带 .network / .detail
      const network = e && e.network ? e.network : oauthNet.extractNetworkError(e);
      logger.error('[oauth] refresh network error', {
        providerId,
        url: safeUrl(provider.tokenEndpoint),
        topLevelName: e && e.name,
        topLevelMessage: e && e.message,
        network,
        attempts: e && e.attempts ? e.attempts.map((a) => ({ ip: a.ip, code: a.network && a.network.code })) : null,
        autoFixAttempt: fix ? fix.reason : 'no_attempt'
      });
      return {
        ok: false,
        reason: 'network',
        detail: 'YouTube OAuth 网络连接失败：' + (e && e.detail || network && network.message || e && e.message || 'unknown') +
          (network && network.code ? '（code=' + network.code + '）' : ''),
        network,
        attempts: e && e.attempts || null,
        autoFixAttempt: fix ? fix.reason : 'no_attempt'
      };
    }
  }

  let data;
  try { data = await resp.json(); } catch (_e) { data = null; }

  if (!resp.ok || !data || !data.access_token) {
    // Google 在 invalid_grant（refresh_token 失效 / 撤销）时会返回 400 + {error:'invalid_grant'}
    const errCode = data && (data.error || ('HTTP ' + resp.status));
    const isInvalidGrant = data && data.error === 'invalid_grant';
    logger.warn('[oauth] refresh failed', { providerId, code: errCode });
    // 标记需要重新授权（保留 account 等信息，便于 UI 显示）
    try {
      cur.needs_reconnect = true;
      await secrets.setOauthToken(providerId, cur);
    } catch (_e) {}
    if (isInvalidGrant) return { ok: false, reason: 'invalid_grant', needsReconnect: true };
    return { ok: false, reason: 'refresh_failed', detail: String(errCode), needsReconnect: true };
  }

  // 合并新 token；Google 在 refresh 时可能不返回新 refresh_token，沿用旧的
  const updated = Object.assign({}, cur, {
    access_token: String(data.access_token),
    refresh_token: data.refresh_token ? String(data.refresh_token) : cur.refresh_token,
    token_type: data.token_type || cur.token_type || 'bearer',
    scope: data.scope || cur.scope || '',
    expires_at: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : cur.expires_at,
    needs_reconnect: false
  });
  await secrets.setOauthToken(providerId, updated);
  logger.info('[oauth] refresh ok', { providerId });
  return { ok: true, expiresAt: updated.expires_at };
}

// 拿一个有效的 access_token：未过期直返，过期则自动 refresh。
// 这是 publish 流程内部使用的入口；Renderer 永远拿不到这个值。
async function getValidAccessToken(providerId) {
  const cur = await secrets.getOauthToken(providerId);
  if (!cur) return null;
  // 提前 60 秒判定过期，避开边界
  const stillValid = cur.expires_at && (Date.now() < cur.expires_at - 60000);
  if (stillValid || !cur.refresh_token) return cur.access_token || null;

  const r = await refresh(providerId);
  if (r && r.ok) {
    const fresh = await secrets.getOauthToken(providerId);
    return fresh && fresh.access_token || null;
  }
  // refresh 失败 → 视为未授权
  return null;
}

async function disconnect(providerId) {
  await secrets.clearOauthToken(providerId);
  logger.info('[oauth] disconnected', { providerId });
  return { ok: true };
}

async function list() {
  const ids = await secrets.listOauthProviders();
  const out = {};
  for (const id of ids) {
    out[id] = await status(id);
  }
  return out;
}

// v1.10：GitHub URL → owner/repo
//   与 main.js 的 ghRepoPart 同源逻辑，复制到这里避免 main.js ↔ oauth.js 互相 require。
//   - 支持 https/http/无协议（自动补 https://）
//   - 尾斜杠、?query、#fragment、.git 后缀都被剥离
//   - /issues/123、/releases 等子路径仍能解析出 base repo
//   - 拒绝非仓库路径（owner in 黑名单）
//   - 返回 null 表示「不是 GitHub 仓库」
const GH_OWNER_BLACKLIST = /^(settings|login|logout|signup|join|explore|topics|trending|collections|events|sponsors|orgs|marketplace|pricing|features|enterprise|customer-stories|security|team|jobs|sitemap|mobile|contact|about|notifications|search|new|home|privacy|terms|pulls|issues|discussions|wiki|projects)$/i;
function parseGithubRepo(rawUrl) {
  if (!rawUrl) return null;
  let s = String(rawUrl).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_e) { return null; }
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = (parts[1] || '').replace(/\.git$/i, '').replace(/[?#].*$/i, '');
  if (!owner || !repo) return null;
  if (GH_OWNER_BLACKLIST.test(owner)) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { owner: owner, repo: repo, url: 'https://github.com/' + owner + '/' + repo };
}

// v1.10：验证 token 对 publishRepo 是否具有 push 权限
//   返回 { ok, status, push, error? }
//     ok=true, push=true  → 仓库存在且有 push 权限
//     ok=true, push=false → 仓库存在但 Token 无 push 权限
//     ok=false            → 404 / 403(其它) / 网络异常
async function verifyPublishRepoPush(token, repo) {
  const url = 'https://api.github.com/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.repo);
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Rokit-OAuth/1.0'
      }
    });
    if (res.status === 200) {
      const j = await res.json().catch(function () { return null; });
      const push = !!(j && j.permissions && j.permissions.push === true);
      return { ok: true, status: 200, push: push, full_name: j && j.full_name || (repo.owner + '/' + repo.repo) };
    }
    if (res.status === 404) {
      let msg = '';
      try { const j = await res.json().catch(function () { return null; }); msg = j && j.message ? String(j.message) : ''; } catch (_e) {}
      return { ok: false, status: 404, error: 'repo_not_found', detail: msg || '仓库不存在或 Token 无权访问' };
    }
    if (res.status === 401) {
      return { ok: false, status: 401, error: 'invalid_token', detail: 'Token 无效或已过期' };
    }
    if (res.status === 403) {
      let msg = '';
      try { const j = await res.json().catch(function () { return null; }); msg = j && j.message ? String(j.message) : ''; } catch (_e) {}
      return { ok: false, status: 403, error: 'forbidden', detail: msg || 'Token 没有访问该仓库的权限' };
    }
    return { ok: false, status: res.status, error: 'http_' + res.status, detail: 'HTTP ' + res.status };
  } catch (e) {
    return { ok: false, error: 'network', detail: String(e && e.message || e) };
  }
}

// 直接保存用户输入的凭据（BYOK Token 模式：跳过 OAuth 跳转）
// 流程：调用 provider /user 验证 token → 拿账号信息 → 写 keytar
// v1.10：可选 publishRepo 入参（仅 GitHub 生效）。保存前必须验证 permissions.push===true。
// 错误分类（reason）：
//   'invalid_input'         空值或格式不合法
//   'invalid_token'         401 / token 已撤销
//   'insufficient_scope'    403 但非 rate limit（scope 不足）
//   'forbidden'             403（其它原因）
//   'rate_limited'          GitHub API 速率限制
//   'network'               网络异常
//   'not_persisted'         keytar 加载失败且未走内存兜底
//   'invalid_repo_url'      publishRepo 解析失败（非 github.com 仓库 URL）
//   'repo_not_found'        仓库 404
//   'no_push_permission'    仓库存在但 Token 无 push 权限（permissions.push !== true）
async function saveCredential(providerId, payload) {
  if (!providerId) return { ok: false, reason: 'invalid_input', detail: 'missing providerId' };
  const provider = providers.getProvider(providerId);
  if (!provider) return { ok: false, reason: 'invalid_input', detail: 'unknown provider' };
  const accessToken = payload && payload.access_token ? String(payload.access_token).trim() : '';
  if (!accessToken) return { ok: false, reason: 'invalid_input', detail: 'empty token' };

  // GitHub PAT 简单格式校验（提示用）
  const isLikelyGitHubPat = /^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)/.test(accessToken);
  if (providerId === 'github' && !isLikelyGitHubPat) {
    logger.warn('[oauth] token 格式不像 GitHub PAT', { providerId, prefix: accessToken.slice(0, 4) });
    // 不阻断，但记录告警；用户可能用经典 token 或自建 server
  }

  // 验证 token（用 provider.accountUrl 拉一下 /user）
  let resp;
  try {
    resp = await fetch(provider.accountUrl, {
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Rokit-OAuth/1.0'
      }
    });
  } catch (e) {
    return { ok: false, reason: 'network', detail: String(e && e.message || e) };
  }

  if (!resp.ok) {
    if (resp.status === 401) {
      return { ok: false, reason: 'invalid_token', status: 401 };
    }
    if (resp.status === 403) {
      const remaining = resp.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        const reset = resp.headers.get('x-ratelimit-reset');
        return { ok: false, reason: 'rate_limited', status: 403, detail: 'GitHub 速率限制' + (reset ? ('，重置于 ' + new Date(Number(reset) * 1000).toLocaleString()) : '') };
      }
      // 其它 403：可能是 scope 不足（如 fine-grained PAT 没勾选 Users: Read）
      return { ok: false, reason: 'insufficient_scope', status: 403 };
    }
    return { ok: false, reason: 'invalid_token', status: resp.status, detail: 'HTTP ' + resp.status };
  }

  const data = await resp.json().catch(function () { return null; });
  if (!data) return { ok: false, reason: 'invalid_token', detail: '无法解析 /user 响应' };

  const account = parseAccount(provider, data) || { id: null, login: null, name: null, avatar_url: null };

  // v1.10：解析并验证发布仓库
  //   规则：
  //     - payload.publishRepo 为空/null/undefined → 不绑定发布仓库（保持兼容旧 Token；用户后续可补）
  //     - 解析失败 → invalid_repo_url
  //     - 解析成功但 /repos 返回 404 → repo_not_found
  //     - 解析成功但 permissions.push !== true → no_push_permission（不保存 publishRepo）
  let publishRepo = null;
  if (providerId === 'github' && payload && payload.publishRepo != null && String(payload.publishRepo).trim() !== '') {
    const repoUrl = String(payload.publishRepo).trim();
    const parsed = parseGithubRepo(repoUrl);
    if (!parsed) {
      return { ok: false, reason: 'invalid_repo_url', detail: '无法解析为 GitHub 仓库地址：' + repoUrl };
    }
    const v = await verifyPublishRepoPush(accessToken, parsed);
    if (!v.ok) {
      // 仓库无法访问或权限不足：拒绝保存 publishRepo；其它错误也直接拒绝整次保存
      // （用户必须先解决 repo/token 配对问题才能继续，避免"半完成"的绑定）
      if (v.error === 'repo_not_found') return { ok: false, reason: 'repo_not_found', detail: v.detail, owner: parsed.owner, repo: parsed.repo };
      if (v.error === 'invalid_token') return { ok: false, reason: 'invalid_token', status: v.status, detail: v.detail };
      if (v.error === 'forbidden') return { ok: false, reason: 'forbidden', status: v.status, detail: v.detail };
      return { ok: false, reason: v.error || 'invalid_repo_url', detail: v.detail };
    }
    if (!v.push) {
      return {
        ok: false,
        reason: 'no_push_permission',
        detail: '当前 Token 没有此仓库的写入权限，请检查仓库地址或 GitHub Token 权限（Fine-grained PAT 需勾选 Contents: Read and write，目标仓库需在 Repository access 列表中）',
        owner: parsed.owner,
        repo: parsed.repo,
        full_name: v.full_name
      };
    }
    publishRepo = { owner: parsed.owner, repo: parsed.repo, url: parsed.url, full_name: v.full_name };
  }

  // 持久化：token_type = pat 表示 Personal Access Token（区分 OAuth flow 产生的 token）
  const record = {
    access_token: accessToken,
    refresh_token: null,
    token_type: 'pat',
    scope: '',
    expires_at: null,
    account
  };
  // v1.10：仅当 publishRepo 校验通过才写入；旧 token 无此字段时视为未设置（向后兼容）
  if (publishRepo) record.publishRepo = publishRepo;

  const persisted = await secrets.setOauthToken(providerId, record);
  if (!persisted) return { ok: false, reason: 'not_persisted' };

  logger.info('[oauth] credential saved (BYOK)', {
    providerId,
    login: account.login,
    hasPublishRepo: !!publishRepo
  });
  return { ok: true, account, publishRepo: publishRepo };
}

// publish 流程内部使用：Main 进程读 token，绝不暴露 Renderer
async function getTokenForInternal(providerId) {
  return secrets.getOauthToken(providerId);
}

module.exports = {
  start,
  status,
  disconnect,
  list,
  saveCredential,
  refresh,
  getValidAccessToken,
  getTokenForInternal
};
