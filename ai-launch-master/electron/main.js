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

// v1.8：「我的作品」GitHub 数据刷新。
//   - 只刷新"url 是 GitHub"的真实作品（示例作品 isSample 跳过）
//   - Promise.allSettled：单 repo 失败不影响其他
//   - 403/429/rate-limit 时保留旧数据（前端不做清空，由后端只回传 ok=false，前端判断）
//   - 失败控制台输出 [GitHubStats] xxx refresh failed: <msg>，不打印 token
async function refreshGithubStats(works) {
  var targets = (works || []).filter(function(w){
    return w && w.id && typeof w.url === 'string' && /github\.com/i.test(w.url);
  });
  if (!targets.length) return [];
  var results = await Promise.allSettled(targets.map(async function(w){
    var repo = ghRepoPart(w.url);
    if (!repo) throw new Error('invalid github url: ' + w.url);
    var meta = await fetchGithubMeta(repo);
    if (!meta || typeof meta.stars !== 'number') throw new Error('no stars field in response');
    return { id: w.id, stars: meta.stars, full_name: meta.title || repo };
  }));
  var updates = [];
  results.forEach(function(r, i){
    var w = targets[i];
    if (r.status === 'fulfilled'){
      updates.push({ id: w.id, ok: true, stars: r.value.stars, full_name: r.value.full_name });
      // 主进程侧持久化（即使 IPC 后续前端 saveWork 失败也不丢数据）
      try { store.saveWork({ id: w.id, star: r.value.stars }); } catch(_e){}
    } else {
      var msg = String((r.reason && r.reason.message) || r.reason || 'unknown error');
      // 不打印 token / Authorization header
      try { console.warn('[GitHubStats]', (w.id || w.url || ''), 'refresh failed:', msg); } catch(_e){}
      updates.push({ id: w.id, ok: false, error: msg });
    }
  });
  return updates;
}
ipcMain.handle('works:refresh-github-stats', async (_e, works) => {
  try {
    var updates = await refreshGithubStats(works || []);
    return { ok: true, updates: updates };
  } catch (e) {
    var em = String((e && e.message) || e);
    try { console.warn('[GitHubStats] IPC handler error:', em); } catch(_e){}
    return { ok: false, error: em };
  }
});

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
// v1.9：GitHub URL → "owner/repo" 解析
//   - 支持 https/http/无协议（自动补 https://）
//   - 尾斜杠、?query、#fragment、.git 后缀都被剥离
//   - /issues/123、/releases 等子路径仍能解析出 base repo
//   - 拒绝非仓库路径（owner in 黑名单）：/settings, /login, /explore, /pricing 等
//   - GitHub 用户名/仓库名做粗略合法性校验（避免把 `foo/bar/` 这种被错误拆分的脏数据放过去）
//   - 返回 null 表示「不是 GitHub 仓库」
var __GH_OWNER_BLACKLIST = /^(settings|login|logout|signup|join|explore|topics|trending|collections|events|sponsors|orgs|marketplace|pricing|features|enterprise|customer-stories|security|team|jobs|sitemap|mobile|contact|about|notifications|search|new|home|privacy|terms|pulls|issues|discussions|wiki|projects)$/i;
function ghRepoPart(rawUrl) {
  if (!rawUrl) return null;
  var s = String(rawUrl).trim();
  if (!s) return null;
  // 补协议
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  var u;
  try { u = new URL(s); } catch (_e) { return null; }
  // 只接受 github.com 顶级域（允许 www.）
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  // 拆 path
  var parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  var owner = parts[0];
  var repo  = (parts[1] || '').replace(/\.git$/i, '').replace(/[?#].*$/i, '');
  if (!owner || !repo) return null;
  // 黑名单：owner 是 GitHub 站点保留路径（不是用户/组织）
  if (__GH_OWNER_BLACKLIST.test(owner)) return null;
  // 用户名规则粗校验：字母数字 + . _ -，首尾不能是 . _ -
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return owner + '/' + repo;
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

// v1.5：把发布窗口强制拉到最前 —— 无论最小化 / 被 mainWindow 遮挡 / 正在加载
//   - 先 restore（如果最小化），再 show（如果隐藏），再 moveTop，再 focus
//   - 跨平台：Linux 没有 moveTop；macOS 的 show() 已经包含 un-minimize
//   - 安全：每个调用都 try/catch，单步失败不影响后续步骤
//   - 不创建窗口：调用方必须自己先 ensurePubWin
function _focusPubWin(win) {
  try {
    if (!win || win.isDestroyed()) return false;
    if (typeof win.isMinimized === 'function' && win.isMinimized()) {
      try { win.restore(); } catch (_e) {}
    }
    if (typeof win.isVisible === 'function' && !win.isVisible()) {
      try { win.show(); } catch (_e) {}
    }
    // 重复 show/focus 是安全的（Electron 会去重）
    try { win.show(); } catch (_e) {}
    try { if (typeof win.moveTop === 'function') win.moveTop(); } catch (_e) {}
    try { win.focus(); } catch (_e) {}
    return true;
  } catch (_e) { return false; }
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
    // v1.1：小红书发布页加载失败专项输出（无论谁触发 loadURL，只过 win 页）
    try {
        if (isMainFrame && _isXhsPublishUrl(validatedURL || '')) {
          var fu = '';
          var ft = '';
          try { fu = contents.getURL() || ''; } catch (_e) {}
          try { ft = contents.getTitle() || ''; } catch (_e) {}
          _outputXhsPublishLoadFailed(validatedURL, fu, ft, errorCode, errorDescription);
          _clearXhsPublishLoadExpected();
        }
      } catch (_e) {}
  });
  contents.on('did-finish-load', () => {
    logger.info('publisher page loaded', { url: contents.getURL(), title: contents.getTitle() });
    // v1.2：小红书发布页加载成功 → 由这里（主进程）统一输出 XHS PUBLISH WINDOW 块
    //   - 此时 wc.getURL() / wc.getTitle() 已经稳定，不再是 loadURL().then() 解析太早的旧 URL
    //   - setWindowOpenHandler 路径也会自然走这里（loadURL 后触发 did-finish-load）
    //   - 用 _xhsPublishLoadExpected 标记 + 1500ms 去重，避免 SPA / 多次 did-finish-load 重复刷屏
    try {
      var finishedUrl = '';
      try { finishedUrl = contents.getURL() || ''; } catch (_e) {}
      // v1.6：小红书首页加载完成 → 自动跳转发布页（不再等用户点「发布」）
      //   - 仅当 URL 是 www.xiaohongshu.com 且不在登录页时触发
      //   - 同窗口同会话只触发一次（SPA 多次 did-finish-load 由 _xhsHomeAutoNavDone 去重）
      //   - 在 creator 子域上的 did-finish-load 由下面 if (_isXhsPublishUrl(...)) 分支处理
      if (/^https?:\/\/www\.xiaohongshu\.com/i.test(finishedUrl)
          && !/\/(login|signin|signup|register)\b/i.test(finishedUrl)) {
        if (_xhsScheduleAutoNavFromHome(pubWin, finishedUrl)) {
          try { logger.info('[XHS] 小红书首页已加载'); } catch (_e) {}
          // 立刻把窗口拉到最前，确保用户看到的是首页（不等到 2.5s 后再 focus）
          try { _focusPubWin(pubWin); } catch (_e) {}
        }
      }
      if (_isXhsPublishUrl(finishedUrl)) {
        // v1.4：默认仅输出一行 [XHS] 发布页加载完成：<title>
        try { logger.info('[XHS] 发布页加载完成：' + (contents.getTitle() || '')); } catch (_e) {}
        // v1.5：小红书 SPA 加载过程中经常自己抢焦点（iframe / 浮层 / 模态弹窗脚本），
        //   在 did-finish-load 之后再拉一次焦点，确保发布页真的在用户眼前
        try { _focusPubWin(pubWin); } catch (_e) {}
        // 等 SPA / 异步组件挂载完再统计计数 / 输出 "已显示"（页面端实际渲染通常 < 1s）
        setTimeout(function () { _emitXhsPublishWindowBlock(pubWin, finishedUrl); }, 350);
      }
    } catch (_e) {}
  });
  // 小红书「观察者模式」专属监听（仅在 URL 命中时打印 / 转发）
  try { installXhsObserverHooks(pubWin); } catch (e) { logger.warn('installXhsObserverHooks failed', { error: String((e && e.message) || e) }); }
  pubWin.on('closed', function () {
    pubWin = null;
    // v1.6：清理首页→发布页自动跳转状态，确保下次重建窗口能重新触发
    _xhsResetHomeAutoNav();
  });
  return pubWin;
}

// =====================================================================
// installXhsObserverHooks
// -----------------------------------------------------------------
// 在 pubWin 创建时挂载小红书专属观察者模式监听器。
// 这些监听器：
//   - 永不阻止用户操作（绝不调 event.preventDefault）
//   - 永不点击任何按钮
//   - 仅当 URL 命中「xiaohongshu」时打印 / 转发日志
//   - 所有「详细观察日志」默认静音（受 XHS_DEBUG=1 控制）
//
// v1.4 行为：
//   1) webContents 导航类事件 → XHS NAVIGATION 日志（仅 DEBUG）
//   2) page-title-updated   → XHS NAVIGATION 日志（仅 DEBUG）
//   3) did-finish-load      → 仅 DEBUG 输出 NAVIGATION；任何时候都重新注入页面端观察器
//   4) new-window / setWindowOpenHandler → 仅 DEBUG 输出 XHS NEW WINDOW；
//      setWindowOpenHandler 命中 creator publish URL 时，输出 [XHS] 检测到发布请求 / 发布页：<url>
//   5) console-message      → [XHS-PAGE] 前缀的页面日志仅在 DEBUG 时转发到主 logger
//   6) session.web-contents-created → 仅 DEBUG 输出 XHS NEW WEB CONTENTS
//
// v1.5 增量（仅"窗口显示"相关，不影响观察者）：
//   - setWindowOpenHandler 命中 publish URL 时：pubWin 为空自动 ensurePubWin() 创建
//     （不再 WINDOW_UNAVAILABLE deny）；同步 + setImmediate + loadURL().then + did-finish-load
//     四处调用 _focusPubWin()（restore/show/moveTop/focus），确保用户真的看到窗口
//   - 日志序列（命中 publish URL）：
//       [XHS] 检测到发布请求
//       [XHS] 发布页：<url>
//       [XHS] 正在打开发布页
//       [XHS] 发布页加载完成：<title>
//       [XHS] 发布页已显示
//
// 默认输出（业务关键日志）：
//   [XHS] 检测到发布请求
//   [XHS] 发布页：<url>
//   [XHS] 正在打开发布页                （setImmediate，进入 loadURL 之前）
//   [XHS] 发布页加载完成：<title>      （did-finish-load，命中 publish URL）
//   [XHS] 发布页已显示                （SPA settle 后，仅一行；v1.5 由「已就绪」改名）
// 失败时另输出：
//   [XHS] 发布页加载失败 {...}
// =====================================================================
function _xhsUrlMatch(url) {
  if (!url || typeof url !== 'string') return false;
  return /xiaohongshu\.com|xhslink\.com/i.test(url);
}
// v1.4：详细观察日志门控 —— 默认关闭，仅 XHS_DEBUG=1 时开启
//   - 详细导航事件、元素统计、REINJECT、OBSERVER_MODE 等都走 DEBUG
//   - 默认仅输出 5 条关键业务日志：[XHS] 检测到发布请求 / 发布页：<url> / 正在打开发布页 / 发布页加载完成：<title> / 发布页已显示
//   - 真实失败（loadURL 失败 / pubWin 不可用）保留为 warn 行
function _xhsDebug() {
  try {
    var v = process.env.XHS_DEBUG;
    return v === '1' || v === 'true' || v === 'TRUE' || v === 'yes';
  } catch (_e) { return false; }
}
// v1.1：识别「小红书创作平台发布页」(creator.xiaohongshu.com/publish/publish)
function _isXhsPublishUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^https?:\/\/creator\.xiaohongshu\.com\/publish\/publish(?:\?|$|#|\/)/i.test(url)
      || /^https?:\/\/creator\.xiaohongshu\.com\/publish\/publish/i.test(url);
}
// v1.1：标记「我们刚主动 loadURL 触发的发布页导航」以便 did-finish-load 输出诊断块
let _xhsPublishLoadExpected = null; // { url, requestedAt } | null
function _markXhsPublishLoadExpected(url) {
  _xhsPublishLoadExpected = { url: String(url || ''), requestedAt: Date.now() };
}
function _consumeXhsPublishLoadExpected(url) {
  if (!_xhsPublishLoadExpected) return false;
  if (url && _xhsPublishLoadExpected.url && _xhsPublishLoadExpected.url === url) {
    _xhsPublishLoadExpected = null;
    return true;
  }
  return false;
}
function _clearXhsPublishLoadExpected() { _xhsPublishLoadExpected = null; }
// v1.1：XHS PUBLISH WINDOW 块去重（同一进程内 1500ms 只输出一次，避免 SPA / 多次 did-finish-load 重复刷屏）
let _xhsLastPublishBlockAt = 0;
function _tryConsumePublishBlockDedup() {
  var now = Date.now();
  if (now - _xhsLastPublishBlockAt < 1500) return false;
  _xhsLastPublishBlockAt = now;
  return true;
}

// v1.6：小红书首页加载完成后，主动跳转到发布页（不再等用户点「发布」）
//   - 触发条件：did-finish-load 时 URL 是 www.xiaohongshu.com 且不在登录页
//   - 延迟：XHS_HOME_AUTO_NAV_DELAY_MS（默认 2500ms）—— 让 SPA 自己水合完
//   - 去重：同窗口同次会话只跳一次；窗口销毁后由 _xhsResetHomeAutoNav 重置
//   - 不依赖 setWindowOpenHandler（该路径保留为用户手动点「发布」的 fallback）
//   - 不影响其他平台：仅匹配 www.xiaohongshu.com
//   - 不修改 session / 不清除 cookies / 不强制跳转到 creator 登录页
const XHS_PUBLISH_URL_AUTO = 'https://creator.xiaohongshu.com/publish/publish?source=official';
const XHS_HOME_AUTO_NAV_DELAY_MS = 800;
let _xhsHomeAutoNavTimer = null;
let _xhsHomeAutoNavDone = false;
let _xhsHomeAutoNavWinId = null;
function _xhsResetHomeAutoNav() {
  try {
    if (_xhsHomeAutoNavTimer) { clearTimeout(_xhsHomeAutoNavTimer); _xhsHomeAutoNavTimer = null; }
    _xhsHomeAutoNavDone = false;
    _xhsHomeAutoNavWinId = null;
  } catch (_e) {}
}
// 在首页 did-finish-load 后安排一次性的"2.5s 后自动跳转到发布页"定时器。
//   返回 true 表示本次成功安排了定时器（应当输出 [XHS] 小红书首页已加载）；
//   返回 false 表示该窗口已跳过一次 / 当前在登录页 / 窗口已销毁等，无需重复触发。
function _xhsScheduleAutoNavFromHome(win, currentUrl) {
  try {
    if (!win || win.isDestroyed()) return false;
    var wc = win.webContents;
    if (!wc || wc.isDestroyed()) return false;
    var url = String(currentUrl || '');
    if (!url) return false;
    // 已在 creator 子域 / 已在登录页 → 不自动跳转
    if (/creator\.xiaohongshu\.com/i.test(url)) return false;
    if (/\/(login|signin|signup|register)\b/i.test(url)) return false;
    // 同窗口已经跳过一次 → 不再重复（避免 SPA 内部多次 did-finish-load 反复触发）
    if (_xhsHomeAutoNavTimer) return false;
    if (_xhsHomeAutoNavDone && _xhsHomeAutoNavWinId === win.id) return false;
    _xhsHomeAutoNavWinId = win.id;
    _xhsHomeAutoNavTimer = setTimeout(function () {
      _xhsHomeAutoNavTimer = null;
      try {
        if (!win || win.isDestroyed()) return;
        var curUrl = '';
        try { curUrl = win.webContents.getURL() || ''; } catch (_e) {}
        // 二次校验：仍应在 www 首页且不在登录页
        if (!/^https?:\/\/www\.xiaohongshu\.com/i.test(curUrl)) return;
        if (/\/(login|signin|signup|register)\b/i.test(curUrl)) {
          // 用户在登录页 → 等用户登录后由下一次 did-finish-load 再次触发
          _xhsHomeAutoNavDone = false;
          return;
        }
        // 已被 setWindowOpenHandler 抢先跳到 creator 子域 → 不重复跳
        if (/creator\.xiaohongshu\.com/i.test(curUrl)) return;
        _xhsHomeAutoNavDone = true;
        try { logger.info('[XHS] 准备自动打开发布页'); } catch (_e) {}
        try { logger.info('[XHS] 正在打开发布页：' + XHS_PUBLISH_URL_AUTO); } catch (_e) {}
        try { _focusPubWin(win); } catch (_e) {}
        _markXhsPublishLoadExpected(XHS_PUBLISH_URL_AUTO);
        win.loadURL(XHS_PUBLISH_URL_AUTO).then(function () {
          _consumeXhsPublishLoadExpected(XHS_PUBLISH_URL_AUTO);
          if (isPubWinAlive(win)) _focusPubWin(win);
        }).catch(function (loadErr) {
          var msg = String((loadErr && loadErr.message) || loadErr || '');
          try { logger.warn('[XHS] 发布页加载失败', { url: XHS_PUBLISH_URL_AUTO, code: 'LOAD_URL_REJECTED', error: msg }); } catch (_e) {}
          _clearXhsPublishLoadExpected();
        });
      } catch (innerErr) {
        try { logger.warn('[XHS] auto navigate error', { error: String((innerErr && innerErr.message) || innerErr) }); } catch (_e) {}
      }
    }, XHS_HOME_AUTO_NAV_DELAY_MS);
    return true;
  } catch (e) {
    return false;
  }
}

// v1.7：小红书 payload 富化（仅 xiaohongshu 平台）
//   - 把 videoAssetId → 在 main 里查 filePath → fs.readFileSync 转 base64 dataUrl
//   - 注意：视频可能较大（数百MB），此路径目前只支持小文件；超过 ~80MB 时跳过，由用户在发布页手动选
//   - 不修改其他平台；title/body 由 renderer 自己 setTitle/setBody 写入 payload
function _enrichXhsPayloadForFill(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  try {
    var assetId = payload.videoAssetId;
    if (!assetId || !videoSource || typeof videoSource.getInternalAsset !== 'function') return payload;
    var internal = videoSource.getInternalAsset(assetId);
    if (!internal || !internal.filePath) {
      logger.warn('[XHS] 视频文件不存在（未找到 assetId 对应的 filePath）', { videoAssetId: assetId });
      return payload;
    }
    if (!fs.existsSync(internal.filePath)) {
      logger.warn('[XHS] 视频文件不存在', { filePath: internal.filePath });
      return payload;
    }
    var stat = fs.statSync(internal.filePath);
    var MAX_BYTES = 80 * 1024 * 1024; // 80MB 上限：超出则跳过自动上传（避免 IPC 卡死）
    if (stat.size > MAX_BYTES) {
      logger.warn('[XHS] 视频文件过大，跳过自动上传', { size: stat.size, max: MAX_BYTES, filePath: internal.filePath });
      payload.videoUploadSkipped = true;
      return payload;
    }
    var buf = fs.readFileSync(internal.filePath);
    var mime = payload.videoMime || (internal.mimeType) || 'video/mp4';
    var base64 = Buffer.from(buf).toString('base64');
    payload.videoDataUrl = 'data:' + mime + ';base64,' + base64;
    payload.videoUploadSkipped = false;
    logger.info('[XHS] 视频文件读取完成', { size: stat.size, mime: mime });
  } catch (e) {
    logger.warn('[XHS] 视频文件读取失败', { error: String((e && e.message) || e) });
  }
  return payload;
}

// =====================================================================
// v2.1-DIAG：小红书发布页【只读诊断探针】
// -----------------------------------------------------------------
// 不上传、不修改 DOM、不点击按钮、不调用 setFileInputFiles
// 只读检查：
//   1) Electron / Chrome / 当前 URL
//   2) 当前 videoAssetId → filePath 是否存在
//   3) 所有 input[type="file"] 的完整结构（accept/multiple/name/id/class/hidden/disabled/outerHTML/parentOuterHTML）
//   4) 所有 iframe（）
//   5) Shadow DOM 中是否存在
//   6) 上传相关按钮（不点，只是验证 XHS 页面是否真的提供了上传点）
//   7) CDP 可用性 + DOM.getDocument / DOM.querySelector / DOM.describeNode 是否返回正确 nodeId
//   8) 关键上传关键词在页面文本里的位置（上传 / 选择 / 拖拽）
// -----------------------------------------------------------------
// 输出统一以 [XHS DIAG] 前缀，与 v2.1 上传日志严格区分
// 触发点：pubExec 在调用 _xhsUploadVideoViaCdp 之前先调用本探针
// =====================================================================
async function _runXhsDiagnosticProbe(win, payload) {
  var startedAt = Date.now();
  function _log(level, msg, extra) {
    try { (level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info)('[XHS DIAG] ' + msg, extra || {}); } catch (_e) {}
  }
  _log('info', '========== DIAGNOSTIC START ==========');
  _log('info', 'Electron 版本', {
    electron: process.versions.electron || '?',
    chrome:   process.versions.chrome   || '?',
    node:     process.versions.node     || '?'
  });

  if (!win || win.isDestroyed()) { _log('error', '窗口不可用'); return; }
  var wc = win.webContents;
  if (!wc || wc.isDestroyed()) { _log('error', 'webContents 不可用'); return; }

  var url = '';
  try { url = wc.getURL(); } catch (_e) {}
  _log('info', '当前页面 URL', { url: url });

  // ---- (1) videoAssetId → filePath 路径 ----
  payload = payload || {};
  var assetId = payload.videoAssetId || '';
  _log('info', 'payload.videoAssetId', { assetId: assetId || '(空)' });

  var filePath = '';
  var fileExists = false;
  var fileSize = 0;
  var fileExt = '';
  if (assetId && videoSource && typeof videoSource.getInternalAsset === 'function') {
    var internal = videoSource.getInternalAsset(assetId);
    if (internal && internal.filePath) {
      filePath = internal.filePath;
      fileExt = (filePath.match(/\.([a-z0-9]+)$/i) || ['',''])[1] || '';
      try {
        var stat = fs.statSync(filePath);
        fileExists = true;
        fileSize = stat.size;
      } catch (_e) {}
    }
  }
  _log('info', '视频路径解析结果', {
    filePath: filePath || '(空)',
    exists: fileExists ? '是' : '否',
    size: fileExists ? fileSize : 0,
    sizeMB: fileExists ? +(fileSize / (1024 * 1024)).toFixed(2) : 0,
    extension: fileExt
  });

  // ---- (2) 所有 input[type="file"] 结构 ----
  var fileInputs;
  try {
    fileInputs = await wc.executeJavaScript(
      '(function(){\n' +
      '  var list=document.querySelectorAll(\'input[type="file"]\');\n' +
      '  var out=[];\n' +
      '  for(var i=0;i<list.length;i++){\n' +
      '    var inp=list[i];\n' +
      '    var p=inp.parentElement;\n' +
      '    var pp=p?p.parentElement:null;\n' +
      '    var ppp=pp?pp.parentElement:null;\n' +
      '    var rect=inp.getBoundingClientRect();\n' +
      '    out.push({\n' +
      '      index:i,\n' +
      '      accept:inp.accept||"",\n' +
      '      multiple:inp.multiple,\n' +
      '      required:inp.required,\n' +
      '      name:inp.name||"",\n' +
      '      id:inp.id||"",\n' +
      '      className:inp.className||"",\n' +
      '      hidden:inp.hidden,\n' +
      '      disabled:inp.disabled,\n' +
      '      visible:rect.width>0&&rect.height>0,\n' +
      '      style:inp.style.display||"",\n' +
      '      rectW:rect.width,rectH:rect.height,\n' +
      '      outerHTML:inp.outerHTML.substring(0,400),\n' +
      '      parentTag:p?p.tagName:"",\n' +
      '      parentClass:p?p.className||"":"",\n' +
      '      parentOuterHTML:p?p.outerHTML.substring(0,400):"",\n' +
      '      gpTag:pp?pp.tagName:"",\n' +
      '      gpClass:pp?pp.className||"":"",\n' +
      '      ggpTag:ppp?ppp.tagName:"",\n' +
      '      ggpClass:ppp?ppp.className||"":"",\n' +
      '      dataAttrs: (function(){var a={};for(var j=0;j<inp.attributes.length;j++){var n=inp.attributes[j];if(n.name.indexOf("data-")===0)a[n.name]=n.value;}return a;})(),\n' +
      '      ariaAttrs: (function(){var a={};for(var j=0;j<inp.attributes.length;j++){var n=inp.attributes[j];if(n.name.indexOf("aria-")===0||n.name==="role")a[n.name]=n.value;}return a;})()\n' +
      '    });\n' +
      '  }\n' +
      '  return {count:list.length,items:out};\n' +
      '})()',
      true
    );
  } catch (e) { fileInputs = null; _log('error', 'executeJavaScript(file inputs) 失败', { error: String(e.message || e) }); }
  if (fileInputs) {
    _log('info', '所有 input[type=file] 结构', { count: fileInputs.count, items: fileInputs.items });
    if (fileInputs.count === 0) {
      _log('warn', '页面里完全没有 input[type=file]。可能是：');
      _log('warn', '  - SPA 还没 hydrate 完成；');
      _log('warn', '  - 上传组件藏在 iframe 内（见下方 iframe 检测）；');
      _log('warn', '  - 上传组件用 Shadow DOM（见下方 Shadow 检测）；');
      _log('warn', '  - 上传组件是 div + click 触发隐藏的 picker，根本不用 <input>。');
    }
  }

  // ---- (3) iframe ----
  var iframes;
  try {
    iframes = await wc.executeJavaScript(
      '(function(){\n' +
      '  var list=document.querySelectorAll(\'iframe\');\n' +
      '  var out=[];\n' +
      '  for(var i=0;i<list.length;i++){\n' +
      '    var f=list[i];\n' +
      '    var src=f.src||"";\n' +
      '    try{\n' +
      '      var sameOrigin=false;\n' +
      '      try{sameOrigin=f.contentDocument!==null;}catch(_e){sameOrigin=false;}\n' +
      '      var innerFiles=null;\n' +
      '      if(sameOrigin){\n' +
      '        try{\n' +
      '          var innerInputs=f.contentDocument.querySelectorAll(\'input[type="file"]\');\n' +
      '          innerFiles=innerInputs.length;\n' +
      '        }catch(_e){}\n' +
      '      }\n' +
      '      out.push({index:i,src:src.substring(0,300),id:f.id,name:f.name,className:f.className,sameOrigin:sameOrigin,innerFileInputsCount:innerFiles});\n' +
      '    }catch(_e){\n' +
      '      out.push({index:i,src:src.substring(0,300),id:f.id,name:f.name,className:f.className,sameOrigin:false,error:String(_e.message||_e)});\n' +
      '    }\n' +
      '  }\n' +
      '  return {count:list.length,items:out};\n' +
      '})()',
      true
    );
  } catch (e) { iframes = null; _log('error', 'executeJavaScript(iframes) 失败', { error: String(e.message || e) }); }
  if (iframes) {
    _log('info', 'iframe 列表', { count: iframes.count, items: iframes.items });
    var xhsFrame = (iframes.items || []).filter(function (it) { return (it.src || '').indexOf('xiaohongshu.com') >= 0; });
    if (xhsFrame.length) {
      _log('info', '小红书域 iframe 中 file input 数量', { items: xhsFrame });
    }
  }

  // ---- (4) Shadow DOM ----
  var shadowList;
  try {
    shadowList = await wc.executeJavaScript(
      '(function(){\n' +
      '  function walk(root,depth,out){\n' +
      '    if(depth>8)return out;\n' +
      '    var all=root.querySelectorAll(\'*\');\n' +
      '    for(var i=0;i<all.length;i++){\n' +
      '      var n=all[i];\n' +
      '      if(n.shadowRoot){\n' +
      '        var innerFiles=n.shadowRoot.querySelectorAll(\'input[type="file"]\').length;\n' +
      '        out.push({tag:n.tagName,id:n.id||"",className:n.className||"",innerFileInputsCount:innerFiles,childCount:n.shadowRoot.children.length});\n' +
      '        walk(n.shadowRoot,depth+1,out);\n' +
      '      }\n' +
      '    }\n' +
    '    return out;\n' +
      '  }\n' +
      '  return walk(document,0,[]);\n' +
      '})()',
      true
    );
  } catch (e) { shadowList = null; _log('error', 'executeJavaScript(shadow DOM) 失败', { error: String(e.message || e) }); }
  if (shadowList) {
    _log('info', 'Shadow DOM 中存在自定义元素的节点', { count: shadowList.length, items: shadowList });
    var shadowWithInputs = (shadowList || []).filter(function (it) { return it.innerFileInputsCount > 0; });
    if (shadowWithInputs.length) {
      _log('error', '【关键】 file input 在 Shadow DOM 内 —— 主查询 \"document.querySelector(\'input[type=file]\')\" 看不到这些', { items: shadowWithInputs });
    }
  }

  // ---- (5) 上传相关按钮（不点击） ----
  var buttons;
  try {
    buttons = await wc.executeJavaScript(
      '(function(){\n' +
      '  var kw=["上传","视频","添加","选择","发布","拖拽","导入","点击上传","选择文件","upload video","add video","choose","drop","import","select"];\n' +
      '  var btns=document.querySelectorAll(\'button,[role="button"],label,a,.upload,[class*="upload" i],[class*="upload-area" i],[class*="upload-zone" i],[class*="picker" i]\');\n' +
      '  var out=[];\n' +
      '  for(var i=0;i<btns.length;i++){\n' +
      '    var b=btns[i];\n' +
      '    var txt=(b.innerText||b.textContent||"").trim();\n' +
      '    var html=(b.outerHTML||"").substring(0,200);\n' +
      '    var matched=null;\n' +
      '    for(var k=0;k<kw.length;k++){\n' +
      '      if(txt.indexOf(kw[k])>=0||html.toLowerCase().indexOf(kw[k].toLowerCase())>=0){matched=kw[k];break;}\n' +
      '    }\n' +
      '    if(matched){\n' +
      '      out.push({tag:b.tagName,className:(b.className||"").substring(0,200),text:txt.substring(0,100),matchedKeyword:matched,htmlSnippet:html});\n' +
      '    }\n' +
      '  }\n' +
      '  return out;\n' +
      '})()',
      true
    );
  } catch (e) { buttons = null; _log('error', 'executeJavaScript(buttons) 失败', { error: String(e.message || e) }); }
  if (buttons) {
    _log('info', '上传相关按钮（不点击）', { count: buttons.length, items: buttons });
  }

  // ---- (6) 页面文本关键上传词 ----
  var pageText;
  try {
    pageText = await wc.executeJavaScript(
      '(function(){\n' +
      '  var t=(document.body&&document.body.innerText)||"";\n' +
      '  var kw=["上传视频","选择视频","点击上传","拖拽视频","添加视频","上传","选择文件","拖拽到此处","upload video","choose video"];\n' +
      '  var found=[];\n' +
      '  for(var i=0;i<kw.length;i++){\n' +
      '    var idx=t.indexOf(kw[i]);\n' +
      '    if(idx>=0)found.push({keyword:kw[i],pos:idx,snippet:t.substring(Math.max(0,idx-15),idx+kw[i].length+15)});\n' +
      '  }\n' +
      '  return {bodyTextLength:t.length,found:found,sample:t.substring(0,500)};\n' +
      '})()',
      true
    );
  } catch (e) { pageText = null; }
  if (pageText) {
    _log('info', '页面文本关键上传词', pageText);
  }

  // ---- (7) CDP 可用性 + DOM.getDocument / DOM.querySelector / DOM.describeNode ----
  _log('info', '开始 CDP 可用性自检（不调用 setFileInputFiles）');
  var dbg = wc.debugger;
  var attachedHere = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; _log('info', 'CDP attach 成功', { version: '1.3' }); }
    else { _log('info', 'CDP 已被占用，复用'); }

    var rootResp = await dbg.send('DOM.getDocument', { depth: -1, pierce: true });
    var rootId = rootResp && rootResp.root && rootResp.root.nodeId;
    _log('info', 'CDP DOM.getDocument 结果', { rootId: rootId, rootHasChildren: rootResp && rootResp.root && rootResp.root.children ? rootResp.root.children.length : null });

    if (rootId) {
      var probeRoot = await dbg.send('DOM.querySelector', { nodeId: rootId, selector: 'input[type="file"]' });
      _log('info', 'CDP DOM.querySelector(input[type="file"]) 结果', { nodeId: probeRoot.nodeId, found: probeRoot.nodeId > 0 });
      if (probeRoot.nodeId > 0) {
        var descResp = await dbg.send('DOM.describeNode', { nodeId: probeRoot.nodeId, depth: 1 });
        var attrs = (descResp.node && descResp.node.attributes) || [];
        var accept = ''; var multiple = ''; var name = ''; var id = ''; var cls = '';
        for (var i = 0; i < attrs.length; i++) {
          var a = attrs[i];
          if (a.name === 'accept') accept = a.value;
          if (a.name === 'multiple') multiple = a.value;
          if (a.name === 'name') name = a.value;
          if (a.name === 'id') id = a.value;
          if (a.name === 'class') cls = a.value;
        }
        _log('info', 'CDP DOM.describeNode(input) 属性', { accept: accept, multiple: multiple, name: name, id: id, className: cls });
      }
      // 二次查询：上传区域容器（XHS 通常包在 .upload 之类）
      try {
        var probeUpload = await dbg.send('DOM.querySelector', { nodeId: rootId, selector: '.upload-area,.upload-zone,.upload-container,[class*="upload" i]' });
        _log('info', 'CDP DOM.querySelector(.upload-area) 结果', { nodeId: probeUpload.nodeId });
      } catch (e) {
        _log('warn', 'CDP DOM.querySelector(.upload-area) 失败', { error: String(e.message || e) });
      }
      // 二次查询：video
      var probeVideo = await dbg.send('DOM.querySelector', { nodeId: rootId, selector: 'video' });
      _log('info', 'CDP DOM.querySelector(video) 结果', { nodeId: probeVideo.nodeId });
    }
  } catch (cdpErr) {
    _log('error', 'CDP 可用性自检失败', { error: String((cdpErr && cdpErr.message) || cdpErr) });
  } finally {
    if (attachedHere && dbg && dbg.isAttached && dbg.isAttached()) {
      try { dbg.detach(); _log('info', 'CDP detach（自检用）'); } catch (_e) {}
    }
  }

  // ---- (8) 总结 ----
  _log('info', '========== DIAGNOSTIC END ==========', { elapsedMs: Date.now() - startedAt });
}

