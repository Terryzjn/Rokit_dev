// Rokit · Google OAuth 网络层
//
// 背景：Node 18+ 的 undici fetch 在底层 socket / DNS 出错时会抛 TypeError('fetch failed')，
// 真正的 errno 在 error.cause（SystemError { code, syscall, address }）。
// Electron 28+ 的全局 fetch 也是基于 undici。常见故障：
//
//   UND_ERR_CONNECT_TIMEOUT
//     Connect Timeout Error (attempted address: oauth2.googleapis.com:443, timeout: 10000ms)
//
// 根因通常是 happy-eyeballs 选了 AAAA（IPv6）记录，但当前网络 IPv6 路由不通，
// 等待 10s 超时后才回退到 A（IPv4）。即便 Node 20 默认 autoSelectFamily: true，
// 在部分 Electron 版本 / 部分网络环境下行为不一致。
//
// 更根本的原因：**Node 进程和 Chromium（Electron Renderer / BrowserWindow）走的是不同的
// 网络栈**。Chromium 内部会自动读取 Windows 的 Internet Options / 系统代理 / PAC，
// 但 Node 的 socket 完全不读这些设置 —— 因此"浏览器能开 Google、Node 不能"是常态。
//
// 修复策略（只针对 Google OAuth host，不影响其它网络请求）：
//   1. **首选** Electron Main Process 的 `electron.net.fetch()` —— 它用 Chromium 原生网络栈，
//      会自动用 Windows IE 代理 / PAC / 系统代理，与浏览器行为一致
//   2. 如果 `electron.net.fetch()` 不可用（运行在非 Electron 环境）或抛错，则 fallback 到
//      强制 IPv4 路径（dns.lookup family:4 + https.request 直连 IPv4）
//   3. 非 Google OAuth host 完全不动，继续走原生 fetch
//
// 安全：
//   - 模块必须在 Electron Main Process 中调用（client_secret / authorization code 只在 Main）
//   - 日志只输出 hostname / port / DNS 地址 / errno / HTTP status，不打印 token / secret / code
//   - electron.net.fetch 内部走 Chromium，不会泄露敏感数据到 Node 进程外
//
// 代理：
//   - electron.net.fetch 自动用 Windows 系统代理 / PAC（**不需要**配 HTTPS_PROXY env）
//   - 用户电脑开了系统代理（Clash 系统代理 / 公司 PAC / IE 代理）就能直接访问 Google
//   - 不需要硬编码代理 IP / 端口
'use strict';

const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const { URL } = require('url');

const logger = (() => {
  try { return require('./logger'); } catch (_e) { return { info() {}, warn() {}, error() {} }; }
})();

// 惰性加载 electron 模块。
// - 在 Electron Main Process 中：require('electron') 返回 API 对象，{ net, app } 可用
// - 在普通 Node 环境（dev test / CLI）：require('electron') 返回 Electron 二进制路径字符串，
//   typeof !== 'object'，自动 fallback 到 IPv4 路径
// - 加载失败（沙箱 / 非 Electron 应用）：catch 后 null
let electronApiCache = null;
function loadElectronApi() {
  if (electronApiCache !== null) return electronApiCache;
  try {
    const e = require('electron');
    if (e && typeof e === 'object' && e.net && e.app && typeof e.net.fetch === 'function') {
      electronApiCache = { net: e.net, app: e.app };
      logger.info('[oauth-net] Electron API loaded, using Chromium net.fetch as primary path');
      return electronApiCache;
    }
  } catch (_e) { /* not running under Electron */ }
  electronApiCache = false; // 显式 false 表示"已确认不可用"，避免重复尝试
  return electronApiCache;
}

function hasElectron() { return !!loadElectronApi(); }

// 只对 Google OAuth 相关 host 强制 IPv4。
// 其它 host（GitHub API / 自建 endpoint 等）维持原 fetch 行为。
const GOOGLE_OAUTH_HOSTS = new Set([
  'oauth2.googleapis.com',     // token / refresh / revoke
  'accounts.google.com',       // authorize
  'www.googleapis.com'         // channels.list / userinfo
]);

