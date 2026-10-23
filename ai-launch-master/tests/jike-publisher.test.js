// Rokit · JikePublisher v3 单元测试（vitest）
// ---------------------------------------------------------------
// 验证目标：把用户传入的 content 写进即刻的动态发布框。
//          不把"操作过于频繁"判为应用层失败。
//          单次导航 + 有限 DOM 重试 + 8 状态机 + 媒体上传 + 不自动发送。
//
// 覆盖：
//   - fillContent 成功 / 失败 / 节流 三条主路径（节流不再 abort）
//   - 8 状态机：状态转移合法性 / 状态历史记录
//   - 节流命中：ok 仍可为 true（即便 prepare 报告 throttled=true）
//   - openPlatform 必传 BrowserManager + 单次导航
//   - submit 永远不允许自动发送
//   - publishTask 形态入参：content + video
//   - media 上传：fetch + DataTransfer + File + change event
//   - JikePrepareScript 4 阶段日志 + contenteditable+execCommand + 原生 setter
//   - 节流仅作日志（[Jike] 检测到网页提示"操作过于频繁"，忽略...）
//   - 不引入 setInterval / reload / location 写入 / 历史栈写入 / 自动点 send
//   - publishers.js 老 adapters 不被破坏
'use strict';

function makePublisher() {
  const M = require('../electron/browser/platforms/jike/JikePublisher.js');
  return new M.JikePublisher();
}

function makeStubBM(opts) {
  opts = opts || {};
  const isVit = (typeof opts._vitest === 'function') ? opts._vitest : (typeof vi !== 'undefined' && !!vi.fn);
  const mk = (init) => isVit ? vi.fn().mockResolvedValue(init) : (function () { return Promise.resolve(init); });
  return {
    openPlatform: mk({ reused: false, windowId: 1 }),
    navigate:     mk({ skipped: 'same-url' }),
    execute:      mk({ ok: false, error: 'not-set' }),
    getPlatformWindow: function () { return null; }
  };
}