// =====================================================================
// v2.1：小红书发布页视频上传 —— CDP Page.setFileInputFiles 直传本地文件路径
// -----------------------------------------------------------------
// 替代 v1.1 的 base64 → fetch → File → DataTransfer 链路：
//   - 直接传 videoSource.getInternalAsset(assetId).filePath 给 <input type="file">
//   - 不读 base64、不读 fs.readFileSync，节省内存和 CPU
//   - 文件注入由 Chromium 内核完成，绕过 input.value = "..." 的安全限制
//   - 真实上传：XHS 会通过 input.files 读取 File 对象并上传
//
// 流程：
//   1) 拿到 videoAssetId → videoSource.getInternalAsset → filePath
//   2) fs.existsSync + 80MB 阈值（避免当帧式往返大文件）
//   3) webContents.debugger.attach('1.3')
//   4) DOM.getDocument → DOM.querySelector('input[type="file"]')，最多轮询 15s
//   5) Page.setFileInputFiles({ nodeId, files: [filePath] })
//   6) 手动 dispatch change 事件（CDP 不一定自动触发 React onChange）
//   7) 验证 input.files.length > 0（关键：必须真正有文件才算成功）
//   8) 轮询 DOM 等上传完成（最多 180s）：
//      progress 不可见 && (出现 <video> / 「上传成功」文本 / progressbar aria-valuenow=100)
//   9) detach
//
// 失败：立即返回 ok=false + error=...，不假装成功
// 成功：ok=true && domDone={...}，停留页面，由用户手动点发布
// =====================================================================

