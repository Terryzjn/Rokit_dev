// Rokit · 微信凭据 IPC 注册
// 从 main.js 抽出的 wechat:credentials-* 四个通道；
// secrets / directWechatRead / secretKeys 均由调用方注入，
// 不直接依赖 Electron、keytar 或 secrets 模块，便于行为测试。
//
// 行为约定（与拆分前保持一致，勿加额外逻辑）：
//   - 四个 handler 原本都没有 try/catch：异常继续以 rejected Promise 向上传播
//   - 不写日志
//   - WECHAT_SECRET_KEYS 与 _directWechatRead 仍由 main.js 持有，这里只接收引用
'use strict';

function registerWechatCredentialsIpc(ipcMain, deps) {
  deps = deps || {};
  const secrets = deps.secrets;
  const directWechatRead = deps.directWechatRead;
  const secretKeys = deps.secretKeys;

  ipcMain.handle('wechat:credentials-status', async () => {
    // v1.2 修复：直读 keytar，不走 secrets.js 的模块级 cache，避免「保存了但 cache 没更新/为空」导致误报
    const direct = await directWechatRead();
    const missing = [];
    if (!direct.appId) missing.push('appId');
    if (!direct.appSecret) missing.push('appSecret');
    if (!direct.thumbMediaId) missing.push('thumbMediaId');
    const persisted = secrets.hasNative ? secrets.hasNative() : false;
    return {
      hasAppId: !!direct.appId,
      hasAppSecret: !!direct.appSecret,
      hasThumbMediaId: !!direct.thumbMediaId,
      missing: missing,
      configured: missing.length === 0,
      persisted: persisted
    };
  });

  ipcMain.handle('wechat:credentials-load', async () => {
    const direct = await directWechatRead();
    return {
      appId: direct.appId,
      appSecret: direct.appSecret,
      thumbMediaId: direct.thumbMediaId
    };
  });

  ipcMain.handle('wechat:credentials-save', async (_e, values) => {
    const input = values || {};
    let persisted = true;
    for (const field of Object.keys(secretKeys)) {
      const value = String(input[field] || '').trim();
      if (value) {
        // v1.2 修复：保存时显式写 keytar，并更新 secrets.js 的 cache，让后续 getSecret 也命中
        const ok = await secrets.setSecret(secretKeys[field], value);
        persisted = ok && persisted;
      }
    }
    return { ok: true, persisted: persisted };
  });

  ipcMain.handle('wechat:credentials-clear', async () => {
    await Promise.all(Object.values(secretKeys).map((key) => secrets.deleteSecret(key)));
    return { ok: true };
  });
}

module.exports = { registerWechatCredentialsIpc };
