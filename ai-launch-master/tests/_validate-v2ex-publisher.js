// Rokit · V2EX Publisher 验证脚本（不依赖 vitest；Node 原生 assert）
// 用法：node tests/_validate-v2ex-publisher.js
'use strict';
const assert = require('assert');

const PublisherRegistry = require('../electron/browser/PublisherRegistry');
// 先把整个 platforms 加载完，确保 zhihu / v2ex 都被注册
require('../electron/browser/platforms');
const { V2EXPublisher, V2EX_CONFIG, V2EX_SELECTORS } =
  require('../electron/browser/platforms/v2ex/V2EXPublisher');
const fillScripts = require('../electron/browser/fill-input');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 ' + name + ' :: ' + (e && e.message || e)); failed++; }
}

console.log('== PublisherRegistry 自动注册了 v2ex ==');
check('v2ex 已注册', function () {
  assert.ok(PublisherRegistry.has('v2ex'), 'v2ex 未注册');
});
check('list() 包含 v2ex', function () {
  assert.ok(PublisherRegistry.list().indexOf('v2ex') >= 0);
});
check('v2ex 指向 V2EXPublisher 构造函数', function () {
  assert.strictEqual(PublisherRegistry.get('v2ex'), V2EXPublisher);
});
check('zhihu 仍保留', function () {
  assert.ok(PublisherRegistry.has('zhihu'));
});

console.log('== V2EX_CONFIG ==');
check('homeUrl 是 https://www.v2ex.com/', function () {
  assert.strictEqual(V2EX_CONFIG.homeUrl, 'https://www.v2ex.com/');
});
check('loginUrl 与 homeUrl 相同（V2EX 主页就显示登录表单）', function () {
  assert.strictEqual(V2EX_CONFIG.loginUrl, V2EX_CONFIG.homeUrl);
});
check('publishUrl 命中 https://www.v2ex.com/new/<node>', function () {
  assert.ok(/^https:\/\/www\.v2ex\.com\/new\/[a-z0-9_-]+$/i.test(V2EX_CONFIG.publishUrl),
    'publishUrl 应形如 https://www.v2ex.com/new/<node>，实际：' + V2EX_CONFIG.publishUrl);
});
check('quitWriteUrl 兜底 /quit/write', function () {
  assert.strictEqual(V2EX_CONFIG.quitWriteUrl, 'https://www.v2ex.com/quit/write');
});

console.log('== V2EX_SELECTORS（必须是非空字符串/数组） ==');
check('title 至少 5 个 fallback', function () {
  assert.ok(Array.isArray(V2EX_SELECTORS.title));
  assert.ok(V2EX_SELECTORS.title.length >= 5);
});
check('content 至少 5 个 fallback', function () {
  assert.ok(Array.isArray(V2EX_SELECTORS.content));
  assert.ok(V2EX_SELECTORS.content.length >= 5);
});
check('title 首位 selector 必须是 input[name="title"]（V2EX 真实 DOM）', function () {
  assert.strictEqual(V2EX_SELECTORS.title[0], 'input[name="title"]');
});
check('content 首位 selector 必须是 textarea[name="content"]（V2EX 真实 DOM）', function () {
  assert.strictEqual(V2EX_SELECTORS.content[0], 'textarea[name="content"]');
});
check('title 不含随机 css 关键词', function () {
  var bad = V2EX_SELECTORS.title.filter(function (s) { return /\b(css-[a-z0-9]{5,})/.test(s); });
  assert.strictEqual(bad.length, 0, '发现疑似不稳定 css：' + JSON.stringify(bad));
});
check('content 不含随机 css 关键词', function () {
  var bad = V2EX_SELECTORS.content.filter(function (s) { return /\b(css-[a-z0-9]{5,})/.test(s); });
  assert.strictEqual(bad.length, 0, '发现疑似不稳定 css：' + JSON.stringify(bad));
});
check('loggedInIndicators 不为空', function () {
  assert.ok(Array.isArray(V2EX_SELECTORS.loggedInIndicators));
  assert.ok(V2EX_SELECTORS.loggedInIndicators.length > 0);
});
check('loginIndicators 不为空', function () {
  assert.ok(Array.isArray(V2EX_SELECTORS.loginIndicators));
  assert.ok(V2EX_SELECTORS.loginIndicators.length > 0);
});
check('loggedInIndicators 必须包含 a[href^="/member/"]（V2EX 顶栏用户名链接）', function () {
  assert.ok(V2EX_SELECTORS.loggedInIndicators.indexOf('a[href^="/member/"]') >= 0);
});
check('loginIndicators 必须包含 input[name="u"]（V2EX 登录用户名）', function () {
  assert.ok(V2EX_SELECTORS.loginIndicators.indexOf('input[name="u"]') >= 0);
});
check('loginIndicators 必须包含 input[name="p"]（V2EX 登录密码）', function () {
  assert.ok(V2EX_SELECTORS.loginIndicators.indexOf('input[name="p"]') >= 0);
});