// v2.2-DIAG：点击事件诊断（只读，不上传、不点击、不修改 DOM）
//   目的：排查「手动点『上传文件』但 Electron 没有任何 [XHS] 日志」的原因。
//   主进程端：监听 BrowserWindow / webContents 关键事件
//     - did-start-navigation / did-navigate / did-navigate-in-page / did-frame-navigate
//       did-finish-load / page-title-updated
//       （这 6 个已被 installXhsObserverHooks 覆盖，本函数不再重复）
//     - 本函数**新增**3 个：render-process-gone / unresponsive / responsive
//     - **不监听** webContents.on('select-file', ...)：Electron 36 没有此 API。
//       <input type=file> 由 Chromium 内部直接打开系统文件选择框，Electron 不暴露
//       对应 webContents 事件。
//   页面端（通过 executeJavaScript 注入）：
//     - 立即 dump 当前 input[type=file]（接受属性 / multiple / 可见性 / outerHTML）
//     - MutationObserver(childList + subtree)：监听动态创建的 file input
//     - click capture listener（不 preventDefault）：定位用户点击的元素
//     - label / input 关系探测
//   日志全部以 [XHS-DIAG] 前缀输出，由 console-message 监听器转发到主 logger。
// =====================================================================
function _xhsAttachClickDiag(win) {
  if (!win || win.isDestroyed()) return;
  if (win.__xhsClickDiagInstalled) return;
  win.__xhsClickDiagInstalled = true;
  var wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  // 输出窗口 / webContents / URL 三元组，后续日志能区分是哪个窗口触发的
  try {
    logger.info('[XHS-DIAG] BrowserWindow id=' + (win.id || '?') +
      ' webContents id=' + (wc.id || '?') +
      ' url=' + (wc.getURL() || ''));
  } catch (_e) {}

  // ---- 监听未覆盖的 3 个事件（render-process-gone / unresponsive / responsive）----
  try {
    wc.on('render-process-gone', function (_e, details) {
      try {
        var reason = (details && details.reason) || '?';
        logger.warn('[XHS-DIAG] render-process-gone reason=' + reason, { details: details || {} });
      } catch (_e) {}
    });
  } catch (_e) {}
  try {
    wc.on('unresponsive', function () {
      try { logger.warn('[XHS-DIAG] unresponsive'); } catch (_e) {}
    });
  } catch (_e) {}
  try {
    wc.on('responsive', function () {
      try { logger.info('[XHS-DIAG] responsive'); } catch (_e) {}
    });
  } catch (_e) {}
}

