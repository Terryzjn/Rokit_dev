// electron/browser/platforms/producthunt/ProductHuntPublisher.js
//
// v3 — 系统默认浏览器辅助发布模式
//
// 设计目标：
//   - Product Hunt 在 Electron 内置 BrowserWindow 中无法通过 Cloudflare / "verify you are human"
//     安全验证。我们不再尝试绕过验证。
//   - 改为：调起用户本机的 Edge / Chrome 打开 https://www.producthunt.com/ ，
//     让用户在自己熟悉的浏览器里完成安全验证和登录。
//   - Electron 侧只负责：
//       (1) 调起系统默认浏览器；
//       (2) 在 UI 中显示「Product Hunt 发布助手」面板，提供字段复制按钮。
//   - 永不创建 BrowserWindow、不调 reload、不调 loadURL、不在 BrowserWindow 内注入脚本、不接远程调试协议、不做远程调试。
//   - 最终 Submit / Publish 永远由用户手动点击。
//
// 注册：PublisherRegistry.register('producthunt', ProductHuntPublisher)
//
// 兼容说明：
//   - 老 pub:launch / pub:submit 链路会调用 adapters.producthunt.launch / fill / submit，
//     仍然走 electron/publishers.js 中的 system-browser IIFE，不动这里。
//   - 新 browser:publish 链路会实例化本类，openPlatform 走 shell.openExternal，
//     fillContent / uploadMedia / verify / submit 都是 no-op（仅返回成功标志）。
'use strict';

const PublisherRegistry = require('../../PublisherRegistry');

// ============================================================
// 状态机（v3，简化）
// ============================================================
const PH_STATES = Object.freeze({
  INIT:                            'INIT',
  OPENED_IN_SYSTEM_BROWSER:        'OPENED_IN_SYSTEM_BROWSER',
  USER_DOING_MANUAL_PUBLISH:       'USER_DOING_MANUAL_PUBLISH',
  HELPER_PANEL_READY:              'HELPER_PANEL_READY',
  ERROR:                           'ERROR'
});

// ============================================================
// 工具函数
// ============================================================
function _shell() {
  // 仅在主进程 / 预加载脚本中可获取到 electron.shell。
  // 当本模块被 renderer 侧测试 / require 时，require('electron') 可能没有 shell，
  // 因此用 try/catch 兜底。
  try {
    const { shell } = require('electron');
    if (shell && typeof shell.openExternal === 'function') return shell;
  } catch (_e) {}
  return null;
}

// ============================================================
// ProductHuntPublisher（v3：系统浏览器辅助发布）
// ============================================================
class ProductHuntPublisher {
  constructor(opts = {}) {
    this.platformId = 'producthunt';
    this.state = PH_STATES.INIT;
    this.stateHistory = [{ at: Date.now(), from: null, to: PH_STATES.INIT }];
    this.lastError = null;
    this.lastOpenedUrl = null;
    this._bm = null;
    // opts.shell 允许测试时注入；生产环境走 _shell() 拿真实 shell。
    this._shell = (opts && opts.shell) || _shell();
    this._log('info', 'ProductHuntPublisher (v3 system-browser mode) ready');
  }

  // --------------------------------------------------------
  // 内部：状态转移
  // --------------------------------------------------------
  _transition(next, meta) {
    const prev = this.state;
    this.state = next;
    const entry = { at: Date.now(), from: prev, to: next };
    if (meta) entry.meta = meta;
    this.stateHistory.push(entry);
    return this.state;
  }

