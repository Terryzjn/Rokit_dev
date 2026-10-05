// Rokit · 统一 BrowserWindow + Session 管理（v1.7 + v1.10 诊断增强）
// ----------------------------------------------------------------
// 与需求文档二、三、五、十六、十七、十九、二十、二十一条对应：
//   - 每个 platformId 对应一个独立 Electron BrowserWindow 实例（不会重复创建）。
//   - 每个平台使用独立 partition：persist:platform-{platformId}，
//     登录态由 Electron Session 自动落盘到 userData/Partitions/platform-{platformId}。
//   - 默认 webPreferences: contextIsolation=true, nodeIntegration=false, sandbox=true，
//     绝不把 Node API 直接暴露给网页（除非某个平台必须关闭并加注释说明原因）。
//   - 不修改用户系统浏览器的 Cookie；不在 JSON 文件里保存 Cookie；不抓密码。
//   - 提供 openPlatform / closePlatform / getPlatformWindow / isPlatformOpen /
//     navigate / execute / onceNavigated 等 API，供 PublisherRegistry 调用。
//   - 与现有 main.js 中的 pubWin 单实例 BrowserWindow（persist:pub）
//     **完全独立**，老逻辑（11 个平台字符串脚本注入）不受影响。
//
// v1.10 变更（V2EX 白屏定位专用）：
//   - 默认 userAgent 改为 **带 Chrome 标识的现代 UA**（去掉 Electron 默认 UA
//     中的 "Electron/x.y.z" 字段），解决 Cloudflare / V2EX 把 Electron UA 识别为
//     自动化浏览器后直接返回拦截页（表现为"白屏"）的问题。
//   - 关键：仅设置 userAgent，**不动** webSecurity / contextIsolation / sandbox
//     / nodeIntegration / CSP / partition 等安全配置。
//   - 默认对每个 BrowserWindow 挂载**完整 10 项诊断日志**：
//       did-start-loading, did-stop-loading, did-finish-load, did-fail-load,
//       did-frame-finish-load, render-process-gone, unresponsive,
//       console-message, plus 当前 URL 与 title。
//   - 每个平台窗口保留最近 200 条诊断事件（环形缓冲），提供 getDiagnostics(platformId)
//     让 Renderer 直接查看「为什么这个平台白屏」。
//   - 不写 Cookie / 不抓密码 / 不改用户系统浏览器的任何数据。
'use strict';

const { BrowserWindow, session } = require('electron');

// =====================================================================
// 默认 userAgent：去掉 Electron 标识，避免 Cloudflare / V2EX 把内置浏览器
// 误判为机器人后直接返回拦截页。这是 Electron 内置浏览器白屏最常见的根因之一。
//
// 策略：保留 Electron/Chromium 实际能解析的 Chrome 主版本号（保证网站兼容性），
//       只把 Electron/x.y.z 标记删掉。Electron 会自动补回 Chrome/xxx.0.0.0
//       Safari/537.36 等同真实 Chrome 一致的部分。
//
// 调用方如果想完全自定义 UA，可以在 openPlatform(platformId, { webPreferences:
// { userAgent: 'xxx' } }) 时覆盖。
// =====================================================================
var DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 单条诊断事件保留的最大数量（环形缓冲）
var DIAG_BUFFER_SIZE = 200;

class BrowserManager {
  constructor(opts) {
    opts = opts || {};
    this.logger = opts.logger || console;
    // platformId -> { window, partitionName, listeners, isReady, diag, _diagCount }
    this._windows = Object.create(null);
    // 默认窗口配置（平台子类可覆盖）
    this.defaultWindowOptions = Object.assign({
      width: 1220,
      height: 880,
      show: true,
      title: 'Rokit · 内置浏览器',
      backgroundColor: '#F4F7F6',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // v1.10：默认 UA 去掉 Electron 标识，避免被 Cloudflare 等拦截
        // 平台 openPlatform 时可以通过 options.webPreferences.userAgent 覆盖
        userAgent: DEFAULT_USER_AGENT
      }
    }, opts.defaultWindowOptions || {});

    // 默认 partition 前缀（Electron 约定 "persist:" 开头的 partition 才会落盘）
    this.partitionPrefix = opts.partitionPrefix || 'persist:platform-';

