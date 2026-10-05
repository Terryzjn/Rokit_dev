// Rokit · 掘金 Publisher（v1.11）
// ----------------------------------------------------------------
// 重要约束（与需求文档第十五、十七、二十一、二十三、二十七条对应）：
//   - **绝对不自动点击** "确定并发布" / "发布" / "Submit" 按钮。
//   - **不读取**用户手机号 / 验证码 / 密码 / Cookie 内容（不绕过掘金安全机制）。
//   - 登录态通过 persist:platform-juejin 的 Electron Session 自动落盘。
//   - Selector / URL 集中到 JUEJIN_SELECTORS / JUEJIN_CONFIG；掘金改版后只改这两个常量。
//   - 不修改掘金实际 DOM（不修改别人的 localStorage、不修改 iframe 来源）。
//   - 与 ZhihuPublisher / V2EXPublisher 走完全相同的架构（继承 PublisherBase +
//     复用 BrowserManager + 复用 fillScripts 工具），不重写浏览器框架。
//
// ⚠ 关于实测：
//   本文件中的 selector 与 URL 是基于公开页面快照（flydean/blog-auto-publishing-tools
//   自动化实现版 / 2024-05 博客文章）+ 掘金官方页面结构（ByteMD / CodeMirror 编辑器）
//   推导出的**保守候选清单**，必须在使用本机的 GUI Electron 环境实测后才能确认。
//   **沙盒无 GUI**，我无法替你实测。首次实测时若某个 selector 不命中：
//     1) 打开 Electron 内置浏览器手动到 https://juejin.cn/editor/drafts/new
//     2) 在 DevTools 用 document.querySelector 找真实标题输入框 / 编辑器的 selector
//     3) 更新本文件 JUEJIN_SELECTORS 列表
//   不需要改测试按钮 / 流程代码。
//
// 关键特殊点（与知乎 / V2EX 不同）：
//   - 掘金的正文编辑器是 **CodeMirror / ByteMD**（不是 contenteditable div，也不是
//     <textarea>）。CodeMirror 内部的真实 textarea 是被隐藏的；CodeMirror 实例
//     通过 .CodeMirror 元素上的 .CodeMirror 字段暴露（CM5），或通过 .cm-content 上挂
//     的 EditorView 暴露（CM6 / ByteMD 1.x）。
//   - 掘金登录态**只能**通过独立持久化 partition（persist:platform-juejin）保存；
//     登录方式：手机号 + 验证码 / GitHub OAuth / 微信扫码。**不读取**用户输入的
//     验证码 / 密码。
//   - 写文章入口有两个：
//       A) 主页右侧 "创作者中心 → 写文章" 下拉菜单中的"写文章"
//       B) 直接 URL: https://juejin.cn/editor/drafts/new （已登录后能直接进入）
//     本实现**优先用 (B)**，省去菜单点击步骤；如果 (B) 被重定向到登录页，
//     则说明用户未登录，让用户手动登录后会自动回到写文章页。
//
// 流程（由上一阶段 runPublish 调度）：
//   1. openPlatform('juejin')               —— 打开独立 partition 的 BrowserWindow
//   2. checkLoginStatus()                  —— 用 JUEJIN_SELECTORS 检测登录态
//   3. if logged_out: openLoginPage → waitForLogin
//   4. openPublishPage(publishUrl)         —— 跳到 https://juejin.cn/editor/drafts/new
//   5. prepareContent({title, content})     —— waitForSelector → fillTitle → fillContent → verify
//   6. 显示 banner「掘金内容已自动填充，请手动点击「确定并发布」按钮确认」
//
// 本类只覆盖 openLoginPage / openPublishPage / checkLoginStatus /
// waitForLogin / fillTitle / fillContent / prepareContent / cleanup。
// 其它方法（uploadImages / uploadVideo）继承 PublisherBase 默认占位实现。
'use strict';

const { PublisherBase } = require('../../PublisherBase');
const PublisherRegistry = require('../../PublisherRegistry');
const fillScripts = require('../../fill-input');

