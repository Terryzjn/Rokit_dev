// Rokit · 知乎 Publisher 验证脚本（不依赖 vitest；Node 原生 assert）
// 用法：node tests/_validate-zhihu-publisher.js
'use strict';
const assert = require('assert');

const PublisherRegistry = require('../electron/browser/PublisherRegistry');
const { ZhihuPublisher, ZHIHU_CONFIG, ZHIHU_SELECTORS } =
  require('../electron/browser/platforms/zhihu/ZhihuPublisher');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 ' + name + ' :: ' + (e && e.message || e)); failed++; }
}

console.log('== PublisherRegistry 自动注册了 zhihu ==');
check('zhihu 已注册', function () {
  assert.ok(PublisherRegistry.has('zhihu'), 'zhihu 未注册');
});
check('list() 包含 zhihu', function () {
  assert.ok(PublisherRegistry.list().indexOf('zhihu') >= 0);
});
check('zhihu 指向 ZhihuPublisher 构造函数', function () {
  assert.strictEqual(PublisherRegistry.get('zhihu'), ZhihuPublisher);
});

console.log('== ZHIHU_CONFIG ==');
check('loginUrl 是 https://www.zhihu.com/signin', function () {
  assert.strictEqual(ZHIHU_CONFIG.loginUrl, 'https://www.zhihu.com/signin');
});
check('publishUrl 是 https://www.zhihu.com/creator/article/edit 或类似的创作页', function () {
  assert.ok(/zhihu\.com/.test(ZHIHU_CONFIG.publishUrl));
});
check('homeUrl 是 https://www.zhihu.com/', function () {
  assert.strictEqual(ZHIHU_CONFIG.homeUrl, 'https://www.zhihu.com/');
});

console.log('== ZHIHU_SELECTORS（必须是非空字符串/数组） ==');
check('title 至少 5 个 fallback', function () {
  assert.ok(Array.isArray(ZHIHU_SELECTORS.title));
  assert.ok(ZHIHU_SELECTORS.title.length >= 5);
});
check('content 至少 5 个 fallback', function () {
  assert.ok(Array.isArray(ZHIHU_SELECTORS.content));
  assert.ok(ZHIHU_SELECTORS.content.length >= 5);
});
check('title 中不包含随机 class 关键词', function () {
  // 兜底方案只允许 id / name / placeholder / aria-label / contenteditable
  // 严禁依赖 .css-xxx
  var bad = ZHIHU_SELECTORS.title.filter(function (s) { return /\b(css-[a-z0-9]{5,})/.test(s); });
  assert.strictEqual(bad.length, 0, '发现疑似不稳定 css：' + JSON.stringify(bad));
});
check('content 中包含 [contenteditable="true"]', function () {
  var has = ZHIHU_SELECTORS.content.some(function (s) { return /contenteditable="true"/.test(s); });
  assert.ok(has, '正文必须至少有 1 个 contenteditable selector');
});
check('loggedInIndicators 不为空', function () {
  assert.ok(Array.isArray(ZHIHU_SELECTORS.loggedInIndicators));
  assert.ok(ZHIHU_SELECTORS.loggedInIndicators.length > 0);
});
check('loginIndicators 不为空', function () {
  assert.ok(Array.isArray(ZHIHU_SELECTORS.loginIndicators));
  assert.ok(ZHIHU_SELECTORS.loginIndicators.length > 0);
});

