// Rokit · 通用 API Key 凭据 IPC 注册
// 从 main.js 抽出的 secrets:set-api-key / secrets:clear-api-key / secrets:status 三个通道；
// secrets 与 getStore 由调用方注入，不直接依赖 Electron、keytar 或数据库，便于行为测试。
//
// 行为约定（与拆分前保持一致，勿加额外逻辑）：
//   - store 必须在每次 handler 调用时经 getStore() 读取：注册发生在 store 创建之前
//   - 三个 handler 均为 async，除局部 try/catch 外不新增异常捕获
//   - 不写日志
'use strict';

function registerSecretsIpc(ipcMain, deps) {
  deps = deps || {};
  const secrets = deps.secrets;
  const getStore = deps.getStore;

  ipcMain.handle('secrets:set-api-key', async (_e, value) => {
    if (!value) return { ok: false, error: 'empty-key' };
    const persisted = await secrets.setApiKey(String(value));
    // 清掉 SQLite 明文（写入凭据管理器后就不再需要）
    const store = getStore();
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
    return {
      hasNative: hasNative,
      hasApiKey: !!apiKey,
      keytarError: keytarErrorMessage()
    };
  });
}

module.exports = { registerSecretsIpc };
