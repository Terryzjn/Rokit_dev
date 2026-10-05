// Rokit · 即刻 Publisher (v1.12 即刻网支持)
// ---------------------------------------------------------------
// 重要约束（与需求文档第十一条、二十条对应）：
//   - 绝对不自动点击 发送 / 发布 / 提交 / 确认发布 按钮。
//   - 不读取 / 保存 / 导出 用户 Cookie / 密码 / 验证码 / token。
//   - 登录态通过 persist:platform-jike 的 Electron Session 自动落盘，
//     与 知乎 (persist:platform-zhihu) / V2EX (persist:platform-v2ex) /
//     掘金 (persist:platform-juejin) 完全隔离。
//   - 复用 PublisherBase / BrowserManager / fillScripts，不重复造轮子。
//   - 即刻 web.okjike.com 是 React SPA，发布输入框是 [contenteditable]，
//     fillce 走 execCommand('insertText') + InputEvent，天然保留换行与 Emoji。
//   - 即刻没有独立 publishUrl —— 登录页与发布页都是首页 https://web.okjike.com/。
//   - 不自动选择圈子 —— 即刻圈子是发布语义的核心，由用户手动选。
//   - 不上传媒体 —— 第一版只支持文字动态。
//
// 流程（由 browser-ipc.runPublish 调度，基类实现）：
//   1. openPlatform('jike')             —— 打开独立 BrowserWindow
//   2. navigate(loginUrl)
//   3. checkLoginStatus()               —— 用 JIKE_SELECTORS 检测
//   4. if logged_out: waitForLogin()    —— 用户自己登录（不输密码、不存密码）
//   5. openPublishPage()                —— 同一首页，跳转再 await
//   6. prepareContent({content})        —— fillce → 内容验证 → banner
//   7. 返回 readyForManual=true，由用户自己点「发送」
//
// 不修改：PublisherBase / BrowserManager / fill-input.js / Zhihu / V2EX / Juejin
'use strict';

const { PublisherBase } = require('../../PublisherBase');
const PublisherRegistry = require('../../PublisherRegistry');
const fillScripts = require('../../fill-input');

// ============================================================
// 1) 即刻配置：URL 集中管理
// ============================================================
const JIKE_CONFIG = {
  platformId:   'jike',
  platformName: '即刻',
  homeUrl:      'https://web.okjike.com/',
  loginUrl:     'https://web.okjike.com/',
  publishUrl:   'https://web.okjike.com/'
};

// ============================================================
// 2) 即刻 selector：所有 selector 集中在这里，即刻改版后只改这里
// ============================================================
// 原则（与需求文档第十条、十七条对应）：
//   - 优先 id / aria-label / placeholder / data-* / [contenteditable]，
//     不依赖随机生成的 css-xxx className（保留 * 含语义片段的兜底）。
//   - 候选按"最稳定 → 最不稳定"排序。
//   - loginIndicators 优先级 > inSelectors（detectLogin 先看未登录标志）。
const JIKE_SELECTORS = {
  // 已登录指示器：看到至少一个视为已登录
  loggedInIndicators: [
    // 顶栏右侧用户区（即刻首页顶部右侧）
    '[class*="user-bar"]',
    '[class*="UserBar"]',
    '[class*="topbar-user"]',
    '[class*="TopBarUser"]',
    '[class*="user-info"]',
    '[class*="UserInfo"]',
    '[class*="user-menu"]',
    '[class*="UserMenu"]',
    // 头像 / 用户主页
    'img[class*="avatar" i]',
    'img[alt*="头像" i]',
    'img[alt*="avatar" i]',
    'a[href*="/user/"]',
    'a[href*="/u/"]',
    'a[href*="/me"]',
    // 登出入口
    'a[href*="logout" i]',
    'a[href*="signout" i]',
    // 发布入口（已登录后才显示）
    '[class*="publish-entry"]',
    '[class*="PublishEntry"]',
    'button[class*="publish" i]',
    '[class*="topbar-publish"]'
  ],

  // 未登录指示器：看到任一即视为未登录（detectLogin 先扫这个清单）
  loginIndicators: [
    // 登录浮层 / 弹窗
    '[class*="login-modal"]',
    '[class*="LoginModal"]',
    '[class*="login-dialog"]',
    '[class*="signin-modal"]',
    '[class*="SigninModal"]',
    '[class*="login-popup"]',
    // 顶栏"登录"按钮
    'button[class*="login-btn"]',
    'button[class*="loginBtn"]',
    '[class*="header-login"]',
    'a[href*="/login"]',
    'a[href*="/signin"]',
    // 第三方登录 / 手机号登录
    '[class*="wechat-login"]',
    '[class*="phone-login"]',
    'input[name="phone"]',
    'input[name="password"]',
    'input[type="tel"]',
    // 验证码输入
    'input[name="code"]',
    'input[name="smsCode"]'
  ],

  // 即刻动态发布输入框
  //   - 即刻 web.okjike.com 首页的"分享你的想法..."是 contenteditable div。
  //   - placeholder 通过 HTML 属性 / data-placeholder / aria-label 实现。
  //   - 候选清单按"最精确 → 最宽松"排序。
  content: [
    // 1. placeholder 含"想法"（即刻当前主输入框）
    '[contenteditable="true"][placeholder*="想法"]',
    '[contenteditable="true"][placeholder*="想法" i]',
    // 2. placeholder 含"分享"
    '[contenteditable="true"][placeholder*="分享"]',
    '[contenteditable="true"][placeholder*="分享" i]',
    // 3. placeholder 含"发布" / "说点什么"
    '[contenteditable="true"][placeholder*="发布"]',
    '[contenteditable="true"][placeholder*="说点什么"]',
    // 4. data-placeholder (CSS / React fake placeholder)
    '[contenteditable="true"][data-placeholder*="想法"]',
    '[contenteditable="true"][data-placeholder*="分享"]',
    // 5. aria-label
    '[contenteditable="true"][aria-label*="想法"]',
    '[contenteditable="true"][aria-label*="分享"]',
    // 6. 即刻可能改成 textarea 的兜底
    'textarea[placeholder*="想法"]',
    'textarea[placeholder*="分享"]',
    'textarea[placeholder*="说点什么"]',
    // 7. role=textbox
    '[role="textbox"]',
    // 8. 兜底：contenteditable / textarea
    '[contenteditable="true"]',
    'textarea'
  ]
};

