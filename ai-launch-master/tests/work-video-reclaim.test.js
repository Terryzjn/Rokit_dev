// Rokit · 删除作品时的关联视频引用检查与安全回收（第四批）—— 定向测试
//
// 覆盖需求第六节的 16 个验证点：
//   1  最后一个引用者删除 → 作品 + work-videos 视频均删除
//   2  两个作品引用同一视频 → 删其中一个只删其作品数据（视频保留）
//   3  三个作品共享视频 → 删任意两个后视频仍存在
//   4  最后一个真实作品删除，但草稿映射仍引用 → 视频保留
//   5  无关联视频 → 正常删除作品
//   6  temp/videos/final/ 的视频绝不删除
//   7  saved-videos/、videos/ 的视频绝不删除
//   8  路径穿越拒绝
//   9  符号链接拒绝
//  10  目录本身拒绝
//  11  非普通文件拒绝
//  12  文件删除失败 → 作品数据仍保持已删除，返回明确结果
//  13  作品数据删除失败 → 绝不删除文件
//  14  弹窗前查询与实际删除时状态不一致 → 以主进程执行时的最新状态为准
//  15  seedWorks() 静默删除不弹确认框
//  16  旧 works:delete IPC 与 store.deleteWork() 返回语义不变
//
// 全部使用**隔离临时目录 + mock store**，绝不触碰生产数据库 / 真实媒体。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

// ---------- 通用：按花括号配平切出具名函数 ----------
function extractFn(src, header) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error('源码中找不到：' + header);
  const open = src.indexOf('{', start);
  if (open < 0) throw new Error('缺少花括号：' + header);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('花括号不配平：' + header);
}

let ud = '';
let finalDir = '';    // <ud>/temp/videos/final
let workDir = '';     // <ud>/work-videos
let savedDir = '';    // <ud>/saved-videos
let videosDir = '';   // <ud>/videos

beforeEach(function () {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-reclaim-'));
  finalDir = path.join(ud, 'temp', 'videos', 'final');
  workDir = path.join(ud, 'work-videos');
  savedDir = path.join(ud, 'saved-videos');
  videosDir = path.join(ud, 'videos');
  fs.mkdirSync(finalDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(savedDir, { recursive: true });
  fs.mkdirSync(videosDir, { recursive: true });
});

afterEach(function () {
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_e) {}
});

// ---------- 主进程函数集合（注入 app / fs / path / store / crypto 后执行生产源码） ----------
function loadMainFns(opts) {
  const o = opts || {};
  const src = [
    "const FINAL_VIDEO_KEY_PREFIX = 'finalVideo:';",
    extractFn(MAIN_SRC, 'function managedFinalVideoRoots()'),
    extractFn(MAIN_SRC, 'function isInsideManagedFinalDir(resolvedPath, roots)'),
    extractFn(MAIN_SRC, 'function resolveFinalVideoFile(filePath)'),
    extractFn(MAIN_SRC, 'function normalizeVideoOwnerId(workId)'),
    extractFn(MAIN_SRC, 'function workVideosDir()'),
    extractFn(MAIN_SRC, 'function _fileSha256(filePath)'),
    extractFn(MAIN_SRC, 'function _findArchivedBySha256(sha, dir, srcSize)'),
    extractFn(MAIN_SRC, 'function _uniqueArchivePath(dir, fileName)'),
    extractFn(MAIN_SRC, 'function archiveFinalVideoForWork(workId, videoPath)'),
    extractFn(MAIN_SRC, 'function _normVideoPath(p)'),
    extractFn(MAIN_SRC, 'function _isDraftOwnerKey(ownerId)'),
    extractFn(MAIN_SRC, 'function _collectVideoMappingOwners(targetPath, excludeWorkId)'),
    extractFn(MAIN_SRC, 'function listWorkVideoReferences(workId)'),
    extractFn(MAIN_SRC, 'function _safeUnlinkManagedArchive(filePath)'),
    extractFn(MAIN_SRC, 'function deleteWorkAndReclaimVideo(workId)')
  ].join('\n');

  const factory = new Function(
    'app', 'fs', 'path', 'store', 'crypto',
    src + '\nreturn { list: listWorkVideoReferences, reclaim: deleteWorkAndReclaimVideo, unlink: _safeUnlinkManagedArchive, archive: archiveFinalVideoForWork };'
  );
  return factory(
    { getPath: function () { return ud; } },
    o.fs || fs,
    path,
    o.store,
    require('crypto')
  );
}

