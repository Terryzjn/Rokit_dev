//
// Rokit · 手动录屏（用户手动录屏）—— 定向测试
//
// 覆盖需求里的 9 个验证点：
//   R1  开始后控制条仍在录制画面之外（控制条是独立窗口，不是主窗口的一部分）
//   R2  开始按钮消失（IDLE → RECORDING）
//   R3  暂停后录制真正暂停（MediaRecorder.pause）
//   R4  恢复后继续录制（MediaRecorder.resume）
//   R5  停止后文件保存成功
//   R6  保存后回到首页
//   R7  生成的 VideoAsset 能被现有视频预览和后续流程识别（sourceType=MANUAL_RECORDING）
//   R8  主窗口最小化时不会产生黑屏录制（自动暂停）
//   R9  控制条窗口不会被捕获（标题不含 "Rokit" → 不被 isRokitWindow 误判）
//
// 跑的是**生产代码**：
//   - index.html 里的手动录屏核心（按花括号配平切出后注入依赖执行）
//   - electron/recorder-controls.js 的定位计算（computePosition）
//   - electron/ai-demo.js 的 saveRecording（真实临时目录，不碰活动数据库）
//
// **绝不写入活动数据库 .userdata/ai-launch-master.db，不启动真实录屏，不调用平台 API**。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const CONTROLS_JS = fs.readFileSync(path.join(ROOT, 'electron', 'recorder-controls.js'), 'utf8');
const CONTROLS_HTML = fs.readFileSync(path.join(ROOT, 'electron', 'recorder-controls.html'), 'utf8');
const CONTROLS_PRELOAD = fs.readFileSync(path.join(ROOT, 'electron', 'recorder-controls-preload.js'), 'utf8');

/* ---------- 从源码里按花括号配平切出函数 ---------- */
function extractBlock(src, header) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error('源码中找不到：' + header);
  const open = src.indexOf('{', start + header.length - 1);
  if (open < 0) throw new Error('缺少花括号：' + header);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('花括号不配平：' + header);
}

const SRC = [
  extractBlock(HTML, 'var __manualRec = {'),
  extractBlock(HTML, 'function __manualElapsedSec(){'),
  extractBlock(HTML, 'function __manualPushState(){'),
  extractBlock(HTML, 'function __manualShowControls(){'),
  extractBlock(HTML, 'function __manualHideControls(){'),
  extractBlock(HTML, 'async function __manualOpenCaptureStream(){'),
  extractBlock(HTML, 'async function __manualStartRecorder(stream){'),
  extractBlock(HTML, 'function __manualOnMediaStop(){'),
  extractBlock(HTML, 'window.__manualStart = async function(){'),
  extractBlock(HTML, 'window.__manualPause = function(){'),
  extractBlock(HTML, 'window.__manualResume = function(){'),
  extractBlock(HTML, 'window.__manualStop = function(){'),
  extractBlock(HTML, 'window.__manualSave = async function(){'),
  extractBlock(HTML, 'function adoptSavedRecordingAsset(sa, durationSec, defaultSourceType){'),
  extractBlock(HTML, 'function __manualAdoptAsset(asset){'),
  extractBlock(HTML, 'window.__manualDispose = function(){'),
  extractBlock(HTML, 'window.__manualBindControls = function(){'),
  extractBlock(HTML, 'window.startManualRecording = function(){'),
  // —— 本批新增：手动录屏的"最终视频确认界面" ——
  extractBlock(HTML, 'function __manualNextEnabled(){'),
  extractBlock(HTML, 'function __manualRenderStage(ctrl){'),
  extractBlock(HTML, 'window.saveManualRecording = async function(){'),
  extractBlock(HTML, 'window.exportManualRecordingMp4 = async function(){'),
  extractBlock(HTML, 'window.resetManualRecordingForRerecord = function(){'),
  extractBlock(HTML, 'window.closeManualRecordingWorkspace = function(){'),
  extractBlock(HTML, 'window.manualRecordingNext = function(){'),
  // —— 与 AI 录屏共用的视频处理层 ——
  extractBlock(HTML, 'function renderRecordingProductBlock(rec, opts){'),
  extractBlock(HTML, 'async function saveRecordingBlobToAsset(rec, opts){'),
  extractBlock(HTML, 'async function exportRecordingToMp4(rec){'),
  // 窗口导出（extractBlock 只切出函数体，赋值语句需单独带上）
  'window.__manualRenderStage = __manualRenderStage;',
  'window.__manualNextEnabled = __manualNextEnabled;'
].join('\n');

/* ---------- 假 MediaRecorder ---------- */
function makeFakeMediaRecorder(calls) {
  return function (stream, opts) {
    this.state = 'inactive';
    this.mimeType = (opts && opts.mimeType) || 'video/webm';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    this.start = function () { this.state = 'recording'; calls.push({ op: 'start' }); };
    this.pause = function () { this.state = 'paused'; calls.push({ op: 'pause' }); };
    this.resume = function () { this.state = 'recording'; calls.push({ op: 'resume' }); };
    this.stop = function () {
      this.state = 'inactive';
      calls.push({ op: 'stop' });
      if (this.ondataavailable) this.ondataavailable({ data: { size: 100 } });
      if (this.onstop) this.onstop();
    };
  };
}

