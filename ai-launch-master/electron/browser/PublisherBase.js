// Rokit · 平台 Publisher 适配器基类（v1.7）
// ----------------------------------------------------------------
// 设计原则（与需求文档第六、七、十二、十三、十四、二十三条对应）：
//   - 每个具体平台是一个继承 PublisherBase 的类。
//   - 平台只需实现与本平台网页相关的 hooks（selectors / openLoginPage /
//     openPublishPage / checkLoginStatus / waitForLogin / fillTitle /
//     fillContent / uploadImages / uploadVideo / prepareContent）。
//   - 通用生命周期（创建 BrowserWindow / Session 持久化 / 关闭 / 错误处理）
//     由 BrowserManager 负责，Publisher 不直接 new BrowserWindow。
//   - Publisher **绝不在内部自动点击最终发布按钮**（与需求文档第十五条对应）。
//   - 默认 fillTitle / fillContent / 等会通过 BrowserManager 注入通用填充脚本。
'use strict';

var fillScripts = require('./fill-input');

// 简单的 NotImplemented 错误，给开发者明确反馈
function notImplemented(name) {
  return Promise.reject(new Error('Publisher: method not implemented: ' + name));
}

// 默认 select 集合：覆盖常见语义化选择器，平台可覆盖。
// 与需求文档第十条对应：优先 id / name / aria-label / placeholder / data-* / contenteditable。
var DEFAULT_SELECTORS = {
  title: [
    'input[name="title"]',
    'input[id="title"]',
    'input[aria-label*="标题"]',
    'input[aria-label*="Title" i]',
    'input[placeholder*="标题"]',
    'input[placeholder*="Title" i]',
    'input[data-testid*="title" i]',
    'textarea[name="title"]'
  ],
  content: [
    'textarea[name="content"]',
    'textarea[name="body"]',
    'textarea[name="description"]',
    'textarea[id="content"]',
    '[contenteditable="true"]',
    '[role="textbox"]'
  ],
  images: [
    'input[type="file"][accept*="image"]',
    'input[type="file"]'
  ]
};

// 默认登录检测：保守策略，所有平台都应该覆盖
var DEFAULT_LOGIN_CONFIG = {
  // 看到任意"登录入口"则视为未登录
  outSelectors: [
    'a[href*="/login" i]',
    'button[id*="login" i]',
    '[class*="login-btn" i]',
    'input[name="username"]',
    'input[name="password"]'
  ],
  // 看到任意"用户头像 / 用户名 / 退出"则视为已登录
  inSelectors: [
    'img[alt*="avatar" i]',
    'img[class*="avatar" i]',
    'a[href*="/logout" i]',
    '[data-testid*="user" i]'
  ]
};

function PublisherBase(options) {
  if (!options || !options.platformId) {
    throw new Error('PublisherBase: platformId 必填');
  }
  this.platformId = String(options.platformId);
  this.platformName = options.platformName || this.platformId;
  this.browserManager = options.browserManager || null;
  this.logger = options.logger || console;

  // 平台级配置（子类覆盖）
  this.selectors = options.selectors || deepClone(DEFAULT_SELECTORS);
  this.loginConfig = options.loginConfig || deepClone(DEFAULT_LOGIN_CONFIG);
  this.loginUrl = options.loginUrl || null;
  this.publishUrl = options.publishUrl || null;

  // 等待登录超时（毫秒），默认 5 分钟
  this.loginTimeoutMs = options.loginTimeoutMs || 5 * 60 * 1000;
  this.loginPollIntervalMs = options.loginPollIntervalMs || 2000;
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o || {}));
}

// ----------------------------------------------------------------
// 生命周期：登录态检测 / 等待登录 / 填表 / 收尾
// 每个方法在子类里都可以覆盖，下面给出"开箱即用"默认实现。
// ----------------------------------------------------------------

// 打开登录页（让用户手动登录）。子类可覆盖此 URL。
PublisherBase.prototype.openLoginPage = function () {
  if (!this.loginUrl) {
    return Promise.reject(new Error('Publisher[' + this.platformId + ']: 未配置 loginUrl'));
  }
  return this.browserManager.navigate(this.platformId, this.loginUrl);
};