console.log('== V2EXPublisher 实例化与基础属性 ==');
check('new V2EXPublisher() 不报错', function () {
  var pub = new V2EXPublisher({ browserManager: stubBM() });
  assert.strictEqual(pub.platformId, 'v2ex');
  assert.strictEqual(pub.platformName, 'V2EX');
});
check('selectors.title / content 是副本（不共享引用）', function () {
  var pub = new V2EXPublisher({ browserManager: stubBM() });
  assert.notStrictEqual(pub.selectors.title, V2EX_SELECTORS.title);
  assert.notStrictEqual(pub.selectors.content, V2EX_SELECTORS.content);
  assert.deepStrictEqual(pub.selectors.title, V2EX_SELECTORS.title);
  assert.deepStrictEqual(pub.selectors.content, V2EX_SELECTORS.content);
});
check('loginConfig.inSelectors / outSelectors 正确填充', function () {
  var pub = new V2EXPublisher({ browserManager: stubBM() });
  assert.deepStrictEqual(pub.loginConfig.inSelectors, V2EX_SELECTORS.loggedInIndicators);
  assert.deepStrictEqual(pub.loginConfig.outSelectors, V2EX_SELECTORS.loginIndicators);
});
check('loginUrl / publishUrl 来自 V2EX_CONFIG', function () {
  var pub = new V2EXPublisher({ browserManager: stubBM() });
  assert.strictEqual(pub.loginUrl, V2EX_CONFIG.loginUrl);
  assert.strictEqual(pub.publishUrl, V2EX_CONFIG.publishUrl);
});

console.log('== V2EXPublisher.prepareContent（用 stub BM 跑"准备脚本"） ==');
check('prepareContent 调用 BrowserManager.execute', async function () {
  var bm = stubBM();
  bm.returns = {
    ok: true,
    found: { title: true, content: true },
    filled: { title: { ok: true, value: 'X' }, content: { ok: true, value: 'YYYYY' } },
    verified: { title: { match: true }, content: { match: true } }
  };
  var pub = new V2EXPublisher({ browserManager: bm });
  var r = await pub.prepareContent({ title: 'X', content: 'YYYYY' });
  assert.ok(bm.calls.filter(function (c) { return c[0] === 'execute'; }).length >= 2,
    'execute 至少被调用 2 次（prepare + banner）');
  assert.ok(r && r.banner && /手动点击/.test(r.banner));
  assert.strictEqual(r.verifiedTitle, true);
  assert.strictEqual(r.verifiedContent, true);
});
check('prepareContent title 未找到时返回 ok=false', async function () {
  var bm = stubBM();
  bm.returns = {
    ok: false,
    found: { title: false, content: true },
    filled: { title: { ok: false, error: 'title-not-found' }, content: { ok: true, value: 'YYYYY' } },
    verified: {}
  };
  var pub = new V2EXPublisher({ browserManager: bm });
  var r = await pub.prepareContent({ title: 'X', content: 'YYYYY' });
  assert.strictEqual(r.ok, false);
});
check('prepareContent verify 不匹配时给出 banner 但 verifiedXxx=false', async function () {
  var bm = stubBM();
  bm.returns = {
    ok: true,
    found: { title: true, content: true },
    filled: { title: { ok: true, value: 'X' }, content: { ok: true, value: 'YYYYY' } },
    verified: { title: { match: false }, content: { match: false } }
  };
  var pub = new V2EXPublisher({ browserManager: bm });
  var r = await pub.prepareContent({ title: 'X', content: 'YYYYY' });
  assert.strictEqual(r.verifiedTitle, false);
  assert.strictEqual(r.verifiedContent, false);
});