// 每地址 connect 超时（毫秒）。3 次 × 5s ≈ 15s 总预算，留出 happy-eyeballs 的余量。
const CONNECT_TIMEOUT_MS = 5000;

// 探测当前进程的代理环境变量。Windows / macOS / Linux 桌面用户最常配 Clash / V2Ray。
// Electron 自身的 session.setProxy() 不影响 Node http(s) 模块；这里只探测 Node 层。
function detectProxyEnv() {
  const env = process.env || {};
  return {
    HTTP_PROXY: env.HTTP_PROXY || env.http_proxy || '',
    HTTPS_PROXY: env.HTTPS_PROXY || env.https_proxy || '',
    ALL_PROXY: env.ALL_PROXY || env.all_proxy || '',
    NO_PROXY: env.NO_PROXY || env.no_proxy || '',
    // Electron / Chromium 的额外代理配置（仅日志观测用）
    ELECTRON_PROXY: env.ELECTRON_PROXY || ''
  };
}

// 把 errno 平铺成可序列化对象，便于跨 IPC 传回 Renderer。
// e 可能是：undici 的 SystemError / Node net 的 SystemError / 普通 Error。
function extractNetworkError(e) {
  if (!e) return null;
  const cause = e.cause || e;
  const out = {
    name: typeof cause.name === 'string' ? cause.name : undefined,
    message: typeof cause.message === 'string' ? cause.message : undefined,
    code: typeof cause.code === 'string' ? cause.code : undefined,
    syscall: typeof cause.syscall === 'string' ? cause.syscall : undefined,
    address: typeof cause.address === 'string' ? cause.address : undefined,
    port: typeof cause.port === 'number' ? cause.port : undefined
  };
  // 去掉 undefined 字段
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : null;
}

// 把 hostname 解析为 IPv4，轮流尝试 connect，第一个能连上的地址返回。
// 全部失败时抛 AggregatedError，把每次的 errno 一并保留。
async function pickReachableIPv4(host, port) {
  let addrs = [];
  let dnsErr = null;
  try {
    addrs = await dns.lookup(host, { family: 4, all: true });
  } catch (e) {
    dnsErr = e;
  }
  if (!addrs || !addrs.length) {
    const err = new Error('dns_lookup_failed_for_' + host);
    err.code = dnsErr && dnsErr.code ? dnsErr.code : 'NO_IPV4';
    err.detail = '无法解析 ' + host + ' 的 IPv4 地址' + (dnsErr && dnsErr.message ? '（' + dnsErr.message + '）' : '');
    err.network = extractNetworkError(dnsErr) || { message: String(dnsErr && dnsErr.message || dnsErr) };
    throw err;
  }

  const attempts = [];
  for (const a of addrs) {
    const ip = a.address;
    try {
      await new Promise((resolve, reject) => {
        const sock = net.connect({ host: ip, port, family: 4, timeout: CONNECT_TIMEOUT_MS });
        let settled = false;
        const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
        sock.once('connect', () => done(resolve, ip));
        sock.once('timeout', () => { sock.destroy(); done(reject, Object.assign(new Error('connect_timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT', address: ip, port })); });
        sock.once('error', (e) => done(reject, e));
      });
      return ip;
    } catch (e) {
      attempts.push({ ip, network: extractNetworkError(e) || { message: String(e && e.message || e) } });
    }
  }
  // 全部失败
  const err = new Error('all_ipv4_connect_attempts_failed');
  err.code = 'ALL_IPV4_FAILED';
  err.detail = '已尝试 ' + attempts.length + ' 个 IPv4 地址均无法连接 ' + host + ':' + port;
  err.network = attempts[attempts.length - 1] && attempts[attempts.length - 1].network;
  err.attempts = attempts;
  throw err;
}

// 读完整 body
function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// 用 Node 内置 https 模块发请求，返回 fetch-Response 兼容对象。
// 仅在调用方已确保 url 是 Google OAuth host 时调用。
function httpsRequest(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const responseHeaders = {
        get(name) {
          if (!name) return null;
          const v = res.headers[String(name).toLowerCase()];
          return v == null ? null : v;
        }
      };
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage || '',
        headers: responseHeaders,
        text() { return readAll(res).then((b) => b.toString('utf8')); },
        json() { return readAll(res).then((b) => JSON.parse(b.toString('utf8'))); }
      });
    });
    req.on('error', (e) => reject(e));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Google OAuth fetch 入口。
