// Rokit · 唯一主推 IPC 注册
// 从 main.js 抽出的 works:set-main / works:clear-main 两个通道；
// store 由调用方注入，不直接依赖 Electron 或数据库，便于行为测试。
//
// 行为约定（与 works-crud-ipc 保持一致）：
//   - 同步执行：不做 async / await / Promise 包装
//   - 参数原样透传：不校验、不转换、不克隆
//   - 返回值保持对象身份：不复制、不重新构造
//   - store 在每次 handler 调用时读取（getStore()），不在注册时捕获实例
//
// 唯一性由 store 层的 setMainWork / clearMainWork 保证（单语句原子更新），
// 这里只做转发，不在 IPC 层重复实现主推规则。
'use strict';

function registerWorksMainIpc(ipcMain, deps) {
  deps = deps || {};
  const getStore = deps.getStore;

  // 设为主推：目标作品成为唯一主推，原主推自动降级
  ipcMain.handle('works:set-main', (_e, id) => getStore().setMainWork(id));

  // 取消主推：清掉主推标记，之后没有主推作品
  ipcMain.handle('works:clear-main', (_e, id) => getStore().clearMainWork(id));
}

module.exports = { registerWorksMainIpc };
