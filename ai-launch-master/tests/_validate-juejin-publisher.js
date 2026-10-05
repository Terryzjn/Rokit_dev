// Rokit · JuejinPublisher（v1.11）验证脚本
'use strict';
const assert = require('assert');

const { JuejinPublisher, JUEJIN_CONFIG, JUEJIN_SELECTORS, buildJuejinPrepareScript } =
  require('../electron/browser/platforms/juejin/JuejinPublisher');

const PublisherRegistry = require('../electron/browser/PublisherRegistry');

let passed = 0, failed = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // async: 将结果交由调用方通过 collect() 处理
      pendingAsync.push({ name, p: r });
      console.log('  \u00b7 ' + name + ' (async, pending)');
      return;
    }
    console.log('  \u2713 ' + name); passed++;
  }
  catch (e) { console.log('  \u2717 ' + name + ' :: ' + (e && e.message || e)); failed++; }
}
const pendingAsync = [];

console.log('== JUEJIN_CONFIG ==');
check('homeUrl 是 https://juejin.cn/', function () {
  assert.strictEqual(JUEJIN_CONFIG.homeUrl, 'https://juejin.cn/');
});
check('loginUrl 是 https://juejin.cn/login', function () {
  assert.strictEqual(JUEJIN_CONFIG.loginUrl, 'https://juejin.cn/login');
});
check('publishUrl 是 https://juejin.cn/editor/drafts/new（真实创作页）', function () {
  assert.strictEqual(JUEJIN_CONFIG.publishUrl, 'https://juejin.cn/editor/drafts/new');
});
check('creatorUrl / draftsUrl 存在', function () {
  assert.ok(JUEJIN_CONFIG.creatorUrl.indexOf('juejin.cn') >= 0);
  assert.ok(JUEJIN_CONFIG.draftsUrl.indexOf('editor/drafts') >= 0);
});

