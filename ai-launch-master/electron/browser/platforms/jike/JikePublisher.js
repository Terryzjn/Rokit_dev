// Rokit · 即刻 Publisher（v3 状态机精简版）
// ----------------------------------------------------------------
// 唯一职责：把用户传入的 content 写到即刻的动态发布框里。
// 不自动点最终发布按钮 —— 用户在窗口里自己点。
//
// 8 状态机（按用户规范）：
//   INIT ──▶ LOADING ──▶ WAITING_LOGIN ──▶ WAITING_COMPOSER
//        ──▶ FILLING_CONTENT ──▶ UPLOADING_MEDIA ──▶ VERIFYING
//        ──▶ READY_FOR_MANUAL_SEND
//
//   - 任一状态失败：只允许有限次数的 DOM 查找重试（800ms × 15），不刷新页面。
//   - 浏览器导航只调一次：依赖 BrowserManager 自带的 same-url guard
//     （多次 navigate 同一 URL 会被 BrowserManager 内部跳过）。
//
// v3 关键变更（取消"操作过于频繁"导致的应用层失败提示）：
//   - 节流关键字（"操作过于频繁" 等）由 JikePrepareScript 当作"环境信号"记录，
//     **不再 abort**，不影响 ok 字段。
//   - 主进程拿到 submit 路径不弹错误框、不判失败、不 throw。
//   - 仅在开发日志记录一行：
//       [Jike] 检测到网页提示"操作过于频繁"，忽略该提示，不判定为自动发布失败
//
// 入参（兼容多形态）：
//   payload.content                   - 直接文本
//   payload.fillData.content          - 老 adapter 形态
//   payload.publishTask               - 完整 PublishTask 形态
//     publishTask.content: string
//     publishTask.video : { type: 'video'|'image', src: 'https://...' | 'data:...' } | null
'use strict';

const PublisherRegistry = require('../../PublisherRegistry');
const { buildJikePrepareScript }  = require('./JikePrepareScript');
const { buildJikeMediaUploadScript } = require('./JikeMediaUploadScript');

// =====================================================================
// 状态机定义
// =====================================================================
const STATES = [
  'INIT',
  'LOADING',
  'WAITING_LOGIN',
  'WAITING_COMPOSER',
  'FILLING_CONTENT',
  'UPLOADING_MEDIA',
  'VERIFYING',
  'READY_FOR_MANUAL_SEND'
];

// 合法转移（自检用；运行时通过 _transition 显式允许）
const VALID_TRANSITIONS = {
  INIT:                  ['LOADING'],
  LOADING:               ['WAITING_LOGIN', 'WAITING_COMPOSER'],
  WAITING_LOGIN:         ['WAITING_COMPOSER'],
  WAITING_COMPOSER:      ['FILLING_CONTENT'],
  FILLING_CONTENT:       ['UPLOADING_MEDIA', 'VERIFYING'],
  UPLOADING_MEDIA:       ['VERIFYING', 'READY_FOR_MANUAL_SEND'],
  VERIFYING:             ['READY_FOR_MANUAL_SEND'],
  READY_FOR_MANUAL_SEND: []
};

// =====================================================================
// 配置
// =====================================================================
const JIKE_CONFIG = {
  platformId:    'jike',
  platformName:  '即刻',
  // 单次导航：登录后的内容流主页（动态发布入口即此页顶栏）
  homeUrl:       'https://web.okjike.com/',
  // 备用 URL（与 homeUrl 等价；有些客户端默认跳 following）
  composeUrl:    'https://web.okjike.com/following',
  // 等待时长：800ms × 15 = 12s（DOM 查找重试上限）
  pollIntervalMs: 800,
  maxAttempts:    15,
  verifyDelayMs:  800
};

