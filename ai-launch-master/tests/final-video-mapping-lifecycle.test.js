// Rokit · 作品关联视频映射的生命周期（第一批）—— 定向测试
//
// 覆盖需求点：
//   1. SQLite 模式删除作品时，只删除**该作品自己的** finalVideo:<id> 映射
//   2. JSON 模式删除作品时，同样只删除自己的映射
//   3. 正常迁移成功后：目标映射存在、源草稿映射被删除
//   4. 目标已有映射时：目标与源**都保留**，返回 migrated:false
//   5. 目标写入失败时：源映射保留
//   6. 删除映射**不触碰任何磁盘文件**
//
// 全部使用临时数据库 / 临时目录 + mock store，**不产生真实视频文件**，
// 不连接任何平台 API，不修改生产数据库。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const H = require('./helpers/plan-store');

const ROOT = path.resolve(__dirname, '..');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');

const VIDEO_W1 = 'C:/rokit-final/w1.mp4';
const VIDEO_W2 = 'C:/rokit-final/w2.mp4';
const VIDEO_DRAFT = 'C:/rokit-final/draft.mp4';

// ---------- store 工厂 ----------
let tmpDir = null;
let dbPath = null;

function makeTmp() {
  if (!tmpDir) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-fvmapping-'));
    dbPath = path.join(tmpDir, 'test.db');
  }
  return tmpDir;
}
function cleanupTmp() {
  H.restoreDrivers();
  if (tmpDir) { H.rmTmpDir(tmpDir); tmpDir = null; dbPath = null; }
}
function newStore(jsonMode) {
  makeTmp();
  const { Store } = H.loadStoreFresh(!!jsonMode);   // jsonMode=true → 屏蔽两个驱动 → JSON 兜底
  return new Store(dbPath);
}

beforeEach(() => { makeTmp(); });
afterEach(() => { cleanupTmp(); });

/* ==================================================================
   1 · 删除作品 → 清理自己的 finalVideo: 映射（SQLite / JSON）
   ================================================================== */