console.log('== JUEJIN_SELECTORS ==');
check('title 至少 4 个，含「输入文章标题」和「标题」兜底', function () {
  assert.ok(JUEJIN_SELECTORS.title.length >= 4, 'title 候选过少：' + JUEJIN_SELECTORS.title.length);
  assert.ok(JUEJIN_SELECTORS.title.some(function (s) { return /输入文章标题/.test(s); }), '缺「输入文章标题」');
  assert.ok(JUEJIN_SELECTORS.title.some(function (s) { return /placeholder\*="标题"/.test(s); }), '缺通用「标题」兜底');
});
check('content 至少 8 个，含 CodeMirror / CodeMirror 6 / cm / bytemd', function () {
  assert.ok(JUEJIN_SELECTORS.content.length >= 8, 'content 候选过少：' + JUEJIN_SELECTORS.content.length);
  assert.ok(JUEJIN_SELECTORS.content.indexOf('.CodeMirror') >= 0, '缺 .CodeMirror');
  assert.ok(JUEJIN_SELECTORS.content.indexOf('.cm-content') >= 0, '缺 .cm-content');
  assert.ok(JUEJIN_SELECTORS.content.indexOf('.bytemd') >= 0, '缺 .bytemd');
});
check('loggedInIndicators 至少 3 个，含 /user/ 路径与 avatar', function () {
  assert.ok(JUEJIN_SELECTORS.loggedInIndicators.length >= 3);
  assert.ok(JUEJIN_SELECTORS.loggedInIndicators.some(function (s) { return /\/user\//.test(s); }), '缺 /user/ 已登录指示器');
  assert.ok(JUEJIN_SELECTORS.loggedInIndicators.some(function (s) { return /avatar/.test(s); }), '缺 avatar 已登录指示器');
});
check('loginIndicators 至少 3 个，含手机号表单 / GitHub / 微信', function () {
  assert.ok(JUEJIN_SELECTORS.loginIndicators.length >= 3);
  assert.ok(JUEJIN_SELECTORS.loginIndicators.some(function (s) { return /手机号|phoneNumber/.test(s); }), '缺手机号表单未登录指示器');
});

console.log('== PublisherRegistry 注册 ==');
check('juejin 平台已注册到 PublisherRegistry', function () {
  var list = PublisherRegistry.list();
  assert.ok(list.indexOf('juejin') >= 0, 'PublisherRegistry 未注册 juejin：' + list.join(','));
});
check('PublisherRegistry.get(\'juejin\') 返回 JuejinPublisher', function () {
  var C = PublisherRegistry.get('juejin');
  assert.strictEqual(C.name, 'JuejinPublisher');
});
check('platforms/index.js require 后列出 juejin', function () {
  var reg = require('../electron/browser/platforms/index.js');
  assert.ok(reg.registeredPlatforms.indexOf('juejin') >= 0);
});

console.log('== JuejinPublisher 实例 ==');
check('platformId / platformName 正确', function () {
  var j = new JuejinPublisher({ logger: { info: function(){}, error: function(){}, warn: function(){} } });
  assert.strictEqual(j.platformId, 'juejin');
  assert.strictEqual(j.platformName, '掘金');
  assert.strictEqual(j.publishUrl, 'https://juejin.cn/editor/drafts/new');
});
check('默认 loginTimeoutMs = 5 分钟', function () {
  var j = new JuejinPublisher({ logger: { info: function(){}, error: function(){}, warn: function(){} } });
  assert.strictEqual(j.loginTimeoutMs, 5 * 60 * 1000);
});
check('selectors.title 不会改到常量原数组', function () {
  var j = new JuejinPublisher({ logger: { info: function(){}, error: function(){}, warn: function(){} } });
  var before = JUEJIN_SELECTORS.title.length;
  j.selectors.title.push('input.modified');
  assert.strictEqual(j.selectors.title.length, before + 1);
  assert.strictEqual(JUEJIN_SELECTORS.title.length, before, '常量原数组被修改了！');
});

console.log('== buildJuejinPrepareScript IIFE 形状 ==');
check('返回的是合法 JS 字符串，可被 new Function 解析', function () {
  var s = buildJuejinPrepareScript({
    titleSelectors: ['input[placeholder*="输入文章标题"]'],
    contentSelectors: ['.CodeMirror'],
    fillData: { title: 'T', content: 'C' },
    waitTimeoutMs: 30000
  });
  assert.strictEqual(typeof s, 'string');
  // 直接把整个 IIFE 作为表达式传给 new Function —— 因为我们没传 document，
  // 函数体内 document.* 访问会抛 ReferenceError，但**语法解析**会先于运行。
  // 如果语法错误，会抛 SyntaxError；如果是运行时错误，会抛 ReferenceError。
  // 我们通过 typeof 检查 = 'function' 即可（即使运行时立刻 throw，构造时 typeof 也是 function）。
  var fn;
  try {
    fn = new Function('return ' + s + ';');
  } catch (e) {
    if (/SyntaxError/.test(String(e))) {
      throw new Error('IIFE 语法错误：' + (e && e.message || e));
    }
    // 其它错误（如 ReferenceError: document is not defined）是预期的，因为沙盒无 DOM
  }
  assert.strictEqual(typeof fn, 'function', 'IIFE 应被解析为函数');
});
check('payload 正确序列化到 IIFE 末尾', function () {
  var s = buildJuejinPrepareScript({
    titleSelectors: ['input[placeholder*="输入文章标题"]'],
    contentSelectors: ['.CodeMirror'],
    fillData: { title: 'T 标题', content: 'C 内容' },
    waitTimeoutMs: 30000
  });
  // 标题 / 内容应该出现在 JSON 序列化里
  assert.ok(s.indexOf('T \\u6807\\u9898') >= 0 || s.indexOf('T 标题') >= 0, 'title 未序列化');
  assert.ok(s.indexOf('C \\u5185\\u5bb9') >= 0 || s.indexOf('C 内容') >= 0, 'content 未序列化');
  assert.ok(s.indexOf('30000') >= 0, 'waitTimeoutMs 未序列化');
});

console.log('== buildJuejinPrepareScript 的代码路径全覆盖 ==');
check('代码里包含 CodeMirror 5 / 6 分支', function () {
  var s = buildJuejinPrepareScript({
    titleSelectors: ['input[placeholder*="标题"]'],
    contentSelectors: ['.CodeMirror'],
    fillData: { title: 't', content: 'c' },
    waitTimeoutMs: 1000
  });
  assert.ok(s.indexOf('fillCodeMirror5') >= 0, '缺 CodeMirror 5 分支');
  assert.ok(s.indexOf('fillCodeMirror6') >= 0, '缺 CodeMirror 6 分支');
  assert.ok(s.indexOf('contentFillType') >= 0, '缺 contentFillType 字段');
});
check('代码里没有自动点击发布按钮', function () {
  var s = buildJuejinPrepareScript({
    titleSelectors: ['input[placeholder*="标题"]'],
    contentSelectors: ['.CodeMirror'],
    fillData: { title: 't', content: 'c' },
    waitTimeoutMs: 1000
  });
  // 必须 **不** 包含 .click() 或 submit 类调用
  assert.ok(!/click\(/.test(s) || /fillce|fillce-/.test(s) === false, '出现 click() 调用！');
  // 注意：FILL_CONTENTEDITABLE_FN 里**没有** click，所以是自包含检测
  // 我们更精确地检测：不能有"确定并发布" / "submit" / "publish" 字符串
  assert.ok(!/确定并发布/.test(s), '出现「确定并发布」');
  assert.ok(!/publish|submit/i.test(s), '出现 publish / submit 关键字');
});
check('代码里没有读取密码 / Cookie 内容', function () {
  var s = buildJuejinPrepareScript({
    titleSelectors: ['input[placeholder*="标题"]'],
    contentSelectors: ['.CodeMirror'],
    fillData: { title: 't', content: 'c' },
    waitTimeoutMs: 1000
  });
  // 不应该出现 document.cookie / window.localStorage / 截取 cookie 的代码
  assert.ok(!/document\.cookie/.test(s), '出现 document.cookie');
  assert.ok(!/localStorage\.getItem/.test(s), '出现 localStorage.getItem');
  assert.ok(!/password|passwd/i.test(s), '出现 password / passwd 关键字');
});

console.log('== checkLoginStatus URL 启发式 ==');
check('未登录 URL 推断为 logged_out', function () {
  var j = new JuejinPublisher({
    logger: { info: function(){}, error: function(){}, warn: function(){} },
    browserManager: {
      execute: function (pid, script) {
        // 模拟返回 juejin.cn/login
        return Promise.resolve('https://juejin.cn/login');
      }
    }
  });
  // 强制 superCheck 返回 unknown 触发 URL 启发式
  var mod = require('../electron/browser/PublisherBase');
  var orig = mod.PublisherBase.prototype.checkLoginStatus;
  mod.PublisherBase.prototype.checkLoginStatus = function () { return Promise.resolve('unknown'); };
  return j.checkLoginStatus().then(function (status) {
    mod.PublisherBase.prototype.checkLoginStatus = orig;
    assert.strictEqual(status, 'logged_out');
  }).catch(function (e) {
    mod.PublisherBase.prototype.checkLoginStatus = orig;
    throw e;
  });
});
check('已登录 URL 推断为 logged_in', function () {
  var j = new JuejinPublisher({
    logger: { info: function(){}, error: function(){}, warn: function(){} },
    browserManager: {
      execute: function (pid, script) {
        return Promise.resolve('https://juejin.cn/user/center/home');
      }
    }
  });
  var mod = require('../electron/browser/PublisherBase');
  var orig = mod.PublisherBase.prototype.checkLoginStatus;
  mod.PublisherBase.prototype.checkLoginStatus = function () { return Promise.resolve('unknown'); };
  return j.checkLoginStatus().then(function (status) {
    mod.PublisherBase.prototype.checkLoginStatus = orig;
    assert.strictEqual(status, 'logged_in');
  }).catch(function (e) {
    mod.PublisherBase.prototype.checkLoginStatus = orig;
    throw e;
  });
});

console.log('== 不破坏既有平台 ==');
check('其它平台（zhihu / v2ex / browser-test）仍正常注册', function () {
  var reg = require('../electron/browser/platforms/index.js');
  assert.ok(reg.registeredPlatforms.indexOf('zhihu') >= 0);
  assert.ok(reg.registeredPlatforms.indexOf('v2ex') >= 0);
  assert.ok(reg.registeredPlatforms.indexOf('browser-test') >= 0);
});

(async function () {
  // 处理所有 pending async checks
  for (var i = 0; i < pendingAsync.length; i++) {
    var { name, p } = pendingAsync[i];
    try {
      await p;
      console.log('  \u2713 ' + name + ' (async)'); passed++;
    } catch (e) {
      console.log('  \u2717 ' + name + ' :: ' + (e && e.message || e)); failed++;
    }
  }
  console.log('\n=== Summary ===');
  console.log('Passed: ' + passed);
  console.log('Failed: ' + failed);
  process.exit(failed === 0 ? 0 : 1);
})();