// =====================================================================
// 主流程
// =====================================================================
describe('JikePublisher.fillContent · 主流程', () => {
  it('空字符串 → 立即返回 empty-content，不调 bm.execute', async () => {
    const bm = makeStubBM();
    const pub = makePublisher();
    const r = await pub.fillContent({ browserManager: bm, content: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty-content');
    expect(bm.execute).not.toHaveBeenCalled();
  });

  it('没有 browserManager → 返回 no-browser-manager', async () => {
    const pub = makePublisher();
    const r = await pub.fillContent({ content: '你好' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-browser-manager');
  });

  it('正常填入：bm.execute 返回 ok=true → 返回 readyForManualSend=true', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValue({
      ok: true,
      throttled: false,
      composer: {
        tagName: 'DIV',
        role: 'textbox',
        ariaLabel: '',
        placeholder: '分享你的想法...',
        contenteditable: 'true',
        ariaMultiline: 'true',
        visible: true,
        height: 120,
        width: 600
      },
      fillMethod: 'execCommand-insertText-range',
      contentBeforeLen: 0,
      contentAfterLen:  8,
      targetPreview:    '你好即刻',
      actualPreview:    '你好即刻',
      attempts: 3,
      elapsedMs: 2400
    });
    const r = await makePublisher().fillContent({ browserManager: bm, content: '你好即刻' });
    expect(r.ok).toBe(true);
    expect(r.readyForManualSend).toBe(true);
    expect(r.fillMethod).toBe('execCommand-insertText-range');
    expect(r.state).toBe('READY_FOR_MANUAL_SEND');
    expect(r.contentAfterLen).toBe(8);
    expect(r.targetPreview).toBe('你好即刻');
    expect(r.actualPreview).toBe('你好即刻');
  });

  it('【关键】节流命中：bm.execute 返回 throttled=true 但 ok=true → 主进程不再判失败', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValue({
      ok: true,                                                  // ← 即便节流命中也 ok
      throttled: true,
      throttleSource: 'dom-leaf',
      throttleSample: '操作过于频繁，请稍后再试',
      composer: { tagName: 'DIV', contenteditable: 'true', placeholder: '分享你的想法' },
      fillMethod: 'execCommand-insertText-range',
      contentBeforeLen: 0,
      contentAfterLen: 8,
      actualPreview: '你好即刻',
      attempts: 1,
      elapsedMs: 800
    });
    const r = await makePublisher().fillContent({ browserManager: bm, content: '你好即刻' });
    // 关键断言：节流不再让 ok=false
    expect(r.ok).toBe(true);
    expect(r.readyForManualSend).toBe(true);
    expect(r.throttled).toBe(true);
    expect(r.error).not.toBe('throttled');
    expect((r.error || '')).not.toMatch(/throttled/);
    expect(r.throttleSource).toBe('dom-leaf');
    expect(r.throttleSample).toMatch(/操作过于频繁/);
  });

  it('节流命中但填表本身失败（ok=false）→ 返回 fill-failed，throttled 仅作环境信号', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValue({
      ok: false,
      throttled: true,
      throttleSource: 'dom-leaf',
      composer: null,
      fillMethod: null,
      contentBeforeLen: 0,
      contentAfterLen: 0,
      actualPreview: '',
      attempts: 15,
      elapsedMs: 12000
    });
    const r = await makePublisher().fillContent({ browserManager: bm, content: '测试' });
    // 失败原因不再是 'throttled'
    expect(r.ok).toBe(false);
    expect(r.error).not.toBe('throttled');
    expect(r.throttled).toBe(true);
    expect(r.contentAfterLen).toBe(0);
  });

  it('填入失败：bm.execute 返回 ok=false → 返回 fill-failed', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValue({
      ok: false,
      throttled: false,
      error: 'actual-content-empty',
      composer: null,
      fillMethod: null,
      contentBeforeLen: 0,
      contentAfterLen: 0,
      attempts: 15,
      elapsedMs: 12000
    });
    const r = await makePublisher().fillContent({ browserManager: bm, content: '测试' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('actual-content-empty');
    expect(r.readyForManualSend).toBe(false);
  });

  it('bm.execute 返回 null → 返回 no-result', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValueOnce(null);
    const r = await makePublisher().fillContent({ browserManager: bm, content: '测试' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-result');
  });

  it('bm.execute throws → 返回 execute-threw 错误信息', async () => {
    const bm = makeStubBM();
    bm.execute.mockRejectedValueOnce(new Error('窗口已销毁'));
    const r = await makePublisher().fillContent({ browserManager: bm, content: '测试' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/execute-threw/);
    expect(r.error).toMatch(/窗口已销毁/);
  });

  it('兼容老调用：fill / prepareContent 都最终调 bm.execute 一次并返回相同结果', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValue({
      ok: true, throttled: false,
      fillMethod: 'execCommand-insertText-range',
      contentBeforeLen: 0, contentAfterLen: 4,
      targetPreview: '你好', actualPreview: '你好',
      attempts: 1, elapsedMs: 800
    });
    const M = require('../electron/browser/platforms/jike/JikePublisher.js');
    const pub = new M.JikePublisher();
    const r1 = await pub.fill         ({ browserManager: bm, content: '你好' });
    const r2 = await pub.prepareContent({ browserManager: bm, content: '你好' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.fillMethod).toBe('execCommand-insertText-range');
    expect(r2.fillMethod).toBe('execCommand-insertText-range');
  });

  it('支持 fillData.content 入参格式', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValue({
      ok: true, throttled: false,
      fillMethod: 'native-setter',
      contentBeforeLen: 0, contentAfterLen: 6,
      targetPreview: '一二三四', actualPreview: '一二三四',
      attempts: 1, elapsedMs: 800
    });
    const pub = makePublisher();
    const r = await pub.fillContent({ browserManager: bm, fillData: { content: '一二三四' } });
    expect(r.ok).toBe(true);
    expect(r.fillMethod).toBe('native-setter');
  });
});

// =====================================================================
// 8 状态机
// =====================================================================
describe('JikePublisher · 8 状态机', () => {
  const M = require('../electron/browser/platforms/jike/JikePublisher.js');
  const STATES = M.STATES;
  const VALID = M.VALID_TRANSITIONS;

  it('导出 8 个状态：INIT / LOADING / WAITING_LOGIN / WAITING_COMPOSER / FILLING_CONTENT / UPLOADING_MEDIA / VERIFYING / READY_FOR_MANUAL_SEND', () => {
    expect(STATES).toEqual([
      'INIT', 'LOADING', 'WAITING_LOGIN', 'WAITING_COMPOSER',
      'FILLING_CONTENT', 'UPLOADING_MEDIA', 'VERIFYING', 'READY_FOR_MANUAL_SEND'
    ]);
  });

  it('导出 VALID_TRANSITIONS 表', () => {
    expect(typeof VALID).toBe('object');
    expect(VALID.INIT).toEqual(['LOADING']);
    expect(VALID.READY_FOR_MANUAL_SEND).toEqual([]);
  });

  it('fillContent 成功后 state = READY_FOR_MANUAL_SEND', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValue({
      ok: true, throttled: false,
      fillMethod: 'execCommand-insertText-range',
      contentBeforeLen: 0, contentAfterLen: 4,
      actualPreview: 'abcd',
      attempts: 1, elapsedMs: 800
    });
    const r = await makePublisher().fillContent({ browserManager: bm, content: 'abcd' });
    expect(r.state).toBe('READY_FOR_MANUAL_SEND');
  });

  it('stateHistory 包含全部转移节点', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValue({
      ok: true, throttled: false,
      fillMethod: 'execCommand-insertText-range',
      contentBeforeLen: 0, contentAfterLen: 4,
      actualPreview: 'abcd',
      attempts: 1, elapsedMs: 800
    });
    const r = await makePublisher().fillContent({ browserManager: bm, content: 'abcd' });
    const toList = r.stateHistory.map(function (s) { return s.to; });
    expect(toList[0]).toBe('INIT');
    expect(toList).toContain('LOADING');
    expect(toList).toContain('WAITING_LOGIN');
    expect(toList).toContain('WAITING_COMPOSER');
    expect(toList).toContain('FILLING_CONTENT');
    expect(toList[toList.length - 1]).toBe('READY_FOR_MANUAL_SEND');
  });

  it('无 video 任务时 stateHistory 不含 UPLOADING_MEDIA 节点', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValue({
      ok: true, throttled: false,
      fillMethod: 'execCommand-insertText-range',
      contentBeforeLen: 0, contentAfterLen: 4,
      actualPreview: 'abcd',
      attempts: 1, elapsedMs: 800
    });
    const r = await makePublisher().fillContent({ browserManager: bm, content: 'abcd' });
    const toList = r.stateHistory.map(function (s) { return s.to; });
    expect(toList).not.toContain('UPLOADING_MEDIA');
  });

  it('有 video 任务时 stateHistory 含 UPLOADING_MEDIA', async () => {
    const bm = makeStubBM();
    // 第一次 execute：prepare script；第二次：media upload script
    let callIdx = 0;
    const realExec = bm.execute;
    bm.execute = (typeof vi !== 'undefined' && vi.fn)
      ? vi.fn().mockImplementation(function () {
          callIdx++;
          if (callIdx === 1) return Promise.resolve({
            ok: true, throttled: false,
            fillMethod: 'execCommand-insertText-range',
            contentBeforeLen: 0, contentAfterLen: 4,
            actualPreview: 'abcd',
            attempts: 1, elapsedMs: 800
          });
          return Promise.resolve({
            ok: true, found: true,
            fileName: 'media.mp4', fileSize: 1234567, fileType: 'video/mp4',
            inputMethod: 'input[type="file"][accept*="video"]'
          });
        })
      : function () {
          callIdx++;
          if (callIdx === 1) return Promise.resolve({
            ok: true, throttled: false,
            fillMethod: 'execCommand-insertText-range',
            contentBeforeLen: 0, contentAfterLen: 4,
            actualPreview: 'abcd',
            attempts: 1, elapsedMs: 800
          });
          return Promise.resolve({
            ok: true, found: true,
            fileName: 'media.mp4', fileSize: 1234567, fileType: 'video/mp4',
            inputMethod: 'input[type="file"][accept*="video"]'
          });
        };
    const r = await makePublisher().fillContent({
      browserManager: bm,
      publishTask: { content: 'abcd', video: { type: 'video', src: 'https://x.com/a.mp4' } }
    });
    expect(r.ok).toBe(true);
    const toList = r.stateHistory.map(function (s) { return s.to; });
    expect(toList).toContain('UPLOADING_MEDIA');
    expect(r.media).toBeTruthy();
    expect(r.media.ok).toBe(true);
    expect(r.media.fileName).toBe('media.mp4');
  });

  it('每次 fillContent 独立重置状态机（不跨调用复用）', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValue({
      ok: true, throttled: false,
      fillMethod: 'native-setter',
      contentBeforeLen: 0, contentAfterLen: 2,
      actualPreview: 'hi',
      attempts: 1, elapsedMs: 800
    });
    const pub = makePublisher();
    const r1 = await pub.fillContent({ browserManager: bm, content: 'hi' });
    const r2 = await pub.fillContent({ browserManager: bm, content: 'hi' });
    // 两次 stateHistory 都从 INIT 开头
    expect(r1.stateHistory[0].to).toBe('INIT');
    expect(r2.stateHistory[0].to).toBe('INIT');
  });
});