// 每次页面整体替换时（did-finish-load），重新注入页面端观察器
//   注意：注入脚本**只读不写**，不调用任何上传 API、不点击按钮
function _xhsReinjectsClickDiag(win) {
  if (!win || win.isDestroyed()) return;
  var wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    var url = wc.getURL() || '';
    // 仅对 XHS 域注入（避免给无关页面带来噪音）
    if (url.indexOf('xiaohongshu.com') < 0 && url.indexOf('xhslink.com') < 0) return;
    var script = _getXhsClickDiagPageScript();
    if (!script) return;
    wc.executeJavaScript(script, true).then(function () {
      // 注入完成不打印（会被 console-message 监听器自动转发）
    }).catch(function (err) {
      try { logger.warn('[XHS-DIAG] 注入页面端脚本失败（不影响发布）', { error: String((err && err.message) || err) }); } catch (_e) {}
    });
  } catch (e) {
    try { logger.warn('[XHS-DIAG] 注入页面端脚本同步失败', { error: String(e) }); } catch (_e) {}
  }
}

// 注入到 renderer 的页面端脚本（**只读**）
//   - 立即 dump 当前 input[type=file]
//   - MutationObserver 监听动态创建
//   - click capture listener 记录与上传相关的点击
//   - 暴露 window.__xhsDiagDump() / window.__xhsDiagDumpLabels() 供手动调用
function _getXhsClickDiagPageScript() {
  // 通过数组 join 构造，避免转义噩梦
  var src = [
    "(function(){",
    "if (window.__xhsClickDiagInstalled) { try { console.info('[XHS-DIAG] page-script 已存在，跳过重复注入'); } catch(_e){} return; }",
    "window.__xhsClickDiagInstalled = true;",
    "function _trim(s){ try { return (s==null?'':String(s)).slice(0,160); } catch(_e){ return ''; } }",
    "function _dumpInputs(reason){",
    "  try {",
    "    var list = document.querySelectorAll('input[type=\"file\"]');",
    "    var rows = [];",
    "    for (var i = 0; i < list.length; i++) {",
    "      var inp = list[i];",
    "      var rect = inp.getBoundingClientRect();",
    "      var visible = false;",
    "      try { visible = !inp.hidden && rect.width > 0 && rect.height > 0 && inp.offsetParent !== null; } catch(_e){}",
    "      rows.push({",
    "        idx: i,",
    "        accept: _trim(inp.accept),",
    "        multiple: !!inp.multiple,",
    "        name: _trim(inp.name),",
    "        id: _trim(inp.id),",
    "        hidden: !!inp.hidden,",
    "        disabled: !!inp.disabled,",
    "        visible: visible,",
    "        rectW: Math.round(rect.width),",
    "        rectH: Math.round(rect.height),",
    "        dataAttrs: Object.keys(inp.dataset || {}).slice(0,12),",
    "        ariaLabel: _trim(inp.getAttribute && inp.getAttribute('aria-label')),",
    "        parentTag: inp.parentElement ? inp.parentElement.tagName : '',",
    "        parentClass: inp.parentElement ? _trim(String(inp.parentElement.className)) : '',",
    "        outerHTML: _trim(inp.outerHTML)",
    "      });",
    "    }",
    "    try { console.info('[XHS-DIAG] file-inputs '+reason+' count=' + list.length + ' rows=' + JSON.stringify({rows: rows}).slice(0, 8000)); } catch(_e){}",
    "  } catch(e) { try { console.info('[XHS-DIAG] _dumpInputs error', String(e)); } catch(_e){} }",
    "}",
    "function _findRelatedLabel(input){",
    "  try {",
    "    if (input.id) {",
    "      var l = document.querySelector('label[for=\"'+input.id+'\"]');",
    "      if (l) return { via: 'for', text: _trim(l.innerText), outer: _trim(l.outerHTML) };",
    "    }",
    "    var p = input.parentElement;",
    "    while (p) {",
    "      if (p.tagName === 'LABEL') return { via: 'ancestor', text: _trim(p.innerText), outer: _trim(p.outerHTML) };",
    "      p = p.parentElement;",
    "    }",
    "    return null;",
    "  } catch(e) { return null; }",
    "}",
    "// 初次 dump（页面刚加载完成时的状态）",
    "_dumpInputs('init');",
    "// MutationObserver：监听动态创建的 file input",
    "try {",
    "  var _mo = new MutationObserver(function(records){",
    "    for (var i=0;i<records.length;i++){",
    "      var r = records[i];",
    "      if (!r.addedNodes) continue;",
    "      Array.prototype.forEach.call(r.addedNodes, function(n){",
    "        if (!n || n.nodeType !== 1) return;",
    "        var tag = n.tagName;",
    "        if (tag === 'INPUT' && (n.type||'').toLowerCase() === 'file') {",
    "          try {",
    "            try { console.info('[XHS-DIAG] NEW-FILE-INPUT accept=' + _trim(n.accept) + ' multiple=' + !!n.multiple + ' visible=' + (!n.hidden && n.offsetParent !== null) + ' outer=' + JSON.stringify({outer: _trim(n.outerHTML)}).slice(0, 8000)); } catch(_e){}",
    "          } catch(_e){}",
    "        } else if (tag === 'DIV' || tag === 'SPAN' || tag === 'SECTION' || tag === 'LABEL' || tag === 'BUTTON' || tag === 'A') {",
    "          try {",
    "            var inner = (n.querySelectorAll && n.querySelectorAll('input[type=\"file\"]').length) || 0;",
    "            if (inner > 0) try { console.info('[XHS-DIAG] NEW-CONTAINER tag=' + tag + ' innerFileInputs=' + inner + ' outer=' + JSON.stringify({outer: _trim(n.outerHTML)}).slice(0, 8000)); } catch(_e){}",
    "          } catch(_e){}",
    "        }",
    "      });",
    "    }",
    "    _dumpInputs('after-mutation');",
    "  });",
    "  _mo.observe(document.documentElement || document.body, { childList: true, subtree: true });",
    "  console.info('[XHS-DIAG] MutationObserver 已挂载（childList+subtree）');",
    "} catch(e) { try { console.info('[XHS-DIAG] MutationObserver 失败', String(e)); } catch(_e){} }",
    "// click capture listener：不阻止默认行为，只记录",
    "try {",
    "  document.addEventListener('click', function(ev){",
    "    try {",
    "      var t = ev.target;",
    "      if (!t || t.nodeType !== 1) return;",
    "      var txt = ((t.innerText || t.textContent || '')+'').trim();",
    "      var tag = t.tagName;",
    "      var role = t.getAttribute && t.getAttribute('role');",
    "      var cls = (t.className && t.className.toString) ? t.className.toString() : '';",
    "      var aria = t.getAttribute && (t.getAttribute('aria-label') || t.getAttribute('aria-labelledby'));",
    "      var isUploadRelated = (txt.indexOf('上传') >= 0) || (txt.indexOf('视频') >= 0) || (txt.indexOf('选择') >= 0) || (txt.indexOf('添加') >= 0) || (txt.indexOf('拖拽') >= 0) || (txt.indexOf('文件') >= 0) || (txt.toLowerCase().indexOf('upload') >= 0) || (txt.toLowerCase().indexOf('video') >= 0) || (txt.toLowerCase().indexOf('select') >= 0) || (role === 'button' && cls.toLowerCase().indexOf('upload') >= 0);",
    "      var hasFileInputInTarget = false;",
    "      try { hasFileInputInTarget = !!(t.querySelector && t.querySelector('input[type=\"file\"]')); } catch(_e){}",
    "      var fileInputsAll = document.querySelectorAll('input[type=\"file\"]').length;",
    "      try { console.info('[XHS-DIAG] CLICK isUpload=' + isUploadRelated + ' fileInputsAll=' + fileInputsAll + ' hasFileInputInTarget=' + hasFileInputInTarget + ' detail=' + JSON.stringify({tag: tag, role: role || '', class: _trim(cls), aria: _trim(aria || ''), text: _trim(txt)}).slice(0, 1500)); } catch(_e){}",
    "      if (isUploadRelated) { _dumpInputs('after-click'); }",
    "    } catch(e) { try { console.info('[XHS-DIAG] click listener error', String(e)); } catch(_e){} }",
    "  }, true);",
    "  console.info('[XHS-DIAG] click capture listener 已挂载（capture phase）');",
    "} catch(e) { try { console.info('[XHS-DIAG] click listener 失败', String(e)); } catch(_e){} }",
    "// 暴露手动调用 API，方便在 DevTools console 里 dump",
    "window.__xhsDiagDump = function() { _dumpInputs('manual'); };",
    "window.__xhsDiagDumpLabels = function() {",
    "  try {",
    "    var labels = document.querySelectorAll('label');",
    "    var rows = [];",
    "    for (var i = 0; i < labels.length; i++) {",
    "      var l = labels[i];",
    "      rows.push({ idx: i, htmlFor: l.htmlFor || '', text: _trim(l.innerText), outer: _trim(l.outerHTML) });",
    "    }",
    "    try { console.info('[XHS-DIAG] labels count=' + labels.length + ' rows=' + JSON.stringify({rows: rows}).slice(0, 8000)); } catch(_e){}",
    "  } catch(e) { try { console.info('[XHS-DIAG] labels dump error', String(e)); } catch(_e){} }",
    "};",
    "})();"
  ];
  return src.join("\n");
}

function _xhsCdpExtractAttr(attrs, name) {
  if (!Array.isArray(attrs)) return '';
  for (var i = 0; i < attrs.length; i++) {
    var a = attrs[i];
    if (a && a.name === name) return String(a.value || '');
  }
  return '';
}