// ============================================================
// 掘金配置：URL 集中管理
// ============================================================
// 掘金当前（2024-2026）的页面结构：
//   - 主页                https://juejin.cn/
//   - 登录页              https://juejin.cn/login （掘金登录是弹窗式，未登录访问受保护页
//                                          时会在主页弹出登录浮层）
//   - 创作者中心              https://juejin.cn/user/center/home
//   - 写文章（新建草稿）      https://juejin.cn/editor/drafts/new
//   - 草稿箱              https://juejin.cn/editor/drafts
//
// 注：掘金写文章编辑器是基于 ByteMD 的 Markdown 编辑器；写作目标是** Markdown 内容**。
// 因此本实现的 fillData.content 是 Markdown 字符串（与 V2EX / Zhihu 一致）。
const JUEJIN_CONFIG = {
  homeUrl:        'https://juejin.cn/',
  // 掘金登录页（登录是弹窗形式）
  loginUrl:       'https://juejin.cn/login',
  // 创作者中心
  creatorUrl:     'https://juejin.cn/user/center/home',
  // 写文章入口（直接 URL，登录后会落到新建草稿编辑器）
  publishUrl:     'https://juejin.cn/editor/drafts/new',
  // 草稿箱（用户管理自己的草稿）
  draftsUrl:      'https://juejin.cn/editor/drafts'
};

// ============================================================
// 掘金 selector：所有 selector 集中在这里，掘金改版后只改这里
// ============================================================
// 原则（与需求文档第十条对应）：
//   - 优先 id / name / aria-label / placeholder / data-* / contenteditable
//   - 候选清单按"最稳定 → 最不稳定"排序
//   - 掘金使用 className 混淆 css-xxxxxx 的风格很少，但仍要避免使用
//   - CodeMirror / ByteMD 编辑器的内部 className（如 .CodeMirror, .cm-content）
//     是**稳定**的，可以放心使用
const JUEJIN_SELECTORS = {
  // 已登录指示：掘金页面出现这些元素至少一个就视为已登录
  loggedInIndicators: [
    // 顶栏右侧的用户头像（掘金常用 class="user-menu" 包裹头像）
    '[class*="user-menu"]',
    '[class*="avatar"]',
    'img[class*="avatar"]',
    // 个人主页链接（出现在顶栏头像区）—— 掘金个人主页路径 /user/<id>
    'a[href*="/user/"]',
    // 顶栏右上角的下拉按钮（已登录专属）
    '[class*="header-user"]',
    '[class*="user-info"]',
    // 创作者中心入口（已登录专属）
    'a[href*="/user/center"]',
    'a[href*="creator"]',
    // 草稿箱入口（已登录专属）
    'a[href*="/editor/drafts"]',
    // 登出 / 设置（已登录专属）
    'a[href*="logout"]',
    'a[href*="signout"]'
  ],

  // 未登录指示：掘金页面出现这些元素就视为未登录
  loginIndicators: [
    // 掘金登录弹窗 / 登录页
    'button[class*="login-btn"]',
    '[class*="login-modal"]',
    'input[name="phoneNumber"]',
    'input[placeholder*="手机号"]',
    'input[placeholder*="验证码"]',
    'button[class*="send-code"]',
    // GitHub 登录按钮（掘金登录弹窗里通常有）
    'button[class*="github-login"]',
    'a[href*="github.com/login/oauth"]',
    // 微信扫码登录按钮
    'button[class*="wechat-login"]',
    '[class*="wechat"]',
    // 顶栏"登录" / "注册"按钮
    'a[href*="/login"]',
    'button[class*="header-login"]',
    // 兜底
    'input[type="tel"]',
    'input[name="username"]',
    'input[name="password"]'
  ],

  // 标题输入框（掘金写文章页面）
  // 掘金的标题 placeholder 是"输入文章标题..."（flydean 实现 2024-05 已确认）；
  // 后续改版可能微调，因此保留宽松的子串匹配。
  title: [
    // 2024-2026 主流 placeholder（保守子串匹配，避免末尾 "..." 误差）
    'input[placeholder*="输入文章标题"]',
    'textarea[placeholder*="输入文章标题"]',
    'input[placeholder*="文章标题"]',
    'textarea[placeholder*="文章标题"]',
    // 掘金有时用 contenteditable 容器作为标题（React 组件可能切到 contenteditable）
    '[contenteditable="true"][placeholder*="标题"]',
    '[contenteditable="true"][data-placeholder*="标题"]',
    // 旧版 / 改版兜底
    'input[placeholder*="标题"]',
    'textarea[placeholder*="标题"]',
    'input[placeholder*="Title"]',
    // 兜底
    'input[name="title"]',
    '#title',
    'input[class*="title-input"]',
    'textarea[class*="title-input"]'
  ],

  // 正文编辑器（掘金使用 ByteMD = CodeMirror 5 / 6）
  //
  //   ★ 不直接抓取 contenteditable 元素，因为掘金的编辑器不是 contenteditable，
  //     而是 CodeMirror 5/6 的特殊结构。CodeMirror 5 的真实输入是隐藏的
  //     <textarea>，上层 .CodeMirror-code 是高亮预览层。
  //   ★ prepareContent 内部会区分元素类型，分别走不同的填充策略：
  //       A) CodeMirror 5 实例（el.CodeMirror） → instance.setValue()
  //       B) CodeMirror 6 / .cm-content 实例 → contenteditable + insertText 走 execCommand
  //       C) <textarea> → 标准 FILL_INPUT_FN
  //       D) 普通 contenteditable → 已有的 FILL_CONTENTEDITABLE_FN
  content: [
    // CodeMirror 5 顶层（与 CodeMirror 实例绑定）
    '.CodeMirror',
    // CodeMirror 5 高亮行容器
    '.CodeMirror-code',
    // CodeMirror 6 / ByteMD 1.x 编辑区
    '.cm-content',
    '.cm-editor',
    '.bytemd',
    // 掘金实际隐藏的 textarea（CodeMirror 真实输入层）—— 保留兜底
    'textarea[class*="CodeMirror"]',
    'textarea[class*="cm-content"]',
    'textarea[class*="bytemd"]',
    // 旧版 / 兜底
    'textarea[name="content"]',
    'textarea[name="body"]',
    'textarea[placeholder*="正文"]',
    'textarea[placeholder*="Markdown"]',
    'textarea[placeholder*="文章内容"]',
    // 兜底
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    '[role="textbox"]',
    'textarea#content'
  ]
};

