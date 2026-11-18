// Rokit · 字幕片段拖动（OUTPUT 时间轴）行为锁定
//
// 覆盖需求点（全部使用**真实生产函数** + 合成 pointer 事件，不启动 Electron）：
//   1. 目标位置恒为「按下时锚点 + 相对 pointerdown 的累计位移」，不重复累加
//   2. 遇到其他字幕时**贴在碰撞边界平稳停止**，不跳到障碍另一侧的远处空档
//   3. 鼠标反向离开碰撞区域后**立即恢复 1:1 跟随**，无残留偏移
//   4. 靠近最右边界时保持原始长度并平稳贴边
//   5. 拖动方向正确（左拖不会右跑）
//   6. 松开鼠标后位置稳定
//   7. 段长、吸附精度、OUTPUT 坐标体系不变
//
// 策略：**不复制**任何生产逻辑——直接从 index.html 源码里按大括号配平切出生产函数，
//   注入最小依赖后执行。测试跑的就是生产代码本身。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

// ---- 从 index.html 切出生产函数（含签名，按大括号配平）----
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
  '_capFindOverlapOut', '_capHasOverlapOut', '_capFitSegmentOut', '_captionDragSegment'
].map(extractFn).join('\n');

const TRACKS_W = 690;   // #captionTracks 内容宽度（clientWidth - padding - border）
const PXPS = TRACKS_W / 22;

