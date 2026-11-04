// Rokit · 作品 CRUD IPC 注册
// 从 main.js 抽出的 works:list / works:save / works:delete 三个通道；
// store 由调用方注入，不直接依赖 Electron 或数据库，便于行为测试。
//
// 行为约定（与拆分前保持一致，勿加额外逻辑）：
//   - 同步执行：不做 async / await / Promise 包装
//   - 参数原样透传：不校验、不转换、不克隆
//   - 返回值保持对象身份：不复制、不重新构造
//   - store 在每次调用时读取（getStore()），不在注册时捕获实例
'use strict';

function registerWorksCrudIpc(ipcMain, deps) {
  deps = deps || {};
  const getStore = deps.getStore;

  ipcMain.handle('works:list', () => getStore().listWorks());
  ipcMain.handle('works:save', (_e, w) => getStore().saveWork(w));
  ipcMain.handle('works:delete', (_e, id) => getStore().deleteWork(id));
}

module.exports = { registerWorksCrudIpc };
