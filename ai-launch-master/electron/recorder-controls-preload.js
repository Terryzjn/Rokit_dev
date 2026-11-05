// Rokit · 手动录屏控制条 preload
//
// 控制条窗口只做两件事：
//   1) 把三个按钮的点击转成 IPC（发给主进程，由主进程转发给主窗口 renderer）
//   2) 接收主进程推送的录制状态（IDLE / RECORDING / PAUSED + 已录秒数）
//
// 注意：控制条**不**接触任何录屏 API（不拉流、不保存、不转码），
// 也不直接访问文件系统。

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderControls', {
  // 点击 → 通知主进程（主进程再转发给主窗口执行）
  sendAction: (action) => ipcRenderer.invoke('recorder-controls:action', action),

  // 主进程推送状态
  onState: (callback) => {
    const listener = (_event, payload) => {
      try { callback(payload || { state: 'IDLE', durationSec: 0 }); } catch (_e) {}
    };
    ipcRenderer.on('recorder-controls:state', listener);
    return () => ipcRenderer.removeListener('recorder-controls:state', listener);
  }
});
