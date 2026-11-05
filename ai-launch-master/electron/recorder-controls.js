// Rokit · 手动录屏控制条（独立窗口）
//
// 目的：
//   让「开始 / 暂停·恢复 / 停止」三个按钮**位于 Rokit 主窗口之外**，
//   因此它们永远不会出现在录制画面里（录制对象是主窗口本身）。
//
// 设计要点：
//   1) 独立 BrowserWindow（frame:false / 小尺寸 / alwaysOnTop）→ 不是主窗口的一部分。
//   2) 窗口标题**故意不含 "Rokit"**：捕获源识别（ai-demo.js 的 isRokitWindow）
//      靠 /rokit/i.test(title) 匹配主窗口；控制条标题若含 Rokit 会被误判成主窗口
//      → 进而被 desktopCapturer 当成"要录的窗口"，把控制条录进画面。
//   3) 位置跟随主窗口：贴在主窗口**外侧**（默认右侧；右侧放不下时自动改到左侧），
//      主窗口移动 / 缩放 / 最大化时同步跟随。
//   4) 控制条只与主进程通信；主进程再把动作转发给主窗口的 renderer。
//      控制条自身**不**接触任何录屏 API。
//
// 约束：
//   - 不重复实现录屏服务：拉流 / 保存 / MP4 转码仍复用现有 capture:* 与 demo:* IPC。
//   - 录制状态由主窗口 renderer 持有；本模块只负责展示状态 + 转发点击。

'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');

const logger = (() => {
  try { return require('./logger'); } catch (_e) { return { info() {}, warn() {}, error() {} }; }
})();

// 控制条窗口标题：绝不能包含 "Rokit"（会被 isRokitWindow 误判）
const CONTROLS_TITLE = 'Recorder Controls';

// 控制条尺寸与间距
//   宽度必须容纳「状态点 + 计时 + 开始 + 暂停·恢复 + 停止」三个按钮**完整显示**
//   （三个按钮文字为 2 个汉字 + 内边距，各约 40px，合计 ~120px；
//     再加状态点 9px、计时 38px、间隔与内边距 ~28px → 最小约 200px）。
//   这里取 232px，确保三个按钮在任何缩放比例下都完整可见（不被裁切）。
const BAR_WIDTH = 232;
const BAR_HEIGHT = 46;
const GAP = 10;

// 窗口状态：IDLE / RECORDING / PAUSED
let controlsWin = null;
let currentState = 'IDLE';
let currentDurationSec = 0;
let attachedMainWindow = null;
let followTimer = null;

// ---------- 位置计算 ----------

// 计算控制条应放置的位置（贴在主窗口外侧）。
// 优先主窗口右侧；右侧空间不足时改到左侧；两侧都不够时贴在顶部外侧。
function computePosition(mainBounds) {
  if (!mainBounds) return null;
  const display = (screen && typeof screen.getDisplayMatching === 'function')
    ? screen.getDisplayMatching(mainBounds)
    : null;
  const area = display && display.workArea ? display.workArea : null;
  const b = {
    x: Math.round(mainBounds.x || 0),
    y: Math.round(mainBounds.y || 0),
    width: Math.round(mainBounds.width || 0),
    height: Math.round(mainBounds.height || 0)
  };
  const rightX = b.x + b.width + GAP;
  const leftX = b.x - GAP - BAR_WIDTH;
  const fitsRight = !area || (rightX + BAR_WIDTH <= area.x + area.width);
  const fitsLeft = !area || (leftX >= area.x);
  if (fitsRight) {
    // 垂直居中于主窗口
    const y = b.y + Math.max(0, Math.round((b.height - BAR_HEIGHT) / 2));
    return { x: rightX, y: y };
  }
  if (fitsLeft) {
    const y = b.y + Math.max(0, Math.round((b.height - BAR_HEIGHT) / 2));
    return { x: leftX, y: y };
  }
  // 两侧都放不下 → 贴在顶部外侧
  return { x: b.x, y: Math.max(0, b.y - GAP - BAR_HEIGHT) };
}

// 同步控制条位置到主窗口外侧
function syncPosition() {
  if (!controlsWin || controlsWin.isDestroyed()) return;
  const main = attachedMainWindow && !attachedMainWindow.isDestroyed()
    ? attachedMainWindow
    : (BrowserWindow.getAllWindows() || []).find(function (w) {
        if (!w || w.isDestroyed()) return false;
        const t = (typeof w.getTitle === 'function' ? w.getTitle() : '') || '';
        return /rokit/i.test(t) && w !== controlsWin;
      });
  if (!main) return;
  let bounds = null;
  try { bounds = main.getBounds(); } catch (_e) { bounds = null; }
  if (!bounds) return;
  const pos = computePosition(bounds);
  if (!pos) return;
  try {
    if (controlsWin.isMaximized()) controlsWin.unmaximize();
    controlsWin.setPosition(pos.x, pos.y, false);
  } catch (_e) { /* 窗口已销毁 */ }
}

// ---------- 状态同步 ----------

