// Rokit · X (Twitter) Publisher（v1.0 phase 1）
// ----------------------------------------------------------------
// v1.0 phase 1 目标：
//   - 使用 Electron BrowserManager（不是 shell.openExternal）
//   - 独立持久化 partition：persist:platform-x
//   - 第一阶段只打通：
//       ① 打开 X 首页
//       ② 等待用户登录（DOM 检测，非 setTimeout 假成功）
//       ③ 自动跳转到 https://x.com/compose/post
//       ④ 找到帖子编辑器（不做填表）
//   - 永不自动点击 Post。
//
//   第二阶段（phase 2）会扩展填正文、上传图片/视频，**这次不做**。
//
// 重要约束（与需求文档第十五、十七条对应）：
//   - 不读取 X 密码 / Cookie / token 内容。
//   - 登录态完全由 Electron Session（persist:platform-x）自动落盘到
//     userData/Partitions/platform-x/，下次再打开自动保持登录。
//   - 不模拟登录态、不伪造 Cookie、不导出/复制系统浏览器 Cookie。
//   - 不强行绕过 X 的安全机制；登录态由真实 DOM 信号 + URL 启发式判断。
//
// 与其他平台的关系：
//   - 不复用 publishers.js 老 x adapter；新逻辑全部走 BrowserManager。
//   - 不修改 jike / xiaohongshu / zhihu / v2ex / juejin / producthunt。
//
// v1.x fillContent 调试开关：
//   - ROKIT_X_DRYRUN=1：fillContent 只跑诊断脚本，不修改任何 DOM，
//     让用户在不开填表时也能探查 X 编辑器结构（用于定位光标错位）。
//   - 诊断日志统一通过 self.logger.info 推到 main 的 [X-publish][diag] 通道，
//     字段不含 token / cookie。

// 流程（由 main.js runXLoginPhase 调用）：
//   1. browserManager.openPlatform('x') —— 打开独立 BrowserWindow
//   2. browserManager.navigate('x', X_CONFIG.homeUrl)  —— 加载 https://x.com/
//   3. waitForLoginReady()                                —— 反复探测直到登录完成
//   4. browserManager.navigate('x', X_CONFIG.publishUrl) —— 跳到 /compose/post
//   5. findComposer()                                    —— 找到发推文本框
//   6. return { ok, stage, platformId, composer, ... }
// ----------------------------------------------------------------
'use strict';

const { PublisherBase } = require('../../PublisherBase');
const PublisherRegistry = require('../../PublisherRegistry');
const { buildXFindComposerScript, X_COMPOSER_SELECTORS } = require('./XFindComposerScript');

// ============================================================
// X 配置：URL 集中管理
// ============================================================
// X (Twitter) 的关键 URL（第一阶段只需要这三个）：
//   homeUrl     —— https://x.com/                  登录等待页
//   publishUrl  —— https://x.com/compose/post      发推页
//   loginUrl    —— https://x.com/login/                      登录入口
//
// 备选 / 兜底（不同地区 / 不同登录态时尝试）：
//   xLoginPath           —— https://x.com/i/flow/login
//   mobileSharePath      —— https://x.com/intent/post
//   intentTweetPath      —— https://x.com/intent/tweet
const X_CONFIG = {
  homeUrl:    'https://x.com/',
  publishUrl: 'https://x.com/compose/post',
  loginUrl:   'https://x.com/login',
  // 备选（不被 phase 1 默认使用，保留以备改版）
  xFlowLoginUrl:  'https://x.com/i/flow/login',
  intentPostUrl:  'https://x.com/intent/post'
};

// ============================================================
// X 选择器集合
// ============================================================
// 已登录指示（X 已登录时 DOM 里会出现下列元素之一）：
//   - 顶栏 [data-testid="primaryColumn"] 或 [data-testid="sidebarColumn"]
//   - 顶栏 [data-testid="AppTabBar_Profile_Link"]
//   - 顶栏头像 [data-testid="UserAvatar-Container-0"]
//   - 顶栏 "Post" 按钮 [data-testid="SideNav_NewTweet_Button"]
//   - URL 路径 = /home
//
// 未登录指示：
//   - 顶栏 "Sign in" / "Log in" 链接
//   - [data-testid="login"] 或 [data-testid="LoginForm"]
//   - URL 包含 /login 或 /i/flow/login
//   - 页面主文案出现 "Sign in" / "Log in"
//
// **不依赖** 容易变化的 CSS class。
const X_LOGIN_INDICATORS = {
  loggedIn: [
    '[data-testid="primaryColumn"]',
    '[data-testid="sidebarColumn"]',
    '[data-testid="AppTabBar_Profile_Link"]',
    '[data-testid="UserAvatar-Container-0"]',
    '[data-testid="SideNav_NewTweet_Button"]',
    '[data-testid="tweet"]'
  ],
  loggedOut: [
    '[data-testid="login"]',
    '[data-testid="LoginForm"]',
    'a[href*="/login"]',
    'a[href*="/i/flow/login"]',
    'a[href*="/signup"]'
  ]
};

