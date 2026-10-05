// Rokit · V2EX Publisher（v1.9）
// ----------------------------------------------------------------
// 重要约束（与需求文档第十五、十七、二十一、二十三、二十七条对应）：
//   - **绝对不自动点击** "创建主题" / "发布" / "Send" 按钮。
//   - **不读取**用户密码 / 验证码 / Cookie 内容（不绕过 V2EX 安全机制）。
//   - 登录态通过 persist:platform-v2ex 的 Electron Session 自动落盘。
//   - Selector / URL 集中到 V2EX_SELECTORS / V2EX_CONFIG；V2EX 改版后只改这两个常量。
//   - 不修改 V2EX 实际 DOM（不修改别人的 localStorage、不修改 iframe 来源）。
//   - 与 ZhihuPublisher 走完全相同的架构（继承 PublisherBase + 复用
//     BrowserManager + 复用 fillScripts 工具），不重写浏览器框架。
//
// ⚠ 关于实测：
//   V2EX 与知乎不同，**V2EX 是非常朴素的论坛，页面结构稳定**：
//   - 主页 https://www.v2ex.com/ 顶栏直接显示登录表单（用户名/密码 <form action="/signin">）。
//   - 创建主题页 https://www.v2ex.com/new/<node> 用标准 HTML：
//       <form method="POST" action="/new/<node>">
//         <input name="title" class="topic-tab" tabindex="1" />
//         <textarea name="content" class="topic-tab" rows="15" tabindex="2"></textarea>
//         <input type="submit" value="创建主题" />
//       </form>
//     因此本实现**优先复用基类 fillScripts.buildFillScript**，不再额外等待（V2EX 页面是
//     服务端渲染，DOM 直接就绪），只用 zhihuPrepare 同源的"等+填+验证"模板覆盖
//     prepareContent 以满足需求文档第十三章"等 DOM → 填 → 验证"流程。
//
//   我**没有在沙盒里**启动 GUI Electron / 真实打开 V2EX / 真实登录 V2EX 做端到端实测。
//   实际 selector 是否命中必须由你本机 GUI 实测后确认。
//
// 流程（由上一阶段 runPublish 调度）：
//   1. openPlatform('v2ex')               —— 打开独立 partition 的 BrowserWindow
//   2. checkLoginStatus()                  —— 用 V2EX_SELECTORS 检测登录态
//   3. if logged_out: openLoginPage → waitForLogin
//   4. openPublishPage(publishUrl)         —— 跳到 https://www.v2ex.com/new/<node>
//   5. prepareContent({title, content})     —— waitForSelector → fillTitle → fillContent → verify
//   6. 显示 banner「V2EX 内容已自动填充，请手动点击「创建主题」按钮确认」
//
// 本类只覆盖 openLoginPage / openPublishPage / checkLoginStatus /
// waitForLogin / fillTitle / fillContent / prepareContent / cleanup。
// 其它方法（uploadImages / uploadVideo）继承 PublisherBase 默认占位实现。
'use strict';

const { PublisherBase } = require('../../PublisherBase');
const PublisherRegistry = require('../../PublisherRegistry');
const fillScripts = require('../../fill-input');

// ============================================================
// V2EX 配置：URL 集中管理
// ============================================================
// V2EX 的真实页面结构：
//   - 主页             https://www.v2ex.com/
//   - 登录表单         直接在主页顶栏（<form action="/signin" method="post">），
//                     所以 loginUrl 与 homeUrl 同地址即可。
//   - 新建主题页       https://www.v2ex.com/new/<node>
//                     必须在已登录态下访问；节点名是路径子词。
//                     候选节点（按常用度）：python, javascript, programmer, life, tech, jobs
//   - 顶栏"创作"入口  https://www.v2ex.com/quit/write
//                     V2EX 也提供该 URL 作为"快速创作"入口；登录态下 V2EX 会自动重定向
//                     到当前账号默认节点的 new/<node> 页面。
//
// 默认 publishUrl 优先选 python 节点（V2EX 最具代表性的节点）；若用户默认节点不是
// python，可把 publishUrl 改为 https://www.v2ex.com/quit/write 让 V2EX 自动重定向。
// 也可以在 BrowserManager 配置里覆盖。
const V2EX_CONFIG = {
  homeUrl:    'https://www.v2ex.com/',
  // V2EX 主页本身就显示登录表单，所以"登录页"就是主页
  loginUrl:   'https://www.v2ex.com/',
  // 快速创作入口（登录态下会自动重定向到 /new/<default_node>）
  quitWriteUrl: 'https://www.v2ex.com/quit/write',
  // 默认发布页：python 节点。V2EX 最常见、技术性最强的节点
  publishUrl: 'https://www.v2ex.com/new/python',
  // 兜底：如果 python 失效，可以换 programmer / javascript / tech
  jobsUrl:    'https://www.v2ex.com/new/programmer',
  jsUrl:      'https://www.v2ex.com/new/javascript'
};

