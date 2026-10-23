// Rokit · 小红书（Xiaohongshu / RED）Publisher（v2.0）
// ----------------------------------------------------------------
// 平台 ID  : xiaohongshu（沿用项目既有 PLATFORMS 命名规范）
// Partition : persist:platform-xiaohongshu（独立持久化 session；不存密码 / Cookie 上行）
// 模式     : Electron 持久化 BrowserWindow + 自动填写（不点击最终发布）
//
// 关键不变量：
//   1) 不发送在 BrowserWindow 中注入的脚本、不接远程调试协议、不做远程调试。
//   2) 不点 Submit / 发布笔记 / 完成。程序永远停在 READY_FOR_MANUAL_SEND。
//   3) 不绕过 Cloudflare / 验证码 / 安全验证；遇阻立即停止。
//   4) 节流文案（"操作过于频繁" 等）只作为环境日志，**不**触发整体失败。
//   5) 媒体文件以 File + DataTransfer 注入 input[type=file]；不上传到非小红书服务器。
//
// 状态机（顺序单向，每态最多执行一次）：
//   INIT
//    ↓
//   LOADING                创建 BrowserWindow（partition: persist:platform-xiaohongshu）
//    ↓
//   WAITING_LOGIN          每 1.5s 检测一次登录状态；超时给出等待 UI
//    ↓
//   LOGIN_CONFIRMED        检测成功
//    ↓
//   NAVIGATING_TO_PUBLISH  直接 loadURL(https://creator.xiaohongshu.com/publish)；
//                          不再从小红书首页 DOM 猜"发布"按钮。
//    ↓
//   WAITING_PUBLISH_PAGE   每 1s 探测发布页真实特征（URL + title + DOM 元素）
//    ↓
//   FILLING_TITLE
//    ↓
//   FILLING_CONTENT
//    ↓
//   UPLOADING_MEDIA        图片 / 视频分别走 Prepare IIFE
//    ↓
//   VERIFYING
//    ↓
//   READY_FOR_MANUAL_SEND  等待用户自己点「发布」
//
// 错误分级：
//   - 硬错误（无法继续）：fail('login-timeout' | 'browser-crash' | 'launch-failed'
//                              | 'creator-redirect-home' | 'creator-need-login')
//   - 软错误（部分缺失）：partialFail({ titleMissing: true, contentMissing: false, mediaMissing: true })
'use strict';

const { buildXiaohongshuPrepareScript } = require('./XiaohongshuPrepareScript');
const { buildXiaohongshuMediaUploadScript } = require('./XiaohongshuMediaUploadScript');
const { PublisherBase } = require('../../PublisherBase');

const PARTITION = 'persist:platform-xiaohongshu';
const HOME_URL = 'https://www.xiaohongshu.com/';
// v2.0：直接走官方创作服务平台，不再从小红书首页猜发布按钮。
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish';

// 登录信号（综合判断）：URL 不再带 /login，DOM 里能匹配以下任一元素。
// 避免依赖 CSS class，仅按可见文本 / role / aria 推断。
const LOGIN_SIGNALS = [
  'header [class*="user"]',
  'header [class*="avatar"]',
  '[role="img"][aria-label*="头像"]',
  '[aria-label*="头像"]',
  '[class*="user-info"]',
  '[class*="user-menu"]'
];
const LOGIN_NEGATIVE_HINTS = [
  '请先登录', '扫码登录', '手机号登录', '未登录', '登录以继续',
  '登录 / 注册', '登录/注册'
];

// 发布页面特征（用于"是否真正进入发布页"综合判定）
const PUBLISH_PAGE_KEYWORDS = [
  '创作服务平台', '创作中心', '发布笔记', '发布视频', '图文', '视频',
  '上传视频', '上传图片', '写正文', '正文', '标题', '封面'
];
// 创作服务平台可能要求重新登录；检测到这些 URL/关键词时不判失败，而是等待用户完成登录。
const CREATOR_LOGIN_HINTS = ['/login', '/signin'];

