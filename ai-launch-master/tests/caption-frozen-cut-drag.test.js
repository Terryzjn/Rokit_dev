// Rokit · 冻结切点拖动（SOURCE/OUTPUT 双坐标）行为锁定
//
// 覆盖需求点（全部使用**真实生产函数** + 合成 pointer 事件，不启动 Electron）：
//   1. 拖动全程 pxps 恒定 —— 像素↔时间比例稳定（灵敏度不漂移）
//   2. 每帧位移与鼠标位移成稳定比例，不累计放大
//   3. 反向拖动立即跟随，无残留偏移
//   4. SOURCE 物理时长边界正确钳位，不产生虚构源帧
//   5. 左/右切点配对关系与冻结时长计算正确
//   6. 拖动中 OUTPUT 总时长变化不影响本次拖动基准
//   7. 松手后位置与冻结时长稳定
//
// 策略：**不复制**任何生产逻辑——直接从 index.html 源码里按大括号配平切出生产函数，
//   注入最小依赖后执行。测试跑的就是生产代码本身。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function extractFn(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = HTML.match(re);
  if (!m) throw new Error('源码中找不到函数：' + name);
  let i = m.index + m[0].length, depth = 1;
  while (i < HTML.length && depth > 0) {
    const ch = HTML.charAt(i++);
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  if (depth !== 0) throw new Error('花括号不配平：' + name);
  return HTML.slice(m.index, i);
}

const SRC = [
  '_captionSnap', '_capSourceToOutput', '_captionGetDuration', '_capFinalOutputDuration',
  '_capRecomputeViewRange', '_captionRange', '_captionAvailableWidth', '_captionPxPerSec',
  '_capCollectSegOutBaseline', '_capShiftSegmentsForFrozenChange', '_captionDragCut'
].map(extractFn).join('\n');

const TRACKS_W = 690;

function makeEnv(state) {
  const listeners = {};
  const win = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => {
      const a = listeners[t] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }
  };
  const tracksEl = { clientWidth: TRACKS_W, id: 'captionTracks', dataset: {} };
  const doc = {
    getElementById: (id) => (id === 'captionTracks' ? tracksEl : null),
    querySelector: () => null
  };
  const api = new Function('state', 'document', 'window', SRC + `
    function _captionAvailableWidth(){ return ${TRACKS_W}; }
    function _capRender(){ _capRecomputeViewRange(); }
    function _capPersist(){ }
    function _capUpdateTopLabels(){ }
    function _capExtractFrameFor(){ }
    return {
      _captionDragCut: _captionDragCut,
      _captionPxPerSec: _captionPxPerSec,
      _capFinalOutputDuration: _capFinalOutputDuration,
      _capRecomputeViewRange: _capRecomputeViewRange
    };
  `)(state, doc, win);
  return { api, win, listeners };
}

function fire(listeners, type, ev) {
  (listeners[type] || []).slice().forEach(fn => fn(ev));
}

function dragCut(cfg) {
  const { videoDur, frozen, cutId, frames } = cfg;
  const state = {
    videoAsset: { duration: videoDur, id: 'v1' },
    subtitleData: {
      frozenFrames: frozen.map(f => Object.assign({}, f)),
      segments: []
    }
  };
  const env = makeEnv(state);
  const sd = state.subtitleData;
  const fz = sd.frozenFrames.find(f => f.id === frozen[0].id);

  // 进入编辑器时的初始 recompute（与真实应用一致）
  env.api._capRecomputeViewRange();
  const pxpsEntry = env.api._captionPxPerSec();
  const viewEndEntry = sd.viewRange.end;

  env.api._captionDragCut({ preventDefault() {}, clientX: frames[0].downX, clientY: 100 }, cutId);

  const trace = [];
  for (const f of frames) {
    fire(env.listeners, 'pointermove', { clientX: f.mouseX, clientY: 100 });
    trace.push({
      i: f.i, mouseX: f.mouseX,
      at: fz.at, end: fz.end, dur: fz.duration,
      pxps: env.api._captionPxPerSec(),
      viewEnd: sd.viewRange.end,
      finalDur: env.api._capFinalOutputDuration()
    });
  }
  const beforeUp = { at: fz.at, end: fz.end, dur: fz.duration };
  fire(env.listeners, 'pointerup', { clientX: frames[frames.length - 1].mouseX, clientY: 100 });
  return {
    trace, beforeUp,
    afterUp: { at: fz.at, end: fz.end, dur: fz.duration, viewEnd: sd.viewRange.end },
    pxpsEntry, viewEndEntry, fz, sd
  };
}