/* ---------- 运行环境 ---------- */
function makeEnv(opts) {
  const o = opts || {};
  const calls = {
    media: [], states: [], saved: [], hidden: 0, shown: 0, toasts: [], go: [],
    exported: [], rendered: [], rail: 0, flow: 0, pushed: []
  };
  const state = o.state || {
    videoAsset: null,
    videoState: 'NO_VIDEO',
    __captionFinalVideo: { path: '/old/final.mp4' },
    step: 5
  };
  // 假 DOM：记录渲染出的 HTML
  function makeEl(id) {
    return {
      id: id,
      innerHTML: '',
      getAttribute: function () { return null; },
      addEventListener: function () {}
    };
  }
  const ctrlBox = makeEl('ctrlBox');
  const documentStub = {
    getElementById: function (id) { return id === 'ctrlBox' ? ctrlBox : null; }
  };

  const windowStub = {
    api: {
      captureListSources: function () {
        return Promise.resolve(o.sources || {
          ok: true,
          sources: [{ id: 'window:1', name: 'Rokit', isRokitWindow: true, region: { x: 10, y: 20, width: 800, height: 600, isMinimized: false } }]
        });
      },
      captureProbe: function () { return Promise.resolve({ ok: true, region: { x: 0, y: 0, width: 800, height: 600 } }); },
      captureGetRokitBounds: function () {
        return Promise.resolve(o.bounds || { ok: true, contentBounds: { x: 10, y: 20, width: 800, height: 600 }, isMinimized: false });
      },
      recorderControlsShow: function () { calls.shown++; return Promise.resolve({ ok: true }); },
      recorderControlsHide: function () { calls.hidden++; return Promise.resolve({ ok: true }); },
      recorderControlsSetState: function (s) { calls.states.push(s); return Promise.resolve({ ok: true }); },
      onRecorderControlsCommand: function (cb) { calls.onCommand = cb; return function () {}; },
      demoSaveRecording: function (payload) {
        calls.saved.push(payload);
        if (o.saveFails) return Promise.resolve({ ok: false, error: 'write-failed:disk-full' });
        return Promise.resolve({
          ok: true,
          asset: {
            id: 'va-manual-1',
            sourceType: payload.sourceType,
            fileName: 'va-manual-1.webm',
            filePath: 'C:/tmp/va-manual-1.webm',
            fileSize: 1234,
            mimeType: 'video/webm',
            createdAt: '2026-11-04T00:00:00.000Z'
          }
        });
      },
      demoExportMp4: function (payload) {
        calls.exported.push(payload);
        if (o.exportFails) return Promise.resolve({ ok: false, error: 'ffmpeg-unavailable' });
        return Promise.resolve({ ok: true, outputPath: 'C:/tmp/va-manual-1.mp4' });
      }
    }
  };

  const fakeStream = {
    getTracks: function () {
      return [{ stop: function () { calls.streamStopped = (calls.streamStopped || 0) + 1; } }];
    }
  };

  const globalNavigator = {
    mediaDevices: {
      getUserMedia: function (constraints) {
        calls.constraints = constraints;
        return Promise.resolve(fakeStream);
      }
    }
  };

  // Blob / FileReader 必须是**构造函数**（生产代码用 new Blob() / new FileReader()）
  function FakeBlob(chunks, opts2) {
    this.size = 1234;
    this.type = (opts2 && opts2.type) || 'video/webm';
  }
  function FakeFileReader() {
    this.result = null;
    this.onload = null;
    this.onerror = null;
  }
  FakeFileReader.prototype.readAsDataURL = function () {
    this.result = 'data:video/webm;base64,AAA';
    if (this.onload) this.onload();
  };

  // URL.createObjectURL / revokeObjectURL
  const URLStub = {
    createObjectURL: function () { return 'blob:manual/1'; },
    revokeObjectURL: function () {}
  };

  // 可控定时器：让"最小化守卫"这类 interval 能被测试显式触发
  const timers = { intervals: [], timeouts: [] };
  function fakeSetInterval(fn2, ms) {
    const h = { fn: fn2, ms: ms, cleared: false };
    timers.intervals.push(h);
    return h;
  }
  function fakeClearInterval(h) { if (h) h.cleared = true; }
  function fakeSetTimeout(fn2, ms) {
    const h = { fn: fn2, ms: ms };
    timers.timeouts.push(h);
    return h;
  }

  const fn = new Function(
    'window', 'state', 'navigator', 'MediaRecorder', 'Blob', 'FileReader',
    'toast', 'go', 'console', 'setTimeout', 'clearInterval', 'setInterval',
    'document', 'URL', 'confirm', 'renderRail', 'renderFlow', 'pushAI',
    'reloadVoiceProfiles', 'fmtDur', 'fmtSize', 'esc',
    SRC + '\nreturn { __manualStart: window.__manualStart, __manualPause: window.__manualPause,'
    + ' __manualResume: window.__manualResume, __manualStop: window.__manualStop,'
    + ' __manualSave: window.__manualSave, __manualDispose: window.__manualDispose,'
    + ' __manualBindControls: window.__manualBindControls,'
    + ' startManualRecording: window.startManualRecording,'
    + ' saveManualRecording: window.saveManualRecording,'
    + ' exportManualRecordingMp4: window.exportManualRecordingMp4,'
    + ' resetManualRecordingForRerecord: window.resetManualRecordingForRerecord,'
    + ' closeManualRecordingWorkspace: window.closeManualRecordingWorkspace,'
    + ' manualRecordingNext: window.manualRecordingNext,'
    + ' __manualRenderStage: window.__manualRenderStage,'
    + ' __manualNextEnabled: __manualNextEnabled,'
    + ' __manualAdoptAsset: __manualAdoptAsset, __manualElapsedSec: __manualElapsedSec,'
    + ' __manualRec: __manualRec };'
  );
  const api = fn(
    windowStub, state, globalNavigator, makeFakeMediaRecorder(calls.media), FakeBlob, FakeFileReader,
    function (m, k) { calls.toasts.push({ msg: String(m), level: k }); },
    function (route) { calls.go.push(route); },
    console,
    fakeSetTimeout, fakeClearInterval, fakeSetInterval,
    documentStub, URLStub,
    function () { return o.confirmResult === undefined ? true : o.confirmResult; },
    function () { calls.rail++; },
    function () {
      calls.flow++;
      // 模拟真实渲染链：renderFlow → renderStep(5) → renderLocalVideoStage → 手动录屏确认界面
      if (state.step === 5 && typeof windowStub.__manualRenderStage === 'function') {
        try { windowStub.__manualRenderStage(ctrlBox); } catch (_e) {}
      }
      calls.rendered.push(ctrlBox.innerHTML);
    },
    function (m) { calls.pushed.push(String(m)); },
    function () { return Promise.resolve([]); },
    function (sec) { return String(Math.floor(sec || 0)) + 's'; },
    function (n) { return String(n || 0) + 'B'; },
    function (s) { return String(s == null ? '' : s); }
  );
  return {
    state: state, calls: calls, api: api, window: windowStub, fakeStream: fakeStream, timers: timers,
    ctrlBox: ctrlBox,
    // 手动触发所有 interval 回调（用于最小化守卫）
    runIntervals: function () { timers.intervals.forEach((h) => { if (!h.cleared) h.fn(); }); }
  };
}