console.log('== ZhihuPublisher 实例化与基础属性 ==');
check('new ZhihuPublisher() 不报错', function () {
  var pub = new ZhihuPublisher({ browserManager: stubBM() });
  assert.strictEqual(pub.platformId, 'zhihu');
  assert.strictEqual(pub.platformName, '知乎');
});
check('selectors.title === ZHIHU_SELECTORS.title 的副本（避免共享引用）', function () {
  var pub = new ZhihuPublisher({ browserManager: stubBM() });
  assert.notStrictEqual(pub.selectors.title, ZHIHU_SELECTORS.title);
  assert.deepStrictEqual(pub.selectors.title, ZHIHU_SELECTORS.title);
});
check('loginConfig.inSelectors / outSelectors 正确填充', function () {
  var pub = new ZhihuPublisher({ browserManager: stubBM() });
  assert.deepStrictEqual(pub.loginConfig.inSelectors, ZHIHU_SELECTORS.loggedInIndicators);
  assert.deepStrictEqual(pub.loginConfig.outSelectors, ZHIHU_SELECTORS.loginIndicators);
});
check('loginUrl / publishUrl 来自 ZHIHU_CONFIG', function () {
  var pub = new ZhihuPublisher({ browserManager: stubBM() });
  assert.strictEqual(pub.loginUrl, ZHIHU_CONFIG.loginUrl);
  assert.strictEqual(pub.publishUrl, ZHIHU_CONFIG.publishUrl);
});

console.log('== ZhihuPublisher.prepareContent（用 stub BM 跑"准备脚本"） ==');
check('prepareContent 调用 BrowserManager.execute', async function () {
  var bm = stubBM();
  bm.execute.returns = {
    ok: true,
    found: { title: true, content: true },
    filled: { title: { ok: true, value: 'X' }, content: { ok: true, length: 5 } },
    verified: { title: { match: true }, content: { match: true } }
  };
  var pub = new ZhihuPublisher({ browserManager: bm });
  var r = await pub.prepareContent({ title: 'X', content: 'YYYYY' });
  assert.ok(bm.execute.calls.length >= 2, 'execute 至少被调用 2 次（prepare + banner）');
  assert.ok(r && r.banner && /手动点击/.test(r.banner));
  assert.strictEqual(r.verifiedTitle, true);
  assert.strictEqual(r.verifiedContent, true);
});
check('prepareContent title 未找到时返回 ok=false', async function () {
  var bm = stubBM();
  bm.execute.returns = {
    ok: false,
    found: { title: false, content: true },
    filled: { title: { ok: false, error: 'title-not-found' }, content: { ok: true, length: 5 } },
    verified: {}
  };
  var pub = new ZhihuPublisher({ browserManager: bm });
  var r = await pub.prepareContent({ title: 'X', content: 'YYYYY' });
  assert.strictEqual(r.ok, false);
});
check('prepareContent verify 不匹配时给出 banner 但 verifiedXxx=false', async function () {
  var bm = stubBM();
  bm.execute.returns = {
    ok: true,
    found: { title: true, content: true },
    filled: { title: { ok: true, value: 'X' }, content: { ok: true, length: 5 } },
    verified: { title: { match: false }, content: { match: false } }
  };
  var pub = new ZhihuPublisher({ browserManager: bm });
  var r = await pub.prepareContent({ title: 'X', content: 'YYYYY' });
  assert.strictEqual(r.verifiedTitle, false);
  assert.strictEqual(r.verifiedContent, false);
});

console.log('== ZhihuPublisher.checkLoginStatus（URL 启发式） ==');
check('URL 命中 /signin → logged_out', async function () {
  var bm = stubBM();
  // detectLogin 返回 undefined (无 status 字段) → 基类返回 unknown
  // 然后 ZhihuPublisher 走 URL 启发式
  bm._executeImpl = function (id, script) {
    if (script.indexOf('detectLogin') >= 0) return Promise.resolve(undefined);
    return Promise.resolve('https://www.zhihu.com/signin');
  };
  var pub = new ZhihuPublisher({ browserManager: bm });
  var s = await pub.checkLoginStatus();
  assert.strictEqual(s, 'logged_out');
});
check('URL 命中 /creator → logged_in', async function () {
  var bm = stubBM();
  bm._executeImpl = function (id, script) {
    if (script.indexOf('detectLogin') >= 0) return Promise.resolve(undefined);
    return Promise.resolve('https://www.zhihu.com/creator');
  };
  var pub = new ZhihuPublisher({ browserManager: bm });
  var s = await pub.checkLoginStatus();
  assert.strictEqual(s, 'logged_in');
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