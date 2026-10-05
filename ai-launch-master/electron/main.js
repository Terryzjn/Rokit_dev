// Rokit · Electron 主进程（v1.5）
// v1.5 增量：
//   - 凭据：secrets（keytar）+ 明文 API Key 一次性迁移
//   - 主推队列：queue.schedule() 启动时跑一次
//   - 反馈：collectForWork + analyzeForWork
//   - 录制 / 视频：recorder + video IPC
//   - 推广渠道扩展：checkHealth + GitHub L1 直发
// v1.6 增量：
//   - YouTube 视频发布：走 YouTube Data API v3（resumable upload）而非浏览器
const { app, BrowserWindow, ipcMain, shell, Menu, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { chatComplete } = require('./llm');
const { adapters } = require('./publishers');
const wechat = require('./wechat');
const oauth = require('./oauth');
const oauthNet = require('./oauth-net');
const logger = require('./logger');
const platformContext = require('./platform-context');
const youtubePublisher = require('./youtube-publisher');

// v1.5 新增模块
const secrets = require('./secrets');
const queue = require('./queue');
const collector = require('./feedback-collector');
const analyzer = require('./feedback-analyzer');
const recorder = require('./recorder');
const video = require('./video');
const pubex = require('./publisher-extensions');

// v1.7：通用浏览器框架（内置 Session 持久化 + Publisher 适配器）
// 与现有的 pubWin 单实例 BrowserWindow（persist:pub）完全独立
// —— 老逻辑（11 个平台字符串脚本注入）继续走 pub:launch/submit，
// 新框架走 browser:* IPC，每个平台使用独立 persist:platform-{id}。
const { BrowserManager } = require('./browser/BrowserManager');
const { registerBrowserIpc } = require('./browser/browser-ipc');
require('./browser/platforms'); // 把 BrowserTestPublisher 等注册到 PublisherRegistry

// 尽早安装全局异常兜底（在 app.whenReady 之前也要能捕获）
logger.installGlobalHandlers({ stage: 'pre-app-ready' });

let store = null;
let mainWindow = null;

// 固定 userData 目录（品牌更名后路径稳定），并一次性迁移旧数据
// 支持 ROKIT_USER_DATA 环境变量覆盖（用于沙箱环境或便携运行）
(function ensureUserData() {
  // 相对路径基于应用目录解析，保证从任意 cwd 启动都指向同一位置
  const override = process.env.ROKIT_USER_DATA
    ? path.resolve(app.getAppPath(), process.env.ROKIT_USER_DATA)
    : null;
  const dir = override || path.join(app.getPath('appData'), 'Rokit');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) {}
  if (override) {
    app.setPath('userData', dir);
    return;
  }
  const olds = ['AI推广大师', '推广火箭'];
  try {
    olds.forEach(function (oldName) {
      const old = path.join(app.getPath('appData'), oldName);
      if (!fs.existsSync(path.join(dir, 'ai-launch-master.db')) && fs.existsSync(path.join(old, 'ai-launch-master.db'))) {
        fs.mkdirSync(dir, { recursive: true });
        ['ai-launch-master.db', 'ai-launch-master.db-wal', 'ai-launch-master.db-shm'].forEach(function (f) {
          const s = path.join(old, f), d = path.join(dir, f);
          if (fs.existsSync(s)) { try { fs.copyFileSync(s, d); } catch (_e) {} }
        });
      }
    });
  } catch (_e) {}
  app.setPath('userData', dir);
})();

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    minWidth: 780,
    minHeight: 600,
    title: 'Rokit',
    // v1.5：自定义无边框顶栏（macOS 仍保留 traffic-light 阴影，Windows 完整接管）
    frame: false,
    resizable: true,
    maximizable: true,
    titleBarStyle: 'hidden',
    backgroundColor: '#F4F7F6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.loadFile(path.join(__dirname, '..', 'index.html'));
  // v1.5：无边框顶栏需要窗口控制 IPC——必须在 createWindow 内部挂载，
  // 否则 macOS activate 重开新窗口时 control handler 仍是旧窗口闭包，新窗口的
  // min/max/close 全部失效。
  attachWindowControls(win);
  return win;
}

// ---------- v1.5：自定义顶栏窗口控制（无边框 frame:false） ----------
// 全部共享的 IPC channel 名集中定义，避免 register/cleanup 时遗漏
const WIN_CTRL_CHANNELS = ['window:minimize', 'window:maximize-toggle', 'window:close', 'window:is-maximized'];

