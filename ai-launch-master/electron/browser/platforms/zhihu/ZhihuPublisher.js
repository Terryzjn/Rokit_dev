// Rokit · 知乎 Publisher（v1.8）
// ----------------------------------------------------------------
// 重要约束（与需求文档第十五、十七、二十一、二十三、二十七条对应）：
//   - **绝对不自动点击** "发布/提交" 按钮（与 v1.7 通用框架一致）。
//   - **不读取**用户密码 / 验证码 / Cookie 内容（不绕过知乎安全机制）。
//   - 登录态通过 persist:platform-zhihu 的 Electron Session 自动落盘。
//   - Selector / URL 集中到 ZHIHU_SELECTORS / ZHIHU_CONFIG；知乎改版后只改这两个常量。
//   - 不修改知乎实际 DOM（不修改别人的 localStorage、不修改 iframe 来源）。
//
// ⚠ 关于实测：
//   本文件中的 selector 与 URL 是基于公开页面快照（历史版本）+ 知乎常用约定
//   （placeholder 标题、"RichText" 编辑器类名等）得出的**保守候选清单**，
//   必须在使用本机的 GUI Electron 环境实测后才能确认。**沙盒无 GUI**，
//   我无法替你实测。首次实测时若某个 selector 不命中：
//     1) 打开 Electron 内置浏览器手动到 https://www.zhihu.com/creator/article/edit
//     2) 在 DevTools 用 document.querySelector 找真实标题输入框的 selector
//     3) 更新本文件 ZHIHU_SELECTORS.title 列表
//   不需要改测试按钮 / 流程代码。
//
// 流程（由上一阶段 runPublish 调度）：
//   1. openPlatform('zhihu')               —— 打开独立 partition 的 BrowserWindow
//   2. checkLoginStatus()                  —— 用 ZHIHU_SELECTORS 检测登录态
//   3. if logged_out: openLoginPage → waitForLogin
//   4. openPublishPage(publishUrl)         —— 跳到写文章页
//   5. prepareContent({title, content})     —— waitForSelector(title+content) → fillTitle → fillContent → verify
//   6. 显示 banner「知乎内容已自动填充，请手动点击发布按钮确认」
//
// 本类只覆盖 openLoginPage / openPublishPage / checkLoginStatus /
// waitForLogin / fillTitle / fillContent / prepareContent / cleanup。
// 其它方法（uploadImages / uploadVideo）继承 PublisherBase 默认占位实现。
'use strict';

const { PublisherBase } = require('../../PublisherBase');
const PublisherRegistry = require('../../PublisherRegistry');
const fillScripts = require('../../fill-input');

// ============================================================
// 知乎配置：URL 集中管理
// ============================================================
// 知乎的 URL 路径相对稳定，但页面版本会更新。如果 publishUrl 失效，
// 备选候选：https://zhuanlan.zhihu.com/write 或 https://zhuanlan.zhihu.com/p/write
const ZHIHU_CONFIG = {
  homeUrl: 'https://www.zhihu.com/',
  loginUrl: 'https://www.zhihu.com/signin',
  creatorUrl: 'https://www.zhihu.com/creator',
  // 知乎当前"写文章"页（new UI 在 2023-2024 重做后使用这个）
  publishUrl: 'https://www.zhihu.com/creator/article/edit',
  // 备用：旧版知乎专栏写文章
  answerUrl: 'https://www.zhihu.com/creator/answer'
};