async function _xhsUploadVideoViaCdp(win, payload) {
  var startedAt = Date.now();
  // =====================================================================
  // [XHS-UPLOAD] v3.0 详细诊断：1-8（参数 / 窗口 / 当前页面）
  // 不破坏现有 [XHS] 业务日志节奏，只新增 [XHS-UPLOAD] 详细诊断
  // 目的：定位上传失败卡在哪一级（A-E）
  // =====================================================================
  try {
    var _u_wc0 = (win && win.webContents && !win.webContents.isDestroyed()) ? win.webContents : null;
    var _u_title0 = '';
    try { _u_title0 = _u_wc0 ? (_u_wc0.getTitle() || '') : ''; } catch(_e){}
    var _u_payload0 = payload || {};
    var _u_assetId0 = _u_payload0.videoAssetId || '';
    logger.info('[XHS-UPLOAD] 5. 当前 BrowserWindow 是否存在', {
      windowExists: !!(win && !win.isDestroyed()),
      windowId: (win && !win.isDestroyed()) ? (win.id || '?') : '?',
      webContentsExists: !!_u_wc0
    });
    logger.info('[XHS-UPLOAD] 6. 当前 webContents.id', {
      webContentsId: _u_wc0 ? (_u_wc0.id || '?') : '?',
      webContentsIsDestroyed: _u_wc0 ? !!_u_wc0.isDestroyed() : true
    });
    logger.info('[XHS-UPLOAD] 7. 当前页面 URL', {
      url: _u_wc0 ? (_u_wc0.getURL() || '') : '',
      electronVersion: process.versions.electron || '',
      chromeVersion: process.versions.chrome || ''
    });
    logger.info('[XHS-UPLOAD] 8. 当前页面 title', { title: _u_title0 });
    logger.info('[XHS-UPLOAD] 1. 当前准备上传的视频 videoAssetId（绝对路径稍后查表）', {
      videoAssetId: _u_assetId0 || '(空)',
      note: 'assetId 仅是 ID；真实绝对路径由 videoSource.getInternalAsset(assetId).filePath 解析'
    });
    logger.info('[XHS-UPLOAD] 2-4. 文件路径/大小/扩展名（稍后 fs.existsSync/fs.statSync 后回填）', { pending: true });
  } catch (e) {
    try { logger.warn('[XHS-UPLOAD] 1-8 诊断快照异常', { error: String((e && e.message) || e) }); } catch (_e) {}
  }
  var result = {
    status: 'manual',
    platformId: 'xiaohongshu',
    ok: false,
    found: false,
    pickedCount: 0,
    elapsedMs: 0,
    attempts: 0,
    error: '',
    fileInputs: [],
    fileName: '',
    fileSize: 0,
    filePath: '',
    domDone: null,
    videoUploadSkipped: false,
    skipped: false,
    method: 'cdp:Page.setFileInputFiles',
    electronVersion: process.versions.electron || '',
    chromeVersion: process.versions.chrome || '',
    nodeVersion: process.versions.node || '',
    currentUrl: ''
  };
  function _fail(why, extra) {
    try { logger.error('[XHS] 视频上传失败：' + why, extra || {}); } catch (_e) {}
    result.ok = false;
    result.error = why;
    result.elapsedMs = Date.now() - startedAt;
    return result;
  }

  // (0) 参数 / 窗口校验
  if (!win || win.isDestroyed()) return _fail('window-unavailable');
  var wc = win.webContents;
  if (!wc || wc.isDestroyed()) return _fail('webcontents-unavailable');
  payload = payload || {};
  result.currentUrl = (function () { try { return wc.getURL(); } catch (_e) { return ''; } })();

  // (2) videoAssetId → filePath
  var assetId = payload.videoAssetId;
  if (!assetId) {
    result.videoUploadSkipped = true;
    result.skipped = 'no-asset-id';
    result.elapsedMs = Date.now() - startedAt;
    try { logger.warn('[XHS] 没有视频资产，跳过自动上传（请手动选择）'); } catch (_e) {}
    return result;
  }
  if (!videoSource || typeof videoSource.getInternalAsset !== 'function') {
    return _fail('video-source-module-missing');
  }
  var internal = videoSource.getInternalAsset(assetId);
  if (!internal || !internal.filePath) {
    result.videoUploadSkipped = true;
    result.skipped = 'no-internal-asset';
    result.elapsedMs = Date.now() - startedAt;
    try { logger.warn('[XHS] 视频文件不存在（未找到 assetId 对应的 filePath）', { videoAssetId: assetId }); } catch (_e) {}
    return result;
  }
  var filePath = internal.filePath;
  result.filePath = filePath;

  // (3) 文件存在性 / 大小检查
  if (!fs.existsSync(filePath)) {
    result.videoUploadSkipped = true;
    result.skipped = 'file-not-found';
    result.elapsedMs = Date.now() - startedAt;
    try { logger.error('[XHS] 视频文件不存在', { filePath: filePath }); } catch (_e) {}
    return result;
  }
  var stat;
  try { stat = fs.statSync(filePath); }
  catch (e) { return _fail('stat-failed:' + String((e && e.message) || e)); }
  result.fileName = path.basename(filePath);
  result.fileSize = stat.size;
  var mime = internal.mimeType || payload.videoMime || 'video/mp4';
  try { logger.info('[XHS] 当前视频路径', { filePath: filePath, size: stat.size, mime: mime, duration: internal.duration || null, width: internal.width || null, height: internal.height || null }); } catch (_e) {}
  // [XHS-UPLOAD] 1-4：权威值（已确认文件存在）
  try {
    var _u_ext2 = (filePath.match(/\.([a-z0-9]+)$/i) || ['',''])[1] || '';
    logger.info('[XHS-UPLOAD] 1. 当前准备上传的视频绝对路径', { filePath: filePath });
    logger.info('[XHS-UPLOAD] 2. 文件是否存在', { exists: true, filePath: filePath });
    logger.info('[XHS-UPLOAD] 3. 文件大小', { bytes: stat.size, MB: +(stat.size / (1024*1024)).toFixed(2) });
    logger.info('[XHS-UPLOAD] 4. 文件扩展名', { ext: _u_ext2, mime: mime, fileName: path.basename(filePath) });
  } catch (e) {
    try { logger.warn('[XHS-UPLOAD] 1-4 诊断异常', { error: String((e && e.message) || e) }); } catch (_e) {}
  }
  try { logger.info('[XHS] 视频文件大小', { bytes: stat.size, MB: +(stat.size / (1024 * 1024)).toFixed(2) }); } catch (_e) {}

  var MAX_BYTES = 80 * 1024 * 1024;
  if (stat.size > MAX_BYTES) {
    result.videoUploadSkipped = true;
    result.skipped = 'file-too-large';
    result.elapsedMs = Date.now() - startedAt;
    try { logger.warn('[XHS] 视频文件过大，跳过自动上传', { size: stat.size, max: MAX_BYTES, filePath: filePath }); } catch (_e) {}
    return result;
  }

  // (4) attach debugger
  var dbg = wc.debugger;
  var attached = false;
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      attached = true;
      try { logger.info('[XHS] webContents.debugger 已连接', { version: '1.3' }); } catch (_e) {}
    } else {
      try { logger.info('[XHS] webContents.debugger 已处于 attached 状态，复用现有会话'); } catch (_e) {}
    }
  } catch (e) {
    return _fail('cdp-attach-failed:' + String((e && e.message) || e));
  }

  try {
    // (5) 探测 file input（轮询，最多 15s）
    var nodeId = null;
    var inputInfo = null;
    var attempts = 0;
    var deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      attempts++;
      try {
        var rootResp = await dbg.send('DOM.getDocument', { depth: -1, pierce: true });
        var rootId = rootResp && rootResp.root && rootResp.root.nodeId;
        if (rootId) {
          var q = await dbg.send('DOM.querySelector', {
            nodeId: rootId,
            selector: 'input[type="file"]'
          });
          if (q && q.nodeId) {
            nodeId = q.nodeId;
            // 探测属性
            try {
              var desc = await dbg.send('DOM.describeNode', { nodeId: nodeId, depth: 1 });
              var attrs = (desc.node && desc.node.attributes) || [];
              inputInfo = {
                selector: 'input[type="file"]',
                accept: _xhsCdpExtractAttr(attrs, 'accept'),
                multiple: _xhsCdpExtractAttr(attrs, 'multiple'),
                name: _xhsCdpExtractAttr(attrs, 'name'),
                type: 'file'
              };
            } catch (_e) { inputInfo = { selector: 'input[type="file"]', accept: '', multiple: '', name: '', type: 'file' }; }
            break;
          }
        }
      } catch (probeErr) {
        // 偶发"Could not find node with given id" —— 等下一轮
      }
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    if (!nodeId) {
      try { logger.error('[XHS] 视频上传 input 未找到', { attempts: attempts, url: currentUrl }); } catch (_e) {}
      return _fail('no-file-input', { attempts: attempts, url: (function () { try { return wc.getURL(); } catch (_e) { return ''; } })() });
    }
    result.attempts = attempts;
    result.fileInputs = [inputInfo];
    try { logger.info('[XHS] 视频上传 input 数量：1'); } catch (_e) {}
    try { logger.info('[XHS] 视频文件 input 已找到', { accept: inputInfo.accept, multiple: inputInfo.multiple, name: inputInfo.name }); } catch (_e) {}
    // [XHS-UPLOAD] 9-13：file input 详细结构（数量/accept/disabled/visible/iframe）
    try {
      var _u_inputsAll = null;
      var _u_inputState = null;
      var _u_inIframe = false;
      try {
        _u_inputsAll = await wc.executeJavaScript(
          "(function(){try{return document.querySelectorAll('input[type=\"file\"]').length;}catch(e){return -1;}})()", true);
      } catch(_e){}
      try {
        _u_inputState = await wc.executeJavaScript(
          "(function(){try{var inp=document.querySelector('input[type=\"file\"]');if(!inp)return null;" +
          "var rect=inp.getBoundingClientRect();" +
          "return {disabled:!!inp.disabled,visible:(rect.width>0&&rect.height>0)," +
          "accept:inp.accept||'',multiple:!!inp.multiple,name:inp.name||'',id:inp.id||''," +
          "rectW:Math.round(rect.width),rectH:Math.round(rect.height)," +
          "offsetParent:inp.offsetParent?'yes':'null'," +
          "className:inp.className||'',outerHTML:(inp.outerHTML||'').slice(0,300)};" +
          "}catch(e){return {error:String(e.message||e)};}})()", true);
      } catch(_e){}
      try {
        // 探测 file input 是否在 iframe：查主文档所有 iframe 的 contentDocument
        var _u_inFrame = await wc.executeJavaScript(
          "(function(){try{var fs=document.querySelectorAll('iframe');for(var i=0;i<fs.length;i++){" +
          "var d=null;try{d=fs[i].contentDocument;}catch(_e){continue;}" +
          "if(d&&d.querySelectorAll('input[type=\"file\"]').length>0){" +
          "return {inIframe:true,iframeSrc:(fs[i].src||'').slice(0,200),iframeIdx:i};}" +
          "}return {inIframe:false};}catch(e){return {inIframe:false,error:String(e.message||e)};}})()", true);
        if (_u_inFrame && _u_inFrame.inIframe) _u_inIframe = true;
      } catch(_e){}
      logger.info('[XHS-UPLOAD] 9. 找到的 file input 数量', {
        totalInputs: _u_inputsAll,
        cdpFoundInputs: 1,
        attempts: attempts
      });
      logger.info('[XHS-UPLOAD] 10. file input 的 accept 属性', {
        accept: (_u_inputState && _u_inputState.accept) || inputInfo.accept || '',
        multiple: (_u_inputState && _u_inputState.multiple) || false
      });
      logger.info('[XHS-UPLOAD] 11. file input 是否 disabled', {
        disabled: _u_inputState ? !!_u_inputState.disabled : null
      });
      logger.info('[XHS-UPLOAD] 12. file input 是否 visible', {
        visible: _u_inputState ? !!_u_inputState.visible : null,
        rectW: (_u_inputState && _u_inputState.rectW) || 0,
        rectH: (_u_inputState && _u_inputState.rectH) || 0,
        offsetParent: (_u_inputState && _u_inputState.offsetParent) || '?',
        note: 'visible = rectW>0 && rectH>0；offsetParent=null 不代表不可用（Vue/React 经常用 opacity:0 包裹）'
      });
      logger.info('[XHS-UPLOAD] 13. file input 是否位于 iframe', {
        inIframe: _u_inIframe,
        note: '在主文档 querySelector 已经能拿到 input，CDP DOM.querySelector 也返回 nodeId>0 → 主文档判定'
      });
    } catch (e) {
      try { logger.warn('[XHS-UPLOAD] 9-13 诊断异常', { error: String((e && e.message) || e) }); } catch (_e) {}
    }

    // (6) 检查是否已经上传过（避免重复上传）
    var already;
    try {
      already = await wc.executeJavaScript(
        '(function(){\n' +
        '  var inp=document.querySelector(\'input[type="file"]\');\n' +
        '  if(!inp||!inp.files||inp.files.length===0)return null;\n' +
        '  return inp.files[0].name+"\\|"+(inp.files[0].size||0)+"|"+(inp.files[0].type||"");\n' +
        '})()',
        true
      );
    } catch (_e) { already = null; }

    if (already && typeof already === 'string' && already.indexOf('|') >= 0) {
      var parts = already.split('|');
      try { logger.info('[XHS] 检测到视频已经存在，跳过重复上传', { name: parts[0], size: Number(parts[1]), type: parts[2] }); } catch (_e) {}
      // [XHS-UPLOAD] 15-20：页面侧 input.files 已存在
      try {
        logger.info('[XHS-UPLOAD] 15. 文件选择事件最终返回的路径（页面侧 input.files 已存在）', {
          name: parts[0],
          size: Number(parts[1]),
          type: parts[2]
        });
        logger.info('[XHS-UPLOAD] 16. 文件已设置到 file input（之前用户已选过）', { alreadyUploaded: true });
        logger.info('[XHS-UPLOAD] 17. file input.files.length', { length: 1 });
        logger.info('[XHS-UPLOAD] 18. file input.files[0].name', { name: parts[0] });
        logger.info('[XHS-UPLOAD] 19. file input.files[0].size', { size: Number(parts[1]) });
        logger.info('[XHS-UPLOAD] 20. file input.files[0].type', { type: parts[2] });
      } catch(_e){}
      result.found = true;
      result.pickedCount = 1;
      result.fileName = parts[0];
      result.fileSize = Number(parts[1]);
      result.skipped = 'already-uploaded';
    } else {
      // (7) CDP Page.setFileInputFiles —— 关键调用
      try {
        logger.info('[XHS-UPLOAD] 14. 点击上传按钮后是否触发文件选择事件', {
          trigger: 'CDP Page.setFileInputFiles（绕过原生 picker / 不弹系统对话框）',
          note: 'CDP 路径下没有用户点击；文件由 Chromium 内核直接写入 <input type=file>.files'
        });
        logger.info('[XHS-UPLOAD] 15. 文件选择事件最终返回的路径', {
          files: [filePath],
          note: 'CDP setFileInputFiles 调用参数；真实落盘到 input.files 由下方 ver 验证'
        });
        await dbg.send('Page.setFileInputFiles', {
          nodeId: nodeId,
          files: [filePath]
        });
        try { logger.info('[XHS] CDP Page.setFileInputFiles 已设置', { filePath: filePath, nodeId: nodeId }); } catch (_e) {}
        try {
          logger.info('[XHS-UPLOAD] 16. 文件是否真正设置到了 file input', {
            cdpReturn: 'ok（无 exception）',
            filesParam: [filePath]
          });
        } catch(_e){}
      } catch (setErr) {
        try {
          logger.error('[XHS-UPLOAD] 16. 文件是否真正设置到了 file input', {
            cdpReturn: 'FAILED',
            error: String((setErr && setErr.message) || setErr)
          });
        } catch(_e){}
        return _fail('cdp-set-files-failed:' + String((setErr && setErr.message) || setErr));
      }

      // (8) 手动 dispatch change 事件（React/Vue onChange 依赖 DOM 事件）
      try {
        var dispatched = await wc.executeJavaScript(
          '(function(){\n' +
          '  var inp=document.querySelector(\'input[type="file"]\');\n' +
          '  if(!inp)return "no-input";\n' +
          '  try { inp.dispatchEvent(new Event("input",  { bubbles: true, cancelable: true })); } catch(_e){}\n' +
          '  try { inp.dispatchEvent(new Event("change", { bubbles: true, cancelable: true })); } catch(_e){}\n' +
          '  return "dispatched";\n' +
          '})()',
          true
        );
        try { logger.info('[XHS] 已触发 input/change 事件', { dispatched: dispatched }); } catch (_e) {}
        // [XHS-UPLOAD] 21：dispatch 状态 + 17-20：dispatch 后 100ms 再 dump 一次 input.files
        try {
          logger.info('[XHS-UPLOAD] 21. 设置文件后是否触发 change/input 事件', {
            dispatched: dispatched,
            note: 'CDP setFileInputFiles 默认不派发 DOM 事件；这里手动 dispatchEvent(input) + dispatchEvent(change) 来唤醒 React/Vue onChange'
          });
          await new Promise(function (r) { setTimeout(r, 100); });
          var _u_after100 = await wc.executeJavaScript(
            "(function(){try{var inp=document.querySelector('input[type=\"file\"]');" +
            "if(!inp)return null;" +
            "var f=(inp.files&&inp.files[0])||null;" +
            "return f?{len:inp.files.length,name:f.name,size:f.size,type:f.type}:{len:0};" +
            "}catch(e){return {error:String(e.message||e)};}})()", true);
          logger.info('[XHS-UPLOAD] 17. file input.files.length（dispatch 后 100ms）', {
            length: _u_after100 && typeof _u_after100.len === 'number' ? _u_after100.len : '?'
          });
          logger.info('[XHS-UPLOAD] 18. file input.files[0].name', {
            name: (_u_after100 && _u_after100.name) || '(空)'
          });
          logger.info('[XHS-UPLOAD] 19. file input.files[0].size', {
            size: (_u_after100 && _u_after100.size) || 0
          });
          logger.info('[XHS-UPLOAD] 20. file input.files[0].type', {
            type: (_u_after100 && _u_after100.type) || '(空)'
          });
        } catch(_e){}
      } catch (e) {
        try { logger.warn('[XHS] dispatch change 异常（inner 未持久化；React 可能未触发）', { error: String((e && e.message) || e) }); } catch (_e) {}
      }

      // (9) 验证 input.files
      var ver;
      try {
        ver = await wc.executeJavaScript(
          '(function(){\n' +
          '  var inp=document.querySelector(\'input[type="file"]\');\n' +
          '  if(!inp)return {ok:false,reason:"no-input"};\n' +
          '  if(!inp.files||!inp.files.length)return {ok:false,reason:"no-files"};\n' +
          '  var f=inp.files[0];\n' +
          '  return {ok:true,name:f.name||"",size:f.size||0,type:f.type||""};\n' +
          '})()',
          true
        );
      } catch (_e) { ver = null; }
      if (!ver || !ver.ok) {
        try { logger.error('[XHS] input.files 验证失败', { ver: ver }); } catch (_e) {}
        return _fail('input-files-empty:' + (ver && ver.reason || 'unknown'));
      }
      try { logger.info('[XHS] 已注入视频文件', { name: ver.name, size: ver.size, type: ver.type }); } catch (_e) {}
      // [XHS-UPLOAD] 17-20：权威值（来源 ver，来自 CDP 调用后页面侧 querySelector）
      try {
        logger.info('[XHS-UPLOAD] 17. file input.files.length', { length: 1 });
        logger.info('[XHS-UPLOAD] 18. file input.files[0].name', { name: ver.name || '' });
        logger.info('[XHS-UPLOAD] 19. file input.files[0].size', { size: ver.size || 0 });
        logger.info('[XHS-UPLOAD] 20. file input.files[0].type', { type: ver.type || '' });
      } catch(_e){}
      result.found = true;
      result.pickedCount = 1;
      result.fileName = ver.name;
      result.fileSize = ver.size;
    }

    // (10) 等真实上传完成（DOM 信号，不依赖 setTimeout 单纯等 N 秒）
    try { logger.info('[XHS] 小红书视频上传已开始，等待页面 DOM 完成信号'); } catch (_e) {}
    try { logger.info('[XHS] 视频上传中'); } catch (_e) {}
    var deadline2 = Date.now() + 180000;
    var doneInfo = null;
    var _u_pollTick = 0;
    var _u_lastSnap = 0;
    while (Date.now() < deadline2) {
      var signal;
      _u_pollTick++;
      // [XHS-UPLOAD] 22 / 23：每 5 秒一次 DOM 状态快照（首次立即）
      var _u_now = Date.now();
      if (_u_now - _u_lastSnap >= 5000 || _u_pollTick === 1) {
        _u_lastSnap = _u_now;
        try {
          var _u_snap = await wc.executeJavaScript(
            "(function(){try{" +
            "var busy=document.querySelectorAll('[class*=\"progress\" i],[class*=\"uploading\" i],[class*=\"loading\" i],[class*=\"percent\" i]');" +
            "var busyVis=0;var busySample='';" +
            "for(var b=0;b<busy.length;b++){var r=busy[b].getBoundingClientRect();if(r.width>0&&r.height>0){busyVis++;if(!busySample)busySample=(busy[b].className||'').slice(0,80)+':'+(busy[b].innerText||'').slice(0,80);}}" +
            "var videos=document.querySelectorAll('video');" +
            "var hasVid=false;var vidSrc='';" +
            "for(var v=0;v<videos.length;v++){var s=videos[v].currentSrc||videos[v].src||'';if(s){vidSrc=s.slice(0,200);if(s.indexOf('blob:')!==0){hasVid=true;break;}}}" +
            "var aria100=document.querySelector('[role=\"progressbar\"][aria-valuenow=\"100\"]')!==null;" +
            "var successText=/上传成功|上传完成|已上传/i.test(document.body&&document.body.innerText||'');" +
            "return {busyVis:busyVis,busySample:busySample,hasVid:hasVid,vidSrc:vidSrc,aria100:aria100,successText:successText};" +
            "}catch(e){return {error:String(e.message||e)};}})()", true);
          logger.info('[XHS-UPLOAD] 22. 设置文件后页面是否出现视频预览', {
            hasVid: !(_u_snap && _u_snap.error) && !!(_u_snap && _u_snap.hasVid),
            vidSrc: (_u_snap && _u_snap.vidSrc) || '',
            snapError: (_u_snap && _u_snap.error) || '',
            pollTick: _u_pollTick
          });
          logger.info('[XHS-UPLOAD] 23. 是否出现上传进度/上传中状态', {
            busyVis: (_u_snap && _u_snap.busyVis) || 0,
            busySample: (_u_snap && _u_snap.busySample) || '',
            aria100: (_u_snap && _u_snap.aria100) || false,
            successText: (_u_snap && _u_snap.successText) || false,
            pollTick: _u_pollTick
          });
        } catch(_e){}
      }
      try {
        signal = await wc.executeJavaScript(
          '(function(){\n' +
          '  var busy=document.querySelectorAll(\'[class*="progress" i],[class*="uploading" i],[class*="loading" i],[class*="percent" i]\');\n' +
          '  var busyVis=0;\n' +
          '  for(var b=0;b<busy.length;b++){\n' +
          '    var r=busy[b].getBoundingClientRect();\n' +
          '    if(r.width>0 && r.height>0) busyVis++;\n' +
          '  }\n' +
          '  var videos=document.querySelectorAll("video");\n' +
          '  var hasVid=false;\n' +
          '  for(var v=0;v<videos.length;v++){\n' +
          '    var s=videos[v].currentSrc||videos[v].src||"";\n' +
          '    if(s && s.indexOf("blob:")!==0) { hasVid=true; break; }\n' +
          '  }\n' +
          '  var successText=/上传成功|上传完成|已上传/i.test(document.body && document.body.innerText || "");\n' +
          '  var aria100=document.querySelector(\'[role="progressbar"][aria-valuenow="100"]\')!==null;\n' +
          '  if(busyVis===0 && (hasVid||successText||aria100)){\n' +
          '    return {done:true, hasVid:hasVid, successText:successText, aria100:aria100, busyVis:busyVis};\n' +
          '  }\n' +
          '  return {done:false, busyVis:busyVis};\n' +
          '})()',
          true
        );
      } catch (_e) { signal = null; }
      if (signal && signal.done) { doneInfo = signal; break; }
      await new Promise(function (r) { setTimeout(r, 600); });
    }
    if (!doneInfo) {
      try { logger.error('[XHS] 视频上传失败：DOM 未在 180s 内显示预览/完成信号'); } catch (_e) {}
      try {
        logger.error('[XHS-UPLOAD] 24. 是否出现上传完成状态', {
          done: false,
          timeout: '180s',
          note: 'progress/uploading/loading 全部不可见 && (hasVid || successText || aria100) 始终为 false'
        });
      } catch (_e) {}
      return _fail('upload-not-confirmed');
    }

    // (11) 成功
    result.domDone = doneInfo;
    result.ok = true;
    result.elapsedMs = Date.now() - startedAt;
    try { logger.info('[XHS] 视频上传完成', { domDone: doneInfo, filePath: filePath, elapsedMs: result.elapsedMs }); } catch (_e) {}
    try {
      logger.info('[XHS-UPLOAD] 24. 是否出现上传完成状态', {
        done: true,
        hasVid: !!(doneInfo && doneInfo.hasVid),
        successText: !!(doneInfo && doneInfo.successText),
        aria100: !!(doneInfo && doneInfo.aria100),
        domDone: doneInfo
      });
    } catch (_e) {}
    try { logger.info('[XHS] 视频已准备好，请手动点击发布'); } catch (_e) {}
    return result;

  } finally {
    // (12) detach debugger
    if (attached && dbg && dbg.isAttached && dbg.isAttached()) {
      try { dbg.detach(); } catch (_e) {}
      try { logger.info('[XHS] webContents.debugger 已断开'); } catch (_e) {}
    }
  }
}