// =====================================================================
// selector 列表（按特异性从高到低）
// =====================================================================
const JIKE_SELECTORS = {
  content: [
    '[contenteditable="true"][role="textbox"][aria-multiline="true"]',
    '[contenteditable="true"][aria-multiline="true"]',
    '[contenteditable="true"][placeholder*="分享你的想法"]',
    '[contenteditable="true"][placeholder*="想法"]',
    '[contenteditable="true"][placeholder*="分享"]',
    '[contenteditable="true"][placeholder*="说点什么"]',
    '[contenteditable="true"][data-placeholder*="想法"]',
    '[contenteditable="true"][data-placeholder*="分享"]',
    '[contenteditable="true"][aria-label*="想法"]',
    '[contenteditable="true"][aria-label*="分享"]',
    'textarea[placeholder*="分享你的想法"]',
    'textarea[placeholder*="想法"]',
    'textarea[placeholder*="分享"]',
    'textarea[aria-multiline="true"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    'textarea'
  ]
};

// =====================================================================
// 主类
// =====================================================================
class JikePublisher {
  constructor() {
    this.platformId   = JIKE_CONFIG.platformId;
    this.platformName = JIKE_CONFIG.platformName;
    this._bm = null;
    // 当前 fillContent 会话的状态（每次调用独立 start 重置）
    this._currentState = 'INIT';
    this._stateHistory = [];
  }

  // -----------------------------------------------------------------
  // 状态机工具
  // -----------------------------------------------------------------
  _transition(next) {
    const prev = this._currentState;
    const allowed = VALID_TRANSITIONS[prev] || [];
    if (allowed.indexOf(next) === -1) {
      console.warn('[Jike][state] INVALID transition ' + prev + ' -> ' + next + ' (allowed: ' + JSON.stringify(allowed) + ')');
      // 不 throw，仍前进（防止卡死）
    }
    this._currentState = next;
    this._stateHistory.push({ from: prev, to: next, t: Date.now() });
    console.log('[Jike][state] ' + prev + ' -> ' + next);
  }

  _resetState() {
    this._currentState = 'INIT';
    this._stateHistory = [];
  }

  // -----------------------------------------------------------------
  // 打开/复用 BrowserWindow + 单次导航
  // -----------------------------------------------------------------
  async openPlatform(payload) {
    const bm = payload && payload.browserManager;
    if (!bm || typeof bm.openPlatform !== 'function') {
      return { ok: false, error: 'no-browser-manager' };
    }
    this._bm = bm;

    let openRes = null;
    try {
      openRes = await bm.openPlatform(this.platformId);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }

    // 单次导航：依赖 BrowserManager 的 same-url guard，不会重复 reload
    if (typeof bm.navigate === 'function') {
      const url = (payload && payload.url) || JIKE_CONFIG.homeUrl;
      try {
        await bm.navigate(this.platformId, url);
      } catch (_e) {
        // navigate 异常（如已 same-url skip）也允许继续
      }
    }

    console.log('[Jike][open] windowId=' + (openRes && openRes.windowId) + ' reused=' + !!(openRes && openRes.reused));
    return { ok: true, windowId: openRes && openRes.windowId, reused: !!(openRes && openRes.reused) };
  }