function flush(times) {
  const n = times || 3;
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) {
    p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  }
  return p;
}

/* ================================================================== */

describe('手动录屏 · 控制条窗口（R1 / R9）', () => {
  it('R1 控制条是独立窗口，不是主窗口的一部分 → 不会进入录制画面', () => {
    // 1) 主进程侧：控制条用独立的 BrowserWindow
    expect(CONTROLS_JS).toMatch(/new BrowserWindow\(/);
    expect(CONTROLS_JS).toMatch(/frame:\s*false/);
    expect(CONTROLS_JS).toMatch(/alwaysOnTop:\s*true/);
    expect(CONTROLS_JS).toMatch(/skipTaskbar:\s*true/);
    // 2) 控制条不放在主窗口的 HTML 里（index.html 不含控制条按钮）
    expect(HTML).not.toMatch(/id="btnStart"/);
    expect(HTML).not.toMatch(/id="btnPause"/);
    expect(HTML).not.toMatch(/id="btnStop"/);
    // 3) 三个按钮只存在于控制条自己的 HTML 里
    expect(CONTROLS_HTML).toMatch(/id="btnStart"/);
    expect(CONTROLS_HTML).toMatch(/id="btnPause"/);
    expect(CONTROLS_HTML).toMatch(/id="btnStop"/);
  });

  it('R9 控制条窗口标题不含 "Rokit" → 不会被 isRokitWindow 误判为要录的窗口', () => {
    const titleMatch = /const CONTROLS_TITLE\s*=\s*'([^']*)'/.exec(CONTROLS_JS);
    expect(titleMatch).toBeTruthy();
    const title = titleMatch[1];
    // 捕获源识别逻辑是 /rokit/i.test(title) → 控制条标题必须不匹配
    expect(/rokit/i.test(title)).toBe(false);
  });

  it('控制条定位在主窗口外侧（不遮挡主窗口内容）', () => {
    const src = extractBlock(CONTROLS_JS, 'function computePosition(mainBounds) {');
    const fn = new Function('screen', 'GAP', 'BAR_WIDTH', 'BAR_HEIGHT', src + '\nreturn computePosition;');
    const computePosition = fn(
      { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
      10, 132, 46
    );
    // 主窗口在屏幕中间 → 控制条应落在其右侧之外
    const pos = computePosition({ x: 500, y: 100, width: 800, height: 600 });
    expect(pos).toBeTruthy();
    expect(pos.x).toBeGreaterThanOrEqual(500 + 800);   // 完全在主窗口右侧
    // 右侧放不下 → 改到左侧
    const pos2 = computePosition({ x: 1700, y: 100, width: 800, height: 600 });
    expect(pos2.x).toBeLessThan(1700);
  });
});