function _xhsBlock(title, lines) {
  var out = '\n========== ' + title + ' ==========\n';
  if (Array.isArray(lines)) for (var i = 0; i < lines.length; i++) out += lines[i] + '\n';
  out += '==========================================\n';
  return out;
}
function _xhsLogBlock(title, lines) {
  // v1.4：详细日志默认静音（仅 XHS_DEBUG=1 时输出）
  if (!_xhsDebug()) return;
  // 单行 logger.info（rokit.log 友好），附带原始 multi-line 文本
  var text = _xhsBlock(title, lines);
  try { logger.info('[XHS-OBSERVER] ' + title + ':' + text); } catch (_e) {}
}
function _xhsLogKV(tag, kv) {
  // v1.4：详细日志默认静音（仅 XHS_DEBUG=1 时输出）
  if (!_xhsDebug()) return;
  try { logger.info('[XHS-OBSERVER] ' + tag + ' ' + JSON.stringify(kv || {})); } catch (_e) {}
}
// 缓存上一次 selector 元素 / dom 观察器（仅用于重注入）
let _xhsObserverScriptCache = null;
function _getXhsObserverScript() {
  if (_xhsObserverScriptCache !== null) return _xhsObserverScriptCache;
  try {
    var mod = require('./browser/platforms/xiaohongshu/XhsObserverScript');
    if (mod && typeof mod.buildXhsObserverScript === 'function') {
      _xhsObserverScriptCache = mod.buildXhsObserverScript();
      return _xhsObserverScriptCache;
    }
  } catch (e) {
    logger.warn('[XHS-OBSERVER] load observer script failed', { error: String((e && e.message) || e) });
  }
  _xhsObserverScriptCache = '';
  return _xhsObserverScriptCache;
}
async function _xhsReinjectsObserver(win) {
  try {
    if (!win || win.isDestroyed()) return;
    var wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (!_xhsUrlMatch(wc.getURL())) return;
    var script = _getXhsObserverScript();
    if (!script) return;
    // v1.3：观察器脚本是函数表达式 "(function(){...})"，必须包一层 () 调用，
    //   否则 executeJavaScript 会把"函数引用"作为返回值传回主进程，
    //   触发 IPC structured clone 失败（"An object could not be cloned"）。
    //   经过 () 包裹后，真正 IIFE 调用，V8 返回的是 "observer-started" 字符串。
    await wc.executeJavaScript('(' + script + ')()');
    _xhsLogKV('REINJECT', { url: wc.getURL(), title: wc.getTitle(), webContentsId: wc.id, windowId: win.id });
  } catch (e) {
    try { logger.warn('[XHS-OBSERVER] reinject failed', { error: String((e && e.message) || e) }); } catch (_e) {}
  }
}
// v1.1：输出 XHS PUBLISH WINDOW 诊断块（异步，因为 counts 要在页面 context 里取）
// v1.4：默认仅输出 [XHS] 发布页已显示；详细元素统计仅在 XHS_DEBUG=1 时执行
// v1.5：「发布页已就绪」→「发布页已显示」，强调窗口已被强制 focus 到用户眼前
async function _tryOutputPublishWindowBlock(win, requestedUrl) {
  try {
    if (!win || win.isDestroyed()) return;
    var wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    var finalUrl = '';
    var finalTitle = '';
    try { finalUrl = wc.getURL() || ''; } catch (_e) {}
    try { finalTitle = wc.getTitle() || ''; } catch (_e) {}
    if (_xhsDebug()) {
      // DEBUG：保留原统计块（input / textarea / contenteditable / file / button / dialog 数量）
      await new Promise(function (resolve) { setTimeout(resolve, 400); });
      if (!win || win.isDestroyed()) return;
      if (!wc || wc.isDestroyed()) return;
      var countsSrc = '';
      try {
        countsSrc = await wc.executeJavaScript(
          "(function(){try { return JSON.stringify({inputs:document.querySelectorAll('input').length," +
            "textareas:document.querySelectorAll('textarea').length," +
            "contenteditables:document.querySelectorAll('[contenteditable=\"true\"]').length," +
            "fileInputs:document.querySelectorAll('input[type=\"file\"]').length," +
            "buttons:document.querySelectorAll('button').length," +
            "dialogs:document.querySelectorAll('dialog,[role=\"dialog\"]').length," +
            "title:document.title||''}); } catch(e) { return ''; }})()");
      } catch (_e) { countsSrc = ''; }
      var parsed = null;
      try { parsed = countsSrc ? JSON.parse(countsSrc) : null; } catch (_e) { parsed = null; }
      var lines = [
        'TIME: ' + new Date().toISOString(),
        'REQUESTED URL: ' + (requestedUrl || ''),
        'URL: ' + (finalUrl || ''),
        'TITLE: ' + (finalTitle || ''),
        'WINDOW ID: ' + (win.id || ''),
        'WEB CONTENTS ID: ' + (wc.id || ''),
        'INPUT COUNT: ' + ((parsed && parsed.inputs != null) ? parsed.inputs : 'n/a'),
        'TEXTAREA COUNT: ' + ((parsed && parsed.textareas != null) ? parsed.textareas : 'n/a'),
        'CONTENTEDITABLE COUNT: ' + ((parsed && parsed.contenteditables != null) ? parsed.contenteditables : 'n/a'),
        'FILE INPUT COUNT: ' + ((parsed && parsed.fileInputs != null) ? parsed.fileInputs : 'n/a'),
        'BUTTON COUNT: ' + ((parsed && parsed.buttons != null) ? parsed.buttons : 'n/a'),
        'DIALOG COUNT: ' + ((parsed && parsed.dialogs != null) ? parsed.dialogs : 'n/a')
      ];
      _xhsLogBlock('XHS PUBLISH WINDOW', lines);
    } else {
      // 默认：仅一行关键日志（v1.5：改名为「已显示」，强调窗口确实在前台可被用户看到）
      try { logger.info('[XHS] 发布页已显示'); } catch (_e) {}
    }
    // 主动加载成功后清掉 pending 标记
    if (requestedUrl) _consumeXhsPublishLoadExpected(requestedUrl);
  } catch (e) {
    try { logger.warn('[XHS-OBSERVER] output publish window block failed', { error: String((e && e.message) || e) }); } catch (_e) {}
  }
}
// v1.2：触发输出 XHS PUBLISH WINDOW 块（含去重）
//   - 来源 1：ensurePubWin 的 did-finish-load（成功路径，URL/title 已经稳定）
//   - 来源 2：setWindowOpenHandler 的 loadURL().then() 兼容路径（保留，但不依赖它读取 URL）
//   - 去重：1500ms 内不重复输出，避免 SPA / 多次 did-finish-load 刷屏
function _emitXhsPublishWindowBlock(win, requestedUrl) {
  try {
    if (!_tryConsumePublishBlockDedup()) {
      // 已输出过（1500ms 内），只清掉 expected 标记，不再触发 _tryOutputPublishWindowBlock
      if (requestedUrl) _consumeXhsPublishLoadExpected(requestedUrl);
      return;
    }
    if (requestedUrl) _consumeXhsPublishLoadExpected(requestedUrl);
    _tryOutputPublishWindowBlock(win, requestedUrl || (isPubWinAlive(win) ? win.webContents.getURL() : ''));
  } catch (_e) {}
}
// v1.4：发布页加载失败 —— 默认只输出一行 warn，详细块仅在 DEBUG 模式下输出
function _outputXhsPublishLoadFailed(requestedUrl, finalUrl, title, errorCode, errorDescription) {
  try {
    try { logger.warn('[XHS] 发布页加载失败', { url: requestedUrl, code: errorCode, error: errorDescription }); } catch (_e) {}
    _xhsLogBlock('XHS PUBLISH LOAD FAILED', [
      'TIME: ' + new Date().toISOString(),
      'REQUESTED URL: ' + (requestedUrl || ''),
      'FINAL URL: ' + (finalUrl || ''),
      'TITLE: ' + (title || ''),
      'ERROR CODE: ' + (errorCode == null ? 'UNKNOWN' : String(errorCode)),
      'ERROR DESCRIPTION: ' + (errorDescription || '')
    ]);
  } catch (_e) {}
}

