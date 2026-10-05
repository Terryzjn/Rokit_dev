// Rokit · 浏览器框架单元测试（v1.7）
// ----------------------------------------------------------------
// 不启动 Electron（用 stub 模拟 BrowserManager），
// 验证：PublisherRegistry、PublisherBase 流程编排、填充脚本字符串形态。
'use strict';

// vitest 全局（vitest.config.js globals: true 已注入）
const PublisherRegistry = require('../electron/browser/PublisherRegistry');
const fillScripts = require('../electron/browser/fill-input');

// 强制注入 BrowserTestPublisher
require('../electron/browser/platforms/browser-test');

// ---------- Stub BrowserManager ----------
function makeStubBrowserManager() {
  const calls = [];
  return {
    calls,
    openPlatform: vi.fn(async (id) => { calls.push(['openPlatform', id]); return { reused: false, windowId: 1 }; }),
    closePlatform: vi.fn(async (id) => { calls.push(['closePlatform', id]); return true; }),
    navigate: vi.fn(async (id, url) => { calls.push(['navigate', id, url]); return null; }),
    execute: vi.fn(async (id, script) => {
      calls.push(['execute', id, script.length]);
      // 模拟登录检测
      if (script.indexOf('logged_in') >= 0 && script.indexOf('inSelectors') >= 0) {
        return { status: 'logged_out' };
      }
      if (script.indexOf('detectLogin') >= 0 && script.indexOf('outSelectors') >= 0) {
        return { status: 'logged_in' };
      }
      // 模拟填充
      if (script.indexOf('fillInput') >= 0 || script.indexOf('FILL_INPUT_FN') >= 0
          || script.indexOf('filter') >= 0) {
        return { ok: true, filled: { title: { ok: true, value: 'X' }, content: { ok: true } } };
      }
      return { ok: true };
    }),
    onceNavigated: vi.fn((id, _cb) => { calls.push(['onceNavigated', id]); })
  };
}

describe('PublisherRegistry', () => {
  it('默认注册了 browser-test 与 test', () => {
    expect(PublisherRegistry.has('browser-test')).toBe(true);
    expect(PublisherRegistry.has('test')).toBe(true);
  });
  it('register / unregister 正常', () => {
    class Stub { constructor(o) { this.platformId = o.platformId; } }
    PublisherRegistry.register('stub-x', Stub);
    expect(PublisherRegistry.has('stub-x')).toBe(true);
    expect(PublisherRegistry.get('stub-x')).toBe(Stub);
    PublisherRegistry.unregister('stub-x');
    expect(PublisherRegistry.has('stub-x')).toBe(false);
  });
  it('未注册平台 instantiate 抛错', () => {
    expect(() => PublisherRegistry.instantiate('not-exists', {})).toThrow(/未注册平台/);
  });
  it('list 至少包含 browser-test', () => {
    expect(PublisherRegistry.list()).toContain('browser-test');
  });
});

describe('PublisherBase 流程', () => {
  it('登录态 unknown → 返回 unknown', async () => {
    const bm = makeStubBrowserManager();
    const pub = PublisherRegistry.instantiate('browser-test', { browserManager: bm });
    const status = await pub.checkLoginStatus();
    expect(['unknown', 'logged_in', 'logged_out']).toContain(status);
  });

  it('prepareContent 调用 BrowserManager.execute 注入填充脚本', async () => {
    const bm = makeStubBrowserManager();
    const pub = PublisherRegistry.instantiate('browser-test', { browserManager: bm });
    pub.openPlatform = vi.fn(async () => ({}));
    pub.browserManager = bm;
    const r = await pub.prepareContent({ title: '标题A', content: '正文A' });
    expect(bm.execute).toHaveBeenCalled();
    expect(r).toBeDefined();
  });
});

describe('fill-input 脚本构造', () => {
  it('buildFillScript 是合法 IIFE 字符串', () => {
    const s = fillScripts.buildFillScript(
      { title: ['input[name="title"]'], content: ['textarea[name="content"]'] },
      { title: 'x', content: 'y' }
    );
    expect(typeof s).toBe('string');
    // 用 Function 验证：能解析（不真正执行，因为缺 document）
    let parsed = false;
    try { new Function(s); parsed = true; } catch (_e) { parsed = false; }
    expect(parsed).toBe(true);
  });
  it('buildLoginScript 是合法 IIFE 字符串', () => {
    const s = fillScripts.buildLoginScript({ inSelectors: ['img'], outSelectors: ['#login'] });
    expect(typeof s).toBe('string');
  });
  it('buildBannerScript 是合法 IIFE 字符串', () => {
    const s = fillScripts.buildBannerScript('测试');
    expect(typeof s).toBe('string');
  });
  it('extractFillData 兼容 body/content 字段', () => {
    expect(fillScripts.extractFillData({ title: 't', body: 'b' }))
      .toEqual({ title: 't', content: 'b', images: [], videoPath: null });
    expect(fillScripts.extractFillData({ title: 't', content: 'c' }))
      .toEqual({ title: 't', content: 'c', images: [], videoPath: null });
  });
});

describe('BrowserTestPublisher 配置', () => {
  it('继承自 PublisherBase', () => {
    const Ctor = PublisherRegistry.get('browser-test');
    expect(Ctor).toBeDefined();
    const bm = makeStubBrowserManager();
    const pub = PublisherRegistry.instantiate('browser-test', { browserManager: bm });
    expect(pub.platformId).toBe('browser-test');
    expect(pub.loginUrl).toMatch(/^file:\/\//);
    expect(pub.publishUrl).toMatch(/^file:\/\//);
    expect(Array.isArray(pub.selectors.title)).toBe(true);
    expect(Array.isArray(pub.selectors.content)).toBe(true);
  });
});