// ============================================================
// 知乎 selector：所有 selector 集中在这里，知乎改版后只改这里
// ============================================================
// 原则（与需求文档第十条对应）：
//   - 优先 id / name / aria-label / placeholder / data-* / contenteditable
//   - 候选清单按"最稳定 → 最不稳定"排序
//   - 同一个元素的多 selector 用「逗号分隔的字符串」或「数组」
//   - 知乎的随机 class（如 css-xxxxxx）一律不进入本表
const ZHIHU_SELECTORS = {
  // 已登录指示：知乎页面出现这些元素至少一个就视为已登录
  loggedInIndicators: [
    // 用户头像
    'img[class*="Avatar"]:not([class*="Avatar-logo"])',
    'img.Avatar',
    '.Avatar',
    // 个人主页链接（出现在顶栏头像区）
    'a[href*="/people/"]',
    // 顶栏"我"按钮
    '.AppHeader-profileEntry',
    'button[class*="Profile"]',
    // 创作中心"我的"按钮
    '[data-zh-nav*="profile"]',
    'a[href*="/creator/manage"]'
  ],

  // 未登录指示：知乎页面出现这些元素就视为未登录
  loginIndicators: [
    // 知乎登录页：账号密码表单
    '.SignFlow-tab',
    '.SignFlow-passwordInput',
    '.SignFlow-accountInput',
    '.SignFlow-input',
    // 知乎登录页：登录按钮
    'button[class*="SignFlow-submitButton"]',
    'button[class*="SignFlow"]',
    // 知乎登录页：手机/邮箱/微信切换 Tab
    'div[class*="QRLogin"]',
    // 兜底
    'input[placeholder*="手机号"]',
    'input[placeholder*="邮箱"]',
    'input[placeholder*="账号"]'
  ],

  // 标题输入框（知乎写文章页面）
  // 知乎新版：input/textarea with placeholder="请输入文章标题"
  // 知乎旧版：input.WriteInput
  title: [
    'input[placeholder*="请输入文章标题"]',
    'textarea[placeholder*="请输入文章标题"]',
    'input[placeholder*="文章标题"]',
    'textarea[placeholder*="文章标题"]',
    'input.WriteInput',
    'textarea.WriteInput',
    'input[class*="WriteInput"]',
    'textarea[class*="WriteInput"]',
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
    // 兜底
    'input[name="title"]',
    '#title'
  ],

  // 正文编辑器（知乎通常使用 Draft.js / 自研 contenteditable）
  // 知乎新版：.RichText (外层) + .RichText [contenteditable="true"] (内层真正可编辑)
  // 知乎旧版：textarea[name="content"]
  content: [
    '.RichText [contenteditable="true"]',
    '.RichText',
    '[contenteditable="true"][placeholder*="文章"]',
    '[contenteditable="true"][placeholder*="正文"]',
    '[contenteditable="true"][placeholder*="回答"]',
    '[contenteditable="true"][placeholder*="想法"]',
    '[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    // 旧版知乎专栏
    'textarea[name="content"]',
    'textarea[placeholder*="正文"]',
    'textarea[placeholder*="内容"]',
    // 兜底
    '[role="textbox"]',
    'textarea#content'
  ]
};