// =====================================================================
// openPlatform
// =====================================================================
describe('JikePublisher.openPlatform', () => {
  it('没有 browserManager → 返回 no-browser-manager', async () => {
    const pub = makePublisher();
    const r = await pub.openPlatform({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-browser-manager');
  });

  it('有 browserManager → 调 openPlatform + 单次 navigate', async () => {
    const bm = makeStubBM();
    const pub = makePublisher();
    const r = await pub.openPlatform({ browserManager: bm });
    expect(r.ok).toBe(true);
    expect(r.windowId).toBe(1);
    expect(bm.openPlatform).toHaveBeenCalledWith('jike');
    expect(bm.navigate).toHaveBeenCalledWith('jike', 'https://web.okjike.com/');
  });

  it('payload.url 显式传 → navigate 到 payload.url', async () => {
    const bm = makeStubBM();
    const pub = makePublisher();
    await pub.openPlatform({ browserManager: bm, url: 'https://web.okjike.com/following' });
    expect(bm.navigate).toHaveBeenCalledWith('jike', 'https://web.okjike.com/following');
  });

  it('bm.openPlatform throws → 返回错误信息，不 throw', async () => {
    const bm = makeStubBM();
    bm.openPlatform.mockRejectedValueOnce(new Error('open blew up'));
    const pub = makePublisher();
    const r = await pub.openPlatform({ browserManager: bm });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/open blew up/);
  });
});

// =====================================================================
// submit
// =====================================================================
describe('JikePublisher.submit', () => {
  it('永远不允许自动发送', async () => {
    const pub = makePublisher();
    const r = await pub.submit({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('auto-send-disabled');
    expect(r.manualReason).toBe('user-must-click-send-manually');
  });
});

// =====================================================================
// publishTask 入参
// =====================================================================
describe('JikePublisher.fillContent · publishTask 入参', () => {
  it('publishTask.content + publishTask.video → 走两步 execute', async () => {
    const bm = makeStubBM();
    let callIdx = 0;
    bm.execute.mockImplementation(function () {
      callIdx++;
      if (callIdx === 1) return Promise.resolve({
        ok: true, throttled: false,
        fillMethod: 'execCommand-insertText-range',
        contentBeforeLen: 0, contentAfterLen: 8,
        actualPreview: '你好即刻',
        attempts: 1, elapsedMs: 800
      });
      return Promise.resolve({
        ok: true, found: true,
        fileName: 'clip.mp4', fileSize: 999999, fileType: 'video/mp4',
        inputMethod: 'input[type="file"]'
      });
    });
    const r = await makePublisher().fillContent({
      browserManager: bm,
      publishTask: {
        content: '你好即刻',
        video:   { type: 'video', src: 'https://example.com/clip.mp4' }
      }
    });
    expect(r.ok).toBe(true);
    expect(r.readyForManualSend).toBe(true);
    expect(r.media).toBeTruthy();
    expect(r.media.ok).toBe(true);
    expect(r.media.fileName).toBe('clip.mp4');
  });

  it('video.src 不存在 → 不调 media upload script', async () => {
    const bm = makeStubBM();
    bm.execute.mockResolvedValue({
      ok: true, throttled: false,
      fillMethod: 'native-setter',
      contentBeforeLen: 0, contentAfterLen: 4,
      actualPreview: 'abcd',
      attempts: 1, elapsedMs: 800
    });
    await makePublisher().fillContent({
      browserManager: bm,
      publishTask: { content: 'abcd', video: { type: 'video' } } // no src
    });
    expect(bm.execute).toHaveBeenCalledTimes(1);
  });

  it('media upload 失败 → 整体仍 ok=true，让用户在窗口手动添加附件', async () => {
    const bm = makeStubBM();
    let callIdx = 0;
    bm.execute.mockImplementation(function () {
      callIdx++;
      if (callIdx === 1) return Promise.resolve({
        ok: true, throttled: false,
        fillMethod: 'native-setter',
        contentBeforeLen: 0, contentAfterLen: 4,
        actualPreview: 'abcd',
        attempts: 1, elapsedMs: 800
      });
      return Promise.resolve({ ok: false, found: false, error: 'no-file-input' });
    });
    const r = await makePublisher().fillContent({
      browserManager: bm,
      publishTask: { content: 'abcd', video: { type: 'video', src: 'https://x.com/a.mp4' } }
    });
    expect(r.ok).toBe(true);
    expect(r.readyForManualSend).toBe(true);
    expect(r.media.ok).toBe(false);
    expect(r.media.error).toBe('no-file-input');
  });
});

// =====================================================================
// JikePrepareScript 输出形状
// =====================================================================
describe('JikePrepareScript · IIFE 形状', () => {
  const M = require('../electron/browser/platforms/jike/JikePrepareScript.js');

  it('导出 buildJikePrepareScript', () => {
    expect(typeof M.buildJikePrepareScript).toBe('function');
  });

  it('生成的是字符串且为 async IIFE', () => {
    const s = M.buildJikePrepareScript({
      contentSelectors: ['[contenteditable="true"]'],
      fillData: { content: '测试' },
      pollIntervalMs: 800, maxAttempts: 15, verifyDelayMs: 800
    });
    expect(typeof s).toBe('string');
    expect(s.trim().startsWith('(async function')).toBe(true);
  });

  it('节流关键字仍在脚本里（仅作日志记录）', () => {
    const s = M.buildJikePrepareScript({
      contentSelectors: ['[contenteditable="true"]'],
      fillData: { content: 'x' },
      pollIntervalMs: 800, maxAttempts: 15, verifyDelayMs: 800
    });
    expect(s).toMatch(/操作过于频繁/);
    expect(s).toMatch(/detectThrottle/);
    expect(s).toMatch(/dom-leaf/);
    expect(s).toMatch(/dom-title/);
    // 节流不再导致 abort：脚本里**不应**有 throttled 直接 return
    expect(s).not.toMatch(/if\(result\.throttled\)\{[\s\S]*?return result/);
    expect(s).toMatch(/NOT aborting/);
  });

  it('包含 4 个阶段日志：search start / found / length before / length after', () => {
    const s = M.buildJikePrepareScript({
      contentSelectors: ['[contenteditable="true"]'],
      fillData: { content: 'x' },
      pollIntervalMs: 800, maxAttempts: 15, verifyDelayMs: 800
    });
    expect(s).toMatch(/composer search start/);
    expect(s).toMatch(/composer found/);
    expect(s).toMatch(/content length before/);
    expect(s).toMatch(/FILL SUCCESS|FILL FAILED/);
  });

  it('contenteditable 走 Range + insertText（真实输入事件），不走 selectAll', () => {
    const s = M.buildJikePrepareScript({
      contentSelectors: ['[contenteditable="true"]'],
      fillData: { content: 'x' },
      pollIntervalMs: 800, maxAttempts: 15, verifyDelayMs: 800
    });
    expect(s).toMatch(/selectNodeContents/);
    expect(s).toMatch(/execCommand\(\s*["']insertText["']/);
    expect(s).toMatch(/InputEvent/);
    expect(s).toMatch(/dispatchEvent/);
    expect(s).not.toMatch(/\.selectAll\b/);
  });

  it('textarea 走原生 setter (Object.getOwnPropertyDescriptor)', () => {
    const s = M.buildJikePrepareScript({
      contentSelectors: ['textarea'],
      fillData: { content: 'x' },
      pollIntervalMs: 800, maxAttempts: 15, verifyDelayMs: 800
    });
    expect(s).toMatch(/HTMLTextAreaElement\.prototype/);
    expect(s).toMatch(/getOwnPropertyDescriptor/);
  });

  it('支持最长 12s 等待（800ms × 15）', () => {
    const s = M.buildJikePrepareScript({
      contentSelectors: ['[contenteditable="true"]'],
      fillData: { content: 'x' },
      pollIntervalMs: 800, maxAttempts: 15, verifyDelayMs: 800
    });
    expect(s).toMatch(/"pollIntervalMs":\s*800/);
    expect(s).toMatch(/"maxAttempts":\s*15/);
    expect(s).toMatch(/"verifyDelayMs":\s*800/);
  });

  it('填后用 innerText / textContent / value 任意一种读回', () => {
    const s = M.buildJikePrepareScript({
      contentSelectors: ['[contenteditable="true"]'],
      fillData: { content: 'x' },
      pollIntervalMs: 800, maxAttempts: 15, verifyDelayMs: 800
    });
    expect(s).toMatch(/textContent/);
    expect(s).toMatch(/innerText/);
    expect(s).toMatch(/readContent/);
  });

  it('不调用 setInterval；只用一次性 setTimeout 轮询', () => {
    const s = M.buildJikePrepareScript({
      contentSelectors: ['[contenteditable="true"]'],
      fillData: { content: 'x' },
      pollIntervalMs: 800, maxAttempts: 15, verifyDelayMs: 800
    });
    expect(s).not.toMatch(/setInterval/);
    expect(s).toMatch(/setTimeout/);
  });

  it('不写入 location / history；不调 reload / send click', () => {
    const s = M.buildJikePrepareScript({
      contentSelectors: ['[contenteditable="true"]'],
      fillData: { content: 'x' },
      pollIntervalMs: 800, maxAttempts: 15, verifyDelayMs: 800
    });
    expect(s).not.toMatch(/location\.href\s*=/);
    expect(s).not.toMatch(/location\.replace/);
    expect(s).not.toMatch(/history\.pushState/);
    expect(s).not.toMatch(/history\.replaceState/);
    expect(s).not.toMatch(/\.reload\(/);
    expect(s).not.toMatch(/\.click\(\s*(send|submit|publish)/i);
  });
});

// =====================================================================
// JikeMediaUploadScript 输出形状
// =====================================================================
describe('JikeMediaUploadScript · IIFE 形状', () => {
  const M = require('../electron/browser/platforms/jike/JikeMediaUploadScript.js');

  it('导出 buildJikeMediaUploadScript', () => {
    expect(typeof M.buildJikeMediaUploadScript).toBe('function');
  });

  it('生成的是 async IIFE', () => {
    const s = M.buildJikeMediaUploadScript({
      media: { type: 'video', src: 'https://x.com/a.mp4' },
      timeoutMs: 15000
    });
    expect(typeof s).toBe('string');
    expect(s.trim().startsWith('(async function')).toBe(true);
  });

  it('走 DataTransfer + File + change event（真实上传事件）', () => {
    const s = M.buildJikeMediaUploadScript({
      media: { type: 'video', src: 'https://x.com/a.mp4' },
      timeoutMs: 15000
    });
    expect(s).toMatch(/DataTransfer/);
    expect(s).toMatch(/new File/);
    expect(s).toMatch(/\.files\s*=/);
    expect(s).toMatch(/dispatchEvent/);
    expect(s).toMatch(/new Event\(["']change["']/);
    expect(s).toMatch(/new Event\(["']input["']/);
  });

  it('寻找 input[type=file][accept*=video] / input[type=file]', () => {
    const s = M.buildJikeMediaUploadScript({
      media: { type: 'video', src: 'https://x.com/a.mp4' },
      timeoutMs: 15000
    });
    // 脚本里有转义引号 \"
    expect(s).toMatch(/input\[type=\\?"file\\?"\]\[accept/);
  });

  it('支持 data: URL 上传', () => {
    const s = M.buildJikeMediaUploadScript({
      media: { type: 'image', src: 'data:image/png;base64,AAAA' },
      timeoutMs: 15000
    });
    expect(s).toMatch(/data:/i);
    expect(s).toMatch(/atob/);
  });

  it('不调 setInterval / reload / location / send click', () => {
    const s = M.buildJikeMediaUploadScript({
      media: { type: 'video', src: 'https://x.com/a.mp4' },
      timeoutMs: 15000
    });
    expect(s).not.toMatch(/setInterval/);
    expect(s).not.toMatch(/location\.href\s*=/);
    expect(s).not.toMatch(/location\.replace/);
    expect(s).not.toMatch(/\.reload\(/);
    expect(s).not.toMatch(/\.click\(\s*(send|submit|publish)/i);
  });
});

// =====================================================================
// 主类静态安全
// =====================================================================
describe('JikePublisher · 主类静态安全', () => {
  it('不在主类里写 location / history / reload / setInterval', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../electron/browser/platforms/jike/JikePublisher.js'),
      'utf8'
    );
    expect(src).not.toMatch(/location\.href\s*=/);
    expect(src).not.toMatch(/history\.pushState/);
    expect(src).not.toMatch(/history\.replaceState/);
    expect(src).not.toMatch(/\.reload\(/);
    expect(src).not.toMatch(/setInterval/);
  });

  it('不在主类里直接 send click（submit 必须返回 auto-send-disabled）', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../electron/browser/platforms/jike/JikePublisher.js'),
      'utf8'
    );
    expect(src).not.toMatch(/\.click\(\s*[^)]*send/i);
    expect(src).toMatch(/auto-send-disabled/);
  });

  it('主类里包含 throttle 日志（"忽略该提示，不判定为自动发布失败"）', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../electron/browser/platforms/jike/JikePublisher.js'),
      'utf8'
    );
    expect(src).toMatch(/忽略该提示，不判定为自动发布失败/);
  });

  it('已在 PublisherRegistry 注册 jike', () => {
    const reg = require('../electron/browser/PublisherRegistry.js');
    expect(reg.has('jike')).toBe(true);
  });

  it('已删 JikeObserveScript（observe 模式不再需要）', () => {
    const fs = require('fs');
    const path = require('path');
    expect(fs.existsSync(
      path.resolve(__dirname, '../electron/browser/platforms/jike/JikeObserveScript.js')
    )).toBe(false);
  });
});

// =====================================================================
// publishers.js 老 path 不被破坏
// =====================================================================
describe('publishers.js · 老 adapters 不被破坏', () => {
  it('zhihu launch 不变', () => {
    const adapters = require('../electron/publishers.js').adapters;
    expect(adapters.zhihu.launch()).toBe('https://zhuanlan.zhihu.com/write');
  });

  it('v2ex launch 不变', () => {
    const adapters = require('../electron/publishers.js').adapters;
    expect(adapters.v2ex.launch()).toMatch(/^https:\/\/www\.v2ex\.com\/new$/);
  });

  it('juejin launch 不变', () => {
    const adapters = require('../electron/publishers.js').adapters;
    expect(adapters.juejin.launch()).toMatch(/^https:\/\/juejin\.cn\/editor\/drafts\/new$/);
  });

  it('jike 老 path launch 不变', () => {
    const adapters = require('../electron/publishers.js').adapters;
    expect(adapters.jike.launch()).toBe('https://web.okjike.com/following');
  });

  it('jike 老 path fill 是合法 JS', () => {
    const adapters = require('../electron/publishers.js').adapters;
    const code = adapters.jike.fill({ title: 't', body: 'hello 中文', link: 'https://x.com' });
    expect(typeof code).toBe('string');
    expect(() => new Function(code)).not.toThrow();
  });

  it('jike 老 path submit 是合法 JS', () => {
    const adapters = require('../electron/publishers.js').adapters;
    const code = adapters.jike.submit({});
    expect(typeof code).toBe('string');
    expect(() => new Function(code)).not.toThrow();
  });
});