describe('1 · 删除作品清理自身 finalVideo: 映射', function () {
  it('1a. SQLite 模式：只删除被删作品自己的映射，其它作品的映射不受影响', function () {
    const store = newStore(false);
    expect(store.mode).toBe('sqlite');
    H.seedWork(store, 'w1', '作品一');
    H.seedWork(store, 'w2', '作品二');
    store.upsertSettingKv('finalVideo:w1', VIDEO_W1);
    store.upsertSettingKv('finalVideo:w2', VIDEO_W2);

    store.deleteWork('w1');

    // 被删作品的映射被清理
    expect(store.getSettingKv('finalVideo:w1')).toBe(null);
    // 其它作品的映射完好无损
    expect(store.getSettingKv('finalVideo:w2')).toBe(VIDEO_W2);
    // 作品行本身也删掉了
    expect(store.listWorks().map(function (w) { return w.id; })).toEqual(['w2']);
  });

  it('1b. JSON 模式：同样只删除自己的映射，并落到 jsonFile', function () {
    const store = newStore(true);
    expect(store.mode).not.toBe('sqlite');
    H.seedWork(store, 'w1', '作品一');
    H.seedWork(store, 'w2', '作品二');
    store.upsertSettingKv('finalVideo:w1', VIDEO_W1);
    store.upsertSettingKv('finalVideo:w2', VIDEO_W2);

    store.deleteWork('w1');

    // JSON 兜底模式：getSettingKv 对缺失键返回 undefined（既有行为）
    expect(store.getSettingKv('finalVideo:w1')).toBeFalsy();
    expect(store.getSettingKv('finalVideo:w2')).toBe(VIDEO_W2);

    // 落盘后同样成立（JSON 兜底必须持久化这次清理）
    const raw = JSON.parse(fs.readFileSync(store.jsonFile, 'utf8'));
    expect(raw.settings_kv['finalVideo:w1']).toBeUndefined();
    expect(raw.settings_kv['finalVideo:w2']).toBe(VIDEO_W2);
  });

  it('1c. 删除没有映射的作品 → 不报错，其它映射不受影响', function () {
    const store = newStore(false);
    H.seedWork(store, 'w1', '作品一');
    H.seedWork(store, 'w2', '作品二');
    store.upsertSettingKv('finalVideo:w2', VIDEO_W2);

    expect(function () { store.deleteWork('w1'); }).not.toThrow();

    expect(store.getSettingKv('finalVideo:w2')).toBe(VIDEO_W2);
  });

  it('1d. store.deleteWork() 本身只动数据库，绝不触碰磁盘视频文件', function () {
    // v1.22.6（第四批）：磁盘文件的回收改由**主进程新删除入口**
    //   （deleteWorkAndReclaimVideo）负责 —— 它会先判断是否还有其它作品 / 草稿引用。
    //   store.deleteWork() 的职责仍然只是"删数据库记录"，本身不做任何文件操作。
    const store = newStore(false);
    H.seedWork(store, 'w1', '作品一');
    store.upsertSettingKv('finalVideo:w1', VIDEO_W1);

    // 造一个真实存在的假视频文件，确认 deleteWork 之后它**仍在**
    const fakeVideo = path.join(makeTmp(), 'fake-final.mp4');
    fs.writeFileSync(fakeVideo, 'FAKE_MP4');
    store.upsertSettingKv('finalVideo:w1', fakeVideo);

    store.deleteWork('w1');

    expect(store.getSettingKv('finalVideo:w1')).toBe(null);
    // store 层不删文件 → 文件仍在
    expect(fs.existsSync(fakeVideo)).toBe(true);
  });

  it('1e. 主进程新删除入口负责安全回收文件（引用判断 + 受管目录白名单）', function () {
    // 反向确认：文件回收**不在** store 层，而在 main.js 的新入口。
    const mainSrc = MAIN_SRC;
    expect(mainSrc).toMatch(/function deleteWorkAndReclaimVideo\(workId\)/);
    expect(mainSrc).toMatch(/function _safeUnlinkManagedArchive\(filePath\)/);
    // 新入口里先删作品数据、失败即中止；文件删除在数据删除之后
    const block = mainSrc.slice(
      mainSrc.indexOf('function deleteWorkAndReclaimVideo(workId)'),
      mainSrc.indexOf('// 取 GitHub 发布目标', mainSrc.indexOf('function deleteWorkAndReclaimVideo(workId)'))
    );
    const delAt = block.indexOf('store.deleteWork(id)');
    const unlinkAt = block.indexOf('_safeUnlinkManagedArchive(candidate)');
    expect(delAt).toBeGreaterThan(0);
    expect(unlinkAt).toBeGreaterThan(delAt);   // 文件删除在作品数据删除之后
  });
});

/* ==================================================================
   2 · 草稿映射迁移（migrateWorkFinalVideo）
   ================================================================== */