// ============================================================
// "在页面里跑"的复合 IIFE —— 用于 JuejinPublisher.prepareContent：
//   1) 等待 title / content 选择器可见（最多 N 次 × intervalMs 毫秒）
//   2) 填充：
//      - title：与 ZhihuPublisher 同源的 input setter + InputEvent 派发
//      - content：根据 content 元素的实际类型走不同填充策略：
//          A) CodeMirror 5（.CodeMirror 上挂有 CodeMirror 实例）→ instance.setValue
//          B) CodeMirror 6 / ByteMD（.cm-content contenteditable）→ execCommand('insertText')
//          C) 普通 <textarea> → 标准 FILL_INPUT_FN
//          D) 普通 contenteditable → 标准 FILL_CONTENTEDITABLE_FN
//   3) readBack：读实际 DOM 内容做校验（textarea 读 .value；ce 读 .textContent）
//   4) 返回 { ok, found, filled, verified, contentFillType }
//   5) **绝不**点击 submit / publishButton
// ============================================================
function buildJuejinPrepareScript(payload) {
  // payload = { titleSelectors, contentSelectors, fillData, waitTimeoutMs }
  return '(' +
    'async function juejinPrepare(p){\n' +
    '  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }\n' +
    // 1) resolveSelector（与 fill-input.js 同源逻辑）
    fillScripts.RESOLVE_SELECTOR_FN + '\n' +
    fillScripts.FILL_INPUT_FN + '\n' +
    fillScripts.FILL_CONTENTEDITABLE_FN + '\n' +
    // 2) 等待可见
    '  async function waitVisible(selectors, totalMs){\n' +
    '    var start = Date.now();\n' +
    '    while(Date.now() - start < totalMs){\n' +
    '      var el = resolveOne(selectors);\n' +
    '      if(el) return el;\n' +
    '      await sleep(500);\n' +
    '    }\n' +
    '    return null;\n' +
    '  }\n' +
    // 3) CodeMirror 专用填充：识别 .CodeMirror 元素并通过其挂载的 CodeMirror 实例
    //    设置值（这是 CodeMirror 5 的标准 API）。
    '  function fillCodeMirror5(el, text){\n' +
    '    try{\n' +
    '      if(!el) return { ok:false, error:"cm-el-missing" };\n' +
    '      // 找到最近的 .CodeMirror 祖先（el 可能是 .CodeMirror-code / .CodeMirror-line 等内部节点）\n' +
    '      var cmEl = el;\n' +
    '      if(!cmEl.CodeMirror){\n' +
    '        var p = cmEl;\n' +
    '        while(p && p !== document.body){\n' +
    '          if(p.CodeMirror){ cmEl = p; break; }\n' +
    '          p = p.parentElement;\n' +
    '        }\n' +
    '      }\n' +
    '      if(cmEl && cmEl.CodeMirror && typeof cmEl.CodeMirror.setValue === "function"){\n' +
    '        cmEl.CodeMirror.setValue(String(text || ""));\n' +
    '        try { cmEl.CodeMirror.refresh(); } catch(_e){}\n' +
    '        try { cmEl.CodeMirror.focus(); } catch(_e){}\n' +
    '        var len = (cmEl.CodeMirror.getValue && cmEl.CodeMirror.getValue() || "").length;\n' +
    '        return { ok:true, fillType:"codemirror5", length:len };\n' +
    '      }\n' +
    '      return { ok:false, error:"no-codemirror-instance" };\n' +
    '    }catch(e){ return { ok:false, error:"cm-throw:"+String(e && e.message || e) }; }\n' +
    '  }\n' +
    // 4) CodeMirror 6 / ByteMD 1.x 专用填充：cm-content 是 contenteditable=true 元素。
    //    通过 execCommand("insertText") 走标准 contenteditable 填充路径即可。
    '  function fillCodeMirror6(text){\n' +
    '    try{\n' +
    '      var cm = document.querySelector(".cm-content") || document.querySelector(".cm-editor");\n' +
    '      if(!cm) return { ok:false, error:"cm6-el-missing" };\n' +
    '      if(typeof cm.focus === "function") cm.focus();\n' +
    '      try { document.execCommand("selectAll", false, null); } catch(_e){}\n' +
    '      var ok = false;\n' +
    '      try { ok = document.execCommand("insertText", false, String(text||"")); } catch(_e){ ok = false; }\n' +
    '      if(!ok){\n' +
    '        cm.textContent = String(text||"");\n' +
    '        cm.dispatchEvent(new InputEvent("input", { bubbles:true, cancelable:true }));\n' +
    '      }\n' +
    '      return { ok:true, fillType:"codemirror6", length:(cm.textContent||cm.innerText||"").length };\n' +
    '    }catch(e){ return { ok:false, error:"cm6-throw:"+String(e && e.message || e) }; }\n' +
    '  }\n' +
    '  var t = p.titleSelectors || [];\n' +
    '  var c = p.contentSelectors || [];\n' +
    '  var fd = p.fillData || {};\n' +
    '  var wm = Number(p.waitTimeoutMs || 30000);\n' +
    '  var result = { ok: true, found: { title: false, content: false }, filled: {}, verified: {}, contentFillType: "" };\n' +
    // 5) 等标题
    '  var te = await waitVisible(t, wm);\n' +
    '  result.found.title = !!te;\n' +
    '  if(!te){\n' +
    '    result.ok = false;\n' +
    '    result.filled.title = { ok: false, error: "title-not-found" };\n' +
    '  } else {\n' +
    '    var ttag = te.tagName;\n' +
    '    if(ttag === "INPUT" || ttag === "TEXTAREA"){\n' +
    '      var tr = filter({ el: te, value: String(fd.title || "") });\n' +
    '      result.filled.title = tr;\n' +
    '      if(!tr.ok) result.ok = false;\n' +
    '    } else {\n' +
    '      // contenteditable 标题（极少数情况）—— 用 fillce 触发 input event\n' +
    '      var tcr = fillce({ el: te, value: String(fd.title || "") });\n' +
    '      result.filled.title = tcr;\n' +
    '      if(!tcr.ok) result.ok = false;\n' +
    '    }\n' +
    '  }\n' +
    // 6) 等正文
    '  var ce = await waitVisible(c, wm);\n' +
    '  result.found.content = !!ce;\n' +
    '  if(!ce){\n' +
    '    result.ok = false;\n' +
    '    result.filled.content = { ok: false, error: "content-not-found" };\n' +
    '  } else {\n' +
    '    var tag = ce.tagName;\n' +
    '    // 关键：识别元素类型并走对应分支\n' +
    '    if(tag === "TEXTAREA"){\n' +
    '      // CodeMirror 5 / 6 的真实 <textarea> 都走这里\n' +
    '      var cr = filter({ el: ce, value: String(fd.content || "") });\n' +
    '      result.filled.content = cr;\n' +
    '      result.contentFillType = "textarea";\n' +
    '      if(!cr.ok) result.ok = false;\n' +
    '    } else if(tag === "DIV" && ce.classList && (ce.classList.contains("CodeMirror-code") || ce.classList.contains("CodeMirror-line") || ce.classList.contains("CodeMirror"))){\n' +
    '      // CodeMirror 5 高亮行：往上爬到 .CodeMirror 元素，调实例 API\n' +
    '      var cm5r = fillCodeMirror5(ce, String(fd.content || ""));\n' +
    '      result.filled.content = cm5r;\n' +
    '      result.contentFillType = cm5r.fillType || "codemirror5";\n' +
    '      if(!cm5r.ok) result.ok = false;\n' +
    '    } else if(tag === "DIV" && ce.classList && (ce.classList.contains("cm-content") || ce.classList.contains("cm-editor"))){\n' +
    '      // CodeMirror 6 / ByteMD 1.x：.cm-content 是 contenteditable=true 元素\n' +
    '      var cm6r = fillCodeMirror6(String(fd.content || ""));\n' +
    '      result.filled.content = cm6r;\n' +
    '      result.contentFillType = cm6r.fillType || "codemirror6";\n' +
    '      if(!cm6r.ok) result.ok = false;\n' +
    '    } else {\n' +
    '      // 通用 contenteditable 兜底\n' +
    '      var cr2 = fillce({ el: ce, value: String(fd.content || "") });\n' +
    '      result.filled.content = cr2;\n' +
    '      result.contentFillType = "contenteditable";\n' +
    '      if(!cr2.ok) result.ok = false;\n' +
    '    }\n' +
    '  }\n' +
    // 7) readBack 验证
    '  if(te && result.filled.title && result.filled.title.ok){\n' +
    '    var actualT = (te.value || te.textContent || ""); \n' +
    '    result.verified.title = { expected: String(fd.title || ""), actual: actualT, match: actualT === String(fd.title || "") };\n' +
    '  }\n' +
    '  if(ce && result.filled.content && result.filled.content.ok){\n' +
    '    // 1. CodeMirror 5：从 / 拿\n' +
    '    var actualC = "";\n' +
    '    try{\n' +
    '      var cmElBack = null;\n' +
    '      var probe = ce;\n' +
    '      while(probe && probe !== document.body){\n' +
    '        if(probe.CodeMirror){ cmElBack = probe; break; }\n' +
    '        probe = probe.parentElement;\n' +
    '      }\n' +
    '      if(cmElBack && cmElBack.CodeMirror && typeof cmElBack.CodeMirror.getValue === "function"){\n' +
    '        actualC = cmElBack.CodeMirror.getValue() || "";\n' +
    '      } else if(ce.tagName === "TEXTAREA"){\n' +
    '        actualC = ce.value || "";\n' +
    '      } else {\n' +
    '        actualC = ce.textContent || ce.innerText || "";\n' +
    '      }\n' +
    '    }catch(_e){\n' +
    '      actualC = ce.tagName === "TEXTAREA" ? (ce.value||"") : (ce.textContent||ce.innerText||"");\n' +
    '    }\n' +
    '    result.verified.content = { expected: String(fd.content || ""), actual: actualC, match: actualC === String(fd.content || "") };\n' +
    '  }\n' +
    '  return result;\n' +
    '}' +
    ')(' + JSON.stringify(payload) + ')';
}