const TITLE_SELECTORS = [
  'input[placeholder*="标题"]',
  'input[placeholder*="标题" i]',
  '[contenteditable="true"][aria-label*="标题" i]',
  '[data-type="title"] input',
  '[class*="title"] input',
  'textarea[placeholder*="标题" i]',
  'header [class*="title"] input',
  // 创作服务平台常见
  '[placeholder*="请输入标题" i]',
  '[placeholder*="填写标题" i]',
  '[aria-label*="笔记标题" i]'
];
const CONTENT_SELECTORS = [
  '[contenteditable="true"][aria-label*="正文" i]',
  '[contenteditable="true"][aria-label*="内容" i]',
  '[contenteditable="true"][class*="editor" i]',
  'textarea[placeholder*="正文" i]',
  'textarea[placeholder*="正文"]',
  'textarea[placeholder*="内容"]',
  '[class*="editor"] textarea',
  '[class*="post-editor"]',
  '[class*="content-editor"]',
  // 创作服务平台常见
  '[placeholder*="正文" i]',
  '[placeholder*="说点什么" i]',
  '[aria-label*="笔记正文" i]'
];

const XHS_STATES = Object.freeze({
  INIT:                    'INIT',
  LOADING:                 'LOADING',
  WAITING_LOGIN:           'WAITING_LOGIN',
  LOGIN_CONFIRMED:         'LOGIN_CONFIRMED',
  NAVIGATING_TO_PUBLISH:   'NAVIGATING_TO_PUBLISH',
  WAITING_PUBLISH_PAGE:    'WAITING_PUBLISH_PAGE',
  FILLING_TITLE:           'FILLING_TITLE',
  FILLING_CONTENT:         'FILLING_CONTENT',
  UPLOADING_MEDIA:         'UPLOADING_MEDIA',
  VERIFYING:               'VERIFYING',
  READY_FOR_MANUAL_SEND:   'READY_FOR_MANUAL_SEND'
});

class XiaohongshuPublisher extends PublisherBase {
  constructor(opts) {
    super(Object.assign({ platformId: 'xiaohongshu', platformName: '小红书' }, opts || {}));
    this.partition = PARTITION;
    this.state = XHS_STATES.INIT;
    this.stateHistory = [];
    this.window = null;
    this.browserManager = null;
    this.detection = null;
    this.diagnostics = [];
    this.mode = 'auto-attach';
    this.manualReason = '小红书自动安全机制要求：最终发布必须由用户在小红书页面手动完成；程序永不点 Submit / 发布笔记。';
    this.lastPublishUrl = null;
  }

  logInfo(msg, extra) {
    try { console.log('[Xiaohongshu] ' + msg + (extra ? ' ' + JSON.stringify(extra) : '')); }
    catch (_e) { /* noop */ }
  }

  transition(next) {
    if (this.state === next) return;
    this.stateHistory.push({ from: this.state, to: next, at: Date.now() });
    this.state = next;
    this.logInfo('state -> ' + next);
  }

  // ===== 持久化 partition（不存密码 / 不上行 Cookie） =====
  async ensurePartition() {
    if (app && typeof app.getPath === 'function' && !app.isReady()) {
      // app 一般已 ready；这里仅防御性 noop
    }
    return PARTITION;
  }