// ============================================================
// V2EX selector：所有 selector 集中在这里，V2EX 改版后只改这里
// ============================================================
// 原则（与需求文档第十条对应）：
//   - 优先 id / name / aria-label / placeholder / data-* / contenteditable
//   - 候选清单按"最稳定 → 最不稳定"排序
//   - V2EX 是开源、稳定、朴素的论坛，可以放心使用 name 属性（name="title" / name="content"）
const V2EX_SELECTORS = {
  // 已登录指示：V2EX 页面出现这些元素至少一个就视为已登录
  loggedInIndicators: [
    // 顶栏右侧用户名链接（<a href="/member/<username>">username</a>）
    'a[href^="/member/"]',
    // 顶栏"登出"链接
    'a[href*="/signout"]',
    'a[href*="/logout"]',
    // 顶栏设置链接（已登录专属）
    'a[href^="/settings"]',
    // 顶栏"通知"链接（已登录专属）
    'a[href^="/notifications"]',
    // 顶栏"创作 / Write"链接（已登录专属；/quit/write 入口在已登录后会显示）
    'a[href*="/quit/write"]',
    'a[href*="/new/"]',
    // 顶栏用户头像区（V2EX 是 <img src="//v2ex.com/avatar/...>）
    'img[src*="/avatar/"]',
    // 顶栏货币中心（已登录专属）
    'a[href^="/balance"]',
    'a[href*="/mission/daily"]'
  ],

  // 未登录指示：V2EX 页面出现这些元素就视为未登录
  loginIndicators: [
    // V2EX 主页登录表单：用户名 / 密码
    'input[name="u"]',
    'input[name="p"]',
    // 顶栏 "Sign In / 登录" 链接
    'a[href*="/signin"]',
    'a[href*="/login"]',
    'a[href*="/signup"]'
  ],

  // 标题输入框（V2EX 创建主题页面）
  // 真实 DOM：<input tabindex="1" class="topic-tab" type="text" name="title" />
  // name 属性是最稳定的（服务端表单字段）；class .topic-tab 是 V2EX 稳定的非随机 class
  title: [
    'input[name="title"]',
    'input.topic-tab',
    'input[class*="topic-tab"]',
    'input[id="topic-title"]',
    'input[id*="title" i]',
    // 兜底
    'input[placeholder*="标题"]',
    'textarea[name="title"]'
  ],

  // 正文编辑器（V2EX 创建主题页面）
  // 真实 DOM：<textarea tabindex="2" class="topic-tab" name="content" rows="15"></textarea>
  // V2EX 的正文是**普通 textarea**（不是 contenteditable），所以填充最容易：
  // 标准 fillScripts.fillInput 即可正确处理。
  content: [
    'textarea[name="content"]',
    'textarea.topic-tab',
    'textarea[class*="topic-tab"]',
    'textarea[rows="15"]',
    'textarea[id*="content" i]',
    // 兜底
    'textarea[placeholder*="正文"]',
    'textarea'
  ]
};