// ---- 构造最小运行环境，驱动**真实** _captionDragSegment ----
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
    function _captionMoveSegmentToBank(){ }
    return { _captionDragSegment: _captionDragSegment, _capRecomputeViewRange: _capRecomputeViewRange };
  `)(state, doc, win);
  return { api, win, listeners };
}

function fire(listeners, type, ev) {
  (listeners[type] || []).slice().forEach(fn => fn(ev));
}

// 跑一次完整拖动，返回每帧的片段位置
function drag(cfg) {
  const { videoDur, segId, initialOut, frames, extraSegs = [] } = cfg;
  const state = {
    videoAsset: { duration: videoDur, id: 'v1' },
    subtitleData: {
      frozenFrames: [],
      segments: [{ id: segId, outStart: initialOut[0], outEnd: initialOut[1], start: initialOut[0], end: initialOut[1] }]
    }
  };
  extraSegs.forEach(s => state.subtitleData.segments.push(s));

  const env = makeEnv(state);
  const seg = state.subtitleData.segments[0];
  // 真实应用进入字幕页时先渲染一次 → 初始化 viewRange / _capBaseDuration
  env.api._capRecomputeViewRange();
  env.api._captionDragSegment({ preventDefault() {}, clientX: frames[0].downX, clientY: 100 }, segId);

  const trace = [];
  for (const f of frames) {
    fire(env.listeners, 'pointermove', { clientX: f.mouseX, clientY: 100 });
    trace.push({ i: f.i, mouseX: f.mouseX, outStart: seg.outStart, outEnd: seg.outEnd, len: seg.outEnd - seg.outStart });
  }
  const beforeUp = { outStart: seg.outStart, outEnd: seg.outEnd };
  fire(env.listeners, 'pointerup', { clientX: frames[frames.length - 1].mouseX, clientY: 100 });
  return { trace, beforeUp, afterUp: { outStart: seg.outStart, outEnd: seg.outEnd } };
}

const D = 100;
const OBST = { id: 'OBST', outStart: 8, outEnd: 10, start: 8, end: 10 };

describe('字幕片段拖动 · OUTPUT 时间轴行为锁定', function () {

  it('1. 目标位置恒为「按下锚点 + 累计位移」，连续多帧不重复累加', function () {
    const r = drag({
      videoDur: 22, segId: 'S1', initialOut: [2, 6],
      frames: [
        { i: 1, downX: D, mouseX: 120 }, { i: 2, downX: D, mouseX: 140 }, { i: 3, downX: D, mouseX: 160 },
        { i: 4, downX: D, mouseX: 180 }, { i: 5, downX: D, mouseX: 200 }, { i: 6, downX: D, mouseX: 220 }
      ]
    });
    // 每帧增量 ≈ 20px / pxps（0.1s Snap 网格量化误差 ≤ 0.1s）
    const expectDelta = 20 / PXPS;
    for (let i = 1; i < r.trace.length; i++) {
      const d = r.trace[i].outStart - r.trace[i - 1].outStart;
      expect(Math.abs(d - expectDelta)).toBeLessThan(0.11);
    }
    // 总位移 = 累计像素 / pxps（不允许放大）
    const total = r.trace[r.trace.length - 1].outStart - 2;
    expect(Math.abs(total - 120 / PXPS)).toBeLessThan(0.11);
    // 长度不变
    r.trace.forEach(t => expect(t.len).toBeCloseTo(4, 6));
  });

  it('2. 从左向右拖动遇到障碍物 → 贴在碰撞边界平稳停止，不跳到障碍另一侧', function () {
    const r = drag({
      videoDur: 22, segId: 'S1', initialOut: [2, 6], extraSegs: [OBST],
      frames: [
        { i: 1, downX: D, mouseX: 150 }, { i: 2, downX: D, mouseX: 200 }, { i: 3, downX: D, mouseX: 230 },
        { i: 4, downX: D, mouseX: 250 }, { i: 5, downX: D, mouseX: 270 }, { i: 6, downX: D, mouseX: 300 }
      ]
    });
    const last = r.trace[r.trace.length - 1];
    // 障碍在片段右侧 → 片段的**右端**停在 obstacle.os - 0.2 = 7.8
    expect(last.outEnd).toBeLessThanOrEqual(8 - 0.2 + 1e-6);
    expect(last.outEnd).toBeGreaterThan(7.0);
    // 绝不跳到障碍右侧（> 10）
    expect(last.outEnd).toBeLessThan(10);
    // 单调递增（无跳位/回退）
    for (let i = 1; i < r.trace.length; i++) {
      expect(r.trace[i].outStart).toBeGreaterThanOrEqual(r.trace[i - 1].outStart - 1e-9);
    }
    r.trace.forEach(t => expect(t.len).toBeCloseTo(4, 6));
  });

  it('3. 快速拖过障碍物边界 → 落在鼠标目标，不产生跳位', function () {
    const r = drag({
      videoDur: 22, segId: 'S1', initialOut: [2, 6], extraSegs: [OBST],
      frames: [
        { i: 1, downX: D, mouseX: 150 }, { i: 2, downX: D, mouseX: 400 }, { i: 3, downX: D, mouseX: 600 }
      ]
    });
    // x=400 / x=600 时目标已不与障碍重叠 → 直接落在鼠标目标
    expect(Math.abs(r.trace[1].outStart - (2 + 300 / PXPS))).toBeLessThan(0.15);
    expect(Math.abs(r.trace[2].outStart - (2 + 500 / PXPS))).toBeLessThan(0.15);
    for (let i = 1; i < r.trace.length; i++) {
      expect(r.trace[i].outStart).toBeGreaterThanOrEqual(r.trace[i - 1].outStart - 1e-9);
    }
    r.trace.forEach(t => expect(t.len).toBeCloseTo(4, 6));
  });

  it('4. 鼠标反向离开碰撞区域 → 立即恢复 1:1 跟随（无残留偏移）', function () {
    const r = drag({
      videoDur: 22, segId: 'S1', initialOut: [2, 6], extraSegs: [OBST],
      frames: [
        { i: 1, downX: D, mouseX: 250 }, { i: 2, downX: D, mouseX: 270 },
        { i: 3, downX: D, mouseX: 200 }, { i: 4, downX: D, mouseX: 150 }, { i: 5, downX: D, mouseX: 120 }
      ]
    });
    // 反向回到 x=120 → 应回到 2 + 20/pxps（吸附误差 ≤0.1s）
    expect(Math.abs(r.trace[4].outStart - (2 + 20 / PXPS))).toBeLessThan(0.11);
    // 反向过程单调递减
    for (let i = 1; i < r.trace.length; i++) {
      expect(r.trace[i].outStart).toBeLessThanOrEqual(r.trace[i - 1].outStart + 1e-9);
    }
    r.trace.forEach(t => expect(t.len).toBeCloseTo(4, 6));
  });

  it('5. 靠近最右边界 → 保持长度并平稳贴边（start=18, end=22）', function () {
    const r = drag({
      videoDur: 22, segId: 'S1', initialOut: [2, 6],
      frames: [
        { i: 1, downX: D, mouseX: 300 }, { i: 2, downX: D, mouseX: 450 }, { i: 3, downX: D, mouseX: 550 },
        { i: 4, downX: D, mouseX: 600 }, { i: 5, downX: D, mouseX: 800 }
      ]
    });
    const last = r.trace[r.trace.length - 1];
    expect(last.outStart).toBeCloseTo(18, 2);   // dur(22) - len(4)
    expect(last.outEnd).toBeCloseTo(22, 2);
    expect(last.len).toBeCloseTo(4, 6);          // 长度未被截短
    for (let i = 1; i < r.trace.length; i++) {
      expect(r.trace[i].outStart).toBeGreaterThanOrEqual(r.trace[i - 1].outStart - 1e-9);
    }
  });

  it('6. 松开鼠标后位置稳定（不跳动）', function () {
    const r = drag({
      videoDur: 22, segId: 'S1', initialOut: [2, 6],
      frames: [{ i: 1, downX: D, mouseX: 300 }, { i: 2, downX: D, mouseX: 600 }]
    });
    expect(r.afterUp.outStart).toBe(r.beforeUp.outStart);
    expect(r.afterUp.outEnd).toBe(r.beforeUp.outEnd);
  });

  it('7. 拖动方向正确：纯左拖位置必须单调递减（不会往右跑）', function () {
    const r = drag({
      videoDur: 22, segId: 'S1', initialOut: [10, 14],
      frames: [
        { i: 1, downX: 300, mouseX: 260 }, { i: 2, downX: 300, mouseX: 220 }, { i: 3, downX: 300, mouseX: 180 },
        { i: 4, downX: 300, mouseX: 140 }, { i: 5, downX: 300, mouseX: 100 }
      ]
    });
    for (let i = 1; i < r.trace.length; i++) {
      expect(r.trace[i].outStart).toBeLessThanOrEqual(r.trace[i - 1].outStart + 1e-9);
    }
    expect(Math.abs(r.trace[4].outStart - (10 - 200 / PXPS))).toBeLessThan(0.11);
  });

  it('8. 障碍在拖动起点左侧（向左拖）→ 退到障碍右侧贴边，不穿到障碍左侧', function () {
    const r = drag({
      videoDur: 22, segId: 'S1', initialOut: [12, 16], extraSegs: [OBST],
      frames: [
        { i: 1, downX: D, mouseX: 80 }, { i: 2, downX: D, mouseX: 60 },
        { i: 3, downX: D, mouseX: 40 }, { i: 4, downX: D, mouseX: 20 }
      ]
    });
    const last = r.trace[r.trace.length - 1];
    expect(last.outStart).toBeGreaterThanOrEqual(10 + 0.2 - 1e-6);
    r.trace.forEach(t => expect(t.len).toBeCloseTo(4, 6));
  });

  it('9. 段被左右两个障碍夹住 → 停在两障碍之间，不重叠、不崩溃', function () {
    const r = drag({
      videoDur: 22, segId: 'S1', initialOut: [8, 12],
      extraSegs: [
        { id: 'L', outStart: 4, outEnd: 8, start: 4, end: 8 },
        { id: 'R', outStart: 12, outEnd: 16, start: 12, end: 16 }
      ],
      frames: [{ i: 1, downX: D, mouseX: 150 }, { i: 2, downX: D, mouseX: 200 }]
    });
    r.trace.forEach(t => {
      expect(t.len).toBeCloseTo(4, 6);
      expect(t.outStart).toBeGreaterThanOrEqual(8 - 0.2 - 1e-6);
      expect(t.outEnd).toBeLessThanOrEqual(12 + 0.2 + 1e-6);
    });
  });

  it('10. 源码约束：_captionDragSegment 不再使用 avoidOffset / 上一帧位置作锚点', function () {
    const body = extractFn('_captionDragSegment');
    // 锚点只在 pointerdown 时赋值一次（startOutStart = ...），拖动过程中不得重新赋值
    const assignments = body.match(/startOutStart\s*=/g) || [];
    expect(assignments.length).toBe(1);
    // 目标位置必须基于按下时的锚点 + 累计位移
    expect(body).toMatch(/var desiredOut = startOutStart \+ dsOut;/);
    // 旧的"补偿量累加"机制已移除
    expect(body).not.toMatch(/avoidOffset/);
    expect(body).not.toMatch(/mouseFree/);
    expect(body).not.toMatch(/clampedByRight/);
    // 不允许把上一帧的段位置作为新起点（这会造成位移重复累加）
    expect(body).not.toMatch(/desiredOut\s*=\s*seg\.outStart/);
    // 去掉行注释后再断言（curOutStart 只出现在注释里）
    var code = body.replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/curOutStart/);
    // 必须把拖动起点传给 _capFitSegmentOut，用于判断避让方向
    expect(body).toMatch(/fromOutStart:\s*startOutStart/);
  });

  it('11. 源码约束：_capFitSegmentOut 保留原位命中 + 贴边避让，不再跨障碍跳跃', function () {
    const body = extractFn('_capFitSegmentOut');
    // 原位命中仍返回 clipped:false
    expect(body).toMatch(/if \(tryAt\(start, end\)\) return \{ outStart: start, outEnd: end, clipped: false \};/);
    // 拖动场景（keepLen && fromOutStart）走"贴边避让"分支并返回 clipped:true
    expect(body).toMatch(/if \(_from !== null && keepLen\)/);
    expect(body).toMatch(/return \{ outStart: _cand, outEnd: _candEnd, clipped: true \};/);
    // 贴边距离 0.2s 与最小长度 0.2s 约束不变
    expect(body).toMatch(/0\.2 - len/);            // 退到障碍左侧：r.os - 0.2 - len
    expect(body).toMatch(/\+ 0\.2\);/);            // 退到障碍右侧：r.oe + 0.2
    expect(body).toMatch(/end < start \+ 0\.2 - 1e-6/);
  });
});