  // ===== 主入口：和 BrowserManager 对接 =====
  async openPlatform(browserManager) {
    if (this.state !== XHS_STATES.INIT) {
      this.logInfo('openPlatform: already in state ' + this.state);
      return { ok: true, state: this.state, reused: true };
    }
    this.transition(XHS_STATES.LOADING);
    const bm = browserManager;
    try {
      const partition = await this.ensurePartition();
      const url = HOME_URL;
      const r = await bm.createWindow({
        partition,
        url,
        platformId: this.platformId,
        title: 'Rokit · 小红书发布助手',
        onBeforeUnload: null
      });
      this.window = r && r.window;
      this.browserManager = bm;
      this.logInfo('window created', { partition, url });
      // 监听 did-finish-load / did-fail-load / render-process-gone
      if (this.window && typeof this.window.on === 'function') {
        this.window.on('render-process-gone', (_e, details) => {
          this.logInfo('render-process-gone', details);
          this.detection && this.detection.fail('browser-crash');
        });
      }
      this.transition(XHS_STATES.WAITING_LOGIN);
      this.startLoginDetection(bm);
      return { ok: true, state: this.state, url };
    } catch (e) {
      this.logInfo('openPlatform FAILED', { error: String((e && e.message) || e) });
      return { ok: false, state: this.state, error: String((e && e.message) || e) };
    }
  }

  // ===== 登录检测：每 1.5s 一次，命中立即停止 =====
  startLoginDetection(bm) {
    if (this.detection) return this.detection;
    const LOGIN_POLL_INTERVAL = 1500;
    const LOGIN_MAX_ATTEMPTS = 120; // 最多 3 分钟
    let attempts = 0;

    const probeScript = '(' + function () {
      try {
        var body = String(document.body ? document.body.innerText : '');
        var url  = String(location.href || '');
        var negative = ['请先登录', '扫码登录', '手机号登录', '未登录', '登录以继续', '登录 / 注册', '登录/注册', '登录注册'];
        var matched = { foundLoginCTA: false, hint: '', isLoginURL: false };
        for (var i = 0; i < negative.length; i++) {
          if (body.indexOf(negative[i]) !== -1) { matched.foundLoginCTA = true; matched.hint = negative[i]; break; }
        }
        matched.isLoginURL = /\/login|signin|登录/.test(url);
        // 用户信号
        var avatar = document.querySelector('header [class*="avatar"], header [class*="user"], [class*="user-info"], [aria-label*="头像"]');
        matched.hasAvatar = !!(avatar && avatar.getBoundingClientRect().width > 0);
        return matched;
      } catch (e) { return { foundLoginCTA: false, hint: '', isLoginURL: false, hasAvatar: false, error: String(e && e.message || e) }; }
    } + ')()';

    const detector = setInterval(async () => {
      attempts++;
      if (this.state !== XHS_STATES.WAITING_LOGIN) {
        clearInterval(detector);
        return;
      }
      try {
        const r = await bm.execute(this.platformId, probeScript);
        const probe = r && r.result;
        if (probe && !probe.foundLoginCTA && !probe.isLoginURL && probe.hasAvatar) {
          clearInterval(detector);
          this.transition(XHS_STATES.LOGIN_CONFIRMED);
          this.logInfo('login confirmed', { attempts });
          this.startNavigateToPublish(bm);
          return;
        }
        if (attempts === 1 || attempts % 5 === 0) {
          this.logInfo('waiting for manual login', { attempts, probe });
        }
      } catch (e) {
        this.logInfo('login probe error', { attempts, error: String((e && e.message) || e) });
      }
      if (attempts >= LOGIN_MAX_ATTEMPTS) {
        clearInterval(detector);
        this.logInfo('login timeout');
        this.detection && this.detection.fail('login-timeout');
      }
    }, LOGIN_POLL_INTERVAL);
    this.detection = { stop() { clearInterval(detector); }, fail(reason) {
      this.logInfo('detector reported failure', { reason });
    } };
    return this.detection;
  }

