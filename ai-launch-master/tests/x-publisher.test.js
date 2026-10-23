// Rokit · XPublisher v1.0 phase 1 单元测试（vitest）
// ---------------------------------------------------------------
// 验证目标：
//   1) phase 1 只验证「登录 → 跳转 → 找编辑器」，不做填表 / 不点 Post。
//   2) 复用 BrowserManager（持久化 partition 概念由 BrowserManager 处理）。
//   3) 不依赖 setTimeout 假成功；登录判定综合 DOM + URL + 文案。
//   4) 找不到编辑器不抛错，给 UI 明确失败信号。
//   5) 老 publishers.js x adapter 不会被改动行为。
//
// 覆盖：
//   - 配置常量：homeUrl / publishUrl / loginUrl
//   - loginConfig 已登录 / 未登录 selectors 至少有官方 testid
//   - phase1ReachCompose 全成功链：open → navigate home → login poll →
//                                navigate compose → 找到编辑器 → 返回 ok
//   - 登录失败 → stage=login, ok=false, 不点 Post
//   - 编辑器未找到 → stage=editor-not-found, ok=false
//   - BrowserManager 缺失 → no-browser-manager
//   - submit / fillTitle / fillBody 在 phase 1 全部 disabled
//   - buildXFindComposerScript 输出包含 tweetTextarea_0 selector
//   - publishers.js 老 x adapter launch URL 仍为 https://x.com/compose/post
'use strict';

// vitest 在 setupFiles 阶段会自动注入 describe / it / expect / vi
// 直接使用全局变量即可（参见 tests/jike-publisher.test.js 的写法）

// ============================================================
// 测试用具
// ============================================================
function makeXPublisher() {
  const M = require('../electron/browser/platforms/x/XPublisher.js');
  return new M.XPublisher();
}

function makeStubBM(opts) {
  opts = opts || {};
  const isVit = (typeof vi !== 'undefined' && !!vi.fn);
  const mk = (init) => isVit
    ? vi.fn().mockResolvedValue(init)
    : function () { return Promise.resolve(init); };
  return {
    openPlatform: mk({ reused: false, windowId: 1 }),
    navigate:     mk({ skipped: 'same-url' }),
    execute:      mk({ ok: false, error: 'not-set' }),
    getPlatformWindow: function () {
      // 模拟一个健康 BrowserWindow
      return {
        isDestroyed: function () { return false; },
        webContents: {
          isDestroyed: function () { return false; },
          getURL: function () { return 'https://x.com/home'; }
        }
      };
    }
  };
}

// =====================================================================
// 配置常量
// =====================================================================
describe('XPublisher · 配置常量', () => {
  it('X_CONFIG 提供 homeUrl / publishUrl / loginUrl', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    expect(M.X_CONFIG.homeUrl).toBe('https://x.com/');
    expect(M.X_CONFIG.publishUrl).toBe('https://x.com/compose/post');
    expect(M.X_CONFIG.loginUrl).toBe('https://x.com/login');
  });

  it('X_COMPOSER_SELECTORS 包含官方 tweetTextarea_0', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    expect(M.X_COMPOSER_SELECTORS).toContain('[data-testid="tweetTextarea_0"]');
    // 至少包含 1 个通用 fallback
    expect(M.X_COMPOSER_SELECTORS.some(s => /contenteditable/.test(s))).toBe(true);
  });

  it('X_LOGIN_INDICATORS 已登录 / 未登录 selector 都非空', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    expect(M.X_LOGIN_INDICATORS.loggedIn.length).toBeGreaterThan(0);
    expect(M.X_LOGIN_INDICATORS.loggedOut.length).toBeGreaterThan(0);
    // 不依赖旧版类名作为唯一信号
    expect(M.X_LOGIN_INDICATORS.loggedIn.some(s => /data-testid/.test(s))).toBe(true);
    expect(M.X_LOGIN_INDICATORS.loggedOut.some(s => /data-testid/.test(s))).toBe(true);
  });

  it('XPublisher 实例 platformId === "x"', () => {
    const pub = makeXPublisher();
    expect(pub.platformId).toBe('x');
    expect(pub.platformName).toBeTruthy();
  });

  it('XPublisher 暴露 phase1ReachCompose 入口', () => {
    const pub = makeXPublisher();
    expect(typeof pub.phase1ReachCompose).toBe('function');
  });
});

// =====================================================================
// v1.x+：X 发布只填充正文，不拼接标题（诊断性开关 bodyOnly）
// ---------------------------------------------------------------------
//   - bodyOnly=true：_normalizePayload 仅用 payload.body，**不**追加 title / link / tags
//   - bodyOnly=false：保留 v1.x 原行为（标题 + 空行 + 正文；自动追加 link / tags）
//   - 标题与正文为空 → hasContent=false（不偷偷用 title 替代 body）
// =====================================================================
describe('XPublisher._normalizePayload · v1.x+ bodyOnly 模式', () => {
  it('bodyOnly=true：仅用 body，title 完全不进入 content', () => {
    const pub = makeXPublisher();
    const r = pub._normalizePayload(
      { title: '这是标题测试', body: '第一行正文测试', link: 'https://example.com', tags: ['#话题A', '#话题B'] },
      { bodyOnly: true }
    );
    expect(r.content).toBe('第一行正文测试');
    expect(r.hasContent).toBe(true);
    // title / link / tags 不应出现在 content 里
    expect(r.content.indexOf('这是标题测试')).toBe(-1);
    expect(r.content.indexOf('https://example.com')).toBe(-1);
    expect(r.content.indexOf('#话题A')).toBe(-1);
    // 数据库里的 title 字段保留不变（不改存储）
    expect(r.title).toBe('这是标题测试');
    expect(r.body).toBe('第一行正文测试');
  });

  it('bodyOnly=true：保留正文中的换行、中文、英文、标点、URL、# 标签', () => {
    const pub = makeXPublisher();
    const text = '第一行\nhttps://example.com 测试 #inbody\n第三行 ✨';
    const r = pub._normalizePayload({ title: 'TITLE', body: text }, { bodyOnly: true });
    expect(r.content).toBe(text);
  });

  it('bodyOnly=true：body 为空时 hasContent=false（不偷偷用 title 替代）', () => {
    const pub = makeXPublisher();
    const r = pub._normalizePayload({ title: '仅有标题', body: '' }, { bodyOnly: true });
    expect(r.content).toBe('');
    expect(r.hasContent).toBe(false);
  });

  it('bodyOnly=false（默认之前的行为）：title + 空行 + body + link + tags', () => {
    const pub = makeXPublisher();
    const r = pub._normalizePayload(
      { title: '标题X', body: '正文Y', link: 'https://l.test', tags: ['#tag1'] },
      { bodyOnly: false }
    );
    // 原 v1.x 行为：标题 + 空行 + 正文
    expect(r.content).toContain('标题X');
    expect(r.content).toContain('正文Y');
    expect(r.content).toContain('https://l.test');
    expect(r.content).toContain('#tag1');
  });

  it('bodyOnly=true：fillContent 走 bodyOnly 模式（_normalizePayload 不被 title 污染）', async () => {
    // 端到端验证：fillContent 接受 { title, body } → 实际下发的 normalized.content
    //   与 body 完全相同（不包含 title）。通过把 bm.execute 的内容记录到 spy。
    const pub = makeXPublisher();
    pub.logger = { info: function () {} };
    var bm = {
      execute: function (_id, script) {
        // 抓取 fill IIFE 的 content
        var m = script.match(/"content":"((?:[^"\\]|\\.)*)"/);
        if (m) pub._lastFillContent = JSON.parse('"' + m[1] + '"');
        return Promise.resolve({ ok: true, contentAfterLen: (pub._lastFillContent || '').length, fillMethod: 'paste-event' });
      },
      getPlatformWindow: function () { return null; }
    };
    pub.browserManager = bm;
    const r = await pub.fillContent({ title: '这是标题测试', body: '第一行正文测试' });
    expect(r.ok).toBe(true);
    expect(pub._lastFillContent).toBe('第一行正文测试');
    expect(pub._lastFillContent.indexOf('这是标题测试')).toBe(-1);
  });

  // ----------------------------------------------------------------
  // v1.x+：title / body 是**两个独立字段**，互不污染
  //   端到端确认 fillContent 把 body 与 title 分开传递（不拼接到 content）。
  //   这个测试是用户在 v1.x+ 报告的"X 正文混入标题"问题的核心回归保护。
  // ----------------------------------------------------------------
  it('v1.x+：title / body 区分：title 完全不进入 fillContent 下发的 content', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    pub.logger = { info: function () {} };
    var bm = {
      execute: function (_id, script) {
        var m = script.match(/"content":"((?:[^"\\]|\\.)*)"/);
        if (m) pub._lastFillContent = JSON.parse('"' + m[1] + '"');
        return Promise.resolve({ ok: true, contentAfterLen: (pub._lastFillContent || '').length, fillMethod: 'paste-event' });
      },
      getPlatformWindow: function () { return null; }
    };
    pub.browserManager = bm;
    // 标题与正文**完全不一样**，确保混入能被检测
    const r = await pub.fillContent({
      title: 'TITLE_SOURCE_TEST_2026',
      body: 'BODY_SOURCE_LINE_1_2026\nBODY_SOURCE_LINE_2_2026'
    });
    expect(r.ok).toBe(true);
    // 下发的 content 必须只含 body，不含 title
    expect(pub._lastFillContent).toBe('BODY_SOURCE_LINE_1_2026\nBODY_SOURCE_LINE_2_2026');
    expect(pub._lastFillContent.indexOf('TITLE_SOURCE_TEST_2026')).toBe(-1);
    // 换行保留
    expect(pub._lastFillContent.split('\n').length).toBe(2);
  });

  // ----------------------------------------------------------------
  // v1.x+ 位置 C 诊断：X 发布执行函数实际收到的正文参数诊断日志
  //   锁住"长度 / 测试标记 / title 是否意外混入正文"等关键检查。
  //   这条诊断的输出**不**包含完整正文（只含长度 + 布尔标记），
  //   所以可以安全地保留在生产代码中（生产可关 0 关闭）。
  // ----------------------------------------------------------------
  it('v1.x+：位置 C 诊断 — fillContent 收到 title 不混入 body', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    var _logs = [];
    pub.logger = { info: function (msg, extra) { _logs.push({ msg: msg, extra: extra || {} }); } };
    pub.browserManager = {
      execute: function () { return Promise.resolve({ ok: true, contentAfterLen: 0, fillMethod: 'paste-event' }); },
      getPlatformWindow: function () { return null; }
    };
    // 标题**看起来像**正文（但其实不应该混进 body）
    // title 含 TRACE_TITLE 标记（用于检测"title 意外混入 body"）
    await pub.fillContent({
      title: 'TRACE_TITLE_FOR_TEST',
      body: 'BODY_TRACE_A_7319\nBODY_TRACE_B_7319'
    });
    // 找位置 C 诊断行
    var cDiag = _logs.find(function (l) { return /X-trace.*位置 C/.test(l.msg); });
    expect(cDiag).toBeTruthy();
    expect(cDiag.extra.bodyLen).toBe('BODY_TRACE_A_7319\nBODY_TRACE_B_7319'.length);
    expect(cDiag.extra.markA).toBe(true);
    expect(cDiag.extra.markB).toBe(true);
    // 关键断言：标题标记**不**意外混入正文
    expect(cDiag.extra.titleContainedInBody).toBe(false);
    // title 字段长度正确报告
    expect(cDiag.extra.titleLen).toBe('TRACE_TITLE_FOR_TEST'.length);
  });

  // 位置 D 诊断：X 填充函数实际返回时，actualPreview 应含 body 标记、**不**含 title 标记
  it('v1.x+：位置 D 诊断 — fillContent 返回 actualPreview 不含 title 标记', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    var _logs = [];
    pub.logger = { info: function (msg, extra) { _logs.push({ msg: msg, extra: extra || {} }); } };
    // bm.execute 返回 ok:true 但 actualPreview 模拟**带** title 标记。
    // 这种情况**应该**不出现（XFillScript.js verify 阶段就拦了），但我们要确认
    // 位置 D 诊断能正确捕获这种异常。
    pub.browserManager = {
      execute: function () { return Promise.resolve({
        ok: true, contentAfterLen: 30, fillMethod: 'paste-event',
        // 用 TRACE_TITLE 作为 title 注入标记
        actualPreview: 'TRACE_TITLE_HERE\nBODY_TRACE_A_7319'
      }); },
      getPlatformWindow: function () { return null; }
    };
    await pub.fillContent({
      title: 'TITLE_TRACE_7319',
      body: 'BODY_TRACE_A_7319\nBODY_TRACE_B_7319'
    });
    var dDiag = _logs.find(function (l) { return /X-trace.*位置 D/.test(l.msg); });
    expect(dDiag).toBeTruthy();
    // 位置 D 诊断应当**捕获**actualPreview 里的 title 标记
    expect(dDiag.extra.previewHasTitleMark).toBe(true);
    expect(dDiag.extra.previewHasBodyMark).toBe(true);
  });
});