  // -----------------------------------------------------------------
  // 主流程：填表 + （可选）媒体上传
  // payload: { browserManager?, content?, fillData?, publishTask? }
  // -----------------------------------------------------------------
  async fillContent(payload) {
    payload = payload || {};
    this._resetState();

    const bm = payload.browserManager || this._bm;

    // 解析入参（兼容多种形态）
    const task = this._normalizePayload(payload);

    if (!bm || typeof bm.execute !== 'function') {
      this._transition('INIT'); // 兜底
      return { ok: false, error: 'no-browser-manager', state: this._currentState, stateHistory: this._stateHistory.slice() };
    }
    if (!task.content) {
      return { ok: false, error: 'empty-content', state: this._currentState, stateHistory: this._stateHistory.slice() };
    }

    // ============================================================
    // 状态机：INIT -> LOADING -> WAITING_LOGIN -> WAITING_COMPOSER
    //         -> FILLING_CONTENT -> UPLOADING_MEDIA -> VERIFYING
    //         -> READY_FOR_MANUAL_SEND
    // ============================================================

    // ----- INIT -----
    this._transition('INIT');
    const result = {
      ok:               false,
      throttled:        false,
      throttleSource:   null,
      throttleSample:   '',
      composer:         null,
      fillMethod:       null,
      contentBeforeLen: 0,
      contentAfterLen:  0,
      targetPreview:    task.content.slice(0, 50),
      actualPreview:    '',
      media:            null,
      state:             this._currentState,
      stateHistory:     this._stateHistory.slice(),
      // 关键 flag：UI 看到 ready=true 时停止自动化
      readyForManualSend: false,
      // 不再弹出"无法自动发布：操作过于频繁"
      manualReason:     'user-must-click-send-manually',
      attempts:         0,
      elapsedMs:        0
    };

    // ----- LOADING（确保窗口存在 + 单次导航） -----
    this._transition('LOADING');
    const openRes = await this._ensureOpen(bm);
    if (!openRes.ok) {
      result.error = openRes.error;
      return result;
    }

    // ----- WAITING_LOGIN（轻量检查：等待 did-finish-load + 短暂延迟） -----
    this._transition('WAITING_LOGIN');
    // 这里不做强制登录校验（避免再次猜测身份）
    // 仅以 prepare 脚本能填入(它隐含了：能进入动态框 = 登录态有效)
    // 这里给浏览器留 ~400ms 让页面稳定
    try {
      await new Promise(function (r) { setTimeout(r, 400); });
    } catch (_e) {}

    // ----- WAITING_COMPOSER + FILLING_CONTENT + VERIFYING（合成一步：调 prepare） -----
    this._transition('WAITING_COMPOSER');
    this._transition('FILLING_CONTENT');

    let pr = null;
    try {
      const script = buildJikePrepareScript({
        contentSelectors: JIKE_SELECTORS.content,
        fillData:          { content: task.content },
        pollIntervalMs:    JIKE_CONFIG.pollIntervalMs,
        maxAttempts:       JIKE_CONFIG.maxAttempts,
        verifyDelayMs:     JIKE_CONFIG.verifyDelayMs
      });
      pr = await bm.execute(this.platformId, script);
    } catch (e) {
      result.error = 'execute-threw: ' + String((e && e.message) || e);
      return result;
    }
    if (!pr || typeof pr !== 'object') {
      result.error = 'no-result';
      return result;
    }

    // 把 prepare 的字段复制出来
    result.composer         = pr.composer || null;
    result.fillMethod       = pr.fillMethod || null;
    result.contentBeforeLen = pr.contentBeforeLen || 0;
    result.contentAfterLen  = pr.contentAfterLen || 0;
    result.targetPreview    = pr.targetPreview || result.targetPreview;
    result.actualPreview    = pr.actualPreview || '';
    result.attempts         = pr.attempts || 0;
    result.elapsedMs        = pr.elapsedMs || 0;
    result.throttled        = !!pr.throttled;
    result.throttleSource   = pr.throttleSource || null;
    result.throttleSample   = pr.throttleSample || '';

    // ----- 节流不再判失败：仅日志 -----
    if (result.throttled) {
      console.log('[Jike] 检测到网页提示"操作过于频繁"，忽略该提示，不判定为自动发布失败', {
        throttleSource: result.throttleSource,
        throttleSample: result.throttleSample
      });
    }

    // ----- 填表判定 -----
    // 注意：节流不再作为失败条件。这里仅在填表本身失败时报错。
    if (!pr.ok) {
      result.error = pr.error || 'fill-failed';
      // VERIFYING 失败 → 直接停；不刷新、不重试
      this._transition('VERIFYING');
      return result;
    }

    // ----- UPLOADING_MEDIA（仅当 task.video 存在时） -----
    this._transition('VERIFYING');
    if (task.video && task.video.src) {
      this._transition('UPLOADING_MEDIA');
      try {
        const mediaScript = buildJikeMediaUploadScript({
          media:     { type: task.video.type || 'video', src: task.video.src, name: task.video.name || '' },
          timeoutMs: 15000
        });
        const mr = await bm.execute(this.platformId, mediaScript);
        if (mr && typeof mr === 'object') {
          result.media = {
            found:    !!mr.found,
            ok:       !!mr.ok,
            fileName: mr.fileName || '',
            fileSize: mr.fileSize || 0,
            fileType: mr.fileType || '',
            error:    mr.error || ''
          };
          if (!mr.ok) {
            // 媒体失败不中断整体流程：让用户手动选文件
            console.log('[Jike] 媒体上传未成功，继续让用户在窗口手动添加附件', result.media);
          }
        }
      } catch (e) {
        result.media = { ok: false, error: String((e && e.message) || e) };
      }
    }

    // ----- VERIFYING 终结 -----
    // (已在上一行 transition 到 VERIFYING；若走过 UPLOADING_MEDIA，则从 UPLOADING_MEDIA -> VERIFYING)
    // 这里再校验一次：实际写入长度应 > 0
    if (result.contentAfterLen <= 0) {
      result.error = 'actual-content-empty';
      return result;
    }

    // ----- READY_FOR_MANUAL_SEND -----
    this._transition('READY_FOR_MANUAL_SEND');
    result.ok = true;
    result.state = this._currentState;
    result.stateHistory = this._stateHistory.slice();
    result.readyForManualSend = true;

    console.log('[Jike][fill] ' + JSON.stringify({
      state:           result.state,
      throttled:       result.throttled,
      throttleSource:  result.throttleSource,
      fillMethod:      result.fillMethod,
      contentBefore:   result.contentBeforeLen,
      contentAfter:    result.contentAfterLen,
      targetPreview:   result.targetPreview,
      actualPreview:   result.actualPreview,
      media:           result.media && result.media.ok ? { fileName: result.media.fileName, size: result.media.fileSize } : (result.media ? { notReleased: result.media.error } : null),
      attempts:        result.attempts,
      elapsedMs:       result.elapsedMs
    }));

    return result;
  }