// ============================================================
// 登录检测 IIFE —— 综合 DOM + URL + 文案三重信号
// ============================================================
// 输出：
//   {
//     status:         'logged_in' | 'logged_out' | 'unknown',
//     url:            string,
//     loggedInHits:    [...{selector, sample}],
//     loggedOutHits:  [...{selector, sample}],
//     bodyMarkers:    [...{marker, sample}],  // 在 body innerText 里找到的登录/未登录关键字
//     reason:         string
//   }
function buildXCheckLoginScript() {
  return '(' +
    'function xCheckLogin(){\n' +
    '  var url = String(location.href || "");\n' +
    '  var body = String(document.body ? document.body.innerText : "");\n' +
    '  var loggedInSel = ' + JSON.stringify(X_LOGIN_INDICATORS.loggedIn) + ';\n' +
    '  var loggedOutSel = ' + JSON.stringify(X_LOGIN_INDICATORS.loggedOut) + ';\n' +
    '  var loggedInHits = [];\n' +
    '  var loggedOutHits = [];\n' +
    '  for(var i=0;i<loggedInSel.length;i++){\n' +
    '    var s = loggedInSel[i];\n' +
    '    try{\n' +
    '      var el = document.querySelector(s);\n' +
    '      if(el){\n' +
    '        var r = el.getBoundingClientRect();\n' +
    '        var visible = !!(r && r.width > 0 && r.height > 0);\n' +
    '        loggedInHits.push({ selector: s, visible: visible });\n' +
    '      }\n' +
    '    }catch(_e){}\n' +
    '  }\n' +
    '  for(var j=0;j<loggedOutSel.length;j++){\n' +
    '    var s2 = loggedOutSel[j];\n' +
    '    try{\n' +
    '      var el2 = document.querySelector(s2);\n' +
    '      if(el2){\n' +
    '        var r2 = el2.getBoundingClientRect();\n' +
    '        var v2 = !!(r2 && r2.width > 0 && r2.height > 0);\n' +
    '        loggedOutHits.push({ selector: s2, visible: v2 });\n' +
    '      }\n' +
    '    }catch(_e){}\n' +
    '  }\n' +
    '  // 文本标记（更鲁棒）：用 grep-like 关键字\n' +
    '  var outMarkers = [];\n' +
    '  var outKeys = ["Sign in","Log in","Sign In","Login","登录"];\n' +
    '  for(var k=0;k<outKeys.length;k++){\n' +
    '    var idx = body.indexOf(outKeys[k]);\n' +
    '    if(idx >= 0){\n' +
    '      outMarkers.push({ marker: outKeys[k], sample: body.substr(Math.max(0,idx-10), 50) });\n' +
    '    }\n' +
    '  }\n' +
    '  // URL 启发式\n' +
    '  var urlIsLogin = /\\/(login|i\\/flow\\/login|signup)/i.test(url);\n' +
    '  // 综合判定\n' +
    '  var status = "unknown";\n' +
    '  var reason = "";\n' +
    '  // 任意一个 loggedOut 信号可见 → 未登录\n' +
    '  var anyVisibleOut = loggedOutHits.some(function(h){ return h.visible; });\n' +
    '  var anyVisibleIn = loggedInHits.some(function(h){ return h.visible; });\n' +
    '  if(urlIsLogin || anyVisibleOut){\n' +
    '    status = "logged_out";\n' +
    '    reason = urlIsLogin ? "url-is-login" : "out-selector-visible";\n' +
    '  } else if(anyVisibleIn){\n' +
    '    status = "logged_in";\n' +
    '    reason = "in-selector-visible";\n' +
    '  } else if(outMarkers.length > 0 && loggedInHits.length === 0){\n' +
    '    status = "logged_out";\n' +
    '    reason = "body-marker-without-in-selectors";\n' +
    '  }\n' +
    '  return {\n' +
    '    status: status,\n' +
    '    url: url,\n' +
    '    loggedInHits: loggedInHits,\n' +
    '    loggedOutHits: loggedOutHits,\n' +
    '    bodyMarkers: outMarkers,\n' +
    '    reason: reason\n' +
    '  };\n' +
    '}' +
    ')()';
}

// ============================================================
// 主类
// ============================================================
class XPublisher extends PublisherBase {
  constructor(opts) {
    super(Object.assign({
      platformId:    'x',
      platformName:  'X (Twitter)',
      loginUrl:      X_CONFIG.loginUrl,
      publishUrl:    X_CONFIG.publishUrl,
      // 不需要 fillSelectors —— phase 1 不做填表
      selectors:     { title: [], content: [], images: [] },
      loginConfig:   {
        inSelectors:  X_LOGIN_INDICATORS.loggedIn.slice(),
        outSelectors: X_LOGIN_INDICATORS.loggedOut.slice()
      },
      // X 加载不算慢，但登录可能卡验证码 —— 5 分钟足够
      loginTimeoutMs:     5 * 60 * 1000,
      loginPollIntervalMs: 1500
    }, opts || {}));
  }

  // ============================================================
  // 覆盖 checkLoginStatus：使用 X 专用 IIFE（包含 URL + DOM + 文案综合判断）
  // ============================================================
  checkLoginStatus() {
    var self = this;
    return Promise.resolve(self.browserManager.execute(self.platformId, buildXCheckLoginScript()))
      .then(function (r) {
        var status = (r && r.status) || 'unknown';
        if (status !== 'logged_in' && status !== 'logged_out') return 'unknown';
        return status;
      })
      .catch(function () { return 'unknown'; });
  }