// ============================================================
// "在页面里跑"的复合 IIFE —— 用于 V2EXPublisher.prepareContent：
//   1) 等待 title / content 选择器可见（最多 N 次 × intervalMs 毫秒）
//   2) 调用通用 fillInput（V2EX 是 <textarea>，标准 fillScripts 100% 兼容）
//   3) readBack：读实际 DOM 内容做校验
//   4) 返回 { ok, found: { title, content }, filled, verified }
//   5) **绝不**点击 submit / 任何按钮
// ============================================================
// 与 ZhihuPublisher 的 buildZhihuPrepareScript 同源；差异：
//   - 仅处理 <textarea> / <input>（不做 contenteditable 分支，因为 V2EX 是 textarea）
//   - 调用 fillScripts.FILL_INPUT_FN 一次即可
function buildV2exPrepareScript(payload) {
  // payload = { titleSelectors, contentSelectors, fillData, waitTimeoutMs }
  return '(' +
    'async function v2exPrepare(p){\n' +
    '  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    // 复用 fillScripts.RESOLVE_SELECTOR_FN
    fillScripts.RESOLVE_SELECTOR_FN + '\n' +
    // 复用 fillScripts.FILL_INPUT_FN
    fillScripts.FILL_INPUT_FN + '\n' +
    '  function filter(resolved){\n' +
    '    // 与 fillScripts.FILL_INPUT_FN 同源（直接复制一份避免再次序列化子问题）\n' +
    '    var el = resolved.el;\n' +
    '    if(!el) return { ok:false, error:"input-not-found" };\n' +
    '    if(typeof el.focus === "function") el.focus();\n' +
    '    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;\n' +
    '    var setter = Object.getOwnPropertyDescriptor(proto, "value");\n' +
    '    if(setter && setter.set) setter.set.call(el, String(resolved.value || ""));\n' +
    '    else el.value = String(resolved.value || "");\n' +
    '    el.dispatchEvent(new InputEvent("input", { bubbles:true, cancelable:true, data:String(resolved.value||""), inputType:"insertText" }));\n' +
    '    el.dispatchEvent(new Event("change", { bubbles:true }));\n' +
    '    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, cancelable:true }));\n' +
    '    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, cancelable:true }));\n' +
    '    if(typeof el.blur === "function") el.blur();\n' +
    '    return { ok:true, value: el.value, name: el.name || el.id || "" };\n' +
    '  }\n' +
    '  // 等待可见\n' +
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
    '  // 等标题\n' +
    '  var te = await waitVisible(t, wm);\n' +
    '  result.found.title = !!te;\n' +
    '  if(!te){\n' +
    '    result.ok = false;\n' +
    '    result.filled.title = { ok: false, error: "title-not-found" };\n' +
    '  } else {\n' +
    '    var tr = filter({ el: te, value: String(fd.title || "") });\n' +
    '    result.filled.title = tr;\n' +
    '    if(!tr.ok) result.ok = false;\n' +
    '  }\n' +
    '  // 等正文（V2EX 是 textarea，filter 同样适用）\n' +
    '  var ce = await waitVisible(c, wm);\n' +
    '  result.found.content = !!ce;\n' +
    '  if(!ce){\n' +
    '    result.ok = false;\n' +
    '    result.filled.content = { ok: false, error: "content-not-found" };\n' +
    '  } else {\n' +
    '    var cr = filter({ el: ce, value: String(fd.content || "") });\n' +
    '    result.filled.content = cr;\n' +
    '    if(!cr.ok) result.ok = false;\n' +
    '  }\n' +
    '  // readBack 验证\n' +
    '  if(te && result.filled.title && result.filled.title.ok){\n' +
    '    var actualT = (te.value || te.textContent || ""); \n' +
    '    result.verified.title = { expected: String(fd.title || ""), actual: actualT, match: actualT === String(fd.title || "") };\n' +
    '  }\n' +
    '  if(ce && result.filled.content && result.filled.content.ok){\n' +
    '    var actualC = (ce.value || ce.textContent || ""); \n' +
    '    result.verified.content = { expected: String(fd.content || ""), actual: actualC, match: actualC === String(fd.content || "") };\n' +
    '  }\n' +
    '  return result;\n' +
    '}' +
    ')(' + JSON.stringify(payload) + ')';
}

// =====================================================================
// V2EXPublisher：V2EX 平台适配器
// =====================================================================
class V2EXPublisher extends PublisherBase {
  constructor(opts) {
    super(Object.assign({
      platformId: 'v2ex',
      platformName: 'V2EX',
      loginUrl: V2EX_CONFIG.loginUrl,
      publishUrl: V2EX_CONFIG.publishUrl,
      // 多 selector fallback；V2EX 改版后只改这里
      selectors: {
        title: V2EX_SELECTORS.title.slice(),
        content: V2EX_SELECTORS.content.slice(),
        images: ['input[type="file"][accept*="image"]', 'input[type="file"]']
      },
      // 登录态检测（基类 checkLoginStatus 用）
      loginConfig: {
        inSelectors: V2EX_SELECTORS.loggedInIndicators.slice(),
        outSelectors: V2EX_SELECTORS.loginIndicators.slice()
      },
      // V2EX 页面是同步加载（服务端渲染），但保险起见仍给 5 分钟
      loginTimeoutMs: 5 * 60 * 1000,
      loginPollIntervalMs: 2500
    }, opts || {}));
  }

