# Rokit · 当前架构（v1.X 整理前）

> **状态**：2026-10-19 快照。每个章节末尾都用 `[状态]` 标明本次是否已变更。

## 1. 进程与入口

- **Main 进程**：`ai-launch-master/electron/main.js`（被 `package.json` 的 `"main"` 引用）。
  - 在 `app.whenReady` 之后构造 `mainWindow = new BrowserWindow({ frame: false, webPreferences: { preload: ..., contextIsolation: true, sandbox: false } })`，调用 `win.loadFile('../index.html')`。
  - 启动耗时使用 `[startup] ... (+Nms)` 体系（`stageMark(name)`）记录：logger-init、crud-repair、store-init、browser-manager、window-created、`ready-to-show`。
- **Preload**：`ai-launch-master/electron/preload.js` 通过 `contextBridge` 暴露 API；渲染进程通过 `window.api.*` 调用。
- **Renderer 入口**：`ai-launch-master/index.html`（**单 HTML 文件**，包含全部前端 JS/CSS）。
  - `[状态]` 本次拆分：HEAD 末尾新增 `<script src="renderer-utils/format.js"></script>`，将 `esc()` 纯工具独立到该文件；`esc` 在 index.html 内部定义已删除并以注释替代。

## 2. 前端模块边界（index.html 视角）

- 全部前端代码位于 index.html 的 IIFE 中（`[L1996]` 起），按"功能块"用空行注释划分：
  - 默认计划、状态机、引导向导、平台配置、作品管理。
  - 字幕编辑器（caption editor IIFE，L9000+），时间轴、OUT/SOURCE 时间映射、冻结切点、字幕拖动、字幕素材双向拖拽。
  - 与 `electron/llm.js`、`electron/publishers.js`、`electron/youtube-publisher.js` 通过 IPC 调用。
- 渲染函数命名遵循 `renderXxx`，事件绑定函数遵循 `captionBindXxx`，数据变更函数遵循 `_capXxx`、`_captionXxx`。
- 重型 IPC 适配器（Xiaohongshu / Wechat / 浏览器框架等）写在 `electron/`，对 renderer 暴露到 `window.api`。

## 3. 全局共享状态（已知风险）

- `window.state` / `state.subtitleData` / `state.voiceEngine`：由 main IIFE 单一拥有，跨流程通过函数形参传递。
- `sd.__capDraggingSegment`、`sd.__capDraggingFrozenMove`、`sd.__captionMoveToBankFired`、`sd._capBaseDuration`：动态拖动 / 字幕 / 冻结共享信号。仅 onMove 期间设置，onUp 清理。
  - `[状态]` 本批次未触及。
- `window._capIsSeeking`、`window._capPxpsRetry`：拖动 / 重算信号。已清理在 `_capRender` 路径。

## 4. 主进程模块（`ai-launch-master/electron/`）

- `main.js`：窗口 + IPC 注册 + 启动埋点。
- `llm.js`、`publishers.js`、`youtube-publisher.js`：模型、平台抽象、YouTube 直发。
- `voice-engine.js`、`voice-profiles.js`：XTTS 语音。
- `store.js`、`queue.js`、`secrets.js`、`recorder.js`、`video.js`、`feedback-{collector,analyzer}.js`：持久化、队列、凭据、录屏、视频、反馈。
- `browser/`：通用浏览器框架；`browser/platforms/`：每个平台的脚本化适配器。

## 5. 渲染端维护的脚本

- `ai-launch-master/index.html`（renderer）。
- `ai-launch-master/renderer-utils/format.js`（新增，第一批）。
- `[状态]` 本批次未涉及 `scripts/`（构建脚本）、`tests/`（vitest 套件）。

## 6. 构建与分发

- `package.json` 的 `electron-builder.files` 现在同时收录 `index.html` 与 `renderer-utils/**/*`。
  - `[状态]` 本次已修改。
- `npm run dist` / `npm run pack` 走 `electron-builder` -> `RELEASE/win-unpacked/`。
- 启动命令：`npm start` = `node scripts/start.js`（spawn electron）。

## 7. 性能埋点现状

- 主进程有 `stageMark(name)` 与 `ready-to-show` 标记，输出在 logger 中，**可重复测量**。
- `[状态]` 本批次未对启动本身做变更，因此基线没有波动。如下一批次涉及 index.html 引入新的 script 或动态加载，需要重新采集 `ready-to-show` 时间戳。