  // ============================================================
  // phase1ReachCompose
  //   主流程入口：打开首页 → 等登录 → 进入 /compose/post → 找编辑器
  //
  //   返回：
  //     {
  //       ok:                boolean,
  //       stage:             'home' | 'login' | 'compose' | 'editor-found' | 'editor-not-found',
  //       platformId:        'x',
  //       composer:          {selector, tag, role, ...} | null,
  //       currentUrl:        string,
  //       loginUrl:          string,         // 用户最后停留的 URL（可能就是 /home）
  //       attempts:          number,
  //       elapsedMs:         number,
  //       note:              string,         // 给 UI 看的提示
  //       readyForManualSend: false          // phase 1 永远 false
  //     }
  // ============================================================
  phase1ReachCompose() {
    var self = this;
    var logTag = '[X-publish]';
    var bm = self.browserManager;
    if (!bm || typeof bm.openPlatform !== 'function') {
      return Promise.resolve({
        ok: false,
        stage: 'home',
        platformId: self.platformId,
        error: 'no-browser-manager',
        note: 'BrowserManager 未注入，phase 1 无法继续。'
      });
    }

    var t0 = Date.now();
    var stages = [];

    function _log(msg, extra) {
      try { self.logger.info(logTag + ' ' + msg, extra || {}); } catch (_e) {}
    }

    function _aliveCheck() {
      try {
        var win = bm.getPlatformWindow && bm.getPlatformWindow(self.platformId);
        if (!win) return false;
        if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false;
        if (!win.webContents) return false;
        if (typeof win.webContents.isDestroyed === 'function' && win.webContents.isDestroyed()) return false;
        return true;
      } catch (_e) { return false; }
    }

    // ----- 1. 打开 BrowserWindow（persist:platform-x） -----
    return Promise.resolve(bm.openPlatform(self.platformId)).then(function (openRes) {
      _log('Publisher 启动', {
        partition: 'persist:platform-' + self.platformId,
        reused:    !!(openRes && openRes.reused),
        windowId:  openRes && openRes.windowId
      });
      _log('当前模式：electron-browser (persist:platform-x)');
      stages.push('open');

      if (!_aliveCheck()) {
        _log('BrowserWindow 不可用', {});
        return {
          ok: false,
          stage: 'home',
          platformId: self.platformId,
          error: 'WINDOW_UNAVAILABLE',
          elapsedMs: Date.now() - t0,
          note: '内置浏览器窗口不可用，请重新点击「开始发射」。'
        };
      }

      // ----- 2. 加载首页 -----
      _log('打开 X', { url: X_CONFIG.homeUrl });
      return Promise.resolve(bm.navigate(self.platformId, X_CONFIG.homeUrl)).then(function () {
        stages.push('navigate-home');

        // ----- 3. 探测登录状态 -----
        return _pollLogin(self, bm, _log).then(function (loginRes) {
          if (!loginRes || loginRes.status !== 'logged_in') {
            _log('登录状态检测：' + (loginRes && loginRes.status), {
              reason: loginRes && loginRes.reason,
              currentUrl: loginRes && loginRes.currentUrl,
              elapsedMs: Date.now() - t0
            });
            return {
              ok: false,
              stage: 'login',
              platformId: self.platformId,
              currentUrl: loginRes && loginRes.currentUrl,
              reason: loginRes && loginRes.reason,
              elapsedMs: Date.now() - t0,
              note: '未检测到 X 已登录。请在内置浏览器完成登录（扫码 / 密码 / Google）后，再次点击「开始发射」，phase 1 会自动恢复。'
            };
          }
          _log('登录状态：success', {
            url: loginRes.currentUrl,
            elapsedMs: Date.now() - t0,
            reason: loginRes.reason
          });
          _log('当前 URL', { url: loginRes.currentUrl });
          stages.push('login-ok');

          // ----- 4. 跳转到 /compose/post -----
          _log('正在进入发帖页面', { url: X_CONFIG.publishUrl });
          return Promise.resolve(bm.navigate(self.platformId, X_CONFIG.publishUrl)).then(function () {
            stages.push('navigate-compose');

            // ----- 5. 找帖子编辑器 -----
            _log('发帖页面加载完成', { url: X_CONFIG.publishUrl });
            var findScript = buildXFindComposerScript({
              selectors: X_COMPOSER_SELECTORS,
              pollIntervalMs: 800,
              maxAttempts: 30
            });
            return Promise.resolve(bm.execute(self.platformId, findScript)).then(function (findRes) {
              if (findRes && findRes.found) {
                _log('找到帖子编辑器', {
                  selector: findRes.selector,
                  composer: findRes.composer,
                  attempts: findRes.attempts,
                  elapsedMs: findRes.elapsedMs
                });
                _log('X 第一阶段初始化完成', {
                  totalElapsedMs: Date.now() - t0
                });
                return {
                  ok: true,
                  stage: 'editor-found',
                  platformId: self.platformId,
                  composer: findRes.composer,
                  selector: findRes.selector,
                  currentUrl: findRes.currentUrl,
                  attempts: findRes.attempts,
                  elapsedMs: Date.now() - t0,
                  stages: stages,
                  note: 'X 已登录并进入 /compose/post；编辑器已就位。当前为 phase 1，' +
                        '尚未自动填正文或媒体。请手动输入推文 + 上传图片/视频，' +
                        '然后手动点击 Post（X 推文要求至少 1 个媒体 或 1 条文本；' +
                        '若纯文本点击 Post 即可）。',
                  readyForManualSend: false,
                  phase: 1
                };
              }
              _log('未找到帖子编辑器', {
                attempts: findRes && findRes.attempts,
                elapsedMs: findRes && findRes.elapsedMs,
                currentUrl: findRes && findRes.currentUrl
              });
              return {
                ok: false,
                stage: 'editor-not-found',
                platformId: self.platformId,
                currentUrl: findRes && findRes.currentUrl,
                attempts: findRes && findRes.attempts,
                elapsedMs: Date.now() - t0,
                stages: stages,
                note: '已登录 X，但 /compose/post 页面上找不到发推文本框（X 改版？）。' +
                      '请在内置浏览器手动写推文。',
                readyForManualSend: false,
                phase: 1
              };
            });
          });
        });
      });
    });
  }

