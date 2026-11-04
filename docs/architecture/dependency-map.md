# Rokit · 依赖关系图（v1.X 整理前）

> **状态**：2026-10-19 快照。所有"现在"的箭头描述**这次整理前**的实际调用关系。

## 进程边界（main ↔ preload ↔ renderer）

```
[main: electron/main.js]
        │ loadFile('../index.html')
        ▼
[renderer: ai-launch-master/index.html] ──contextBridge── [preload: electron/preload.js]
        │  IPC: ipcRenderer.invoke / ipcMain.handle
        ▼
[main modules, 仅在 IPC handle 中被按需 require]
  llm.js / publishers.js / youtube-publisher.js / wechat.js / oauth*.js
  recorder.js / video.js / feedback-collector.js / feedback-analyzer.js
  voice-engine.js (主进程) / store.js / queue.js / secrets.js
  browser/ BrowserManager / browser-ipc.js
```

## renderer-utils（第一批新增）

```
index.html  ── <script src="renderer-utils/format.js"> ──>  window.esc
                ▲
                └────────── 234 处 esc(...) 调用通过全局查找找到
```

`renderer-utils/format.js` 是 IIFE-lite 自包含模块，**不依赖**其他任何模块；其它模块也不依赖它（除了调用 `esc`）。

## index.html 内部调用关系（高频模块）

```
state.subtitleData
  ├─► _capFinalOutputDuration()      ──┐
  ├─► _captionGetDuration()          ──┤──► _capBaseDuration 水位线
  ├─► _capRecomputeViewRange()       ──┘
  ├─► renderCaptionsSubtitleTrack
  ├─► renderCaptionsSceneTrack
  └─► renderCaptionsSubtitleBank

_captionDragSegment(ev, id)
  ├─► _capFitSegmentOut(outStart, outEnd, opts)
  ├─► _capHasOverlapOut
  └─► _capRender()
        └─► _capRecomputeViewRange()  ◄── 已被 __capDraggingSegment / __capDraggingFrozenMove 守卫

_captionDragCut(ev, cutId)
  ├─► prefix='l'：仅改 f.at
  ├─► prefix='r'：改 f.end / f.duration
  ├─► prefix='m'：固定 duration，平移 at / end（本轮新增）
  └─► _capRender()

_capDropRowToTimeline(rid, ev)
  ├─► _captionXToSec(x)
  ├─► _capOutputToSource / _capSourceToOutput
  ├─► _capSuggestSegmentStart
  ├─► 创建 seg.text 副本（本轮修复）
  └─► 同时 sd.rows 移除 row（本轮新增）

_captionMoveSegmentToBank(segId)        ◄── 本轮新增
  └─► 删除 seg；缺失 row 时按 seg.text 重建
```

## 关键约束（不可变）

- 字幕 OUT/SOURCE 时间映射核心：`_capSourceToOutput` ↔ `_capOutputToSource`。
- 字幕段长度 OUT / SOURCE 同步：靠 `_captionSnap(0.1s)` 吸附与 `0.2s` 最小间距。
- 冻结切点坐标：始终在 SOURCE 时间轴上。
- viewRange.end 与 `_capBaseDuration` 必须保持单调 / 收敛（不能反向被 lastEnd 撑大）。
