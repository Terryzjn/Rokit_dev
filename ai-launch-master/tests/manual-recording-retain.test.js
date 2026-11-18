// Rokit · 手动录屏「临时保存 → 主动保留」生命周期测试
//
// 覆盖需求点（全部使用**真实生产代码** —— vm 加载完整的 electron/ai-demo.js，
// 只替换 require('electron') 的 app 与 require('./video-source') 的内部存储）：
//   1. 停止录屏后主文件和 sidecar 均进入 temp/videos/recorder/
//   2. 默认保存不会在 videos/ 创建录屏文件
//   3. 未保留时，原 assetId 仍能通过 _internalStore 正常读取临时文件
//   4. 主动保留后，主文件和 sidecar 均进入 videos/
//   5. 保留后 assetId 不变，_internalStore 指向新路径
//   6. 保留后 sidecar 的 filePath 指向新路径
//   7. 同名文件自动编号，不覆盖已有文件
//   8. 重复点击保留不会重复移动或生成副本
//   9. 移动失败 / sidecar 更新失败时不留下半完成状态
//   10. 未保留和已保留两种状态下，现有资产读取接口均可正常读取
//   11. Renderer 侧：保留不是继续流程的前置条件

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const AD_PATH = path.join(ROOT, 'electron', 'ai-demo.js');
const AD_SRC = fs.readFileSync(AD_PATH, 'utf8').replace(/\r\n/g, '\n');

let ud = '';           // userData
let tmpRoot = '';      // 存放 ai-demo 的 fallback 目录（避免污染仓库）
let store = new Map(); // 模拟 video-source 的 _internalStore