// ============================================================
// 3) buildJikePrepareScript —— 独立的即刻 prepare 脚本
// ---------------------------------------------------------------
// 设计要点：
//   - 直接复用 fillScripts.RESOLVE_SELECTOR_FN /
//     fillScripts.FILL_CONTENTEDITABLE_FN / fillScripts.SHOW_BANNER_FN
//     三个 IIFE 字符串，不修改 fillScripts。
//   - 不使用 fillScripts.buildFillScript —— 后者在 title / textarea
//     分支有 typo bug（即刻只走 contenteditable，不触发 bug，
//     但还是独立实现以保持路径可控）。
//   - 只走 contenteditable 分支：title 直接跳过，textarea fallback 也不走。
//   - 加内容验证：fillce 后再读一次 ce.textContent，与期望 trim 比较。
//   - 不自动点提交按钮 —— 只显示 banner 提示用户手动确认。
// ============================================================
function buildJikePrepareScript(contentSelectors, fillData) {
  var payload = JSON.stringify({
    contentSelectors: Array.isArray(contentSelectors) ? contentSelectors : [],
    fillData: fillData || { title: '', content: '', images: [] }
  });
  var body =
    '(async function(p){\n' +
    fillScripts.RESOLVE_SELECTOR_FN + '\n' +
    fillScripts.FILL_CONTENTEDITABLE_FN + '\n' +
    fillScripts.SHOW_BANNER_FN + '\n' +
    'var result = { ok: true, filled: {}, verified: false, verifiedReason: "" };\n' +
    'try {\n' +
    '  var ce = resolveOne(p.contentSelectors);\n' +
    '  if (!ce) {\n' +
    '    result.ok = false;\n' +
    '    result.filled.content = { ok: false, error: "content-not-found" };\n' +
    '    result.verified = false;\n' +
    '    result.verifiedReason = "content element not found in DOM";\n' +
    '  } else {\n' +
    '    var cr = fillce({ el: ce, value: p.fillData.content || "" });\n' +
    '    result.filled.content = cr;\n' +
    '    if (!cr.ok) { result.ok = false; }\n' +
    '    var actual = String(ce.textContent || ce.innerText || "").trim();\n' +
    '    var expected = String(p.fillData.content || "").trim();\n' +
    '    if (expected.length === 0) {\n' +
    '      result.verified = true;\n' +
    '    } else if (actual === expected) {\n' +
    '      result.verified = true;\n' +
    '    } else {\n' +
    '      var lenDiff = Math.abs(actual.length - expected.length);\n' +
    '      if (lenDiff <= 2) {\n' +
    '        result.verified = true;\n' +
    '        result.verifiedReason = "len-tolerance(" + lenDiff + ")";\n' +
    '      } else {\n' +
    '        result.verified = false;\n' +
    '        result.verifiedReason = "content-mismatch: actualLen=" +\n' +
    '          actual.length + " expectedLen=" + expected.length;\n' +
    '      }\n' +
    '    }\n' +
    '  }\n' +
    '} catch (e) {\n' +
    '  result.ok = false;\n' +
    '  result.error = String((e && e.message) || e);\n' +
    '  result.verified = false;\n' +
    '  result.verifiedReason = "exception: " + result.error;\n' +
    '}\n' +
    'showBanner("即刻");\n' +
    'return result;\n' +
    '})(' + payload + ')';
  return body;
}