  // -----------------------------------------------------------------
  // 兼容老调用
  // -----------------------------------------------------------------
  async fill(payload)            { return this.fillContent(payload); }
  async prepareContent(payload)  { return this.fillContent(payload); }

  // -----------------------------------------------------------------
  // 永不自动发送
  // -----------------------------------------------------------------
  async submit(/* payload */) {
    return { ok: false, error: 'auto-send-disabled', manualReason: 'user-must-click-send-manually' };
  }

  // -----------------------------------------------------------------
  // 工具
  // -----------------------------------------------------------------
  _normalizePayload(payload) {
    const pt = payload.publishTask;
    if (pt && typeof pt === 'object') {
      return {
        content: String((pt.content != null ? pt.content : '') || ''),
        video:   (pt.video && typeof pt.video === 'object') ? pt.video : null
      };
    }
    const fd = payload.fillData || {};
    const content = String(
      (payload.content != null ? payload.content :
       (fd.content != null ? fd.content : '')) || ''
    );
    return {
      content: content,
      video:   (payload.video && typeof payload.video === 'object') ? payload.video : null
    };
  }

  // 确保窗口存在 + 已导航到首页（不强制 reload；same-url guard 自动跳过）
  async _ensureOpen(bm) {
    try {
      const openRes = await bm.openPlatform(this.platformId);
      if (typeof bm.navigate === 'function') {
        try {
          await bm.navigate(this.platformId, JIKE_CONFIG.homeUrl);
        } catch (_e) {}
      }
      return { ok: true, windowId: openRes && openRes.windowId, reused: !!(openRes && openRes.reused) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
}

PublisherRegistry.register('jike', JikePublisher);

module.exports = {
  JikePublisher:  JikePublisher,
  JIKE_CONFIG:    JIKE_CONFIG,
  JIKE_SELECTORS: JIKE_SELECTORS,
  STATES:         STATES,
  VALID_TRANSITIONS: VALID_TRANSITIONS
};