  // phase 1 不实现自动发送
  submit = function () {
    return Promise.resolve({
      ok: false,
      phase: 1,
      autoSubmitDisabled: true,
      manualReason: 'phase 1 only verifies login + auto-reach compose/post; final Post must be clicked by user',
      platformId: this.platformId
    });
  };

  // phase 1 不实现 fillContent（保留兼容；phase 2 由 fillContent 主流程接管）
  fillTitle = function () { return Promise.resolve({ ok: false, phase: 1, error: 'phase-1-no-fill', platformId: this.platformId }); };
  fillBody   = function () { return Promise.resolve({ ok: false, phase: 1, error: 'phase-1-no-fill', platformId: this.platformId }); };

  // ====================================================================
  // phase 2 — fillContent(payload) + uploadMedia(payload)
  //   复用 BrowserManager 同一个内置浏览器、partition、openPlatform
  //   不修改登录流程、不重开 BrowserWindow
  //
  //   fillContent:
  //     - 构造 X 正文 (payload.body + payload.link)  ← 项目真实字段
  //     - bm.execute(fillScript) → React-aware contenteditable 填充
  //     - 验证：actualPreview 前 20 字必须命中 targetPreview
  //     - **不点 Post**
  //
  //   uploadMedia:
  //     - 把 payload.mediaItems (dataURL 或 http) 喂给 file input
  //     - 等 postUploadMarker（DOM 出现 tweetPhoto/tweetVideo/previewCard）
  //     - **不点 Post**
  // ====================================================================