// ============================================================
// 4) JikePublisher —— 即刻适配器
// ============================================================
class JikePublisher extends PublisherBase {
  constructor(opts) {
    super(Object.assign({
      platformId:   'jike',
      platformName: '即刻',
      loginUrl:    JIKE_CONFIG.loginUrl,
      publishUrl:  JIKE_CONFIG.publishUrl,
      selectors: {
        title:   [],   // 即刻第一版不支持标题
        content: JIKE_SELECTORS.content.slice(),
        images:  []
      },
      loginConfig: {
        inSelectors:  JIKE_SELECTORS.loggedInIndicators.slice(),
        outSelectors: JIKE_SELECTORS.loginIndicators.slice()
      },
      // 即刻 SPA 路由切换比较慢，给个宽松超时
      loginTimeoutMs:     5 * 60 * 1000,
      loginPollIntervalMs: 2500
    }, opts || {}));
  }

  openLoginPage() {
    this.logger.info('[JikePublisher] Opening Jike login page', {
      platformId: this.platformId,
      url: this.loginUrl
    });
    return super.openLoginPage();
  }

  openPublishPage() {
    this.logger.info('[JikePublisher] Opening Jike publish page', {
      platformId: this.platformId,
      url: this.publishUrl
    });
    return super.openPublishPage();
  }

  // 覆盖：先走 fillScripts.detectLogin（DOM 启发式），unknown 时再用 URL 启发式
  checkLoginStatus() {
    var self = this;
    var script = fillScripts.buildLoginScript(this.loginConfig);
    return this.browserManager.execute(this.platformId, script)
      .then(function (r) {
        var s = (r && r.status) || 'unknown';
        if (s === 'logged_in' || s === 'logged_out') return s;
        return self.browserManager.execute(self.platformId,
          '(function(){return location.href||"";})()')
          .then(function (url) {
            url = String(url || '');
            if (/okjike\.com\/(login|signin|signup|oauth)/i.test(url)) return 'logged_out';
            if (/okjike\.com\/(user|u|me|creator)/i.test(url))   return 'logged_in';
            return 'unknown';
          })
          .catch(function () { return 'unknown'; });
      });
  }

  waitForLogin() {
    this.logger.info('[JikePublisher] Waiting for login (timeout=' +
      Math.round(this.loginTimeoutMs / 1000) + 's)');
    return super.waitForLogin();
  }

  // 覆盖 prepareContent：走 buildJikePrepareScript 并打详细日志
  // 严格按照需求第九节日志格式：
  //   [Jike] content filling started
  //   [Jike] content filled (随 verification passed/failed 合并输出)
  //   [Jike] content verification passed / failed
  prepareContent(fillData) {
    var self = this;
    var data = fillScripts.extractFillData(fillData || {});
    this.logger.info('[Jike] content filling started', {
      platformId: self.platformId,
      titleLen:   data.title.length,
      contentLen: data.content.length,
      imageCount: data.images.length
    });
    var script = buildJikePrepareScript(self.selectors.content, data);
    return self.browserManager.execute(self.platformId, script)
      .then(function (r) {
        var ok = !!(r && r.ok);
        var verified = !!(r && r.verified);
        var reason = verified
          ? (r.verifiedReason || 'ok')
          : (r.verifiedReason || (r.error || 'unknown'));
        var contentLen = (r && r.filled && r.filled.content && r.filled.content.length) || 0;
        self.logger.info(
          verified ? '[Jike] content verification passed' : '[Jike] content verification failed',
          {
            ok: ok,
            verified: verified,
            contentLen: contentLen,
            reason: verified ? 'len-tolerance-or-exact' : reason
          }
        );
        // 关键信号：返回 readyForManual=true，明确告知调用方"已停手，等用户点发送"
        return Object.assign({}, r, {
          readyForManual: true,
          note: '即刻第一版不自动提交。请手动选择圈子、添加附件并点击「发送」按钮确认。',
          hostName: 'web.okjike.com'
        });
      });
  }

  // 覆盖 fillTitle：即刻第一版不支持标题
  fillTitle(text) {
    this.logger.info('[JikePublisher] Title is ignored (即刻第一版不支持标题)', {
      platformId: this.platformId,
      length: String(text || '').length
    });
    return Promise.resolve({ ok: true, skipped: true, reason: 'jike-v1-no-title' });
  }

  // 不重写 click / clickSubmit —— 基类默认不发提交，需求文档第十一条强约束。
  // 不重写 triggerClick —— 基类默认不调。
}

PublisherRegistry.register('jike', JikePublisher);

module.exports = {
  JikePublisher:            JikePublisher,
  JIKE_CONFIG:              JIKE_CONFIG,
  JIKE_SELECTORS:           JIKE_SELECTORS,
  buildJikePrepareScript:   buildJikePrepareScript
};