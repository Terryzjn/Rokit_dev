# Rokit · 整理路线图

> **状态**：2026-10-19 文档。每批次 `[状态]` 行明确进行位置。

## 已完成

### 第一批 · 低风险抽取（renderer-utils/format.js）
- **范围**：`esc()` 纯 HTML 转义函数从 index.html 内嵌 IIFE 抽出到 `ai-launch-master/renderer-utils/format.js`。
- **变更点**：
  - 新建 `ai-launch-master/renderer-utils/format.js`，挂到 `window.esc`。
  - 在 index.html `</head>` 之前插入 `<script src="renderer-utils/format.js">`。
  - 删除 index.html 中原本的 `function esc(...)`，替换为指向新文件的注释。
  - `package.json` 的 `electron-builder.files` 增加 `"renderer-utils/**/*"`。
- **风险**：
  - IIFE 内的 `esc(xxx)` 调用查找路径变为 global → window.esc。
  - 已检查存在一处局部 `var esc`（modal 的 Escape 键监听），作用域独立，不污染。
- **验证**：
  - `node --check renderer-utils/format.js` 通过。
  - 全文搜 `function esc(`，仅注释中的引用保留。
  - 调用点 234 处，全部通过全局查找生效（运行时需 Electron 验证）。

## 进行中 / 待办

### 第二批 · 字幕编辑器纯函数抽取
- **目标**：把字幕 IIFE（L9000+）中明显无副作用的纯函数集中：
  - `_capNewId` / `_captionSnap` / `_captionXToSec` / `_captionSecToX` / `_captionPxPerSec` / `_captionRange` / `_captionGetDuration` / `_capSourceToOutput` / `_capOutputToSource`。
- **新文件候选**：`renderer-utils/caption-time.js`。
- **风险**：跨模块 IIFE 闭包查找，必须保证 `_capXxx` 都通过显式调用、不依赖外层闭包变量。
- **不做**：`_capBackfillOutFields`、`_captionDragSegment`、`_captionDragCut`、`_captionResizeSegment`、`_capFitSegmentOut` 等含副作用或 state 写入函数，留在 index.html 内部。
- **不做**：`fmtDur` 双版本合一（行为差异需要单独决策）。

### 第三批 · 大型业务模块拆分
- **目标**：字幕编辑器主 IIFE 整体拆出 `renderer/captions/captions.js`。
- **前置**：第二批完成 + 一轮回归确认。
- **风险**：DOM 节点是否在模块初始化时已存在；事件监听是否重复注册；脚本执行顺序和异步初始化时序。
- **保护清单**：
  - 字幕 OUT/SOURCE 时间映射。
  - 冻结时长。
  - 字幕拖动（含 reverse、threshold）。
  - 字幕素材双向拖拽（含 text 副本、segNorm 保留 text、_captionMoveSegmentToBank 兜底）。
  - 语音生成。
  - MP4 导出。
  - 多平台发布。
- **建议保护方法**：搬迁完跑现有 vitest 套件 + 手动抽测，不要无脑改业务代码。

### 第四批 · 加载性能优化
- **基线方法**：主进程已有 `stageMark()` 输出冷启动时间戳到 logger；不引入新依赖。
- **基线采集**：通过 `npm start` 启动后查 logger 输出 `[startup] xxx (+Nms)` 行；首屏 / DOM 交互 / 主要功能首次使用时机需要新增 performance marker 才能量化（暂未做，避免引入 risk）。
- **优化候选**：
  - 重型模块（如 `wechat.js`、`youtube-publisher.js`）是否可以在首次使用时再加载。
  - 启动时是否执行了与首屏无关的初始化。
  - 是否有同步文件操作阻塞主线程。
- **保护**：避免拆分 JS 文件反而引入大量串行脚本加载。

## 明确禁止事项（持续遵守）

- 不一次性重写整个 index.html。
- 不改变用户可见的产品行为和 UI。
- 不改变 IPC 协议、Preload 暴露接口或安全策略。
- 不修改草稿 / 用户配置 / 语音档案 / 项目数据的格式。
- 不删除未确认无用的代码。
- 不升级依赖、不安装新依赖、不更换构建工具。
- 不顺手修改与本批次无关的功能。
- 不覆盖或清理用户数据。
- 不因为代码难拆就直接复制整套实现到新文件中。

## 验证标准（每批）

1. 明确本批修改范围和风险。
2. 实施小范围修改。
3. 检查引用、脚本加载顺序和语法。
4. 执行项目现有的相关检查与测试。
5. 在可用的情况下启动 Electron 验证实际行为（renderer-utils 类改动需 `window.esc` 引用未坏）。
6. 对比修改前后的性能数据。
7. 报告修改文件、模块边界、验证结果和已知风险。

## 风险与回归保护

- 任何抽取都优先用"删除原实现 + 全文件范围确认无调用"消除重复；如果仍有调用，撤回抽取。
- 抽取时保留原有 git blame 风格注释，便于追溯修复历史。
- 子模块导出方式必须挂在 `window.*` 上，与"无构建工具"现状一致；不要引入 ESM `import/export`，也不引入 TypeScript。