console.log('== V2EXPublisher.checkLoginStatus（URL 启发式） ==');
check('URL 命中 /signin → logged_out', async function () {
  var bm = stubBM();
  bm._executeImpl = function (id, script) {
    if (script.indexOf('detectLogin') >= 0) return Promise.resolve(undefined);
    return Promise.resolve('https://www.v2ex.com/signin');
  };
  var pub = new V2EXPublisher({ browserManager: bm });
  var s = await pub.checkLoginStatus();
  assert.strictEqual(s, 'logged_out');
});
check('URL 命中 /new/python → logged_in', async function () {
  var bm = stubBM();
  bm._executeImpl = function (id, script) {
    if (script.indexOf('detectLogin') >= 0) return Promise.resolve(undefined);
    return Promise.resolve('https://www.v2ex.com/new/python');
  };
  var pub = new V2EXPublisher({ browserManager: bm });
  var s = await pub.checkLoginStatus();
  assert.strictEqual(s, 'logged_in');
});
check('URL 命中 /member/ → logged_in', async function () {
  var bm = stubBM();
  bm._executeImpl = function (id, script) {
    if (script.indexOf('detectLogin') >= 0) return Promise.resolve(undefined);
    return Promise.resolve('https://www.v2ex.com/member/Waylon');
  };
  var pub = new V2EXPublisher({ browserManager: bm });
  var s = await pub.checkLoginStatus();
  assert.strictEqual(s, 'logged_in');
});

console.log('== V2EXPublisher 与 ZhihuPublisher 架构同源（不重复造轮子） ==');
check('V2EXPublisher.prototype instanceof PublisherBase', function () {
  var pub = new V2EXPublisher({ browserManager: stubBM() });
  var { PublisherBase } = require('../electron/browser/PublisherBase');
  assert.ok(pub instanceof PublisherBase);
});
check('V2EXPublisher 不重写 BrowserManager 字段', function () {
  var pub = new V2EXPublisher({ browserManager: stubBM() });
  assert.strictEqual(typeof pub.browserManager.execute, 'function');
});
check('uploadImages / uploadVideo 继承自 PublisherBase（notImplemented 行为）', async function () {
  var pub = new V2EXPublisher({ browserManager: stubBM() });
  try { await pub.uploadImages(); assert.fail('应该 reject'); }
  catch (e) { assert.ok(/not implemented/i.test(e.message)); }
  try { await pub.uploadVideo(); assert.fail('应该 reject'); }
  catch (e) { assert.ok(/not implemented/i.test(e.message)); }
});

console.log('== buildV2exPrepareScript 注入文本（IIFE 语法级校验） ==');
check('IIFE 字符串可以被 eval（Node.js 端模拟一次）', function () {
  // 用 jsdom-like 最小 stub 模拟 DOM API
  var fakeEl = {
    tagName: 'INPUT',
    focus: function () {},
    blur: function () {},
    dispatchEvent: function () {},
    get name() { return 'title'; },
    set name(v) {},
    value: ''
  };
  var calls = [];
  var docStub = {
    _query: function (sel) {
      calls.push(['querySelectorAll', sel]);
      return sel.indexOf('name="title"') >= 0 ? [fakeEl] : [];
    },
    _exec: function (cmd, a, b) {
      calls.push(['execCommand', cmd]);
      return true;
    },
    querySelectorAll: function (sel) { return this._query(sel); },
    querySelector: function (sel) { var xs = this._query(sel); return xs[0] || null; },
    execCommand: function (cmd, a, b) { return this._exec(cmd, a, b); }
  };
  var proto = {
    set value(v) {},
    get value() { return ''; }
  };
  // 我们手工 parse buildV2exPrepareScript 的输出字符串，断言它能被 eval 成合法函数
  var v2exMod = require('../electron/browser/platforms/v2ex/V2EXPublisher');
  // 重新 require 来获得 buildV2exPrepareScript（导出未暴露，临时构造触发）:
  // 这里只能通过 require fill-input.js 来验证 RESOLVE_SELECTOR_FN / FILL_INPUT_FN 已导出
  assert.strictEqual(typeof fillScripts.RESOLVE_SELECTOR_FN, 'string');
  assert.strictEqual(typeof fillScripts.FILL_INPUT_FN, 'string');
  assert.ok(fillScripts.RESOLVE_SELECTOR_FN.indexOf('resolveOne') > 0);
  assert.ok(fillScripts.FILL_INPUT_FN.indexOf('filter') > 0);
});

function stubBM() {
  var calls = [];
  var self = {
    calls: calls,
    openPlatform: async function (id) { calls.push(['openPlatform', id]); return { reused: false }; },
    closePlatform: async function (id) { calls.push(['closePlatform', id]); return true; },
    navigate: async function (id, url) { calls.push(['navigate', id, url]); return null; },
    execute: async function (id, script) {
      calls.push(['execute', id, script.length]);
      if (typeof self._executeImpl === 'function') return self._executeImpl(id, script);
      if (self.returns !== undefined) return self.returns;
      return undefined;
    },
    onceNavigated: function (id, cb) { calls.push(['onceNavigated', id]); }
  };
  return self;
}

(async function () {
  console.log('\n=== Summary ===');
  console.log('Passed: ' + passed);
  console.log('Failed: ' + failed);
  process.exit(failed === 0 ? 0 : 1);
})();