function installXhsObserverHooks(win) {
  if (!win) return;
  if (win.__xhsObserverHooksInstalled) return;
  win.__xhsObserverHooksInstalled = true;

  var wc = win.webContents;
  if (!wc) return;

  // v2.2-DIAG：点击事件诊断（一次性主进程侧事件绑定；页面端注入见 did-finish-load）
  try { _xhsAttachClickDiag(win); } catch (_e) {}

  // ---- 1) console-message：把 [XHS-PAGE] 前缀的页面日志转发到主 logger ----
  // v1.4：仅在 XHS_DEBUG=1 时转发页面端日志（默认静音 OBSERVER_MODE / BASELINE / NAVIGATION / DOM CHANGE 等）
  try {
    wc.on('console-message', function (_event, level, message, line, sourceId) {
      try {
        var text = (typeof message === 'string') ? message : String(message || '');
        // v1.4：[XHS-PAGE] 前缀：仅 DEBUG 模式转发
        if (text.indexOf('[XHS-PAGE]') === 0) {
          if (!_xhsDebug()) return; // DEBUG 关闭时不转发任何 [XHS-PAGE] 行
          // level: 0=verbose 2=warning 3=error
          var lv = level >= 3 ? 'error' : (level === 2 ? 'warn' : 'info');
          try { logger[lv]('[XHS-PAGE] ' + text); } catch (_e) {}
          return;
        }
        // v3.1：[XHS*] 通用前缀：始终转发（小红书发布阶段用户可见的进度日志）
        //   v1.7-v3.0 曾经用 'text.indexOf('[XHS]') === 0'（严格 [XHS] 前缀），
        //   但这样会吞掉 [XHS-CONTENT] / [XHS-UPLOAD] 等其他 XHS 子标签的页面端 console.log
        //   （它们以 [XHS- 开头，找不到 [XHS] 这个 5 字符子串）。
        //   修复：放行所有以 [XHS 开头的页面日志（[XHS] / [XHS-PAGE] 已在上面过 各自规则，
        //   [XHS-DIAG] 在下面，这里只补 [XHS-CONTENT] / [XHS-UPLOAD] / 未来新增的子标签）。
        if (text.indexOf('[XHS') === 0) {
          var lv2 = level >= 3 ? 'error' : (level === 2 ? 'warn' : 'info');
          try { logger[lv2](text); } catch (_e) {}
          return;
        }
        // v2.2：[XHS-DIAG] 前缀：点击事件诊断（始终转发，便于排查"手动点击上传后无日志"问题）
        if (text.indexOf('[XHS-DIAG]') === 0) {
          var lv3 = level >= 3 ? 'error' : (level === 2 ? 'warn' : 'info');
          try { logger[lv3](text); } catch (_e) {}
          return;
        }
      } catch (_e) {}
    });
  } catch (_e) {}

  // ---- 2) 导航事件：did-start-navigation ----
  try {
    wc.on('did-start-navigation', function (_event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
      if (!_xhsUrlMatch(url)) return;
      _xhsLogBlock('XHS NAVIGATION', [
        'EVENT: did-start-navigation',
        'TIME: ' + new Date().toISOString(),
        'OLD URL: ' + (wc.getURL() || ''),
        'NEW URL: ' + (url || ''),
        'TITLE: ' + (wc.getTitle() || ''),
        'IS IN PLACE: ' + (isInPlace ? 'yes' : 'no'),
        'IS MAIN FRAME: ' + (isMainFrame ? 'yes' : 'no')
      ]);
    });
  } catch (_e) {}

  // ---- 3) did-navigate ----
  try {
    wc.on('did-navigate', function (_event, url, httpResponseCode, httpStatusText) {
      if (!_xhsUrlMatch(url)) return;
      _xhsLogBlock('XHS NAVIGATION', [
        'EVENT: did-navigate',
        'TIME: ' + new Date().toISOString(),
        'OLD URL: (previous page)',
        'NEW URL: ' + (url || ''),
        'TITLE: ' + (wc.getTitle() || ''),
        'HTTP STATUS: ' + (httpResponseCode || '?') + ' ' + (httpStatusText || '')
      ]);
    });
  } catch (_e) {}

  // ---- 4) did-navigate-in-page（仅主帧）----
  try {
    wc.on('did-navigate-in-page', function (_event, url, isMainFrame) {
      if (!_xhsUrlMatch(url)) return;
      if (!isMainFrame) return;
      _xhsLogBlock('XHS NAVIGATION', [
        'EVENT: did-navigate-in-page',
        'TIME: ' + new Date().toISOString(),
        'NEW URL: ' + (url || ''),
        'TITLE: ' + (wc.getTitle() || '')
      ]);
    });
  } catch (_e) {}

  // ---- 5) did-frame-navigate（任意 frame）----
  try {
    wc.on('did-frame-navigate', function (_event, url, httpResponseCode, httpStatusText, isMainFrame, frameProcessId) {
      if (!_xhsUrlMatch(url)) return;
      _xhsLogBlock('XHS NAVIGATION', [
        'EVENT: did-frame-navigate',
        'TIME: ' + new Date().toISOString(),
        'NEW URL: ' + (url || ''),
        'TITLE: ' + (wc.getTitle() || ''),
        'IS MAIN FRAME: ' + (isMainFrame ? 'yes' : 'no'),
        'HTTP STATUS: ' + (httpResponseCode || '?') + ' ' + (httpStatusText || '')
      ]);
    });
  } catch (_e) {}

  // ---- 6) page-title-updated ----
  try {
    wc.on('page-title-updated', function (_event, title, explicitSet) {
      var url = '';
      try { url = wc.getURL(); } catch (_e) {}
      if (!_xhsUrlMatch(url)) return;
      _xhsLogBlock('XHS NAVIGATION', [
        'EVENT: page-title-updated',
        'TIME: ' + new Date().toISOString(),
        'URL: ' + (url || ''),
        'NEW TITLE: ' + (title || ''),
        'EXPLICIT SET: ' + (explicitSet ? 'yes' : 'no')
      ]);
    });
  } catch (_e) {}

  // ---- 7) did-finish-load：补一条 NAVIGATION + 重新注入观察器 ----
  try {
    wc.on('did-finish-load', function () {
      var url = '';
      var title = '';
      try { url = wc.getURL(); } catch (_e) {}
      try { title = wc.getTitle(); } catch (_e) {}
      if (!_xhsUrlMatch(url)) return;
      _xhsLogBlock('XHS NAVIGATION', [
        'EVENT: did-finish-load',
        'TIME: ' + new Date().toISOString(),
        'URL: ' + (url || ''),
        'TITLE: ' + (title || '')
      ]);
      // 重新注入页面端观察器（页面整体替换时 JS 上下文被清空，需要重新挂）
      _xhsReinjectsObserver(win);
      // v2.2-DIAG：点击事件诊断（页面端：file input dump + MutationObserver + click capture）
      try { _xhsReinjectsClickDiag(win); } catch (_e) {}
    });
  } catch (_e) {}

  // ---- 8) new-window / setWindowOpenHandler ----
  try {
    wc.on('new-window', function (event, url, frameName, disposition, options, additionalFeatures) {
      try {
        // 不拦截、不阻止 — 仅观察
        if (!_xhsUrlMatch(url)) return;
        var winInfo = {
          url: url,
          frameName: frameName,
          disposition: disposition,
          webContentsId: 'options.createdWebContents ? options.createdWebContents.id : null'
        };
        _xhsLogBlock('XHS NEW WINDOW', [
          'TIME: ' + new Date().toISOString(),
          'URL: ' + (url || ''),
          'FRAME NAME: ' + (frameName || ''),
          'DISPOSITION: ' + (disposition || ''),
          'FEATURES: ' + JSON.stringify(additionalFeatures || {})
        ]);
      } catch (_e) {}
    });
  } catch (_e) {}
  try {
    // v1.1：小红书「发布页」特殊处理 —— 必须继续在 Electron 内置浏览器里打开
    //   - 其他 xhs URL：维持「仅观察 + 默认 allow」行为，不影响小窗/登录页等
    //   - creator.xiaohongshu.com/publish/publish：在当前 pubWin 内 loadURL（复用窗口），
    //     并返回 { action: 'deny' } 阻止 Electron 创建不可控的新 BrowserWindow
    //   - 不调用 shell.openExternal，绝不使用系统浏览器
    wc.setWindowOpenHandler(function (details) {
      try {
        var openUrl = (details && details.url) || '';
        if (!_xhsUrlMatch(openUrl)) {
          // 非小红书 URL：维持默认 allow（不影响其他平台窗口）
          return { action: 'allow' };
        }
        // DEBUG：详细 setWindowOpenHandler 元数据
        _xhsLogBlock('XHS NEW WINDOW', [
          'TIME: ' + new Date().toISOString(),
          'SOURCE: setWindowOpenHandler',
          'URL: ' + openUrl,
          'FRAME NAME: ' + ((details && details.frameName) || ''),
          'FEATURES: ' + JSON.stringify((details && details.features) || {})
        ]);
        // 只对 creator.xiaohongshu.com/publish/publish 做"在当前 pubWin 里打开发布页"动作
        if (!_isXhsPublishUrl(openUrl)) {
          return { action: 'allow' };
        }
        // v1.5：必须先把 pubWin 准备好 —— 不再"不可用就 deny"导致用户看不到任何东西
        //   - pubWin 不存在 / 被销毁：自动 ensurePubWin() 创建（使用 persist:pub 持久化登录态）
        //   - pubWin 存在：什么都不做，下面的 _focusPubWin() 会处理显示
        if (!pubWin || !isPubWinAlive(pubWin)) {
          try {
            pubWin = ensurePubWin();
          } catch (createErr) {
            _outputXhsPublishLoadFailed(
              openUrl, '', '',
              'WINDOW_UNAVAILABLE',
              'ensurePubWin 创建/复用小红书 BrowserWindow 失败：' + String((createErr && createErr.message) || createErr)
            );
            return { action: 'deny' };
          }
        }
        // 二次校验：ensurePubWin 在极端情况下可能仍返回 null
        if (!pubWin || !isPubWinAlive(pubWin)) {
          _outputXhsPublishLoadFailed(
            openUrl, '', '',
            'WINDOW_UNAVAILABLE',
            '小红书 BrowserWindow (pubWin) 不可用，无法在 Electron 内置浏览器中打开发布页'
          );
          return { action: 'deny' };
        }
        // 同一个窗口里打开发布页（URL 已经在 pubWin 内，避免 shell.openExternal）
        _markXhsPublishLoadExpected(openUrl);
        // v1.4：业务关键日志（顺序与上一轮一致）
        try { logger.info('[XHS] 检测到发布请求'); } catch (_e) {}
        try { logger.info('[XHS] 发布页：' + openUrl); } catch (_e) {}
        // v1.5：先把窗口拉到最前 —— 用户点「发布」时可能 pubWin 被遮挡/最小化，
        //   立即 show/focus 让用户能直观看到窗口被"切回来"，而不是等 loadURL 完成。
        _focusPubWin(pubWin);
        // DEBUG：详细 request 块
        _xhsLogBlock('XHS PUBLISH WINDOW REQUEST', [
          'TIME: ' + new Date().toISOString(),
          'REQUESTED URL: ' + openUrl,
          'ACTION: loadURL on existing pubWin (reuse same Electron window)',
          'TARGET WINDOW ID: ' + (pubWin.id || ''),
          'TARGET WEB CONTENTS ID: ' + (pubWin.webContents.id || '')
        ]);
        // 异步执行 loadURL，避免在 setWindowOpenHandler 同步上下文中抛错
        setImmediate(function () {
          try {
            if (!isPubWinAlive(pubWin)) {
              _outputXhsPublishLoadFailed(
                openUrl, '', '',
                'WINDOW_DESTROYED',
                'pubWin 在 loadURL 之前已被销毁'
              );
              _clearXhsPublishLoadExpected();
              return;
            }
            // setImmediate 再拉一次焦点（防止同步阶段 mainWindow 又抢了焦点）
            _focusPubWin(pubWin);
            try { logger.info('[XHS] 正在打开发布页'); } catch (_e) {}
            pubWin.loadURL(openUrl).then(function () {
              // v1.2：loadURL resolved，但 URL 切换通常要等到 did-finish-load。
              //   此时直接读 wc.getURL() 经常会得到未变化的旧 URL（旧 bug），
              //   所以这里不输出 XHS PUBLISH WINDOW 块，改为依赖 did-finish-load 路径。
              //   只需要清掉 expected 标记 + 再次拉焦点（小红书 SPA 自己抢焦点）。
              _consumeXhsPublishLoadExpected(openUrl);
              if (isPubWinAlive(pubWin)) _focusPubWin(pubWin);
              // DEBUG：详细 resolved 块
              _xhsLogKV('PUBLISH LOAD RESOLVED', { url: openUrl, currentUrl: pubWin.webContents.getURL() || null });
            }).catch(function (loadErr) {
              var msg = String((loadErr && loadErr.message) || loadErr || '');
              _outputXhsPublishLoadFailed(
                openUrl,
                isPubWinAlive(pubWin) ? (pubWin.webContents.getURL() || '') : '',
                isPubWinAlive(pubWin) ? (pubWin.webContents.getTitle() || '') : '',
                'LOAD_URL_REJECTED',
                msg
              );
              _clearXhsPublishLoadExpected();
            });
          } catch (innerErr) {
            _outputXhsPublishLoadFailed(
              openUrl, '', '',
              'UNEXPECTED',
              String((innerErr && innerErr.message) || innerErr)
            );
            _clearXhsPublishLoadExpected();
          }
        });
        // 阻止 Electron 自动创建新 BrowserWindow / 新 webView
        return { action: 'deny' };
      } catch (_e) {}
      // 兜底：保留默认 allow（理论上到不了这里）
      return { action: 'allow' };
    });
  } catch (_e) {}

  // ---- 9) session.web-contents-created：检测新 WebContents ----
  try {
    var ses = wc.session;
    if (ses && typeof ses.on === 'function' && !ses.__xhsWCInstalled) {
      ses.__xhsWCInstalled = true;
      ses.on('web-contents-created', function (_event, childContents, _details) {
        try {
          var childUrl = '';
          try { childUrl = childContents.getURL(); } catch (_e) {}
          var childType = '';
          try { childType = childContents.getType(); } catch (_e) {}
          if (!_xhsUrlMatch(childUrl)) return;
          _xhsLogBlock('XHS NEW WEB CONTENTS', [
            'TIME: ' + new Date().toISOString(),
            'URL: ' + (childUrl || ''),
            'TYPE: ' + (childType || ''),
            'WEB CONTENTS ID: ' + (childContents.id || '')
          ]);
          // 转发子 WebContents 的 console-message 与新窗口事件（递归）
          // v1.4：DEBUG 关闭时不转发子 WebContents 的 [XHS-PAGE] 行
          try {
            childContents.on('console-message', function (_e, level, message) {
              try {
                var text = (typeof message === 'string') ? message : String(message || '');
                if (text.indexOf('[XHS-PAGE]') === 0) {
                  if (!_xhsDebug()) return;
                  var lv = level >= 3 ? 'error' : (level === 2 ? 'warn' : 'info');
                  try { logger[lv]('[XHS-PAGE] ' + text); } catch (_e) {}
                }
              } catch (_e) {}
            });
          } catch (_e) {}
          try {
            childContents.on('did-finish-load', function () {
              var u = '';
              var t = '';
              try { u = childContents.getURL(); } catch (_e) {}
              try { t = childContents.getTitle(); } catch (_e) {}
              if (!_xhsUrlMatch(u)) return;
              _xhsLogBlock('XHS NAVIGATION', [
                'EVENT: did-finish-load (child webContents)',
                'TIME: ' + new Date().toISOString(),
                'URL: ' + (u || ''),
                'TITLE: ' + (t || ''),
                'WEB CONTENTS ID: ' + (childContents.id || '')
              ]);
              // 在子 WebContents 里也注入观察器（v1.3：包一层 () 调用，避免返回函数引用）
              try {
                var script = _getXhsObserverScript();
                if (script) {
                  childContents.executeJavaScript('(' + script + ')()');
                }
              } catch (_e) {}
            });
          } catch (_e) {}
        } catch (_e) {}
      });
    }
  } catch (_e) {}
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
      // v3.0：小红书在 launch 之前先富化 payload：videoAssetId → videoDataUrl
      //   _enrichXhsPayloadForFill 已经在 main.js:838 定义，但前几轮没人调它，
      //   导致 a.fill(payload) 拿到的 payload.videoDataUrl 始终是 null。
      //   这里加一次调用，a.fill IIFE 内的 fetchToBlob 才有 data URL 可读。
      if (platformId === 'xiaohongshu') {
        try {
          _enrichXhsPayloadForFill(payload);
          try { logger.info('[XHS-UPLOAD] PUBEXEC-FILL 富化完成', {
            videoAssetId: (payload && payload.videoAssetId) || '',
            videoDataUrlLen: ((payload && payload.videoDataUrl) || '').length,
            videoUploadSkipped: !!(payload && payload.videoUploadSkipped),
            note: 'videoDataUrlLen > 0 表示 base64 dataUrl 已生成；否则 a.fill 会跳过自动上传并提示用户手动选文件'
          }); } catch (_e) {}
        } catch (enrichErr) {
          try { logger.warn('[XHS-UPLOAD] PUBEXEC-FILL 富化抛错（继续走 a.fill，由 IIFE 内部 fallback）', { error: String((enrichErr && enrichErr.message) || enrichErr) }); } catch (_e) {}
        }
      }
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

      // v3.0：所有平台（包括小红书）统一走 a.fill(payload) IIFE 路径。
      //   小红书的 a.fill()（publishers.js:xiaohongshu.fill）已完整实现：
      //     videoAssetId → videoDataUrl → DataTransfer → input.files → 等 DOM 上传完成信号。
      //   修复原因：原 "if xiaohongshu 走 CDP" 分支从未真正被触发（前几轮用户日志里
      //   完全没有 [XHS-UPLOAD] 即可证明 CDP 路径没跑）；改回统一路径后，
      //   a.fill IIFE 内部的 console.log("[XHS] ...") 会经 console-message 监听器
      //   转发到 rokit.log，最终用户能看到 [XHS] 发布页已加载 / 正在上传视频 / 视频上传完成 等关键节点。
      //   备注：_xhsUploadVideoViaCdp / _runXhsDiagnosticProbe 函数仍保留在 main.js 内
      //   （死代码），不删以便未来需要 CDP 诊断时可一键切回。
      var r1;
      try {
        if (platformId === 'xiaohongshu') {
          // [XHS-UPLOAD] 入口：a.fill(payload) IIFE 即将注入到 XHS 页面
          try {
            var _u_iife = (a.fill && typeof a.fill === 'function') ? a.fill(payload) : '';
            logger.info('[XHS-UPLOAD] PUBEXEC-FILL 进入 xiaohongshu 分支', {
              payloadTitle: (payload && payload.title) || '',
              payloadBodyLen: ((payload && payload.body) || '').length,
              videoAssetId: (payload && payload.videoAssetId) || '',
              videoDataUrlLen: ((payload && payload.videoDataUrl) || '').length,
              videoUploadSkipped: !!(payload && payload.videoUploadSkipped),
              videoName: (payload && payload.videoName) || '',
              videoMime: (payload && payload.videoMime) || '',
              fillIIFELen: _u_iife.length,
              fillIIFEPreview: _u_iife.slice(0, 120),
              note: 'IIFE 长度 > 0 表示 a.fill() 成功构造了字符串；下一步 executeJavaScript 会注入到 XHS 页面'
            });
          } catch (_e) {
            try { logger.warn('[XHS-UPLOAD] PUBEXEC-FILL 入口日志异常', { error: String(_e && _e.message || _e) }); } catch (_e2) {}
          }
        }
        // await #2：executeJavaScript —— 同样的窗口销毁风险
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
      if (platformId === 'xiaohongshu') {
        // [XHS-UPLOAD] 出口：IIFE 已返回，r1 即为 a.fill 的最后 return 对象
        try {
          logger.info('[XHS-UPLOAD] PUBEXEC-FILL xiaohongshu 分支 IIFE 返回', {
            ok: r1 ? r1.ok : null,
            found: r1 ? r1.found : null,
            pickedCount: r1 ? r1.pickedCount : null,
            elapsedMs: r1 ? r1.elapsedMs : null,
            attempts: r1 ? r1.attempts : null,
            error: (r1 && r1.error) || '',
            fileName: (r1 && r1.fileName) || '',
            domDone: (r1 && r1.domDone) || null,
            videoUploadSkipped: (r1 && r1.videoUploadSkipped) || false,
            note: 'r1 来自 a.fill 内部 IIFE 的最后 return r；ok=true 表示文件已成功注入 input.files 并等到了 DOM 完成信号'
          });
        } catch (_e) {
          try { logger.warn('[XHS-UPLOAD] PUBEXEC-FILL 出口日志异常', { error: String(_e && _e.message || _e) }); } catch (_e2) {}
        }
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