//  - 仅对 GOOGLE_OAUTH_HOSTS 中的 host 走 OAuth 专用路径；其它 host 直接走全局 fetch（不破坏既有请求）
//  - 路径优先级：
//      1. Electron Main Process 的 `electron.net.fetch()`（Chromium 原生栈，自动用系统代理 / PAC）
//      2. fallback：Node 内置 https.request + dns.lookup(family:4) 强制 IPv4 直连
//  - 网络层异常抛出的 Error 会带 .network / .attempts / .fallback 字段，**不含任何 token / secret / code**
async function googleOAuthFetch(urlString, init) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (_e) {
    const err = new Error('invalid_url: ' + urlString);
    err.code = 'INVALID_URL';
    throw err;
  }
  const baseHost = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'http:' ? 80 : 443);

  if (!GOOGLE_OAUTH_HOSTS.has(baseHost)) {
    return fetch(urlString, init);
  }

  const safeReqUrl = parsed.protocol + '//' + parsed.host + parsed.pathname;
  const method = (init && init.method) || 'GET';

  // 1) 首选：Electron net.fetch（Chromium 原生栈）
  //    优势：自动读 Windows IE / 系统 / PAC 代理，绕过 Node undici 的 happy-eyeballs / IPv6-first 行为。
  //    适用：用户电脑开了系统代理（TUN / Clash 系统代理 / 公司代理 / IE 代理）时立即连通。
  const electron = loadElectronApi();
  if (electron) {
    try {
      const resp = await electron.net.fetch(urlString, init);
      logger.info('[oauth-net] electron.net.fetch ok', { url: safeReqUrl, method, status: resp && resp.status });
      return resp;
    } catch (e) {
      // 不抛错，继续 fallback 到 IPv4 路径
      logger.warn('[oauth-net] electron.net.fetch failed, falling back to IPv4 path', {
        url: safeReqUrl,
        method,
        name: e && e.name,
        message: e && e.message,
        code: e && e.code
      });
    }
  }

  // 2) Fallback：强制 IPv4 直连（解决 UND_ERR_CONNECT_TIMEOUT / IPv6-only 路由故障）
  const ip = await pickReachableIPv4(baseHost, port);

  const initHeaders = (init && init.headers) || {};
  const headers = Object.assign({}, initHeaders);
  // https.request 会自动加 Host 头；如果调用方显式给了就尊重它
  if (headers.Host == null && headers.host == null) {
    headers.Host = parsed.host;
  }
  // https.request 禁止重复设置 Host
  delete headers.host;

  const body = (init && init.body !== undefined && init.body !== null) ? init.body : null;

  const opts = {
    method,
    host: ip,                // 直连 IPv4
    servername: baseHost,    // TLS SNI 用 hostname（证书校验也按 hostname）
    port,
    path: (parsed.pathname || '/') + (parsed.search || ''),
    headers,
    family: 4,               // 显式声明 IPv4（host 是字面 IP 时其实无影响，但保险起见）
    body                     // httpsRequest 内部读 opts.body 并 req.write
  };

  // User-Agent：如果调用方没设，补一个便于 Google 排错
  if (opts.headers['User-Agent'] == null && opts.headers['user-agent'] == null) {
    opts.headers['User-Agent'] = 'Rokit-OAuth/1.0';
  }

  return httpsRequest(opts);
}

