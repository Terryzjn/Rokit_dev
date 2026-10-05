'use strict';
// Rokit · 抖音开放平台 IPC 接口注册
//
// 主进程侧：在 main.js 创建 Store 之后调用 registerDouyinIpc(ipcMain, store)
// 所有抖音相关 IPC channel 统一以 'douyin:' 前缀

const credentials = require('./douyin-credentials');
const tokenManager = require('./douyin-token-manager');
const auth = require('./douyin-auth');
const apiClient = require('./douyin-api-client');

/**
 * 注册抖音 IPC handlers。
 * @param {Electron.IpcMain} ipcMain
 * @param {import('./store').Store} store
 */
function registerDouyinIpc(ipcMain, store) {
  // 把 store 注入 credentials 模块（依赖注入，避免模块硬引用全局 store 实例）
  credentials.setStore(store);

  // ---- douyin:save-credentials ----
  //   入参: { clientKey, clientSecret }
  //   返回: { success: true } | { success: false, error }
  ipcMain.handle('douyin:save-credentials', async (_e, payload) => {
    try {
      const ck = payload && payload.clientKey;
      const cs = payload && payload.clientSecret;
      if (!ck || !cs) return { success: false, error: 'INVALID_INPUT: clientKey / clientSecret 不能为空' };
      await credentials.saveCredentials(String(ck).trim(), String(cs).trim());
      return { success: true };
    } catch (e) {
      return { success: false, error: e && (e.description || e.message) || String(e) };
    }
  });

  // ---- douyin:start-auth ----
  //   启动授权窗口；用户授权后写入 session；返回 { success, session?, error? }
  ipcMain.handle('douyin:start-auth', async () => {
    try {
      const r = await auth.startAuthFlow();
      return r;
    } catch (e) {
      return { success: false, error: e && (e.description || e.message) || String(e) };
    }
  });

  // ---- douyin:get-auth-status ----
  //   返回: { authorized, openId?, expiresAt? }
  ipcMain.handle('douyin:get-auth-status', async () => {
    try {
      const status = await credentials.isSessionValid();
      if (!status.session) return { authorized: false };
      return {
        authorized: !!status.valid,
        openId: status.session.openId,
        expiresAt: status.session.accessTokenExpiresAt,
        refreshExpiresAt: status.session.refreshTokenExpiresAt
      };
    } catch (_e) {
      return { authorized: false };
    }
  });

  // ---- douyin:clear-auth ----
  //   清除 session 与凭据（注意：保留 clientKey / clientSecret 不变，按 spec 切换开关不删凭据）
  //   这里实现 spec 的「Cross 删除」语义：清除所有
  ipcMain.handle('douyin:clear-auth', async () => {
    try {
      await credentials.clearSession();
      await credentials.clearCredentials();
      return { success: true };
    } catch (e) {
      return { success: false, error: e && e.message || String(e) };
    }
  });

  // ---- douyin:refresh-token ----
  //   手动触发 token 刷新（验收点 4 之外的主动刷新场景）
  ipcMain.handle('douyin:refresh-token', async () => {
    try {
      const session = await credentials.loadSession();
      if (!session) return { success: false, error: 'NO_SESSION' };
      const fresh = await tokenManager.refreshAccessToken(session.refreshToken);
      return { success: true, expiresAt: fresh.accessTokenExpiresAt };
    } catch (e) {
      // 10010 refresh_token 已过期 → 提示重新授权
      if (e && e.errorCode === 10010) {
        return { success: false, error: 'REFRESH_TOKEN_EXPIRED', needReauth: true, description: e.description };
      }
      return { success: false, error: e && (e.description || e.message) || String(e) };
    }
  });

  // ---- douyin:validate-credentials ----
  //   验证 clientKey / clientSecret 是否有效（用 client_token 接口探测）
  ipcMain.handle('douyin:validate-credentials', async () => {
    try {
      // 临时校验：调用 client_token 接口拿一个 token，能拿到即视为有效
      const t = await tokenManager.getClientToken();
      return { valid: !!t };
    } catch (e) {
      // 抖音错误 code 10005/10002 等表示 client_key/secret 错
      const code = e && e.errorCode;
      return {
        valid: false,
        errorCode: code,
        error: e && (e.description || e.message) || String(e)
      };
    }
  });

  // ---- douyin:toggle-enable ----（spec UI 补充说明）
  //   Renderer 触发开关：{ enabled: boolean }
  //   - enabled=true: 先查 session 有效；有效直接成功，无效自动调起授权窗口
  //                取消授权返回 USER_CANCELLED 时 success:false，UI 自行恢复
  //   - enabled=false: 不动凭据（按 spec 「不禁用时清除凭据」）
  ipcMain.handle('douyin:toggle-enable', async (_e, payload) => {
    const enabled = payload && payload.enabled;
    if (enabled) {
      const status = await credentials.isSessionValid();
      if (status.valid) return { success: true };
      // session 无效 → 主动授权
      const r = await auth.startAuthFlow();
      if (!r.success) {
        return { success: false, error: r.error };
      }
      return { success: true, session: r.session };
    } else {
      // 关闭不清凭据；UI 把本地 isEnabled=false 同步即可
      return { success: true };
    }
  });

  // ---- douyin:get-status ----（UI 渲染时常拉的卡片状态）
  //   一次性返回「是否已配置 + 是否已授权 + openId + 过期时间」，减少多次 IPC
  ipcMain.handle('douyin:get-status', async () => {
    try {
      const creds = await credentials.loadCredentials();
      const status = await credentials.isSessionValid();
      return {
        hasCredentials: !!creds,
        authorized: !!status.valid,
        openId: status.session ? status.session.openId : null,
        accessTokenExpiresAt: status.session ? status.session.accessTokenExpiresAt : null,
        refreshTokenExpiresAt: status.session ? status.session.refreshTokenExpiresAt : null,
        reason: status.reason || null
      };
    } catch (_e) {
      return { hasCredentials: false, authorized: false };
    }
  });

  // ---- douyin:get-user-info ----（UI 上点「刷新频道信息」时用）
  ipcMain.handle('douyin:get-user-info', async () => {
    try {
      const info = await apiClient.getUserInfo();
      return { success: true, info };
    } catch (e) {
      return { success: false, error: e && (e.description || e.message) || String(e) };
    }
  });
}

module.exports = { registerDouyinIpc };