function attachWindowControls(win) {
  if (!win || win.isDestroyed()) return;

  // 幂等保护：先反注册避免重复调用（macOS activate / HMR / 单测）报
  // "Attempted to register a second handler for ..." 后直接挂进程
  for (const ch of WIN_CTRL_CHANNELS) {
    try { ipcMain.removeHandler(ch); } catch (_e) {}
  }

  ipcMain.handle('window:minimize', () => { try { win.minimize(); } catch (_e) {} });
  ipcMain.handle('window:maximize-toggle', () => {
    try {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return win.isMaximized();
    } catch (_e) { return false; }
  });
  ipcMain.handle('window:close', () => { try { win.close(); } catch (_e) {} });
  ipcMain.handle('window:is-maximized', () => {
    try { return !!win.isMaximized(); } catch (_e) { return false; }
  });

  // 去重推送：避免与渲染进程主动 windowIsMaximized() 查询双轨同步
  // 造成的 aria-label / icon 闪烁
  let lastIsMax = null;
  const push = (isMax) => {
    if (win.isDestroyed()) return;
    if (lastIsMax === isMax) return;
    lastIsMax = isMax;
    win.webContents.send('window:maximize-changed', isMax);
  };
  win.on('maximize', () => push(true));
  win.on('unmaximize', () => push(false));

  // 窗口关闭时反注册 handler，释放闭包对 win 的引用，避免 channel 名被僵尸 handler 占用
  win.on('closed', () => {
    for (const ch of WIN_CTRL_CHANNELS) {
      try { ipcMain.removeHandler(ch); } catch (_e) {}
    }
  });
}

// ---------- IPC ----------
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:save', (_e, s) => store.saveSettings(s));

ipcMain.handle('works:list', () => store.listWorks());
ipcMain.handle('works:save', (_e, w) => store.saveWork(w));
ipcMain.handle('works:delete', (_e, id) => store.deleteWork(id));

ipcMain.handle('pubs:list', () => store.listPubs());
ipcMain.handle('pubs:add', (_e, r) => store.addPub(r));

// ---------- 推广渠道（增删改 + 连通性测试） ----------
ipcMain.handle('channels:list', () => store.listChannels());
ipcMain.handle('channels:save', (_e, c) => store.saveChannel(c));
ipcMain.handle('channels:delete', (_e, id) => store.deleteChannel(id));

