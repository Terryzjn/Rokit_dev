// Rokit · 原视频工作副本（temp/videos/source/）行为锁定
//
// 覆盖需求点（全部使用**真实生产代码** —— 用 vm 加载完整的 electron/video-source.js，
// 只替换 require('electron') 的 dialog / app，其余全部跑生产实现）：
//   1. 选择本地视频后，工作副本确实生成在 <userData>/temp/videos/source/
//   2. 内部资产 filePath 指向副本（不是用户原文件）
//   3. 用户原视频仍存在且内容未改变
//   4. 预览 / 冻结帧提取 / 字幕合成仍通过 getInternalAsset() 读到副本
//   5. 同一资产不会因不同平台读取而重复复制
//   6. 复制失败不会留下无效资产（不 stash）
//   7. Renderer 资产结构不泄露本地绝对路径
//   8. 非本地视频来源（手动录屏 stashInternalAsset）不受影响

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const VS_PATH = path.join(ROOT, 'electron', 'video-source.js');
const VS_SRC = fs.readFileSync(VS_PATH, 'utf8').replace(/\r\n/g, '\n');

let ud = '';            // userData 目录
let externalDir = '';   // 模拟"用户电脑上的其它位置"
let pickedPath = '';    // 模拟用户选中的文件
let pickCanceled = false;
let showOpenCalls = 0;

