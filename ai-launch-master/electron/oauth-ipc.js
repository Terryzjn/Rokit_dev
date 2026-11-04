// Rokit · OAuth IPC 注册
// 从 main.js 抽出的 oauth:* 八个通道；oauth / oauthNet / logger 均由调用方注入，
// 不直接依赖 Electron 或 keytar，便于行为测试。
'use strict';

function registerOauthIpc(ipcMain, deps) {
  deps = deps || {};
  const oauth = deps.oauth;
  const oauthNet = deps.oauthNet;
  const logger = deps.logger;

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
    catch { return {}; }
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
    } catch {
      return { ok: false, hasToken: false };
    }
  });
}

module.exports = { registerOauthIpc };