describe('2 · 草稿映射迁移的生命周期', function () {
  // 从 main.js 源码里切出 migrateWorkFinalVideo 函数体，用注入的 mock store 执行。
  //   真实实现依赖模块级 `store` 与 `FINAL_VIDEO_KEY_PREFIX`，
  //   通过 new Function 把这两个依赖注入，避免改动生产代码的可测性。
  //   注意：store 是**闭包变量**（不是函数参数）→ 返回的包装函数只接受 (fromOwner, toOwner)。
  function loadMigrate() {
    const start = MAIN_SRC.indexOf('function migrateWorkFinalVideo');
    const end = MAIN_SRC.indexOf('// 取 GitHub 发布目标');
    if (start < 0 || end < 0 || end <= start) throw new Error('源码中找不到 migrateWorkFinalVideo');
    const body = MAIN_SRC.slice(start, end);
    const prefixStart = MAIN_SRC.indexOf("const FINAL_VIDEO_KEY_PREFIX = 'finalVideo:'");
    const prefixEnd = MAIN_SRC.indexOf('\n', prefixStart);
    const prefixLine = MAIN_SRC.slice(prefixStart, prefixEnd);
    const factory = new Function(
      'store',
      prefixLine + '\n' + body
      + '\nreturn function(fromOwner, toOwner){ return migrateWorkFinalVideo(fromOwner, toOwner); };'
    );
    return function (mockStore) { return factory(mockStore); };
  }

  // 构造一个最小可用的 mock store（记录调用顺序，可注入失败）
  function makeMockStore(initial, opts) {
    opts = opts || {};
    const kv = Object.assign({}, initial || {});
    const calls = [];
    return {
      kv: kv,
      calls: calls,
      getSettingKv: function (key) {
        calls.push(['get', key]);
        return Object.prototype.hasOwnProperty.call(kv, key) ? kv[key] : null;
      },
      upsertSettingKv: function (key, value) {
        calls.push(['upsert', key, value]);
        if (opts.failUpsert) throw new Error('mock-upsert-failed');
        kv[key] = value;
      },
      deleteSettingKv: function (key) {
        calls.push(['delete', key]);
        if (opts.failDelete) throw new Error('mock-delete-failed');
        delete kv[key];
        return { ok: true, key: key };
      },
      hasDeleteSettingKv: true
    };
  }

  it('2a. 正常迁移：目标映射写入成功 → 源草稿映射被删除', function () {
        const store = makeMockStore({ 'finalVideo:draft_x': VIDEO_DRAFT });

    const r = (loadMigrate()(store))('draft_x', 'w1');

    expect(r.ok).toBe(true);
    expect(r.migrated).toBe(true);
    // 目标映射存在且值正确
    expect(store.kv['finalVideo:w1']).toBe(VIDEO_DRAFT);
    // 源草稿映射已删除
    expect(store.kv['finalVideo:draft_x']).toBeUndefined();
    // 调用顺序：读源 → 读目标 → 写目标 → 删源
    const order = store.calls.map(function (c) { return c[0] + ':' + c[1]; });
    expect(order).toEqual([
      'get:finalVideo:draft_x',
      'get:finalVideo:w1',
      'upsert:finalVideo:w1',
      'delete:finalVideo:draft_x'
    ]);
  });

  it('2b. 目标已有映射：目标与源都保留，返回 migrated:false', function () {
        const store = makeMockStore({
      'finalVideo:draft_x': VIDEO_DRAFT,
      'finalVideo:w1': VIDEO_W1
    });

    const r = (loadMigrate()(store))('draft_x', 'w1');

    expect(r.ok).toBe(true);
    expect(r.migrated).toBe(false);
    // 目标不被覆盖
    expect(store.kv['finalVideo:w1']).toBe(VIDEO_W1);
    // 源也保留（保守：该草稿视频可能正被别的作品复用）
    expect(store.kv['finalVideo:draft_x']).toBe(VIDEO_DRAFT);
    // 没有任何写 / 删动作
    expect(store.calls.some(function (c) { return c[0] === 'upsert' || c[0] === 'delete'; })).toBe(false);
  });

  it('2c. 目标写入失败：源映射保留，且不产生目标映射', function () {
        const store = makeMockStore({ 'finalVideo:draft_x': VIDEO_DRAFT }, { failUpsert: true });

    const r = (loadMigrate()(store))('draft_x', 'w1');

    expect(r.ok).toBe(false);
    expect(r.error).toBe('exception');
    // 源映射完好
    expect(store.kv['finalVideo:draft_x']).toBe(VIDEO_DRAFT);
    // 目标映射不存在
    expect(store.kv['finalVideo:w1']).toBeUndefined();
    // 失败路径没有执行删除
    expect(store.calls.some(function (c) { return c[0] === 'delete'; })).toBe(false);
  });

  it('2d. 源映射不存在：什么都不做', function () {
        const store = makeMockStore({});

    const r = (loadMigrate()(store))('draft_x', 'w1');

    expect(r.ok).toBe(true);
    expect(r.migrated).toBe(false);
    expect(store.calls.some(function (c) { return c[0] === 'upsert' || c[0] === 'delete'; })).toBe(false);
  });

  it('2e. from === to 或参数为空：什么都不做', function () {
        const store = makeMockStore({ 'finalVideo:w1': VIDEO_W1 });

    expect((loadMigrate()(store))('w1', 'w1').migrated).toBe(false);
    expect((loadMigrate()(store))('', 'w1').migrated).toBe(false);
    expect((loadMigrate()(store))('draft_x', '').migrated).toBe(false);
    expect(store.kv['finalVideo:w1']).toBe(VIDEO_W1);
    expect(store.calls.length).toBe(0);
  });

  it('2f. store 没有 deleteSettingKv 能力：仍然迁移成功，但不删源键', function () {
        const store = makeMockStore({ 'finalVideo:draft_x': VIDEO_DRAFT });
    store.deleteSettingKv = undefined;   // 模拟旧版 store（无该能力）

    const r = (loadMigrate()(store))('draft_x', 'w1');

    expect(r.ok).toBe(true);
    expect(r.migrated).toBe(true);
    expect(store.kv['finalVideo:w1']).toBe(VIDEO_DRAFT);
    // 没有删除能力 → 源键保留（不报错）
    expect(store.kv['finalVideo:draft_x']).toBe(VIDEO_DRAFT);
  });

  it('2g. 删除源键失败（抛错）：不影响迁移结论，源键仍在', function () {
        const store = makeMockStore({ 'finalVideo:draft_x': VIDEO_DRAFT }, { failDelete: true });

    const r = (loadMigrate()(store))('draft_x', 'w1');

    // 迁移本身成功
    expect(r.ok).toBe(true);
    expect(r.migrated).toBe(true);
    expect(store.kv['finalVideo:w1']).toBe(VIDEO_DRAFT);
    // 删除失败被吞 → 源键仍在
    expect(store.kv['finalVideo:draft_x']).toBe(VIDEO_DRAFT);
  });
});

