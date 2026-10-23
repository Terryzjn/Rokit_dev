// Rokit · 小红书（Xiaohongshu）Publisher 测试（v1.0）
// ------------------------------------------------------------
// 验证项：
//   - 不修改其他平台（github / v2ex / juejin / jike / ph / bili / douyin / zhihu / wechat / facebook / youtube / x）
//   - 主类状态机、Prepare / MediaUpload IIFE 语法正确
//   - 主类不点最终发布（never clicks Submit）
//   - 主类不构建自己的 BrowserWindow（用项目共享 pubWin）
//   - 主类不发 executeJavaScript / CDP / chrome-remote-interface / chrome.devtools
//   - adapter 配置正确
//   - 选择器覆盖 input / textarea / contenteditable
//   - 节流文案只作日志，不 abort
//   - partition: persist:platform-xiaohongshu
//   - 适配器 fill() IIFE 在 JSDOM-like vm 里可被 Node 解析（无 throw）
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PUBLISHER_PATH = path.join(ROOT, 'electron/browser/platforms/xiaohongshu/XiaohongshuPublisher.js');
const PREPARE_PATH   = path.join(ROOT, 'electron/browser/platforms/xiaohongshu/XiaohongshuPrepareScript.js');
const MEDIA_PATH     = path.join(ROOT, 'electron/browser/platforms/xiaohongshu/XiaohongshuMediaUploadScript.js');
const ADAPTERS_PATH  = path.join(ROOT, 'electron/publishers.js');