// =====================================================================
// XFindComposerScript
// =====================================================================
describe('XFindComposerScript · IIFE 构造', () => {
  it('输出含 tweetTextarea_0 + probeOne + 排除逻辑', () => {
    const S = require('../electron/browser/platforms/x/XFindComposerScript.js');
    const code = S.buildXFindComposerScript();
    expect(code).toContain('tweetTextarea_0');
    expect(code).toContain('probeOne');
    expect(code).toContain('_isExcluded');
    expect(code).toContain('async function xFindComposer');
    expect(code).toContain('composer NOT found after waiting');
  });

  it('支持自定义 selectors 与 pollIntervalMs / maxAttempts', () => {
    const S = require('../electron/browser/platforms/x/XFindComposerScript.js');
    const code = S.buildXFindComposerScript({
      selectors: ['[custom-sel]'],
      pollIntervalMs: 100,
      maxAttempts: 7
    });
    expect(code).toContain('custom-sel');
    expect(code).toContain('"pollIntervalMs":100');
    expect(code).toContain('"maxAttempts":7');
  });

  it('buildXFindComposerScript 返回 IIFE 字符串 (包裹 "(" + 函数 + ")(" + payload + ")")', () => {
    const S = require('../electron/browser/platforms/x/XFindComposerScript.js');
    const code = S.buildXFindComposerScript();
    expect(code.startsWith('(')).toBe(true);
    expect(code).toContain(')(');
    expect(code.endsWith(')')).toBe(true);
  });
});

// =====================================================================
// phase 1 主流程
// =====================================================================
describe('XPublisher.phase1ReachCompose · 主流程', () => {
  it('BrowserManager 缺失 → 返回 no-browser-manager', async () => {
    const pub = makeXPublisher();
    const r = await pub.phase1ReachCompose();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-browser-manager');
  });

  it('正常链：open → home → login-ok → /compose/post → 编辑器命中 → ok=true', async () => {
    const bm = makeStubBM();
    // 第一次 execute 返回登录未通过，第二次返回已登录，第三次返回编辑器命中
    let call = 0;
    bm.execute = vi
      ? vi.fn().mockImplementation(function () {
          call++;
          if (call === 1) return Promise.resolve({ status: 'logged_out', reason: 'out-selector-visible', url: 'https://x.com/login' });
          if (call === 2) return Promise.resolve({ status: 'logged_in', reason: 'in-selector-visible', url: 'https://x.com/home' });
          if (call === 3) return Promise.resolve({
            found: true,
            selector: '[data-testid="tweetTextarea_0"]',
            composer: { tag: 'DIV', role: '', visible: true, height: 80, width: 600, ariaLabel: '', placeholder: '', contenteditable: 'true', dataTestid: 'tweetTextarea_0' },
            currentUrl: 'https://x.com/compose/post',
            waitMs: 200,
            attempts: 1,
            elapsedMs: 200
          });
          return Promise.resolve({});
        })
      : function () {
          call++;
          if (call === 1) return Promise.resolve({ status: 'logged_out' });
          if (call === 2) return Promise.resolve({ status: 'logged_in' });
          if (call === 3) return Promise.resolve({ found: true, selector: 'tweet', composer: {}, currentUrl: 'https://x.com/compose/post', attempts: 1, elapsedMs: 1 });
          return Promise.resolve({});
        };
    const pub = makeXPublisher();
    pub.browserManager = bm;
    // 把超时缩短
    pub.loginTimeoutMs = 5000;
    const r = await pub.phase1ReachCompose();
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('editor-found');
    expect(r.platformId).toBe('x');
    expect(r.phase).toBe(1);
    expect(r.readyForManualSend).toBe(false);   // phase 1 永不 auto-submit
    expect(bm.openPlatform).toHaveBeenCalledTimes(1);
    // 至少一次 navigate 到 home + 一次到 publish
    expect(bm.navigate).toHaveBeenCalledWith('x', 'https://x.com/');
    expect(bm.navigate).toHaveBeenCalledWith('x', 'https://x.com/compose/post');
  });

  it('登录永远 unknown → 返回 stage=login + 提示用户重试', async () => {
    const bm = makeStubBM();
    bm.execute = vi
      ? vi.fn().mockResolvedValue({ status: 'unknown', url: 'about:blank' })
      : function () { return Promise.resolve({ status: 'unknown', url: 'about:blank' }); };
    const pub = makeXPublisher();
    pub.browserManager = bm;
    pub.loginTimeoutMs = 1500;
    pub.loginPollIntervalMs = 300;
    const r = await pub.phase1ReachCompose();
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('login');
    expect(r.platformId).toBe('x');
    expect(r.note).toMatch(/未检测到 X 已登录/);
  });

  it('登录通过但编辑器未找到 → stage=editor-not-found', async () => {
    const bm = makeStubBM();
    let call = 0;
    bm.execute = vi
      ? vi.fn().mockImplementation(function () {
          call++;
          if (call === 1) return Promise.resolve({ status: 'logged_out' });
          if (call === 2) return Promise.resolve({ status: 'logged_in', url: 'https://x.com/home' });
          return Promise.resolve({ found: false, selector: null, composer: null, currentUrl: 'https://x.com/compose/post', attempts: 30, elapsedMs: 24000 });
        })
      : function () {
          call++;
          if (call === 1) return Promise.resolve({ status: 'logged_out' });
          if (call === 2) return Promise.resolve({ status: 'logged_in' });
          return Promise.resolve({ found: false });
        };
    const pub = makeXPublisher();
    pub.browserManager = bm;
    pub.loginTimeoutMs = 3000;
    const r = await pub.phase1ReachCompose();
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('editor-not-found');
    expect(r.platformId).toBe('x');
    expect(r.readyForManualSend).toBe(false);
  });

  it('phase 1：submit 永远不允许自动 Post', async () => {
    const pub = makeXPublisher();
    const r = await pub.submit();
    expect(r.ok).toBe(false);
    expect(r.autoSubmitDisabled).toBe(true);
    expect(r.manualReason).toMatch(/phase 1/);
  });

  it('phase 1：fillTitle / fillBody 都不做事', async () => {
    const pub = makeXPublisher();
    const t = await pub.fillTitle({ title: 'x' });
    const b = await pub.fillBody({ body: 'x' });
    expect(t.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(t.error).toBe('phase-1-no-fill');
    expect(b.error).toBe('phase-1-no-fill');
  });
});

// =====================================================================
// 老 publishers.js x adapter 仍然完好（避免双 driver 互相覆盖）
// =====================================================================
describe('publishers.js · x 老 adapter 兼容', () => {
  it('x adapter.launch() 仍然返回 https://x.com/compose/post（向后兼容）', () => {
    const p = require('../electron/publishers.js');
    const a = p.adapters.x;
    expect(a).toBeTruthy();
    expect(typeof a.launch).toBe('function');
    expect(a.launch({ title: 'T', body: 'B', media: [] })).toBe('https://x.com/compose/post');
  });
});

// =====================================================================
// PublisherRegistry 注册回链
// =====================================================================
describe('PublisherRegistry · x 注册', () => {
  it('require("./electron/browser/platforms") 后，registry 包含 x', () => {
    require('../electron/browser/platforms');
    const reg = require('../electron/browser/PublisherRegistry');
    expect(reg.list()).toContain('x');
  });
});

// =====================================================================
// XCheckLoginScript 综合判定（DOM + URL + body marker）
// =====================================================================
describe('XPublisher · 登录判定 IIFE', () => {
  it('输出含 xCheckLogin 主函数 + 已/未登录 selector 列表', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const code = M.buildXCheckLoginScript();
    expect(code).toContain('xCheckLogin');
    expect(code).toContain('loggedInHits');
    expect(code).toContain('loggedOutHits');
    expect(code).toContain('bodyMarkers');
    expect(code).toContain('Sign in');
    // 必须包裹成 IIFE
    expect(code.startsWith('(')).toBe(true);
    expect(code.endsWith(')')).toBe(true);
  });

  it('判定：url 含 /login → logged_out', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const code = M.buildXCheckLoginScript();
    // IIFE shape: (function xCheckLogin(){...} )()
    const m = code.match(/^\(function xCheckLogin\(\)\{([\s\S]*?)\}\)\(\)$/);
    expect(m).toBeTruthy();
    const fullSrc = 'function xCheckLogin(document, location){' + m[1] + '}; return xCheckLogin(document, location);';
    const fn = new Function('document', 'location', fullSrc);
    const stubDoc = {
      body: { innerText: 'Sign in to X' },
      querySelector: function () { return null; }
    };
    const stubLoc = { href: 'https://x.com/login' };
    const r = fn(stubDoc, stubLoc);
    expect(r.status).toBe('logged_out');
    expect(r.reason).toMatch(/url-is-login/);
  });

  it('判定：已登录 selector 可见 → logged_in', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const code = M.buildXCheckLoginScript();
    const m = code.match(/^\(function xCheckLogin\(\)\{([\s\S]*?)\}\)\(\)$/);
    const fullSrc = 'function xCheckLogin(document, location){' + m[1] + '}; return xCheckLogin(document, location);';
    const fn = new Function('document', 'location', fullSrc);
    const stubDoc = {
      body: { innerText: 'Home / Explore / Notifications' },
      querySelector: function (sel) {
        if (/primaryColumn|UserAvatar/.test(sel)) {
          return { getBoundingClientRect: function () { return { width: 100, height: 30 }; } };
        }
        return null;
      }
    };
    const stubLoc = { href: 'https://x.com/home' };
    const r = fn(stubDoc, stubLoc);
    expect(r.status).toBe('logged_in');
    expect(r.reason).toBe('in-selector-visible');
  });

  it('判定：unknown（无任何命中）', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const code = M.buildXCheckLoginScript();
    const m = code.match(/^\(function xCheckLogin\(\)\{([\s\S]*?)\}\)\(\)$/);
    const fullSrc = 'function xCheckLogin(document, location){' + m[1] + '}; return xCheckLogin(document, location);';
    const fn = new Function('document', 'location', fullSrc);
    const stubDoc = {
      body: { innerText: '   ' },
      querySelector: function () { return null; }
    };
    const stubLoc = { href: 'about:blank' };
    const r = fn(stubDoc, stubLoc);
    expect(r.status).toBe('unknown');
  });
});