// ============================================================
// "在页面里跑"的复合 IIFE —— 用于 ZhihuPublisher.prepareContent：
//   1) 等待 title / content 选择器可见（最多 N 次 × intervalMs 毫秒）
//   2) 调用 fillTitle / fillContent
//   3) readBack：读实际 DOM 内容做校验
//   4) 返回 { ok, found: { title, content }, filled, verified }
//   5) **绝不**点击 submit / publishButton
// ============================================================
function buildZhihuPrepareScript(payload) {
  // payload = { titleSelectors, contentSelectors, fillData, waitTimeoutMs }
  return '(' +
    'async function zhihuPrepare(p){\n' +
    '  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    '  // 1) resolveSelector（与 fill-input.js 同源逻辑，但允许允许搜索不可见元素以便 debug）\n' +
    fillScripts.RESOLVE_SELECTOR_FN + '\n' +
    '  // 2) 等待可见\n' +
    '  async function waitVisible(selectors, totalMs){\n' +
    '    var start = Date.now();\n' +
    '    while(Date.now() - start < totalMs){\n' +
    '      var el = resolveOne(selectors);\n' +
    '      if(el) return el;\n' +
    '      await sleep(500);\n' +
    '    }\n' +
    '    return null;\n' +
    '  }\n' +
    '  var t = p.titleSelectors || [];\n' +
    '  var c = p.contentSelectors || [];\n' +
    '  var fd = p.fillData || {};\n' +
    '  var wm = Number(p.waitTimeoutMs || 30000);\n' +
    '  var result = { ok: true, found: { title: false, content: false }, filled: {}, verified: {} };\n' +
    '  // 3) 等标题\n' +
    '  var te = await waitVisible(t, wm);\n' +
    '  result.found.title = !!te;\n' +
    '  if(!te){\n' +
    '    result.ok = false;\n' +
    '    result.filled.title = { ok: false, error: "title-not-found" };\n' +
    '  } else {\n' +
    '    var proto = te.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;\n' +
    '    var setter = Object.getOwnPropertyDescriptor(proto, "value");\n' +
    '    if(setter && setter.set) setter.set.call(te, String(fd.title || ""));\n' +
    '    else te.value = String(fd.title || "");\n' +
    '    te.dispatchEvent(new InputEvent("input", { bubbles:true, cancelable:true, data:String(fd.title||""), inputType:"insertText" }));\n' +
    '    te.dispatchEvent(new Event("change", { bubbles:true }));\n' +
    '    te.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, cancelable:true }));\n' +
    '    te.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, cancelable:true }));\n' +
    '    te.dispatchEvent(new Event("blur", { bubbles:true }));\n' +
    '    result.filled.title = { ok: true, value: te.value || "" };\n' +
    '  }\n' +
    '  // 4) 等正文\n' +
    '  var ce = await waitVisible(c, wm);\n' +
    '  result.found.content = !!ce;\n' +
    '  if(!ce){\n' +
    '    result.ok = false;\n' +
    '    result.filled.content = { ok: false, error: "content-not-found" };\n' +
    '  } else {\n' +
    '    var tag = ce.tagName;\n' +
    '    if(tag === "TEXTAREA"){\n' +
    '      var setter2 = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");\n' +
    '      if(setter2 && setter2.set) setter2.set.call(ce, String(fd.content || ""));\n' +
    '      else ce.value = String(fd.content || "");\n' +
    '      ce.dispatchEvent(new InputEvent("input", { bubbles:true, cancelable:true, data:String(fd.content||""), inputType:"insertText" }));\n' +
    '      ce.dispatchEvent(new Event("change", { bubbles:true }));\n' +
    '      ce.dispatchEvent(new Event("blur", { bubbles:true }));\n' +
    '      result.filled.content = { ok: true, length: (ce.value || "").length };\n' +
    '    } else {\n' +
    '      // contenteditable：用 selectAll + insertText（execCommand）\n' +
    '      try { document.execCommand("selectAll", false, null); } catch(_e) {}\n' +
    '      var ok2 = false;\n' +
    '      try { ok2 = document.execCommand("insertText", false, String(fd.content || "")); } catch(_e) { ok2 = false; }\n' +
    '      if(!ok2){\n' +
    '        // 兜底：直接 textContent（不破坏内嵌 HTML，仅用于"非框架"的页面）\n' +
    '        ce.textContent = String(fd.content || "");\n' +
    '        ce.dispatchEvent(new InputEvent("input", { bubbles:true, cancelable:true }));\n' +
    '        ce.dispatchEvent(new Event("change", { bubbles:true }));\n' +
    '      }\n' +
    '      ce.dispatchEvent(new Event("blur", { bubbles:true }));\n' +
    '      var txt = (ce.textContent || ce.innerText || "");\n' +
    '      result.filled.content = { ok: true, length: txt.length, sample: txt.slice(0, 50) };\n' +
    '    }\n' +
    '  }\n' +
    '  // 5) readBack 验证（read actual DOM 与预期对比）\n' +
    '  if(te && result.filled.title && result.filled.title.ok){\n' +
    '    var actualT = (te.value || te.textContent || ""); \n' +
    '    result.verified.title = { expected: String(fd.title || ""), actual: actualT, match: actualT === String(fd.title || "") };\n' +
    '  }\n' +
    '  if(ce && result.filled.content && result.filled.content.ok){\n' +
    '    var actualC = (ce.tagName === "TEXTAREA") ? (ce.value || "") : (ce.textContent || ce.innerText || "");\n' +
    '    result.verified.content = { expected: String(fd.content || ""), actual: actualC, match: actualC === String(fd.content || "") };\n' +
    '  }\n' +
    '  return result;\n' +
    '}' +
    ')(' + JSON.stringify(payload) + ')';
}

// =====================================================================
// ZhihuPublisher：知乎平台适配器
// =====================================================================
class ZhihuPublisher extends PublisherBase {
  constructor(opts) {
    super(Object.assign({
      platformId: 'zhihu',
      platformName: '知乎',
      loginUrl: ZHIHU_CONFIG.loginUrl,
      publishUrl: ZHIHU_CONFIG.publishUrl,
      // 多 selector fallback；知乎改版后只改这里
      selectors: {
        title: ZHIHU_SELECTORS.title.slice(),
        content: ZHIHU_SELECTORS.content.slice(),
        images: ['input[type="file"][accept*="image"]', 'input[type="file"]']
      },
      // 登录态检测（基类 checkLoginStatus 用）
      loginConfig: {
        inSelectors: ZHIHU_SELECTORS.loggedInIndicators.slice(),
        outSelectors: ZHIHU_SELECTORS.loginIndicators.slice()
      },
      // 知乎登录/创作页可能加载较慢，给一个相对宽松的超时
      loginTimeoutMs: 5 * 60 * 1000,
      loginPollIntervalMs: 2500
    }, opts || {}));
  }

  // 覆盖入口方法（仅是为了日志更明显，便于以后观察）
  openLoginPage() {
    this.logger.info('[ZhihuPublisher] Opening Zhihu login page', {
      platformId: this.platformId,
      url: this.loginUrl
    });
    return super.openLoginPage();
  }