// "尝试一次自动修复并重试 fetch"：
//   场景：当前 Windows 用户设置了 IE 代理，但 WinHTTP 是 direct（最常见场景）。
//   调用方拿到 fetch 失败的 Error 后调本函数：
//     - 如果不是 Windows → 返回 { fixed: false, reason: 'not_windows' }
//     - 如果 IE 代理没启用 → 返回 { fixed: false, reason: 'no_ie_proxy' }
//     - 如果 WinHTTP 已设代理但 Node 仍连不上 → 这是代理本身的问题，重试也无效
//     - 否则 → netsh winhttp import proxy source=ie，再调一次 fetch
//   返回 { fixed, reason, response?, error? }；调用方根据 response 决定走 token 解析流程。
async function tryAutoFixAndRetry(urlString, init) {
  if (process.platform !== 'win32') return { fixed: false, reason: 'not_windows' };
  // 先确认 IE 代理确实启用了
  const ie = await readWindowsIEProxy();
  if (!ie || !ie.available) return { fixed: false, reason: 'ie_proxy_unavailable' };
  if (!ie.enabled || !ie.server) return { fixed: false, reason: 'no_ie_proxy_enabled' };
  // 再确认 WinHTTP 真的是 direct
  const wh = await readWinHttpProxy();
  if (wh && wh.server) return { fixed: false, reason: 'winhttp_already_set', currentServer: wh.server };

  const r = await enableWinHttpFromIE();
  if (!r || !r.ok) {
    return { fixed: false, reason: 'netsh_import_failed', detail: r && (r.stderr || r.reason || '') };
  }
  // WinHTTP 代理设置是进程级，对当前 Node 进程立即生效；重试一次 fetch
  try {
    const resp = await googleOAuthFetch(urlString, init);
    return { fixed: true, reason: 'winhttp_imported', response: resp };
  } catch (e) {
    return { fixed: false, reason: 'retry_still_failed', error: e };
  }
}

// 诊断：DNS / 双 family TCP connect / 真实 HTTPS 探测 + 代理环境变量
// 不发送 authorization code / client_secret / token；只 GET https://oauth2.googleapis.com/