// 自定义渠道连通性测试：仅对 kind='custom' 的渠道生效
//   - 优先尝试 webhook（POST JSON）；空则用 api_base（POST JSON）
//   - 发送最小 payload：{test:true, title, body, ts}
ipcMain.handle('channels:test', async (_e, payload) => {
  const url = payload && (payload.webhook || payload.api_base);
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: '未填写有效的 API 地址或 Webhook URL' };
  }
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(payload.api_key ? { 'Authorization': 'Bearer ' + payload.api_key } : {})
      },
      body: JSON.stringify({
        test: true,
        title: 'Rokit 连接测试',
        body: '这是一条来自 Rokit 的测试消息，用于验证你的渠道接入是否成功。',
        ts: new Date().toISOString()
      })
    }, 9000);
    return {
      ok: res.ok,
      status: res.status,
      // 部分 webhook 服务会返回纯文本，仅截取前 200 字符避免日志爆炸
      preview: (await res.text().catch(function () { return ''; })).slice(0, 200)
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// v1.5：渠道健康度批量探测（涵盖内置平台 + 自定义 webhook）
ipcMain.handle('channels:health', async (_e, channels) => {
  try { return await pubex.checkAllHealth(channels || store.listChannels()); }
  catch (e) { return { _error: String((e && e.message) || e) }; }
});

ipcMain.handle('llm:generate', async (_e, req) => {
  // v1.5：不再依赖 settings.api_key；llm.chatComplete 内部已统一走 secrets
  const settings = store.getSettings();
  return chatComplete(settings, req);
});

// ============================================================
// v1.5 新增 IPC：secrets / queue / feedback / recorder / video / github-release
// ============================================================

// ---------- 凭据 ----------
ipcMain.handle('secrets:set-api-key', async (_e, value) => {
  if (!value) return { ok: false, error: 'empty-key' };
  const persisted = await secrets.setApiKey(String(value));
  // 清掉 SQLite 明文（写入凭据管理器后就不再需要）
  if (store && typeof store.clearPlaintextApiKey === 'function') {
    try { store.clearPlaintextApiKey(); } catch (_e) {}
  }
  return { ok: true, persisted: !!persisted };
});

ipcMain.handle('secrets:clear-api-key', async () => {
  await secrets.clearApiKey();
  return { ok: true };
});

// keytar 加载失败时的错误文案。
// 注意：keytar **正常加载**时 secrets._keytarError() 返回 null（secrets.js 里
// keytarLoadError 初值就是 null），旧写法直接读 `.message` 会抛 TypeError，
// 使 secrets:status 这个 IPC 每次都失败，渲染端因此拿不到「已配置 / 未配置」状态。
// 这里做空值 + 异常双重兜底。
function keytarErrorMessage() {
  try {
    const err = typeof secrets._keytarError === 'function' ? secrets._keytarError() : null;
    if (!err) return '';
    return String(err.message || err);
  } catch (_e) { return ''; }
}

ipcMain.handle('secrets:status', async () => {
  const hasNative = secrets.hasNative();
  const apiKey = await secrets.getApiKey();
  const githubPat = await secrets.getGithubPat();
  return {
    hasNative: hasNative,
    hasApiKey: !!apiKey,
    hasGithubPat: !!githubPat,
    keytarError: keytarErrorMessage()
  };
});

ipcMain.handle('secrets:set-github-pat', async (_e, value) => {
  if (!value) return { ok: false, error: 'empty-pat' };
  const persisted = await secrets.setGithubPat(String(value));
  return { ok: true, persisted: !!persisted };
});

ipcMain.handle('secrets:clear-github-pat', async () => {
  await secrets.clearGithubPat();
  return { ok: true };
});

const WECHAT_SECRET_KEYS = {
  appId: 'wechat-app-id',
  appSecret: 'wechat-app-secret',
  thumbMediaId: 'wechat-thumb-media-id'
};

ipcMain.handle('wechat:credentials-status', async () => ({
  hasAppId: !!(await secrets.getSecret(WECHAT_SECRET_KEYS.appId)),
  hasAppSecret: !!(await secrets.getSecret(WECHAT_SECRET_KEYS.appSecret)),
  hasThumbMediaId: !!(await secrets.getSecret(WECHAT_SECRET_KEYS.thumbMediaId))
}));

ipcMain.handle('wechat:credentials-save', async (_e, values) => {
  const input = values || {};
  let persisted = true;
  for (const field of Object.keys(WECHAT_SECRET_KEYS)) {
    const value = String(input[field] || '').trim();
    if (value) persisted = (await secrets.setSecret(WECHAT_SECRET_KEYS[field], value)) && persisted;
  }
  return { ok: true, persisted: persisted };
});

ipcMain.handle('wechat:credentials-clear', async () => {
  await Promise.all(Object.values(WECHAT_SECRET_KEYS).map((key) => secrets.deleteSecret(key)));
  return { ok: true };
});

ipcMain.handle('wechat:draft-create', async (_e, payload) => {
  const credentials = {
    appId: await secrets.getSecret(WECHAT_SECRET_KEYS.appId),
    appSecret: await secrets.getSecret(WECHAT_SECRET_KEYS.appSecret),
    thumbMediaId: await secrets.getSecret(WECHAT_SECRET_KEYS.thumbMediaId)
  };
  return wechat.createDraft(credentials, payload, (url, options) => fetchWithTimeout(url, options, 15000));
});

ipcMain.handle('secrets:migrate-plaintext', async () => {
  return secrets.migratePlaintextApiKey(store);
});

// ---------- OAuth（Phase 1：GitHub） ----------
// 不暴露任何读 token 的 channel；Renderer 只能触发流程 / 查询连接状态 / 断开
ipcMain.handle('oauth:start', async (_e, providerId) => {
  try {
    return await oauth.start(String(providerId || ''));
  } catch (e) {
    logger.warn('[oauth] start 抛出', { providerId, error: String(e && e.message || e) });
    return { ok: false, reason: 'exception', detail: String(e && e.message || e) };
  }
});
ipcMain.handle('oauth:status', async (_e, providerId) => {
  try { return await oauth.status(String(providerId || '')); }
  catch (e) { return { connected: false, error: String(e && e.message || e) }; }
});
// 网络诊断：检测 Google OAuth endpoint 的可达性 / 代理 / 双 family connect。
// 不发送 token / secret / code。供 Renderer 在 OAuth 失败后点击"网络诊断"按钮触发。
ipcMain.handle('oauth:net-diag', async () => {
  try { return await oauthNet.testGoogleOAuthNetwork(); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('oauth:disconnect', async (_e, providerId) => {
  try { return await oauth.disconnect(String(providerId || '')); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('oauth:list', async () => {
  try { return await oauth.list(); }
  catch (e) { return {}; }
});
// BYOK：直接保存用户粘贴的 token（不依赖 OAuth App）
// 入参字段：access_token（必填）；Main 端会调用 provider /user 验证
ipcMain.handle('oauth:save-credential', async (_e, providerId, payload) => {
  try { return await oauth.saveCredential(String(providerId || ''), payload || {}); }
  catch (e) {
    logger.warn('[oauth] saveCredential 抛出', { providerId, error: String(e && e.message || e) });
    return { ok: false, reason: 'exception', detail: String(e && e.message || e) };
  }
});
// refresh_token 续期：Main 端内部使用 refresh_token 换取新 access_token；Renderer 看不到 token。
// 返回状态供 UI 决定是否提示「重新授权」（如 invalid_grant）
ipcMain.handle('oauth:refresh', async (_e, providerId) => {
  try { return await oauth.refresh(String(providerId || '')); }
  catch (e) {
    logger.warn('[oauth] refresh 抛出', { providerId, error: String(e && e.message || e) });
    return { ok: false, reason: 'exception', detail: String(e && e.message || e) };
  }
});
// publish 流程内部用：Main 拿一个"当前有效"的 access_token（过期自动 refresh）。
// Renderer 不可见。
ipcMain.handle('oauth:get-valid-token', async (_e, providerId) => {
  try {
    const t = await oauth.getValidAccessToken(String(providerId || ''));
    // 出于安全：永远不把 token 回传到 Renderer
    return { ok: !!t, hasToken: !!t };
  } catch (e) {
    return { ok: false, hasToken: false };
  }
});

// ---------- 主推队列 ----------
ipcMain.handle('queue:schedule', async () => {
  try { return await queue.schedule(store); }
  catch (e) { return { error: String((e && e.message) || e) }; }
});

// ---------- 反馈：采集 + 分析 ----------
ipcMain.handle('feedback:collect', async (_e, payload) => {
  if (!payload || !payload.work) return { ok: false, error: 'no-work' };
  try {
    const r = await collector.collectForWork(payload.work, payload.opts || {});
    if (r.items && r.items.length && store && typeof store.upsertFeedback === 'function') {
      const n = store.upsertFeedback(r.items);
      return { ok: true, inserted: n, notes: r.notes || {} };
    }
    return { ok: true, inserted: 0, notes: r.notes || {} };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('feedback:analyze', async (_e, payload) => {
  if (!payload || !payload.workId) return { ok: false, error: 'no-work-id' };
  try {
    const r = await analyzer.analyzeForWork(store, payload.workId, {
      llm: function (req) { return chatComplete(store.getSettings(), req); },
      maxItems: payload.maxItems || 100,
      clusterThreshold: payload.clusterThreshold
    });
    return { ok: true, clusters: r.clusters.length, updated: r.updated };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('feedback:list', (_e, payload) => {
  if (!store || typeof store.listFeedback !== 'function') return [];
  return store.listFeedback(payload && payload.workId);
});

ipcMain.handle('feedback:list-clusters', (_e, payload) => {
  if (!store || typeof store.listFeedbackClusters !== 'function') return [];
  return store.listFeedbackClusters(payload && payload.workId);
});

ipcMain.handle('feedback:summarize', (_e, payload) => {
  return analyzer.summarizeForIpc(store, payload && payload.workId);
});

// ---------- 录制 ----------
recorder.attachIpc(ipcMain);

// ---------- 视频处理 ----------
video.attachIpc(ipcMain);

// ---------- GitHub L1 直发 ----------
// 找用户最近推送的仓库（兜底目标，给 step 2 没填链接时用）
ipcMain.handle('github:pick-repo', async () => {
  let token = null;
  try {
    const oauthRec = await oauth.getTokenForInternal('github');
    if (oauthRec && oauthRec.access_token) token = oauthRec.access_token;
  } catch (_e) {}
  if (!token) {
    try { token = await secrets.getGithubPat(); } catch (_e) {}
  }
  if (!token) return { ok: false, error: 'no-token' };
  const r = await pubex.githubPickRepo(token);
  if (!r) return { ok: false, error: 'no-repos' };
  return { ok: true, owner: r.owner, repo: r.repo };
});

ipcMain.handle('github:put-file', async (_e, opts) => {
  if (!opts) return { ok: false, error: 'no-opts' };
  // Token 来源优先级：OAuth (推广渠道 → GitHub BYOK) > PAT (设置里的 GitHub PAT)
  let token = null;
  let tokenSource = null;
  try {
    const oauthRec = await oauth.getTokenForInternal('github');
    if (oauthRec && oauthRec.access_token) {
      token = oauthRec.access_token;
      tokenSource = 'oauth';
    }
  } catch (_e) {}
  if (!token) {
    token = await secrets.getGithubPat();
    if (token) tokenSource = 'pat';
  }
  if (!token) {
    return {
      ok: false,
      error: 'no-token',
      detail: '未配置 GitHub Token。请先到「推广渠道 → GitHub → 添加 Personal Access Token」（推荐，需勾选 Contents: Read and write），或在设置里配置 GitHub PAT。'
    };
  }
  try {
    const r = await pubex.githubPutFile(token, opts);
    if (r && r.ok) r.tokenSource = tokenSource;
    return r;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('github:probe', async () => {
  // 仅验证凭据是否有效（用 /user 端点）
  const token = await secrets.getGithubPat();
  if (!token) return { ok: false, error: 'missing-github-pat' };
  try {
    const res = await fetchWithTimeout('https://api.github.com/user', {
      headers: {
        'Authorization': 'token ' + token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Rokit-L1/1.5'
      }
    }, 9000);
    if (!res.ok) return { ok: false, status: res.status, error: res.status === 401 ? 'PAT 失效或权限不足' : ('HTTP ' + res.status) };
    const j = await res.json().catch(function () { return null; });
    return { ok: true, login: j && j.login, avatar: j && j.avatar_url };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// ---------- 作品信息抓取（GitHub 仓库 / 普通网址） ----------
function decodeHtml(v) {
  return String(v)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function (_, n) { try { return String.fromCharCode(+n); } catch (_e) { return ''; } });
}
function ghRepoPart(url) {
  var m = /^https?:\/\/(www\.)?github\.com\/([^/?#]+\/[^/?#]+)/i.exec(url);
  return m ? m[2].replace(/\.git$/i, '') : null;
}
async function fetchWithTimeout(url, opt, ms) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, ms || 9000);
  try { return await fetch(url, Object.assign({ signal: ctrl.signal }, opt || {})); }
  finally { clearTimeout(t); }
}
async function fetchGithubMeta(ownerRepo) {
  var api = 'https://api.github.com/repos/' + encodeURIComponent(ownerRepo);
  var res = await fetchWithTimeout(api, { headers: { 'User-Agent': 'tuiguang-huojian/1.0', 'Accept': 'application/vnd.github+json' } });
  if (!res.ok) throw new Error('GitHub 仓库不存在或不可访问（HTTP ' + res.status + '）');
  var j = await res.json();
  var readme = '';
  try {
    var rr = await fetchWithTimeout(api + '/readme', { headers: { 'User-Agent': 'tuiguang-huojian/1.0', 'Accept': 'application/vnd.github.raw+json' } });
    if (rr.ok) readme = String(await rr.text()).slice(0, 1500);
  } catch (_e) {}
  return {
    kind: 'github',
    url: j.html_url || ('https://github.com/' + ownerRepo),
    title: j.full_name || ownerRepo,
    description: j.description || '',
    stars: j.stargazers_count || 0,
    forks: j.forks_count || 0,
    language: j.language || '',
    topics: Array.isArray(j.topics) ? j.topics : [],
    readme: readme
  };
}
async function fetchWebMeta(url) {
  var res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' } });
  if (!res.ok) throw new Error('页面无法访问（HTTP ' + res.status + '）');
  var html = await res.text();
  var head = html.slice(0, 30000);
  var pick = function (pats) {
    for (var i = 0; i < pats.length; i++) {
      var x = head.match(pats[i]);
      if (x && x[1] && x[1].trim()) return decodeHtml(x[1].trim());
    }
    return '';
  };
  var title = pick([/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i, /<title[^>]*>([^<]*)<\/title>/i]);
  var desc = pick([/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i]);
  return { kind: 'web', url: url, title: title, description: desc };
}
async function fetchPageMeta(url) {
  var g = ghRepoPart(url);
  if (g) return await fetchGithubMeta(g);
  if (/^https?:\/\//i.test(url)) return await fetchWebMeta(url);
  throw new Error('请输入有效的网址（http/https 开头）');
}

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    return shell.openExternal(url);
  }
  return false;
});

ipcMain.handle('fetch:meta', async (_e, url) => fetchPageMeta(String(url || '').trim()));

// ---------- 自动发布浏览器（内置持久化登录态，按平台自动填表/发布） ----------
let pubWin = null;

// 生命周期安全：判断 BrowserWindow + webContents 是否仍可访问
// 关键：每次 await 之后都可能销毁，必须重新检查
function isPubWinAlive(win) {
  return !!(win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed());
}

// 把 Electron C++ 层抛出的 "Object has been destroyed" 识别出来
// 这些错误不应该走"系统浏览器兜底"分支（用户是主动关闭窗口，不是网络/加载失败）
function isDestroyedError(e) {
  if (!e) return false;
  var msg = String((e && e.message) || e);
  return /has been destroyed/i.test(msg);
}

function ensurePubWin() {
  if (pubWin && !pubWin.isDestroyed()) return pubWin;
  pubWin = new BrowserWindow({
    width: 1220,
    height: 880,
    show: true,
    title: 'Rokit · 自动发布浏览器',
    backgroundColor: '#F4F7F6',
    webPreferences: {
      // 独立持久化分区：登录态落盘到 %APPDATA%\Rokit\Partitions\pub
      session: session.fromPartition('persist:pub'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  const contents = pubWin.webContents;
  const browserUserAgent = contents.getUserAgent()
    .replace(/\s[^\s/]+\/[\d.]+(?=\s+Chrome\/)/i, '')
    .replace(/\sElectron\/[\d.]+/i, '');
  contents.setUserAgent(browserUserAgent);
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) logger.error('publisher page failed to load', { errorCode, errorDescription, url: validatedURL });
  });
  contents.on('did-finish-load', () => {
    logger.info('publisher page loaded', { url: contents.getURL(), title: contents.getTitle() });
  });
  pubWin.on('closed', function () { pubWin = null; });
  return pubWin;
}
// 视频来源模块（在 main 内取 filePath；renderer 不持有绝对路径）
let videoSource = null;
try { videoSource = require('./video-source'); } catch (_e) { videoSource = null; }

// 安全地把 youtube 上传进度发送给 mainWindow 的 renderer
// 必须在每次 send 前重新检查窗口存活
function safeSendYoutubeProgress(progress) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    var wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send('youtube:upload-progress', progress);
  } catch (_e) { /* 兜底：永不抛出 */ }
}

// YouTube 上传专用分支（v1.6 新增）：不走 BrowserWindow，走 YouTube Data API v3
// payload 期望字段：title / description / tags / categoryId / privacyStatus / videoAssetId
//   videoAssetId 由 renderer 通过 videoPickLocal 拿到；main 用 videoSource.getInternalAsset() 反查 filePath
// 返回值统一映射到标准 pubLaunch 协议：{ status, platformId, videoId?, url?, error?, note?, hint? }
async function pubExecYouTube(payload) {
  payload = payload || {};
  var assetId = payload.videoAssetId;
  var filePath = null;
  if (assetId && videoSource && typeof videoSource.getInternalAsset === 'function') {
    var internal = videoSource.getInternalAsset(assetId);
    if (internal && internal.filePath) filePath = internal.filePath;
  }
  // 兜底：极少数场景下 renderer 直接传了 videoPath（不在 prod 流程里）
  if (!filePath && typeof payload.videoPath === 'string') {
    filePath = payload.videoPath;
  }
  if (!filePath) {
    return {
      status: 'manual',
      platformId: 'youtube',
      error: 'VIDEO_FILE_NOT_FOUND',
      note: '未选择本地视频或视频文件已失效，请重新选择后再次发射'
    };
  }

  var startedAt = Date.now();
  logger.info('[youtube-publish] start', { fileSize: null, privacyStatus: payload.privacyStatus || 'private' });

  var result;
  try {
    result = await youtubePublisher.uploadResumable({
      videoPath: filePath,
      title: payload.title,
      description: payload.description,
      tags: payload.tags,
      categoryId: payload.categoryId,
      privacyStatus: payload.privacyStatus || 'private',
      mimeType: payload.mimeType,
      onProgress: safeSendYoutubeProgress
    });
  } catch (e) {
    logger.error('[youtube-publish] unexpected throw', { error: String((e && e.message) || e) });
    return {
      status: 'manual',
      platformId: 'youtube',
      error: 'UNEXPECTED',
      note: '上传过程中抛出未预期异常：' + String((e && e.message) || e)
    };
  }

  if (result && result.ok) {
    logger.info('[youtube-publish] success', { videoId: result.videoId, durationMs: Date.now() - startedAt });
    return {
      status: 'ok',
      platformId: 'youtube',
      videoId: result.videoId,
      url: result.url,
      fileSize: result.fileSize,
      mimeType: result.mimeType
    };
  }

  // 失败映射
  var reason = (result && result.reason) || 'UNKNOWN';
  var note = (result && result.message) || 'YouTube 上传失败';
  var hint = result && result.hint;
  var mappedStatus = (reason === 'NOT_CONNECTED' || reason === 'YOUTUBE_REAUTH_REQUIRED' || reason === 'SCOPE_INSUFFICIENT')
    ? 'need_login'
    : 'manual';
  // 资源/元数据类失败：建议用户重新检查
  if (reason === 'VIDEO_FILE_NOT_FOUND' || reason === 'VIDEO_FILE_NOT_READABLE') mappedStatus = 'need_file';
  if (reason === 'INVALID_METADATA') mappedStatus = 'manual';

  logger.warn('[youtube-publish] failed', { reason: reason, status: result && result.status, durationMs: Date.now() - startedAt });

  var out = {
    status: mappedStatus,
    platformId: 'youtube',
    error: reason,
    note: note
  };
  if (hint) out.hint = hint;
  if (result && result.status) out.apiStatus = result.status;
  return out;
}

async function pubExec(platformId, stage, payload) {
  // v1.6：YouTube 走 API 上传，不开 BrowserWindow
  if (platformId === 'youtube') {
    return pubExecYouTube(payload || {});
  }
  var a = adapters[platformId];
  if (!a) return { status: 'manual', note: '该平台暂未接入自动发布' };
  var targetUrl = null;
  var win = null;
  try {
    win = ensurePubWin();
    // 拿窗口后再校验一次：ensurePubWin 返回后到下一行之间窗口也可能被销毁
    if (!isPubWinAlive(win)) {
      logger.warn('publisher window unavailable before navigation', { platformId });
      return {
        status: 'manual',
        error: 'WINDOW_UNAVAILABLE',
        note: '自动发布浏览器窗口已不可用，请重新点击「开始发射」。',
        platformId: platformId
      };
    }
    if (stage === 'fill') {
      targetUrl = (a.launch && a.launch(payload)) || null;
      if (!targetUrl) return { status: 'manual', note: '缺少发布地址（请先填写作品链接）' };
      logger.info('publisher navigation started', { platformId, url: targetUrl });

      // await #1：loadURL —— 用户可能在这一步关闭窗口
      // 加载失败交给外层 catch 处理（包含网络错误 / 加载被中断等）
      await win.loadURL(targetUrl);

      // 关键：await 之后必须重新校验窗口是否还活着
      if (!isPubWinAlive(win)) {
        logger.warn('publisher window destroyed during loadURL', { platformId, url: targetUrl });
        return {
          status: 'manual',
          error: 'WINDOW_DESTROYED',
          note: '自动发布浏览器窗口在加载过程中被关闭，本次未完成发布。请重新点击「开始发射」或在弹出的窗口中手动完成。',
          platformId: platformId
        };
      }

      // await #2：executeJavaScript —— 同样的窗口销毁风险
      var r1;
      try {
        r1 = await win.webContents.executeJavaScript(a.fill(payload), true);
      } catch (execErr) {
        if (isDestroyedError(execErr)) {
          logger.warn('publisher window destroyed during fill executeJavaScript', { platformId });
          return {
            status: 'manual',
            error: 'WINDOW_DESTROYED',
            note: '自动发布浏览器窗口在填表过程中被关闭，本次未完成发布。',
            platformId: platformId
          };
        }
        throw execErr;
      }

      // 再校验一次返回值后返回
      if (!isPubWinAlive(win)) {
        return {
          status: 'manual',
          error: 'WINDOW_DESTROYED',
          note: '自动发布浏览器窗口在完成后已被关闭。',
          platformId: platformId
        };
      }
      return Object.assign({ platformId: platformId }, r1);
    } else {
      // submit 阶段
      if (!isPubWinAlive(win)) {
        return {
          status: 'manual',
          error: 'WINDOW_UNAVAILABLE',
          note: '自动发布浏览器窗口已不可用，请重新发射。',
          platformId: platformId
        };
      }
      var r2;
      try {
        r2 = await win.webContents.executeJavaScript(a.submit(payload), true);
      } catch (execErr) {
        if (isDestroyedError(execErr)) {
          logger.warn('publisher window destroyed during submit executeJavaScript', { platformId });
          return {
            status: 'manual',
            error: 'WINDOW_DESTROYED',
            note: '自动发布浏览器窗口在提交过程中被关闭，本次未完成发布。',
            platformId: platformId
          };
        }
        throw execErr;
      }
      if (!isPubWinAlive(win)) {
        return {
          status: 'manual',
          error: 'WINDOW_DESTROYED',
          note: '自动发布浏览器窗口在完成后已被关闭。',
          platformId: platformId
        };
      }
      return Object.assign({ platformId: platformId }, r2);
    }
  } catch (e) {
    var windowDestroyed = isDestroyedError(e);
    logger.error('publisher operation failed', {
      platformId,
      stage,
      error: String((e && e.message) || e),
      code: e && e.code,
      isWindowDestroyed: windowDestroyed,
      currentUrl: isPubWinAlive(win) ? win.webContents.getURL() : ''
    });
    // 窗口被销毁：不要 fallback 到系统浏览器（用户是主动关闭的）
    if (windowDestroyed) {
      if (pubWin === win) pubWin = null;
      return {
        status: 'manual',
        error: 'WINDOW_DESTROYED',
        note: '自动发布浏览器窗口在过程中被关闭，Rokit 已停止该次发布。请重新打开应用或再次点击「开始发射」重试。',
        platformId: platformId
      };
    }
    // 其他错误（加载失败 / 注入脚本抛错 等）：fallback 到系统浏览器
    if (stage === 'fill' && targetUrl && /^https:\/\//i.test(targetUrl)) {
      try {
        if (isPubWinAlive(win)) win.close();
        if (pubWin === win) pubWin = null;
        logger.warn('opening publisher page in system browser after embedded navigation failed', { platformId, url: targetUrl });
        shell.openExternal(targetUrl).then(() => {
          logger.info('publisher page handed off to system browser', { platformId, url: targetUrl });
        }).catch((fallbackError) => {
          logger.error('publisher system-browser fallback failed', {
            platformId,
            error: String((fallbackError && fallbackError.message) || fallbackError)
          });
        });
        return {
          status: 'manual',
          note: '内置浏览器无法加载此页面，正在系统默认浏览器打开；请手动登录并完成发布。'
        };
      } catch (fallbackError) {
        logger.error('publisher system-browser fallback failed', { platformId, error: String((fallbackError && fallbackError.message) || fallbackError) });
      }
    }
    return { status: 'manual', error: String((e && e.message) || e), platformId: platformId };
  }
}
ipcMain.handle('pub:launch', (_e, arg) => pubExec(String(arg && arg.platformId || ''), 'fill', arg && arg.payload || {}));
ipcMain.handle('pub:submit', (_e, arg) => pubExec(String(arg && arg.platformId || ''), 'submit', arg && arg.payload || {}));
ipcMain.handle('pub:open', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    var w = ensurePubWin();
    if (!isPubWinAlive(w)) {
      logger.warn('pub:open skipped because publisher window unavailable', { url: url });
      return false;
    }
    // loadURL 失败不应抛回 renderer；只 warn 即可
    w.loadURL(url).catch(function (e) {
      logger.warn('pub:open loadURL failed', { url: url, error: String(e && e.message || e) });
    });
    return true;
  }
  return false;
});

function chooseCaptureSource(sources) {
  return new Promise((resolve, reject) => {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const picker = new BrowserWindow({
      width: 620,
      height: 540,
      minWidth: 560,
      minHeight: 440,
      resizable: true,
      maximizable: false,
      modal: !!parent,
      parent,
      show: false,
      center: true,
      autoHideMenuBar: true,
      title: '选择录屏来源',
      backgroundColor: '#F4F7F6',
      webPreferences: {
        preload: path.join(__dirname, 'capture-picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    let settled = false;
    const cleanup = () => ipcMain.removeListener('capture-source:selected', onSelected);
    const onSelected = (event, sourceId) => {
      if (event.sender !== picker.webContents) return;
      const source = sources.find((item) => item.id === sourceId);
      if (!source || settled) return;
      settled = true;
      cleanup();
      resolve(source);
      if (!picker.isDestroyed()) picker.close();
    };
    ipcMain.on('capture-source:selected', onSelected);
    picker.on('closed', () => {
      cleanup();
      if (!settled) { settled = true; resolve(null); }
    });
    picker.loadFile(path.join(__dirname, 'capture-picker.html')).then(() => {
      if (picker.isDestroyed()) return;
      picker.webContents.send('capture-picker:sources', sources.map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.id.indexOf('screen:') === 0 ? '屏幕' : '窗口',
        thumbnail: source.thumbnail.toDataURL()
      })));
      picker.show();
      picker.focus();
    }).catch((err) => {
      cleanup();
      if (!settled) { settled = true; reject(err); }
      if (!picker.isDestroyed()) picker.close();
    });
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!request.videoRequested) { callback({}); return; }
    desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 240, height: 135 }
    }).then(async (sources) => {
      if (!sources.length) { logger.warn('display capture returned no sources'); callback({}); return; }
      const source = await chooseCaptureSource(sources);
      logger.info('display capture source selected', { source: source ? source.name : 'cancelled' });
      callback(source ? { video: source } : {});
    }).catch((err) => {
      logger.warn('display capture source selection failed', { error: String((err && err.message) || err) });
      callback({});
    });
  });
  // 初始化日志（需要 userData 路径，因此放在 whenReady 后）
  try { logger.init(app.getPath('userData')); logger.info('app ready', { version: app.getVersion() }); } catch (_e) {}

  // 启动时记录令牌完整性级别（必须在 logger.init 之后）
  // 探测逻辑集中在 electron/platform-context.js（按完整性 SID 判定，与系统语言无关）
  // 关键：Low 完整性（受限 / 沙箱上下文）下 Windows 根本无法把 URL 交给已运行的浏览器，
  // 这是「调用系统浏览器不成功」的唯一根因，详见 oauth.js 中的说明。
  try {
    const { level, sid } = platformContext.getIntegrity();
    if (level === 'high' || level === 'system') {
      logger.info('[startup] running elevated (' + sid + ')：OAuth 调起系统浏览器可用（实测 High 正常开标签）；个别配置下可能弹 UAC 对话框。');
    } else if (level === 'medium') {
      logger.info('[startup] running as standard user (' + sid + '); OAuth 浏览器启动应正常工作。');
    } else if (level === 'low') {
      logger.warn('[startup] token integrity is Low (' + sid + ')：Windows 会拒绝把 URL 交给已运行的浏览器（shell.openExternal 会"假成功"、不报错也不开标签页），系统浏览器无法被自动调起，OAuth 将改走剪贴板手动粘贴。根因通常是可执行文件所在目录被打了低完整性标签（实测：同一个 whoami.exe 放 C:\\Windows\\System32 是 High(S-1-16-12288)，放进被打标目录就是 Low(S-1-16-4096)）——把应用移到未被标记的目录（如 C:\\Rokit，或安装到 Program Files）运行即可恢复自动调起。');
    } else {
      logger.info('[startup] integrity detection inconclusive (whoami 输出中找不到 S-1-16-* 完整性 SID)');
    }
  } catch (_e) { /* 检测失败不影响启动 */ }
  store = new Store(path.join(app.getPath('userData'), 'ai-launch-master.db'));
  // 注册抖音开放平台 IPC（依赖 Store 已创建）
  try { require('./douyin-ipc').registerDouyinIpc(ipcMain, store); }
  catch (_e) { logger.warn('[douyin] IPC 注册失败', { error: String(_e && _e.message || _e) }); }

  // v1.7：通用浏览器框架初始化 + 注册 browser:* IPC
  // 允许 execute 任意脚本的平台白名单（仅供测试平台使用，避免被滥用）
  try {
    const browserManager = new BrowserManager({ logger: logger });
    registerBrowserIpc(ipcMain, {
      browserManager: browserManager,
      allowExecutePlatforms: ['browser-test', 'test']
    });
    logger.info('[BrowserManager] 已就绪，平台注册列表', { list: require('./browser/PublisherRegistry').list() });
  } catch (_e) {
    logger.warn('[BrowserManager] 初始化失败', { error: String(_e && _e.message || _e) });
  }
  // YouTube / Google OAuth 应用级 Client ID / Client Secret 由
  // electron/config/youtube-oauth.local.js 提供（仅 Main Process 可见），
  // 这里**不**注册任何 IPC 暴露 client_secret 给 Renderer
  // 注册视频来源 IPC（VideoSource / VideoAsset 选择与缓存）
  try { require('./video-source').registerVideoSourceIpc(ipcMain); }
  catch (_e) { logger.warn('[video-source] IPC 注册失败', { error: String(_e && _e.message || _e) }); }
  createWindow();
  // attachWindowControls 已在 createWindow() 内部挂载（避免 macOS activate 新窗口漏挂）

  // v1.5：应用启动后自动跑一次主推队列选择
  try {
    queue.schedule(store).then(function (r) {
      if (r && r.main) logger.info('[queue] main selected', { main: r.main, demoted: r.demoted, promoted: r.promoted });
    }).catch(function (e) { logger.warn('[queue] schedule failed', { error: String((e && e.message) || e) }); });
  } catch (_e) {}

  // v1.5：检测到 SQLite 里仍有明文 API Key 时，自动后台迁移（不阻塞 UI）
  try {
    secrets.migratePlaintextApiKey(store).then(function (m) {
      if (m && m.migrated) logger.info('[secrets] plaintext migration', m);
    }).catch(function (e) { logger.warn('[secrets] migration failed', { error: String((e && e.message) || e) }); });
  } catch (_e) {}

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