  // 覆盖入口方法（仅是为了日志更明显，便于以后观察）
  openLoginPage() {
    this.logger.info('[V2EXPublisher] Opening V2EX login page', {
      platformId: this.platformId,
      url: this.loginUrl
    });
    return super.openLoginPage();
  }

  openPublishPage() {
    this.logger.info('[V2EXPublisher] Opening V2EX publish page', {
      platformId: this.platformId,
      url: this.publishUrl
    });
    return super.openPublishPage();
  }

  // 覆盖 checkLoginStatus：除了 DOM 指示器，再加一个 URL 启发式判断
  // V2EX 未登录时主页顶栏显示 input[name="u"] 与 input[name="p"]，
  // 已登录时顶栏显示用户名链接 (/member/<name>) 与 /signout。
  // 未知态时，使用 URL 启发式：登录页 = 主页，登录后进入任意页面都不会跳回主页。
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
          // V2EX 未登录访问 /new/<node> 会被跳回主页
          if (/v2ex\.com\/signin|\/login/i.test(url)) return 'logged_out';
          if (/v2ex\.com\//i.test(url)) return 'logged_in';
          return 'unknown';
        })
        .catch(function () { return 'unknown'; });
    });
  }

  // 覆盖 waitForLogin：基类已经支持，但是每 2.5s 检测一次，可以直接复用
  // 这里只额外打日志便于观察
  waitForLogin() {
    this.logger.info('[V2EXPublisher] Waiting for login (timeout ' +
      Math.round(this.loginTimeoutMs / 1000) + 's)');
    return super.waitForLogin();
  }

  // 覆盖 fillTitle / fillContent：用通用基类实现，但打日志
  fillTitle(text) {
    this.logger.info('[V2EXPublisher] Filling title', {
      platformId: this.platformId,
      length: String(text || '').length
    });
    return super.fillTitle(text);
  }

  fillContent(text) {
    this.logger.info('[V2EXPublisher] Filling content', {
      platformId: this.platformId,
      length: String(text || '').length
    });
    return super.fillContent(text);
  }

  // 重写 prepareContent：V2EX 创建主题页通常是同步加载，
  // 但保险起见仍然走 "等待 + 填 + 验证" 的复合 IIFE（与 ZhihuPublisher 同模式）。
  // V2EX 的正文是 <textarea>，所以 IIFE 比知乎的简化：不需要 contenteditable 分支。
  prepareContent(fillData) {
    var self = this;
    var data = fillScripts.extractFillData(fillData || {});
    this.logger.info('[V2EXPublisher] Preparing content', {
      platformId: this.platformId,
      titleLen: data.title.length,
      contentLen: data.content.length
    });

    // 第一步：等 title/content DOM 出现，然后填充
    var script = buildV2exPrepareScript({
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

        self.logger.info('[V2EXPublisher] Content preparation completed', {
          platformId: self.platformId,
          ok: ok,
          foundTitle: foundTitle,
          foundContent: foundContent,
          verifiedTitle: verifiedTitle,
          verifiedContent: verifiedContent,
          filled: r && r.filled
        });

        // 显示 banner（复用 fillScripts.buildBannerScript）
        var bannerScript = fillScripts.buildBannerScript('V2EX');
        return self.browserManager.execute(self.platformId, bannerScript)
          .catch(function () {})
          .then(function () {
            return Object.assign({}, r, {
              banner: 'V2EX 内容已自动填充，请手动点击「创建主题」按钮确认。',
              // 如果 DOM 找到但 verify 不通过（例如前端组件未同步 state），warn 但不假装 ok
              verifiedTitle: !!verifiedTitle,
              verifiedContent: !!verifiedContent
            });
          });
      });
  }
}

// 注册到 registry（默认即生效）
PublisherRegistry.register('v2ex', V2EXPublisher);

module.exports = {
  V2EXPublisher: V2EXPublisher,
  V2EX_CONFIG: V2EX_CONFIG,
  V2EX_SELECTORS: V2EX_SELECTORS
};