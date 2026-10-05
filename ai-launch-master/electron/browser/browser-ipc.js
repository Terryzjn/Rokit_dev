// Rokit · 浏览器框架 IPC 注册（v1.7）
// ----------------------------------------------------------------
// 与需求文档十七、二十一、二十二条对应：
//   - 命名空间统一为 "browser:*"，不与现有 "pub:*" 冲突。
//   - Renderer **不能** 直接控制 BrowserWindow 的私有属性（如 webContents），
//     只能通过有限的高层 API（open / close / navigate / fill / status）。
//   - 不向 Renderer 暴露 Node API 或 Electron BrowserWindow 对象。
//   - 绝不通过 IPC 把 Cookie / 密码 / token 等敏感数据回传。
'use strict';

const logger = require('../logger');
const PublisherRegistry = require('./PublisherRegistry');

// 构造一个统一的发布流程入口（openPlatform → navigate publishUrl → 登录等待（首次） → prepareContent → banner）
// 不再点击最终发布按钮（与需求文档第十五条对应）。
async function runPublish(browserManager, platformId, fillData) {
  var id = String(platformId);
  // 1) 通过 registry 拿 platform config（loginUrl/publishUrl/selectors/loginConfig）
  var pub = PublisherRegistry.instantiate(id, { browserManager: browserManager });
  // 2) 打开窗口（首次）
  await browserManager.openPlatform(id);
  // 3) 检测登录态
  var status = await pub.checkLoginStatus();
  logger.info('[Publisher] Checking login status', { platformId: id, status: status });
  if (status !== 'logged_in') {
    // 打开登录页（如配置了 loginUrl）
    if (pub.loginUrl) {
      try { await browserManager.navigate(id, pub.loginUrl); }
      catch (e) {
        return { ok: false, stage: 'open-login', error: String((e && e.message) || e) };
      }
    }
    // 等待登录（带超时）
    try {
      await pub.waitForLogin();
      logger.info('[Publisher] Login detected', { platformId: id });
    } catch (e) {
      return { ok: false, stage: 'wait-login', error: String((e && e.message) || e),
               note: '请在内置浏览器中登录该平台，登录后重新点击「发射」。' };
    }
  }
  // 4) 跳转到 publishUrl
  if (!pub.publishUrl) {
    return { ok: false, stage: 'open-publish', error: 'Publisher 未配置 publishUrl' };
  }
  try { await browserManager.navigate(id, pub.publishUrl); }
  catch (e) { return { ok: false, stage: 'navigate-publish', error: String((e && e.message) || e) }; }
  // 5) 自动填充（不点最终发布）
  var fillResult;
  try { fillResult = await pub.prepareContent(fillData || {}); }
  catch (e) { return { ok: false, stage: 'fill', error: String((e && e.message) || e) }; }
  logger.info('[Publisher] Content preparation completed', {
    platformId: id,
    filled: fillResult && fillResult.filled
  });
  return { ok: true, stage: 'filled', platformId: id, fill: fillResult,
           note: '内容已自动填充，请手动点击「发布/投稿/提交」按钮确认。' };
}

function registerBrowserIpc(ipcMain, opts) {
  opts = opts || {};
  var browserManager = opts.browserManager;
  if (!browserManager) throw new Error('registerBrowserIpc: 缺少 browserManager');

  // 1) browser:open —— 打开平台窗口
  ipcMain.handle('browser:open', async (_e, platformId) => {
    try {
      var r = await browserManager.openPlatform(String(platformId || ''));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // 2) browser:close —— 关闭平台窗口
  ipcMain.handle('browser:close', async (_e, platformId) => {
    try {
      var ok = await browserManager.closePlatform(String(platformId || ''));
      return { ok: !!ok };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 3) browser:status —— 列出所有窗口
  ipcMain.handle('browser:status', async () => {
    try { return { ok: true, list: browserManager.status() }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 3.5) browser:diagnostics —— v1.10 白屏定位专用：返回某平台窗口的最近诊断事件
  //      用于「V2EX 打开是空白页面，根本没拿到 URL」时定位根因
  //      （did-fail-load 的 errorCode、render-process-gone 的 reason、
  //      console-message 的 4xx/5xx 等都会被记录下来）。
  ipcMain.handle('browser:diagnostics', async (_e, platformId) => {
    try {
      var d = browserManager.getDiagnostics(String(platformId || ''));
      return { ok: true, ...d };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 4) browser:navigate —— 导航
  ipcMain.handle('browser:navigate', async (_e, platformId, url) => {
    try {
      await browserManager.navigate(String(platformId || ''), String(url || ''));
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 5) browser:execute —— 在网页里执行 JS（IIFE 字符串）
  // 谨慎使用：执行任意脚本可能引入 XSS。仅供「调试/测试平台」使用；
  // 测试平台默认不向 Renderer 暴露 execute（避免被滥用）。
  ipcMain.handle('browser:execute', async (_e, platformId, script) => {
    // 仅允许 explicit list 中的 platformId 执行任意脚本
    var allowExecute = Array.isArray(opts.allowExecutePlatforms) ? opts.allowExecutePlatforms : [];
    if (allowExecute.indexOf(String(platformId || '')) < 0) {
      return { ok: false, error: 'execute not allowed for platform: ' + platformId };
    }
    try {
      var r = await browserManager.execute(String(platformId || ''), String(script || ''));
      return { ok: true, result: r };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 6) browser:login-status —— 平台登录状态
  ipcMain.handle('browser:login-status', async (_e, platformId) => {
    try {
      var pub = PublisherRegistry.instantiate(String(platformId || ''), { browserManager: browserManager });
      var status = await pub.checkLoginStatus();
      return { ok: true, status: status };
    } catch (e) { return { ok: false, error: String((e && e.message) || e), status: 'unknown' }; }
  });

  // 7) browser:fill —— 仅填充（不打开 publishUrl，不点击）
  ipcMain.handle('browser:fill', async (_e, platformId, fillData) => {
    try {
      var pub = PublisherRegistry.instantiate(String(platformId || ''), { browserManager: browserManager });
      await browserManager.openPlatform(String(platformId || ''));
      var result = await pub.prepareContent(fillData || {});
      return { ok: true, ...result };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 8) browser:publish —— 完整流程入口
  ipcMain.handle('browser:publish', async (_e, platformId, fillData) => {
    try {
      var r = await runPublish(browserManager, String(platformId || ''), fillData || {});
      return r;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 9) browser:destroy-session —— 清空平台登录态
  ipcMain.handle('browser:destroy-session', async (_e, platformId) => {
    try {
      await browserManager.closePlatform(String(platformId || ''));
      var ok = await browserManager.destroySession(String(platformId || ''));
      return { ok: !!ok };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  logger.info('[BrowserManager] IPC registered', {
    channels: [
      'browser:open', 'browser:close', 'browser:status', 'browser:navigate',
      'browser:execute', 'browser:login-status', 'browser:fill',
      'browser:publish', 'browser:destroy-session',
      'browser:diagnostics'
    ]
  });
}

module.exports = {
  registerBrowserIpc: registerBrowserIpc,
  runPublish: runPublish
};