// 读取 Windows 注册表的 IE 代理设置（仅 Windows）。
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ProxyEnable
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ProxyServer
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\AutoConfigURL
// 不在 Win 平台下用 spawn reg.exe（避免依赖 PATH），而是直接读注册表。fallback 到 spawn。
function readWindowsIEProxy() {
  if (process.platform !== 'win32') return null;
  // 用 reg.exe 读（系统自带；不需要额外 npm 依赖）。在受限沙箱里 reg.exe 可能失败，
  // 那种情况返回 available:false 让上层知道无法判断。
  return new Promise((resolve) => {
    const cp = require('child_process');
    const out = { available: false, enabled: false, server: '', autoConfigURL: '', source: 'registry' };
    const tryQuery = (valueName) => new Promise((res) => {
      try {
        const r = cp.spawnSync('reg.exe', [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
          '/v', valueName
        ], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
        if (r.error || r.status !== 0) return res(null);
        const m = (r.stdout || '').match(/REG_SZ\s+(.+?)\r?\n/);
        res(m ? m[1].trim() : null);
      } catch (_e) { res(null); }
    });
    Promise.all([tryQuery('ProxyEnable'), tryQuery('ProxyServer'), tryQuery('AutoConfigURL')]).then(([en, srv, pac]) => {
      if (en !== null) {
        out.available = true;
        out.enabled = en === '0x1' || en === '1';
        out.server = srv || '';
        out.autoConfigURL = pac || '';
        resolve(out);
      } else {
        // 连 reg.exe 都没读到（极端沙箱），返回 available:false 让上层知道无法判断
        resolve({ available: false, reason: 'reg_query_failed' });
      }
    });
  });
}

// 读取 WinHTTP 当前代理（netsh winhttp show proxy）。
// 注意：WinHTTP 才是 Node https 模块底层的网络栈；IE 代理不会自动同步到这里。
// 所以**同时**读 IE 代理和 WinHTTP 代理才能定位"为什么浏览器能开 Google、Node 不能"。
function readWinHttpProxy() {
  if (process.platform !== 'win32') return null;
  return new Promise((resolve) => {
    const cp = require('child_process');
    try {
      const r = cp.spawnSync('netsh', ['winhttp', 'show', 'proxy'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      if (r.error || r.status !== 0) {
        return resolve({ available: false, reason: String((r.error && r.error.message) || ('exit=' + r.status)) });
      }
      const txt = (r.stdout || '');
      // 解析形如：
      //   Current WinHTTP proxy settings:
      //       Direct access (no proxy server).
      // 或者
      //       Proxy Server(s) :  127.0.0.1:7890
      const m = txt.match(/Proxy Server\(s\)\s*:\s*([^\r\n]+)/i);
      if (m) {
        return resolve({ available: true, server: m[1].trim(), direct: false, raw: txt.trim() });
      }
      if (/Direct access/i.test(txt)) {
        return resolve({ available: true, server: '', direct: true, raw: txt.trim() });
      }
      return resolve({ available: true, server: '', direct: false, raw: txt.trim() });
    } catch (e) {
      resolve({ available: false, reason: String(e && e.message || e) });
    }
  });
}

// 尝试让 WinHTTP 走 IE 代理（一次性，副作用：修改 WinHTTP 注册表项）
//   netsh winhttp import proxy source=ie
// 成功后 Node 的 https 模块将走 Windows 系统代理，可解决"浏览器能开 Google、Node 不能"。
// 需要 netsh.exe 可用（系统自带）；失败时返回 ok:false + reason，**绝不**抛错阻断主流程。
async function enableWinHttpFromIE() {
  if (process.platform !== 'win32') return { ok: false, reason: 'not_windows' };
  const cp = require('child_process');
  return new Promise((resolve) => {
    try {
      const r = cp.spawnSync('netsh', ['winhttp', 'import', 'proxy', 'source=ie'], {
        encoding: 'utf8', windowsHide: true, timeout: 5000
      });
      resolve({
        ok: r.status === 0,
        stdout: String(r.stdout || '').slice(-200),
        stderr: String(r.stderr || '').slice(-200),
        status: r.status
      });
    } catch (e) {
      resolve({ ok: false, reason: String(e && e.message || e) });
    }
  });
}

// 解析 ProxyServer 字符串：
//   "http=127.0.0.1:8080;https=127.0.0.1:8080"  → https → 127.0.0.1:8080
//   "127.0.0.1:7890"                              → 通用 → 127.0.0.1:7890
//   "socks=127.0.0.1:1080"                        → socks → 127.0.0.1:1080
function parseProxyServer(server) {
  if (!server) return null;
  const parts = String(server).split(';').map((s) => s.trim()).filter(Boolean);
  const out = {};
  let generic = null;
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) { generic = p; continue; }
    const scheme = p.slice(0, eq).trim().toLowerCase();
    const addr = p.slice(eq + 1).trim();
    out[scheme] = addr;
  }
  return {
    http: out.http || generic || '',
    https: out.https || out.http || generic || '',
    socks: out.socks || out.socks4 || out.socks5 || ''
  };
}

// 给 Renderer 看的 actionable 建议文案。
// 规则：基于"有没有代理 / Electron net.fetch 是否通 / Node 直连是否通"组合给出对应建议。
function buildAdvice(result) {
  const advice = [];
  const proxyEnv = result.proxyEnv || {};
  const hasEnvProxy = !!(proxyEnv.HTTPS_PROXY || proxyEnv.HTTP_PROXY || proxyEnv.ALL_PROXY);
  const ieProxy = result.windowsIEProxy || {};
  const winHttp = result.winHttpProxy || {};
  const ipv4Ok = result.tcp && result.tcp.ipv4 && result.tcp.ipv4.ok;
  const ipv6Ok = result.tcp && result.tcp.ipv6 && result.tcp.ipv6.ok;
  const nodeProbeOk = result.httpsProbe && result.httpsProbe.ok;
  const electronProbe = result.electronProbe || {};
  const electronProbeOk = electronProbe.ok;
  const electronProbeAttempted = !!electronProbe.attempted;

  // 0) Electron net.fetch 是 Google OAuth 的真正首选路径 —— 如果它能通，OAuth 就能成。
  if (electronProbeOk) {
    advice.push('✓ Electron Chromium 网络栈可达 Google（net.fetch HTTP ' + (electronProbe.status || '?') + '）。YouTube OAuth token exchange 应该可以成功。');
    return advice;
  }

  // 1) Node https 强制 IPv4 直连能通（说明这台机器 outbound 网络本身没问题）
  if (nodeProbeOk) {
    advice.push('✓ Node 网络层可达 Google（IPv4 强制直连 OK）。YouTube OAuth 应该可以成功。');
    return advice;
  }

  // 2) Electron net.fetch 尝试过但失败 —— 真正的不通
  if (electronProbeAttempted && !electronProbeOk) {
    advice.push('Electron Chromium 网络栈也无法连接 Google：' + (electronProbe.message || electronProbe.code || 'unknown'));
    if (result.electronProxyRule && result.electronProxyRule !== 'DIRECT') {
      advice.push('  Chromium 当前解析到的代理规则：' + result.electronProxyRule + '（请确认代理软件已启动）');
    }
  }

  // 3) 检测到代理环境变量但 probe 失败
  if (hasEnvProxy) {
    advice.push('已检测到代理环境变量（' + (proxyEnv.HTTPS_PROXY || proxyEnv.HTTP_PROXY || proxyEnv.ALL_PROXY) + '），但 Node 仍无法连接 Google。检查代理软件是否运行、地址端口是否正确。');
  }

  // 4) 检测到 Windows IE 代理但 WinHTTP 没同步（这是最常见的"浏览器能开、Node 不能"原因）
  if (ieProxy && ieProxy.enabled && ieProxy.server && winHttp && winHttp.direct !== false) {
    advice.push('检测到 Windows 系统代理：' + ieProxy.server + '。但 Node 主进程底层走 WinHTTP（默认不读 IE 代理），已自动尝试让 WinHTTP 走系统代理（netsh winhttp import proxy source=ie）。');
  }

  // 5) WinHTTP 已设置代理但 Node 还是连不上
  if (winHttp && winHttp.server && !nodeProbeOk) {
    advice.push('当前 WinHTTP 代理：' + winHttp.server + '。请确认代理软件（TUN / 全局 / 系统代理）已启动且允许该地址出站。');
  }

  // 6) 都没有代理，且 IPv4 直连超时 → 大概率是 TUN 模式代理（Clash / V2Ray / sing-box 等）
  //    TUN 模式下 Chromium 进程能自动捕获，但 Node socket 在某些 TUN 实现下不会走代理。
  if (!hasEnvProxy && !(ieProxy && ieProxy.enabled) && !ipv4Ok && !ipv6Ok) {
    advice.push('当前电脑 outbound 网络无法直连 Google（IPv4 connect 超时）。如使用 Clash / V2Ray / sing-box / 公司代理：');
    advice.push('  a. 把代理切换到「系统代理」或「TUN 模式」（而不是仅在浏览器扩展中启用）—— Electron net.fetch 会自动用它；');
    advice.push('  b. 或在启动 Rokit 前设置环境变量：set HTTPS_PROXY=http://127.0.0.1:<your-port>');
    advice.push('  c. 或在管理员 PowerShell 运行：netsh winhttp import proxy source=ie（让 Node 走 Windows 系统代理）');
  }

  // 7) IPv6 ENOENT 但 IPv4 也失败
  if (result.tcp && result.tcp.ipv6 && !result.tcp.ipv6.ok && result.tcp.ipv6.network && result.tcp.ipv6.network.code === 'ENOENT' && !ipv4Ok) {
    advice.push('系统未启用 IPv6，但 IPv4 也无法连接 → 网络确实无法直连目标。');
  }

  return advice;
}

async function testGoogleOAuthNetwork() {
  const target = 'oauth2.googleapis.com';
  const result = {
    proxyEnv: detectProxyEnv(),
    hasProxy: false,
    node: process.versions.node || null,
    electron: process.versions.electron || null,
    chrome: process.versions.chrome || null,
    undici: process.versions.undici || null,
    platform: process.platform,
    arch: process.arch,
    dns: { host: target },
    tcp: {},
    httpsProbe: { ok: false },
    // Electron net.fetch 探测结果（这是 Google OAuth 真正的首选路径）
    electronProbe: { ok: false, attempted: false },
    electronProxyRule: null,
    electronIsOnline: null,
    // Windows 特有字段：
    windowsIEProxy: null,
    winHttpProxy: null,
    winHttpImportAttempt: null,
    // 给 Renderer 文案层用的 actionable advice
    advice: []
  };
  const p = result.proxyEnv;
  result.hasProxy = !!(p.HTTP_PROXY || p.HTTPS_PROXY || p.ALL_PROXY);

  // 1) DNS
  try {
    const [v4, v6] = await Promise.all([
      dns.resolve4(target).catch((e) => ({ __err: e })),
      dns.resolve6(target).catch((e) => ({ __err: e }))
    ]);
    result.dns.ipv4 = Array.isArray(v4) ? v4 : null;
    result.dns.ipv6 = Array.isArray(v6) ? v6 : null;
    if (!Array.isArray(v4)) result.dns.ipv4Error = String(v4 && v4.__err && v4.__err.message || v4 && v4.__err);
    if (!Array.isArray(v6)) result.dns.ipv6Error = String(v6 && v6.__err && v6.__err.message || v6 && v6.__err);
  } catch (e) {
    result.dns.error = String(e && e.message || e);
  }

  // 2) TCP connect per family（不依赖 googleOAuthFetch，原始 net.connect）
  for (const family of [4, 6]) {
    try {
      await new Promise((resolve, reject) => {
        const sock = net.connect({ host: target, port: 443, family, timeout: 5000 });
        let settled = false;
        const done = (fn, arg) => { if (settled) return; settled = true; fn(arg); };
        sock.once('connect', () => { sock.destroy(); done(resolve); });
        sock.once('timeout', () => { sock.destroy(); done(reject, Object.assign(new Error('connect_timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })); });
        sock.once('error', (e) => done(reject, e));
      });
      result.tcp['ipv' + family] = { ok: true };
    } catch (e) {
      result.tcp['ipv' + family] = {
        ok: false,
        network: extractNetworkError(e) || { message: String(e && e.message || e) }
      };
    }
  }

  // 3) HTTPS 探测（强制 IPv4 路径）
  try {
    const resp = await googleOAuthFetch('https://oauth2.googleapis.com/', {
      method: 'GET',
      headers: { 'User-Agent': 'Rokit-OAuth-NetDiag/1.0' }
    });
    result.httpsProbe = {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText
    };
    try { await resp.text(); } catch (_e) {} // 必须 drain body
  } catch (e) {
    const ne = extractNetworkError(e);
    result.httpsProbe = {
      ok: false,
      name: e && e.name,
      message: String(e && e.message || e),
      network: ne,
      detail: e && e.detail,
      attempts: e && e.attempts
    };
  }

  // 4) Electron net.fetch 探测（这才是 Google OAuth 的真正首选路径）
  //    场景：当前 Windows 用户的 Node 直连 Google 超时 —— 因为 Node 走 WinHTTP，
  //    Chromium（浏览器 / electron.net）走自己的网络栈 + 自动读 Windows 系统代理 / PAC。
  //    这里同时记录：
  //      - app.resolveProxy('https://oauth2.googleapis.com/') 返回 Chromium 实际会用的代理
  //      - net.isOnline() 系统是否在线
  //      - net.fetch('https://oauth2.googleapis.com/') 是否能拿到 HTTP 响应（任何 status 都算通）
  const electron = loadElectronApi();
  if (electron) {
    result.electronProbe.attempted = true;
    try {
      const proxyRule = await electron.app.resolveProxy('https://' + target + '/');
      result.electronProxyRule = proxyRule;
      logger.info('[oauth-net] app.resolveProxy', { url: 'https://' + target + '/', rule: proxyRule });
    } catch (e) {
      result.electronProxyRule = '';
      result.electronProbe.proxyResolveError = String(e && e.message || e);
    }
    try {
      result.electronIsOnline = await electron.net.isOnline();
    } catch (e) {
      result.electronIsOnline = null;
      result.electronProbe.isOnlineError = String(e && e.message || e);
    }
    try {
      const resp = await electron.net.fetch('https://' + target + '/', {
        method: 'GET',
        headers: { 'User-Agent': 'Rokit-OAuth-NetDiag/1.0' }
      });
      result.electronProbe.ok = resp.ok;
      result.electronProbe.status = resp.status;
      result.electronProbe.statusText = resp.statusText;
      try { await resp.text(); } catch (_e) {} // 必须 drain body
      logger.info('[oauth-net] electron.net.fetch probe', { ok: resp.ok, status: resp.status });
    } catch (e) {
      result.electronProbe.ok = false;
      result.electronProbe.name = e && e.name;
      result.electronProbe.message = String(e && e.message || e);
      result.electronProbe.code = e && e.code;
      logger.warn('[oauth-net] electron.net.fetch probe failed', {
        name: e && e.name,
        message: e && e.message,
        code: e && e.code
      });
    }
  } else {
    result.electronProbe.attempted = false;
    result.electronProbe.reason = 'electron_api_unavailable';
  }

  // 5) Windows 代理检测 + 自动 WinHTTP 代理打通
  //    场景：用户在 Windows 设置了"使用代理服务器"（IE/系统代理），浏览器走 Chromium
  //    网络栈能自动使用，但 Node 的 https 模块底层走 WinHTTP，而 WinHTTP 默认 Direct，
  //    必须显式 `netsh winhttp import proxy source=ie` 让它同步 IE 代理。
  //    一旦成功，Node 的 socket 也会走系统代理，OAuth token 请求就能连通。
  //    注：Electron net.fetch 不需要这一步 —— Chromium 已经自动读了 IE 代理。
  if (process.platform === 'win32') {
    result.windowsIEProxy = await readWindowsIEProxy();
    result.winHttpProxy = await readWinHttpProxy();

    // 仅当：Electron 探测失败 + Node https 探测失败 + IE 代理 enabled + WinHTTP 仍为 Direct 时，
    // 自动尝试 netsh winio 打通的 fallback 路径（仅供日志诊断，不影响主流程）
    const electronProbeFailed = !result.electronProbe.ok;
    const nodeProbeFailed = !result.httpsProbe.ok;
    const ie = result.windowsIEProxy || {};
    const wh = result.winHttpProxy || {};
    if (electronProbeFailed && nodeProbeFailed && ie.enabled && ie.server && wh.direct !== false) {
      result.winHttpImportAttempt = await enableWinHttpFromIE();
      // 重新探测一次（WinHTTP 代理设置是进程级，对当前 Node 进程立即生效）
      if (result.winHttpImportAttempt && result.winHttpImportAttempt.ok) {
        try {
          const resp2 = await googleOAuthFetch('https://oauth2.googleapis.com/', {
            method: 'GET',
            headers: { 'User-Agent': 'Rokit-OAuth-NetDiag/1.0' }
          });
          result.httpsProbeAfterImport = {
            ok: resp2.ok,
            status: resp2.status,
            statusText: resp2.statusText
          };
          try { await resp2.text(); } catch (_e) {}
        } catch (e2) {
          const ne2 = extractNetworkError(e2);
          result.httpsProbeAfterImport = {
            ok: false,
            name: e2 && e2.name,
            message: String(e2 && e2.message || e2),
            network: ne2,
            detail: e2 && e2.detail,
            attempts: e2 && e2.attempts
          };
        }
        // 同步最新的 WinHTTP 状态
        result.winHttpProxy = await readWinHttpProxy();
      }
    }
  }

  // 6) 计算 actionable advice（给 Renderer 文案层展示）
  result.advice = buildAdvice(result);

  logger.info('[oauth-net] network diagnostic', {
    electronProbeOk: result.electronProbe.ok,
    nodeProbeOk: result.httpsProbe.ok,
    proxyRule: result.electronProxyRule,
    isOnline: result.electronIsOnline,
    adviceCount: result.advice.length
  });
  return result;
}

module.exports = {
  googleOAuthFetch,
  tryAutoFixAndRetry,
  testGoogleOAuthNetwork,
  detectProxyEnv,
  extractNetworkError,
  enableWinHttpFromIE,
  parseProxyServer,
  hasElectron,
  GOOGLE_OAUTH_HOSTS
};
