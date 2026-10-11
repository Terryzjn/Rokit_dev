// Rokit · 平台发布适配器单元测试
// 验证所有 12 个平台注入脚本的语法合法性、launch URL 拼接、status 语义
// vitest 全局由 vitest.config.js globals:true 注入
const { adapters, inject } = require('../electron/publishers');

const ALL_PLATFORMS = [
  'github', 'producthunt', 'v2ex', 'juejin', 'x', 'facebook', 'youtube',
  'douyin', 'bili', 'jike', 'zhihu', 'wechat'
];

describe('publishers · 注册表完整性', () => {
  it('应当覆盖所有 12 个目标平台', () => {
    for (const id of ALL_PLATFORMS) {
      expect(adapters[id]).toBeDefined();
      expect(adapters[id].launch).toBeTypeOf('function');
      expect(adapters[id].fill).toBeTypeOf('function');
      expect(adapters[id].submit).toBeTypeOf('function');
    }
  });

  it('每个平台应声明 auto 标志', () => {
    for (const id of ALL_PLATFORMS) {
      expect(typeof adapters[id].auto).toBe('boolean');
    }
  });
});

describe('publishers · launch URL', () => {
  it('github：应能从 link 中提取 owner/repo 并跳到 releases/new', () => {
    const url = adapters.github.launch({ link: 'https://github.com/foo/bar' });
    expect(url).toBe('https://github.com/foo/bar/releases/new');
  });

  it('github：link 缺失时应返回 null（让 UI 提示用户补填）', () => {
    expect(adapters.github.launch({})).toBeNull();
    expect(adapters.github.launch({ link: 'not-a-url' })).toBeNull();
  });

  it('github：owner/repo 包含特殊字符时也应正确拼接', () => {
    const url = adapters.github.launch({ link: 'https://github.com/user-with-dots/repo.name' });
    expect(url).toBe('https://github.com/user-with-dots/repo.name/releases/new');
  });

  it('github：自动去掉 .git 后缀', () => {
    const url = adapters.github.launch({ link: 'https://github.com/foo/bar.git' });
    expect(url).toBe('https://github.com/foo/bar/releases/new');
  });

  it('静态 URL 平台：launch 应返回正确的发布页', () => {
    expect(adapters.producthunt.launch()).toMatch(/^system-browser:https:\/\/www\.producthunt\.com\/$/);
    expect(adapters.v2ex.launch()).toMatch(/^https:\/\/www\.v2ex\.com\/new$/);
    expect(adapters.juejin.launch()).toMatch(/^https:\/\/juejin\.cn\/editor\/drafts\/new$/);
    expect(adapters.x.launch()).toMatch(/^https:\/\/x\.com\/compose\/post$/);
  });

  it('github：link 含 query / fragment 也应能抽出 owner/repo', () => {
    expect(adapters.github.launch({ link: 'https://github.com/foo/bar?tab=readme' }))
      .toBe('https://github.com/foo/bar/releases/new');
    expect(adapters.github.launch({ link: 'https://github.com/foo/bar#readme' }))
      .toBe('https://github.com/foo/bar/releases/new');
  });

  it('github：link 为 http 协议也应能抽取（适配老仓库页面）', () => {
    expect(adapters.github.launch({ link: 'http://github.com/foo/bar' }))
      .toBe('https://github.com/foo/bar/releases/new');
  });

  it('github：带 www 子域也兼容', () => {
    expect(adapters.github.launch({ link: 'https://www.github.com/foo/bar' }))
      .toBe('https://github.com/foo/bar/releases/new');
  });

  it('github：不是 github 域名时应返回 null', () => {
    expect(adapters.github.launch({ link: 'https://gitlab.com/foo/bar' })).toBeNull();
    expect(adapters.github.launch({ link: 'https://example.com/foo/bar' })).toBeNull();
  });

  it('其余静态平台也应返回稳定 URL（smoke test）', () => {
    expect(adapters.facebook.launch()).toBe('https://www.facebook.com/');
    expect(adapters.youtube.launch()).toBe('https://studio.youtube.com/');
    expect(adapters.douyin.launch()).toMatch(/^https:\/\/creator\.douyin\.com\//);
    expect(adapters.bili.launch()).toMatch(/^https:\/\/member\.bilibili\.com\//);
    expect(adapters.jike.launch()).toMatch(/^https:\/\/web\.okjike\.com\//);
    expect(adapters.zhihu.launch()).toMatch(/^https:\/\/zhuanlan\.zhihu\.com\//);
    expect(adapters.wechat.launch()).toBe('https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&isNew=1&lang=zh_CN');
  });
});

describe('publishers · 注入脚本语法', () => {
  it.each(ALL_PLATFORMS)('%s fill / submit 必须是合法 JS（new Function 不报错）', (id) => {
    const fillCode = adapters[id].fill({ title: 't', body: 'b', link: 'https://x.com' });
    const submitCode = adapters[id].submit({ title: 't', body: 'b', link: 'https://x.com' });
    expect(() => new Function(fillCode)).not.toThrow();
    expect(() => new Function(submitCode)).not.toThrow();
  });

  it('inject 工具：应正确序列化 payload（含中文/引号/换行）', () => {
    const code = inject(
      'function(p){return {title:p.t,body:p.b};}',
      { t: '标题"含引号"', b: '正文\n多行\n带"引号"' }
    );
    // 关键：执行后能直接拿到反序列化数据（inject 返回的 code 是立即调用的 IIFE）
    const result = new Function('return (' + code + ')')();
    expect(result.title).toBe('标题"含引号"');
    expect(result.body).toBe('正文\n多行\n带"引号"');
  });
});

describe('publishers · 自动 vs 半自动（v0.1.1 修正）', () => {
  // 与 electron/publishers.js 保持一致：auto 反映「点一键后是否需要人工最终确认」
  // v0.1.1 修正：ph / juejin / facebook / youtube 实际在发布前需要人工选分类/受众/上传文件，改 auto:false
  it('auto:true 的真一键平台：github / v2ex / x', () => {
    expect(adapters.github.auto).toBe(true);
    expect(adapters.v2ex.auto).toBe(true);
    expect(adapters.x.auto).toBe(true);
  });

  it('auto:false 需手动点下一步/Submit 的平台：producthunt / juejin / facebook / youtube', () => {
    expect(adapters.producthunt.auto).toBe(false);
    expect(adapters.juejin.auto).toBe(false);
    expect(adapters.facebook.auto).toBe(false);
    expect(adapters.youtube.auto).toBe(false);
    // 这 4 个必须有 manualReason 给 UI 展示
    expect(typeof adapters.producthunt.manualReason).toBe('string');
    expect(typeof adapters.juejin.manualReason).toBe('string');
    expect(typeof adapters.facebook.manualReason).toBe('string');
    expect(typeof adapters.youtube.manualReason).toBe('string');
  });

  it('auto:false 的国内平台：douyin / bili / jike / zhihu / wechat', () => {
    expect(adapters.douyin.auto).toBe(false);
    expect(adapters.bili.auto).toBe(false);
    expect(adapters.jike.auto).toBe(false);
    expect(adapters.zhihu.auto).toBe(false);
    expect(adapters.wechat.auto).toBe(false);
  });
});

describe('publishers · YouTube（特殊）', () => {
  it('应返回 need_file 状态（视频需要本地文件）', () => {
    // fill 直接返回对象而不是注入脚本
    const code = adapters.youtube.fill({ title: 't', body: 'b' });
    expect(code).toMatch(/need_file/);
  });
});

describe('publishers · inject 工具 · 边界 payload', () => {
  it('payload 为 undefined / null 应序列化为空对象 {}', () => {
    const code1 = inject('function(p){return p;}', undefined);
    const code2 = inject('function(p){return p;}', null);
    // 立即调用后的返回值应为空对象
    expect(new Function('return (' + code1 + ')')()).toEqual({});
    expect(new Function('return (' + code2 + ')')()).toEqual({});
  });

  it('payload 为基本类型时应正确序列化', () => {
    const code = inject('function(p){return p;}', { s: 'hi', n: 42, b: true, x: null });
    expect(new Function('return (' + code + ')')()).toEqual({ s: 'hi', n: 42, b: true, x: null });
  });

  it('payload 含嵌套对象与数组应完整往返', () => {
    const payload = {
      title: 'outer',
      meta: { tags: ['a', 'b', 'c'], settings: { auto: true, n: 0 } },
      list: [1, 'two', null, false]
    };
    const code = inject('function(p){return p;}', payload);
    expect(new Function('return (' + code + ')')()).toEqual(payload);
  });

  it('payload 含 unicode 与 emoji 应完整往返', () => {
    const payload = { title: '你好 Rokit 🚀', body: '🎉 测试' };
    const code = inject('function(p){return p;}', payload);
    const out = new Function('return (' + code + ')')();
    expect(out.title).toBe('你好 Rokit 🚀');
    expect(out.body).toBe('🎉 测试');
  });

  it('payload 含控制字符与反斜杠应安全序列化（不破坏 JS 语法）', () => {
    const payload = { body: 'line1\nline2\ttab\\back', s: '"quoted""' };
    const code = inject('function(p){return p;}', payload);
    // 能在页面里 new Function 也能跑
    const out = new Function('return (' + code + ')')();
    expect(out.body).toBe('line1\nline2\ttab\\back');
    expect(out.s).toBe('"quoted""');
  });

  it('payload 含 HTML 标签 / </script> 应原样序列化（浏览器 XSS 防护由 CSP 负责）', () => {
    const payload = { body: '<script>alert(1)</script><img onerror=x>' };
    const code = inject('function(p){return p;}', payload);
    const out = new Function('return (' + code + ')')();
    expect(out.body).toBe('<script>alert(1)</script><img onerror=x>');
    // 额外验证：序列化产物应能被 new Function 执行，不报语法错
    expect(() => new Function(code)).not.toThrow();
  });

  it('payload 为空对象 / 空数组应正常', () => {
    expect(new Function('return (' + inject('function(p){return p;}', {}) + ')')()).toEqual({});
    expect(new Function('return (' + inject('function(p){return p;}', []) + ')')()).toEqual([]);
  });

  it('payload 含 NaN / Infinity 应被 JSON.stringify 转为 null（标准行为，文档化）', () => {
    const code = inject('function(p){return p;}', { a: NaN, b: Infinity });
    const out = new Function('return (' + code + ')')();
    expect(out.a).toBeNull();
    expect(out.b).toBeNull();
  });

  it('函数体不含 payload 引用也应能合法执行', () => {
    const code = inject('function(){return 42;}', { ignored: true });
    expect(new Function('return (' + code + ')')()).toBe(42);
  });
});

// =====================================================================
// 即刻 v1.14：填正文 + 附加视频（DataTransfer + File + change）
// 设计点：
//   - 字段名：项目实际是 payload.body / videoDataUrl；不是 content/video
//   - 节流不再 abort：脚本里**不应**再直接 return {status:'throttled'}
//   - 真实输入事件：textarea 走原生 setter；contenteditable 走 Range+execCommand
//   - file input 探查 + 日志：count + #i { accept, multiple, visible, disabled }
//   - 永不自动点发送：submit 始终返回 confirm
// =====================================================================
describe('publishers · 即刻 v1.14 填正文 + 附加视频', () => {
  it('auto=false 且有 manualReason', () => {
    expect(adapters.jike.auto).toBe(false);
    expect(typeof adapters.jike.manualReason).toBe('string');
  });

  it('launch 仍指向 https://web.okjike.com/following', () => {
    expect(adapters.jike.launch()).toBe('https://web.okjike.com/following');
  });

  it('fill 是合法 IIFE（new Function 不报错）', () => {
    const code = adapters.jike.fill({
      body: '你好 Rokit', link: 'https://x.com', tags: []
    });
    expect(() => new Function(code)).not.toThrow();
  });

  it('fill 是合法 IIFE（含视频 payload 也不报错）', () => {
    const code = adapters.jike.fill({
      body: '你好 Rokit',
      videoDataUrl: 'data:video/mp4;base64,AAAA',
      videoName: 'clip.mp4',
      videoMime: 'video/mp4'
    });
    expect(() => new Function(code)).not.toThrow();
  });

  it('fill 读 p.body 而不是 p.content（用项目实际字段）', () => {
    const code = adapters.jike.fill({ body: '你好 Rokit' });
    // 脚本里出现 targetBody / p.body 字符串
    expect(code).toMatch(/targetBody|"body"|"targetBody"/);
    // 不应再读 p.content（旧 adapter 的错误字段）
    expect(code).not.toMatch(/p\.content\b|p2\.content\b/);
  });

  it('fill 不再因为"操作过于频繁"直接 abort', () => {
    const code = adapters.jike.fill({ body: 'x' });
    // 旧 abort 路径应被清除：
    expect(code).not.toMatch(/status:\s*['"]throttled['"]/);
    // 节流关键字仍在（仅作环境日志）
    expect(code).toMatch(/操作过于频繁/);
    expect(code).toMatch(/detectThrottle/);
    // 但脚本里**不应**有：throttled 命中即 return
    expect(code).not.toMatch(/if\s*\(.*throttled.*\)\{[^}]*return\s*\{[^}]*throttled/);
  });

  it('fill 用真实输入事件：textarea 走原生 setter，contenteditable 走 Range+execCommand', () => {
    const code = adapters.jike.fill({ body: 'x' });
    // 原生 setter（不是 el.value= 直接赋值）
    expect(code).toMatch(/HTMLTextAreaElement\.prototype/);
    expect(code).toMatch(/getOwnPropertyDescriptor/);
    expect(code).toMatch(/setter\.call/);
    // InputEvent 派发
    expect(code).toMatch(/InputEvent\(\s*["']input["']/);
    expect(code).toMatch(/new Event\(\s*["']change["']/);
    // Range + execCommand（contenteditable）
    expect(code).toMatch(/selectNodeContents/);
    expect(code).toMatch(/execCommand\(\s*["']insertText["']/);
  });

  it('fill 包含 4 阶段日志：composer search start / composer found / length before / fill success', () => {
    const code = adapters.jike.fill({ body: 'x' });
    expect(code).toMatch(/composer search start/);
    expect(code).toMatch(/composer found/);
    expect(code).toMatch(/content length before/);
    expect(code).toMatch(/content fill success|content fill FAILED/);
    // 按用户规范：必须打印 target / actual content length
    expect(code).toMatch(/target content length: /);
    expect(code).toMatch(/actual content length: /);
  });

  it('fill 必须校验：actual length === 0 → 不继续', () => {
    const code = adapters.jike.fill({ body: 'x' });
    expect(code).toMatch(/actual-content-empty/);
    expect(code).toMatch(/preview-not-found/);
  });

  it('fill 含 file input 探查 + 日志（按用户规范）', () => {
    const code = adapters.jike.fill({ body: 'x' });
    expect(code).toMatch(/probeFileInputs/);
    expect(code).toMatch(/file input count:/);
    expect(code).toMatch(/file input #/);
    expect(code).toMatch(/accept:/);
    expect(code).toMatch(/multiple:/);
    expect(code).toMatch(/visible:/);
    expect(code).toMatch(/disabled:/);
  });

  it('fill 用 DataTransfer + File + change event 上传视频（不假伪造）', () => {
    const code = adapters.jike.fill({
      body: 'x',
      videoDataUrl: 'data:video/mp4;base64,AAAA',
      videoName: 'clip.mp4',
      videoMime: 'video/mp4'
    });
    expect(code).toMatch(/DataTransfer/);
    expect(code).toMatch(/new File/);
    expect(code).toMatch(/\.files\s*=/);
    expect(code).toMatch(/new Event\(\s*["']change["']/);
    expect(code).toMatch(/new Event\(\s*["']input["']/);
    // fetch data URL
    expect(code).toMatch(/fetch\(\s*video\.dataUrl|fetch\(\s*p2\.video\.dataUrl|fetch\(\s*video\.dataUrl/);
  });

  it('fill 没有视频字段时不应调用 DataTransfer / File 上传（健壮性）', () => {
    const code = adapters.jike.fill({ body: 'x' });
    // adapter 里：videoPayload 缺省是 null（不出现在 IIFE 里，但确保不在 IIFE 中实例化 File/DataTransfer）
    // IIFE 里：video 条件取 p2.video，不存在则跳过 upload
    expect(code).toMatch(/if\s*\(\s*video\s*&&\s*video\.dataUrl\s*\)/);
    // 没有 video 时 payloadJson 里 video:null
    expect(code).toMatch(/"video":null/);
  });

  it('fill 不引入 setInterval / location 写入 / history / reload / 自动点 send', () => {
    const code = adapters.jike.fill({ body: 'x' });
    expect(code).not.toMatch(/setInterval/);
    expect(code).not.toMatch(/location\.href\s*=/);
    expect(code).not.toMatch(/location\.replace/);
    expect(code).not.toMatch(/history\.pushState/);
    expect(code).not.toMatch(/history\.replaceState/);
    expect(code).not.toMatch(/\.reload\(/);
    expect(code).not.toMatch(/\.click\(\s*[^)]*send/i);
    expect(code).not.toMatch(/\.click\(\s*[^)]*提交/i);
  });

  it('submit 永远返回 confirm，不自动点发送', () => {
    const code = adapters.jike.submit({});
    expect(() => new Function(code)).not.toThrow();
    expect(code).toMatch(/status:\s*['"]confirm['"]/);
    expect(code).toMatch(/不自动点发送/);
  });
});

// =====================================================================
// 即刻 v1.14 · 端到端 vm 沙箱功能测试
// =====================================================================
describe('publishers · 即刻 v1.14 · vm 沙箱功能测试', () => {
  // 构造一个轻量 DOM 沙箱，让 fill IIFE 能跑通核心逻辑
  function makeSandbox() {
    const calls = [];
    const listeners = {};
    const elements = [];

    function makeEl(tag, attrs) {
      attrs = attrs || {};
      const el = {
        tagName: tag.toUpperCase(),
        children: [],
        attributes: {},
        _text: '',
        getAttribute: function (n) { return this.attributes[n] != null ? this.attributes[n] : null; },
        setAttribute: function (n, v) { this.attributes[n] = String(v); },
        focus: function () { this._focused = true; },
        click: function () {},
        dispatchEvent: function (ev) {
          calls.push('dispatch:' + ev.type + ':' + tag + ':' + (this.attributes['data-id'] || ''));
          (listeners[ev.type] || []).forEach(function (l) { try { l(ev); } catch (_e) {} });
        },
        addEventListener: function (t, l) {
          (listeners[t] || (listeners[t] = [])).push(l);
        },
        getBoundingClientRect: function () { return this.attributes._hidden ? { width: 0, height: 0 } : { width: 600, height: 120 }; },
        // contenteditable 用 textContent 作为输入
        get textContent() { return this._text; },
        set textContent(v) { this._text = String(v); },
        get innerText() { return this._text; },
        get value() { return this._text; },
        set value(v) {
          this._text = String(v);
          // 模拟原生 setter 调用
          if (attrs._inputOnSet && typeof this._onInput === 'function') this._onInput();
        }
      };
      Object.entries(attrs).forEach(function (kv) { el.attributes[kv[0]] = kv[1]; });
      if (attrs._id) elements[attrs._id] = el;
      elements.push(el);
      return el;
    }

    function docQueryAll(sel) {
      // 极简解析 [contenteditable="true"] 这种 selector
      var m = sel.match(/^\[(\w[\w-]*)=\"([^\"]*)\"\](\[[\w-]+(?:=\"[^\"]*\")?\])*$/);
      if (m) {
        return elements.filter(function (el) {
          // 全部属性必须命中
          var parts = sel.split('][');
          for (var i = 0; i < parts.length; i++) {
            var p = parts[i].replace(/\[|\]|"/g, '');
            var eq = p.indexOf('=');
            var k = eq >= 0 ? p.slice(0, eq) : p;
            var v = eq >= 0 ? p.slice(eq + 1) : null;
            if (v === null) {
              if (el.attributes[k] === undefined) return false;
            } else {
              var attrVal = el.attributes[k];
              if (attrVal === undefined) return false;
              // 占位符包含
              if (v.indexOf('*') >= 0) {
                var prefix = v.replace(/\*.*/, '');
                if (attrVal.indexOf(prefix) !== 0) return false;
              } else if (String(attrVal).indexOf(v) < 0) return false;
            }
          }
          return true;
        });
      }
      return [];
    }

    const sandbox = {
      console: { log: function (m, x) { calls.push('log:' + m + (x ? ':' + JSON.stringify(x).slice(0, 80) : '')); } },
      setTimeout: function (fn) { fn(); return 0; },
      Promise: Promise,
      Blob: function (parts) { this.size = parts.join('').length; this.type = 'video/mp4'; },
      File: function (parts, name, opts) { this.size = parts[0].size; this.type = opts && opts.type; this.name = name; },
      DataTransfer: function () {
        this._files = [];
        this.items = { add: function (f) { this._files.push(f); }.bind(this) };
        Object.defineProperty(this, 'files', { get: function () { return this._files; } });
      },
      Event: function (t) { this.type = t; },
      InputEvent: function (t, init) { this.type = t; Object.assign(this, init || {}); },
      Object: Object,
      Math: Math,
      Array: Array,
      JSON: JSON,
      RegExp: RegExp,
      String: String,
      Number: Number,
      Boolean: Boolean,
      Error: Error,
      Promise: Promise,
      Date: Date,
      Uint8Array: Uint8Array,
      Symbol: Symbol,
      _calls: calls,
      _listeners: listeners,
      _docQueryAll: docQueryAll,
      _docQuery: function (sel) { var r = docQueryAll(sel); return r[0] || null; },
      _makeEl: makeEl,
      document: {
        createRange: function () { return { selectNodeContents: function () {} }; },
        createElement: function (tag) { return makeEl(tag); },
        execCommand: function () { return true; },
        querySelectorAll: docQueryAll,
        querySelector: function (sel) { var r = docQueryAll(sel); return r[0] || null; },
        title: '',
        body: { innerText: '' }
      },
      window: {
        getSelection: function () { return { removeAllRanges: function () {}, addRange: function () {} }; },
        getComputedStyle: function () { return { visibility: 'visible', display: 'block' }; },
        addEventListener: function () {}
      },
      fetch: function (url) { return Promise.resolve({ ok: true, blob: function () { return Promise.resolve(new (sandbox.Blob)(['x'])); } }); },
      atob: function (b64) { return Buffer.from(b64, 'base64').toString('binary'); }
    };
    sandbox.HTMLTextAreaElement = { prototype: { get value() { return ''; }, set value(v) { /* trigger input on setter */ } } };
    sandbox.HTMLInputElement = { prototype: { get value() { return ''; }, set value(v) { /* trigger input */ } } };

    return sandbox;
  }

  it('fill IIFE 在 contenteditable 沙箱里能跑通并返回 ok=true', async () => {
    const vm = require('vm');
    const code = adapters.jike.fill({ body: '你好 Rokit' });
    const sandbox = makeSandbox();
    const composer = sandbox._makeEl('div', { contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', _id: 'composer' });
    // 让 execCommand('insertText', false, text) 真正更新 _text
    sandbox.document.execCommand = function (cmd, _ui, text) {
      if (cmd === 'insertText') { composer._text = String(text || ''); return true; }
      return false;
    };
    vm.createContext(sandbox);
    const m = code.match(/^\(async function\(p\)\{([\s\S]*)\)\s*\(\s*(\{[\s\S]*\})\s*\)\s*$/);
    if (!m) {
      const fn = vm.runInContext(code, sandbox);
      const r = await fn;
      expect(r.ok).toBe(true);
      expect(r.fillMethod).toMatch(/execCommand/);
      return;
    }
    const fnBody = m[1];
    const argJson = m[2];
    const fn = vm.runInContext('(async function(){\n  var p = ' + argJson + ';\n  ' + fnBody + '\n  return result;\n})', sandbox);
    const r = await fn;
    expect(r.ok).toBe(true);
    expect(r.fillMethod).toMatch(/execCommand/);
    expect(r.contentAfterLen).toBeGreaterThan(0);
  }, 15000);
});