// =====================================================================
// JuejinPublisher：掘金平台适配器
// =====================================================================
class JuejinPublisher extends PublisherBase {
  constructor(opts) {
    super(Object.assign({
      platformId: 'juejin',
      platformName: '掘金',
      loginUrl: JUEJIN_CONFIG.loginUrl,
      publishUrl: JUEJIN_CONFIG.publishUrl,
      // 多 selector fallback；掘金改版后只改这里
      selectors: {
        title: JUEJIN_SELECTORS.title.slice(),
        content: JUEJIN_SELECTORS.content.slice(),
        images: ['input[type="file"][accept*="image"]', 'input[type="file"]']
      },
      // 登录态检测（基类 checkLoginStatus 用）
      loginConfig: {
        inSelectors: JUEJIN_SELECTORS.loggedInIndicators.slice(),
        outSelectors: JUEJIN_SELECTORS.loginIndicators.slice()
      },
      // 掘金页面是 Vue SPA，但写文章页是 ByteMD；给一个相对宽松的超时
      loginTimeoutMs: 5 * 60 * 1000,
      loginPollIntervalMs: 2500
    }, opts || {}));
  }

  // 覆盖入口方法（仅是为了日志更明显，便于以后观察）
  openLoginPage() {
    this.logger.info('[JuejinPublisher] Opening Juejin login page', {
      platformId: this.platformId,
      url: this.loginUrl
    });
    return super.openLoginPage();
  }