    // 在 BrowserWindow 内部用于显示导航控件的额外 UI（可选）
    this.toolbarHtmlPath = opts.toolbarHtmlPath || null;

    // 监听 did-finish-load 时的额外回调
    this.onWindowReady = typeof opts.onWindowReady === 'function' ? opts.onWindowReady : null;
  }

  // 计算 partition 名
  _partition(platformId) {
    return this.partitionPrefix + String(platformId);
  }

  // 安全判断窗口存活
  _isAlive(entry) {
    return !!(entry && entry.window && !entry.window.isDestroyed()
      && entry.window.webContents && !entry.window.webContents.isDestroyed());
  }

  // 是否已为该平台打开
  isPlatformOpen(platformId) {
    var entry = this._windows[String(platformId)];
    return this._isAlive(entry);
  }

  // 获取窗口（renderer 不要直接拿 BrowserWindow；这是 Main 内部使用）
  getPlatformWindow(platformId) {
    var entry = this._windows[String(platformId)];
    if (!this._isAlive(entry)) return null;
    return entry.window;
  }

  // 打开平台窗口（已存在则聚焦）
  openPlatform(platformId, options) {
    var id = String(platformId);
    var existing = this._windows[id];
    if (this._isAlive(existing)) {
      // 已有窗口 → 聚焦并返回
      try {
        existing.window.show();
        existing.window.focus();
      } catch (_e) {}
      return Promise.resolve({ reused: true, windowId: existing.window.id });
    }

    var partition = this._partition(id);
    var winOpts = Object.assign({}, this.defaultWindowOptions, options || {});
    // 合并 webPreferences，强制安全设置（除非调用方明确覆盖）
    winOpts.webPreferences = Object.assign(
      {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: partition
      },
      winOpts.webPreferences || {},
      { partition: partition } // partition 不可被覆盖
    );
    winOpts.title = winOpts.title || ('Rokit · ' + id);
    var win;
    try {
      win = new BrowserWindow(winOpts);
    } catch (e) {
      this.logger.error('[BrowserManager] 创建 BrowserWindow 失败', {
        platformId: id,
        error: String((e && e.message) || e)
      });
      throw new Error('无法打开内置浏览器：' + String((e && e.message) || e));
    }

    var entry = {
      window: win,
      partitionName: partition,
      listeners: [],
      isReady: false,
      pendingNavigations: [],
      // v1.10：最近 200 条诊断事件环形缓冲，给 Renderer 通过 getDiagnostics 查看
      diag: [],
      _diagCount: 0,
      _diagStart: 0,
      _diagSize: DIAG_BUFFER_SIZE
    };
    this._windows[id] = entry;

    // 卸载时清理 entry，避免幽灵引用
    win.on('closed', function () {
      // entry 已无引用，但保留结构以便 isPlatformOpen 立刻 false
      if (this._windows[id] === entry) delete this._windows[id];
    }.bind(this));

    // ============================================================
    // v1.10：完整 10 项 webContents 诊断日志（白屏定位专用）
    //   1) did-start-loading
    //   2) did-stop-loading
    //   3) did-finish-load
    //   4) did-fail-load（带 errorCode / errorDescription / validatedURL）
    //   5) did-frame-finish-load（带 isMainFrame）
    //   6) render-process-gone（renderer 崩溃）
    //   7) unresponsive / responsive（renderer 卡死 / 恢复）
    //   8) console-message（页面 console 输出）
    //   9) 当前 URL（每次事件后打点）
    //  10) 当前 title（每次事件后打点）
    // 所有事件同时写入 entry.diag 环形缓冲，供 getDiagnostics(platformId) 查询。
    // ============================================================
    var self = this;
    function snapshot(level, message) {
      var url = '', title = '';
      try { url = win.webContents.getURL(); } catch (_e) {}
      try { title = win.webContents.getTitle(); } catch (_e) {}
      var rec = {
        t: Date.now(),
        level: level,
        url: url,
        title: title,
        message: message
      };
      // 环形缓冲
      if (!Array.isArray(entry.diag)) {
        entry.diag = [];
        entry._diagCount = 0;
        entry._diagStart = 0;
        entry._diagSize = DIAG_BUFFER_SIZE;
      }
      entry.diag[entry._diagStart] = rec;
      entry._diagStart = (entry._diagStart + 1) % entry._diagSize;
      entry._diagCount = Math.min(entry._diagCount + 1, entry._diagSize);
    }

    win.webContents.on('did-start-loading', function () {
      self.logger.info('[' + id + ' Browser] did-start-loading', {
        platformId: id, partition: partition
      });
      snapshot('info', 'did-start-loading');
    });

    win.webContents.on('did-stop-loading', function () {
      self.logger.info('[' + id + ' Browser] did-stop-loading', {
        platformId: id, partition: partition
      });
      snapshot('info', 'did-stop-loading');
    });

    win.webContents.on('did-finish-load', function () {
      entry.isReady = true;
      var url = '', title = '';
      try { url = win.webContents.getURL(); } catch (_e) {}
      try { title = win.webContents.getTitle(); } catch (_e) {}
      self.logger.info('[' + id + ' Browser] did-finish-load', {
        platformId: id, partition: partition,
        url: url, title: title
      });
      snapshot('info', 'did-finish-load');
      if (self.onWindowReady) {
        try { self.onWindowReady({ platformId: id, url: url }); }
        catch (_e) {}
      }
    });

    win.webContents.on('did-fail-load', function (_ev, errorCode, errorDescription, validatedURL, isMainFrame) {
      self.logger.warn('[' + id + ' Browser] did-fail-load', {
        platformId: id, partition: partition,
        errorCode: errorCode,
        errorDescription: errorDescription,
        validatedURL: validatedURL,
        isMainFrame: !!isMainFrame
      });
      snapshot('warn', 'did-fail-load errorCode=' + errorCode + ' ' + errorDescription + ' url=' + validatedURL);
    });

    win.webContents.on('did-frame-finish-load', function (_ev, isMainFrame, _frameProcessId, _frameRoutingId) {
      // 子 frame 也算，避免错过 SPA iframe 的失败
      self.logger.info('[' + id + ' Browser] did-frame-finish-load', {
        platformId: id, partition: partition,
        isMainFrame: !!isMainFrame
      });
      if (isMainFrame) snapshot('info', 'did-frame-finish-load (main)');
    });

    win.webContents.on('render-process-gone', function (_ev, details) {
      // details: { reason, exitCode }
      self.logger.error('[' + id + ' Browser] render-process-gone', {
        platformId: id, partition: partition,
        reason: details && details.reason,
        exitCode: details && details.exitCode
      });
      snapshot('error', 'render-process-gone reason=' + (details && details.reason) + ' exitCode=' + (details && details.exitCode));
    });

    win.webContents.on('unresponsive', function () {
      self.logger.warn('[' + id + ' Browser] unresponsive', {
        platformId: id, partition: partition
      });
      snapshot('warn', 'unresponsive');
    });

    win.webContents.on('responsive', function () {
      self.logger.info('[' + id + ' Browser] responsive (recovered)', {
        platformId: id, partition: partition
      });
      snapshot('info', 'responsive');
    });

    // console-message：把页面里的 console 输出也写进诊断（用于发现 CSP / 401 / 403 等）
    win.webContents.on('console-message', function (_ev, level, message, line2, source2) {
      // level: 0=verbose 2=warning 3=error
      var lv = level >= 3 ? 'error' : (level === 2 ? 'warn' : 'log');
      self.logger.info('[' + id + ' Browser] console-message', {
        platformId: id, partition: partition,
        level: lv, message: message, source: source2, line: line2
      });
      // 只把 warn / error 写进环形缓冲（避免 verbose 噪声撑爆）
      if (level >= 2) {
        snapshot(lv, 'console: ' + String(message).slice(0, 200));
      }
    });

    // 默认在 BrowserWindow 上方放一个轻量控件栏（返回 / 前进 / 刷新 / 地址栏 / 关闭）
    // 通过额外注入的 init script 把工具栏插入网页（不接管整个网页，仅 top banner）
    win.webContents.on('dom-ready', function () {
      try { self._injectToolbar(win, id); } catch (_e) {}
    });

    this.logger.info('[BrowserManager] Opening platform', {
      platformId: id,
      partition: partition,
      title: winOpts.title
    });
    return Promise.resolve({ reused: false, windowId: win.id, partition: partition });
  }

  // 注入顶部工具栏（不接管网页、不抢焦点；仅显示一个返回/前进/刷新/关闭按钮）
  // 由 did-finish-load 后调用 ipcRenderer 关闭按钮使用 mainWindow.api.browserClose
  _injectToolbar(win, _platformId) {
    try {
      var script = "(function(){\n" +
        "try{\n" +
        "  if(document.getElementById('rokit-browser-toolbar')) return;\n" +
        "  var bar=document.createElement('div');\n" +
        "  bar.id='rokit-browser-toolbar';\n" +
        "  bar.setAttribute('data-rokit','browser-toolbar');\n" +
        "  bar.style.cssText='position:fixed;top:0;left:0;right:0;z-index:2147483646;display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(244,247,246,.95);border-bottom:1px solid #E3EBEA;font:13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1A2226;';\n" +
        "  function mkBtn(t,fn){var b=document.createElement('button');b.textContent=t;b.style.cssText='padding:4px 10px;border:1px solid #E3EBEA;background:#fff;border-radius:6px;cursor:pointer;font:inherit;color:inherit';b.onclick=fn;return b;}\n" +
        "  bar.appendChild(mkBtn('← 后退',function(){history.back();}));\n" +
        "  bar.appendChild(mkBtn('前进 →',function(){history.forward();}));\n" +
        "  bar.appendChild(mkBtn('刷新',function(){location.reload();}));\n" +
        "  var url=document.createElement('span');url.id='rokit-browser-url';url.style.cssText='flex:1;padding:4px 8px;background:#fff;border:1px solid #E3EBEA;border-radius:6px;color:#5A6B72;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';url.textContent=location.href;bar.appendChild(url);\n" +
        "  bar.appendChild(mkBtn('关闭',function(){window.close();}));\n" +
        "  document.body.appendChild(bar);\n" +
        "  // 地址栏同步\n" +
        "  var observer=new MutationObserver(function(){var u=document.getElementById('rokit-browser-url');if(u)u.textContent=location.href;});\n" +
        "  try{observer.observe(document.querySelector('title')||document.head,{childList:true,characterData:true,subtree:true});}catch(_e){}\n" +
        "}catch(_e){}\n" +
        "})();";
      win.webContents.executeJavaScript(script, true).catch(function (_e) {});
    } catch (_e) {}
  }

  // 关闭平台窗口
  closePlatform(platformId) {
    var id = String(platformId);
    var entry = this._windows[id];
    if (!this._isAlive(entry)) return Promise.resolve(false);
    try {
      entry.window.close();
    } catch (e) {
      this.logger.warn('[BrowserManager] closePlatform 异常', { platformId: id, error: String((e && e.message) || e) });
    }
    return Promise.resolve(true);
  }

  // 导航到 URL
  navigate(platformId, url) {
    var id = String(platformId);
    var entry = this._windows[id];
    if (!this._isAlive(entry)) {
      // 没有窗口则先打开
      return this.openPlatform(id).then(function () {
        return this.navigate(id, url);
      }.bind(this));
    }
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return Promise.reject(new Error('navigate: URL 必须以 http/https 开头'));
    }
    this.logger.info('[BrowserManager] Navigating', { platformId: id, url: url });
    return Promise.resolve(entry.window.loadURL(url))
      .catch(function (e) {
        this.logger.warn('[BrowserManager] navigate 失败', {
          platformId: id,
          url: url,
          error: String((e && e.message) || e)
        });
        throw e;
      }.bind(this));
  }

  // 在网页上下文执行 JS（IIFE 字符串或函数体字符串）
  execute(platformId, script) {
    var id = String(platformId);
    var entry = this._windows[id];
    if (!this._isAlive(entry)) {
      return Promise.reject(new Error('平台窗口未打开：' + id));
    }
    if (typeof script !== 'string') {
      return Promise.reject(new Error('execute: script 必须是字符串（IIFE）'));
    }
    return Promise.resolve(entry.window.webContents.executeJavaScript(script, true))
      .catch(function (e) {
        if (/has been destroyed/i.test(String((e && e.message) || e))) {
          this.logger.warn('[BrowserManager] execute 时窗口已销毁', { platformId: id });
          throw new Error('WINDOW_DESTROYED');
        }
        this.logger.warn('[BrowserManager] execute 失败', {
          platformId: id,
          error: String((e && e.message) || e)
        });
        throw e;
      }.bind(this));
  }

  // 监听导航（BrowserWindow 用）
  onceNavigated(platformId, cb) {
    var id = String(platformId);
    var entry = this._windows[id];
    if (!this._isAlive(entry)) {
      // 不在窗口上：下一次 navigate 时再触发（用回调）
      this._waitForWindow(id).then(function (win) {
        if (!win || !win.webContents) return;
        var fn = function () {
          try { cb(); } catch (_e) {}
          try { win.webContents.removeListener('did-navigate', fn); } catch (_e) {}
          try { win.webContents.removeListener('did-navigate-in-page', fn); } catch (_e) {}
        };
        win.webContents.on('did-navigate', fn);
        win.webContents.on('did-navigate-in-page', fn);
      });
      return;
    }
    var win = entry.window;
    var fn = function () {
      try { cb(); } catch (_e) {}
      try { win.webContents.removeListener('did-navigate', fn); } catch (_e) {}
      try { win.webContents.removeListener('did-navigate-in-page', fn); } catch (_e) {}
    };
    win.webContents.on('did-navigate', fn);
    win.webContents.on('did-navigate-in-page', fn);
  }

  _waitForWindow(platformId) {
    var id = String(platformId);
    var self = this;
    return new Promise(function (resolve) {
      var tries = 0;
      function tick() {
        var entry = self._windows[id];
        if (self._isAlive(entry)) return resolve(entry.window);
        if (++tries > 200) return resolve(null);
        setTimeout(tick, 50);
      }
      tick();
    });
  }

  // 获取 Session（不提供给 Renderer；Main 内部使用）
  getSession(platformId) {
    var id = String(platformId);
    return session.fromPartition(this._partition(id));
  }

  // 销毁 Session（清空登录态）。**仅在用户显式确认后调用**。
  destroySession(platformId) {
    var id = String(platformId);
    var sess = session.fromPartition(this._partition(id));
    return new Promise(function (resolve) {
      try {
        sess.clearStorageData().then(function () { resolve(true); }, function () { resolve(false); });
      } catch (_e) { resolve(false); }
    });
  }

  // 列出所有平台窗口状态
  status() {
    var out = [];
    Object.keys(this._windows).forEach(function (id) {
      var entry = this._windows[id];
      if (!entry) return;
      var alive = this._isAlive(entry);
      out.push({
        platformId: id,
        partition: entry.partitionName,
        alive: alive,
        url: alive && entry.window.webContents ? entry.window.webContents.getURL() : '',
        title: alive && entry.window.webContents ? entry.window.webContents.getTitle() : '',
        isReady: !!entry.isReady
      });
    }.bind(this));
    return out;
  }

  // ============================================================
  // v1.10：获取某个平台窗口的最近诊断事件（白屏定位专用）。
  //   返回环形缓冲内的全部事件，按时间升序。
  //   调用方（Renderer / 测试脚本）可以直接 console.table 出来。
  // ============================================================
  getDiagnostics(platformId) {
    var id = String(platformId);
    var entry = this._windows[id];
    if (!entry) return { platformId: id, alive: false, events: [], summary: {} };
    var alive = this._isAlive(entry);
    var events = [];
    if (Array.isArray(entry.diag)) {
      var n = entry._diagCount || 0;
      var start = (entry._diagStart - n + entry._diagSize) % entry._diagSize;
      for (var i = 0; i < n; i++) {
        var idx = (start + i) % entry._diagSize;
        events.push(entry.diag[idx]);
      }
    }
    // summary：统计各级别事件数 + 当前 URL + 是否 finish load
    var summary = {
      total: events.length,
      info: events.filter(function (e) { return e.level === 'info'; }).length,
      warn: events.filter(function (e) { return e.level === 'warn'; }).length,
      error: events.filter(function (e) { return e.level === 'error'; }).length,
      lastError: (function () {
        for (var k = events.length - 1; k >= 0; k--) {
          if (events[k].level === 'error' || events[k].level === 'warn') return events[k];
        }
        return null;
      })(),
      url: alive && entry.window.webContents ? entry.window.webContents.getURL() : '',
      title: alive && entry.window.webContents ? entry.window.webContents.getTitle() : '',
      isReady: !!entry.isReady
    };
    return { platformId: id, alive: alive, events: events, summary: summary };
  }
}

module.exports = {
  BrowserManager: BrowserManager
};