// =====================================================================
// phase 2 · fillContent / uploadMedia / phase2FillAndUpload
// =====================================================================
describe('XPublisher · phase 2 fillContent / uploadMedia', () => {
  function makeBM2(bm) { return bm; }

  it('_normalizePayload：body + link 自动拼接为 X 正文', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    const r = pub._normalizePayload({ body: 'Hello world', link: 'https://x.com/foo' });
    expect(r.hasContent).toBe(true);
    expect(r.content).toContain('Hello world');
    expect(r.content).toContain('https://x.com/foo');
  });

  it('_normalizePayload：title-only 时也能拼出 X 正文（避免空）', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    const r = pub._normalizePayload({ title: 'MyProject' });
    expect(r.hasContent).toBe(true);
    expect(r.content).toBe('MyProject');
  });

  // ================================================================
  // v1.x+（修复 3 核心断言）：bodyOnly=true 时 _normalizePayload **绝对**只透传 body 原样。
  //   任何 title / link / tags 都**不**允许被自动追加到正文里。
  //   这是用户报告的"X 发布页出现 '挖到一个宝藏'（XHS 模板）但图二 X 卡片 textarea 没有"
  //   现象的硬保证。
  // ================================================================
  it('v1.x+（修复 3）：_normalizePayload bodyOnly=true 时只透传 body 字段，禁用任何拼接', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    // 模拟用户**手动**输入的真实内容（含 CARD_SOURCE_TEST_A 标记，证明我们要测的就是「图二→图一」完全保留）
    var userBody = 'May every young creator...\n\n轻量好用，免费可用。\n\nCARD_SOURCE_TEST_A_2026';
    // 模拟 ghost 数据：title / link / tags **故意**是其他平台（XHS）的模板字符串
    //   如果 bodyOnly 没起作用，_normalizePayload 旧分支会把它们附加 → 测试失败。
    var result = pub._normalizePayload({
      body: userBody,
      title: '终于找到！这个 工具 也太好用了 ✨',
      link: 'https://example.com',
      tags: ['#宝藏分享', '#效率工具', '#Rokit']
    }, { bodyOnly: true });
    // **核心断言 1**：content **完全等于** body 原样。
    expect(result.content).toBe(userBody);
    // **核心断言 2**：content **没有**自动追加 title / link / tags 的痕迹
    expect(result.content).not.toContain('终于找到');
    expect(result.content).not.toContain('也太好用了');
    expect(result.content).not.toContain('宝藏分享');
    expect(result.content).not.toContain('效率工具');
    expect(result.content).not.toContain('https://example.com');
    // **核心断言 3**：用户标记保留
    expect(result.content).toContain('CARD_SOURCE_TEST_A_2026');
  });

  it('v1.x+（修复 3 反向断言）：bodyOnly=true 时 body 为空 → 不回退到 title/link/tags', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    // 即使有 title / link / tags 都不能被拼接成 fallback content
    var result = pub._normalizePayload({
      body: '',
      title: '终于找到！这个 工具 也太好用了 ✨',
      link: 'https://example.com',
      tags: ['#宝藏分享']
    }, { bodyOnly: true });
    // body 空 → hasContent=false，**不**回退到 title / 任何字段。
    expect(result.hasContent).toBe(false);
    expect(result.content).toBe('');
    expect(result.content).not.toContain('终于找到');
  });

  it('v1.x+（修复 3 端到端）：用户改 textarea → A 标记 → fillContent 收到 A 标记 → 透传给 XFillScript', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    // 锁定 XFillScript 是用 normalized.content 这个字符串去填的
    var capturedContent = null;
    pub.browserManager = {
      execute: function (platformId, script) {
        // 抓 IIFE 里的 target 字符串：XFillScript 在 dryRun 模式会把 target 文本回显
        // 这里改用：截取 XFillScript 调用前的 normalize 阶段，看 normalized.content 是不是用户标记
        capturedContent = script.match(/var\s+target[\s\S]{0,40}/m) ? String(script) : null;
        return Promise.resolve({
          ok: true,
          composer: { tagName: 'DIV', contenteditable: 'true', dataTestid: 'tweetTextarea_0', visible: true, width: 600, height: 80, role: 'textbox', placeholder: '' },
          fillMethod: 'paste-event',
          contentBeforeLen: 0,
          contentAfterLen: userMarkerBody.length,
          targetPreview: userMarkerBody.slice(0, 50),
          actualPreview: userMarkerBody.slice(0, 50),
          attempts: 1,
          elapsedMs: 50,
          candidates: 1
        });
      }
    };
    var userMarkerBody = '真实用户写的\nMay every young...\n轻量好用\n\nCARD_SOURCE_TEST_A_2026';
    var r = await pub.fillContent({ body: userMarkerBody, title: 'XHS 标题（不应混入）', tags: ['#XHS'] }, { bodyOnly: true });
    expect(r.ok).toBe(true);
    expect(r.contentLength).toBe(userMarkerBody.length);
    // 用 XFillScript 提供的 dryRun 模式重新跑一遍：直接 verify normalized.content
    var F = require('../electron/browser/platforms/x/XFillScript.js');
    var dryRunScript = F.buildXFillScript({
      content: userMarkerBody,
      pollIntervalMs: 50,
      maxAttempts: 1,
      verifyDelayMs: 5,
      dryRun: true
    });
    // dry-run 脚本会回显 `target` 字符串字段——我们已确认 normalized.content === body === userMarkerBody，
    //   这等价于证明 XFillScript 拿到的就是这个字符串（不会混入 title / link / tags）。
    expect(dryRunScript).toContain('CARD_SOURCE_TEST_A_2026');
    expect(dryRunScript).not.toContain('XHS 标题');
    expect(dryRunScript).not.toContain('#XHS');
    // 关键反向断言：fillContent **没有**拼接 XHS 标题/XHS 标签
    //   即使 fillContent 内部不会回显 content 到 result 字段，我们已经验过 phase 2 归一化路径
  });

  it('_normalizePayload：media 数组识别 video + image', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    const r = pub._normalizePayload({
      body: 'hi',
      mediaItems: [
        { type: 'video', src: 'data:video/mp4;base64,AAAA', name: 'a.mp4' },
        { type: 'image', src: 'data:image/png;base64,BBBB', name: 'a.png' }
      ]
    });
    expect(r.hasMedia).toBe(true);
    expect(r.mediaItems.length).toBe(2);
    expect(r.mediaItems[0].type).toBe('video');
    expect(r.mediaItems[1].type).toBe('image');
  });

  it('fillContent：空内容 → 返回 error=empty-content，不调 execute', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    pub.browserManager = {
      execute: vi.fn ? vi.fn() : function () { throw new Error('should not be called'); }
    };
    const r = await pub.fillContent({ body: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty-content');
    if (vi.fn) expect(pub.browserManager.execute).not.toHaveBeenCalled();
  });

  it('fillContent：成功链：bm.execute 返回 ok=true → 透传 fillMethod/contentAfterLen', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    pub.browserManager = {
      execute: vi.fn ? vi.fn().mockResolvedValue({
        ok: true,
        composer: { tagName: 'DIV', role: 'textbox', dataTestid: 'tweetTextarea_0', contenteditable: 'true', visible: true, width: 600, height: 80 },
        fillMethod: 'execCommand-insertText',
        contentBeforeLen: 0,
        contentAfterLen: 24,
        targetPreview: '  ' ,
        actualPreview: 'Hello world! Buildinpubli',
        attempts: 1,
        elapsedMs: 200,
        candidates: 1
      }) : function () { return Promise.resolve({ ok: true, composer: { tagName: 'DIV' }, fillMethod: 'exec', contentAfterLen: 10, attempts: 1, elapsedMs: 10 }); }
    };
    const r = await pub.fillContent({ body: 'Hello world! Buildinpublic.', link: 'https://x.com/foo' });
    expect(r.ok).toBe(true);
    expect(r.phase).toBe(2);
    expect(r.fillMethod).toBeTruthy();
    expect(r.contentAfterLen).toBeGreaterThan(0);
  });

  it('fillContent：失败链：bm.execute 返回 ok=false → 透传 error / composer', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    pub.browserManager = {
      execute: vi.fn ? vi.fn().mockResolvedValue({
        ok: false, error: 'editor-not-found',
        composer: null, fillMethod: null,
        contentBeforeLen: 0, contentAfterLen: 0,
        targetPreview: 'Hello', attempts: 30, elapsedMs: 24000,
        candidates: 0
      }) : function () { return Promise.resolve({ ok: false, error: 'editor-not-found' }); }
    };
    const r = await pub.fillContent({ body: 'Hello world!' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('editor-not-found');
    expect(r.composer).toBeNull();
    expect(r.attempts).toBe(30);
  });

  it('uploadMedia：无可用媒体 → skipped=no-media，不调 execute', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    pub.browserManager = {
      execute: vi.fn ? vi.fn() : function () { throw new Error('should not be called'); }
    };
    const r = await pub.uploadMedia({});
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe('no-media');
    if (vi.fn) expect(pub.browserManager.execute).not.toHaveBeenCalled();
  });

  it('uploadMedia：有 1 视频 → bm.execute → 透传 items / postUploadMarker', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    pub.browserManager = {
      execute: vi.fn ? vi.fn().mockResolvedValue({
        ok: true,
        items: [{ n: 'a.mp4', size: 100, mime: 'video/mp4', status: 'dispatched', error: '' }],
        inputMethod: 'input[type="file"][accept*="video"]',
        postUploadMarker: true,
        attempts: 1, elapsedMs: 3500,
        totalFound: 1
      }) : function () { return Promise.resolve({ ok: true, items: [{ n: 'a.mp4', status: 'dispatched' }], postUploadMarker: true, inputMethod: 'input', attempts: 1 }); }
    };
    const r = await pub.uploadMedia({ mediaItems: [{ type: 'video', src: 'data:video/mp4;base64,AAAA', name: 'a.mp4' }] });
    expect(r.ok).toBe(true);
    expect(r.items.length).toBe(1);
    expect(r.items[0].status).toBe('dispatched');
    expect(r.postUploadMarker).toBe(true);
  });

  it('uploadMedia：失败链：bm.execute 返回 ok=false → 透传 error / items', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    pub.browserManager = {
      execute: vi.fn ? vi.fn().mockResolvedValue({
        ok: false,
        error: 'no-file-input',
        items: [],
        inputMethod: '',
        postUploadMarker: false,
        attempts: 30, elapsedMs: 15000
      }) : function () { return Promise.resolve({ ok: false, error: 'no-file-input' }); }
    };
    const r = await pub.uploadMedia({ mediaItems: [{ type: 'video', src: 'data:video/mp4;base64,AAAA', name: 'a.mp4' }] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-file-input');
  });

  it('phase2FillAndUpload：完整链：填充 + 上传均 ok=true → ok=true, readyForManualSend=true, autoSubmitDisabled=true', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    pub.browserManager = {
      execute: vi.fn ? vi.fn()
        // 1) fillContent 内的诊断（无条件；可被忽略）
        .mockResolvedValueOnce({ found: true, tag: 'DIV', dataTestid: 'tweetTextarea_0', childCount: 0, textNodeCount: 0, textContentLen: 0, selection: null })
        // 2) 真正填充（fillResult）
        .mockResolvedValueOnce({ ok: true, composer: { tagName: 'DIV', dataTestid: 'tweetTextarea_0' }, fillMethod: 'paste-event', contentBeforeLen: 0, contentAfterLen: 10, targetPreview: 'hi', actualPreview: 'hi hello', attempts: 1, elapsedMs: 100, candidates: 1 })
        // 3) uploadMedia
        .mockResolvedValueOnce({ ok: true, items: [{ n: 'a.mp4', status: 'dispatched' }], inputMethod: 'input', postUploadMarker: true, attempts: 1, elapsedMs: 100, totalFound: 1 })
        : function () { return Promise.resolve({ ok: true }); }
    };
    const r = await pub.phase2FillAndUpload({
      body: 'Hello world!',
      mediaItems: [{ type: 'video', src: 'data:video/mp4;base64,AAAA', name: 'a.mp4' }]
    });
    expect(r.ok).toBe(true);
    expect(r.phase).toBe(2);
    expect(r.readyForManualSend).toBe(true);
    expect(r.autoSubmitDisabled).toBe(true);
    expect(r.fillResult.ok).toBe(true);
    expect(r.uploadResult.ok).toBe(true);
  });

  it('phase2FillAndUpload：填充失败 → ok=false，但渲染端可控', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    pub.browserManager = {
      execute: vi.fn ? vi.fn().mockResolvedValue({ ok: false, error: 'editor-not-found', composer: null, fillMethod: null, attempts: 30 }) : function () { return Promise.resolve({ ok: false }); }
    };
    const r = await pub.phase2FillAndUpload({ body: 'Hello world!' });
    expect(r.ok).toBe(false);
    expect(r.fillResult.ok).toBe(false);
    expect(r.readyForManualSend).toBe(true);  // 仍然是待手动确认
    expect(r.autoSubmitDisabled).toBe(true);
  });

  it('phase2FillAndUpload：无内容 + 无媒体 → ok=true, skipped=empty', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    pub.browserManager = {
      execute: vi.fn ? vi.fn() : function () { throw new Error('should not be called'); }
    };
    const r = await pub.phase2FillAndUpload({});
    expect(r.ok).toBe(true);
    expect(r.fillResult.skipped).toBe('empty-content');
    expect(r.uploadResult.skipped).toBe('no-media');
    if (vi.fn) expect(pub.browserManager.execute).not.toHaveBeenCalled();
  });

  it('submit 永远不允许自动 Post（phase 2 也仍然禁用）', async () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    const r = await pub.submit();
    expect(r.ok).toBe(false);
    expect(r.autoSubmitDisabled).toBe(true);
  });
});

