// Rokit · 设置 / LLM IPC 注册
// 从 main.js 抽出的 settings:get / settings:save / llm:generate 三个通道；
// store 与 chatComplete 由调用方注入，不直接依赖 Electron 或数据库，便于行为测试。
//
// 行为约定（与拆分前保持一致，勿加额外逻辑）：
//   - store 必须在每次 handler 调用时经 getStore() 读取：注册发生在 store 创建之前
//   - settings:get / settings:save 保持同步；llm:generate 保持 async
//   - 参数原样透传：不校验、不转换、不克隆
//   - 返回值保持对象身份：不复制、不重新构造
//   - 不写日志，不新增异常捕获
'use strict';

function registerSettingsIpc(ipcMain, deps) {
  deps = deps || {};
  const getStore = deps.getStore;
  const chatComplete = deps.chatComplete;

  ipcMain.handle('settings:get', () => getStore().getSettings());

  ipcMain.handle('settings:save', (_e, s) => getStore().saveSettings(s));

  ipcMain.handle('llm:generate', async (_e, req) => {
    // v1.5：不再依赖 settings.api_key；llm.chatComplete 内部已统一走 secrets
    const settings = getStore().getSettings();
    return chatComplete(settings, req);
  });
}

module.exports = { registerSettingsIpc };