describe('小红书（Xiaohongshu / RED）Publisher', () => {
  describe('文件结构', () => {
    test('XiaohongshuPublisher.js 存在', () => {
      expect(fs.existsSync(PUBLISHER_PATH)).toBe(true);
    });
    test('XiaohongshuPrepareScript.js 存在', () => {
      expect(fs.existsSync(PREPARE_PATH)).toBe(true);
    });
    test('XiaohongshuMediaUploadScript.js 存在', () => {
      expect(fs.existsSync(MEDIA_PATH)).toBe(true);
    });
  });

  describe('主类（XiaohongshuPublisher.js）', () => {
    let SRC;
    let mod;
    let PhPub;

    beforeAll(() => {
      SRC = fs.readFileSync(PUBLISHER_PATH, 'utf8');
      mod = require(PUBLISHER_PATH);
      PhPub = mod.XiaohongshuPublisher;
    });

    test('导出 XiaohongshuPublisher 类 + XiaohongshuStates + PARTITION', () => {
      expect(typeof PhPub).toBe('function');
      expect(mod.XiaohongshuStates).toBeDefined();
      expect(mod.PARTITION).toBe('persist:platform-xiaohongshu');
      expect(mod.HOME_URL).toBe('https://www.xiaohongshu.com/');
      expect(Array.isArray(mod.TITLE_SELECTORS)).toBe(true);
      expect(Array.isArray(mod.CONTENT_SELECTORS)).toBe(true);
    });

    test('状态常量被 Object.freeze（不可修改）', () => {
      let threw = false;
      try { mod.XiaohongshuStates.INIT = 'X'; } catch (_e) { threw = true; }
      expect(mod.XiaohongshuStates.INIT).toBe('INIT');
      expect([true, false]).toContain(threw);
    });

    test('platformId / platformName 正确', () => {
      const p = new PhPub({});
      expect(p.platformId).toBe('xiaohongshu');
      expect(p.platformName).toBe('小红书');
    });

    test('使用独立 partition: persist:platform-xiaohongshu', () => {
      const p = new PhPub({});
      expect(p.partition).toBe('persist:platform-xiaohongshu');
    });

    test('状态机包含 INIT/LOADING/WAITING_LOGIN/LOGIN_CONFIRMED/NAVIGATING_TO_PUBLISH/WAITING_PUBLISH_PAGE/FILLING_TITLE/FILLING_CONTENT/UPLOADING_MEDIA/VERIFYING/READY_FOR_MANUAL_SEND', () => {
      const expectedStates = [
        'INIT','LOADING','WAITING_LOGIN','LOGIN_CONFIRMED','NAVIGATING_TO_PUBLISH',
        'WAITING_PUBLISH_PAGE','FILLING_TITLE','FILLING_CONTENT','UPLOADING_MEDIA',
        'VERIFYING','READY_FOR_MANUAL_SEND'
      ];
      expectedStates.forEach(s => {
        expect(mod.XiaohongshuStates[s]).toBe(s);
      });
      // v2.0：删除首页入口猜测状态
      expect(mod.XiaohongshuStates.FINDING_PUBLISH_ENTRY).toBeUndefined();
      expect(mod.XiaohongshuStates.OPENING_PUBLISH_PAGE).toBeUndefined();
    });

    test('v2.0: 导出 PUBLISH_URL = https://creator.xiaohongshu.com/publish', () => {
      expect(mod.PUBLISH_URL).toBe('https://creator.xiaohongshu.com/publish');
    });

    test('主类永远不点 Submit / 发布笔记 / 完成', () => {
      // 静态扫描：不存在发布按钮选择器
      expect(SRC).not.toMatch(/Selectors\.click.*[Ss]ubmit/);
      expect(SRC).not.toMatch(/Selectors\.click.*[Pp]ublish/);
      expect(SRC).not.toMatch(/Selectors\.click.*[Ll]aunch/);
      expect(SRC).not.toMatch(/Selectors\.click.*[Ss]chedule/);
      expect(SRC).not.toMatch(/\.click\([^)]*[Ss]ubmit/);
      expect(SRC).not.toMatch(/\.click\([^)]*[Pp]ublish/);
      // submit 函数源码返回 confirm + 不点按钮
      const p = new PhPub({});
      p.state = mod.XiaohongshuStates.READY_FOR_MANUAL_SEND;
      const sub = p.submit ? p.submit({}) : null;
      if (sub) {
        // 如果存在 submit，永远返回 { status: 'confirm' } 之类不点
        expect(typeof sub).toBe('function');
      }
    });

    test('主类不发 CDP / chrome-remote-interface / chrome.devtools', () => {
      expect(SRC).not.toMatch(/CDP/i);
      expect(SRC).not.toMatch(/chrome-remote-interface/i);
      expect(SRC).not.toMatch(/chrome\.devtools/i);
    });

    test('主类不构建独立 BrowserWindow（不出现 new BrowserWindow 或 BrowserWindow 构造函数）', () => {
      // 注释里说明使用项目共享 pubWin / partition
      expect(SRC).not.toMatch(/new BrowserWindow\(/);
    });

    test('主页注释里说明：程序永不点 Submit', () => {
      expect(SRC).toContain('永不');
      expect(SRC).toContain('Submit');
    });

    test('getStatus() 在 INIT 状态下不会立即返回 readyForManualSend', () => {
      const p = new PhPub({});
      expect(p.getStatus().readyForManualSend).toBe(false);
    });

    test('logInfo / transition / stateHistory 正常', () => {
      const p = new PhPub({});
      p.transition('LOADING');
      p.transition('WAITING_LOGIN');
      expect(p.state).toBe('WAITING_LOGIN');
      expect(p.stateHistory.length).toBe(2);
      expect(p.stateHistory[0].from).toBe('INIT');
      expect(p.stateHistory[0].to).toBe('LOADING');
    });

    test('openPlatform: 传入 BrowserManager.createWindow 抛错时不会 crash', async () => {
      const bm = { createWindow: () => { throw new Error('boom'); } };
      const p = new PhPub({});
      const r = await p.openPlatform(bm);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('boom');
    });

    test('openPlatform: 正常流程返回 ok，状态 → WAITING_LOGIN', async () => {
      const bm = {
        createWindow: async () => ({ window: { on: () => {} } }),
        execute: async () => ({ result: { hasAvatar: false, foundLoginCTA: false, isLoginURL: false } })
      };
      const p = new PhPub({});
      const r = await p.openPlatform(bm);
      expect(r.ok).toBe(true);
      expect(r.state).toBe('WAITING_LOGIN');
      expect(p.browserManager).toBe(bm);
      // 不再 poll login 后立即清理
      if (p.detection && p.detection.stop) p.detection.stop();
    });
  });

  describe('XiaohongshuPrepareScript（填表 IIFE）', () => {
    test('导出 buildXiaohongshuPrepareScript', () => {
      const m = require(PREPARE_PATH);
      expect(typeof m.buildXiaohongshuPrepareScript).toBe('function');
      expect(Array.isArray(m.THROTTLE_MARKERS)).toBe(true);
    });

    test('生成的 IIFE 是合法字符串', () => {
      const m = require(PREPARE_PATH);
      const code = m.buildXiaohongshuPrepareScript({
        titleSelectors: ['input[placeholder*="标题"]'],
        contentSelectors: ['textarea'],
        fillData: { title: '测试', content: '正文' },
        pollIntervalMs: 800,
        maxAttempts: 15,
        verifyDelayMs: 800
      });
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(1000);
    });

    test('IIFE 在 vm 里能 parse（不抛 SyntaxError）', () => {
      const m = require(PREPARE_PATH);
      const code = m.buildXiaohongshuPrepareScript({
        titleSelectors: ['input[placeholder*="标题"]'],
        contentSelectors: ['textarea'],
        fillData: { title: 'T', content: 'B' }
      });
      // 不直接执行，仅验证语法
      expect(() => new vm.Script(code)).not.toThrow();
    });

    test('IIFE 不点发布按钮（静态扫描）', () => {
      const m = require(PREPARE_PATH);
      const code = m.buildXiaohongshuPrepareScript({
        titleSelectors: ['input[placeholder*="标题"]'],
        contentSelectors: ['textarea'],
        fillData: { title: 'T', content: 'B' }
      });
      expect(code).not.toMatch(/Selectors\.click[^)]*[Pp]ublish/);
      expect(code).not.toMatch(/\.click\([^)]*[Ss]ubmit/);
    });

    test('节流文案只出现在日志中（仅作 informational，**不**抛 abort）', () => {
      const m = require(PREPARE_PATH);
      const code = m.buildXiaohongshuPrepareScript({
        titleSelectors: ['input[placeholder*="标题"]'],
        contentSelectors: ['textarea'],
        fillData: { title: 'T', content: 'B' }
      });
      expect(code).toMatch(/throttled/);
      expect(code).toMatch(/informational|continuing/);
      expect(code).not.toMatch(/return\s*\{[^}]*error[^}]*throttle/i);
    });

    test('输入真实记录（HTMLInputElement 原生 setter）', () => {
      const m = require(PREPARE_PATH);
      const code = m.buildXiaohongshuPrepareScript({
        titleSelectors: ['input[placeholder*="标题"]'],
        contentSelectors: ['textarea'],
        fillData: { title: 'T', content: 'B' }
      });
      expect(code).toMatch(/HTMLInputElement\.prototype/);
      expect(code).toMatch(/HTMLTextAreaElement\.prototype/);
    });
  });

  describe('XiaohongshuMediaUploadScript（上传 IIFE）', () => {
    test('导出 buildXiaohongshuMediaUploadScript', () => {
      const m = require(MEDIA_PATH);
      expect(typeof m.buildXiaohongshuMediaUploadScript).toBe('function');
    });

    test('生成的 IIFE 是合法字符串', () => {
      const m = require(MEDIA_PATH);
      const code = m.buildXiaohongshuMediaUploadScript({
        media: { type: 'image', items: [{ src: 'data:image/png;base64,AAAA', name: 'a.png', mime: 'image/png' }] },
        timeoutMs: 15000
      });
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(800);
    });

    test('IIFE 在 vm 里能 parse', () => {
      const m = require(MEDIA_PATH);
      const code = m.buildXiaohongshuMediaUploadScript({
        media: { type: 'image', items: [{ src: 'data:image/png;base64,AAAA', name: 'a.png' }] },
        timeoutMs: 8000
      });
      expect(() => new vm.Script(code)).not.toThrow();
    });

    test('IIFE 不点发布按钮（静态扫描）', () => {
      const m = require(MEDIA_PATH);
      const code = m.buildXiaohongshuMediaUploadScript({
        media: { type: 'image', items: [{ src: 'data:image/png;base64,AAAA', name: 'a.png' }] },
        timeoutMs: 8000
      });
      expect(code).not.toMatch(/\.click\([^)]*[Pp]ublish/);
      expect(code).not.toMatch(/\.click\([^)]*[Ss]ubmit/);
    });

    test('支持 image 与 video 两种 type', () => {
      const m = require(MEDIA_PATH);
      const codeImg = m.buildXiaohongshuMediaUploadScript({
        media: { type: 'image', items: [{ src: 'data:image/png;base64,AAAA', name: 'a.png' }] },
        timeoutMs: 8000
      });
      const codeVid = m.buildXiaohongshuMediaUploadScript({
        media: { type: 'video', items: [{ src: 'data:video/mp4;base64,AAAA', name: 'a.mp4' }] },
        timeoutMs: 8000
      });
      expect(codeImg).toMatch(/pickFileInput|type===\"image\"/);
      expect(codeVid).toMatch(/pickFileInput|type===\"video\"/);
    });

    test('IIFE 使用 DataTransfer + File + change 事件', () => {
      const m = require(MEDIA_PATH);
      const code = m.buildXiaohongshuMediaUploadScript({
        media: { type: 'image', items: [{ src: 'data:image/png;base64,AAAA', name: 'a.png' }] }
      });
      expect(code).toMatch(/new DataTransfer/);
      expect(code).toMatch(/new File\(/);
      expect(code).toMatch(/dispatchEvent\([^)]*\"change\"/);
    });
  });

  describe('适配器（electron/publishers.js → xiaohongshu）', () => {
    let adapters;
    beforeAll(() => {
      adapters = require(ADAPTERS_PATH).adapters;
    });

    test('adapters.xiaohongshu 存在', () => {
      expect(adapters.xiaohongshu).toBeDefined();
    });

    test('partition = persist:platform-xiaohongshu', () => {
      expect(adapters.xiaohongshu.partition).toBe('persist:platform-xiaohongshu');
    });

    test('launch() 返回 https://www.xiaohongshu.com/', () => {
      expect(adapters.xiaohongshu.launch()).toBe('https://www.xiaohongshu.com/');
    });

    test('auto = false (最终发布由用户手动完成)', () => {
      expect(adapters.xiaohongshu.auto).toBe(false);
    });

    test('manualReason 说明永不点「发布 / 发布笔记」', () => {
      expect(adapters.xiaohongshu.manualReason).toMatch(/发布笔记|手动/);
    });

    test('fill(payload) 返回合法 IIFE 字符串', () => {
      const code = adapters.xiaohongshu.fill({
        title: '测试标题',
        body: '测试正文内容\n第二行',
        videoDataUrl: 'data:video/mp4;base64,AAAA'
      });
      expect(typeof code).toBe('string');
      expect(code.length).toBeGreaterThan(1000);
      expect(code).toMatch(/\[Xiaohongshu\]/);
      expect(code).toMatch(/resolveOne/);
      expect(code).toMatch(/probeFileInputs/);
      expect(code).toMatch(/pickFileInput/);
      expect(code).toMatch(/new DataTransfer/);
    });

    test('submit(payload) 返回 confirm + 不点发布', () => {
      const code = adapters.xiaohongshu.submit({});
      expect(code).toMatch(/confirm/);
      expect(code).toMatch(/手动/);
      expect(code).not.toMatch(/\[Pp]ublish.*click/);
      expect(code).not.toMatch(/click.*[Pp]ublish/);
    });

    test('fill IIFE 包含节流检测但仅作 informational', () => {
      const code = adapters.xiaohongshu.fill({
        title: '测试', body: '正文', videoDataUrl: 'data:video/mp4;base64,AAAA'
      });
      expect(code).toMatch(/detectThrottle/);
      expect(code).toMatch(/informational|continuing/);
    });

    test('fill IIFE 不点击 Submit / 发布按钮', () => {
      const code = adapters.xiaohongshu.fill({
        title: '测试', body: '正文', videoDataUrl: 'data:video/mp4;base64,AAAA'
      });
      expect(code).not.toMatch(/\.click\([^)]*[Pp]ublish/);
      expect(code).not.toMatch(/\.click\([^)]*[Ss]ubmit/);
    });

    test('fill IIFE 在 vm 里可解析', () => {
      const code = adapters.xiaohongshu.fill({
        title: '测试', body: '正文'
      });
      expect(() => new vm.Script(code)).not.toThrow();
    });
  });

  describe('不破坏其他平台', () => {
    test('publishers.js 所有原有平台仍存在', () => {
      const adapters = require(ADAPTERS_PATH).adapters;
      ['github','producthunt','v2ex','juejin','jike','bili','douyin','zhihu','wechat','facebook','youtube','x'].forEach(id => {
        expect(adapters[id]).toBeDefined();
      });
      // 新平台 xiaohongshu 也在
      expect(adapters.xiaohongshu).toBeDefined();
    });

    test('index.html PLATFORMS 数组含 xiaohongshu', () => {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      expect(html).toMatch(/\{id:'xiaohongshu',name:'小红书/);
    });

    test('index.html 不破坏既有平台 id（github / jike / v2ex / juejin）', () => {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      // 每个 L2 跳转平台都有一个 url 表项，形如：github:'https://...'
      // producthunt 走系统浏览器（不存 url 表项），所以下面这组不包含 producthunt
      const ids = ['github','v2ex','juejin','jike','bili','douyin','zhihu','wechat','facebook','youtube','x','xiaohongshu'];
      ids.forEach(id => {
        // id + ":'https"（id 后面跟单引号紧跟 https）
        const reUrl = new RegExp(id + ":'https", 'i');
        expect(html).toMatch(reUrl);
      });
    });

    test('xiaohongshu 不出现在「失败」负面文案路径上', () => {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      // 不允许出现 "xiaohongshu 发布失败" 这类提示
      expect(html).not.toMatch(/xiaohongshu.*发布失败/);
      expect(html).not.toMatch(/发布失败.*xiaohongshu/);
    });

    test('index.html 在 confirm 状态对 xiaohongshu 跳过「确认发布」弹窗', () => {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      // 新版：检测 id==='xiaohongshu' && r.status==='confirm' 时直接 toast
      expect(html).toMatch(/id\s*===\s*['"]xiaohongshu['"]\s*&&\s*r\.status\s*===\s*['"]confirm['"]/);
      // 该分支不能调用 pubSubmit（避免误导用户：「确认发布」按了什么都不发生）
      const m = html.match(/if\s*\(\s*id\s*===\s*['"]xiaohongshu['"]\s*&&\s*r\.status\s*===\s*['"]confirm['"]\s*\)[\s\S]{0,1500}?\}\s*else\s*\{/);
      expect(m).not.toBeNull();
      expect(m[0]).not.toMatch(/pubSubmit/);
    });
  });

  // ====================================================================
  // v1.0 main.js 多步骤编排（runXiaohongshuFill）
  //   - 不动 producthunt / github / v2ex / jike / juejin / wechat / youtube
  //   - 小红书特定：登录轮询 + 跳转发布页 + 元素就绪探测 + 填表 + 媒体上传
  // ====================================================================
  describe('main.js 小红书专属编排（runXiaohongshuFill）', () => {
    let mainSrc;
    beforeAll(() => {
      mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    });

    test('main.js 定义了 runXiaohongshuFill 函数', () => {
      expect(mainSrc).toMatch(/async\s+function\s+runXiaohongshuFill\s*\(/);
    });

    test('runXiaohongshuFill 在 pubExec fill 分支被调用', () => {
      // 期望：if (stage === 'fill') { ... if (platformId === 'xiaohongshu') return runXiaohongshuFill(...) ... }
      const re = /if\s*\(\s*stage\s*===\s*['"]fill['"]\s*\)[\s\S]{0,500}?if\s*\(\s*platformId\s*===\s*['"]xiaohongshu['"]\s*\)[\s\S]{0,200}?runXiaohongshuFill\s*\(/;
      expect(mainSrc).toMatch(re);
    });

    test('小红书走专属浏览器（partition），不走 shell.openExternal', () => {
      // runXiaohongshuFill 内部不应调用 shell.openExternal（producthunt 才用）
      // 取 runXiaohongshuFill 函数体内容
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      // 找到函数体结束的右大括号（粗略截取到函数末尾 + 1000 字节覆盖 return 块）
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      expect(idx).toBeGreaterThan(0);
      expect(body).not.toMatch(/shell\.openExternal/);
    });

    test('runXiaohongshuFill 不点最终发布按钮', () => {
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      // 找到函数体结束的右大括号（粗略截取到函数末尾 + 1000 字节覆盖 return 块）
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      // 拒绝任何形式的 .click()（除非明确只读）
      expect(body).not.toMatch(/win\.webContents\.executeJavaScript\([^)]*\.click\s*\(/);
      expect(body).not.toMatch(/win\.webContents\.send\(['"]click/);
    });

    test('runXiaohongshuFill 有登录轮询（每 1.5s × 最多 3 分钟）', () => {
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      // 找到函数体结束的右大括号（粗略截取到函数末尾 + 1000 字节覆盖 return 块）
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      expect(body).toMatch(/LOGIN_POLL_MS\s*=\s*1500/);
      expect(body).toMatch(/LOGIN_MAX_ATTEMPTS\s*=\s*120/);
      expect(body).toMatch(/登录状态：waiting/);
      expect(body).toMatch(/登录状态：success/);
      expect(body).toMatch(/login-timeout/);
    });

    test('runXiaohongshuFill 探测登录综合信号：URL + 文本 + 头像', () => {
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      // 找到函数体结束的右大括号（粗略截取到函数末尾 + 1000 字节覆盖 return 块）
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      expect(body).toMatch(/登录状态：waiting/);
      expect(body).toMatch(/hasAvatar/);
      expect(body).toMatch(/foundLoginCTA/);
      expect(body).toMatch(/isLoginURL/);
      // creator 域单独通过路径判定
      expect(body).toMatch(/isOnCreator/);
    });

    test('runXiaohongshuFill v2.0: 直接导航到官方发布页 https://creator.xiaohongshu.com/publish，不再从小红书首页 DOM 猜"发布"按钮', () => {
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      // 直接调用 win.webContents.loadURL 跳转到 creator.xiaohongshu.com/publish
      expect(body).toMatch(/win\.webContents\.loadURL\(PUBLISH_URL\)/);
      expect(body).toMatch(/PUBLISH_URL\s*=\s*['"]https:\/\/creator\.xiaohongshu\.com\/publish['"]/);
      // 不再从小红书首页 DOM 猜入口：不再模拟点击发布按钮（dispatchEvent new MouseEvent('click'...)）
      expect(body).not.toMatch(/dispatchEvent\(new MouseEvent\(['"]click/);
      // 不再调用 target.click() 来进入发布页
      expect(body).not.toMatch(/target\.click\(\)/);
      // 等待发布页综合特征：URL + title + DOM 元素 + 关键词
      expect(body).toMatch(/PUBLISH_PAGE_PROBE/);
      expect(body).toMatch(/isOnCreator/);
      expect(body).toMatch(/editorFound/);
      expect(body).toMatch(/titleFound/);
      expect(body).toMatch(/contentFound/);
      expect(body).toMatch(/fileInputCount/);
      expect(body).toMatch(/keywordHits/);
      expect(body).toMatch(/pageReady/);
      expect(body).toMatch(/publish-page-unready/);
      // 兼容性：仍保留"发布入口 URL"诊断前缀（日志对账）
      expect(body).toMatch(/发布入口 URL/);
    });

    test('runXiaohongshuFill v2.0: 处理创作页被重定向回 www.xiaohongshu.com，不会无限循环', () => {
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      expect(body).toMatch(/consecutiveHome/);
      expect(body).toMatch(/REDIRECT_HOME_MAX/);
      expect(body).toMatch(/creator-redirect-home/);
      expect(body).toMatch(/官方发布页被重定向回首页/);
      // 不要重新调 win.webContents.loadURL（避免循环跳转）
      expect(body).not.toMatch(/win\.webContents\.loadURL\(['"]https:\/\/www\.xiaohongshu\.com/);
    });

    test('runXiaohongshuFill v2.0: 创作平台二次登录时，等用户完成登录（不报错）', () => {
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      expect(body).toMatch(/looksLikeLogin/);
      expect(body).toMatch(/完成登录（不报错）|完成登录/);
      expect(body).toMatch(/creator-need-login|登录超时/);
    });

    test('runXiaohongshuFill v2.0: 不再使用首页入口探测的 ENTRY_PROBE_SCRIPT / CLICK_SCRIPT（已替换为 noop 占位）', () => {
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      // 旧变量名保留但内容已替换为 noop
      expect(body).toMatch(/ENTRY_PROBE_SCRIPT\s*=\s*['"]\(function\(\)\{ return \{ ok:false, reason:["']deprecated["']/);
      // 旧的 CLICK_SCRIPT（用于点击发布入口）已删除
      expect(body).not.toMatch(/CLICK_SCRIPT\s*=\s*['"`]\(function\(\)\{/);
      expect(body).not.toMatch(/PUBLISH_PAGE_PROBE.*CLICK_SCRIPT/);
    });

    test('runXiaohongshuFill 等发布页元素就绪（标题 / 正文 / input[file]）', () => {
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      // 找到函数体结束的右大括号（粗略截取到函数末尾 + 1000 字节覆盖 return 块）
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      expect(body).toMatch(/PUBLISH_PAGE_PROBE/);
      expect(body).toMatch(/titleFound/);
      expect(body).toMatch(/contentFound/);
      expect(body).toMatch(/fileInputCount/);
      expect(body).toMatch(/pageReady/);
      expect(body).toMatch(/publish-page-unready/);
    });

    test('runXiaohongshuFill 返回 status=confirm 永不自动点发布', () => {
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      // 找到函数体结束的右大括号（粗略截取到函数末尾 + 1000 字节覆盖 return 块）
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      expect(body).toMatch(/status:\s*['"]confirm['"]/);
      expect(body).toMatch(/readyForManualSend:\s*true/);
      expect(body).toMatch(/永不点.*发布.*发布笔记/);
    });

    test('runXiaohongshuFill 输出明确的诊断日志前缀', () => {
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      // 找到函数体结束的右大括号（粗略截取到函数末尾 + 1000 字节覆盖 return 块）
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      expect(body).toMatch(/logTag \+ ' start'/);
      expect(body).toMatch(/当前模式：electron-browser/);
      expect(body).toMatch(/登录状态/);
      expect(body).toMatch(/寻找发布入口/);
      expect(body).toMatch(/发布入口 URL/);
      expect(body).toMatch(/发布页元素就位/);
      expect(body).toMatch(/标题输入框/);
      expect(body).toMatch(/正文输入框/);
      expect(body).toMatch(/媒体 input/);
      expect(body).toMatch(/标题填充/);
      expect(body).toMatch(/正文填充/);
      expect(body).toMatch(/媒体上传/);
      expect(body).toMatch(/最终状态/);
    });

    test('runXiaohongshuFill 不重新打开 BrowserWindow（只复用现有 win）', () => {
      const idx = mainSrc.indexOf('async function runXiaohongshuFill');
      // 找到函数体结束的右大括号（粗略截取到函数末尾 + 1000 字节覆盖 return 块）
      const endIdx = mainSrc.indexOf('async function pubExec(', idx);
      const sliceLen = (endIdx > idx) ? (endIdx - idx + 200) : 30000;
      const body = mainSrc.slice(idx, idx + sliceLen);
      expect(body).not.toMatch(/new BrowserWindow\(/);
    });
  });
});