// 用 vm 加载真实生产模块，替换 electron / logger / video-source / video
function loadAiDemo() {
  const fakeApp = { getPath: (k) => (k === 'userData' ? ud : ud) };
  const fakeLogger = { info() {}, warn() {}, error() {} };
  const fakeVideoSource = {
    getInternalAsset: (id) => store.get(id) || null,
    stashInternalAsset: (a) => { store.set(a.id, a); }
  };
  const fakeRequire = function (id) {
    if (id === 'electron') return { app: fakeApp };
    if (id === './logger') return fakeLogger;
    if (id === './video-source') return fakeVideoSource;
    if (id === './video') return { transcodeWebmToMp4: async () => ({ ok: false }) };
    return require(id);
  };
  const sandbox = {
    require: fakeRequire, module: { exports: {} }, exports: {}, console,
    Buffer, setTimeout, clearTimeout,
    __dirname: path.join(tmpRoot, 'electron'),
    __filename: AD_PATH
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(AD_SRC, sandbox, { filename: AD_PATH });
  // 让模块内的 _app 指向 fakeApp（attachIpc 会设置，这里直接注入）
  sandbox.module.exports.__setAppForTest = null;
  return sandbox.module.exports;
}

// attachIpc 会把 app 存进模块级 _app；这里通过调用 attachIpc 触发
function makeAiDemo() {
  const mod = loadAiDemo();
  const handlers = {};
  mod.attachIpc({ handle: (ch, fn) => { handlers[ch] = fn; } }, { app: { getPath: (k) => ud } });
  return { mod, handlers };
}

function b64(bytes) {
  return Buffer.alloc(bytes, 3).toString('base64');
}

describe('手动录屏 · 临时保存与主动保留', function () {

  let ai;
  let handlers;

  beforeEach(function () {
    ud = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-ret-ud-'));
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-ret-etc-'));
    store = new Map();
    ai = makeAiDemo();
    handlers = ai.handlers;
  });

  afterEach(function () {
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_e) {}
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
  });

  it('1. 停止录屏后：主文件与 sidecar 均进入 temp/videos/recorder/', async function () {
    const r = await handlers['demo:save-recording']({}, {
      ext: 'webm', blobBase64: b64(2048),
      sourceType: 'MANUAL_RECORDING', recorder: 'manual-recorder v1'
    });
    expect(r.ok).toBe(true);
    const asset = r.asset;
    const tempDir = path.join(ud, 'temp', 'videos', 'recorder');
    expect(path.dirname(asset.filePath)).toBe(tempDir);
    expect(fs.existsSync(asset.filePath)).toBe(true);
    expect(path.dirname(asset.metaPath)).toBe(tempDir);
    expect(fs.existsSync(asset.metaPath)).toBe(true);
  });

  it('2. 默认保存不会在 videos/ 创建录屏文件', async function () {
    const r = await handlers['demo:save-recording']({}, { ext: 'webm', blobBase64: b64(1024) });
    expect(r.ok).toBe(true);
    const keepDir = path.join(ud, 'videos');
    const files = fs.existsSync(keepDir) ? fs.readdirSync(keepDir) : [];
    expect(files.length).toBe(0);
  });

  it('3. 未保留时：原 assetId 仍能通过 _internalStore 读到临时文件', async function () {
    const r = await handlers['demo:save-recording']({}, { ext: 'webm', blobBase64: b64(3072) });
    const id = r.asset.id;
    const internal = store.get(id);
    expect(internal).toBeTruthy();
    expect(internal.filePath).toBe(r.asset.filePath);
    expect(fs.existsSync(internal.filePath)).toBe(true);
  });

  it('4. 主动保留后：主文件与 sidecar 均进入 videos/', async function () {
    const r = await handlers['demo:save-recording']({}, { ext: 'webm', blobBase64: b64(4096) });
    const id = r.asset.id;
    const keepDir = path.join(ud, 'videos');

    const k = await handlers['demo:retain-recording']({}, { assetId: id });
    expect(k.ok).toBe(true);
    expect(path.dirname(k.asset.filePath)).toBe(keepDir);
    expect(fs.existsSync(k.asset.filePath)).toBe(true);
    expect(path.dirname(k.asset.metaPath)).toBe(keepDir);
    expect(fs.existsSync(k.asset.metaPath)).toBe(true);
    // 临时目录里不再有该文件
    const tempDir = path.join(ud, 'temp', 'videos', 'recorder');
    expect(fs.existsSync(path.join(tempDir, path.basename(r.asset.filePath)))).toBe(false);
  });

  it('5. 保留后 assetId 不变，_internalStore 指向新路径', async function () {
    const r = await handlers['demo:save-recording']({}, { ext: 'webm', blobBase64: b64(4096) });
    const id = r.asset.id;
    const k = await handlers['demo:retain-recording']({}, { assetId: id });
    expect(k.asset.id).toBe(id);
    expect(store.get(id).filePath).toBe(k.asset.filePath);
    expect(store.get(id).filePath).not.toBe(r.asset.filePath);
    expect(fs.existsSync(store.get(id).filePath)).toBe(true);
  });

  it('6. 保留后 sidecar 的 filePath 指向新路径', async function () {
    const r = await handlers['demo:save-recording']({}, { ext: 'webm', blobBase64: b64(4096) });
    const k = await handlers['demo:retain-recording']({}, { assetId: r.asset.id });
    const meta = JSON.parse(fs.readFileSync(k.asset.metaPath, 'utf8'));
    expect(meta.filePath).toBe(k.asset.filePath);
    expect(fs.existsSync(meta.filePath)).toBe(true);
  });

  it('7. 同名文件自动编号，不覆盖已有文件', async function () {
    // 预置一个同名文件
    const keepDir = path.join(ud, 'videos');
    fs.mkdirSync(keepDir, { recursive: true });
    const id = 'aabbccddeeff0011';
    const occupied = path.join(keepDir, id + '.webm');
    fs.writeFileSync(occupied, Buffer.alloc(100, 1));

    const r = await handlers['demo:save-recording']({}, { ext: 'webm', blobBase64: b64(2048), id: id });
    expect(r.ok).toBe(true);
    const k = await handlers['demo:retain-recording']({}, { assetId: id });
    expect(k.ok).toBe(true);
    // 没有覆盖已有文件
    expect(fs.statSync(occupied).size).toBe(100);
    // 新文件带编号
    expect(path.basename(k.asset.filePath)).toBe(id + '-1.webm');
    expect(fs.existsSync(k.asset.filePath)).toBe(true);
  });

  it('8. 重复点击保留：不会重复移动或生成副本', async function () {
    const r = await handlers['demo:save-recording']({}, { ext: 'webm', blobBase64: b64(2048) });
    const id = r.asset.id;
    const k1 = await handlers['demo:retain-recording']({}, { assetId: id });
    const k2 = await handlers['demo:retain-recording']({}, { assetId: id });
    expect(k1.ok).toBe(true);
    expect(k2.ok).toBe(true);
    // 第二次是幂等：路径不变，不产生 -1 副本
    expect(k2.asset.filePath).toBe(k1.asset.filePath);
    const keepDir = path.join(ud, 'videos');
    const files = fs.readdirSync(keepDir).filter(f => !f.endsWith('.meta.json'));
    expect(files.length).toBe(1);
  });

  it('9. 移动失败：不留下半完成状态，asset 仍在临时目录', async function () {
    const r = await handlers['demo:save-recording']({}, { ext: 'webm', blobBase64: b64(2048) });
    const id = r.asset.id;
    // 让 videos/ 无法创建（用文件占位）
    const keepDir = path.join(ud, 'videos');
    fs.mkdirSync(path.dirname(keepDir), { recursive: true });
    fs.writeFileSync(keepDir, 'blocker');

    const k = await handlers['demo:retain-recording']({}, { assetId: id });
    expect(k.ok).toBe(false);
    // 主文件仍在临时目录，未被移动
    expect(fs.existsSync(r.asset.filePath)).toBe(true);
    expect(store.get(id).filePath).toBe(r.asset.filePath);
  });

  it('9b. sidecar 更新失败：主文件与 sidecar 一起回滚（不分处两个目录）', async function () {
    const r = await handlers['demo:save-recording']({}, { ext: 'webm', blobBase64: b64(2048) });
    const id = r.asset.id;
    const src = r.asset.filePath;
    const srcMeta = r.asset.metaPath;
    // 把 sidecar 改成非法 JSON → 保留流程更新 sidecar 时会失败 → 必须回滚
    fs.writeFileSync(srcMeta, '{ broken json');

    const k = await handlers['demo:retain-recording']({}, { assetId: id });
    expect(k.ok).toBe(false);
    expect(k.error).toBe('sidecar-update-failed');
    // 主文件回到临时目录
    expect(fs.existsSync(src)).toBe(true);
    // sidecar 也在临时目录（未留在 videos/）
    const keepDir = path.join(ud, 'videos');
    const leftovers = fs.existsSync(keepDir) ? fs.readdirSync(keepDir) : [];
    expect(leftovers.length).toBe(0);
    expect(fs.existsSync(srcMeta)).toBe(true);
    // 登记仍指向临时路径
    expect(store.get(id).filePath).toBe(src);
  });

  it('10. 未保留 / 已保留两种状态下，资产读取接口均正常', async function () {
    const r = await handlers['demo:save-recording']({}, { ext: 'webm', blobBase64: b64(4096) });
    const id = r.asset.id;

    // 未保留：内部资产可读，文件存在
    const before = store.get(id);
    expect(before.filePath).toBeTruthy();
    expect(fs.existsSync(before.filePath)).toBe(true);
    expect(fs.statSync(before.filePath).size).toBe(4096);

    // 保留后：同样可读
    const k = await handlers['demo:retain-recording']({}, { assetId: id });
    const after = store.get(id);
    expect(after.filePath).toBe(k.asset.filePath);
    expect(fs.existsSync(after.filePath)).toBe(true);
    expect(fs.statSync(after.filePath).size).toBe(4096);
  });

  it('11. 保留不是继续流程的前置条件：未保留也能继续下一步', function () {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    // __manualNextEnabled 不得包含 retained 判定
    const body = html.slice(html.indexOf('function __manualNextEnabled()'));
    const fn = body.slice(0, body.indexOf('window.__manualNextEnabled'));
    expect(fn).not.toMatch(/retained/);
    expect(fn).not.toMatch(/保留/);
    // 保留判定是独立函数
    expect(html).toMatch(/function __manualRetainEnabled\(\)/);
    // 保留按钮存在
    expect(html).toMatch(/onclick="retainManualRecording\(\)"/);
    expect(html).toMatch(/💾 保留录屏/);
    // preload 暴露
    const pre = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
    expect(pre).toMatch(/demoRetainRecording: \(assetId\) => ipcRenderer\.invoke\('demo:retain-recording', \{ assetId: assetId \}\)/);
  });

  it('12. 源码约束：保留只接受 assetId，不信任渲染层路径', function () {
    const body = AD_SRC.slice(AD_SRC.indexOf('async function retainRecording(opts)'));
    const fn = body.slice(0, body.indexOf('// -------- WebM -> MP4'));
    // 从 _internalStore 取真实路径
    expect(fn).toMatch(/getInternalAsset\(assetId\)/);
    // 不读 payload 里的路径
    expect(fn).not.toMatch(/opts\.filePath|opts\.path|p\.filePath/);
    // 用原 id 重新登记
    expect(fn).toMatch(/stashInternalAsset\(updated\)/);
    // 有回滚路径
    expect(fn).toMatch(/sidecar-move-failed/);
    expect(fn).toMatch(/sidecar-update-failed/);
    expect(fn).toMatch(/restake-failed/);
  });
});
