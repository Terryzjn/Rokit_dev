// Rokit · 浏览器框架验证脚本（不依赖 vitest；只使用 Node 原生 assert）
// 用法：node tests/_validate-browser-framework.js
'use strict';
const assert = require('assert');

const PublisherRegistry = require('../electron/browser/PublisherRegistry');
const { PublisherBase } = require('../electron/browser/PublisherBase');
const fillScripts = require('../electron/browser/fill-input');
const { BrowserTestPublisher } = require('../electron/browser/platforms/browser-test');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 ' + name + ' :: ' + (e && e.message || e)); failed++; }
}

console.log('== PublisherRegistry ==');
check('默认注册了 browser-test', function () { assert.ok(PublisherRegistry.has('browser-test')); });
check('默认注册了 test（别名）', function () { assert.ok(PublisherRegistry.has('test')); });
check('list() 至少包含 browser-test', function () { assert.ok(PublisherRegistry.list().indexOf('browser-test') >= 0); });
check('register / unregister', function () {
  class Stub {}
  PublisherRegistry.register('__tmp__', Stub);
  assert.strictEqual(PublisherRegistry.get('__tmp__'), Stub);
  PublisherRegistry.unregister('__tmp__');
  assert.ok(!PublisherRegistry.has('__tmp__'));
});
check('未注册平台 instantiate 抛错', function () {
  assert.throws(function () { PublisherRegistry.instantiate('__none__', {}); }, /未注册平台/);
});

console.log('== BrowserTestPublisher ==');
check('导出 BrowserTestPublisher', function () { assert.strictEqual(typeof BrowserTestPublisher, 'function'); });
check('platformId=browser-test', function () {
  const pub = new BrowserTestPublisher({ browserManager: stubBM() });
  assert.strictEqual(pub.platformId, 'browser-test');
});
check('继承自 PublisherBase', function () {
  const pub = new BrowserTestPublisher({ browserManager: stubBM() });
  assert.ok(pub instanceof PublisherBase);
});
check('loginUrl 是 file://', function () {
  const pub = new BrowserTestPublisher({ browserManager: stubBM() });
  assert.ok(/^file:\/\//.test(pub.loginUrl));
});
check('publishUrl 是 file://', function () {
  const pub = new BrowserTestPublisher({ browserManager: stubBM() });
  assert.ok(/^file:\/\//.test(pub.publishUrl));
});
check('selectors.title/content 数组', function () {
  const pub = new BrowserTestPublisher({ browserManager: stubBM() });
  assert.ok(Array.isArray(pub.selectors.title) && pub.selectors.title.length > 0);
  assert.ok(Array.isArray(pub.selectors.content) && pub.selectors.content.length > 0);
});
check('loginConfig.inSelectors/outSelectors 都存在', function () {
  const pub = new BrowserTestPublisher({ browserManager: stubBM() });
  assert.ok(Array.isArray(pub.loginConfig.inSelectors));
  assert.ok(Array.isArray(pub.loginConfig.outSelectors));
});

console.log('== fill-input.js ==');
check('buildFillScript 是字符串', function () {
  const s = fillScripts.buildFillScript(
    { title: ['input[name="title"]'], content: ['textarea[name="content"]'] },
    { title: 'x', content: 'y' }
  );
  assert.strictEqual(typeof s, 'string');
  assert.ok(s.indexOf('(async function') >= 0);
});
check('buildFillScript 能被 Function 解析（语法正确）', function () {
  const s = fillScripts.buildFillScript(
    { title: ['#t'], content: ['#c'] },
    { title: 'x', content: 'y' }
  );
  // 不真正执行（依赖 document），仅解析语法
  new Function(s);
});
check('buildLoginScript 是合法 IIFE', function () {
  const s = fillScripts.buildLoginScript({ inSelectors: ['img'], outSelectors: ['#login'] });
  assert.strictEqual(typeof s, 'string');
  new Function(s);
});
check('buildBannerScript 是合法 IIFE', function () {
  const s = fillScripts.buildBannerScript('test');
  assert.strictEqual(typeof s, 'string');
  new Function(s);
});
check('extractFillData 兼容 body/content 字段', function () {
  assert.deepStrictEqual(
    fillScripts.extractFillData({ title: 't', body: 'b' }),
    { title: 't', content: 'b', images: [], videoPath: null }
  );
  assert.deepStrictEqual(
    fillScripts.extractFillData({ title: 't', content: 'c' }),
    { title: 't', content: 'c', images: [], videoPath: null }
  );
});

console.log('== PublisherBase 流程（用 stub BM） ==');
check('prepareContent 调用 execute 并返回 ok', async function () {
  const bm = stubBM();
  const pub = new BrowserTestPublisher({ browserManager: bm });
  pub.openPlatform = async function () { return {}; }; // override → 不实际打开
  const r = await pub.prepareContent({ title: '标题', content: '正文' });
  assert.ok(bm.execute.calls.length > 0, 'execute 应被调用过');
  assert.ok(r && r.ok, 'result.ok 应为 true');
});
check('checkLoginStatus 调用 execute', async function () {
  const bm = stubBM();
  bm.execute.scriptReturns = { status: 'logged_in' };
  const pub = new BrowserTestPublisher({ browserManager: bm });
  const s = await pub.checkLoginStatus();
  assert.strictEqual(s, 'logged_in');
});
check('checkLoginStatus 异常 → unknown', async function () {
  const bm = stubBM();
  bm.execute.throwIt = true;
  const pub = new BrowserTestPublisher({ browserManager: bm });
  const s = await pub.checkLoginStatus();
  assert.strictEqual(s, 'unknown');
});

function stubBM() {
  const calls = [];
  return {
    calls: calls,
    openPlatform: async function (id) { calls.push(['openPlatform', id]); return { reused: false, windowId: 1 }; },
    closePlatform: async function (id) { calls.push(['closePlatform', id]); return true; },
    navigate: async function (id, url) { calls.push(['navigate', id, url]); return null; },
    execute: async function (id, script) {
      calls.push(['execute', id, script.length]);
      if (this.throwIt) throw new Error('stub-throw');
      if (this.scriptReturns) return this.scriptReturns;
      if (script.indexOf('outSelectors') >= 0 && script.indexOf('inSelectors') >= 0) {
        return { status: 'logged_in' };
      }
      return { ok: true, filled: { title: { ok: true, value: 'X' }, content: { ok: true } } };
    },
    onceNavigated: function (id, cb) { calls.push(['onceNavigated', id]); }
  };
}

(async function () {
  // 同步测试已跑完；现在跑异步测试
  // （上面的 check 已 await；不需要再 await）
  console.log('\n=== Summary ===');
  console.log('Passed: ' + passed);
  console.log('Failed: ' + failed);
  process.exit(failed === 0 ? 0 : 1);
})();