  openPublishPage() {
    this.logger.info('[ZhihuPublisher] Opening Zhihu publish page', {
      platformId: this.platformId,
      url: this.publishUrl
    });
    return super.openPublishPage();
  }

  // 覆盖 checkLoginStatus：除了 DOM 指示器，再加一个 URL 启发式判断
  // 知乎未登录时 URL 会被 redirect 到 https://www.zhihu.com/signin
  // 知乎已登录时 URL 通常是 https://www.zhihu.com/ 或 https://www.zhihu.com/creator
  checkLoginStatus() {
    var self = this;
    var superCheck = PublisherBase.prototype.checkLoginStatus.bind(self);
    return superCheck().then(function (status) {
      if (status === 'logged_in' || status === 'logged_out') return status;
      // 状态 unknown 时，再用 URL 启发式做一次判定
      var script = '(function(){ return location.href||""; })()';
      return self.browserManager.execute(self.platformId, script)
        .then(function (url) {
          url = String(url || '');
          if (/zhihu\.com\/(signin|signin_)/i.test(url)) return 'logged_out';
          if (/zhihu\.com\//i.test(url)) return 'logged_in';
          return 'unknown';
        })
        .catch(function () { return 'unknown'; });
    });
  }

  // 覆盖 waitForLogin：基类已经支持，但是每 2.5s 检测一次，可以直接复用
  // 这里只额外打日志便于观察
  waitForLogin() {
    this.logger.info('[ZhihuPublisher] Waiting for login (timeout ' +
      Math.round(this.loginTimeoutMs / 1000) + 's)');
    return super.waitForLogin();
  }

  // 覆盖 fillTitle / fillContent：用通用基类实现，但打日志
  fillTitle(text) {
    this.logger.info('[ZhihuPublisher] Filling title', {
      platformId: this.platformId,
      length: String(text || '').length
    });
    return super.fillTitle(text);
  }

  fillContent(text) {
    this.logger.info('[ZhihuPublisher] Filling content', {
      platformId: this.platformId,
      length: String(text || '').length
    });
    return super.fillContent(text);
  }

  // 重写 prepareContent：知乎的写文章页是异步加载，
  // 直接复用基类 fillTitle+fillContent 可能会因为 DOM 还没就绪而失败。
  // 这里换成 "等待 + 填 + 验证" 的复合 IIFE。
  prepareContent(fillData) {
    var self = this;
    var data = fillScripts.extractFillData(fillData || {});
    this.logger.info('[ZhihuPublisher] Preparing content', {
      platformId: this.platformId,
      titleLen: data.title.length,
      contentLen: data.content.length
    });

    // 第一步：等 title/content DOM 出现，然后填充
    var script = buildZhihuPrepareScript({
      titleSelectors: this.selectors.title,
      contentSelectors: this.selectors.content,
      fillData: data,
      waitTimeoutMs: 30000
    });
    return this.browserManager.execute(this.platformId, script)
      .then(function (r) {
        var ok = !!(r && r.ok);
        var foundTitle = !!(r && r.found && r.found.title);
        var foundContent = !!(r && r.found && r.found.content);
        var verifiedTitle = r && r.verified && r.verified.title && r.verified.title.match;
        var verifiedContent = r && r.verified && r.verified.content && r.verified.content.match;

        self.logger.info('[ZhihuPublisher] Content preparation completed', {
          platformId: self.platformId,
          ok: ok,
          foundTitle: foundTitle,
          foundContent: foundContent,
          verifiedTitle: verifiedTitle,
          verifiedContent: verifiedContent,
          filled: r && r.filled
        });

        // 显示 banner
        var bannerScript = fillScripts.buildBannerScript('知乎');
        return self.browserManager.execute(self.platformId, bannerScript)
          .catch(function () {})
          .then(function () {
            return Object.assign({}, r, {
              banner: '知乎内容已自动填充，请手动点击「发布」按钮确认。',
              // 如果 DOM 找到但 verify 不通过（例如知乎前端组件未同步 state），warn 但不假装 ok
              verifiedTitle: !!verifiedTitle,
              verifiedContent: !!verifiedContent
            });
          });
      });
  }
}

// 注册到 registry（默认即生效）
PublisherRegistry.register('zhihu', ZhihuPublisher);

module.exports = {
  ZhihuPublisher: ZhihuPublisher,
  ZHIHU_CONFIG: ZHIHU_CONFIG,
  ZHIHU_SELECTORS: ZHIHU_SELECTORS
};