const D = 100;
const FZ = { id: 'f1', at: 10, duration: 2, end: 12 };

describe('冻结切点拖动 · SOURCE/OUTPUT 双坐标行为锁定', function () {

  it('1. 连续向右拖右切点：pxps 全程恒定，每帧位移与鼠标位移成稳定比例', function () {
    const r = dragCut({
      videoDur: 22, frozen: [FZ], cutId: 'fzr:f1',
      frames: [{ i: 1, downX: D, mouseX: 140 }, { i: 2, downX: D, mouseX: 180 }, { i: 3, downX: D, mouseX: 220 },
               { i: 4, downX: D, mouseX: 260 }, { i: 5, downX: D, mouseX: 300 }]
    });
    // pxps 必须恒定（这是本次修复的核心：不再每帧重读 _captionPxPerSec()）
    r.trace.forEach(t => expect(t.pxps).toBeCloseTo(r.pxpsEntry, 9));
    // 每帧 duration 增量 ≈ 40px / pxps（0.1s Snap 量化误差 ≤ 0.11s）
    const expectStep = 40 / r.pxpsEntry;
    for (let i = 1; i < r.trace.length; i++) {
      expect(Math.abs((r.trace[i].dur - r.trace[i - 1].dur) - expectStep)).toBeLessThan(0.11);
    }
    // duration 恒为正（OUTPUT 停留时长）
    r.trace.forEach(t => expect(t.dur).toBeGreaterThan(0.19));
  });

  it('2. 快速向右拖动：不出现突然减速、跳位或卡住', function () {
    const r = dragCut({
      videoDur: 22, frozen: [FZ], cutId: 'fzr:f1',
      frames: [{ i: 1, downX: D, mouseX: 200 }, { i: 2, downX: D, mouseX: 500 }, { i: 3, downX: D, mouseX: 800 }]
    });
    const clamp = (x) => Math.min(r.viewEndEntry - FZ.at, 2 + (x - D) / r.pxpsEntry);
    expect(Math.abs(r.trace[0].dur - clamp(200))).toBeLessThan(0.12);
    expect(Math.abs(r.trace[1].dur - clamp(500))).toBeLessThan(0.12);
    expect(r.trace[2].dur).toBeLessThanOrEqual(r.viewEndEntry - FZ.at + 1e-6);
    for (let i = 1; i < r.trace.length; i++) {
      expect(r.trace[i].dur).toBeGreaterThanOrEqual(r.trace[i - 1].dur - 1e-9);
    }
  });

  it('3. 从右向左反向拖动：立即跟随鼠标，无残留偏移', function () {
    const r = dragCut({
      videoDur: 22, frozen: [FZ], cutId: 'fzr:f1',
      frames: [{ i: 1, downX: D, mouseX: 300 }, { i: 2, downX: D, mouseX: 200 }, { i: 3, downX: D, mouseX: 140 }]
    });
    const expectDur = 2 + (140 - D) / r.pxpsEntry;
    expect(Math.abs(r.trace[2].dur - expectDur)).toBeLessThan(0.12);
    for (let i = 1; i < r.trace.length; i++) {
      expect(r.trace[i].dur).toBeLessThanOrEqual(r.trace[i - 1].dur + 1e-9);
    }
  });

  it('4. 连续多帧等距离移动：不出现累计位移放大', function () {
    const r = dragCut({
      videoDur: 22, frozen: [FZ], cutId: 'fzr:f1',
      frames: [{ i: 1, downX: D, mouseX: 120 }, { i: 2, downX: D, mouseX: 140 }, { i: 3, downX: D, mouseX: 160 },
               { i: 4, downX: D, mouseX: 180 }, { i: 5, downX: D, mouseX: 200 }, { i: 6, downX: D, mouseX: 220 }]
    });
    const expectStep = 20 / r.pxpsEntry;
    for (let i = 1; i < r.trace.length; i++) {
      expect(Math.abs((r.trace[i].dur - r.trace[i - 1].dur) - expectStep)).toBeLessThan(0.11);
    }
    // 总位移 = 累计像素 / pxps（不放大）
    expect(Math.abs((r.trace[5].dur - 2) - 120 / r.pxpsEntry)).toBeLessThan(0.12);
  });

  it('5. 右切点可到达最终 OUTPUT 时间轴最右端（SOURCE 侧仍受物理时长约束）', function () {
    const r = dragCut({
      videoDur: 22, frozen: [FZ], cutId: 'fzr:f1',
      frames: [{ i: 1, downX: D, mouseX: 400 }, { i: 2, downX: D, mouseX: 800 }, { i: 3, downX: D, mouseX: 1200 }]
    });
    // 右切点的 OUTPUT 位置 = outAt + duration，必须能到达 viewRange.end（轨道右端）
    const outAt = FZ.at; // 单个冻结，无更早冻结累加
    const cutOut = outAt + r.trace[2].dur;
    expect(Math.abs(cutOut - r.viewEndEntry)).toBeLessThan(0.12);
    // SOURCE 侧仍然合法：f.end（源区间终点）不超过原视频物理时长
    r.trace.forEach(t => expect(t.end).toBeLessThanOrEqual(22 + 1e-6));
    // 冻结时长（OUTPUT 停留时长）必须为正且可超过原视频剩余长度
    expect(r.trace[2].dur).toBeGreaterThan(0);
    // 抽帧位置 f.at 未被改动 → 冻结帧仍来自原视频有效帧
    expect(r.trace[2].at).toBe(FZ.at);
  });

  it('6. 拖左切点：右切点不动、冻结区间配对关系与时长计算正确', function () {
    const r = dragCut({
      videoDur: 22, frozen: [FZ], cutId: 'fzl:f1',
      frames: [{ i: 1, downX: D, mouseX: 60 }, { i: 2, downX: D, mouseX: 40 }, { i: 3, downX: D, mouseX: 20 }]
    });
    // 右切点（duration）不动 —— 拖左切点不改变 OUTPUT 停留时长
    r.trace.forEach(t => expect(t.dur).toBe(2));
    // duration 是 OUTPUT 停留时长，不再等于 SOURCE 区间长度
    r.trace.forEach(t => expect(t.dur).toBeGreaterThan(0.19));
    // 左切点不越过原视频物理时长，不小于 0
    expect(r.trace[2].at).toBeLessThanOrEqual(22 - 0.2 + 1e-6);
    r.trace.forEach(t => expect(t.at).toBeGreaterThanOrEqual(0));
    // 冻结时长 ≥ 0.2s
    expect(r.trace[2].dur).toBeGreaterThanOrEqual(0.2 - 1e-6);
  });

  it('7. 拖动中 OUTPUT 总时长变化：不影响本次拖动的坐标基准', function () {
    const r = dragCut({
      videoDur: 22, frozen: [FZ], cutId: 'fzr:f1',
      frames: [{ i: 1, downX: D, mouseX: 200 }, { i: 2, downX: D, mouseX: 400 }, { i: 3, downX: D, mouseX: 600 }]
    });
    // OUTPUT 总时长确实变化了
    expect(r.trace[0].finalDur).not.toBeCloseTo(r.trace[2].finalDur, 3);
    // 但 pxps 与 viewRange.end 在拖动期间恒定
    r.trace.forEach(t => {
      expect(t.pxps).toBeCloseTo(r.pxpsEntry, 9);
      expect(t.viewEnd).toBeCloseTo(r.viewEndEntry, 9);
    });
    // 松手后 viewRange.end 按新的 finalDur 重新计算
    expect(r.afterUp.viewEnd).toBeCloseTo(r.trace[2].finalDur, 3);
  });

  it('8. 松开鼠标后：切点位置和冻结时长保持稳定', function () {
    const r = dragCut({
      videoDur: 22, frozen: [FZ], cutId: 'fzr:f1',
      frames: [{ i: 1, downX: D, mouseX: 400 }, { i: 2, downX: D, mouseX: 800 }]
    });
    expect(r.afterUp.at).toBe(r.beforeUp.at);
    expect(r.afterUp.end).toBe(r.beforeUp.end);
    expect(r.afterUp.dur).toBeCloseTo(r.beforeUp.dur, 9);
  });

  it('9. 多冻结场景：pExt 映射基于快照，其余冻结不被本拖动修改', function () {
    const r = dragCut({
      videoDur: 22,
      frozen: [{ id: 'f1', at: 10, duration: 2, end: 12 }, { id: 'f2', at: 16, duration: 3, end: 19 }],
      cutId: 'fzr:f1',
      frames: [{ i: 1, downX: D, mouseX: 140 }, { i: 2, downX: D, mouseX: 180 }]
    });
    // f1 位于 f2 之前 → 自身 OUT 起点 = 10（f2 在其后，不累加）→ duration 增量 = dx/pxps
    expect(Math.abs(r.trace[0].dur - (2 + 40 / r.pxpsEntry))).toBeLessThan(0.12);
    r.trace.forEach(t => expect(t.pxps).toBeCloseTo(r.pxpsEntry, 9));
    // f2 完全未被修改（SOURCE 帧位置与 OUTPUT 映射都不受影响）
    const f2 = r.sd.frozenFrames.find(f => f.id === 'f2');
    expect(f2.at).toBe(16);
    expect(f2.duration).toBe(3);
  });

  it('10. 源码约束：拖动基准已快照化，且未改动字幕片段相关函数', function () {
    const body = extractFn('_captionDragCut');
    // 拖动中必须用快照 pxps，而不是每帧重读 _captionPxPerSec()
    expect(body).toMatch(/var dsOut = dx \/ _snapPxps;/);
    expect(body).not.toMatch(/var dsOut = dx \/ _captionPxPerSec\(\);/);
    // 必须在 pointerdown 时记录快照
    expect(body).toMatch(/var _snapPxps = _captionPxPerSec\(\);/);
    expect(body).toMatch(/var _vaDur = _captionGetDuration\(\);/);
    expect(body).toMatch(/_snapOtherFz/);
    // _outToSourceDelta 必须基于快照，不读当前 frozenFrames
    expect(body).toMatch(/function _outToSourceDelta\(outDelta\)\{[\s\S]*?_snapOtherFz/);
    expect(body).not.toMatch(/\(sd\.frozenFrames \|\| \[\]\)\.slice\(\)\.sort/);
    // 右切点上限改为 OUTPUT 维度（最终时间轴右端），不再是 SOURCE 物理时长
    expect(body).toMatch(/var _snapMaxDur = Math\.max\(0\.2, _snapViewEnd - _snapSelfAtOut\);/);
    expect(body).not.toMatch(/var maxEnd = _vaDur;/);
    // 右切点位移换算必须是纯 OUTPUT 维度（不再用 _outToSourceDelta）
    expect(body).toMatch(/var newDur = _captionSnap\(Math\.max\(0\.2, Math\.min\(_snapMaxDur, _origFzDur \+ dsOut\)\)\);/);
    // SOURCE 侧仍然受物理时长约束（抽帧位置合法）
    expect(body).toMatch(/fz\.end = Math\.max\(fz\.at \+ 0\.2, Math\.min\(_vaDur, fz\.at \+ newDur\)\);/);
    // 拖动锁旗标
    expect(body).toMatch(/sd\.__capDraggingCut = true/);

    // 字幕片段相关函数必须保持不变（本次不修改）
    const seg = extractFn('_captionDragSegment');
    expect(seg).toMatch(/var desiredOut = startOutStart \+ dsOut;/);
    expect(seg).not.toMatch(/avoidOffset/);
    const fit = extractFn('_capFitSegmentOut');
    expect(fit).toMatch(/if \(_from !== null && keepLen\)/);
  });

  it('11. 源码约束：_capRecomputeViewRange 在切点拖动期间保持 viewRange.end 不变', function () {
    const body = extractFn('_capRecomputeViewRange');
    expect(body).toMatch(/sd\.__capDraggingCut === true/);
    expect(body).toMatch(/return;/);   // 提前返回，不改写 viewRange.end
  });
});
