// Rokit · 冻结切点「最右边界」修复专项验证（SOURCE / OUTPUT 语义分离）
//
// 本轮修复的根因（三条同时成立）：
//   1. 右切点上限用的是 SOURCE 维度（原视频物理时长 _vaDur），
//      而右切点的视觉位置与轨道右端都是 OUTPUT 维度（viewRange.end = vaDur + Σduration）
//      → 两套上限不同源，右切点永远到不了最右端，冻结越长差得越远。
//   2. duration（OUTPUT 停留时长）被绑在 SOURCE 区间 [at, end] 上，
//      _capNormalize 用 `end = min(物理时长, end); duration = end - at` 反算
//      → 拉长后的合法停留时长被截断回原视频长度（松手回弹）。
//   3. _outToSourceDelta() 把 SOURCE 的 origEnd 与 OUTPUT 的 _outEndF 直接比较
//      → 跨坐标系比较，产生无意义的 pExt 偏移。
//
// 本文件全部使用**真实生产函数**（从 index.html 切出）+ 合成 pointer 事件，不启动 Electron。
// 测试跑的就是生产代码本身，不复制逻辑。

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
  '_capCollectSegOutBaseline', '_capShiftSegmentsForFrozenChange', '_captionDragCut',
  '_capNormFrozen', '_capNormCut', '_capNormRow', '_capNormSeg', '_capNormalize',
  '_capBackfillOutFields', '_capReconcileSegOutToSource', '_capFrozenLeftCutId', '_capFrozenRightCutId',
  '_capOutputToSource'
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
      _capRecomputeViewRange: _capRecomputeViewRange,
      _capSourceToOutput: _capSourceToOutput,
      _capOutputToSource: _capOutputToSource,
      _capNormalize: _capNormalize,
      _capNormFrozen: _capNormFrozen
    };
  `)(state, doc, win);
  return { api, win, listeners };
}

function fire(listeners, type, ev) {
  (listeners[type] || []).slice().forEach(fn => fn(ev));
}

function mkState(videoDur, frozen, segments) {
  return {
    videoAsset: { duration: videoDur, id: 'v1' },
    subtitleData: {
      frozenFrames: frozen.map(f => Object.assign({}, f)),
      segments: (segments || []).map(s => Object.assign({}, s)),
      cuts: [],
      rows: []
    }
  };
}

// 拖动右切点到指定像素，返回轨迹 + 前后状态
function dragRightCut(state, cutId, id, mouseXs, downX) {
  const env = makeEnv(state);
  const sd = state.subtitleData;
  const fz = sd.frozenFrames.find(f => f.id === id);
  env.api._capRecomputeViewRange();
  const pxps = env.api._captionPxPerSec();
  const viewEnd0 = sd.viewRange.end;
  const finalDur0 = env.api._capFinalOutputDuration();
  env.api._captionDragCut({ preventDefault() {}, clientX: downX, clientY: 100 }, cutId);
  const trace = [];
  for (const mx of mouseXs) {
    fire(env.listeners, 'pointermove', { clientX: mx, clientY: 100 });
    trace.push({
      mouseX: mx, at: fz.at, end: fz.end, dur: fz.duration,
      outAt: env.api._capSourceToOutput(fz.at),
      outEnd: env.api._capSourceToOutput(fz.at) + fz.duration,
      pxps: env.api._captionPxPerSec(),
      viewEnd: sd.viewRange.end,
      finalDur: env.api._capFinalOutputDuration()
    });
  }
  const before = { at: fz.at, end: fz.end, dur: fz.duration };
  fire(env.listeners, 'pointerup', { clientX: mouseXs[mouseXs.length - 1], clientY: 100 });
  return {
    trace, before, pxps, viewEnd0, finalDur0, fz, sd, env,
    after: { at: fz.at, end: fz.end, dur: fz.duration, viewEnd: sd.viewRange.end }
  };
}

const D = 100;

describe('冻结切点最右边界修复 · SOURCE/OUTPUT 语义分离', function () {

  it('V1. 单个冻结：右切点可以精确到达最终 OUTPUT 时间轴最右端', function () {
    const st = mkState(22, [{ id: 'f1', at: 10, duration: 2, end: 12 }]);
    const r = dragRightCut(st, 'fzr:f1', 'f1', [400, 800, 1200, 5000], D);
    const last = r.trace[r.trace.length - 1];
    // 右切点的 OUTPUT 位置 = outAt + duration，必须等于 viewRange.end（轨道右端）
    expect(Math.abs(last.outEnd - r.viewEnd0)).toBeLessThan(0.12);
    // 视觉上：切点像素位置 == 轨道右端像素位置
    const cutPx = last.outEnd * r.pxps;
    const rightPx = r.viewEnd0 * r.pxps;
    expect(Math.abs(cutPx - rightPx)).toBeLessThan(1);
    // SOURCE 侧仍然合法：at（抽帧位置）不变、end ≤ 物理时长
    expect(last.at).toBe(10);
    expect(last.end).toBeLessThanOrEqual(22 + 1e-6);
  });

  it('V2. 持续拉长冻结：最终视频时长与时间轴空间长度同步增长', function () {
    const st = mkState(22, [{ id: 'f1', at: 10, duration: 2, end: 12 }]);
    const r = dragRightCut(st, 'fzr:f1', 'f1', [200, 400, 600, 800], D);
    // 拖动期间 duration（OUTPUT 停留时长）单调不减（到达上限后持平）
    const durs = r.trace.map(t => t.dur);
    for (let i = 1; i < durs.length; i++) {
      expect(durs[i]).toBeGreaterThanOrEqual(durs[i - 1] - 1e-9);
    }
    // 至少有一次实际增长
    expect(durs[durs.length - 1]).toBeGreaterThan(2);
    // 最终时长 = 原视频物理时长 + Σduration（拖动中实时反映在 finalDur 上）
    const lastFinal = r.trace[r.trace.length - 1].finalDur;
    expect(Math.abs(lastFinal - (22 + durs[durs.length - 1]))).toBeLessThan(1e-6);
    // 松手后 viewRange.end 刷新为新的最终时长（时间轴空间长度同步更新）
    expect(Math.abs(r.after.viewEnd - (22 + r.after.dur))).toBeLessThan(0.12);
    // 松手后 viewRange.end 与 finalDur 一致（两者同源）
    expect(Math.abs(r.after.viewEnd - r.env.api._capFinalOutputDuration())).toBeLessThan(0.12);
  });

  it('V3. 多个冻结：拖动其中一个不影响其他冻结的 SOURCE 帧位置与 OUTPUT 映射', function () {
    const st = mkState(22, [
      { id: 'f1', at: 4, duration: 2, end: 6 },
      { id: 'f2', at: 10, duration: 3, end: 13 }
    ]);
    const f1Before = Object.assign({}, st.subtitleData.frozenFrames[0]);
    const f2Before = Object.assign({}, st.subtitleData.frozenFrames[1]);
    const r = dragRightCut(st, 'fzr:f2', 'f2', [200, 400, 600], D);
    const f1After = r.sd.frozenFrames.find(f => f.id === 'f1');
    const f2After = r.sd.frozenFrames.find(f => f.id === 'f2');
    // f2 自身：SOURCE 锚点 at 不变（抽帧位置不变），duration 增长
    expect(f2After.at).toBe(f2Before.at);
    expect(f2After.duration).toBeGreaterThan(f2Before.duration);
    // f1 完全未被修改（SOURCE 帧位置 + 停留时长都不变）
    expect(f1After.at).toBe(f1Before.at);
    expect(f1After.duration).toBe(f1Before.duration);
    // f1 的 OUTPUT 映射不受 f2 拖动影响（f1 在 f2 之前 → outAt 不受 f2 影响）
    expect(r.env.api._capSourceToOutput(f1After.at)).toBe(4);
    // f2 的 OUTPUT 起点 = 10 + f1.duration（f1 在前，累加其 duration）
    expect(r.env.api._capSourceToOutput(f2After.at)).toBe(10 + f1Before.duration);
  });

  it('V4. 冻结时间增长后松手：位置不��弹、不被重新限制', function () {
    const st = mkState(22, [{ id: 'f1', at: 10, duration: 2, end: 12 }]);
    const r = dragRightCut(st, 'fzr:f1', 'f1', [400, 800, 1200], D);
    // 松手前后的 at / end / duration 完全一致（无回弹）
    expect(r.after.at).toBe(r.before.at);
    expect(r.after.end).toBe(r.before.end);
    expect(r.after.dur).toBe(r.before.dur);
    // 且拖动末尾已经到达最右端（不是被截断在中途）
    const last = r.trace[r.trace.length - 1];
    expect(Math.abs(last.outEnd - r.viewEnd0)).toBeLessThan(0.12);
  });

  it('V5. _capNormalize 不再把合法冻结时长钳回原视频物理时长（保存/重进一致）', function () {
    // 模拟拖动后的数据：duration 远大于原视频剩余长度
    const st = mkState(22, [{ id: 'f1', at: 20, duration: 10, end: 22 }]);
    const sd = st.subtitleData;
    const before = { at: sd.frozenFrames[0].at, dur: sd.frozenFrames[0].duration };
    // normalize 走一遍（保存草稿 / 完成生成前都会调用）
    st.subtitleData.rows = [];
    const norm = st.subtitleData;
    const api = makeEnv(st).api;
    api._capNormalize();
    const fz = norm.frozenFrames[0];
    // duration 保持不变（不被 end ≤ 物理时长截断）
    expect(fz.duration).toBeCloseTo(before.dur, 9);
    // at 不变（SOURCE 锚点合法）
    expect(fz.at).toBe(before.at);
    // end 仍是合法的 SOURCE 区间终点（≤ 物理时长）
    expect(fz.end).toBeLessThanOrEqual(22 + 1e-6);
    expect(fz.end).toBeGreaterThan(fz.at);
    // 最终时长 = 物理时长 + duration
    expect(Math.abs(api._capFinalOutputDuration() - 32)).toBeLessThan(1e-6);
  });

  it('V6. 冻结帧始终来自原视频有效帧；冻结期间 OUTPUT 时间继续推进', function () {
    const st = mkState(22, [{ id: 'f1', at: 10, duration: 5, end: 15 }]);
    const api = makeEnv(st).api;
    // 冻结 OUTPUT 区间 = [outAt, outAt + duration]
    const outAt = api._capSourceToOutput(10);
    expect(outAt).toBe(10);
    // 冻结区间内任意 OUTPUT 时刻 → source 固定在 f.at（画面不变）
    expect(api._capOutputToSource(outAt + 0.5)).toBe(10);
    expect(api._capOutputToSource(outAt + 4.9)).toBe(10);
    // 冻结结束后 OUTPUT 继续推进，source 从 f.at 继续（画面恢复播放）
    expect(api._capOutputToSource(outAt + 5.5)).toBeCloseTo(10.5, 6);
    // 抽帧位置 f.at 始终在原视频物理时长内
    expect(st.subtitleData.frozenFrames[0].at).toBeLessThanOrEqual(22);
  });

  it('V7. 旧数据兼容：end-at === duration 的历史数据不被破坏', function () {
    // 旧格式：at=10, end=12, duration=2
    const api = makeEnv(mkState(22, [{ id: 'f1', at: 10, duration: 2, end: 12 }])).api;
    const norm = api._capNormFrozen({ id: 'f1', at: 10, end: 12, duration: 2 });
    expect(norm.at).toBe(10);
    expect(norm.end).toBe(12);
    expect(norm.duration).toBe(2);
    // 更旧的格式：只有 at + duration，没有 end
    const legacy = api._capNormFrozen({ id: 'f2', at: 10, duration: 2 });
    expect(legacy.end).toBe(12);
    expect(legacy.duration).toBe(2);
  });

  it('V8. 源码约束：duration 是 OUTPUT 权威值，不再被 SOURCE 区间长度反算', function () {
    const norm = extractFn('_capNormalize');
    // normalize 不得再用 `duration = end - at` 反算
    expect(norm).not.toMatch(/var duration = end - at;/);
    // 必须保留 duration 权威值
    expect(norm).toMatch(/var duration = \(typeof f\.duration === 'number' && f\.duration > 0\)/);
    // 去重叠挤退不再重算 duration
    expect(norm).not.toMatch(/curF\.duration = curF\.end - curF\.at;/);

    const normFrozen = extractFn('_capNormFrozen');
    expect(normFrozen).not.toMatch(/duration = end - at;\s*\n\s*\}\s*else/);
    expect(normFrozen).toMatch(/duration: Math\.max\(0\.2, duration\),/);
  });

  it('V9. 源码约束：_outToSourceDelta 不再跨坐标系比较', function () {
    const body = extractFn('_captionDragCut');
    // 旧的跨维度比较已消除
    expect(body).not.toMatch(/if \(origEnd > _outEndF - 1e-6\)/);
    // 改为同坐标系（SOURCE 维度）比较
    expect(body).toMatch(/var _srcEndF = _f\.at \+ _f\.dur;/);
    expect(body).toMatch(/if \(origEnd > _srcEndF - 1e-6\)/);
    // 右切点不再使用 _outToSourceDelta
    expect(body).toMatch(/_origFzDur \+ dsOut/);
  });

  it('V10. 字幕片段拖动/缩放/避让逻辑未被修改', function () {
    const seg = extractFn('_captionDragSegment');
    expect(seg).toMatch(/var desiredOut = startOutStart \+ dsOut;/);
    expect(seg).not.toMatch(/avoidOffset/);
    const fit = extractFn('_capFitSegmentOut');
    expect(fit).toMatch(/if \(_from !== null && keepLen\)/);
  });

  it('V11. 渲染位置与拖动位置使用同一套 OUTPUT 映射', function () {
    const scene = extractFn('renderCaptionsSceneTrack');
    // 冻结块的 OUTPUT 区间 = outAt + duration（与 _capSourceToOutput 同源）
    expect(scene).toMatch(/var outAt = _capSourceToOutput\(f\.at\);/);
    expect(scene).toMatch(/var outEnd = outAt \+ fDurSrc;/);
    // 右切点 left = outEnd 的像素位置（拖动命中点 = 渲染位置）
    expect(scene).toMatch(/var atRight = \(outEnd - r\.start\) \* _captionPxPerSec\(\);/);
    // 右切点 div 的 left 直接用 atRight
    expect(scene).toMatch(/data-cut-id="' \+ esc\(fzRightId\) \+ '" data-cut-anchor="line" '/);
    expect(scene).toMatch(/style="position:absolute;left:' \+ atRight \+ 'px;/);
    // 冻结主体宽度 = atRight - atLeft（同一映射）
    expect(scene).toMatch(/var width = Math\.max\(20, atRight - atLeft\);/);
    // 轨道 inner 宽度 = viewRange.end × pxps（与右切点上限同源）
    expect(scene).toMatch(/_captionRange\(\)\.end \* _captionPxPerSec\(\)/);
  });

  it('V12. 右切点可跨越其他冻结到达最右端（不受前序冻结阻断）', function () {
    // 两个冻结：f1 在前（at=4, dur=2），f2 在后（at=10, dur=3）
    // 拖 f2 的右切点到最右 → f2 的 OUTPUT 终点 = viewRange.end
    const st = mkState(22, [
      { id: 'f1', at: 4, duration: 2, end: 6 },
      { id: 'f2', at: 10, duration: 3, end: 13 }
    ]);
    const r = dragRightCut(st, 'fzr:f2', 'f2', [400, 900, 2000], D);
    const last = r.trace[r.trace.length - 1];
    // f2 的 OUTPUT 起点 = 10 + f1.duration = 12
    expect(Math.abs(last.outAt - 12)).toBeLessThan(1e-6);
    // 到达最右端
    expect(Math.abs(last.outEnd - r.viewEnd0)).toBeLessThan(0.12);
    // f1 未受影响
    const f1 = r.sd.frozenFrames.find(f => f.id === 'f1');
    expect(f1.duration).toBe(2);
    expect(f1.at).toBe(4);
  });
});
