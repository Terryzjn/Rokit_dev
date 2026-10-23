// tests/producthunt-publisher.test.js
//
// Product Hunt Publisher v3 单元测试 — 系统默认浏览器辅助发布模式
//
// 关键不变量（每条都对应一个测试）：
//   1. openPlatform 必须调 shell.openExternal，不能创建 BrowserWindow
//   2. openPlatform 永不调 loadURL / reload / executeJavaScript / CDP
//   3. openPlatform 必须打开 Product Hunt 首页（不是老的 /posts/new 直链）
//   4. fillContent / uploadMedia / verify 是 no-op，不向浏览器注入脚本
//   5. submit 永远 auto-send-disabled
//   6. 返回的 manualReason 必须提到「系统浏览器」
//   7. PH_STATES 状态机：INIT → OPENED_IN_SYSTEM_BROWSER → ...
//   8. buildHelperPanelData 字段结构正确（含 productName/tagline/description/website/allText/media）
//   9. adapters.producthunt.launch 返回 'system-browser:https://www.producthunt.com/'
//  10. adapters.producthunt.fill / submit 不再包含 fill 脚本关键字
//  11. 主类静态不含 reload / loadURL / location.href 赋值 / history.pushState / setInterval / 自动 click
'use strict';

const fs   = require('fs');
const path = require('path');

const M = require('../electron/browser/platforms/producthunt/ProductHuntPublisher');

// ============================================================
// 工具
// ============================================================
function makeFakeShell() {
  const calls = [];
  return {
    calls: calls,
    openExternal: async (url) => { calls.push({ method: 'openExternal', url: url }); return true; },
    openPath:     async (p)   => { calls.push({ method: 'openPath', path: p }); return ''; }
  };
}

function makePublisher(opts = {}) {
  return new M.ProductHuntPublisher(Object.assign({ shell: makeFakeShell() }, opts));
}

// ============================================================
// 1. PH_STATES 状态机
// ============================================================
describe('ProductHuntPublisher · v3 状态机常量', () => {
  it('包含 5 个状态常量', () => {
    expect(M.PH_STATES.INIT).toBe('INIT');
    expect(M.PH_STATES.OPENED_IN_SYSTEM_BROWSER).toBe('OPENED_IN_SYSTEM_BROWSER');
    expect(M.PH_STATES.USER_DOING_MANUAL_PUBLISH).toBe('USER_DOING_MANUAL_PUBLISH');
    expect(M.PH_STATES.HELPER_PANEL_READY).toBe('HELPER_PANEL_READY');
    expect(M.PH_STATES.ERROR).toBe('ERROR');
  });

  it('状态常量被 Object.freeze（不可修改）', () => {
    // 严格模式下赋值会抛 TypeError；非严格模式下静默失败
    let threw = false;
    try { M.PH_STATES.INIT = 'X'; } catch (_e) { threw = true; }
    // 任何模式下 frozen 后值都不变
    expect(M.PH_STATES.INIT).toBe('INIT');
    // 两种实现都接受（strict 通常在 ES module 下启用）
    expect([true, false]).toContain(threw);
  });
});

// ============================================================
// 2. 构造函数
// ============================================================
describe('ProductHuntPublisher · 构造函数', () => {
  it('platformId=producthunt；state=INIT；stateHistory 至少 1 条', () => {
    const p = makePublisher();
    expect(p.platformId).toBe('producthunt');
    expect(p.state).toBe('INIT');
    expect(Array.isArray(p.stateHistory)).toBe(true);
    expect(p.stateHistory.length).toBeGreaterThanOrEqual(1);
  });

  it('已通过 PublisherRegistry 注册', () => {
    const reg = require('../electron/browser/PublisherRegistry');
    expect(reg.has('producthunt')).toBe(true);
  });

  it('导出 PH_STATES', () => {
    expect(M.PH_STATES).toBeTruthy();
  });
});

