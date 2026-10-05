// Rokit · BrowserTestPublisher（v1.7）
// ----------------------------------------------------------------
// 与需求文档第八、二十二条对应：
//   - 用于测试整个「内置浏览器 + 登录态持久化 + 自动填充」框架。
//   - 测试页面：file:// 指向 electron/browser/platforms/test-page.html
//   - 该 Publisher **绝不自动点击**提交按钮，仅自动填标题/正文。
//   - 页面加载后显示「内容已自动填充，请手动确认」横幅。
'use strict';

const path = require('path');
const { PublisherBase } = require('../PublisherBase');
const PublisherRegistry = require('../PublisherRegistry');

class BrowserTestPublisher extends PublisherBase {
  constructor(opts) {
    super(Object.assign({
      platformId: 'browser-test',
      platformName: '内置浏览器测试',
      // 测试页面用 file://，这样不依赖任何外网
      loginUrl: pathToFileUrl(path.join(__dirname, 'test-page.html')),
      publishUrl: pathToFileUrl(path.join(__dirname, 'test-page.html')),
      // 测试页面有 username/password 字段，但**我们不读它们的值**
      loginConfig: {
        // 已登录指示：测试页面在 localStorage 写入 rokit_logged_in=1 时视为已登录
        inSelectors: ['[data-rokit-state="logged-in"]'],
        // 未登录指示：测试页面的"模拟登录"表单
        outSelectors: ['#rokit-test-login-form', 'input[name="username"]:not([type="hidden"])']
      },
      selectors: {
        title: [
          'input[name="title"]',
          '#title',
          'input[id="title"]',
          'input[placeholder*="标题" i]',
          'input[aria-label*="标题"]'
        ],
        content: [
          'textarea[name="content"]',
          '#content',
          'textarea[id="content"]',
          '[contenteditable="true"]'
        ]
      },
      loginTimeoutMs: 30000,
      pollIntervalMs: 1500
    }, opts || {}));
  }

  // 测试 Publisher 直接复用父类 fillTitle / fillContent；
  // 这里只是显式覆盖以便后续调试日志更明显。
  fillTitle(text) {
    this.logger.info('[Publisher] Filling title', { platformId: this.platformId });
    return super.fillTitle(text);
  }
  fillContent(text) {
    this.logger.info('[Publisher] Filling content', { platformId: this.platformId });
    return super.fillContent(text);
  }
}

// file:// URL 转换（Windows 兼容：把 C:\foo\bar.html 转为 file:///C:/foo/bar.html）
function pathToFileUrl(p) {
  if (!p) return null;
  var abs = path.resolve(p).replace(/\\/g, '/');
  if (!abs.startsWith('/')) abs = '/' + abs;
  return 'file://' + abs;
}

// 注册到 registry（默认就生效）
PublisherRegistry.register('browser-test', BrowserTestPublisher);
// 同时提供不带连字符的别名
PublisherRegistry.register('test', BrowserTestPublisher);

module.exports = {
  BrowserTestPublisher: BrowserTestPublisher,
  pathToFileUrl: pathToFileUrl
};