// settings_kv + works mock
function makeStore(opts) {
  const o = opts || {};
  const kv = Object.assign({}, o.kv || {});
  const works = (o.works || [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]).map(function (w) {
    return typeof w === 'string' ? { id: w } : w;
  });
  const deleted = [];
  return {
    kv: kv,
    works: works,
    deleted: deleted,
    listWorks: function () { return works; },
    getSettingKv: function (k) { return kv[k] === undefined ? null : kv[k]; },
    upsertSettingKv: function (k, v) { kv[k] = String(v); return true; },
    deleteSettingKv: function (k) { delete kv[k]; return { ok: true, key: k }; },
    _listSettingKv: function (prefix) {
      const p = String(prefix || '');
      if (!p) return [];
      return Object.keys(kv).filter(function (k) { return k.indexOf(p) === 0; })
        .map(function (k) { return { k: k, v: kv[k] }; });
    },
    // 模拟 store.deleteWork：删作品行 + 自己的 finalVideo 映射（不碰任何文件）
    deleteWork: function (id) {
      if (o.failDeleteWork) throw new Error('模拟作品数据删除失败');
      const i = works.findIndex(function (w) { return w.id === id; });
      if (i < 0) return false;
      works.splice(i, 1);
      delete kv['finalVideo:' + id];
      deleted.push(id);
      return true;
    }
  };
}

function makeArchive(store, name, body) {
  const p = path.join(workDir, name);
  fs.writeFileSync(p, Buffer.from(body || 'ARCHIVE-BYTES'));
  return p;
}