  // 把 PublishTask 实际字段归一化
  // v1.x：title / body / tags / link 全部按用户实际输入组装；不允许把数据库对象、
  //   token、文件路径、debug、undefined 直接写进 X 正文。
  // 处理顺序：
  //   1) 用 coerceField 把所有字段强制为干净字符串；过滤 '[object Object]' / 全数字 0 等
  //   2) title 与 body 都有效 → 按「标题 + 空行 + 正文」合并（不重复）
  //   3) 仅 title 有效 → 用 title 当正文（X 没独立标题输入框）
  //   4) tags 仅合并用户已写的（state.copies[id].tags）；不擅自生成
  //   5) link 仅追加（若正文中尚未包含）
  //   6) 任一字段短路返回（永不返回 hasContent=false 假装成功）
  //
  // 诊断性开关（v1.x+）options.bodyOnly=true：
  //   - **不**拼接 title
  //   - **不**追加 link（保留 body 字段里已有的 URL）
  //   - **不**追加 tags（保留 body 字段里已有的 #xxx）
  //   - 仅 body 字段本身进入 X 编辑器
  //   - 标题仍保留在 payload.title 用于 UI 提示 / 数据库，不修改
  // 用途：用户在排查"光标错位"时通过 ROKIT_X_BODY_ONLY=1 或 options.bodyOnly=true 启用，
  //   排除"标题拼接/重复写入"作为根因。
  _normalizePayload(payload, options) {
    var p = payload || {};
    var opts = options || {};
    var bodyOnly = !!opts.bodyOnly;
    function coerceField(v) {
      if (v == null) return '';
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (typeof v === 'string') return v;
      // object/array → 不允许进入正文
      return '';
    }
    function isTrivial(s) {
      if (!s) return true;
      var t = String(s).trim();
      if (!t) return true;
      if (t === '[object Object]') return true;
      if (/^(undefined|null|NaN)$/i.test(t)) return true;
      return false;
    }
    // v1.x+：X 发布体面**绝不**复用 title / intro / link / tags 与 body 自动拼接。
    //   bodyOnly=true 是**强制**默认（fillContent 与 phase2FillAndUpload 都传 bodyOnly:true）。
    //   bodyOnly=false 是 escape hatch，**不**在 X publish 主路径使用。
    var title = String(coerceField(p.title)).trim();
    var body  = String(coerceField(p.body)).trim();
    var intro = String(coerceField(p.intro)).trim();
    var link  = String(coerceField(p.link)).trim();
    // 校验 link 为合法 http(s) URL；否则不写入正文（避免把 token 配置地址等误注入）
    if (link && !/^https?:\/\/\S+/i.test(link)) link = '';
    // X 正文：正文优先；空白则退到 intro；再退到 title；都不行 → hasContent=false
    var primaryBody = body || intro || '';
    var content;
    if (bodyOnly) {
      // 修复 3：bodyOnly=true 时，**绝对**只使用 body 字段原样。**不**回退到 title / intro / link，
      //   **不**追加 tags，**不**追加任何额外内容。如果 body 为空，返回 ''（让 fillContent 返回
      //   empty-content 错误，**不**会用 genCopy 默认模板兜底——这正是用户报告的根因）。
      //   body 这里保留前后空白（用户编辑的换行 / 缩进），trim 仅用于 isTrivial 判定。
      //   真正写入 X 编辑器的 content 是 .replace(/^\s+|\s+$/g,'') 一次，**不**动中间字符。
      content = body;
    } else {
      var parts = [];
      if (title && primaryBody) {
        // 标题 + 空行 + 正文；若正文已经以同标题开头，避免重复
        if (primaryBody.indexOf(title) === 0) {
          parts.push(primaryBody);
        } else {
          parts.push(title);
          parts.push('');
          parts.push(primaryBody);
        }
      } else if (title && !primaryBody) {
        parts.push(title);
      } else if (!title && primaryBody) {
        parts.push(primaryBody);
      }
      content = parts.join('\n');
      // tags：仅合并 user-provided tag 数组，每项加 # 前缀（若已含）
      var tagsArr = Array.isArray(p.tags) ? p.tags : [];
      var tagsLine = '';
      if (tagsArr.length) {
        var tags = tagsArr.map(function (t) {
          return String(coerceField(t)).trim().replace(/^\s*#+/, '#');
        }).filter(function (t) { return !!t; });
        if (tags.length) tagsLine = tags.join(' ');
        // 仅在 content 不已有该标签时追加
        if (tagsLine && content.indexOf(tagsLine) === -1) {
          content = content ? (content + '\n\n' + tagsLine) : tagsLine;
        }
      }
      // 链接：仅当不含时才追加
      if (link && content.indexOf(link) === -1) {
        content = content ? (content + '\n\n' + link) : link;
      }
    }
    // 内容合法性兜底
    if (isTrivial(content)) content = '';
    var hasContent = !!content && content.length > 0;

    // ---- 媒体归一化（不区分 video/image，统一走 DataTransfer+File）----
    var mediaItems = [];
    var rawMedia = [];
    if (Array.isArray(p.mediaItems) && p.mediaItems.length) rawMedia = rawMedia.concat(p.mediaItems);
    if (Array.isArray(p.media) && p.media.length)          rawMedia = rawMedia.concat(p.media);
    if (p.videoDataUrl && isTrivial(rawMedia.length ? '' : p.videoDataUrl)) rawMedia.push({ type: 'video', src: String(p.videoDataUrl), name: p.videoName || 'video.mp4' });
    if (p.videoAssetId && p.videoDataUrl && !rawMedia.length) rawMedia.push({ type: 'video', src: String(p.videoDataUrl), name: p.videoName || 'video.mp4' });
    if (Array.isArray(p.images) && p.images.length) {
      for (var i = 0; i < p.images.length; i++) rawMedia.push({ type: 'image', src: String(coerceField(p.images[i])), name: 'image-' + (i + 1) + '.jpg' });
    }
    mediaItems = rawMedia.map(function (m) {
      var t = (m && m.type) || '';
      var s = (m && m.src) || (m && m.dataURL) || '';
      if (!s) return null;
      if (!t) {
        if (/^data:video\//i.test(String(s))) t = 'video';
        else if (/^data:image\//i.test(String(s))) t = 'image';
      }
      return { type: String(t || 'image'), src: String(s), name: (m && m.name ? String(m.name) : '') };
    }).filter(function (m) { return !!(m && m.src && !isTrivial(m.src)); });

    return {
      content: content,
      mediaItems: mediaItems,
      hasMedia: mediaItems.length > 0,
      hasContent: hasContent,
      title: title,
      body: body,
      link: link,
      tags: tagsArr,
      wasEmpty: !hasContent && !mediaItems.length
    };
  }

  // ---- fillContent ----
  // X 主流程被 main.js 调用时参数是 payload；这里接受 (content, options)
  async fillContent(content, options) {
    var self = this;
    var bm = self.browserManager;
    var logTag = '[X-publish]';
    var _log = function (msg, extra) {
      try { self.logger.info(logTag + ' ' + msg, extra || {}); } catch (_e) {}
    };

    _log('开始填充内容');
    _log('当前 URL:', { url: _safeUrl(bm, self.platformId) });

    // v1.x+：位置 C 诊断 — X 发布执行函数实际收到的正文参数。
    //   只记录长度 / 测试标记 / 字段来源，**不**记录完整正文。
    //   调试模式由 process.env.ROKIT_X_TRACE 启用（默认开），生产环境可设为 0 关闭。
    try {
      var _body = (content && typeof content === 'object') ? content.body : (typeof content === 'string' ? content : '');
      var _bodyStr = _body == null ? '' : String(_body);
      var _trace = (content && typeof content === 'object' && content._xTrace) || '';
      _log('X-trace [位置 C 接收]', {
        trace: _trace || '(no trace)',
        bodyLen: _bodyStr.length,
        hasTitle: !!(content && typeof content === 'object' && content.title),
        titleLen: (content && typeof content === 'object' && content.title) ? String(content.title).length : 0,
        // 测试标记：仅返回是否包含（**不**回显完整字符串）
        markA: _bodyStr.indexOf('TRACE_A') >= 0,
        markB: _bodyStr.indexOf('TRACE_B') >= 0,
        // 是否意外包含 title 标记（说明标题被拼到正文里了）
        titleContainedInBody: _bodyStr.indexOf('TRACE_TITLE') >= 0,
        // 来源字段
        sourceField: (content && typeof content === 'object' && content.body != null) ? 'content.body' : '(not in content.body)'
      });
    } catch (_e) {}

    if (!bm || typeof bm.execute !== 'function') {
      _log('✗ BrowserManager 未就绪', {});
      return { ok: false, error: 'no-browser-manager', platformId: self.platformId };
    }

    // 归一化输入（直接传 content 字符串，或者传 {body,link,...} 形态）
    // 诊断性 v1.x+：X 发布测试期间**只填充正文、不填充标题**。把 bodyOnly 设为
    //   true 让 _normalizePayload 跳过 title / link / tags 自动拼接，**只**把
    //   payload.body 自身写进 X 编辑器；标题仍保留在数据库 / UI 提示中。
    // 默认行为：bodyOnly=true（X 不再有标题输入框，避免 Rokit 拼接产生歧义）。
    // Escape hatch：调用方通过 options.bodyOnly=false 可以临时回退到原 v1.x 行为。
    var bodyOnly = !options || options.bodyOnly !== false; // 默认 true；显式 false 才回退
    var normalized;
    if (typeof content === 'string') {
      normalized = self._normalizePayload({ body: content, link: options && options.link }, { bodyOnly: bodyOnly });
    } else {
      normalized = self._normalizePayload(content || {}, { bodyOnly: bodyOnly });
    }

    if (!normalized.hasContent) {
      _log('✗ 正文为空，跳过填充', {});
      return { ok: false, error: 'empty-content', platformId: self.platformId };
    }

    // 优先发一份诊断（即便非 dryRun 也打点），让 main.log 能看到 X 编辑器真实状态。
    // dryRun=true 时只诊断不填表，UI 可在「我的作品 → 设置」加一个开关触发。
    var envDryRun = false;
    try {
      if (typeof process !== 'undefined' && process && process.env) {
        envDryRun = (process.env.ROKIT_X_DRYRUN === '1' || process.env.ROKIT_X_DRYRUN === 'true');
      }
    } catch (_e) {}
    var dryRun = !!options && !!options.dryRun || envDryRun;
    if (dryRun) {
      _log('dry-run 模式：不填表，仅诊断', { note: options && options.note || '' });
    } else {
      _log('准备填充：内容长度 = ' + normalized.content.length, {});
    }

    // 1) 诊断快照（无条件执行，便于人工复现时一次性拿到 before/after 状态）
    try {
      var FillScript = require('./XFillScript.js');
      var diagScript = (FillScript.buildXDiagnosticScript ? FillScript.buildXDiagnosticScript({
        selectors: (require('./XFillScript.js').X_COMPOSER_SELECTORS || []),
        note: 'fillContent-pre'
      }) : '');
      if (diagScript) {
        var diagRes = await Promise.resolve(bm.execute(self.platformId, diagScript));
        _log('X 编辑器诊断（before）', { result: diagRes });
      }
    } catch (eDiag) {
      _log('✗ 诊断脚本异常（不阻塞填充）', { error: String((eDiag && eDiag.message) || eDiag) });
    }

    // 2) 真正填充
    var FillScript = require('./XFillScript.js');
    var script = FillScript.buildXFillScript({
      content: normalized.content,
      pollIntervalMs: 800,
      maxAttempts: 30,
      verifyDelayMs: 800,
      dryRun: dryRun
    });

    var res;
    try {
      res = await Promise.resolve(bm.execute(self.platformId, script));
    } catch (e) {
      _log('✗ 填充脚本执行异常', { error: String(e && e.message || e) });
      return { ok: false, error: 'execute-exception', platformId: self.platformId, exception: String(e && e.message || e) };
    }

    _log('正文填充完成', {
      ok: res && res.ok,
      method: res && res.fillMethod,
      contentBeforeLen: res && res.contentBeforeLen,
      contentAfterLen: res && res.contentAfterLen
    });

    if (!res || !res.ok) {
      _log('✗ 正文填充失败', { error: res && res.error, composer: res && res.composer, attempts: res && res.attempts });
      return {
        ok: false,
        error: (res && res.error) || 'fill-failed',
        platformId: self.platformId,
        composer: res && res.composer,
        fillMethod: res && res.fillMethod,
        attempts: res && res.attempts,
        elapsedMs: res && res.elapsedMs,
        targetPreview: res && res.targetPreview,
        actualPreview: res && res.actualPreview,
        contentLength: normalized.content.length
      };
    }

    _log('✓ 正文填充成功', { method: res.fillMethod, contentAfterLen: res.contentAfterLen });

    // v1.x+：位置 D 诊断 — 最终 X 填充函数实际返回结果
    try {
      _log('X-trace [位置 D fillContent 返回]', {
        ok: !!res.ok,
        method: res.fillMethod,
        targetLen: (normalized && normalized.content) ? normalized.content.length : 0,
        contentAfterLen: res.contentAfterLen,
        actualPreview: res.actualPreview ? String(res.actualPreview).slice(0, 50) : '',
        // 关键检查：actualPreview 是否含 title / body 标记
        // 用 TRACE_TITLE 标记**专门**用于测试（不是 X 真实用户输入）。
        // 真正 X 真实用户标题里**不**应含 TRACE_TITLE 字符串。
        previewHasTitleMark: res.actualPreview && res.actualPreview.indexOf('TRACE_TITLE') >= 0,
        previewHasBodyMark: res.actualPreview && res.actualPreview.indexOf('TRACE_A') >= 0
      });
    } catch (_e) {}

    return {
      ok: true,
      phase: 2,
      platformId: self.platformId,
      composer: res.composer,
      fillMethod: res.fillMethod,
      contentLength: normalized.content.length,
      contentAfterLen: res.contentAfterLen,
      attempts: res.attempts,
      elapsedMs: res.elapsedMs,
      actualPreview: res.actualPreview,
      targetPreview: res.targetPreview
    };
  }

  // ---- uploadMedia ----
  // payload: { images, videoAssetId, videoSrc, mediaItems, media } 任选
  async uploadMedia(mediaPayload) {
    var self = this;
    var bm = self.browserManager;
    var logTag = '[X-publish]';
    var _log = function (msg, extra) {
      try { self.logger.info(logTag + ' ' + msg, extra || {}); } catch (_e) {}
    };

    var normalized = self._normalizePayload(mediaPayload || {});
    if (!normalized.hasMedia) {
      _log('无可用媒体，跳过上传', {});
      return { ok: true, phase: 2, skipped: 'no-media', platformId: self.platformId, items: [] };
    }

    _log('检查媒体', { count: normalized.mediaItems.length, types: normalized.mediaItems.map(function (m) { return m.type; }) });
    _log('当前 URL:', { url: _safeUrl(bm, self.platformId) });

    if (!bm || typeof bm.execute !== 'function') {
      _log('✗ BrowserManager 未就绪', {});
      return { ok: false, error: 'no-browser-manager', platformId: self.platformId };
    }

    var UploadScript = require('./XUploadScript.js');
    var script = UploadScript.buildXUploadScript({
      mediaItems: normalized.mediaItems,
      timeoutMs: 30000,
      pollIntervalMs: 600,
      verifyDelayMs: 4000,
      maxVideoBytes: 80 * 1024 * 1024
    });

    var res;
    try {
      res = await Promise.resolve(bm.execute(self.platformId, script));
    } catch (e) {
      _log('✗ 媒体上传脚本执行异常', { error: String(e && e.message || e) });
      return { ok: false, error: 'execute-exception', platformId: self.platformId, exception: String(e && e.message || e) };
    }

    var dispatchedItems = (res && res.items || []).filter(function (i) { return i.status === 'dispatched'; });
    var failedItems    = (res && res.items || []).filter(function (i) { return i.status === 'failed'; });
    _log('媒体上传完成', {
      ok: res && res.ok,
      inputMethod: res && res.inputMethod,
      postUploadMarker: res && res.postUploadMarker,
      itemCount: (res && res.items || []).length,
      dispatchedCount: dispatchedItems.length,
      failedCount: failedItems.length
    });

    if (!res || !res.ok) {
      _log('✗ X 媒体上传失败', { error: res && res.error, items: (res && res.items || []).map(function (i) { return { status: i.status, error: i.error }; }) });
      return {
        ok: false,
        error: (res && res.error) || 'upload-failed',
        platformId: self.platformId,
        items: res && res.items,
        inputMethod: res && res.inputMethod,
        attempts: res && res.attempts
      };
    }

    if (!res.postUploadMarker) {
      _log('⚠ X 媒体已 dispatch 但未检测到预览（仍可能上传中或 React 延迟渲染）', {
        dispatched: dispatchedItems.length,
        failed: failedItems.length
      });
    } else {
      _log('✓ X 媒体上传完成（含预览 DOM）', {
        marker: res.postUploadMarker,
        dispatched: dispatchedItems.length,
        failed: failedItems.length
      });
    }

    // v1.x：如果用户传了 N 个媒体，但只 dispatched < N，应明确告知部分失败。
    var expectedCount = (normalized.mediaItems || []).length;
    var dispatchedCount = dispatchedItems.length;
    var partialFailure = dispatchedCount < expectedCount;

    return {
      ok: true,
      phase: 2,
      platformId: self.platformId,
      items: res.items,
      inputMethod: res.inputMethod,
      postUploadMarker: res.postUploadMarker,
      attempts: res.attempts,
      elapsedMs: res.elapsedMs,
      expectedCount: expectedCount,
      dispatchedCount: dispatchedCount,
      failedCount: failedItems.length,
      partialFailure: partialFailure,
      failedReasons: (failedItems || []).map(function (i) { return { name: i.n, error: i.error }; })
    };
  }

  // ---- phase2FillAndUpload(payload) 主入口 ----
  // 完整 phase 2：填充正文 → 上传媒体 → 停在 Post 按钮前
  async phase2FillAndUpload(payload) {
    var self = this;
    var logTag = '[X-publish]';
    var _log = function (msg, extra) {
      try { self.logger.info(logTag + ' ' + msg, extra || {}); } catch (_e) {}
    };
    var bm = self.browserManager;
    if (!bm) {
      _log('✗ BrowserManager 未就绪，跳过 phase 2', {});
      return { ok: false, error: 'no-browser-manager', platformId: self.platformId };
    }

    // v1.x+：X 发布测试期间**只填充正文、不填充标题**。phase 2 入口也按
    //   bodyOnly=true 归一化，让 hasContent 判定与 fillContent 完全一致
    //   （避免「hasContent=true 但 fillContent 因 body 空而失败」的不一致）。
    var normalized = self._normalizePayload(payload || {}, { bodyOnly: true });

    // 1) 填充正文
    var fillResult = { ok: false, skipped: 'empty-content' };
    if (normalized.hasContent) {
      fillResult = await self.fillContent(payload || {}, { bodyOnly: true });
    } else {
      _log('无可用正文，跳过填充', {});
    }

    // 2) 上传媒体
    var uploadResult = { ok: true, skipped: 'no-media', items: [] };
    if (normalized.hasMedia) {
      uploadResult = await self.uploadMedia(payload || {});
    }

    // 3) 总结
    // 严格按用户要求：未自动填入或媒体未确认 → 不假装成功。绝不返回 ok=true 同时又
    // 让用户手动重试（防止「草稿成功 = 文章已发布」误读）。
    var fillOk    = !!(fillResult && fillResult.ok);
    var uploadOk  = uploadResult && uploadResult.ok !== false;
    var uploadPartial = !!(uploadResult && uploadResult.partialFailure);
    var finalOk = (normalized.hasContent ? fillOk : true) && (!normalized.hasMedia ? true : uploadOk && !uploadPartial);
    var userNote;
    if (finalOk) {
      userNote = 'X 内容已自动填充' + (normalized.hasMedia ? '，媒体已附加' : '') + '。请在 X 窗口检查并手动点击 Post。';
    } else if (fillResult && fillResult.error && fillResult.error !== 'empty-content' && !normalized.hasContent) {
      userNote = 'X 标题和正文均为空；请到 Rokit「发布文案」步骤补充内容。';
    } else if (fillResult && !fillResult.ok) {
      userNote = 'X 正文未自动填入：' + (fillResult.error || '未知原因') + '。请在 X 窗口手动粘贴。';
    } else if (uploadPartial) {
      userNote = 'X 正文已自动填好，但媒体部分上传失败（已 dispatch ' + (uploadResult.dispatchedCount || 0) + '/' + (uploadResult.expectedCount || 1) + '）。请在 X 窗口检查媒体并手动补传。';
    } else if (!uploadOk) {
      userNote = 'X 正文已自动填好，但媒体上传未完成：' + (uploadResult.error || '未知原因') + '。请在 X 窗口手动上传。';
    } else {
      userNote = 'X phase 2 部分步骤失败，请查看日志。';
    }

    if (finalOk) {
      _log('✓ X 内容填充完成（' + (normalized.hasMedia ? '含媒体' : '纯文本') + '）', {
        fillMethod: fillResult && fillResult.fillMethod,
        contentAfterLen: fillResult && fillResult.contentAfterLen,
        uploadItems: uploadResult && (uploadResult.items || []).length
      });
    } else {
      _log('✗ X 自动填充部分失败', {
        fillOk: fillOk, uploadOk: uploadOk, uploadPartial: uploadPartial,
        fillError: fillResult && fillResult.error,
        uploadError: uploadResult && uploadResult.error
      });
    }
    if (normalized.hasMedia) {
      _log(uploadOk ? '✓ 媒体准备完成' : '✗ 媒体上传失败', {
        dispatched: uploadResult && uploadResult.dispatchedCount,
        expected:   uploadResult && uploadResult.expectedCount,
        failedReasons: uploadResult && uploadResult.failedReasons
      });
    }
    _log('✓ 已进入最终确认状态');
    _log('✓ 请手动点击 Post');

    // v1.x 兼容：填充/上传失败时窗口仍在，用户可在窗口里手动填表 + 点击 Post；
    //   所以 readyForManualSend 仍标 true，让 UI 保留"等待用户手动 Post"状态；但 ok 严格透传失败信号。
    return {
      ok: finalOk,
      phase: 2,
      platformId: self.platformId,
      readyForManualSend: true,
      autoSubmitDisabled: true,
      fillResult: fillResult,
      uploadResult: uploadResult,
      note: userNote,
      hasContent: normalized.hasContent,
      hasMedia: normalized.hasMedia
    };
  }
}

// ============================================================
// 内部：轮询登录状态
// ============================================================
function _pollLogin(pub, bm, _log) {
  var deadline = Date.now() + pub.loginTimeoutMs;
  var pollIntervalMs = pub.loginPollIntervalMs || 1500;
  var tries = 0;
  return new Promise(function (resolve) {
    function tick() {
      tries++;
      if (Date.now() > deadline) {
        _log('登录等待超时', { tries: tries, timeoutMs: pub.loginTimeoutMs });
        return resolve({
          status: 'unknown',
          reason: 'timeout',
          tries: tries,
          currentUrl: _safeUrl(bm, pub.platformId)
        });
      }
      Promise.resolve(bm.execute(pub.platformId, buildXCheckLoginScript()))
        .then(function (r) {
          var status = (r && r.status) || 'unknown';
          var currentUrl = (r && r.url) || _safeUrl(bm, pub.platformId);
          if (status === 'logged_in') {
            return resolve({
              status: 'logged_in',
              reason: r && r.reason,
              currentUrl: currentUrl,
              tries: tries,
              hits: r && r.loggedInHits
            });
          }
          if (status === 'logged_out') {
            // 继续等待用户登录（不立即失败；用户可能正在输密码）
            // 但每 5 次（约 7.5 秒）记录一次诊断
            if (tries % 5 === 0) {
              _log('等待登录', {
                tries: tries,
                currentUrl: currentUrl,
                reason: r && r.reason
              });
            }
            return setTimeout(tick, pollIntervalMs);
          }
          // unknown —— 多半页面还在加载；继续探测
          if (tries % 5 === 0) {
            _log('登录状态未知（页面可能还在加载）', {
              tries: tries,
              currentUrl: currentUrl
            });
          }
          setTimeout(tick, pollIntervalMs);
        })
        .catch(function () {
          setTimeout(tick, pollIntervalMs);
        });
    }
    tick();
  });
}

function _safeUrl(bm, platformId) {
  try {
    var win = bm.getPlatformWindow && bm.getPlatformWindow(platformId);
    return win && win.webContents ? win.webContents.getURL() : '';
  } catch (_e) { return ''; }
}

// ============================================================
// 注册到 registry（默认即生效）
// ============================================================
PublisherRegistry.register('x', XPublisher);

module.exports = {
  XPublisher:        XPublisher,
  X_CONFIG:          X_CONFIG,
  X_COMPOSER_SELECTORS: X_COMPOSER_SELECTORS,
  X_LOGIN_INDICATORS: X_LOGIN_INDICATORS,
  buildXCheckLoginScript: buildXCheckLoginScript
};