function pushState(state, durationSec) {
  currentState = state || 'IDLE';
  if (typeof durationSec === 'number') currentDurationSec = durationSec;
  if (!controlsWin || controlsWin.isDestroyed()) return;
  try {
    controlsWin.webContents.send('recorder-controls:state', {
      state: currentState,
      durationSec: currentDurationSec
    });
  } catch (_e) { /* 忽略发送失败 */ }
}

// ---------- 窗口创建 ----------

function createControlsWindow(mainWindow) {
  if (controlsWin && !controlsWin.isDestroyed()) {
    attachedMainWindow = mainWindow || attachedMainWindow;
    syncPosition();
    try { controlsWin.show(); controlsWin.focus(); } catch (_e) {}
    return controlsWin;
  }
  attachedMainWindow = mainWindow || attachedMainWindow;
  controlsWin = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: CONTROLS_TITLE,
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'recorder-controls-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  try { controlsWin.setAlwaysOnTop(true, 'screen-saver'); } catch (_e) {}
  try { controlsWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false }); } catch (_e) {}

  // 控制条绝不能被当成"要录的主窗口"
  try { controlsWin.setTitle(CONTROLS_TITLE); } catch (_e) {}

  controlsWin.on('closed', function () {
    controlsWin = null;
    currentState = 'IDLE';
    currentDurationSec = 0;
  });

  // 主窗口移动 / 缩放 / 最大化 → 控制条跟随
  const main = attachedMainWindow;
  if (main && !main.isDestroyed()) {
    try {
      main.on('move', syncPosition);
      main.on('resize', syncPosition);
      main.on('maximize', syncPosition);
      main.on('unmaximize', syncPosition);
      main.on('restore', syncPosition);
    } catch (_e) { /* 忽略 */ }
  }
  // 兜底轮询：某些情况下 move/resize 事件不触发
  if (followTimer) clearInterval(followTimer);
  followTimer = setInterval(function () {
    if (!controlsWin || controlsWin.isDestroyed()) {
      if (followTimer) { clearInterval(followTimer); followTimer = null; }
      return;
    }
    syncPosition();
  }, 500);

  controlsWin.loadFile(path.join(__dirname, 'recorder-controls.html')).then(function () {
    if (!controlsWin || controlsWin.isDestroyed()) return;
    syncPosition();
    controlsWin.show();
    // 把当前状态同步给控制条（可能已错过首次推送）
    pushState(currentState, currentDurationSec);
  }).catch(function (err) {
    logger.warn('[recorder-controls] 载入失败', { error: String(err && err.message || err) });
  });
  return controlsWin;
}

function showControls(mainWindow) {
  createControlsWindow(mainWindow);
}

function hideControls() {
  if (controlsWin && !controlsWin.isDestroyed()) {
    try { controlsWin.close(); } catch (_e) {}
  }
  controlsWin = null;
  currentState = 'IDLE';
  currentDurationSec = 0;
}

function isVisible() {
  return !!(controlsWin && !controlsWin.isDestroyed() && controlsWin.isVisible());
}

function getState() {
  return currentState;
}

// ---------- IPC 注册 ----------

function registerIpc(ipcMainRef, deps) {
  if (!ipcMainRef || typeof ipcMainRef.handle !== 'function') return;
  const d = deps || {};

  // 控制条 → 主进程：开始 / 暂停 / 恢复 / 停止
  ipcMainRef.handle('recorder-controls:action', function (_e, action) {
    const act = String(action || '');
    if (act !== 'start' && act !== 'pause' && act !== 'resume' && act !== 'stop') {
      return { ok: false, error: 'unknown-action' };
    }
    // 转发给主窗口 renderer（真正执行录屏的一侧）
    const main = d.getMainWindow ? d.getMainWindow() : null;
    if (!main || main.isDestroyed()) return { ok: false, error: 'no-main-window' };
    try {
      main.webContents.send('recorder-controls:command', act);
    } catch (_e) {
      return { ok: false, error: 'send-failed' };
    }
    return { ok: true };
  });

  // 主进程 → 控制条：状态同步
  ipcMainRef.handle('recorder-controls:set-state', function (_e, payload) {
    const p = payload || {};
    pushState(p.state, p.durationSec);
    return { ok: true };
  });

  // 主窗口 renderer → 主进程：显示 / 隐藏控制条
  ipcMainRef.handle('recorder-controls:show', function () {
    showControls(d.getMainWindow ? d.getMainWindow() : null);
    return { ok: true };
  });
  ipcMainRef.handle('recorder-controls:hide', function () {
    hideControls();
    return { ok: true };
  });
  ipcMainRef.handle('recorder-controls:state', function () {
    return { ok: true, state: currentState, visible: isVisible() };
  });
}

module.exports = {
  registerIpc: registerIpc,
  createControlsWindow: createControlsWindow,
  showControls: showControls,
  hideControls: hideControls,
  isVisible: isVisible,
  getState: getState,
  computePosition: computePosition,
  syncPosition: syncPosition,
  pushState: pushState,
  CONTROLS_TITLE: CONTROLS_TITLE,
  BAR_WIDTH: BAR_WIDTH,
  BAR_HEIGHT: BAR_HEIGHT
};