  openPublishPage() {
    this.logger.info('[JuejinPublisher] Opening Juejin write page', {
      platformId: this.platformId,
      url: this.publishUrl
    });
    return super.openPublishPage();
  }

  // 覆盖 checkLoginStatus：除了 DOM 指示器，再加一个 URL 启发式判断
  // 掘金未登录时 URL 会被 redirect 到 https://juejin.cn/login
  // 掘金已登录时 URL 通常是 https://juejin.cn/ 或 https://juejin.cn/user/center/...
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
          // 显式登录页 / 登录弹窗 / oauth 回调
          if (/juejin\.cn\/login|\/login/i.test(url)) return 'logged_out';
          // /user 路径是已登录专属
          if (/juejin\.cn\/user/i.test(url)) return 'logged_in';
          // 写文章页能直接进 → 已登录
          if (/juejin\.cn\/editor\/drafts\/new/.test(url)) return 'logged_in';
          if (/juejin\.cn\//i.test(url)) return 'logged_in';
          return 'unknown';
        })
        .catch(function () { return 'unknown'; });
    });
  }

  // 覆盖 waitForLogin：基类已经支持，但是每 2.5s 检测一次，可以直接复用
  // 这里只额外打日志便于观察
  waitForLogin() {
    this.logger.info('[JuejinPublisher] Waiting for login (timeout ' +
      Math.round(this.loginTimeoutMs / 1000) + 's)');
    return super.waitForLogin();
  }

  // 覆盖 fillTitle / fillContent：用通用基类实现，但打日志
  fillTitle(text) {
    this.logger.info('[JuejinPublisher] Filling title', {
      platformId: this.platformId,
      length: String(text || '').length
    });
    return super.fillTitle(text);
  }

  fillContent(text) {
    this.logger.info('[JuejinPublisher] Filling content', {
      platformId: this.platformId,
      length: String(text || '').length,
      // 提示：掘金的编辑器是 CodeMirror / ByteMD，prepareContent 会走专用路径
      fillModeHint: 'codemirror'
    });
    return super.fillContent(text);
  }

  // 重写 prepareContent：掘金的写文章页是异步加载（ByteMD SPA），
    // 直接复用基类 fillTitle+fillContent 可能会因为 DOM 还没就绪而失败。
    // 这里换成"等待 + 填 + 验证"的复合 IIFE，并在 IIFE 内部按元素类型走
    // 不同的填充策略（特别是 CodeMirror 5 / CodeMirror 6）。
  prepareContent(fillData) {
    var self = this;
    var data = fillScripts.extractFillData(fillData || {});
    this.logger.info('[JuejinPublisher] Preparing content', {
      platformId: self.platformId,
      titleLen: data.title.length,
      contentLen: data.content.length
    });

    // 第一步：等 title/content DOM 出现，然后按元素类型填充
    var script = buildJuejinPrepareScript({
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
        var contentFillType = (r && r.contentFillType) || '';

        self.logger.info('[JuejinPublisher] Content preparation completed', {
          platformId: self.platformId,
          ok: ok,
          foundTitle: foundTitle,
          foundContent: foundContent,
          verifiedTitle: verifiedTitle,
          verifiedContent: verifiedContent,
          contentFillType: contentFillType,
          filled: r && r.filled
        });

        // 显示 banner
        var bannerScript = fillScripts.buildBannerScript('掘金');
        return self.browserManager.execute(self.platformId, bannerScript)
          .catch(function () {})
          .then(function () {
            return Object.assign({}, r, {
              banner: '掘金内容已自动填充，请手动点击「确定并发布」按钮确认。',
              // 如果 DOM 找到但 verify 不通过（例如掘金前端组件未同步 state），warn 但不假装 ok
              verifiedTitle: !!verifiedTitle,
              verifiedContent: !!verifiedContent
            });
          });
      });
  }
}

// 注册到 registry（默认即生效）
PublisherRegistry.register('juejin', JuejinPublisher);

module.exports = {
  JuejinPublisher: JuejinPublisher,
  JUEJIN_CONFIG: JUEJIN_CONFIG,
  JUEJIN_SELECTORS: JUEJIN_SELECTORS,
  buildJuejinPrepareScript: buildJuejinPrepareScript
};