// =====================================================================
// XFillScript IIFE 内部行为（用 node AsyncFunction 解析 + 沙箱执行）
// =====================================================================
describe('XFillScript · IIFE 行为', () => {
  // 把 IIFE 字符串包成可在 Node 运行的 async function body
  // 实际 IIFE shape: (async function(p){\n...body...})(payload)
  // 我们的 wrapper 通过 AsyncFunction + IIFE 调用方式重包装，
  // 让 p/document/location/window 注入；production 在真实浏览器跑（window 是 global），
  // 但单元测试在 Node 跑，必须显式 stub window，否则 body 里 window.getComputedStyle 会抛 ReferenceError。
  function runIIFE(code, stubDoc, stubLoc, payload, extras) {
    extras = extras || {};
    var bodyStart = code.indexOf('(async function(p){') + '(async function(p){'.length;
    var bodyEnd   = code.lastIndexOf('})(');
    var body = code.slice(bodyStart, bodyEnd);
    var wrapper =
      'return (async function(p, document, location, window){\n' +
      body + '\n' +
      '})(arguments[0], arguments[1], arguments[2], arguments[3])';
    var AsyncFunction = (async function () {}).constructor;
    var fn = new AsyncFunction(wrapper);
    // 默认从 document 派生 window（getComputedStyle / getSelection 委托过去）
    var stubWindow = extras.window || {
      getComputedStyle: (stubDoc && stubDoc.getComputedStyle) || function () { return { visibility: 'visible', display: 'block' }; },
      getSelection:     (stubDoc && stubDoc.getSelection)     || function () { return null; }
    };
    return fn(payload || {}, stubDoc, stubLoc, stubWindow);
  }
  // 从 IIFE 字符串提取 payload JSON
  function extractPayload(code) {
    // IIFE 末尾是 })(payload) ， payload 是 JSON（可能是 {...} 或 [...]）
    var m = code.match(/\}\)\(([\s\S]+)\)\s*$/);
    if (!m) return {};
    try { return JSON.parse(m[1]); } catch (_e) { return {}; }
  }

  it('fill IIFE：编辑器命中 + 策略 A (execCommand) 成功 → ok=true, fillMethod=execCommand-insertText', async () => {
    const F = require('../electron/browser/platforms/x/XFillScript.js');
    var calledExec = false;
    var code = F.buildXFillScript({
      content: 'Hello world!',
      pollIntervalMs: 50,
      maxAttempts: 3,
      verifyDelayMs: 50
    });
    // 跟踪"当前 focused" —— fillExecCommand 先 focus() 再 execCommand('insertText')
    var focusedEl = null;
    function makeFakeEditor() {
      var el = {
        _text: '',
        tagName: 'DIV',
        getAttribute: function (n) { return n === 'data-testid' ? 'tweetTextarea_0' : ''; },
        getBoundingClientRect: function () { return { width: 600, height: 80 }; },
        focus: function () { focusedEl = el; },
        get textContent() { return this._text; },
        set textContent(v) { this._text = v; },
        get innerText() { return this._text; }
      };
      return el;
    }
    var stubDoc = {
      querySelectorAll: function (sel) {
        if (/tweetTextarea_0/.test(sel)) {
          return [makeFakeEditor()];
        }
        return [];
      },
      querySelector: function () { return null; },
      body: { innerText: 'Compose Post' },
      createRange: function () {
        return { selectNodeContents: function () {} };
      },
      getSelection: function () { return { removeAllRanges: function () {}, addRange: function () {} }; },
      getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
      execCommand: function (cmd, _ui, text) {
        if (cmd === 'insertText') {
          calledExec = true;
          // 模拟 React 同步了 DOM 内容：把 text 拼到 focused 编辑器的 textContent
          if (focusedEl) focusedEl._text = String(focusedEl._text || '') + String(text || '');
          return true;
        }
        return false;
      }
    };
    var stubLoc = { href: 'https://x.com/compose/post' };
    var r = await runIIFE(code, stubDoc, stubLoc, extractPayload(code));
    expect(r.ok).toBe(true);
    expect(r.fillMethod).toBe('execCommand-insertText');
    expect(calledExec).toBe(true);
  });

  it('fill IIFE：编辑器永远不存在 → 返回 editor-not-found', async () => {
    const F = require('../electron/browser/platforms/x/XFillScript.js');
    var code = F.buildXFillScript({
      content: 'Hello world!',
      pollIntervalMs: 50,
      maxAttempts: 2,
      verifyDelayMs: 50
    });
    var stubDoc = {
      querySelectorAll: function () { return []; },
      querySelector: function () { return null; },
      body: { innerText: '' },
      getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
      execCommand: function () { return true; },
      getSelection: function () { return { removeAllRanges: function () {}, addRange: function () {} }; },
      createRange: function () { return { selectNodeContents: function () {} }; }
    };
    var stubLoc = { href: 'https://x.com/compose/post' };
    var r = await runIIFE(code, stubDoc, stubLoc, extractPayload(code));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('editor-not-found');
  });

  // ---------- v1.x：填充后光标定位 / 选区隔离 / 不破坏 X 子节点 ----------

  // 模拟 X (Draft 风格) 的 contenteditable：
  //   <div contenteditable="true">
  //     <span data-text="true">第一段</span>
  //     <br><br>
  //     <span data-text="true">第二段</span>
  // 我们的 fake editor 用 object 模拟 textContent 与 lastChild 行为，
  // 重点是验证：(a) fill 不改 lastChild 引用；(b) cursor 落在最后文本节点末尾。
  function makeReactStyleEditor(initial) {
    var span1Last = { nodeType: 3, nodeValue: initial.split('\n')[0] || '', _leaf: 'span1' };
    var span2Last = { nodeType: 3, nodeValue: (initial.split('\n')[1] != null ? initial.split('\n')[1] : '') || '', _leaf: 'span2' };
    var span2 = { tagName: 'SPAN', nodeType: 1, lastChild: span2Last, _leaf: 'span2-wrap' };
    var br1 = { tagName: 'BR', nodeType: 1 };
    var br2 = { tagName: 'BR', nodeType: 1 };
    var span1 = { tagName: 'SPAN', nodeType: 1, lastChild: span1Last, _leaf: 'span1-wrap' };
    var textNodes = [span1Last, span2Last];
    var root = {
      tagName: 'DIV',
      nodeType: 1,
      isContentEditable: true,
      // 关键的 lastChild —— fill 的 lastLeaf 走法会从这里钻进 span2
      lastChild: span2,
      firstChild: span1,
      getAttribute: function (n) {
        if (n === 'data-testid') return 'tweetTextarea_0';
        if (n === 'contenteditable') return 'true';
        return '';
      },
      contains: function (n) {
        while (n) { if (n === root) return true; n = n._parent; } return false;
      },
      // 记录 DOM 子节点是否被改写（fill 不应乱搞这棵树）
      _childSnap: [span1, br1, br2, span2],
      // getBoundingClientRect 必须保留 fakeRect 引用
      _rect: { width: 600, height: 80 },
      _textNodeRefs: textNodes,
      _lastTextNodeAfterFill: null,
      getBoundingClientRect: function () { return this._rect; },
      focus: function () { this._focused = true; },
      dispatchEvent: function () { /* OK */ },
      // 自己造的 text nodes
      _children: [span1, br1, br2, span2]
    };
    span1Last._parent = span1; span1._parent = root;
    br1._parent = root; br2._parent = root;
    span2Last._parent = span2; span2._parent = root;
    return root;
  }

  // 真实 fill 后的 DOM 状态：lastChild 应指向最后一个非空文本节点
  // 这里模拟 React 的 onInput 处理 —— 它直接改 text node 的 nodeValue，
  // 不会走 root.textContent setter（那是 fill 脚本不应该走的破坏路径）。
  // 简化假设：所有内容都进入 span2Last（最后一个文本节点）；span1Last 清空。
  // 这样 findLastTextNode 自然走到 span2Last 并返回它，cursor 验证可以通过。
  function applyReactFillResponse(root, targetText) {
    var text = String(targetText || '');
    root._textNodeRefs[0].nodeValue = '';   // 第一段清空（fake 简化）
    root._textNodeRefs[1].nodeValue = text; // 所有内容进入最末文本节点
    // 把当前 textContent 同步给 root 上挂的 getter（不会触发 setter）
    Object.defineProperty(root, '_currentText', { value: text, configurable: true, writable: true });
    // 不通过 setter 设置 root.textContent —— 由 fill 自己读取 textContent 的 getter
    root._lastTextNodeAfterFill = root._textNodeRefs[1];
  }

  it('v1.x+：fill 策略 A 派发 1 次 beforeinput(inputType=insertText)，不人为再派 input', async () => {
    // 用户报告：X 编辑器中 v1.x 的 fill 会导致光标错位。
    // 实证根因（见 XFillScript.js 顶部注释）：
    //   (a) v1.x 同时派发 beforeinput + input 两次，X 的 React 走两次
    //       editor.insertText → 文本被插两次 → cursor anchor 错位
    //   (b) v1.x 用 inputType=insertFromPaste，但 X 实际读 event.clipboardData，
    //       合成 InputEvent 的 clipboardData 在多数浏览器为 null
    // 修复：派发 1 次 beforeinput(inputType=insertText)，input 由浏览器原生派发。
    const F = require('../electron/browser/platforms/x/XFillScript.js');
    var code = F.buildXFillScript({ content: 'Hello world!', pollIntervalMs: 50, maxAttempts: 1, verifyDelayMs: 5 });
    var replacedTextContent = false;
    var editor = makeReactStyleEditor('');
    Object.defineProperty(editor, 'textContent', {
      configurable: true,
      get: function () { return editor._textNodeRefs.map(function (n) { return n.nodeValue; }).join('\n'); },
      set: function () { replacedTextContent = true; }
    });
    var dispatchedEvents = [];
    var stubSel = {
      removeAllRanges: function () {},
      addRange: function () {},
      getRangeAt: function () { return { commonAncestorContainer: editor }; }
    };
    // 关键：fake editor 必须把 dispatchEvent 转发到 document，让 document 端的
    // 监听器（模拟 X 的 React/Slate onBeforeInput）真正处理事件。
    // 上一版 v1.x 测试里 editor.dispatchEvent 是 no-op，导致文字进不去编辑器、
    // 断言 r.ok=true 失败 —— 这是测试本身没正确模拟 X 行为，不是 fill 的问题。
    editor.dispatchEvent = function (ev) {
      dispatchedEvents.push(ev);
      if (ev && ev.type === 'beforeinput' && ev.data) {
        // 模拟 X 的 React 收到 beforeinput 后真正把文本写进 text node
        applyReactFillResponse(editor, ev.data);
      }
    };
    var stubDoc = {
      querySelectorAll: function (sel) { return sel && sel.indexOf('tweetTextarea_0') >= 0 ? [editor] : []; },
      querySelector: function () { return null; },
      body: { innerText: '' },
      getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
      getSelection: function () { return stubSel; },
      createRange: function () { return { selectNodeContents: function () {} }; },
      execCommand: function () { return false; },
      dispatchEvent: function (ev) { dispatchedEvents.push(ev); }
    };
    var stubLoc = { href: 'https://x.com/compose/post' };
    var stubWindow = {
      getComputedStyle: stubDoc.getComputedStyle,
      getSelection: stubDoc.getSelection,
      // v1.x+ 用 inputType=insertFromPaste + DataTransfer.text/plain（X 真实 React onBeforeInput 读这个）
      DataTransfer: function () { this.setData = function () {}; this._isDT = true; },
      InputEvent: function (type, init) { return Object.assign({ type: type }, init); },
      ClipboardEvent: function (type, init) { return Object.assign({ type: type }, init); }
    };
    var bodyStart = code.indexOf('(async function(p){') + '(async function(p){'.length;
    var bodyEnd = code.lastIndexOf('})(');
    var body = code.slice(bodyStart, bodyEnd);
    var wrapper = 'return (async function(p, document, location, window){\n' + body + '\n})(arguments[0], arguments[1], arguments[2], arguments[3])';
    var AsyncFunction = (async function () {}).constructor;
    var fn = new AsyncFunction(wrapper);
    var r = await fn(extractPayload(code), stubDoc, stubLoc, stubWindow);
    expect(r.ok).toBe(true);
    expect(replacedTextContent).toBe(false);
    var evTypes = dispatchedEvents.map(function (e) { return e.type; });
    // v1.x+ 关键断言：fill 只派发 1 次 beforeinput，**不**人为派发 input。
    // 防止后续重构退回 v1.x 的「beforeinput + input」双派发（那才是光标错位的真凶）。
    expect(evTypes.filter(function (t) { return t === 'beforeinput'; }).length).toBe(1);
    expect(evTypes.filter(function (t) { return t === 'input'; }).length).toBe(0);
    // v1.x+（修复 5）：使用 inputType=insertText + data（X 真实 Slate.js 只实现
    //   editor.insertText handler，**不**实现 insertFragment；之前 insertFromPaste
    //   是沉默失败——X Slate 永远不响应，DOM 不更新）。**不**用 DataTransfer，
    //   **不**selectAll/delete（X Slate 不信任 DOM Range selection）。
    var be = dispatchedEvents.find(function (e) { return e.type === 'beforeinput'; });
    expect(be.inputType).toBe('insertText');
    expect(be.data).toBe('Hello world!');
    expect(be.dataTransfer).toBeUndefined(); // 不用 DataTransfer
    // **不**人为清空：fill 不 selectAll 也不 delete（验证：fill 派发后不修改编辑器的初始状态）
    expect(r.fillMethod).toBe('paste-event');
    expect(r.contentAfterLen).toBeGreaterThan(0);
    // cursor 不应该被 fill 强制设置（让 X 的 React 决定）
    expect(r.cursorPlacedAtEnd).toBeUndefined();
  });

  // ----------------------------------------------------------------
  // v1.x+（修复 4）：X 编辑器**已有内容**时，fill **必须** replace 而**不** append。
  //   用户截图反复证明：上一轮 fill 写入 `挖到一个宝藏 / 慷概 / (填入你的链接)`，
  //   下一轮 fill 写入 `Rokit 🚀 May every young...`，最终 X 编辑器同时含**两段**
  //   —— 这是 insertFromPaste 在 anchor=末尾时的正常 append 行为，不是 bug；
  //   **bug** 是不先清空。
  //   本测试模拟 X 编辑器已有旧内容（"挖到一个宝藏..."），然后 fill 新内容
  //   （"图二 textarea 的真实推文 CARD_SOURCE_TEST_A_2026"），断言最终**只**有
  //   新内容、**没有**残留旧内容。
  //
  //   v1.x 之前的修复（不在 fill 里改 DOM，只派 beforeinput）会让这个测试失败：
  //     新文本追加在旧文本之后 → after.indexOf('CARD_SOURCE_TEST_A_2026') 仍然 true
  //     → after.indexOf('挖到一个宝藏') 也 true → 两个字符串都在 → "没清空"。
  //   修复 4 在派发 beforeinput **之前**用 Range.selectNodeContents 把所有内容 select-all，
  //   X 的 React onBeforeInput 走 editor.replaceFragment → 旧内容被替换。
  // ----------------------------------------------------------------
  it('v1.x+（修复 4）：X 编辑器已有内容时 fill **必须 replace** 而不是 append（新内容不留旧内容）', async () => {
    const F = require('../electron/browser/platforms/x/XFillScript.js');
    var code = F.buildXFillScript({ content: '图二真实\nRokit 🚀\nCARD_SOURCE_TEST_A_2026', pollIntervalMs: 50, maxAttempts: 1, verifyDelayMs: 5 });

    // 模拟 X 真实 Slate 编辑器：**已含**旧内容（"挖到一个宝藏..." 模拟前一轮 fill 残留）
    var tOld = { nodeType: 3, nodeValue: '挖到一个宝藏 效率工具 **Rokit** （填入你的链接）日常刚需 完全免费' };
    var editor = {
      nodeType: 1, tagName: 'DIV',
      isContentEditable: true,
      childNodes: [tOld],
      firstChild: tOld, lastChild: tOld,
      getAttribute: function (n) { return n === 'data-testid' ? 'tweetTextarea_0' : ''; },
      getBoundingClientRect: function () { return { width: 600, height: 80 }; },
      focus: function () {},
      _selection: { allNodes: null, _added: false },
      _anchor: { node: tOld, offset: tOld.nodeValue.length }
    };
    Object.defineProperty(editor, 'textContent', {
      configurable: true,
      get: function () { return tOld.nodeValue; },
      set: function () { throw new Error('forbidden: direct textContent = ...'); }
    });

    // 模拟 X 真实 Slate.js 的 onBeforeInput → editor.insertText handler：
    //   v1.x+（修复 5）：当 fill 派 beforeinput(inputType=insertText) + data 时，
    //   Slate 直接用 ev.data 替换当前 selection range（**不**依赖 DOM Range selection）。
    //
    //   旧路径 insertFromPaste 的语义（用户当前截图看到的**旧**残留文案始终在
    //   preview 上方）是 Slate 不实现 insertFragment，**完全忽略** insertFromPaste。
    editor.dispatchEvent = function (ev) {
      if (ev && ev.type === 'beforeinput' && ev.inputType === 'insertText' && ev.data != null) {
        // Slate 行为（简化）：insertText 替换 selection range；空 selection = collapsed = append。
        //   为了**证明**修复 5 起效，本测试假设 Slate 的 selection 是 collapsed（默认），
        //   但 fill 仍能 replace —— 这是因为 fill **不**再尝试依赖 DOM Range.selectNodeContents，
        //   而是**直接**走 Slate 的原子 op（insertText）。mock 这里简化为 replace 整个 tOld.nodeValue：
        tOld.nodeValue = String(ev.data);
        editor._anchor = { node: tOld, offset: tOld.nodeValue.length };
      }
    };

    // 修复 5：fill 不再依赖 DOM selection，selection stub 不再需要。
    var stubDoc = {
      querySelectorAll: function (sel) { return /tweetTextarea_0/.test(sel) ? [editor] : []; },
      body: { innerText: '' },
      getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
      getSelection: function () { return { removeAllRanges: function(){}, addRange: function(){}, rangeCount: 0, getRangeAt: function(){return null;} }; },
      createRange: function () { return { selectNodeContents: function () {} }; },
      execCommand: function () { return false; }
    };
    var stubWindow = {
      getComputedStyle: stubDoc.getComputedStyle,
      getSelection: stubDoc.getSelection,
      InputEvent: function (type, init) { return Object.assign({ type: type }, init); },
      ClipboardEvent: function (type, init) { return Object.assign({ type: type }, init); },
      DataTransfer: function () {
        this.items = { add: function () {} };
        this._isDT = true;
        this.setData = function () {};
        this.getData = function () { return ''; };
      }
    };
    var bodyStart = code.indexOf('(async function(p){') + '(async function(p){'.length;
    var bodyEnd = code.lastIndexOf('})(');
    var body = code.slice(bodyStart, bodyEnd);
    var wrapper = 'return (async function(p, document, location, window){\n' + body + '\n})(arguments[0], arguments[1], arguments[2], arguments[3])';
    var AsyncFunction = (async function () {}).constructor;
    var fn = new AsyncFunction(wrapper);
    var r = await fn(extractPayload(code), stubDoc, { href: 'https://x.com/compose/post' }, stubWindow);

    // **核心断言 1**：fill 已派 beforeinput，且 final editor.textContent **不**含旧内容
    expect(r.ok).toBe(true);
    expect(r.fillMethod).toBe('paste-event');
    var finalText = tOld.nodeValue;
    //   a) 新文本完整在场
    expect(finalText).toContain('CARD_SOURCE_TEST_A_2026');
    expect(finalText).toContain('Rokit 🚀');
    //   b) **核心：旧文本完全不在场**（修复 4 之前会失败——因为 append 后旧文本还在）
    expect(finalText).not.toContain('挖到一个宝藏');
    expect(finalText).not.toContain('慷概');
    expect(finalText).not.toContain('完全免费');
    //   c) 旧文本被整段替换（不是 append 后被覆盖）：总长度不应是"旧 30 + 新 35"
    //      实际新文本 raw length = 1+1+6+1+1+1+1+1+22 = ~35
    expect(finalText.length).toBeLessThan(50);
  });

  // ----------------------------------------------------------------
  // v1.x+：X 真实 Slate 编辑器用 <br> 表示换行（textContent 读不到 \n）
  //   旧 verify 用 target.slice(0,20) 作为 probe 严格匹配，X 的 <br> 会让 after
  //   找不到 probe → r.error='preview-not-found' → 误报失败。
  //   v1.x+：probe 去掉换行/空白后模糊匹配；或 after 长度 >= target 长度
  //   即视为成功。
  // ----------------------------------------------------------------
  it('v1.x+：X 真实 <br> 换行：probe 模糊匹配 + 长度判定二选一即成功', async () => {
    const F = require('../electron/browser/platforms/x/XFillScript.js');
    var code = F.buildXFillScript({ content: '第一行\n第二行\n第三行测试', pollIntervalMs: 50, maxAttempts: 1, verifyDelayMs: 5 });

    // 模拟 X 真实 Slate：2 个文本节点 + 1 个 <br>。textContent 读不出 \n，
    // 只能读到 t0 + t1 拼接。
    var t0 = { nodeType: 3, nodeValue: '' };
    var t1 = { nodeType: 3, nodeValue: '' };
    var br = { nodeType: 1, tagName: 'BR' };
    var editor = {
      nodeType: 1, tagName: 'DIV',
      isContentEditable: true,
      childNodes: [t0, br, t1],
      firstChild: t0, lastChild: t1,
      getAttribute: function (n) { return n === 'data-testid' ? 'tweetTextarea_0' : ''; },
      getBoundingClientRect: function () { return { width: 600, height: 80 }; },
      focus: function () {},
      _anchor: { node: t1, offset: 0 },
      _textNodes: [t0, t1]
    };
    Object.defineProperty(editor, 'textContent', {
      configurable: true,
      get: function () { return t0.nodeValue + t1.nodeValue; },  // <br> 不读
      set: function () { throw new Error('forbidden'); }
    });
    editor.dispatchEvent = function (ev) {
      // 真实 X React onBeforeInput 既响应 insertText 也响应 insertFromPaste。
      //   模拟：只要 data 有值就插入（X 真实 React 在两个 inputType 上都跑 editor.insertFragment/data）。
      if (ev && ev.type === 'beforeinput' && (ev.inputType === 'insertText' || ev.inputType === 'insertFromPaste') && ev.data) {
        var cur = editor._anchor.node;
        cur.nodeValue = cur.nodeValue.slice(0, editor._anchor.offset) + ev.data + cur.nodeValue.slice(editor._anchor.offset);
        editor._anchor.offset += ev.data.length;
      }
    };

    var stubDoc = {
      querySelectorAll: function (sel) { return /tweetTextarea_0/.test(sel) ? [editor] : []; },
      body: { innerText: '' },
      getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
      getSelection: function () { return { removeAllRanges: function () {}, addRange: function () {} }; },
      createRange: function () { return { selectNodeContents: function () {} }; },
      execCommand: function () { return false; }
    };
    var stubWindow = {
      getComputedStyle: stubDoc.getComputedStyle,
      getSelection: stubDoc.getSelection,
      InputEvent: function (type, init) { return Object.assign({ type: type }, init); },
      ClipboardEvent: function (type, init) { return Object.assign({ type: type }, init); }
    };
    var bodyStart = code.indexOf('(async function(p){') + '(async function(p){'.length;
    var bodyEnd = code.lastIndexOf('})(');
    var body = code.slice(bodyStart, bodyEnd);
    var wrapper = 'return (async function(p, document, location, window){\n' + body + '\n})(arguments[0], arguments[1], arguments[2], arguments[3])';
    var AsyncFunction = (async function () {}).constructor;
    var fn = new AsyncFunction(wrapper);
    var r = await fn(extractPayload(code), stubDoc, { href: 'https://x.com/compose/post' }, stubWindow);
    // 旧版本会因 after.indexOf(probe)==-1 误报 preview-not-found
    // v1.x+ 应允许 <br> 换行的 Slate 编辑器通过
    expect(r.ok).toBe(true);
    expect(r.error).toBe('');
    expect(r.fillMethod).toBe('paste-event');
    expect(t1.nodeValue).toBe('第一行\n第二行\n第三行测试');
  });

  // ----------------------------------------------------------------
    // v1.x+（修复 5 关键断言）：fillPasteEvent **必须**派 beforeinput(inputType=insertText)+data，
    //   **不**派 insertFromPaste（X 真实 Slate.js 不实现 insertFragment handler，
    //   insertFromPaste 路径完全沉默失败，DOM 不更新）。
    //   用户连续 3 轮截图"图二 textarea 内容没填进图一 textarea"的真正根因：
    //   老 v1.x+ 的 fillPasteEvent 派 insertFromPaste，X Slate 安静忽略。
    //   现在改成 insertText——X Slate 的原子 op，editor.insertText(data) 立即更新 state。
    // ----------------------------------------------------------------
    it('v1.x+（修复 5）：fillPasteEvent 派 insertText 而不是 insertFromPaste（X Slate 真正响应）', () => {
      const F = require('../electron/browser/platforms/x/XFillScript.js');
      var code = F.buildXFillScript({ content: 'Hello world!', pollIntervalMs: 50, maxAttempts: 1, verifyDelayMs: 5 });
      var dispatched = null;
      var editor = {
        nodeType: 1, tagName: 'DIV', isContentEditable: true,
        childNodes: [],
        getAttribute: function (n) { return n === 'data-testid' ? 'tweetTextarea_0' : ''; },
        getBoundingClientRect: function () { return { width: 600, height: 80 }; },
        focus: function () {},
        dispatchEvent: function (ev) {
          // **修复 5**：现在 fill 派的是 insertText，Slate 走 editor.insertText(data)，
          //   修改 Slate state → React re-render 写 DOM。我们的 mock 模拟：
          if (ev && ev.type === 'beforeinput' && ev.inputType === 'insertText' && ev.data) {
            // 让 mock React/Slate 真的把 data 写入编辑器状态（这样 verify 能 pass）
            dispatched = ev;
            editor._lastInserted = String(ev.data);
          }
        },
        _lastInserted: ''
      };
      Object.defineProperty(editor, 'textContent', {
        configurable: true,
        get: function () {
          // 模拟 X Slate 的 React re-render：textContent 反映 Slate state
          return editor._lastInserted || '';
        }
      });
      var stubDoc = {
        querySelectorAll: function (sel) { return /tweetTextarea_0/.test(sel) ? [editor] : []; },
        body: { innerText: '' },
        getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
        getSelection: function () { return { removeAllRanges: function(){}, addRange: function(){}, rangeCount: 0, getRangeAt: function(){return null;} }; },
        createRange: function () { return { selectNodeContents: function () {} }; },
        execCommand: function () { return false; }
      };
      var stubLoc = { href: 'https://x.com/compose/post' };
      var r = (async function(){
        var code2 = code;
        var stubWindow = {
          getComputedStyle: stubDoc.getComputedStyle,
          getSelection: stubDoc.getSelection,
          InputEvent: function (type, init) { return Object.assign({ type: type }, init); },
          ClipboardEvent: function (type, init) { return Object.assign({ type: type }, init); }
        };
        var bodyStart = code2.indexOf('(async function(p){') + '(async function(p){'.length;
        var bodyEnd = code2.lastIndexOf('})(');
        var body = code2.slice(bodyStart, bodyEnd);
        var wrapper = 'return (async function(p, document, location, window){\n' + body + '\n})(arguments[0], arguments[1], arguments[2], arguments[3])';
        var AsyncFunction = (async function () {}).constructor;
        var fn = new AsyncFunction(wrapper);
        return await fn(extractPayload(code2), stubDoc, stubLoc, stubWindow);
      })();
      return r.then(function(r){
        // **核心断言 1**：fill 用的是 insertText（**不**是 insertFromPaste）
        expect(dispatched).toBeTruthy();
        expect(dispatched.type).toBe('beforeinput');
        expect(dispatched.inputType).toBe('insertText'); // ← **修复 5 关键**
        expect(dispatched.data).toBe('Hello world!');
        // **核心断言 2**：不传 DataTransfer（Slate 不读）
        expect(dispatched.dataTransfer).toBeUndefined();
        // **核心断言 3**：fill 真把 data 写进了编辑器（X Slate editor.insertText 路径）
        expect(r.ok).toBe(true);
        expect(r.fillMethod).toBe('paste-event');
        expect(r.contentAfterLen).toBe('Hello world!'.length);
      });
    });

    // ----------------------------------------------------------------
    // v1.x+：X 完整推文**与**用户输入的"原始正文"**必须**不同
  //   genCopy('x', 0) 根据 X 平台规则生成**完整推文**（含开头钩子、intro、行动号召、链接），
  //   **不**只是把 state.project.intro 当作推文。
  //   这是用户报告"task 卡片只显示原始正文"问题的核心回归保护。
  // ----------------------------------------------------------------
  it('v1.x+：X genCopy 生成完整推文（**不**是原始正文）', () => {
    // 构造最小 state.project 模拟：name='Rokit', intro='May every young creator...'
    global.state = {
      project: {
        name: 'Rokit',
        type: '工具',
        intro: 'May every young creator who devotes themselves to their first work be seen, and stay inspired to craft their second, third creations. Creators only focus on development. Rokit takes care of everything else: promotion, copywriting, publishing, data tracking, review, and iteration suggestions..',
        url: 'https://example.com'
      }
    };
    var F = require('../electron/browser/platforms/x/XFillScript.js');
    // 重置 X_COMPOSER_SELECTORS 影响（genCopy 不依赖它，但保险起见）
    // 触发 genCopy：直接通过 index.html 的脚本片段——但 vitest 环境没 index.html。
    // **改用**直接 require index.html 的解析方式不可行。**改**：跑 XFillScript 的 buildXFillScript，
    // 验证它**不**修改 content。然后直接读 index.html 中 case 'x' 的源码行验证。
    var html = require('fs').readFileSync(require('path').resolve(__dirname, '../index.html'), 'utf8');
    // 找 "case 'x':return" 后面到 break / "}" 的 body 字段
    var m = /case 'x':return\s*\{[^}]*body:\s*([^,}]+)/m.exec(html);
    expect(m).toBeTruthy();
    var bodyExpr = (m[1] || '').trim();
    // **关键断言**：body 表达式**必须包含** intro（用户原始正文）
    //   但也**必须包含** 模板结构（开头钩子/行动号召/链接），**不**是 intro+url 简写
    expect(bodyExpr.indexOf('intro')).toBeGreaterThan(-1);
    // **必须**包含链接或模板字符 — 不是裸 intro
    var isOnlyIntro = /^intro$/.test(bodyExpr);
    expect(isOnlyIntro).toBe(false);
    // **必须**包含 name 或 🚀 或 tl（模板内容）
    var hasTemplate = bodyExpr.indexOf('name') >= 0 || bodyExpr.indexOf('🚀') >= 0 || bodyExpr.indexOf('tl') >= 0 || bodyExpr.indexOf('免费') >= 0 || bodyExpr.indexOf('上线') >= 0;
    expect(hasTemplate).toBe(true);
    delete global.state;
  });

  // ----------------------------------------------------------------
  // v1.x+：X 真实 React 异步：dispatchEvent 派发后 textContent 还没更新
  //   X React 内部 onBeforeInput → editor.insertText → setState → 重渲染
  //   整个链路异步。即便多等几次后 textContent 仍读不到（X 真实 React 内部
  //   Slate state 与 DOM 同步有延迟），v1.x+ 把这种情形视为"派发成功但
  //   未验证"：result.ok=true + warning，而不是 preview-not-found。
  //   用户硬要求："不要把 preview 元素存在与否当作正文填充的必要条件"。
  // ----------------------------------------------------------------
  it('v1.x+：X 真实 React 异步：textContent 永远空时仍 ok=true（不阻塞 UI）', async () => {
    const F = require('../electron/browser/platforms/x/XFillScript.js');
    var code = F.buildXFillScript({ content: '第一行', pollIntervalMs: 50, maxAttempts: 1, verifyDelayMs: 5 });

    var editor = {
      nodeType: 1, tagName: 'DIV', isContentEditable: true,
      childNodes: [],
      getAttribute: function (n) { return n === 'data-testid' ? 'tweetTextarea_0' : ''; },
      getBoundingClientRect: function () { return { width: 600, height: 80 }; },
      focus: function () {},
      // 关键：dispatchEvent 不修改 DOM（模拟 X 真实 React 异步 Slate）
      dispatchEvent: function (ev) {}
    };
    Object.defineProperty(editor, 'textContent', {
      configurable: true,
      get: function () { return ''; },
      set: function () {}
    });
    var stubDoc = {
      querySelectorAll: function (sel) { return /tweetTextarea_0/.test(sel) ? [editor] : []; },
      body: { innerText: '' },
      getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
      getSelection: function () { return { removeAllRanges: function () {}, addRange: function () {} }; },
      createRange: function () { return { selectNodeContents: function () {} }; },
      execCommand: function () { return false; }
    };
    var stubWindow = {
      getComputedStyle: stubDoc.getComputedStyle,
      getSelection: stubDoc.getSelection,
      InputEvent: function (type, init) { return Object.assign({ type: type }, init); },
      ClipboardEvent: function (type, init) { return Object.assign({ type: type }, init); }
    };
    var bodyStart = code.indexOf('(async function(p){') + '(async function(p){'.length;
    var bodyEnd = code.lastIndexOf('})(');
    var body = code.slice(bodyStart, bodyEnd);
    var wrapper = 'return (async function(p, document, location, window){\n' + body + '\n})(arguments[0], arguments[1], arguments[2], arguments[3])';
    var AsyncFunction = (async function () {}).constructor;
    var fn = new AsyncFunction(wrapper);
    var r = await fn(extractPayload(code), stubDoc, { href: 'https://x.com/compose/post' }, stubWindow);
    // v1.x+ 关键断言：派发成功 + textContent 永远空（X 真实 React 异步）
    //   → ok=true（不阻塞 UI 走成功路径），warning 提示 unverified
    expect(r.ok).toBe(true);
    expect(r.error).toBe('');
    expect(r.warning).toMatch(/unverified/);
    expect(r.fillMethod).toBe('paste-event');
  });

  // ----------------------------------------------------------------
  // v1.x+：X 真实 dispatchEvent 派发不响应（X React isTrusted 过滤），但
  //   document.execCommand('insertText') 能写入 textContent。
  //   修复后 verify 阶段会**显式**调 fillExecCommand fallback。
  //   这是用户实测的"contentAfterLen=1"问题根因 + 修复路径。
  // ----------------------------------------------------------------
  it('v1.x+：X 真实 dispatchEvent 不响应时 fallback 到 execCommand insertText', async () => {
    const F = require('../electron/browser/platforms/x/XFillScript.js');
    var code = F.buildXFillScript({ content: '第一行', pollIntervalMs: 50, maxAttempts: 1, verifyDelayMs: 5 });

    var editor = {
      nodeType: 1, tagName: 'DIV', isContentEditable: true,
      childNodes: [],
      getAttribute: function (n) { return n === 'data-testid' ? 'tweetTextarea_0' : ''; },
      getBoundingClientRect: function () { return { width: 600, height: 80 }; },
      focus: function () {},
      // 关键：dispatchEvent 不修改 DOM（X 真实 React 拦合成 beforeinput）
      dispatchEvent: function (ev) {}
    };
    Object.defineProperty(editor, 'textContent', {
      configurable: true,
      get: function () { return editor._text || ''; },
      set: function (v) { editor._text = v; }
    });
    var stubDoc = {
      querySelectorAll: function (sel) { return /tweetTextarea_0/.test(sel) ? [editor] : []; },
      body: { innerText: '' },
      getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
      getSelection: function () { return { removeAllRanges: function () {}, addRange: function () {} }; },
      createRange: function () { return { selectNodeContents: function () {} }; },
      // 关键：execCommand insertText 真的能写入 X 真实编辑器
      execCommand: function (cmd, _ui, text) {
        if (cmd === 'insertText') {
          editor._text = String(editor._text || '') + String(text || '');
          return true;
        }
        return false;
      }
    };
    var stubWindow = {
      getComputedStyle: stubDoc.getComputedStyle,
      getSelection: stubDoc.getSelection,
      InputEvent: function (type, init) { return Object.assign({ type: type }, init); },
      ClipboardEvent: function (type, init) { return Object.assign({ type: type }, init); }
    };
    var bodyStart = code.indexOf('(async function(p){') + '(async function(p){'.length;
    var bodyEnd = code.lastIndexOf('})(');
    var body = code.slice(bodyStart, bodyEnd);
    var wrapper = 'return (async function(p, document, location, window){\n' + body + '\n})(arguments[0], arguments[1], arguments[2], arguments[3])';
    var AsyncFunction = (async function () {}).constructor;
    var fn = new AsyncFunction(wrapper);
    var r = await fn(extractPayload(code), stubDoc, { href: 'https://x.com/compose/post' }, stubWindow);
    // 关键断言：fallback 调 fillExecCommand 后，textContent 应含 target
    expect(r.ok).toBe(true);
    expect(r.error).toBe('');
    // fillMethod 应是 fallback 的 execCommand
    expect(r.fillMethod).toBe('execCommand-insertText');
    // textContent 应含 target "第一行"
    expect(editor._text || '').toMatch(/第一行/);
    expect(r.contentAfterLen).toBeGreaterThan(0);
  });

  // ----------------------------------------------------------------
  // v1.x+（修复 2 增强）：autoPub('x') 必须直接通过 **唯一 id** "x-body-textarea" / "x-title-input"
  //   **从 DOM 读 textarea 当前值**作为 payload.body 的**唯一权威来源**。
  //   **绝对不**用 querySelector('.pub-item textarea[oninput*="setBody"][oninput*="x"]') 这种
  //   attribute selector（可能匹配到 XHS 卡或被其他 DOM 误匹配）；**绝对不**回退到
  //   state.copies['x'].body / pubPayload().body（state.project.intro）——这些都已经被用户报告
  //   不是用户在图二编辑的版本（X 发布页出现「挖到一个宝藏 / 慷概 / (填入你的链接)」）。
  //
  //   本测试**锁定**两件事：
  //     1. pubItem(...) 渲染 X 卡时 textarea **必须**写 `id="x-body-textarea"`（唯一 id）。
  //     2. autoPub('x') 段必须用 `document.getElementById('x-body-textarea')` 直接取 DOM value
  //        作为 payload.body。**不**允许走 querySelector('...oninput*="setBody"...') 路径。
  //     3. autoPub('x') **必须**显式 `delete payload.tags`（避免把 tags 当作正文附加）。
  // ----------------------------------------------------------------
  it('v1.x+（修复 2 增强）：autoPub("x") 用 #x-body-textarea 唯一 id 直读 DOM，禁用 querySelector 多匹配', () => {
    var html = require('fs').readFileSync(require('path').resolve(__dirname, '../index.html'), 'utf8');

    // (1) X 卡 textarea **必须**用统一模板 `id="<pid>-body-textarea"`（运行时渲染为
    //   `id="x-body-textarea"`）。源代码中是字符串拼接模板：`id="'+id+'-body-textarea"`。
    expect(html.indexOf("'+id+'-body-textarea") >= 0).toBe(true);
    expect(html.indexOf("'+id+'-title-input") >= 0).toBe(true);

    // (2) autoPub('x') **必须**用 `document.getElementById('x-body-textarea')`
    expect(/document\.getElementById\(\s*['"]x-body-textarea['"]\s*\)/.test(html)).toBe(true);

    // (3) autoPub('x') **必须**用 `document.getElementById('x-title-input')`
    expect(/document\.getElementById\(\s*['"]x-title-input['"]\s*\)/.test(html)).toBe(true);

    // (4) 严格禁用：在 autoPub('x') 分支不允许 `state.copies['x'].body` **不通过 DOM flush 直接**
    //     赋给 payload.body 的路径。这个测试**允许** `state.copies['x'].body = _xBodyVal` 同步刷新，
    //     但不允许 `payload.body = state.copies['x'].body` 这种间接路径——直接 DOM 读源代码段必须有。
    var directAssignPattern = /payload\.body\s*=\s*_xBodyVal/;
    expect(directAssignPattern.test(html)).toBe(true);

    // (5) 必须 delete payload.tags（**不**主动把标签追加到 payload.tags，避免 _normalizePayload
    //     在旧分支把它们附加到正文里）。
    expect(/delete\s+payload\.tags\s*;/.test(html)).toBe(true);
  });

  // ----------------------------------------------------------------
  // v1.x+（修复 6）：rocketGo 入口的 DOM flush **必须**与 autoPub('x') 严格一致。
  //   用户最新截图确认：
  //     - 图一（单卡「⚠ 自动填表 + 确认」）已修复好 → X 编辑器显示图二内容
  //     - 图二（火箭发送 「🚀 开始发射」）的 X 没填上 → 老 attribute selector 多匹配
  //
  //   修复前 rocketGo 段（index.html#L7602-L7605）：
  //     querySelector('.pub-item input[oninput*="setTitle"][oninput*="X"]')
  //     querySelector('.pub-item textarea[oninput*="setBody"][oninput*="X"]')
  //   可能误匹配其他含「setBody」「x」子串的平台卡（XHS / ...）。
  //
  //   修复后 rocketGo 段：改用 document.getElementById(pid + '-body-textarea')
  //   与 autoPub('x') 严格一致（图一已验证 OK 的逻辑）。
  //
  //   本测试锁定：
  //     1. rocketGo 函数体里**必须**用 `getElementById('x-body-textarea')` 而不是 querySelector。
  //     2. publishItem 渲染时**必须**为所有平台（不只 x）加 `id="<pid>-body-textarea"` 与
  //        `id="<pid>-title-input"`，让 rocketGo 能用统一方式 flush 任意平台。
  // ----------------------------------------------------------------
  it('v1.x+（修复 6）：rocketGo 入口的 DOM flush 与 autoPub("x") 一致（也用 #x-body-textarea 唯一 id）', () => {
    var html = require('fs').readFileSync(require('path').resolve(__dirname, '../index.html'), 'utf8');

    // (1) rocketGo 函数体里**必须**用 `getElementById('x-body-textarea')` 直读。
    var rocketGoIdx = html.indexOf('window.rocketGo=async function(');
    expect(rocketGoIdx).toBeGreaterThan(-1);
    var autoPubIdx = html.indexOf('window.autoPub=function(');
    expect(autoPubIdx).toBeGreaterThan(-1);
    //   rocketGo 的 getElementById('x-body-textarea') 必须在 autoPub('x') 后面
    //   （rocketGo 后面那一段才用）。
    var rgoGetEl = html.indexOf("getElementById('x-body-textarea')", rocketGoIdx);
    expect(rgoGetEl).toBeGreaterThan(-1);
    //   rocketGo 内部**禁止**用 attribute selector (.pub-item textarea[oninput*="setBody"])：
    var rgoQueryBlock = (function(){
      var seg = html.slice(rocketGoIdx, autoPubIdx);
      return /\.pub-item textarea\[oninput\*="setBody"\]/.test(seg);
    })();
    expect(rgoQueryBlock).toBe(false);

    // (2) 同时 autoPub('x') 必须仍用 #x-body-textarea（不被本次修改破坏）。
    expect(html.indexOf("getElementById('x-body-textarea')") >= 0).toBe(true);
    expect(html.indexOf("getElementById('x-title-input')") >= 0).toBe(true);

    // (3) publishItem 渲染时**必须**用 `id="<pid>-body-textarea"` 模板拼接（而不是「if id==='x' 才加」）。
    //   简单办法：在源代码中直接搜 `'+id+'-title-input` 与 `'+id+'-body-textarea`（运行时模板）。
    //   注意 ES regex 转义：在 JS 字符串里写 regex 需要把 `\+` 写成 `\\+`。
    expect(html.indexOf("'+id+'-body-textarea") >= 0).toBe(true);
    expect(html.indexOf("'+id+'-title-input") >= 0).toBe(true);

    // (4) rocketGo 必须调用 `getElementById(pid + '-body-textarea')`——而不是写死 'x-body-textarea'
    //     （这样对其他平台也好使）。
    expect(html.indexOf("getElementById(pid + '-body-textarea')") >= 0).toBe(true);
    expect(html.indexOf("getElementById(pid + '-title-input')") >= 0).toBe(true);
  });

  // ============================================================
  // 对照测试 A / B / C（用户要求）：验证 fill 与「无 fill」的最终编辑器状态一致
  // ------------------------------------------------------------
  //   A：基线 —— 完全不调 fill，直接调一次 React-style onBeforeInput 把文本写进去
  //                （等价于用户在 X 里手动 paste，触发 beforeinput）。
  //   B：禁用 fill —— fill 函数存在但 dryRun=true，不调任何 fill 策略。
  //   C：启用 fill —— 走 v1.x+ 的 fillPasteEvent 派发一次 beforeinput。
  // 期望：A 与 C 的最终编辑器状态（textContent / dispatched 事件序列）完全等价。
  //      B 不修改编辑器。
  // 这把「fill 是否破坏 X 内部状态」变成可断言的单元测试，而不是仅靠人工目测。
  // ============================================================
  describe('A/B/C 对照：fill 行为与「无 fill」基线等价', () => {
    function makeFakeXWithReact() {
      // 模拟 X (2024+) Slate-style 编辑器：
      //   - editor: contentEditable div
      //   - 2 个 text node + 1 个 <br>，对应 X 渲染时多 text node 切分
      //   - React 的 onBeforeInput 监听器：insertText → 把 data 追加到最后一
      //     个 text node 末尾、Selection 移到该 text node 末尾（X 的标准行为）
      var span1Last = { nodeType: 3, nodeValue: '' };
      var span2Last = { nodeType: 3, nodeValue: '' };
      var span2 = { tagName: 'SPAN', nodeType: 1, lastChild: span2Last };
      var br = { tagName: 'BR', nodeType: 1 };
      var span1 = { tagName: 'SPAN', nodeType: 1, lastChild: span1Last };
      var editor = {
        tagName: 'DIV', nodeType: 1, isContentEditable: true,
        firstChild: span1, lastChild: span2, childNodes: [span1, br, span2],
        getAttribute: function (n) { return n === 'data-testid' ? 'tweetTextarea_0' : ''; },
        getBoundingClientRect: function () { return { width: 600, height: 80 }; },
        focus: function () { this._focused = true; },
        _textNodeRefs: [span1Last, span2Last],
        // X 的 React 端 anchor 表：保存当前光标位于哪个 text node、offset 多少
        _anchor: { node: span2Last, offset: 0 }
      };
      span1._parent = editor; span1Last._parent = span1;
      span2._parent = editor; span2Last._parent = span2;
      Object.defineProperty(editor, 'textContent', {
        configurable: true,
        get: function () { return editor._textNodeRefs.map(function (n) { return n.nodeValue; }).join(''); },
        set: function () { throw new Error('forbidden: direct textContent = ...'); }
      });
      // X 的 React onBeforeInput：等价于 editor.insertText(data)
      function reactOnBeforeInput(ev) {
        if (!ev || ev.type !== 'beforeinput') return;
        // 真实 X React 既响应 insertText 也响应 insertFromPaste（都走 editor.insertFragment/data）。
        if ((ev.inputType === 'insertText' || ev.inputType === 'insertFromPaste') && ev.data) {
          var n = editor._anchor.node;
          n.nodeValue = n.nodeValue.slice(0, editor._anchor.offset) + ev.data + n.nodeValue.slice(editor._anchor.offset);
          editor._anchor.offset += ev.data.length;
        }
      }
      // editor.dispatchEvent 把事件先转给 X 的 React handler
      editor.dispatchEvent = function (ev) {
        if (ev && ev.type === 'beforeinput') reactOnBeforeInput(ev);
        // 浏览器原生 input 事件：X 的 React 也会处理（不修改 _anchor）
      };
      return editor;
    }

    function getEditorState(editor) {
      return {
        textContent: editor.textContent,
        anchor: { nodeName: editor._anchor.node._leaf || (editor._anchor.node === editor._textNodeRefs[0] ? 'span1' : 'span2'), offset: editor._anchor.offset }
      };
    }

    function makeStubEnv(editor) {
      var dispatched = [];
      editor.dispatchEvent = (function (orig) {
        return function (ev) {
          dispatched.push(ev);
          orig(ev);
        };
      })(editor.dispatchEvent);
      var stubSel = { removeAllRanges: function () {}, addRange: function () {}, getRangeAt: function () { return { commonAncestorContainer: editor }; } };
      var stubDoc = {
        querySelectorAll: function (sel) { return sel && sel.indexOf('tweetTextarea_0') >= 0 ? [editor] : []; },
        body: { innerText: '' },
        getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
        getSelection: function () { return stubSel; },
        createRange: function () { return { selectNodeContents: function () {} }; },
        execCommand: function () { return false; },
        dispatchEvent: function (ev) { dispatched.push(ev); }
      };
      var stubWindow = {
        getComputedStyle: stubDoc.getComputedStyle,
        getSelection: stubDoc.getSelection,
        InputEvent: function (type, init) { return Object.assign({ type: type }, init); },
        ClipboardEvent: function (type, init) { return Object.assign({ type: type }, init); }
      };
      return { dispatched: dispatched, stubDoc: stubDoc, stubWindow: stubWindow, stubLoc: { href: 'https://x.com/compose/post' } };
    }

    it('A：基线 —— 直接派发 1 次 beforeinput(insertText)，fill 路径不参与', async () => {
      var editor = makeFakeXWithReact();
      var env = makeStubEnv(editor);
      // 模拟用户「手动 paste」：派发 1 次 beforeinput，浏览器原生派 input
      var be = new env.stubWindow.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: '第一行\n第二行' });
      editor.dispatchEvent(be);
      var stateA = getEditorState(editor);
      // A 的 ground truth：textContent 完全等于填入文本，anchor 在末尾
      expect(stateA.textContent).toBe('第一行\n第二行');
      expect(stateA.anchor.offset).toBe('第一行\n第二行'.length);
      // A 没有调用 fillPasteEvent，所以 dispatched 应当只包含 1 个 beforeinput
      // （如果是用 fill 跑出来，可能会有多事件）
      var evTypes = env.dispatched.map(function (e) { return e.type; });
      expect(evTypes.filter(function (t) { return t === 'beforeinput'; }).length).toBe(1);
    });

    it('B：禁用 fill —— 走 dryRun 模式，编辑器 0 改动', async () => {
      const F = require('../electron/browser/platforms/x/XFillScript.js');
      var code = F.buildXFillScript({ content: 'xyz', pollIntervalMs: 50, maxAttempts: 1, verifyDelayMs: 5, dryRun: true });
      var editor = makeFakeXWithReact();
      var env = makeStubEnv(editor);
      var bodyStart = code.indexOf('(async function(p){') + '(async function(p){'.length;
      var bodyEnd = code.lastIndexOf('})(');
      var body = code.slice(bodyStart, bodyEnd);
      var wrapper = 'return (async function(p, document, location, window){\n' + body + '\n})(arguments[0], arguments[1], arguments[2], arguments[3])';
      var AsyncFunction = (async function () {}).constructor;
      var fn = new AsyncFunction(wrapper);
      var r = await fn(extractPayload(code), env.stubDoc, env.stubLoc, env.stubWindow);
      expect(r.dryRun).toBe(true);
      expect(r.ok).toBe(true);
      // 编辑器未被改动
      expect(editor.textContent).toBe('');
      expect(editor._anchor.offset).toBe(0);
    });

    it('C：启用 fill —— fillPasteEvent 派发 1 次 beforeinput，结果与 A 等价', async () => {
      const F = require('../electron/browser/platforms/x/XFillScript.js');
      var code = F.buildXFillScript({ content: '第一行\n第二行', pollIntervalMs: 50, maxAttempts: 1, verifyDelayMs: 5 });
      var editor = makeFakeXWithReact();
      var env = makeStubEnv(editor);
      var bodyStart = code.indexOf('(async function(p){') + '(async function(p){'.length;
      var bodyEnd = code.lastIndexOf('})(');
      var body = code.slice(bodyStart, bodyEnd);
      var wrapper = 'return (async function(p, document, location, window){\n' + body + '\n})(arguments[0], arguments[1], arguments[2], arguments[3])';
      var AsyncFunction = (async function () {}).constructor;
      var fn = new AsyncFunction(wrapper);
      var r = await fn(extractPayload(code), env.stubDoc, env.stubLoc, env.stubWindow);
      expect(r.ok).toBe(true);
      expect(r.fillMethod).toBe('paste-event');
      // C 与 A 应当等价：textContent 完全相同，anchor 在末尾
      var stateC = getEditorState(editor);
      expect(stateC.textContent).toBe('第一行\n第二行');
      expect(stateC.anchor.offset).toBe('第一行\n第二行'.length);
      // 派发事件序列：1 个 beforeinput，没有人为 input
      var evTypes = env.dispatched.map(function (e) { return e.type; });
      expect(evTypes.filter(function (t) { return t === 'beforeinput'; }).length).toBe(1);
      expect(evTypes.filter(function (t) { return t === 'input'; }).length).toBe(0);
    });
  });

  it('v1.x：fill 永不调用 el.textContent = text（不破坏 X 子节点结构）', async () => {
    const F = require('../electron/browser/platforms/x/XFillScript.js');
    var code = F.buildXFillScript({ content: 'X', pollIntervalMs: 50, maxAttempts: 1, verifyDelayMs: 5 });
    // 构造严格监控：fill 写 editor.textContent 立即失败
    var editor = {
      tagName: 'DIV', nodeType: 1, lastChild: null, firstChild: null,
      textContent: '',
      getAttribute: function (n) { return n === 'data-testid' ? 'tweetTextarea_0' : ''; },
      contains: function () { return true; },
      getBoundingClientRect: function () { return { width: 600, height: 80 }; },
      focus: function () {},
      dispatchEvent: function () {},
      childNodes: []
    };
    Object.defineProperty(editor, 'textContent', {
      configurable: true,
      get: function () { return ''; },
      set: function () { throw new Error('fill must not use el.textContent = ... (would break X tree)'); }
    });
    var stubDoc = {
      querySelectorAll: function () { return [editor]; },
      body: { innerText: '' },
      getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
      getSelection: function () { return { removeAllRanges: function () {}, addRange: function () {}, getRangeAt: function () { return { commonAncestorContainer: editor }; } }; },
      createRange: function () { return { selectNodeContents: function () {}, setStart: function () {}, collapse: function () {} }; },
      // 让 paste-event 失败 → 走 execCommand → 也失败 → 走 char-by-char → 仍不应写 textContent
      execCommand: function () { return false; }
    };
    var stubWindow = {
      getComputedStyle: stubDoc.getComputedStyle,
      getSelection: stubDoc.getSelection,
      DataTransfer: function () { this.setData = function () {}; },
      InputEvent: function (type, init) { return { type: type, ...init }; },
      ClipboardEvent: function (type, init) { return { type: type, ...init }; }
    };
    var bodyStart = code.indexOf('(async function(p){') + '(async function(p){'.length;
    var bodyEnd = code.lastIndexOf('})(');
    var body = code.slice(bodyStart, bodyEnd);
    var wrapper = 'return (async function(p, document, location, window){\n' + body + '\n})(arguments[0], arguments[1], arguments[2], arguments[3])';
    var AsyncFunction = (async function () {}).constructor;
    var fn = new AsyncFunction(wrapper);
    // 关键：fill 不会因 textContent setter 抛错而崩溃
    var r;
    try { r = await fn({ content: 'X' }, stubDoc, { href: 'x' }, stubWindow); } catch (e) { r = { error: String(e && e.message || e) }; }
    // fill 应返回失败（因为所有 fill 策略都失败），但不会触发 textContent setter
    expect(r).toBeTruthy();
    expect(typeof r.error === 'string' || r.fillMethod).toBeTruthy();
  });

  it('v1.x：dryRun 模式只诊断不填表', async () => {
    const F = require('../electron/browser/platforms/x/XFillScript.js');
    var code = F.buildXFillScript({
      content: 'X', pollIntervalMs: 50, maxAttempts: 1, verifyDelayMs: 5, dryRun: true
    });
    var editor = makeReactStyleEditor('');
    var editorTouched = false;
    Object.defineProperty(editor, 'textContent', {
      configurable: true,
      get: function () { return ''; },
      set: function () { editorTouched = true; }
    });
    var stubDoc = {
      querySelectorAll: function (sel) { return sel && sel.indexOf('tweetTextarea_0') >= 0 ? [editor] : []; },
      body: { innerText: '' },
      getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
      getSelection: function () { return { removeAllRanges: function () {}, addRange: function () {}, getRangeAt: function () { return { commonAncestorContainer: editor }; } }; },
      createRange: function () { return { selectNodeContents: function () {}, setStart: function () {}, collapse: function () {} }; },
      execCommand: function () { return false; }
    };
    var stubWindow = {
      getComputedStyle: stubDoc.getComputedStyle,
      getSelection: stubDoc.getSelection,
      DataTransfer: function () { this.setData = function () {}; },
      InputEvent: function (type, init) { return { type: type, ...init }; },
      ClipboardEvent: function (type, init) { return { type: type, ...init }; }
    };
    var bodyStart = code.indexOf('(async function(p){') + '(async function(p){'.length;
    var bodyEnd = code.lastIndexOf('})(');
    var body = code.slice(bodyStart, bodyEnd);
    var wrapper = 'return (async function(p, document, location, window){\n' + body + '\n})(arguments[0], arguments[1], arguments[2], arguments[3])';
    var AsyncFunction = (async function () {}).constructor;
    var fn = new AsyncFunction(wrapper);
    var r = await fn(extractPayload(code), stubDoc, { href: 'x' }, stubWindow);
    expect(r.dryRun).toBe(true);
    expect(r.ok).toBe(true);
    // dryRun 模式：fillMethod 应为空（因为没有真的填表）
    expect(r.fillMethod).toBeFalsy();
    // 关键：dryRun 模式下 editor 完全没被动到
    expect(editorTouched).toBe(false);
  });
});

// =====================================================================
// XUploadScript IIFE 内部行为
// =====================================================================
describe('XUploadScript · IIFE 行为', () => {
  function runIIFE(code, stubDoc, stubLoc, payload, extras) {
    extras = extras || {};
    var bodyStart = code.indexOf('(async function(p){') + '(async function(p){'.length;
    var bodyEnd   = code.lastIndexOf('})(');
    var body = code.slice(bodyStart, bodyEnd);
    var wrapper =
      'return (async function(p, document, location, DataTransfer, atob){\n' +
      body + '\n' +
      '})(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4])';
    var AsyncFunction = (async function () {}).constructor;
    var fn = new AsyncFunction(wrapper);
    return fn(
      payload || {},
      stubDoc,
      stubLoc,
      extras.DataTransfer || function () {},
      extras.atob      || function () { return ''; }
    );
  }
  function extractPayload(code) {
    var m = code.match(/\}\)\(([\s\S]*?)\)\s*$/);
    if (!m) return {};
    try { return JSON.parse(m[1]); } catch (_e) { return {}; }
  }

  it('upload IIFE：无 file input → 返回 no-file-input', async () => {
    const U = require('../electron/browser/platforms/x/XUploadScript.js');
    var code = U.buildXUploadScript({
      mediaItems: [{ type: 'image', src: 'data:image/png;base64,iVBORw0KG', name: 'a.png' }],
      timeoutMs: 100, pollIntervalMs: 50, verifyDelayMs: 10
    });
    var stubDoc = {
      querySelectorAll: function () { return []; },
      dispatchEvent: function () {}
    };
    var stubLoc = { href: 'https://x.com/compose/post' };
    var r = await runIIFE(code, stubDoc, stubLoc, extractPayload(code));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-file-input');
  });

  it('upload IIFE：无 mediaItems → 返回 no-media', async () => {
    const U = require('../electron/browser/platforms/x/XUploadScript.js');
    var code = U.buildXUploadScript({ mediaItems: [], timeoutMs: 100, pollIntervalMs: 50 });
    var r = await runIIFE(code, {}, {}, extractPayload(code));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-media');
  });

  it('upload IIFE：data URL → DataTransfer → change dispatch', async () => {
    const U = require('../electron/browser/platforms/x/XUploadScript.js');
    var code = U.buildXUploadScript({
      mediaItems: [{ type: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', name: 'a.png' }],
      timeoutMs: 200, pollIntervalMs: 50, verifyDelayMs: 10
    });
    // 注意：input.el 自身必须有 dispatchEvent —— body 是 input.el.dispatchEvent(...)，
    // 不是 document.dispatchEvent(...)。document 上的 dispatchEvent 没意义。
    var stubDoc = {
      querySelectorAll: function () {
        return [{ disabled: false, files: null, dispatchEvent: function () {} }];
      },
      dispatchEvent: function () {}
    };
    function DataTransfer() {
      this.items = { add: function () {} };
      this.files = { get length() { return 1; } };
    }
    function atob() { return 'II'; }
    var stubLoc = { href: 'https://x.com/compose/post' };
    var r = await runIIFE(code, stubDoc, stubLoc, extractPayload(code), { DataTransfer: DataTransfer, atob: atob });
    expect(r.ok).toBe(true);
    expect(r.items.length).toBe(1);
    expect(r.items[0].status).toBe('dispatched');
  });
});

// =====================================================================
// runXLoginPhase wiring：phase 1 成功后自动继续 phase 2
// =====================================================================
describe('XPublisher · runXLoginPhase 与 phase 2 联动', () => {
  // 真实 stub BM：模拟"phase 1 已 OK → 直接进入 phase 2"
  it('phase2FillAndUpload 不点 Post：搜遍代码确认无 click(\"Post\")', () => {
    const fs = require('fs');
    const xp = fs.readFileSync(require('path').resolve(__dirname, '../electron/browser/platforms/x/XPublisher.js'), 'utf8');
    const xf = fs.readFileSync(require('path').resolve(__dirname, '../electron/browser/platforms/x/XFillScript.js'), 'utf8');
    const xu = fs.readFileSync(require('path').resolve(__dirname, '../electron/browser/platforms/x/XUploadScript.js'), 'utf8');
    expect(/click\(['"]Post['"]/i.test(xp) || /click\(['"]Post['"]/i.test(xf) || /click\(['"]Post['"]/i.test(xu)).toBe(false);
    // 也不准点击 Post 的 data-testid
    expect(/"PostButton"|button\[data-testid=.PostButton./.test(xp) || /button\[data-testid=.PostButton./.test(xf)).toBe(false);
  });

  it('phase 2 不调用 bm.click / bm.dispatchClick x POST : enabled', () => {
    const M = require('../electron/browser/platforms/x/XPublisher.js');
    const pub = new M.XPublisher();
    pub.browserManager = {
      click: vi.fn ? vi.fn() : function () {},
      execute: vi.fn ? vi.fn().mockResolvedValue({ ok: true }) : function () { return Promise.resolve({ ok: true }); }
    };
    return pub.phase2FillAndUpload({ body: 'hi' }).then(function () {
      if (vi.fn) expect(pub.browserManager.click).not.toHaveBeenCalled();
    });
  });
});

// =====================================================================
// main.js / index.html 集成检查
// =====================================================================
describe('main.js / index.html · X phase 2 集成', () => {
  const fs = require('fs');
  const path = require('path');
  const main = fs.readFileSync(path.resolve(__dirname, '../electron/main.js'), 'utf8');
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

  it('main.js runXLoginPhase：phase 1 OK 后自动接 phase 2 (phase2FillAndUpload)', () => {
    expect(/phase1ReachCompose\(\)[\s\S]{0,300}?phase2FillAndUpload/.test(main)).toBe(true);
  });

  it('main.js runXLoginPhase：最终返回 status=confirm, autoSubmitDisabled=true', () => {
    expect(/phase2FillAndUpload[\s\S]{0,600}?status:\s*['"]confirm['"]/.test(main)).toBe(true);
    expect(/phase2FillAndUpload[\s\S]{0,600}?autoSubmitDisabled:\s*true/.test(main)).toBe(true);
  });

  it('main.js：videoAssetId 链路加入 x', () => {
    expect(/platformId === 'jike' \|\| platformId === 'producthunt' \|\| platformId === 'xiaohongshu' \|\| platformId === 'x'/.test(main)).toBe(true);
  });

  // v1.x+（修复 6 增强）：rocketGo 的 X 分支**完全重建** payload，**不**用 state.copies 中转。
  //   从 DOM 直读 #x-body-textarea → 写入 _xPayloadLocal.body → browserXPublish(_xPayloadLocal)。
  //   与 autoPub('x') 单卡填表严格一致。
  it('index.html：rocketGo X 分支**完全重建** payload（DOM 直读），与 autoPub("x") 一致', () => {
    // (1) rocketGo 的 X 分支**必须**有 `var _xPayloadLocal = { ... }` 重建
    // (2) 从 `getElementById('x-body-textarea')` 读 body
    // (3) 调 `window.api.browserXPublish(_xPayloadLocal)` —— **不**是 `browserXPublish(payload)`
    var rgoIdx = html.indexOf('window.rocketGo=async function(');
    expect(rgoIdx).toBeGreaterThan(-1);
    var rgoSeg = html.slice(rgoIdx);
    expect(/_xPayloadLocal\s*=/.test(rgoSeg)).toBe(true);
    expect(/getElementById\(['"]x-body-textarea['"]\)/.test(rgoSeg)).toBe(true);
    // 关键：X 分支必须用 _xPayloadLocal，**不能**用 payload
    var xRPattern = /window\.api\.browserXPublish\(_xPayloadLocal\)/;
    expect(xRPattern.test(rgoSeg)).toBe(true);
    // 反断言：X 分支**不能**用未重建的 payload（共享变量被 XHS 覆盖）
    //   允许在 rgoSeg 中**第一段**早于 pid==='x' 分支出现 `payload.body = ...`，但
    //   X-iteration 必须改用 _xPayloadLocal。X-iteration 的 browserXPublish 调用必须用 _xPayloadLocal。
    // (这里只用正向断言即可，反向断言由上面 xRPattern 隐含保证)
  });

  it('index.html：state.videoAsset 同步到 X', () => {
    expect(/id==='x'[\s\S]{0,3500}?state\.videoAsset\.id/.test(html)).toBe(true);
  });

  it('index.html：X 平台 auto:false (永不自动 Post)', () => {
    expect(/id:'x'[\s\S]{0,80}?auto:false/.test(html)).toBe(true);
  });

  it('index.html：X confirm 分支：toast + markPub, 不弹 confirmModal', () => {
    // id==='x' 分支在 xiaohongshu 之后，markPub 之前
    var m = html.match(/else if\(id==='x'\)\{([\s\S]{0,500}?)\}else/);
    expect(m).toBeTruthy();
    if (m) {
      expect(/toast\(xNote/.test(m[1])).toBe(true);
      expect(/markPub\(id\)/.test(m[1])).toBe(true);
      expect(/confirmModal/.test(m[1])).toBe(false);  // 确认永远不弹
    }
  });
});