// =========================================================================
// A · 删除作品时的引用判断与安全回收
// =========================================================================
describe('A1 · 删除作品时回收最后引用的归档视频', () => {
  it('1 · 最后一个引用者删除：作品与 work-videos 视频均删除', () => {
    const store = makeStore({ works: [{ id: 'w1' }] });
    const archive = makeArchive(store, 'final-only.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    const M = loadMainFns({ store: store });

    const r = M.reclaim('w1');
    expect(r.ok).toBe(true);
    expect(r.workDeleted).toBe(true);
    expect(r.videoDeleted).toBe(true);
    expect(r.videoKept).toBe(false);
    expect(r.reason).toBe('video-reclaimed');
    // 作品行已删、映射已删
    expect(store.listWorks()).toHaveLength(0);
    expect(store.getSettingKv('finalVideo:w1')).toBeFalsy();
    // 视频文件已删
    expect(fs.existsSync(archive)).toBe(false);
  });

  it('2 · 两个作品引用同一视频：删其中一个只删其作品数据，视频保留', () => {
    const store = makeStore({ works: [{ id: 'w1' }, { id: 'w2' }] });
    const archive = makeArchive(store, 'final-shared.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    store.upsertSettingKv('finalVideo:w2', archive);
    const M = loadMainFns({ store: store });

    const r = M.reclaim('w1');
    expect(r.ok).toBe(true);
    expect(r.workDeleted).toBe(true);
    expect(r.videoDeleted).toBe(false);
    expect(r.videoKept).toBe(true);
    expect(r.reason).toBe('still-shared');
    expect(r.sharedWith).toEqual(['w2']);
    // 视频仍在
    expect(fs.existsSync(archive)).toBe(true);
    // 另一个作品的映射完好
    expect(store.getSettingKv('finalVideo:w2')).toBe(archive);
    expect(store.getSettingKv('finalVideo:w1')).toBeFalsy();
  });

  it('3 · 三个作品共享视频：删任意两个后视频仍存在', () => {
    const store = makeStore({ works: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] });
    const archive = makeArchive(store, 'final-triple.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    store.upsertSettingKv('finalVideo:w2', archive);
    store.upsertSettingKv('finalVideo:w3', archive);
    const M = loadMainFns({ store: store });

    expect(M.reclaim('w1').videoDeleted).toBe(false);
    expect(M.reclaim('w2').videoDeleted).toBe(false);
    // 两个已删，视频仍在（第三个还在引用）
    expect(fs.existsSync(archive)).toBe(true);
    // 删最后一个 → 视频被回收
    const last = M.reclaim('w3');
    expect(last.videoDeleted).toBe(true);
    expect(fs.existsSync(archive)).toBe(false);
  });

  it('4 · 最后一个真实作品删除，但草稿映射仍引用视频 → 视频保留', () => {
    const store = makeStore({ works: [{ id: 'w1' }] });
    const archive = makeArchive(store, 'final-draft-ref.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    store.upsertSettingKv('finalVideo:draft_abc123_x9', archive);
    const M = loadMainFns({ store: store });

    const r = M.reclaim('w1');
    expect(r.ok).toBe(true);
    expect(r.workDeleted).toBe(true);
    expect(r.videoDeleted).toBe(false);
    expect(r.videoKept).toBe(true);
    expect(r.reason).toBe('draft-referenced');
    expect(r.draftReferenced).toBe(true);
    // 视频仍在
    expect(fs.existsSync(archive)).toBe(true);
    // 草稿映射仍在
    expect(store.getSettingKv('finalVideo:draft_abc123_x9')).toBe(archive);
  });

  it('5 · 无关联视频时正常删除作品', () => {
    const store = makeStore({ works: [{ id: 'w1' }] });
    const M = loadMainFns({ store: store });
    const r = M.reclaim('w1');
    expect(r.ok).toBe(true);
    expect(r.workDeleted).toBe(true);
    expect(r.videoDeleted).toBe(false);
    expect(r.reason).toBe('no-video');
    expect(store.listWorks()).toHaveLength(0);
  });

  it('6 · temp/videos/final/ 中的视频绝不删除', () => {
    const store = makeStore({ works: [{ id: 'w1' }] });
    const tmpVideo = path.join(finalDir, 'final-temp.mp4');
    fs.writeFileSync(tmpVideo, 'TEMP');
    store.upsertSettingKv('finalVideo:w1', tmpVideo);
    const M = loadMainFns({ store: store });

    const r = M.reclaim('w1');
    expect(r.ok).toBe(true);
    expect(r.workDeleted).toBe(true);
    expect(r.videoDeleted).toBe(false);
    expect(r.reason).toBe('video-out-of-scope');
    // 临时视频仍在
    expect(fs.existsSync(tmpVideo)).toBe(true);
  });

  it('7 · saved-videos/ 与 videos/ 中的视频绝不删除', () => {
    const store = makeStore({ works: [{ id: 'w1' }, { id: 'w2' }] });
    const saved = path.join(savedDir, 'saved.mp4');
    const plain = path.join(videosDir, 'recording.mp4');
    fs.writeFileSync(saved, 'SAVED');
    fs.writeFileSync(plain, 'PLAIN');
    store.upsertSettingKv('finalVideo:w1', saved);
    store.upsertSettingKv('finalVideo:w2', plain);
    const M = loadMainFns({ store: store });

    const r1 = M.reclaim('w1');
    expect(r1.videoDeleted).toBe(false);
    expect(r1.reason).toBe('video-out-of-scope');
    expect(fs.existsSync(saved)).toBe(true);

    const r2 = M.reclaim('w2');
    expect(r2.videoDeleted).toBe(false);
    expect(r2.reason).toBe('video-out-of-scope');
    expect(fs.existsSync(plain)).toBe(true);
  });

  it('8 · 路径穿越拒绝（映射指向 work-videos 之外的路径）', () => {
    const store = makeStore({ works: [{ id: 'w1' }] });
    const outside = path.join(ud, 'escape.mp4');
    fs.writeFileSync(outside, 'ESCAPE');
    store.upsertSettingKv('finalVideo:w1', outside);
    const M = loadMainFns({ store: store });
    const r = M.reclaim('w1');
    expect(r.videoDeleted).toBe(false);
    expect(r.reason).toBe('video-out-of-scope');
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('9 · 符号链接拒绝', function () {
    const store = makeStore({ works: [{ id: 'w1' }] });
    const target = path.join(workDir, 'real-target.mp4');
    fs.writeFileSync(target, 'REAL');
    const link = path.join(workDir, 'link.mp4');
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (_e) {
      return;   // 平台不支持符号链接 → 跳过
    }
    store.upsertSettingKv('finalVideo:w1', link);
    const M = loadMainFns({ store: store });
    const r = M.reclaim('w1');
    expect(r.workDeleted).toBe(true);
    expect(r.videoDeleted).toBe(false);
    expect(r.reason).toBe('video-delete-failed');
    expect(r.error).toBe('is-symlink');
    // 符号链接与其目标都还在
    expect(fs.existsSync(link)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('10 · 目录本身拒绝', () => {
    const store = makeStore({ works: [{ id: 'w1' }] });
    store.upsertSettingKv('finalVideo:w1', workDir);   // 映射指向目录本身
    const M = loadMainFns({ store: store });
    const r = M.reclaim('w1');
    expect(r.videoDeleted).toBe(false);
    // 目录还在
    expect(fs.existsSync(workDir)).toBe(true);
    expect(fs.statSync(workDir).isDirectory()).toBe(true);
  });

  it('11 · 非普通文件拒绝（_safeUnlinkManagedArchive 直接调用）', () => {
    const store = makeStore();
    const M = loadMainFns({ store: store });
    // 目录本身
    expect(M.unlink(workDir).error).toBe('path-is-directory-root');
    // 子目录
    const sub = path.join(workDir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    expect(M.unlink(sub).error).toBe('is-directory');
    // 目录外的文件
    const outside = path.join(ud, 'outside.mp4');
    fs.writeFileSync(outside, 'X');
    expect(M.unlink(outside).error).toBe('path-not-allowed');
    // 路径穿越
    expect(M.unlink(path.join(workDir, '..', 'escape.mp4')).error).toBe('path-not-allowed');
    // 不存在
    expect(M.unlink(path.join(workDir, 'nope.mp4')).error).toBe('file-missing');
    // 空路径
    expect(M.unlink('').error).toBe('no-path');
  });

  it('12 · 文件删除失败：作品数据仍保持已删除，并返回明确结果', () => {
    const store = makeStore({ works: [{ id: 'w1' }] });
    const archive = makeArchive(store, 'final-locked.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    // 让 unlinkSync 抛错
    const brokenFs = Object.assign({}, fs, {
      unlinkSync: function () { throw new Error('模拟文件被占用'); }
    });
    const M = loadMainFns({ store: store, fs: brokenFs });

    const r = M.reclaim('w1');
    expect(r.ok).toBe(true);
    expect(r.workDeleted).toBe(true);          // 作品数据已删除
    expect(r.videoDeleted).toBe(false);
    expect(r.videoKept).toBe(true);
    expect(r.reason).toBe('video-delete-failed');
    expect(r.error).toBe('unlink-failed');
    // 作品行与映射都已删（不回滚）
    expect(store.listWorks()).toHaveLength(0);
    expect(store.getSettingKv('finalVideo:w1')).toBeFalsy();
    // 文件留下作为孤儿
    expect(fs.existsSync(archive)).toBe(true);
  });

  it('13 · 作品数据删除失败：绝不删除文件', () => {
    const store = makeStore({ works: [{ id: 'w1' }], failDeleteWork: true });
    const archive = makeArchive(store, 'final-keep.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    const M = loadMainFns({ store: store });

    const r = M.reclaim('w1');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('work-delete-failed');
    expect(r.workDeleted).toBe(false);
    expect(r.videoDeleted).toBe(false);
    // 文件仍在
    expect(fs.existsSync(archive)).toBe(true);
    // 作品行与映射都还在
    expect(store.listWorks()).toHaveLength(1);
    expect(store.getSettingKv('finalVideo:w1')).toBe(archive);
  });

  it('14 · 以主进程执行时的最新引用状态为准（忽略 Renderer 的旧查询）', () => {
    const store = makeStore({ works: [{ id: 'w1' }, { id: 'w2' }] });
    const archive = makeArchive(store, 'final-late.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    const M = loadMainFns({ store: store });

    // 「弹窗前」的查询：当时没有任何其它作品引用
    const before = M.list('w1');
    expect(before.hasVideo).toBe(true);
    expect(before.count).toBe(0);

    // 查询之后、作品真正被删之前，w2 也归档了同一个视频
    store.upsertSettingKv('finalVideo:w2', archive);

    // 实际删除：以执行时的最新状态为准 → 视频保留
    const r = M.reclaim('w1');
    expect(r.videoDeleted).toBe(false);
    expect(r.videoKept).toBe(true);
    expect(r.reason).toBe('still-shared');
    expect(fs.existsSync(archive)).toBe(true);
  });

  it('14b · 查询后其它作品已删除（引用消失）→ 以执行时状态为准，视频被回收', () => {
    const store = makeStore({ works: [{ id: 'w1' }, { id: 'w2' }] });
    const archive = makeArchive(store, 'final-late2.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    store.upsertSettingKv('finalVideo:w2', archive);
    const M = loadMainFns({ store: store });

    const before = M.list('w1');
    expect(before.count).toBe(1);           // 弹窗时看到 1 个其它引用

    // 弹窗后 w2 被删 → 引用消失
    M.reclaim('w2');

    // 实际删除 w1：w2 已不在 → 视频可回收
    const r = M.reclaim('w1');
    expect(r.videoDeleted).toBe(true);
    expect(fs.existsSync(archive)).toBe(false);
  });

  it('未知作品 → 明确失败，不删任何文件', () => {
    const store = makeStore({ works: [{ id: 'w1' }] });
    const archive = makeArchive(store, 'final-x.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    const M = loadMainFns({ store: store });
    const r = M.reclaim('nope');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown-work');
    expect(r.workDeleted).toBe(false);
    expect(fs.existsSync(archive)).toBe(true);
  });
});

// =========================================================================
// B · 只读引用查询
// =========================================================================
describe('B1 · listWorkVideoReferences（只读）', () => {
  it('无映射 → hasVideo=false', () => {
    const store = makeStore();
    const M = loadMainFns({ store: store });
    const r = M.list('w1');
    expect(r.ok).toBe(true);
    expect(r.hasVideo).toBe(false);
    expect(r.count).toBe(0);
    expect(r.sharedWith).toEqual([]);
  });

  it('有两个其它作品引用 → count=2 且列出 ID', () => {
    const store = makeStore({ works: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] });
    const archive = makeArchive(store, 'final-q.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    store.upsertSettingKv('finalVideo:w2', archive);
    store.upsertSettingKv('finalVideo:w3', archive);
    const M = loadMainFns({ store: store });
    const r = M.list('w1');
    expect(r.hasVideo).toBe(true);
    expect(r.count).toBe(2);
    expect(r.sharedWith.sort()).toEqual(['w2', 'w3']);
    expect(r.draftReferenced).toBe(false);
  });

  it('草稿映射引用 → draftReferenced=true 且不计入 count', () => {
    const store = makeStore({ works: [{ id: 'w1' }] });
    const archive = makeArchive(store, 'final-d.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    store.upsertSettingKv('finalVideo:draft_abc_x1', archive);
    const M = loadMainFns({ store: store });
    const r = M.list('w1');
    expect(r.count).toBe(0);
    expect(r.draftReferenced).toBe(true);
  });

  it('路径写法不同但规范化后相同 → 判定为同一文件', () => {
    const store = makeStore({ works: [{ id: 'w1' }, { id: 'w2' }] });
    const archive = makeArchive(store, 'final-norm.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    // 同一文件的另一种写法（目录段带 .）
    const alt = path.join(path.dirname(archive), '.', path.basename(archive));
    store.upsertSettingKv('finalVideo:w2', alt);
    const M = loadMainFns({ store: store });
    const r = M.list('w1');
    expect(r.count).toBe(1);
    expect(r.sharedWith).toEqual(['w2']);
  });

  it('查询不修改任何数据或文件', () => {
    const store = makeStore({ works: [{ id: 'w1' }, { id: 'w2' }] });
    const archive = makeArchive(store, 'final-ro.mp4');
    store.upsertSettingKv('finalVideo:w1', archive);
    store.upsertSettingKv('finalVideo:w2', archive);
    const M = loadMainFns({ store: store });
    const before = JSON.stringify(store.kv);
    M.list('w1');
    expect(JSON.stringify(store.kv)).toBe(before);
    expect(store.listWorks()).toHaveLength(2);
    expect(fs.existsSync(archive)).toBe(true);
  });
});

// =========================================================================
// C · IPC 与 Renderer 接入
// =========================================================================
describe('C1 · IPC 通道', () => {
  it('main.js 注册了 works:final-video-refs 与 works:delete-with-video', () => {
    expect(MAIN_SRC).toMatch(/ipcMain\.handle\('works:final-video-refs'/);
    expect(MAIN_SRC).toMatch(/ipcMain\.handle\('works:delete-with-video'/);
  });

  it('preload 暴露 finalVideoRefs 与 deleteWithVideo', () => {
    expect(PRELOAD_SRC).toMatch(/finalVideoRefs:\s*\(workId\)\s*=>\s*ipcRenderer\.invoke\('works:final-video-refs'/);
    expect(PRELOAD_SRC).toMatch(/deleteWithVideo:\s*\(workId\)\s*=>\s*ipcRenderer\.invoke\('works:delete-with-video'/);
  });

  it('旧 works:delete 通道保留，store.deleteWork 返回语义不变', () => {
    // 旧通道仍在（works-crud-ipc.js 未改）
    const crud = fs.readFileSync(path.join(ROOT, 'electron', 'works-crud-ipc.js'), 'utf8');
    expect(crud).toMatch(/ipcMain\.handle\('works:delete', \(_e, id\) => getStore\(\)\.deleteWork\(id\)\)/);
    // store.deleteWork 仍然 return true
    const storeSrc = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8');
    const start = storeSrc.indexOf('deleteWork(id) {');
    const end = storeSrc.indexOf('// ---------- 发布记录 ----------', start);
    expect(storeSrc.slice(start, end)).toMatch(/return true;/);
  });

  it('store.js 仍然没有任何文件删除操作', () => {
    const storeSrc = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8');
    expect(storeSrc).not.toMatch(/unlinkSync|rmSync|rmdirSync|trashItem|fs\.rm\s*\(/);
  });
});

describe('C2 · Renderer 删除流程', () => {
  function delWorkSrc() {
    return extractFn(HTML_SRC, 'window.delWork=function(id){');
  }

  it('弹窗前调用 finalVideoRefs 查询引用情况', () => {
    const fn = delWorkSrc();
    expect(fn).toMatch(/finalVideoRefs/);
    expect(fn).toMatch(/confirmModal/);
    // 查询在弹窗之前
    expect(fn.indexOf('finalVideoRefs')).toBeLessThan(fn.indexOf('confirmModal'));
  });

  it('三种确认文案都存在', () => {
    const fn = delWorkSrc();
    // 还有其它作品引用 → 视频保留
    expect(fn).toMatch(/个作品正在使用该成品视频，删除本作品后视频会保留/);
    // 草稿引用 → 视频保留
    expect(fn).toMatch(/仍被一个进行中的草稿引用，删除本作品后视频会保留/);
    // 最后一个引用者 → 连同视频一起删
    expect(fn).toMatch(/其关联的成品视频也会一并删除/);
  });

  it('删除走 deleteWithVideo，失败时不提前移除作品', () => {
    const fn = delWorkSrc();
    expect(fn).toMatch(/deleteWithVideo/);
    // 失败分支：提示并 return，不执行内存清理
    const failAt = fn.indexOf("toast('删除失败：'");
    expect(failAt).toBeGreaterThan(0);
    const removeAt = fn.indexOf('state.works=state.works.filter');
    expect(removeAt).toBeGreaterThan(failAt);
  });

  it('已移除删除撤销功能（无备份 / 无撤销 toast action）', () => {
    const fn = delWorkSrc();
    expect(fn).not.toMatch(/_backup/);
    expect(fn).not.toMatch(/label:\s*'撤销'/);
    expect(fn).not.toMatch(/已恢复/);
  });

  it('15 · seedWorks() 静默删除不弹确认框', () => {
    const start = HTML_SRC.indexOf('dirtyIds.forEach(function(id){');
    expect(start).toBeGreaterThan(0);
    const end = HTML_SRC.indexOf('});', HTML_SRC.indexOf('catch(_e){}', start)) + 3;
    const block = HTML_SRC.slice(start, end);
    expect(block).toMatch(/deleteWithVideo/);
    // 静默路径里不允许出现确认框或普通用户删除提示
    expect(block).not.toMatch(/confirmModal/);
    expect(block).not.toMatch(/toast\(/);
  });

  it('其它撤销功能未被误删（发布记录撤回仍在）', () => {
    expect(HTML_SRC).toMatch(/window\.revokeManualMark=function\(id\)/);
    expect(HTML_SRC).toMatch(/onclick="unpub\(/);
  });
});
