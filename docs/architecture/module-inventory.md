# Rokit · 模块清单（v1.X 整理前）

> **状态**：2026-10-19 快照。每个模块末尾 `[状态]` 标明本次是否已变更。

## 第一批已抽取 / 落盘

### `ai-launch-master/renderer-utils/format.js` 〔新增〕
- **导出**：`esc(value)` —— HTML 特殊字符转义（&、<、>、"），纯函数无副作用。
- **载入方式**：浏览器端 `<script src="renderer-utils/format.js">`；渲染端挂到 `window.esc`。UMD-lite，可兼容 Node 测试。
- **历史来源**：原位于 `ai-launch-master/index.html` 内嵌 IIFE，调用次数 234。
- **[状态]** 本批次已抽取；index.html 中 function 定义已被替换为指向新文件的注释。

## 第二批候选（待定，按依赖风险排序）

### 字幕渲染纯函数（建议第二批抽取）
- `_capNewId(prefix)`：递增式 ID 生成（小整数 + prefix），无副作用。位置约 `index.html:9606`。
- `_captionSnap(sec)`：时间 0.1s 吸附。位置约 `index.html:10264`。
- `_captionXToSec(x)` / `_captionSecToX(sec)`：OUTPUT ↔ 像素 互转。位置约 `index.html:10256-10261`。
- `_captionRange()` / `_captionPxPerSec()` / `_captionGetDuration()`：viewRange / pxps / 时长基线。位置约 `index.html:10215` / `10239` / `9359`。
- `_capSourceToOutput(sourceT)` / `_capOutputToSource(outputT)`：OUT/SOURCE 双轴时间映射核心，**保护**。位置约 `index.html:9268` / `9279`。

### 通用格式化工具（建议第二批抽取）
- `fmtDur(sec)` —— ⚠️ **不要轻易合并**：`index.html:3800` 与 `:4239` 两份定义输出格式不同（一处无 '—' fallback，一处支持小时位）。合并会改变用户可见行为，必须先确认是否有人在两处格式差异之上做了 UI 假设。

### 重复工具（建议评估后抽取）
- `toast` (位置约 `index.html:2867`)：已经单独成段，未重复，但属于 UI 副作用工具，第二批暂不处理。
- `av(size)` SVG 头像：单点使用，第二批暂不处理。
- `_capNormRow`、`_capNormSeg`、`_capNormFrozen`、`_capNormCut`：各自只被 `sd.x = sd.x.map(_capNormXxx)` 调一次，重复度低，第二批暂不抽取（避免过度拆分）。

## 第二批风险提示

- 字幕 OUT/SOURCE 时间映射（`_capSourceToOutput` / `_capOutputToSource` / `_captionSnap`）属于**已被多次修复**的算法核心；可以抽到独立文件，但**版本号锁**重要，必须保留 `git blame` 风格注释指向修复 commit 摘要。
- `_captionDragSegment.onMove` `_captionDragCut (prefix='m')` 等函数在拖动期间高频调用纯函数，要保证抽取不引入 IIFE 闭包变化。
- `_capBackfillOutFields` 含较多副作用（修改 seg.outStart/outEnd），属于"边界工具"，第二批最后考虑是否拆。

## 第三批候选（视一二批结果）

- 字幕编辑器 IIFE 整体拆出 `renderer/captions/*.js`（最复杂变动）。
- AI 录屏 / 视频处理 / 语音生成的 renderer-side 调用面拆出 `renderer/captions/voice.js` 之类。
- 平台发布适配（renderer 侧）拆出 `renderer/publishers/*.js`。

每批结束后再细化清单。