/* ==================================================================
   3 · 源码级安全约束
   ================================================================== */
describe('3 · 安全约束（源码断言）', function () {
  it('3a. store.js 全文没有删除文件的操作（删除映射绝不碰磁盘）', function () {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8');
    expect(src).not.toMatch(/unlinkSync|rmSync|rmdirSync|trashItem|fs\.rm\s*\(/);
  });

  it('3b. deleteWork() 用 deleteSettingKv 精确删键（不按前缀批量删）', function () {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8');
    const start = src.indexOf('deleteWork(id) {');
    const end = src.indexOf('// ---------- 发布记录 ----------', start);
    const block = src.slice(start, end);
    expect(block).toMatch(/deleteSettingKv\(FINAL_VIDEO_KEY_PREFIX \+ id\)/);
    // 绝不能出现「按前缀批量删除」
    expect(block).not.toMatch(/deleteSettingKv\('finalVideo:'\)/);
    expect(block).not.toMatch(/_listSettingKv\('finalVideo:'\)/);
  });

  it('3c. main.js 的 migrateWorkFinalVideo 保留「目标已有映射时不覆盖」的源码结构', function () {
    const start = MAIN_SRC.indexOf('function migrateWorkFinalVideo');
    const end = MAIN_SRC.indexOf('// 取 GitHub 发布目标');
    const block = MAIN_SRC.slice(start, end);
    expect(block).toMatch(/if \(!store\.getSettingKv\(FINAL_VIDEO_KEY_PREFIX \+ to\)\)/);
    // 删除源键必须被 deleteSettingKv 的可用性检查包住
    expect(block).toMatch(/typeof store\.deleteSettingKv === 'function'/);
  });

  it('3d. store.js 不含 work-videos（第一批范围）；main.js 已在第二批加入受管目录支持', function () {
    const storeSrc = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8');
    // 第一批只改映射生命周期 → store.js 不应出现 work-videos
    expect(storeSrc).not.toMatch(/work-videos/);
    // 第二批已在 main.js / video-source.js 加入 work-videos 受管目录支持 → 正向断言
    const mainSrc = MAIN_SRC;
    expect(mainSrc).toMatch(/'work-videos'/);
    expect(mainSrc).toMatch(/function managedFinalVideoRoots\(\)/);
  });
});