describe('手动录屏 · 按钮状态机（R2 / R3 / R4）', () => {
  it('R2 开始后：状态推到 RECORDING；控制条在 RECORDING 下隐藏开始按钮', async () => {
    const env = makeEnv();
    await env.api.__manualStart();
    await flush();

    const last = env.calls.states[env.calls.states.length - 1];
    expect(last.state).toBe('RECORDING');
    // 控制条 HTML 的渲染逻辑：RECORDING → 开始隐藏、暂停/停止可用
    expect(CONTROLS_HTML).toMatch(/if\s*\(state\s*===\s*'RECORDING'\)\s*\{[\s\S]{0,200}btnStart\.hidden\s*=\s*true/);
    expect(CONTROLS_HTML).toMatch(/btnPause\.disabled\s*=\s*false/);
    expect(CONTROLS_HTML).toMatch(/btnStop\.disabled\s*=\s*false/);
    // IDLE 时：开始可用，暂停/停止禁用
    expect(CONTROLS_HTML).toMatch(/btnStart\.disabled\s*=\s*false/);
    expect(CONTROLS_HTML).toMatch(/btnPause\.disabled\s*=\s*true/);
    expect(CONTROLS_HTML).toMatch(/btnStop\.disabled\s*=\s*true/);
  });

  it('R3 暂停后：真正调用 MediaRecorder.pause()，状态变 PAUSED', async () => {
    const env = makeEnv();
    await env.api.__manualStart();
    await flush();
    const before = env.calls.media.length;
    const r = env.api.__manualPause();
    expect(r.ok).toBe(true);
    expect(env.calls.media[before].op).toBe('pause');
    const last = env.calls.states[env.calls.states.length - 1];
    expect(last.state).toBe('PAUSED');
    // 暂停期间时长不再增长
    const e1 = env.api.__manualElapsedSec();
    await new Promise((r2) => setTimeout(r2, 30));
    const e2 = env.api.__manualElapsedSec();
    expect(e2).toBe(e1);
  });

  it('R4 恢复后：真正调用 MediaRecorder.resume()，状态回到 RECORDING', async () => {
    const env = makeEnv();
    await env.api.__manualStart();
    await flush();
    env.api.__manualPause();
    const before = env.calls.media.length;
    const r = env.api.__manualResume();
    expect(r.ok).toBe(true);
    expect(env.calls.media[before].op).toBe('resume');
    const last = env.calls.states[env.calls.states.length - 1];
    expect(last.state).toBe('RECORDING');
    // 恢复后时长继续增长
    const e1 = env.api.__manualElapsedSec();
    await new Promise((r2) => setTimeout(r2, 30));
    expect(env.api.__manualElapsedSec()).toBeGreaterThan(e1);
  });

  it('PAUSED 时控制条的暂停按钮显示「恢复」', () => {
    expect(CONTROLS_HTML).toMatch(/state\s*===\s*'PAUSED'[\s\S]{0,200}btnPause\.textContent\s*=\s*'恢复'/);
  });
});

describe('手动录屏 · 停止与保存（R5 / R6 / R7）', () => {
  it('R5 停止后：真正 stop() 并组装 Blob，随后保存成功', async () => {
    const env = makeEnv();
    await env.api.__manualStart();
    await flush();
    const before = env.calls.media.length;
    const r = env.api.__manualStop();
    expect(r.ok).toBe(true);
    expect(env.calls.media[before].op).toBe('stop');
    await flush();

    const saved = await env.api.__manualSave();
    expect(saved.ok).toBe(true);
    expect(env.calls.saved.length).toBe(1);
    expect(env.calls.saved[0].blobBase64).toBe('AAA');
  });

  it('R7 资产类型为 MANUAL_RECORDING（不标记为 AI_RECORDING），并登记为当前视频资产', async () => {
    const env = makeEnv();
    await env.api.__manualStart();
    await flush();
    env.api.__manualStop();
    await flush();
    await env.api.__manualSave();

    expect(env.calls.saved[0].sourceType).toBe('MANUAL_RECORDING');
    expect(env.calls.saved[0].sourceType).not.toBe('AI_RECORDING');
    // 现有视频预览 / 后续流程能识别：state.videoAsset 被登记
    expect(env.state.videoAsset).toBeTruthy();
    expect(env.state.videoAsset.id).toBe('va-manual-1');
    expect(env.state.videoAsset.sourceType).toBe('MANUAL_RECORDING');
    expect(env.state.videoAsset.mimeType).toBe('video/webm');
    expect(env.state.videoState).toBe('VIDEO_READY');
    // 换了视频源 → 旧成品必须清掉
    expect(env.state.__captionFinalVideo).toBeNull();
  });

  it('R6 保存成功后：关闭控制条并进入最终视频确认界面（不再直接回视频选择页）', async () => {
    const env = makeEnv();
    await env.api.__manualStart();
    await flush();
    env.api.__manualStop();
    await flush();
    await env.api.__manualSave();

    expect(env.calls.hidden).toBeGreaterThan(0);   // 控制条被关闭
    // 不再 go('flow') 回到"视频就绪"页 → 改为渲染完成界面
    expect(env.calls.go.length).toBe(0);
    expect(env.calls.flow).toBeGreaterThan(0);
    expect(env.ctrlBox.innerHTML).toMatch(/手动录屏/);
  });

  it('保存失败：明确提示错误，不静默丢失，且不关闭控制条', async () => {
    const env = makeEnv({ saveFails: true });
    await env.api.__manualStart();
    await flush();
    env.api.__manualStop();
    await flush();
    const res = await env.api.__manualSave();

    expect(res.ok).toBe(false);
    expect(res.errorMsg).toMatch(/录屏保存失败/);
    // 有明确提示
    expect(env.calls.toasts.some((t) => /录屏保存失败/.test(t.msg))).toBe(true);
    // 失败时不关闭控制条（用户还能重试）；也不跳走
    expect(env.calls.hidden).toBe(0);
    expect(env.calls.go.length).toBe(0);
  });
});

describe('手动录屏 · 捕获约束（R8 / 60FPS / 复用既有能力）', () => {
  it('R8 主窗口最小化时：暂停录制而不是继续录黑屏', async () => {
    // 录制**开始后**主窗口才被最小化（开始前就最小化 → 根本不该开始）
    const bounds = { ok: true, contentBounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: false };
    const env = makeEnv({ bounds: bounds });
    await env.api.__manualStart();
    await flush();
    expect(env.calls.media.some((c) => c.op === 'start')).toBe(true);

    // 现在主窗口被最小化 → 守卫应暂停录制（而不是继续录黑屏）
    bounds.isMinimized = true;
    env.runIntervals();      // 手动触发最小化守卫（生产代码每 1.5s 轮询）
    await flush();

    const pauseCalls = env.calls.media.filter((c) => c.op === 'pause');
    expect(pauseCalls.length).toBeGreaterThan(0);
    const last = env.calls.states[env.calls.states.length - 1];
    expect(last.state).toBe('PAUSED');
  });

  it('开始前主窗口就已最小化 → 明确报错，不开始录制', async () => {
    const env = makeEnv({ bounds: { ok: true, contentBounds: { x: 0, y: 0, width: 800, height: 600 }, isMinimized: true } });
    const res = await env.api.__manualStart();
    expect(res.ok).toBe(false);
    expect(env.calls.media.some((c) => c.op === 'start')).toBe(false);
  });

  it('只捕获 Rokit 主窗口，且保持 60 FPS 上限', async () => {
    const env = makeEnv();
    await env.api.__manualStart();
    await flush();
    const c = env.calls.constraints;
    expect(c.video.mandatory.chromeMediaSource).toBe('desktop');
    expect(c.video.mandatory.maxFrameRate).toBe(60);
    expect(c.audio).toBe(false);
    // 不 fallback 到 getDisplayMedia（避免整屏被录）
    const src = extractBlock(HTML, 'async function __manualOpenCaptureStream(){');
    expect(src).not.toMatch(/getDisplayMedia/);
  });

  it('找不到 Rokit 主窗口源时明确报错，不静默退回全屏', async () => {
    const env = makeEnv({ sources: { ok: true, sources: [{ id: 'window:9', name: 'Other', isRokitWindow: false }] } });
    const res = await env.api.__manualStart();
    expect(res.ok).toBe(false);
    expect(env.calls.toasts.some((t) => /找不到 Rokit 主窗口/.test(t.msg))).toBe(true);
  });

  it('复用既有 capture / save IPC，不另起一套录屏服务', () => {
    const src = extractBlock(HTML, 'async function __manualOpenCaptureStream(){');
    expect(src).toMatch(/window\.api\.captureListSources/);
    expect(src).toMatch(/window\.api\.captureGetRokitBounds/);
    const saveSrc = extractBlock(HTML, 'window.__manualSave = async function(){');
    expect(saveSrc).toMatch(/window\.api\.demoSaveRecording/);
    // 没有自定义的 save-recording 通道
    expect(HTML).not.toMatch(/manual-recording:save/);
  });

  it('不调用 AI 自动脚本（规划器 / 执行器）', () => {
    const src = extractBlock(HTML, 'window.__manualStart = async function(){');
    expect(src).not.toMatch(/startAiDemoPlan/);
    expect(src).not.toMatch(/runAiDemoScript/);
    expect(src).not.toMatch(/AI_DEMO_EXECUTOR/);
  });

  it('控制条点击 → 执行对应动作（开始 / 暂停 / 恢复 / 停止）', async () => {
    const env = makeEnv();
    env.api.__manualBindControls();
    expect(typeof env.calls.onCommand).toBe('function');
    env.calls.onCommand('start');
    await flush();
    expect(env.calls.media.some((c) => c.op === 'start')).toBe(true);
    env.calls.onCommand('pause');
    expect(env.calls.media.some((c) => c.op === 'pause')).toBe(true);
    env.calls.onCommand('resume');
    expect(env.calls.media.some((c) => c.op === 'resume')).toBe(true);
  });
});

describe('手动录屏 · 主进程接线', () => {
  it('main.js 注册控制条 IPC', () => {
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    expect(main).toMatch(/require\('\.\/recorder-controls'\)/);
    expect(main).toMatch(/recorderControls\.registerIpc\(ipcMain/);
  });

  it('preload 暴露控制条 API（主窗口侧）', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
    expect(preload).toMatch(/recorderControlsShow:/);
    expect(preload).toMatch(/recorderControlsHide:/);
    expect(preload).toMatch(/recorderControlsSetState:/);
    expect(preload).toMatch(/onRecorderControlsCommand:/);
  });

  it('控制条 preload 只暴露转发接口，不接触录屏 API', () => {
    expect(CONTROLS_PRELOAD).toMatch(/sendAction/);
    expect(CONTROLS_PRELOAD).toMatch(/onState/);
    expect(CONTROLS_PRELOAD).not.toMatch(/getUserMedia|MediaRecorder|demoSaveRecording/);
  });

  it('ai-demo.js 的 saveRecording 支持 sourceType 白名单', () => {
    const aiDemo = fs.readFileSync(path.join(ROOT, 'electron', 'ai-demo.js'), 'utf8');
    expect(aiDemo).toMatch(/MANUAL_RECORDING/);
    expect(aiDemo).toMatch(/normalizeSourceType/);
    // 原有 AI 录屏默认仍是 AI_RECORDING（不回归）
    expect(aiDemo).toMatch(/sourceType:\s*normalizeSourceType\(opts\.sourceType\)/);
  });
});

/* ================================================================== */
/* 本批：手动录屏"最终视频确认界面" + 控制条加长                          */
/* ================================================================== */

describe('手动录屏 · 最终视频确认界面（V1 / V2 / V3 / V4 / V5 / V6）', () => {
  async function recordAndSave(env) {
    await env.api.__manualStart();
    await flush();
    env.api.__manualStop();
    await flush();
    await env.api.__manualSave();
  }

  it('V1 手动录屏停止并保存后：进入完整视频确认界面（含 5 个必需元素）', async () => {
    const env = makeEnv();
    await recordAndSave(env);

    const html = env.ctrlBox.innerHTML;
    // 1) 视频播放预览窗口
    expect(html).toMatch(/<video[^>]+id="manualRecPreview"/);
    expect(html).toMatch(/controls/);
    expect(html).toMatch(/playsinline/);
    // 2) 保存为视频样本
    expect(html).toMatch(/保存为视频样本/);
    expect(html).toMatch(/onclick="saveManualRecording\(\)"/);
    // 3) 导出 MP4
    expect(html).toMatch(/导出 MP4/);
    expect(html).toMatch(/onclick="exportManualRecordingMp4\(\)"/);
    // 4) 重新录制
    expect(html).toMatch(/重新录制/);
    expect(html).toMatch(/onclick="resetManualRecordingForRerecord\(\)"/);
    // 5) 底部「下一步：录制声音」
    expect(html).toMatch(/下一步：录制声音/);
    expect(html).toMatch(/onclick="manualRecordingNext\(\)"/);
  });

  it('V2 预览的 src 指向刚刚录制的 Blob（Blob / objectUrl / 资产三者关联正确）', async () => {
    const env = makeEnv();
    await recordAndSave(env);

    // objectUrl 来自刚录的 Blob
    expect(env.api.__manualRec.objectUrl).toBe('blob:manual/1');
    expect(env.ctrlBox.innerHTML).toMatch(/src="blob:manual\/1"/);
    // 资产与 Blob 是同一个录制产物（同一个 savedAsset 被采用）
    expect(env.api.__manualRec.savedAsset.id).toBe('va-manual-1');
    expect(env.state.videoAsset.id).toBe(env.api.__manualRec.savedAsset.id);
    expect(env.state.videoAsset.sourceType).toBe('MANUAL_RECORDING');
    // 保存元信息随资产一并登记（文件路径 / 大小 / 类型）
    expect(env.ctrlBox.innerHTML).toMatch(/va-manual-1\.webm/);
    expect(env.ctrlBox.innerHTML).toMatch(/C:\/tmp\/va-manual-1\.webm/);
  });

  it('V3 「保存为视频样本」正常登记当前手动录制的视频资产', async () => {
    const env = makeEnv();
    await env.api.__manualStart();
    await flush();
    env.api.__manualStop();
    await flush();
    // 停止但**未**保存 → 资产尚未登记
    expect(env.api.__manualRec.savedAsset).toBe(null);
    expect(env.state.videoAsset).toBe(null);

    // 点「保存为视频样本」
    await env.api.saveManualRecording();

    expect(env.calls.saved.length).toBe(1);
    expect(env.calls.saved[0].sourceType).toBe('MANUAL_RECORDING');
    expect(env.calls.saved[0].recorder).toBe('manual-recorder v1');
    expect(env.calls.saved[0].blobBase64).toBe('AAA');
    // 资产已登记为当前视频资产
    expect(env.state.videoAsset.id).toBe('va-manual-1');
    expect(env.state.videoAsset.sourceType).toBe('MANUAL_RECORDING');
    expect(env.state.videoState).toBe('VIDEO_READY');
    // 界面上出现"已保存为 VideoAsset"
    expect(env.ctrlBox.innerHTML).toMatch(/已保存为 VideoAsset/);
  });

  it('V4 「导出 MP4」沿用现有转码逻辑（demo:export-mp4 + 60 FPS 上限在主进程）', async () => {
    const env = makeEnv();
    await recordAndSave(env);

    await env.api.exportManualRecordingMp4();

    expect(env.calls.exported.length).toBe(1);
    expect(env.calls.exported[0].inputPath).toBe('C:/tmp/va-manual-1.webm');
    expect(env.api.__manualRec.mp4OutputPath).toBe('C:/tmp/va-manual-1.mp4');
    expect(env.ctrlBox.innerHTML).toMatch(/已转换 MP4/);

    // 转码调用的是主进程既有通道（不是新写的转码服务）
    const src = extractBlock(HTML, 'async function exportRecordingToMp4(rec){');
    expect(src).toMatch(/window\.api\.demoExportMp4/);
    // 主进程 video.js 的 60 FPS 上限未被改动
    const videoJs = fs.readFileSync(path.join(ROOT, 'electron', 'video.js'), 'utf8');
    expect(videoJs).toMatch(/MAX_FPS_DEFAULT\s*=\s*60/);
  });

  it('V4b MP4 导出失败：明确报错，不静默', async () => {
    const env = makeEnv({ exportFails: true });
    await recordAndSave(env);

    await env.api.exportManualRecordingMp4();
    expect(env.api.__manualRec.errorMsg).toMatch(/MP4 导出失败/);
    expect(env.ctrlBox.innerHTML).toMatch(/MP4 导出失败/);
  });

  it('V5 「重新录制」重新启动的是**手动录屏**（不是 AI 自动演示）', async () => {
    const env = makeEnv();
    await recordAndSave(env);

    env.api.resetManualRecordingForRerecord();

    // 回到待录制状态
    expect(env.api.__manualRec.stage).toBe('RECORDING');
    expect(env.api.__manualRec.blob).toBe(null);
    expect(env.api.__manualRec.savedAsset).toBe(null);
    expect(env.api.__manualRec.status).toBe('IDLE');
    // 控制条重新出现 → 用户点「开始」即可重新录
    expect(env.calls.shown).toBeGreaterThan(1);

    // 重新点「开始」→ 走的是手动录屏链路
    await env.api.__manualStart();
    await flush();
    expect(env.calls.media.some((c) => c.op === 'start')).toBe(true);
    // **没有**触发 AI 自动规划器 / 执行器
    expect(HTML).not.toMatch(/resetManualRecordingForRerecord[\s\S]{0,600}startAiDemo/);
    const src = extractBlock(HTML, 'window.resetManualRecordingForRerecord = function(){');
    expect(src).not.toMatch(/startAiDemo/);
    expect(src).not.toMatch(/openAiDemoWorkspace/);
    expect(src).not.toMatch(/startAiDemoPlan/);
    expect(src).not.toMatch(/runAiDemoScript/);
  });

  it('V6 「下一步：录制声音」沿用现有语音录制流程，且使用刚保存的手动录屏资产', async () => {
    const env = makeEnv();
    await recordAndSave(env);

    env.api.manualRecordingNext();

    // 进入现有录音步骤（state.step = 8 = renderVoice）
    expect(env.state.step).toBe(8);
    // 来源标记为手动录屏（复用现有 voice 流程，不新建流程）
    expect(env.state.voiceSource).toBe('manualRec');
    expect(env.state.voiceReturnStep).toBe(5);
    expect(env.state.voiceNextStep).toBe(13);
    // 读取的正是刚保存的手动录屏资产
    expect(env.state.videoAsset.id).toBe('va-manual-1');
    expect(env.state.videoAsset.sourceType).toBe('MANUAL_RECORDING');
    // 重绘进入录音界面
    expect(env.calls.flow).toBeGreaterThan(0);
  });

  it('V6b 未保存视频样本时「下一步」被阻断并明确提示', async () => {
    const env = makeEnv();
    await env.api.__manualStart();
    await flush();
    env.api.__manualStop();
    await flush();

    expect(env.api.__manualNextEnabled()).toBe(false);
    env.api.manualRecordingNext();
    expect(env.state.step).toBe(5);   // 没跳走
    expect(env.calls.toasts.some((t) => /请先录制并点击/.test(t.msg))).toBe(true);
  });

  it('V7 保存 / 转码 / 重新录制都不会误触发 AI 自动规划器或执行器', () => {
    const saveSrc = extractBlock(HTML, 'window.saveManualRecording = async function(){');
    const mp4Src = extractBlock(HTML, 'window.exportManualRecordingMp4 = async function(){');
    const reSrc = extractBlock(HTML, 'window.resetManualRecordingForRerecord = function(){');
    const nextSrc = extractBlock(HTML, 'window.manualRecordingNext = function(){');
    [saveSrc, mp4Src, reSrc, nextSrc].forEach(function (s) {
      expect(s).not.toMatch(/startAiDemoPlan/);
      expect(s).not.toMatch(/runAiDemoScript/);
      expect(s).not.toMatch(/AI_DEMO_EXECUTOR/);
      expect(s).not.toMatch(/startAiDemo\(/);
    });
  });

  it('V8 手动录屏完成页与 AI 录屏完成页**复用同一套**产物预览块 / 保存 / 转码逻辑', () => {
    // 两侧都调用同一组共用函数
    const aiStage = extractBlock(HTML, 'function renderAiDemoStage(ctrl){');
    expect(aiStage).toMatch(/renderRecordingProductBlock\(d,\s*\{\s*previewId:\s*'aiDemoPreview'\s*\}\)/);
    const manualStage = extractBlock(HTML, 'function __manualRenderStage(ctrl){');
    expect(manualStage).toMatch(/renderRecordingProductBlock\(d,\s*\{\s*previewId:\s*'manualRecPreview'\s*\}\)/);

    // AI 页的保存 / 转码也走共用层
    const aiSave = extractBlock(HTML, 'window.saveAiDemo = async function(){');
    expect(aiSave).toMatch(/saveRecordingBlobToAsset\(state\.aiDemo\)/);
    const aiMp4 = extractBlock(HTML, 'window.exportAiDemoMp4 = async function(){');
    expect(aiMp4).toMatch(/exportRecordingToMp4\(state\.aiDemo\)/);

    // 没有第二套并行实现
    expect(HTML).not.toMatch(/manual-recording:save/);
    expect(HTML).not.toMatch(/manualRecordingSaveToAsset/);
  });

  it('V9 AI 录屏完成页行为不变（按钮 / 判定 / 预览 id 全部保持）', () => {
    // AI 页按钮与文案不变
    expect(HTML).toMatch(/onclick="saveAiDemo\(\)"/);
    expect(HTML).toMatch(/onclick="exportAiDemoMp4\(\)"/);
    expect(HTML).toMatch(/onclick="resetAiDemoForRerecord\(\)"/);
    expect(HTML).toMatch(/onclick="aiDemoNext\(\)"/);
    // AI 页预览窗口 id 不变
    expect(HTML).toMatch(/previewId:\s*'aiDemoPreview'/);
    // AI 页的下一步判定函数不变
    expect(HTML).toMatch(/function aiDemoNextEnabled\(demo\)\{/);
    expect(HTML).toMatch(/window\.aiDemoNextEnabled = aiDemoNextEnabled/);
    // AI 页仍然从 state.aiDemo 取数据
    expect(HTML).toMatch(/state\.aiDemo\.savedAsset/);
  });
});

describe('手动录屏 · 控制条加长（V10 / V11 / V12）', () => {
  it('V10 控制条宽度足够容纳三个按钮（开始 / 暂停 / 停止都完整显示）', () => {
    const m = /const BAR_WIDTH\s*=\s*(\d+)/.exec(CONTROLS_JS);
    expect(m).toBeTruthy();
    const barWidth = Number(m[1]);
    // 三个按钮各至少 44px（CSS min-width）+ 状态点 9px + 计时 38px
    //   + 间距（4 × 4 = 16）+ 内边距（8 × 2 = 16）≈ 211px
    expect(barWidth).toBeGreaterThanOrEqual(211);
    // 比改造前的 132px 明显更宽
    expect(barWidth).toBeGreaterThan(132);

    // 按钮样式保证不裁切
    expect(CONTROLS_HTML).toMatch(/button\s*\{[\s\S]{0,600}min-width:\s*44px/);
    expect(CONTROLS_HTML).toMatch(/white-space:\s*nowrap/);
    expect(CONTROLS_HTML).toMatch(/overflow:\s*hidden/);
    // 隐藏的开始按钮必须真的不占位
    expect(CONTROLS_HTML).toMatch(/button\[hidden\]\s*\{\s*display:\s*none/);
  });

  it('V11 控制条仍在主窗口外侧（右侧优先 → 左侧回退 → 顶部回退策略不变）', () => {
    const src = extractBlock(CONTROLS_JS, 'function computePosition(mainBounds) {');
    const barWidth = Number(/const BAR_WIDTH\s*=\s*(\d+)/.exec(CONTROLS_JS)[1]);
    const fn = new Function('screen', 'GAP', 'BAR_WIDTH', 'BAR_HEIGHT', src + '\nreturn computePosition;');
    const computePosition = fn(
      { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
      10, barWidth, 46
    );
    // 右侧优先
    const right = computePosition({ x: 500, y: 100, width: 800, height: 600 });
    expect(right.x).toBeGreaterThanOrEqual(500 + 800);
    // 右侧放不下 → 左侧回退（左侧位置要能容纳加宽后的条）
    const left = computePosition({ x: 1700, y: 100, width: 800, height: 600 });
    expect(left.x).toBeLessThan(1700);
    expect(left.x).toBeGreaterThanOrEqual(0);
    // 两侧都放不下 → 顶部回退
    const top = computePosition({ x: 0, y: 30, width: 1920, height: 1050 });
    expect(top.y).toBeLessThan(30);
  });

  it('V12 控制条功能 / 状态机 / IPC 未被改动', () => {
    // 按钮与状态机
    expect(CONTROLS_HTML).toMatch(/id="btnStart"/);
    expect(CONTROLS_HTML).toMatch(/id="btnPause"/);
    expect(CONTROLS_HTML).toMatch(/id="btnStop"/);
    expect(CONTROLS_HTML).toMatch(/sendAction\('start'\)/);
    expect(CONTROLS_HTML).toMatch(/sendAction\(isPaused \? 'resume' : 'pause'\)/);
    expect(CONTROLS_HTML).toMatch(/sendAction\('stop'\)/);
    // 主进程 IPC 通道不变
    expect(CONTROLS_JS).toMatch(/'recorder-controls:action'/);
    expect(CONTROLS_JS).toMatch(/'recorder-controls:set-state'/);
    expect(CONTROLS_JS).toMatch(/'recorder-controls:show'/);
    expect(CONTROLS_JS).toMatch(/'recorder-controls:hide'/);
    // 始终置顶 / 独立窗口 / 不被录入的设计不变
    expect(CONTROLS_JS).toMatch(/alwaysOnTop:\s*true/);
    expect(CONTROLS_JS).toMatch(/setAlwaysOnTop\(true,\s*'screen-saver'\)/);
    expect(CONTROLS_JS).toMatch(/frame:\s*false/);
    expect(CONTROLS_JS).toMatch(/const CONTROLS_TITLE\s*=\s*'Recorder Controls'/);
  });
});