  // --------------------------------------------------------
  // 内部：日志
  // --------------------------------------------------------
  _log(level, msg, meta) {
    const line = '[ProductHunt] ' + (meta ? JSON.stringify(meta) + ' ' : '') + msg;
    try { console[level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'log')](line); } catch (_e) {}
  }

  // --------------------------------------------------------
  // openPlatform — 调起系统默认浏览器打开 Product Hunt 首页
  // --------------------------------------------------------
  //
  // ⚠ 关键不变量：
  //   - 不创建 BrowserWindow
  //   - 不调用 loadURL / reload
  //   - 不发送在 BrowserWindow 中注入的脚本、不接远程调试协议、不做远程调试
  //   - 仅通过 electron.shell.openExternal 把控制权交给用户自己的 Edge / Chrome
  //
  async openPlatform(payload) {
    payload = payload || {};
    this._log('info', 'openPlatform requested — handing off to system browser');
    this._bm = null;
    if (!this._shell || typeof this._shell.openExternal !== 'function') {
      const msg = 'electron.shell 不可用；无法打开系统浏览器。请在主进程运行本模块。';
      this.lastError = msg;
      this._log('error', msg);
      this._transition(PH_STATES.ERROR, { error: 'NO_SHELL' });
      return { ok: false, error: 'NO_SHELL', note: msg, state: this.state };
    }
    // 始终打开 PH 首页，让用户先看到自己熟悉的入口；
    // 不再强行打开旧的 /posts/new 链接（用户可能尚未登录 / 尚未完成 CF 验证）。
    const url = 'https://www.producthunt.com/';
    try {
      await this._shell.openExternal(url);
    } catch (e) {
      const msg = String((e && e.message) || e);
      this.lastError = msg;
      this._log('error', 'shell.openExternal failed', { error: msg });
      this._transition(PH_STATES.ERROR, { error: msg });
      return { ok: false, error: msg, state: this.state };
    }
    this.lastOpenedUrl = url;
    this._transition(PH_STATES.OPENED_IN_SYSTEM_BROWSER, { url: url });
    return {
      ok: true,
      state: this.state,
      handedOff: true,
      url: url,
      manualReason:
        'Product Hunt 已在你的系统默认浏览器中打开。请在浏览器中：\n' +
        '1) 完成安全验证\n' +
        '2) 登录 Product Hunt\n' +
        '3) 点击 Submit → New Product\n' +
        '4) 填写 / 粘贴产品信息\n' +
        '5) 手动点击 Submit 完成发布',
      note: '不检测 / 不绕过 / 不破解安全验证；最终 Submit 由用户手动完成。'
    };
  }

  // --------------------------------------------------------
  // fillContent — v3 no-op：不再向浏览器注入 fill 脚本
  // --------------------------------------------------------
  //
  // 字段由 Electron 侧「Product Hunt 发布助手」面板提供一键复制按钮，
  // 用户手动粘贴到系统浏览器里打开的 Product Hunt 表单。
  //
  async fillContent(_payload) {
    this._log('info', 'fillContent requested — v3 uses copy panel, no script injection');
    if (
      this.state !== PH_STATES.OPENED_IN_SYSTEM_BROWSER &&
      this.state !== PH_STATES.USER_DOING_MANUAL_PUBLISH &&
      this.state !== PH_STATES.HELPER_PANEL_READY
    ) {
      this._log('warn', 'fillContent refused — state gate not ready', { state: this.state });
      return {
        ok: false,
        error: 'GATE_NOT_PASSED',
        reason: '请先在 Product Hunt 列表点击「在浏览器中打开 Product Hunt」。',
        state: this.state
      };
    }
    this._transition(PH_STATES.HELPER_PANEL_READY);
    return {
      ok: true,
      state: this.state,
      helper: 'copy-panel',
      manualReason:
        '字段已准备好在「Product Hunt 发布助手」面板一键复制。\n' +
        '请打开 Edge / Chrome，粘贴到 Product Hunt 表单对应字段。'
    };
  }

  // --------------------------------------------------------
  // uploadMedia — v3 no-op：不在系统浏览器里假装上传
  // --------------------------------------------------------
  //
  // 系统浏览器里的 Product Hunt 页面上传由用户手动拖拽 / 选择本地文件完成。
  // Electron 侧「Product Hunt 发布助手」面板会列出图片 / 视频路径，
  // 并提供「打开文件夹」「复制文件路径」按钮。
  //
  async uploadMedia(_payload) {
    this._log('info', 'uploadMedia requested — v3 lets user drag files in system browser');
    if (
      this.state !== PH_STATES.HELPER_PANEL_READY &&
      this.state !== PH_STATES.USER_DOING_MANUAL_PUBLISH &&
      this.state !== PH_STATES.UPLOADING_MEDIA_LEGACY  // 兼容旧测试
    ) {
      // helper-pad 与 u-d-m 之外的合法状态是 none — 一律 no-op 但 ok=true
    }
    return {
      ok: true,
      state: this.state,
      helper: 'media-panel',
      manualReason:
        '图片 / 视频已列在「Product Hunt 发布助手」面板。\n' +
        '请在 Edge / Chrome 中打开 Product Hunt 页面，使用「打开文件夹」或「复制文件路径」按钮拖入上传区域。'
    };
  }

  // --------------------------------------------------------
  // verify — v3 no-op：用户已经在自己浏览器里完成安全验证 + 登录
  // --------------------------------------------------------
  async verify(_payload) {
    this._log('info', 'verify requested — v3 lets user verify in system browser');
    this._transition(PH_STATES.USER_DOING_MANUAL_PUBLISH);
    return {
      ok: true,
      state: this.state,
      readyForManualSend: true,
      manualReason:
        '请在 Edge / Chrome 中确认 Product Hunt 表单已经填好，准备手动点击 Submit。'
    };
  }

  // --------------------------------------------------------
  // submit — 永不自动发送；明确告诉用户必须自己点 Submit
  // --------------------------------------------------------
  async submit(_payload) {
    this._log('info', 'submit skipped — user must click Submit in their browser');
    return {
      ok: false,
      error: 'auto-send-disabled',
      status: 'confirm',
      manualReason: 'user-must-click-send-manually',
      platformNote:
        'Product Hunt Rokit 不自动点 Submit / Publish / Schedule；请在浏览器手动完成发布。',
      state: this.state,
      readyForManualSend: true
    };
  }

  // --------------------------------------------------------
  // 面板数据：提供给 renderer 的「Product Hunt 发布助手」面板
  // --------------------------------------------------------
  buildHelperPanelData(publishTask) {
    const p = publishTask || {};
    const body = String(p.body || p.intro || '');
    const title = String(p.title || '');
    const tagline = body.replace(/\s+/g, ' ').trim().slice(0, 60);
    const description = body || title;
    const website = String(p.link || p.url || p.website || '');
    const images = Array.isArray(p.images) ? p.images.slice() : [];
    const video = p.video || p.videoAsset || null;
    const allText =
      'Product Name:\n' + title + '\n\n' +
      'Tagline:\n' + tagline + '\n\n' +
      'Description:\n' + description + '\n\n' +
      'Website:\n' + (website || '（未提供）') + '\n';
    return {
      platform: 'producthunt',
      mode: 'system-browser-helper',
      fields: {
        productName: { label: 'Product Name', value: title, present: !!title },
        tagline:     { label: 'Tagline',      value: tagline, present: !!tagline },
        description: { label: 'Description',  value: description, present: !!description },
        website:     { label: 'Website',      value: website, present: !!website, missingHint: 'Website：未提供' }
      },
      allText: allText,
      media: {
        images: images.map(function (it) {
          if (typeof it === 'string') return { name: it.split(/[\\/]/).pop(), path: it };
          return {
            name: it.name || (it.path ? it.path.split(/[\\/]/).pop() : ''),
            path: it.path || it.filePath || ''
          };
        }),
        video: video
          ? {
              name: video.fileName || video.name || (video.filePath ? video.filePath.split(/[\\/]/).pop() : ''),
              path: video.filePath || video.path || '',
              mime: video.mimeType || video.mime || ''
            }
          : null
      },
      manualSteps: [
        '在浏览器中完成安全验证',
        '登录 Product Hunt',
        '点击 Submit → New Product',
        '在表单中粘贴「Product Hunt 发布助手」面板的字段',
        '手动点击 Submit 完成发布'
      ],
      state: this.state
    };
  }
}

// ============================================================
// 注册 + 导出
// ============================================================
PublisherRegistry.register('producthunt', ProductHuntPublisher);

module.exports = {
  ProductHuntPublisher: ProductHuntPublisher,
  PH_STATES: PH_STATES
};