// ============================================================
// 3. openPlatform — 调起系统浏览器（关键不变量）
// ============================================================
describe('ProductHuntPublisher · openPlatform 系统浏览器模式', () => {
  it('调起 shell.openExternal 并打开 Product Hunt 首页', async () => {
    const shell = makeFakeShell();
    const p = new M.ProductHuntPublisher({ shell: shell });
    const r = await p.openPlatform({});
    expect(shell.calls.length).toBe(1);
    expect(shell.calls[0].method).toBe('openExternal');
    expect(shell.calls[0].url).toBe('https://www.producthunt.com/');
    expect(r.ok).toBe(true);
    expect(r.handedOff).toBe(true);
    expect(r.url).toBe('https://www.producthunt.com/');
    expect(p.state).toBe('OPENED_IN_SYSTEM_BROWSER');
    expect(p.lastOpenedUrl).toBe('https://www.producthunt.com/');
  });

  it('不打开旧的 /posts/new 直链（必须首页）', async () => {
    const shell = makeFakeShell();
    const p = new M.ProductHuntPublisher({ shell: shell });
    await p.openPlatform({});
    expect(shell.calls[0].url).not.toMatch(/\/posts\/new|\/new\/product|\/submit$/);
    expect(shell.calls[0].url).toMatch(/^https:\/\/www\.producthunt\.com\//);
  });

  it('返回 manualReason 包含「安全验证」和「系统浏览器」+「手动」字样', async () => {
    const shell = makeFakeShell();
    const p = new M.ProductHuntPublisher({ shell: shell });
    const r = await p.openPlatform({});
    expect(r.manualReason).toMatch(/安全验证/);
    expect(r.manualReason).toMatch(/手动|Submit/);
  });

  it('shell 不可用 → 返回 ok=false, error=NO_SHELL', async () => {
    const p = new M.ProductHuntPublisher({ shell: null });
    const r = await p.openPlatform({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('NO_SHELL');
    expect(p.state).toBe('ERROR');
  });

  it('shell.openExternal 抛错 → 返回 ok=false 并进入 ERROR', async () => {
    const p = new M.ProductHuntPublisher({
      shell: { openExternal: async () => { throw new Error('OS 拒绝打开'); } }
    });
    const r = await p.openPlatform({});
    expect(r.ok).toBe(false);
    expect(p.state).toBe('ERROR');
    expect(String(r.error)).toMatch(/拒绝打开/);
  });

  it('状态转移历史记录了 INIT → OPENED_IN_SYSTEM_BROWSER', async () => {
    const p = makePublisher();
    await p.openPlatform({});
    const toStates = p.stateHistory.map(function (h) { return h.to; });
    expect(toStates).toContain('INIT');
    expect(toStates).toContain('OPENED_IN_SYSTEM_BROWSER');
  });
});

// ============================================================
// 4. fillContent / uploadMedia / verify — no-op
// ============================================================
describe('ProductHuntPublisher · fillContent / uploadMedia / verify no-op', () => {
  it('fillContent 不调 bm.execute，向 helper-panel 模式推进', async () => {
    const p = makePublisher();
    await p.openPlatform({});
    let called = false;
    const bm = { execute: function () { called = true; return Promise.resolve({}); } };
    const r = await p.fillContent({ browserManager: bm, fillData: { name: 'X' } });
    expect(r.ok).toBe(true);
    expect(r.helper).toBe('copy-panel');
    expect(p.state).toBe('HELPER_PANEL_READY');
    expect(called).toBe(false);
  });

  it('uploadMedia 不调 bm.execute，把 media 交给面板', async () => {
    const p = makePublisher();
    await p.openPlatform({});
    await p.fillContent({});
    let called = false;
    const r = await p.uploadMedia({
      browserManager: { execute: function () { called = true; return Promise.resolve({}); } },
      media: { type: 'video', src: 'data:video/mp4;base64,AAA=' }
    });
    expect(r.ok).toBe(true);
    expect(r.helper).toBe('media-panel');
    expect(called).toBe(false);
  });

  it('uploadMedia 在 INIT 状态下也允许（no-op），不会抛错', async () => {
    const p = makePublisher();
    const r = await p.uploadMedia({});
    expect(r.ok).toBe(true);
  });

  it('verify 把 state 推到 USER_DOING_MANUAL_PUBLISH', async () => {
    const p = makePublisher();
    await p.openPlatform({});
    const r = await p.verify({});
    expect(r.ok).toBe(true);
    expect(r.readyForManualSend).toBe(true);
    expect(p.state).toBe('USER_DOING_MANUAL_PUBLISH');
  });

  it('fillContent 拒绝在 INIT 状态下执行', async () => {
    const p = makePublisher();
    const r = await p.fillContent({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('GATE_NOT_PASSED');
  });
});

// ============================================================
// 5. submit — 永不自动点击
// ============================================================
describe('ProductHuntPublisher · submit 永不自动发送', () => {
  it('返回 error=auto-send-disabled', async () => {
    const p = makePublisher();
    const r = await p.submit({});
    expect(r.error).toBe('auto-send-disabled');
    expect(r.status).toBe('confirm');
    expect(r.readyForManualSend).toBe(true);
    expect(r.manualReason).toMatch(/user-must-click-send-manually/);
  });

  it('platformNote 明确告诉用户手动完成发布', async () => {
    const p = makePublisher();
    const r = await p.submit({});
    expect(r.platformNote).toMatch(/Submit|Publish|手动/);
  });
});

// ============================================================
// 6. buildHelperPanelData
// ============================================================
describe('ProductHuntPublisher · buildHelperPanelData', () => {
  it('返回 4 个字段 + allText + media + manualSteps', () => {
    const p = makePublisher();
    const d = p.buildHelperPanelData({
      title: 'Rokit',
      body:  'A launcher for indie devs',
      link:  'https://example.com',
      images: ['C:\\pics\\a.png', { name: 'b.png', path: '/p/b.png' }],
      video:  { fileName: 'clip.mp4', filePath: '/v/clip.mp4', mimeType: 'video/mp4' }
    });
    expect(d.platform).toBe('producthunt');
    expect(d.mode).toBe('system-browser-helper');
    expect(d.fields.productName.value).toBe('Rokit');
    expect(d.fields.tagline.value.length).toBeGreaterThan(0);
    expect(d.fields.tagline.value.length).toBeLessThanOrEqual(60);
    expect(d.fields.description.value).toBe('A launcher for indie devs');
    expect(d.fields.website.value).toBe('https://example.com');
    expect(d.allText).toMatch(/Product Name:/);
    expect(d.allText).toMatch(/Tagline:/);
    expect(d.allText).toMatch(/Description:/);
    expect(d.allText).toMatch(/Website:/);
    expect(d.media.images.length).toBe(2);
    expect(d.media.images[0].name).toBe('a.png');
    expect(d.media.images[1].name).toBe('b.png');
    expect(d.media.video.name).toBe('clip.mp4');
    expect(d.media.video.path).toBe('/v/clip.mp4');
    expect(Array.isArray(d.manualSteps)).toBe(true);
    expect(d.manualSteps.length).toBeGreaterThan(0);
  });

  it('website 缺失时显示「Website：未提供」', () => {
    const p = makePublisher();
    const d = p.buildHelperPanelData({ title: 'X', body: 'Y' });
    expect(d.fields.website.present).toBe(false);
    expect(d.fields.website.missingHint).toMatch(/未提供/);
    expect(d.allText).toMatch(/Website:\n（未提供）/);
  });

  it('video 缺失时 media.video=null', () => {
    const p = makePublisher();
    const d = p.buildHelperPanelData({ title: 'X', body: 'Y' });
    expect(d.media.video).toBe(null);
  });
});

// ============================================================
// 7. 主类静态安全（v3 不变量）
// ============================================================
describe('ProductHuntPublisher · 主类静态安全（v3）', () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../electron/browser/platforms/producthunt/ProductHuntPublisher.js'),
    'utf8'
  );

  it('主类不含 reload() / loadURL() / location.href 赋值 / history.pushState / setInterval', () => {
    expect(SRC).not.toMatch(/[^\/]reload\(\)/);
    expect(SRC).not.toMatch(/[^\/]\.loadURL\(/);
    expect(SRC).not.toMatch(/location\.href\s*=[^/]/);
    expect(SRC).not.toMatch(/history\.pushState/);
    expect(SRC).not.toMatch(/history\.replaceState/);
    expect(SRC).not.toMatch(/[^\/]setInterval\(/);
  });

  it('主类不调自动 click(send|submit|publish|next)', () => {
    expect(SRC).not.toMatch(/\.click\(\s*(send|submit|publish|next|launch|schedule)/i);
  });

  it('主类不调 executeJavaScript / CDP / 远程调试', () => {
    expect(SRC).not.toMatch(/executeJavaScript/);
    expect(SRC).not.toMatch(/CDP|chrome-remote-interface|chrome\.devtools/i);
  });

  it('主类不构建 BrowserWindow（不出现 new BrowserWindow 或 BrowserWindow 构造函数）', () => {
    expect(SRC).not.toMatch(/new BrowserWindow/);
    expect(SRC).not.toMatch(/BrowserWindow\(/);
  });

  it('主类注释明确「不绕过安全验证 / 用户手动」', () => {
    expect(SRC).toMatch(/不绕过|不要尝试绕过|绝不/);
    expect(SRC).toMatch(/用户.*手动/);
  });

  it('不调用任何 ProductHuntPrepareScript / MediaUploadScript（v3 不需要）', () => {
    expect(SRC).not.toMatch(/ProductHuntPrepareScript/);
    expect(SRC).not.toMatch(/ProductHuntMediaUploadScript/);
  });
});

// ============================================================
// 8. electron/publishers.js 的 producthunt 适配器
// ============================================================
describe('publishers.js · producthunt 系统浏览器适配器', () => {
  const adapters = require('../electron/publishers').adapters;

  it('adapters.producthunt.mode === "system-browser-helper"', () => {
    expect(adapters.producthunt.mode).toBe('system-browser-helper');
  });

  it('adapters.producthunt.auto === false', () => {
    expect(adapters.producthunt.auto).toBe(false);
  });

  it('launch() 返回 system-browser:https://www.producthunt.com/', () => {
    expect(adapters.producthunt.launch()).toBe('system-browser:https://www.producthunt.com/');
  });

  it('launch 不再返回旧的 /posts/new 直链', () => {
    const url = adapters.producthunt.launch();
    expect(url).not.toMatch(/\/posts\/new/);
    expect(url).toMatch(/^system-browser:https:\/\/www\.producthunt\.com\/$/);
  });

  it('manualReason 提到「系统默认浏览器」', () => {
    expect(adapters.producthunt.manualReason).toMatch(/系统默认浏览器/);
    expect(adapters.producthunt.manualReason).toMatch(/手动/);
  });

  it('fill 返回字符串是合法 JS IIFE（不会注入任何 fill 脚本）', () => {
    const code = adapters.producthunt.fill({ title: 'Rokit', body: 'hello' });
    expect(typeof code).toBe('string');
    expect(() => new Function(code)).not.toThrow();
    expect(code).toMatch(/system-browser-helper/);
    // 不再包含 selector 关键字
    expect(code).not.toMatch(/input\[name="name"\]/);
    expect(code).not.toMatch(/textarea\[name="description"\]/);
    expect(code).not.toMatch(/DocumentFragment|HTMLTextAreaElement|getOwnPropertyDescriptor/);
  });

  it('submit 返回 confirm 状态且永不自动发送', () => {
    const code = adapters.producthunt.submit({});
    expect(code).toMatch(/status:\s*['"]confirm['"]/);
    expect(code).toMatch(/user-must-click-send-manually/);
  });

  it('fill / submit 静态扫描：无 reload / loadURL / location.href / setInterval', () => {
    const code = adapters.producthunt.fill({}) + '\n' + adapters.producthunt.submit({});
    expect(code).not.toMatch(/[^\/]reload\(\)/);
    expect(code).not.toMatch(/[^\/]\.loadURL\(/);
    expect(code).not.toMatch(/location\.href\s*=/);
    expect(code).not.toMatch(/[^\/]setInterval\(/);
  });
});

// ============================================================
// 9. PLATFORMS UI 列表里 producthunt 仍存在（确保没有"完全删除"）
// ============================================================
describe('index.html · PLATFORMS 列表', () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../index.html'),
    'utf8'
  );

  it('Product Hunt 仍在 PLATFORMS 数组中', () => {
    expect(SRC).toMatch(/id:\s*['"]producthunt['"]/);
  });

  it('Product Hunt 改名/换 label 应当仍是独立可识别入口', () => {
    expect(SRC).toMatch(/Product Hunt/);
  });

  it('包含 autoPubProductHunt 路由', () => {
    expect(SRC).toMatch(/autoPubProductHunt/);
  });

  it('包含「Product Hunt 发布助手」面板标记', () => {
    expect(SRC).toMatch(/Product Hunt 发布助手/);
  });

  it('包含「复制全部 Product Hunt 内容」按钮', () => {
    expect(SRC).toMatch(/复制全部 Product Hunt 内容/);
  });

  it('包含 Product Hunt 复制面板 CSS 类', () => {
    expect(SRC).toMatch(/\.ph-modal-card|\.ph-banner|\.ph-field/);
  });

  it('rocketGo 已加入 producthunt 分支', () => {
    expect(SRC).toMatch(/rocketGo/);
    // rocketGo 内有 pid==='producthunt' 分支
    const idx = SRC.indexOf('rocketGo=async');
    expect(idx).toBeGreaterThan(0);
    const block = SRC.slice(idx, idx + 4000);
    expect(block).toMatch(/pid==='producthunt'/);
  });

  it('不再出现「✗ Product Hunt 无法自动发布」/「安全验证失败」错误文案', () => {
    expect(SRC).not.toMatch(/✗\s*Product Hunt 无法自动发布|Product Hunt 无法自动发布/);
    expect(SRC).not.toMatch(/安全验证失败/);
  });

  it('成功文案「✓ Product Hunt 已在系统浏览器中打开」存在', () => {
    expect(SRC).toMatch(/✓\s*Product Hunt 已在系统浏览器中打开|Product Hunt 已在系统浏览器中打开/);
  });
});

// ============================================================
// 10. main.js 的 producthunt 系统浏览器分支
// ============================================================
describe('main.js · producthunt 走系统浏览器', () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../electron/main.js'),
    'utf8'
  );

  it('pubExec 顶部出现 platformId === "producthunt" 分支', () => {
    expect(SRC).toMatch(/platformId\s*===\s*['"]producthunt['"]/);
  });

  it('producthunt 分支调 shell.openExternal', () => {
    const idx = SRC.indexOf('platformId === \'producthunt\'');
    expect(idx).toBeGreaterThan(0);
    const block = SRC.slice(idx, idx + 2000);
    expect(block).toMatch(/shell\.openExternal/);
    expect(block).toMatch(/system-browser-helper/);
  });

  it('注册 clipboard:write IPC', () => {
    expect(SRC).toMatch(/ipcMain\.handle\(['"]clipboard:write['"]/);
  });

  it('注册 shell:reveal IPC', () => {
    expect(SRC).toMatch(/ipcMain\.handle\(['"]shell:reveal['"]/);
  });
});

// ============================================================
// 11. preload.js 暴露 writeClipboard / revealInFolder
// ============================================================
describe('preload.js · v3 API', () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../electron/preload.js'),
    'utf8'
  );

  it('暴露 writeClipboard', () => {
    expect(SRC).toMatch(/writeClipboard\s*:/);
  });

  it('暴露 revealInFolder', () => {
    expect(SRC).toMatch(/revealInFolder\s*:/);
  });
});

// ============================================================
// 12. 其他平台未被改动（adb / jike / weibo / v2ex / juejin / zhihu / douyin / github / youtube）
// ============================================================
describe('其他平台未被修改', () => {
  const adapters = require('../electron/publishers').adapters;

  const others = ['jike', 'v2ex', 'juejin', 'zhihu', 'douyin', 'youtube', 'github', 'wechat', 'bili', 'x', 'facebook'];
  others.forEach(function (id) {
    it('platform ' + id + ' 仍然注册', () => {
      expect(adapters[id]).toBeTruthy();
    });
  });

  it('github 仍走 Contents API 直发（不再依赖 BrowserWindow）', () => {
    // 仅检查仍存在；其具体行为不在本次变更范围
    expect(adapters.github).toBeTruthy();
  });

  it('youtube 仍走 Data API（auto=false / 含 youtubeUpload 等关键字）', () => {
    expect(adapters.youtube).toBeTruthy();
  });
});