// 打开发布页
PublisherBase.prototype.openPublishPage = function () {
  if (!this.publishUrl) {
    return Promise.reject(new Error('Publisher[' + this.platformId + ']: 未配置 publishUrl'));
  }
  return this.browserManager.navigate(this.platformId, this.publishUrl);
};

// 检查登录状态。返回 'logged_in' / 'logged_out' / 'unknown'。
PublisherBase.prototype.checkLoginStatus = function () {
  var cfg = this.loginConfig;
  var script = fillScripts.buildLoginScript(cfg);
  return this.browserManager.execute(this.platformId, script)
    .then(function (r) {
      var status = (r && r.status) || 'unknown';
      if (status !== 'logged_in' && status !== 'logged_out') return 'unknown';
      return status;
    })
    .catch(function () { return 'unknown'; });
};

// 等待登录完成。带超时（loginTimeoutMs）。不会自动点击任何登录按钮。
PublisherBase.prototype.waitForLogin = function () {
  var self = this;
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    var stopped = false;
    function done(err, val) {
      if (stopped) return;
      stopped = true;
      if (err) reject(err); else resolve(val);
    }
    function tick() {
      if (stopped) return;
      // 监听页面导航（用户登录成功通常会跳转）
      var bc = self.browserManager;
      if (!bc) return done(new Error('BrowserManager not attached'));
      bc.onceNavigated(self.platformId, function () {
        // 跳转后再做一次确认
        setTimeout(function () {
          self.checkLoginStatus().then(function (status) {
            if (status === 'logged_in') return done(null, true);
            if (Date.now() - start > self.loginTimeoutMs) {
              return done(new Error('登录等待超时（' + Math.round(self.loginTimeoutMs / 1000) + 's）'));
            }
            tick();
          });
        }, 800);
      });
      self.checkLoginStatus().then(function (status) {
        if (status === 'logged_in') return done(null, true);
        if (Date.now() - start > self.loginTimeoutMs) {
          return done(new Error('登录等待超时（' + Math.round(self.loginTimeoutMs / 1000) + 's），请重新点击「发射」。'));
        }
        setTimeout(tick, self.loginPollIntervalMs);
      }).catch(function () {
        if (Date.now() - start > self.loginTimeoutMs) {
          return done(new Error('登录等待超时（多次检测失败）'));
        }
        setTimeout(tick, self.loginPollIntervalMs);
      });
    }
    tick();
  });
};

// 填充标题
PublisherBase.prototype.fillTitle = function (text) {
  return this._fillField('title', text);
};

// 填充正文
PublisherBase.prototype.fillContent = function (text) {
  return this._fillField('content', text);
};

// 上传图片（默认占位：当前 BrowserSession 不直接支持文件对话框，
// 平台子类可以覆盖此方法以适配平台特定上传组件）
PublisherBase.prototype.uploadImages = function () {
  return notImplemented('uploadImages');
};

// 上传视频
PublisherBase.prototype.uploadVideo = function () {
  return notImplemented('uploadVideo');
};

// 准备内容（统一入口）。**不**触发最终发布。
PublisherBase.prototype.prepareContent = function (fillData) {
  var self = this;
  var data = fillScripts.extractFillData(fillData || {});
  var script = fillScripts.buildFillScript(this.selectors, data);
  return this.browserManager.execute(this.platformId, script)
    .then(function (r) {
      // 显示「内容已自动填充，请手动确认」横幅
      var banner = fillScripts.buildBannerScript(self.platformName);
      return self.browserManager.execute(self.platformId, banner)
        .catch(function () {})
        .then(function () { return r; });
    });
};

// 关闭浏览器窗口
PublisherBase.prototype.cleanup = function () {
  if (!this.browserManager) return Promise.resolve(false);
  return this.browserManager.closePlatform(this.platformId);
};

// 内部：填一个字段
PublisherBase.prototype._fillField = function (field, text) {
  var script = fillScripts.buildFillScript(
    { title: field === 'title' ? this.selectors.title : [],
      content: field === 'content' ? this.selectors.content : [],
      images: [] },
    { title: field === 'title' ? text : '', content: field === 'content' ? text : '' }
  );
  return this.browserManager.execute(this.platformId, script);
};

module.exports = {
  PublisherBase: PublisherBase,
  DEFAULT_SELECTORS: DEFAULT_SELECTORS,
  DEFAULT_LOGIN_CONFIG: DEFAULT_LOGIN_CONFIG
};