  // ===== v2.0：直接导航到官方创作服务平台 =====
  // 之前是从首页 DOM 猜"发布"按钮然后 .click()；现在直接 win.loadURL('https://creator.xiaohongshu.com/publish')。
  startNavigateToPublish(bm) {
    this.transition(XHS_STATES.NAVIGATING_TO_PUBLISH);
    const NAV_MAX_ATTEMPTS = 1; // 最多单次直接导航；不要再 createWindow / reload
    let attempts = 0;
    const navigateAndWait = async () => {
      attempts++;
      this.logInfo('navigating to creator publish page', { url: PUBLISH_URL, attempt: attempts });
      let navOk = true;
      try {
        if (bm && typeof bm.navigate === 'function') {
          await bm.navigate(this.platformId, PUBLISH_URL);
        } else if (this.window && typeof this.window.loadURL === 'function') {
          await this.window.loadURL(PUBLISH_URL);
        } else {
          navOk = false;
        }
      } catch (e) {
        this.logInfo('navigate to publish page error', { error: String((e && e.message) || e) });
        navOk = false;
      }
      if (!navOk) {
        this.logInfo('navigate not available; cannot navigate to publish page');
        // 仍然尝试等待：可能当前已经在发布页（SPA 内部跳转 / 用户已手动打开）
        this.startWaitForPublishPage(bm);
        return;
      }
      this.lastPublishUrl = PUBLISH_URL;
      this.transition(XHS_STATES.WAITING_PUBLISH_PAGE);
      this.startWaitForPublishPage(bm);
    };
    // 只跑一次直接导航
    if (attempts >= NAV_MAX_ATTEMPTS) return;
    navigateAndWait();
  }

