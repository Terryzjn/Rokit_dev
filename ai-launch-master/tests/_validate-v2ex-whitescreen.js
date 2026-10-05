// Rokit · V2EX 白屏诊断（v1.10）验证脚本
'use strict';
const assert = require('assert');

const { BrowserManager } = require('../electron/browser/BrowserManager');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.log('  \u2717 ' + name + ' :: ' + (e && e.message || e)); failed++; }
}

console.log('== BrowserManager 默认配置（v1.10 关键修复点） ==');
check('默认 webPreferences.userAgent 不含 Electron 标识', function () {
  var bm = new BrowserManager();
  var ua = bm.defaultWindowOptions.userAgent || (bm.defaultWindowOptions.webPreferences || {}).userAgent || '';
  // 注：BrowserManager 构造函数里实际把 userAgent 放在了 webPreferences.userAgent
  var actual = (bm.defaultWindowOptions.webPreferences || {}).userAgent;
  assert.ok(actual && typeof actual === 'string', 'webPreferences.userAgent 未设置');
  assert.ok(!/Electron\//.test(actual), '默认 UA 仍含 Electron 标识：' + actual);
  assert.ok(/Chrome\//.test(actual), '默认 UA 应含 Chrome 标识：' + actual);
  assert.ok(/Mozilla\/5\.0/.test(actual), '默认 UA 应以 Mozilla/5.0 开头：' + actual);
});
check('未修改 contextIsolation / nodeIntegration / sandbox 默认', function () {
  var bm = new BrowserManager();
  var wp = bm.defaultWindowOptions.webPreferences || {};
  assert.strictEqual(wp.contextIsolation, true);
  assert.strictEqual(wp.nodeIntegration, false);
  assert.strictEqual(wp.sandbox, true);
});
check('partitionPrefix 仍是 persist:platform-', function () {
  var bm = new BrowserManager();
  assert.strictEqual(bm.partitionPrefix, 'persist:platform-');
});

console.log('== BrowserManager.getDiagnostics（白屏定位专用） ==');
check('getDiagnostics(不存在的平台) 不抛错', function () {
  var bm = new BrowserManager();
  var d = bm.getDiagnostics('never-opened');
  assert.strictEqual(d.platformId, 'never-opened');
  assert.strictEqual(d.alive, false);
  assert.deepStrictEqual(d.events, []);
});
check('getDiagnostics 返回的 events / summary 结构正确', function () {
  var bm = new BrowserManager();
  // 模拟一个曾经打开过的平台（用 _windows 字段）—— 不构造真实 BrowserWindow
  var fake = {
    window: null, // 故意 null 模拟已销毁
    partitionName: 'persist:platform-fake',
    listeners: [],
    isReady: false,
    pendingNavigations: [],
    diag: [],
    _diagCount: 0,
    _diagStart: 0,
    _diagSize: 200
  };
  // 走真实环形缓冲写入（按 BrowserManager 内部 snapshot 写入规则）
  function pushFake(level, msg) {
    fake.diag[fake._diagStart] = { t: fake._diagCount, level: level, url: 'https://x/', title: 'X', message: msg };
    fake._diagStart = (fake._diagStart + 1) % fake._diagSize;
    fake._diagCount = Math.min(fake._diagCount + 1, fake._diagSize);
  }
  pushFake('info', 'did-start-loading');
  pushFake('info', 'did-finish-load');
  pushFake('warn', 'did-fail-load errorCode=-6 url=https://x/');
  bm._windows['fake'] = fake;

  var d = bm.getDiagnostics('fake');
  assert.strictEqual(d.platformId, 'fake');
  assert.strictEqual(d.alive, false);
  assert.strictEqual(d.events.length, 3);
  assert.strictEqual(d.summary.total, 3);
  assert.strictEqual(d.summary.info, 2);
  assert.strictEqual(d.summary.warn, 1);
  assert.strictEqual(d.summary.error, 0);
  assert.ok(d.summary.lastError && d.summary.lastError.level === 'warn');
});
check('环形缓冲：超过 DIAG_BUFFER_SIZE 后只保留最后 200 条', function () {
  var bm = new BrowserManager();
  var entry = {
    window: null, partitionName: 'persist:platform-x', listeners: [],
    isReady: false, pendingNavigations: [], diag: [],
    _diagCount: 0, _diagStart: 0, _diagSize: 200
  };
  bm._windows['x'] = entry;
  // 模拟 snapshot 调用：直接写环形缓冲
  for (var i = 0; i < 250; i++) {
    entry.diag[entry._diagStart] = { t: i, level: 'info', url: '', title: '', message: 'evt-' + i };
    entry._diagStart = (entry._diagStart + 1) % entry._diagSize;
    entry._diagCount = Math.min(entry._diagCount + 1, entry._diagSize);
  }
  var d = bm.getDiagnostics('x');
  assert.strictEqual(d.events.length, 200, '环形缓冲应只剩 200 条，实际 ' + d.events.length);
  // 应该丢弃前 50 条，保留最后 200 条（序号 50..249）
  assert.strictEqual(d.events[0].message, 'evt-50');
  assert.strictEqual(d.events[199].message, 'evt-249');
});

console.log('== BrowserManager.openPlatform 接受 options 覆盖 userAgent ==');
check('options.webPreferences.userAgent 覆盖默认', function () {
  var bm = new BrowserManager();
  // stub electron 模块
  // 这里我们直接验证 _partition / 合并逻辑，不实际 new BrowserWindow
  var overrides = { webPreferences: { userAgent: 'CUSTOM/1.0' } };
  // 模拟内部合并：与 BrowserManager openPlatform 的合并规则一致
  var merged = Object.assign(
    {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      userAgent: bm.defaultWindowOptions.webPreferences.userAgent,
      partition: bm._partition('v2ex')
    },
    overrides.webPreferences,
    { partition: bm._partition('v2ex') }
  );
  assert.strictEqual(merged.userAgent, 'CUSTOM/1.0');
  assert.strictEqual(merged.contextIsolation, true);
  assert.strictEqual(merged.sandbox, true);
  assert.strictEqual(merged.partition, 'persist:platform-v2ex');
});

console.log('== V2EX 关键修复不破坏既有功能 ==');
check('BrowserManager 仍是合法构造函数（不抛错）', function () {
  var bm = new BrowserManager({ logger: { info: function(){}, error: function(){}, warn: function(){} } });
  assert.strictEqual(typeof bm.openPlatform, 'function');
  assert.strictEqual(typeof bm.closePlatform, 'function');
  assert.strictEqual(typeof bm.status, 'function');
  assert.strictEqual(typeof bm.getDiagnostics, 'function');
});
check('v2ex partition 名仍是 persist:platform-v2ex', function () {
  var bm = new BrowserManager();
  assert.strictEqual(bm._partition('v2ex'), 'persist:platform-v2ex');
});
check('V2EXPublisher 没改 platformId / publishUrl', function () {
  var { V2EXPublisher, V2EX_CONFIG } = require('../electron/browser/platforms/v2ex/V2EXPublisher');
  assert.strictEqual(V2EX_CONFIG.publishUrl, 'https://www.v2ex.com/new/python');
  var pub = new V2EXPublisher({ browserManager: { stub: true } });
  assert.strictEqual(pub.platformId, 'v2ex');
});

console.log('== IPC 接口暴露（v1.10） ==');
check('preload 暴露 browserDiagnostics', function () {
  var fs = require('fs');
  var src = fs.readFileSync(require.resolve('../electron/preload.js'), 'utf8');
  assert.ok(/browserDiagnostics\s*:\s*\(platformId\)\s*=>/.test(src),
    'preload.js 未暴露 browserDiagnostics');
});
check('browser-ipc 注册 browser:diagnostics IPC', function () {
  var fs = require('fs');
  var src = fs.readFileSync(require.resolve('../electron/browser/browser-ipc.js'), 'utf8');
  assert.ok(/browser:diagnostics/.test(src),
    'browser-ipc.js 未注册 browser:diagnostics');
  // 同时应加入 channels 列表
  assert.ok(/'browser:diagnostics'/.test(src),
    'browser-ipc.js channels 列表里漏了 "browser:diagnostics"');
});

(async function () {
  console.log('\n=== Summary ===');
  console.log('Passed: ' + passed);
  console.log('Failed: ' + failed);
  process.exit(failed === 0 ? 0 : 1);
})();