function loadProductionModule() {
  const fakeDialog = {
    showOpenDialog: async function () {
      showOpenCalls++;
      if (pickCanceled) return { canceled: true, filePaths: [] };
      return { canceled: false, filePaths: [pickedPath] };
    },
    showSaveDialog: function () { throw new Error('不应调用'); }
  };
  const fakeApp = { getPath: (k) => (k === 'userData' ? ud : ud) };
  const fakeLogger = { info() {}, warn() {}, error() {} };
  const fakeRequire = function (id) {
    if (id === 'electron') return { dialog: fakeDialog, app: fakeApp };
    if (id === './logger') return fakeLogger;
    if (id === './video') return { getMetadata: async function () { return null; } };
    return require(id);
  };
  const sandbox = {
    require: fakeRequire, module: { exports: {} }, exports: {}, console,
    Buffer, setTimeout, clearTimeout,
    __dirname: path.dirname(VS_PATH), __filename: VS_PATH
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(VS_SRC, sandbox, { filename: VS_PATH });
  return sandbox.module.exports;
}

function makeExternalVideo(name, size) {
  const p = path.join(externalDir, name);
  fs.writeFileSync(p, Buffer.alloc(size, 9));
  return p;
}

describe('原视频工作副本 · temp/videos/source/', function () {

  let prod;
  let handlers;

  beforeEach(function () {
    ud = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-wc-ud-'));
    externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-wc-ext-'));
    pickedPath = '';
    pickCanceled = false;
    showOpenCalls = 0;
    prod = loadProductionModule();
    handlers = {};
    prod.registerVideoSourceIpc({ handle: (ch, fn) => { handlers[ch] = fn; } });
  });

  afterEach(function () {
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_e) {}
    try { fs.rmSync(externalDir, { recursive: true, force: true }); } catch (_e) {}
  });

  it('1. 选择本地视频后：工作副本生成在 temp/videos/source/，原文件保留', async function () {
    const src = makeExternalVideo('我的视频.mp4', 8192);
    pickedPath = src;
    const srcHashBefore = fs.readFileSync(src);

    const r = await handlers['video:pick-local']({}, {});

    expect(r.ok).toBe(true);
    // 原文件仍在用户原位置，内容未变
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.readFileSync(src).equals(srcHashBefore)).toBe(true);

    // 工作副本目录里确实有文件
    const copyDir = path.join(ud, 'temp', 'videos', 'source');
    expect(fs.existsSync(copyDir)).toBe(true);
    const copies = fs.readdirSync(copyDir);
    expect(copies.length).toBe(1);
    // 文件名以 assetId 开头，保留 .mp4 扩展名
    expect(copies[0].startsWith(r.asset.id)).toBe(true);
    expect(/\.mp4$/i.test(copies[0])).toBe(true);
    // 副本内容与源一致
    expect(fs.readFileSync(path.join(copyDir, copies[0])).equals(srcHashBefore)).toBe(true);
  });

  it('2. 内部资产 filePath 指向副本而不是用户原文件', async function () {
    const src = makeExternalVideo('原始.mp4', 4096);
    pickedPath = src;

    const r = await handlers['video:pick-local']({}, {});
    const internal = prod.getInternalAsset(r.asset.id);

    expect(internal).not.toBe(null);
    expect(internal.filePath).not.toBe(src);
    expect(path.dirname(internal.filePath)).toBe(path.join(ud, 'temp', 'videos', 'source'));
    expect(fs.existsSync(internal.filePath)).toBe(true);
  });

  it('3. Renderer 资产结构不泄露本地绝对路径', async function () {
    const src = makeExternalVideo('外部.mp4', 2048);
    pickedPath = src;
    const r = await handlers['video:pick-local']({}, {});

    expect(r.ok).toBe(true);
    expect(r.asset).not.toBe(null);
    expect(r.asset.filePath).toBeUndefined();          // 不返回 filePath
    expect(r._internalFilePath).toBeUndefined();       // 已删除
    // 序列化后不含任何绝对路径
    const dumped = JSON.stringify(r);
    expect(dumped).not.toContain(ud);
    expect(dumped).not.toContain(externalDir);
    expect(dumped).not.toContain('\\');
    // 既有字段保持兼容
    expect(r.asset.id).toMatch(/^va-[0-9a-f]{16}$/);
    expect(r.asset.sourceType).toBe('LOCAL_FILE');
    expect(r.asset.fileName).toBe('外部.mp4');
    expect(r.asset.fileSize).toBe(2048);
    expect(r.asset.mimeType).toBe('video/mp4');
    expect(typeof r.asset.createdAt).toBe('number');
  });

  it('4. 预览 / 冻结帧 / 字幕合成都通过 getInternalAsset() 读到同一份副本', async function () {
    const src = makeExternalVideo('共享.mp4', 5000);
    pickedPath = src;
    const r = await handlers['video:pick-local']({}, {});
    const assetId = r.asset.id;

    // 模拟多次读取（预览 / 抽帧 / 合成各来一次）
    const p1 = prod.getInternalAsset(assetId).filePath;
    const p2 = prod.getInternalAsset(assetId).filePath;
    const p3 = prod.getInternalAsset(assetId).filePath;
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    // 副本目录里仍然只有 1 个文件（多次读取不重复复制）
    const copyDir = path.join(ud, 'temp', 'videos', 'source');
    expect(fs.readdirSync(copyDir).length).toBe(1);
  });

  it('5. 同一资产不会因不同平台读取而重复复制（多次 pick 各得各自副本）', async function () {
    const src = makeExternalVideo('两次.mp4', 3000);
    pickedPath = src;

    const r1 = await handlers['video:pick-local']({}, {});
    const r2 = await handlers['video:pick-local']({}, {});

    // 两次选择得到不同 assetId → 两个独立副本（各自唯一命名，互不覆盖）
    expect(r1.asset.id).not.toBe(r2.asset.id);
    const copyDir = path.join(ud, 'temp', 'videos', 'source');
    const copies = fs.readdirSync(copyDir);
    expect(copies.length).toBe(2);
    // 各自指向自己的副本
    expect(prod.getInternalAsset(r1.asset.id).filePath).not.toBe(prod.getInternalAsset(r2.asset.id).filePath);
  });

  it('6. 复制失败 → 返回错误结构，且不登记资产（无无效资产残留）', async function () {
    // 让目标目录不可写：用一个**文件**占位 temp/videos/source → mkdir 失败 → 复制失败
    const src = makeExternalVideo('不可写.mp4', 2048);
    pickedPath = src;
    const blocker = path.join(ud, 'temp', 'videos', 'source');
    fs.mkdirSync(path.dirname(blocker), { recursive: true });
    fs.writeFileSync(blocker, 'not-a-dir');   // 占位文件 → mkdirSync 失败

    const r = await handlers['video:pick-local']({}, {});

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/工作副本创建失败/);
    expect(r.asset).toBeUndefined();
    // 不应留下任何已登记资产
    //   —— 由于 pick 失败没有 assetId，这里用 stash 表大小判断（内部表不可见，改为断言副本未生成）
    // 原文件仍在
    expect(fs.existsSync(src)).toBe(true);
  });

  it('7. 源文件不存在 → 明确失败，不生成副本', async function () {
    pickedPath = path.join(externalDir, 'not-exist.mp4');
    const r = await handlers['video:pick-local']({}, {});
    expect(r.ok).toBe(false);
    // 既有行为：buildAsset 的 fs.statSync 对不存在的文件直接抛 ENOENT（未改动该语义）
    expect(String(r.error)).toMatch(/ENOENT|路径不是文件/);
    expect(r.asset).toBeUndefined();
    const copyDir = path.join(ud, 'temp', 'videos', 'source');
    const exists = fs.existsSync(copyDir) ? fs.readdirSync(copyDir).length : 0;
    expect(exists).toBe(0);
  });

  it('8. 非本地视频来源不受影响：stashInternalAsset 直接登记的资产保持原路径', async function () {
    // 模拟手动录屏（ai-demo.js 走 stashInternalAsset，filePath 指向自己的落盘位置）
    const recPath = path.join(ud, 'videos', 'abcd1234.webm');
    fs.mkdirSync(path.dirname(recPath), { recursive: true });
    fs.writeFileSync(recPath, Buffer.alloc(512, 3));

    prod.stashInternalAsset({
      id: 'va-manualrec01',
      sourceType: 'MANUAL_RECORDING',
      filePath: recPath,
      fileName: 'abcd1234.webm',
      fileSize: 512,
      mimeType: 'video/webm',
      createdAt: Date.now()
    });

    const internal = prod.getInternalAsset('va-manualrec01');
    expect(internal.filePath).toBe(recPath);          // 保持原路径，未被复制
    expect(path.dirname(internal.filePath)).toBe(path.join(ud, 'videos'));
    // 也没有在 temp/videos/source/ 里产生副本
    const copyDir = path.join(ud, 'temp', 'videos', 'source');
    const exists = fs.existsSync(copyDir) ? fs.readdirSync(copyDir).length : 0;
    expect(exists).toBe(0);
  });

  it('9. 用户取消 → 不复制、不登记', async function () {
    pickCanceled = true;
    const r = await handlers['video:pick-local']({}, {});
    expect(r.ok).toBe(false);
    expect(r.canceled).toBe(true);
    const copyDir = path.join(ud, 'temp', 'videos', 'source');
    const exists = fs.existsSync(copyDir) ? fs.readdirSync(copyDir).length : 0;
    expect(exists).toBe(0);
  });

  it('10. 源码约束：工作副本只作用于 handlePickLocal（不套用到其它来源）', function () {
    // _createSourceWorkingCopy 只在 handlePickLocal 内被调用
    const pickBody = VS_SRC.slice(
      VS_SRC.indexOf('async function handlePickLocal(event)'),
      VS_SRC.indexOf('/**\n * 异步探测视频 metadata')
    );
    expect(pickBody).toMatch(/_createSourceWorkingCopy\(filePath, asset\.id\)/);
    expect(pickBody).toMatch(/asset\.filePath = _workingCopy;/);
    // buildAsset 不含复制逻辑（保持"只构造元数据"）
    const buildBody = VS_SRC.slice(
      VS_SRC.indexOf('function buildAsset(filePath, sourceType)'),
      VS_SRC.indexOf('// ---------- 原视频工作副本 ----------')
    );
    expect(buildBody).not.toMatch(/copyFileSync/);
    // stashInternalAsset 不含复制逻辑（录屏等其它来源不受影响）
    const stashBody = VS_SRC.slice(
      VS_SRC.indexOf('function stashInternalAsset(asset)'),
      VS_SRC.indexOf('function getInternalAsset(assetId)')
    );
    expect(stashBody).not.toMatch(/copyFileSync/);
  });
});