  // ===== 等待发布页真实特征 =====
  startWaitForPublishPage(bm) {
    if (this.state !== XHS_STATES.WAITING_PUBLISH_PAGE) {
      this.transition(XHS_STATES.WAITING_PUBLISH_PAGE);
    }
    const POLL_INTERVAL = 1000;
    const MAX_ATTEMPTS = 30; // 30 秒
    const REDIRECT_HOME_MAX = 2; // 连续探测到重定向回首页的次数上限
    let attempts = 0;
    let consecutiveHome = 0;

    // 发布页特征探测脚本
    const PUBLISH_KEYWORDS_JSON = JSON.stringify(PUBLISH_PAGE_KEYWORDS);
    const TITLE_SELS_JSON = JSON.stringify(TITLE_SELECTORS);
    const CONTENT_SELS_JSON = JSON.stringify(CONTENT_SELECTORS);
    const probeScript = `(function(){
      try {
        var url = String(location.href || '');
        var title = String(document.title || '');
        var bodySample = String(document.body ? document.body.innerText : '').slice(0, 800);
        var KEYWORDS = ${PUBLISH_KEYWORDS_JSON};
        var TITLE_SELS = ${TITLE_SELS_JSON};
        var CONTENT_SELS = ${CONTENT_SELS_JSON};

        function vis(el){
          if(!el) return false;
          var r = el.getBoundingClientRect();
          if(r.width <= 0 || r.height <= 0) return false;
          var s = window.getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none';
        }
        function pickVisible(sel){
          try {
            var nodes = document.querySelectorAll(sel);
            for (var i = 0; i < nodes.length; i++) {
              var n = nodes[i]; if (!n) continue;
              if (vis(n)) {
                return {
                  tag: n.tagName,
                  type: n.getAttribute && n.getAttribute('type') || '',
                  placeholder: n.getAttribute && n.getAttribute('placeholder') || '',
                  ariaLabel: n.getAttribute && n.getAttribute('aria-label') || '',
                  name: (n.getAttribute && n.getAttribute('name')) || '',
                  contenteditable: (n.getAttribute && n.getAttribute('contenteditable')) || '',
                  visible: true
                };
              }
            }
          } catch(_e) {}
          return null;
        }
        var titleFound = null;
        for (var ti = 0; ti < TITLE_SELS.length; ti++) {
          var r = pickVisible(TITLE_SELS[ti]);
          if (r) { titleFound = r; break; }
        }
        var contentFound = null;
        for (var ci = 0; ci < CONTENT_SELS.length; ci++) {
          var r2 = pickVisible(CONTENT_SELS[ci]);
          if (r2) { contentFound = r2; break; }
        }
        var fileInputs = document.querySelectorAll('input[type="file"]');
        var fileInfo = [];
        for (var fi = 0; fi < fileInputs.length; fi++) {
          var inp = fileInputs[fi]; if (!inp) continue;
          fileInfo.push({
            accept: inp.getAttribute('accept') || '',
            multiple: inp.hasAttribute('multiple'),
            visible: vis(inp),
            disabled: inp.disabled === true
          });
        }
        var editorFound = !!(titleFound || contentFound || fileInfo.length > 0);
        // 关键词命中
        var keywordHits = [];
        for (var ki = 0; ki < KEYWORDS.length; ki++) {
          if (bodySample.indexOf(KEYWORDS[ki]) !== -1) {
            keywordHits.push(KEYWORDS[ki]);
          }
        }
        var isOnCreator = /creator\\.xiaohongshu\\.com/.test(url);
        var isOnWww = /www\\.xiaohongshu\\.com/.test(url);
        var looksLikeLogin = /\\/(login|signin)\\b/i.test(url) ||
          /请先登录|扫码登录|手机号登录|登录\\s*\\/\\s*注册/.test(bodySample);
        var looksLikePublishPage = editorFound || keywordHits.length >= 1 || isOnCreator;
        return {
          url: url,
          title: title,
          isOnCreator: isOnCreator,
          isOnWww: isOnWww,
          looksLikeLogin: looksLikeLogin,
          looksLikePublishPage: looksLikePublishPage,
          editorFound: editorFound,
          titleFound: titleFound,
          contentFound: contentFound,
          fileInputCount: fileInfo.length,
          fileInputs: fileInfo,
          keywordHits: keywordHits.slice(0, 10),
          inputCount: document.querySelectorAll('input').length,
          textareaCount: document.querySelectorAll('textarea').length,
          contenteditableCount: document.querySelectorAll('[contenteditable="true"]').length,
          visibleLinkCount: document.querySelectorAll('a').length,
          visibleButtonCount: document.querySelectorAll('button').length
        };
      } catch (e) {
        return { url: String(location.href || ''), title: String(document.title || ''), error: String((e && e.message) || e) };
      }
    })()`;

    const detector = setInterval(async () => {
      attempts++;
      if (this.state !== XHS_STATES.WAITING_PUBLISH_PAGE) {
        clearInterval(detector);
        return;
      }
      if (!this.window || (this.window.isDestroyed && this.window.isDestroyed())) {
        clearInterval(detector);
        return;
      }
      let probe = null;
      try {
        const r = await bm.execute(this.platformId, probeScript);
        probe = r && r.result;
      } catch (e) {
        this.logInfo('publish page probe error', { attempts, error: String((e && e.message) || e) });
      }

      // 重定向回到首页：记录次数，超过阈值则停止
      if (probe && probe.isOnWww) {
        consecutiveHome++;
        this.logInfo('creator publish page redirected back to www', {
          attempts,
          url: probe.url,
          title: probe.title,
          consecutiveHome
        });
        if (consecutiveHome >= REDIRECT_HOME_MAX) {
          clearInterval(detector);
          this.logInfo('官方发布页被重定向回首页 → 停止', {
            finalUrl: probe.url, title: probe.title
          });
          this.diagnostics.push({ phase: 'publish-page', at: Date.now(), error: 'creator-redirect-home', probe });
          this.detection && this.detection.fail('creator-redirect-home');
          return;
        }
      } else {
        consecutiveHome = 0;
      }

      // 命中"创作平台 / 发布编辑器 / 标题 或 正文 / 文件上传控件"
      if (probe && probe.looksLikePublishPage && !probe.looksLikeLogin) {
        clearInterval(detector);
        this.logInfo('publish page ready', {
          attempts,
          url: probe.url,
          title: probe.title,
          titleFound: probe.titleFound,
          contentFound: probe.contentFound,
          fileInputCount: probe.fileInputCount,
          keywordHits: probe.keywordHits
        });
        // 不直接 transition 到 FILLING_TITLE —— fillContent 内部会做
        return;
      }

      // 在创作平台但要求登录：等用户完成登录（不报错）
      if (probe && probe.looksLikeLogin) {
        if (attempts === 1 || attempts % 5 === 0) {
          this.logInfo('等待用户在创作服务平台完成登录', {
            attempts, url: probe.url
          });
        }
        if (attempts >= MAX_ATTEMPTS) {
          clearInterval(detector);
          this.logInfo('等待创作平台登录超时', { attempts });
          this.diagnostics.push({ phase: 'publish-page', at: Date.now(), error: 'creator-need-login', probe });
          this.detection && this.detection.fail('creator-need-login');
          return;
        }
        await new Promise(function (r) { setTimeout(r, POLL_INTERVAL); });
        return;
      }

      if (attempts === 1 || attempts % 5 === 0) {
        this.logInfo('waiting for publish page', {
          attempts,
          url: probe && probe.url,
          title: probe && probe.title,
          editorFound: probe && probe.editorFound,
          keywordHits: probe && probe.keywordHits,
          fileInputCount: probe && probe.fileInputCount
        });
      }
      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(detector);
        this.logInfo('publish page timeout; running diagnostics', {
          attempts,
          lastProbe: probe
        });
        this.diagnostics.push({ phase: 'publish-page', at: Date.now(), error: 'publish-page-timeout', probe });
        this.detection && this.detection.fail('publish-page-timeout');
      }
      await new Promise(function (r) { setTimeout(r, POLL_INTERVAL); });
    }, POLL_INTERVAL);
  }

  // ===== 填表：标题 + 正文 =====
  async fillContent(args) {
    if (this.state === XHS_STATES.WAITING_LOGIN) {
      return { ok: false, state: this.state, error: 'login-required', manualRequired: true };
    }
    if (this.state !== XHS_STATES.LOGIN_CONFIRMED &&
        this.state !== XHS_STATES.NAVIGATING_TO_PUBLISH &&
        this.state !== XHS_STATES.WAITING_PUBLISH_PAGE &&
        this.state !== XHS_STATES.READY_FOR_MANUAL_SEND) {
      return { ok: false, state: this.state, error: 'bad-state' };
    }
    const bm = (args && args.browserManager) || this.browserManager;
    const fillData = (args && args.fillData) || {};

    // v2.0：如果还没去到官方发布页，确保触发一次导航 + 等候就绪
    if (bm && (this.state === XHS_STATES.LOGIN_CONFIRMED ||
               this.state === XHS_STATES.NAVIGATING_TO_PUBLISH)) {
      try {
        if (this.state === XHS_STATES.LOGIN_CONFIRMED) {
          this.startNavigateToPublish(bm);
        }
      } catch (_e) { /* noop */ }
    }

    // 解析入参：从 PublishTask 真实字段读取；不强求字段名一定是 title/content
    const task = (args && args.publishTask) || {};
    const title   = String(
      (fillData && fillData.title) ||
      task.title ||
      (args && args.title) ||
      ''
    );
    const content = String(
      (fillData && fillData.content) ||
      task.content ||
      task.body ||
      (args && args.body) ||
      ''
    );

    this.logInfo('fillContent start', {
      state: this.state,
      titleLen: title.length,
      contentLen: content.length,
      hasTitle: !!title,
      hasContent: !!content
    });

    const code = buildXiaohongshuPrepareScript({
      titleSelectors:   TITLE_SELECTORS,
      contentSelectors: CONTENT_SELECTORS,
      fillData:         { title: title, content: content },
      pollIntervalMs:   800,
      maxAttempts:      15,
      verifyDelayMs:    800
    });

    let prepareResult;
    try {
      prepareResult = await bm.execute(this.platformId, code);
    } catch (e) {
      prepareResult = { result: { ok: false, error: String((e && e.message) || e) } };
    }
    const prep = (prepareResult && prepareResult.result) || {};
    this.diagnostics.push({ phase: 'prepare', at: Date.now(), result: prep });

    this.logInfo('title 填充', {
      targetLen: title.length,
      afterLen: prep.titleActualLen || 0,
      method: prep.titleMethod || null,
      ok: (prep.titleActualLen || 0) > 0
    });
    this.logInfo('content 填充', {
      targetLen: content.length,
      afterLen: prep.contentActualLen || 0,
      method: prep.contentMethod || null,
      ok: (prep.contentActualLen || 0) > 0
    });

    // 软失败判定
    const titleMissing   = title && (!prep.titleActualLen || /title-/.test(prep.error || ''));
    const contentMissing = content && (!prep.contentActualLen || /content-/.test(prep.error || ''));

    if (prep.titleActualLen > 0) this.transition(XHS_STATES.FILLING_TITLE);
    if (prep.contentActualLen > 0 && this.state === XHS_STATES.FILLING_TITLE) {
      this.transition(XHS_STATES.FILLING_CONTENT);
    }

    return {
      ok: !titleMissing && !contentMissing,
      state: this.state,
      titleActualLen:    prep.titleActualLen    || 0,
      contentActualLen:  prep.contentActualLen  || 0,
      titleActualPreview:    prep.titleActualPreview    || '',
      contentActualPreview:  prep.contentActualPreview  || '',
      titleMethod:   prep.titleMethod   || null,
      contentMethod: prep.contentMethod || null,
      pageMode:      prep.pageMode      || null,
      fileInputs:    prep.fileInputs    || [],
      titleMissing, contentMissing,
      error: prep.error || '',
      domProbe: prep.domProbe || null
    };
  }

  // ===== 上传媒体 =====
  async uploadMedia(args) {
    const bm = (args && args.browserManager) || this.browserManager;
    // 兼容多种形态：media / images / videos / publishTask.mediaItems
    let media = (args && args.media) || null;
    if (!media && args && args.publishTask) {
      const t = args.publishTask;
      if (Array.isArray(t.mediaItems) && t.mediaItems.length) {
        media = { type: t.mediaType || (t.mediaItems[0].type || 'image'), items: t.mediaItems };
      } else if (t.video) {
        media = { type: 'video', items: [{ src: t.video.src, name: t.video.name, mime: t.video.mime }] };
      } else if (t.images && Array.isArray(t.images) && t.images.length) {
        media = { type: 'image', items: t.images.map(function(it){ return { src: it.src, name: it.name, mime: it.mime }; }) };
      }
    }
    if (!media || !(media.items && media.items.length)) {
      return { ok: true, state: this.state, pickedCount: 0, skipped: true, reason: 'no-media' };
    }
    this.transition(XHS_STATES.UPLOADING_MEDIA);
    const code = buildXiaohongshuMediaUploadScript({
      media: media,
      timeoutMs: 15000
    });
    let uploadResult;
    try {
      uploadResult = await bm.execute(this.platformId, code);
    } catch (e) {
      uploadResult = { result: { ok: false, error: String((e && e.message) || e) } };
    }
    const up = (uploadResult && uploadResult.result) || {};
    this.diagnostics.push({ phase: 'media', at: Date.now(), result: up });
    this.transition(XHS_STATES.VERIFYING);
    this.logInfo('media 上传', {
      type: up.mode || media.type || 'image',
      pickedCount: up.pickedCount || 0,
      totalSize: up.totalSize || 0,
      ok: up.ok === true
    });
    const ok = up.ok === true && up.found === true && (up.pickedCount || 0) > 0;
    return {
      ok,
      state: this.state,
      mode: up.mode || media.type || 'image',
      pickedCount: up.pickedCount || 0,
      fileNames: up.fileNames || [],
      totalSize:  up.totalSize  || 0,
      fileInputs: up.fileInputs || [],
      attempts:   up.attempts   || 0,
      elapsedMs:  up.elapsedMs  || 0,
      error: ok ? '' : (up.error || 'unknown')
    };
  }

  // ===== 验证：只看页面有没有"发布"按钮文字存在，**不点击** =====
  async verify(args) {
    const bm = (args && args.browserManager) || this.browserManager;
    const code = '(' + function () {
      try {
        var body = String(document.body ? document.body.innerText : '');
        var submitHints = ['发布', '发布笔记', '发布视频'];
        var foundSubmitText = submitHints.some(function (h) { return body.indexOf(h) !== -1; });
        // 探测发布按钮位置（但绝不动手）
        var buttons = document.querySelectorAll('button, [role="button"]');
        var matches = [];
        for (var i = 0; i < buttons.length; i++) {
          var b = buttons[i]; if (!b) continue;
          var rect = b.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          var txt = String(b.textContent || '').trim();
          if (submitHints.indexOf(txt) !== -1 || (txt.length <= 6 && submitHints.some(function (h) { return txt.indexOf(h) !== -1; }))) {
            matches.push({ tag: b.tagName, text: txt, disabled: b.disabled === true });
          }
        }
        return { foundSubmitText: foundSubmitText, candidates: matches.slice(0, 5) };
      } catch (e) { return { foundSubmitText: false, candidates: [], error: String(e && e.message || e) }; }
    } + ')()';
    let vResult;
    try {
      vResult = await bm.execute(this.platformId, code);
    } catch (e) {
      vResult = { result: { foundSubmitText: false, candidates: [], error: String((e && e.message) || e) } };
    }
    const vr = (vResult && vResult.result) || {};
    this.diagnostics.push({ phase: 'verify', at: Date.now(), result: vr });
    this.transition(XHS_STATES.READY_FOR_MANUAL_SEND);
    this.logInfo('最终状态：READY_FOR_MANUAL_SEND', { manualReason: this.manualReason });
    return {
      ok: true,
      state: this.state,
      readyForManualSend: true,
      foundSubmitText: vr.foundSubmitText === true,
      candidates: vr.candidates || [],
      manualReason: this.manualReason,
      error: ''
    };
  }

  // ===== 关闭 BrowserWindow（不做 saveAs / prompt） =====
  async close() {
    try {
      if (this.window && !this.window.isDestroyed && this.window.isDestroyed()) {
        // already destroyed
      } else if (this.window && typeof this.window.destroy === 'function') {
        this.window.destroy();
      }
    } catch (e) {
      this.logInfo('close error', { error: String((e && e.message) || e) });
    }
    this.window = null;
    return { ok: true, closed: true };
  }

  // 适配器层使用的"查询状态"
  getStatus() {
    return {
      ok: true,
      state: this.state,
      platform: this.platformId,
      mode: this.mode,
      readyForManualSend: this.state === XHS_STATES.READY_FOR_MANUAL_SEND,
      manualReason: this.manualReason,
      history: this.stateHistory.slice(0, 10)
    };
  }

  // 适配器层：被 prod 模式填表 IIFE 复用
  async runFill(args) {
    const r1 = await this.fillContent(args);
    if (r1 && (r1.titleMissing || r1.contentMissing)) {
      // 部分填写失败：报告，但不抛出
    }
    return r1;
  }
}

module.exports = {
  XiaohongshuPublisher,
  XiaohongshuStates: XHS_STATES,
  PARTITION: PARTITION,
  HOME_URL: HOME_URL,
  PUBLISH_URL: PUBLISH_URL,
  PUBLISH_PAGE_KEYWORDS: PUBLISH_PAGE_KEYWORDS,
  TITLE_SELECTORS: TITLE_SELECTORS,
  CONTENT_SELECTORS: CONTENT_SELECTORS
};
