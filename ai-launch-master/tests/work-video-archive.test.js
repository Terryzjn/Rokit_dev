// Rokit · 发布成功后归档最终成品视频（第三批）—— 定向测试
//
// 覆盖需求第九节的 12 个验证点：
//   1  从 temp/videos/final/ 成功归档到 work-videos/
//   2  归档成功后才写入作品映射
//   3  复制失败时不写映射、不删除源文件
//   4  映射写入失败时保留源文件
//   5  来源已在 work-videos/ 时直接复用
//   6  同名文件不覆盖
//   7  多个作品可以引用同一视频
//   8  GitHub 只有视频和文章都成功才归档
//   9  YouTube 只有 status:'ok' 才归档
//  10  归档失败不改变平台发布成功状态
//  11  重新打开作品时能够读回映射视频
//  12  无映射或文件失效时保持原有行为
//
// 全部使用**临时目录 + mock**，绝不创建生产 work-videos/ 目录，
// 不复制 / 移动 / 删除任何真实用户媒体。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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

// =========================================================================
// A · 主进程归档能力（electron/main.js 真实源码）
// =========================================================================

let ud = '';         // 临时 userData
let finalDir = '';   // <ud>/temp/videos/final
let workDir = '';    // <ud>/work-videos

beforeEach(function () {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-archive-'));
  finalDir = path.join(ud, 'temp', 'videos', 'final');
  workDir = path.join(ud, 'work-videos');
  fs.mkdirSync(finalDir, { recursive: true });
});

afterEach(function () {
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_e) {}
});

// 主进程函数集合：注入 app / fs / path / store / crypto 后执行**生产源码本体**
function loadArchiveFns(opts) {
  const o = opts || {};
  const src = [
    "const FINAL_VIDEO_KEY_PREFIX = 'finalVideo:';",
    // v1.22.7：诊断日志助手（被归档函数调用；不改变任何业务行为）
    "const WORK_VIDEO_DIAG_PREFIX = '[work-video-diagnostic]';",
    "var logger = { info: function(){}, warn: function(){}, error: function(){} };",
    extractFn(MAIN_SRC, 'function _workVideoDiag(stage, data) {'),
    extractFn(MAIN_SRC, 'function _workVideoDiagError(stage, data) {'),
    extractFn(MAIN_SRC, 'function managedFinalVideoRoots()'),
    extractFn(MAIN_SRC, 'function isInsideManagedFinalDir(resolvedPath, roots)'),
    extractFn(MAIN_SRC, 'function resolveFinalVideoFile(filePath)'),
    extractFn(MAIN_SRC, 'function normalizeVideoOwnerId(workId)'),
    extractFn(MAIN_SRC, 'function workVideosDir()'),
    extractFn(MAIN_SRC, 'function _fileSha256(filePath)'),
    extractFn(MAIN_SRC, 'function _findArchivedBySha256(sha, dir, srcSize)'),
    extractFn(MAIN_SRC, 'function _uniqueArchivePath(dir, fileName)'),
    extractFn(MAIN_SRC, 'function archiveFinalVideoForWork(workId, videoPath)'),
    extractFn(MAIN_SRC, 'function releaseDraftFinalVideoMapping(draftOwner, workId, expectedPath)')
  ].join('\n');

  const factory = new Function(
    'app', 'fs', 'path', 'store', 'crypto',
    src + '\nreturn { archiveFinalVideoForWork: archiveFinalVideoForWork, releaseDraftFinalVideoMapping: releaseDraftFinalVideoMapping, _fileSha256: _fileSha256 };'
  );
  return factory(
    { getPath: function () { return ud; } },
    o.fs || fs,
    path,
    o.store,
    o.crypto || crypto
  );
}

// 简单的 settings_kv mock
function makeStore(opts) {
  const o = opts || {};
  const kv = Object.assign({}, o.kv || {});
  return {
    kv: kv,
    listWorks: function () {
      return o.works || [{ id: 'w1' }, { id: 'w2' }];
    },
    getSettingKv: function (k) {
      return kv[k] === undefined ? null : kv[k];
    },
    upsertSettingKv: function (k, v) {
      if (o.failUpsert) throw new Error('模拟映射写入失败');
      kv[k] = String(v);
      return true;
    },
    deleteSettingKv: function (k) {
      if (o.failDelete) throw new Error('模拟映射删除失败');
      delete kv[k];
      return { ok: true, key: k };
    },
    _listSettingKv: function (prefix) {
      const p = String(prefix || '');
      if (!p) return [];
      return Object.keys(kv)
        .filter(function (k) { return k.indexOf(p) === 0; })
        .map(function (k) { return { k: k, v: kv[k] }; });
    }
  };
}

// 造一个非空假 MP4
function makeMp4(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(body || 'fake-mp4-bytes-' + name));
  return p;
}

describe('A1 · 归档到 work-videos/（主进程真实源码）', () => {
  it('1 · 从 temp/videos/final/ 成功归档到 work-videos/，并写回映射', () => {
    const src = makeMp4(finalDir, 'final-abc.mp4', 'video-bytes');
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });

    const r = archiveFinalVideoForWork('w1', src);
    expect(r.ok).toBe(true);
    expect(r.copied).toBe(true);
    // 目标位于受管归档目录
    expect(path.dirname(r.path)).toBe(path.resolve(workDir));
    // 目标文件真实存在且内容一致
    expect(fs.existsSync(r.path)).toBe(true);
    expect(fs.readFileSync(r.path, 'utf8')).toBe('video-bytes');
    // 源文件保留（不删除 temp/videos/final/ 里的源）
    expect(fs.existsSync(src)).toBe(true);
    // 映射指向归档后的路径
    expect(store.getSettingKv('finalVideo:w1')).toBe(r.path);
  });

  it('2 · 映射只在归档校验通过后才写入（复制失败时映射保持为空）', () => {
    const src = makeMp4(finalDir, 'final-x.mp4', 'bytes');
    const store = makeStore();
    // 复制失败
    const brokenFs = Object.assign({}, fs, {
      copyFileSync: function () { throw new Error('EACCES 模拟复制失败'); }
    });
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store, fs: brokenFs });
    const r = archiveFinalVideoForWork('w1', src);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('archive-copy-failed');
    // 没有映射
    expect(store.getSettingKv('finalVideo:w1')).toBeFalsy();
  });

  it('3 · 复制失败：不写映射、不删除源文件', () => {
    const src = makeMp4(finalDir, 'final-y.mp4', 'bytes');
    const store = makeStore();
    const brokenFs = Object.assign({}, fs, {
      copyFileSync: function () { throw new Error('模拟复制失败'); }
    });
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store, fs: brokenFs });
    const r = archiveFinalVideoForWork('w1', src);
    expect(r.ok).toBe(false);
    expect(store.getSettingKv('finalVideo:w1')).toBeFalsy();
    // 源文件必须还在
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.readFileSync(src, 'utf8')).toBe('bytes');
  });

  it('4 · 映射写入失败时保留源文件（且不建立无效映射）', () => {
    const src = makeMp4(finalDir, 'final-z.mp4', 'bytes');
    const store = makeStore({ failUpsert: true });
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });
    const r = archiveFinalVideoForWork('w1', src);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('archive-map-failed');
    // 源文件保留
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.readFileSync(src, 'utf8')).toBe('bytes');
    // 没有写入映射
    expect(store.getSettingKv('finalVideo:w1')).toBeFalsy();
  });

  it('5 · 来源已在 work-videos/ 时直接复用该路径（不复制到自身）', () => {
    fs.mkdirSync(workDir, { recursive: true });
    const already = makeMp4(workDir, 'already-archived.mp4', 'archived');
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });
    const r = archiveFinalVideoForWork('w1', already);
    expect(r.ok).toBe(true);
    expect(r.copied).toBe(false);
    expect(r.reused).toBe(true);
    expect(r.path).toBe(path.resolve(already));
    // 目录里没有多出副本
    expect(fs.readdirSync(workDir)).toEqual(['already-archived.mp4']);
    expect(store.getSettingKv('finalVideo:w1')).toBe(path.resolve(already));
  });

  it('6 · 同名文件不覆盖（已有文件保持原样，归档另起文件名）', () => {
    fs.mkdirSync(workDir, { recursive: true });
    const existing = makeMp4(workDir, 'final-dup.mp4', 'OLD-CONTENT');
    const src = makeMp4(finalDir, 'final-dup.mp4', 'NEW-CONTENT');
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });
    const r = archiveFinalVideoForWork('w1', src);
    expect(r.ok).toBe(true);
    // 旧文件内容未被覆盖
    expect(fs.readFileSync(existing, 'utf8')).toBe('OLD-CONTENT');
    // 新归档落在另一个文件名
    expect(path.dirname(r.path)).toBe(path.resolve(workDir));
    expect(path.basename(r.path)).not.toBe('final-dup.mp4');
    expect(fs.readFileSync(r.path, 'utf8')).toBe('NEW-CONTENT');
  });

  it('7 · 多个作品可以引用同一个视频（映射各自独立、互不覆盖、文件不被删）', () => {
    fs.mkdirSync(workDir, { recursive: true });
    const shared = makeMp4(workDir, 'shared.mp4', 'shared-bytes');
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });

    const a = archiveFinalVideoForWork('w1', shared);
    const b = archiveFinalVideoForWork('w2', shared);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // 两个作品指向同一个文件
    expect(a.path).toBe(b.path);
    expect(store.getSettingKv('finalVideo:w1')).toBe(a.path);
    expect(store.getSettingKv('finalVideo:w2')).toBe(b.path);
    // 共享文件仍然存在（没有因为 workId 不同被删除）
    expect(fs.existsSync(shared)).toBe(true);
    expect(fs.readFileSync(shared, 'utf8')).toBe('shared-bytes');
  });

  it('7b · 同一源视频分别归档给两个作品时：源文件保留、两份归档指向同一文件（v1.22.5 内容去重）', () => {
    const src = makeMp4(finalDir, 'same-source.mp4', 'same');
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });
    const a = archiveFinalVideoForWork('w1', src);
    const b = archiveFinalVideoForWork('w2', src);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // 内容相同 → 复用同一份归档，不产生第二份副本
    expect(a.path).toBe(b.path);
    expect(b.copied).toBe(false);
    expect(b.deduplicated).toBe(true);
    // 归档目录里只有一份
    expect(fs.readdirSync(workDir)).toHaveLength(1);
    // 源文件保留
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.readFileSync(a.path, 'utf8')).toBe('same');
    // 两个作品各自写自己的映射，都指向同一归档路径
    expect(store.getSettingKv('finalVideo:w1')).toBe(a.path);
    expect(store.getSettingKv('finalVideo:w2')).toBe(b.path);
  });

  it('拒绝外部路径（不在受管目录内的文件不能被归档）', () => {
    const outside = makeMp4(os.tmpdir(), 'rokit-outside-' + Date.now() + '.mp4', 'x');
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });
    try {
      const r = archiveFinalVideoForWork('w1', outside);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('path-not-allowed');
      expect(store.getSettingKv('finalVideo:w1')).toBeFalsy();
    } finally {
      try { fs.unlinkSync(outside); } catch (_e) {}
    }
  });
});

// =========================================================================
// A1b · 内容去重（SHA-256）：同一份成品视频只归档一次
// =========================================================================
describe('A1b · 视频内容去重（SHA-256）', () => {
  it('D1 · 同一个临时源视频为两个作品归档，只生成一份归档文件', () => {
    const src = makeMp4(finalDir, 'final-shared.mp4', 'SHARED-BYTES');
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });

    const a = archiveFinalVideoForWork('w1', src);
    const b = archiveFinalVideoForWork('w2', src);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.path).toBe(b.path);
    // 归档目录里只有一份文件
    expect(fs.readdirSync(workDir)).toHaveLength(1);
    expect(fs.readdirSync(workDir)[0]).toBe('final-shared.mp4');
  });

  it('D2 · 同一作品 GitHub、YouTube 连续归档同一视频，只生成一份归档文件', () => {
    const src = makeMp4(finalDir, 'final-rocket.mp4', 'ROCKET-BYTES');
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });

    const gh = archiveFinalVideoForWork('w1', src);       // GitHub 成功
    const yt = archiveFinalVideoForWork('w1', src);       // YouTube 成功
    expect(gh.ok).toBe(true);
    expect(yt.ok).toBe(true);
    expect(gh.path).toBe(yt.path);
    expect(yt.copied).toBe(false);
    expect(yt.deduplicated).toBe(true);
    // 只有一份文件，没有 -1 副本
    expect(fs.readdirSync(workDir)).toEqual(['final-rocket.mp4']);
  });

  it('D3 · 两个不同路径但内容完全相同的视频，能够复用同一归档文件', () => {
    const srcA = makeMp4(finalDir, 'final-a.mp4', 'IDENTICAL-BYTES');
    const srcB = makeMp4(finalDir, 'final-b.mp4', 'IDENTICAL-BYTES');   // 同内容、不同文件名
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });

    const a = archiveFinalVideoForWork('w1', srcA);
    const b = archiveFinalVideoForWork('w2', srcB);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // 内容相同 → 复用
    expect(a.path).toBe(b.path);
    expect(fs.readdirSync(workDir)).toHaveLength(1);
    // 两个源文件都保留
    expect(fs.existsSync(srcA)).toBe(true);
    expect(fs.existsSync(srcB)).toBe(true);
  });

  it('D4 · 内容不同的视频即使大小相同，也不能错误复用', () => {
    const srcA = makeMp4(finalDir, 'final-same-size-a.mp4', 'AAAA');   // 4 字节
    const srcB = makeMp4(finalDir, 'final-same-size-b.mp4', 'BBBB');   // 4 字节，内容不同
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });

    const a = archiveFinalVideoForWork('w1', srcA);
    const b = archiveFinalVideoForWork('w2', srcB);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // 大小相同但内容不同 → 必须生成两份，绝不错误复用
    expect(a.path).not.toBe(b.path);
    expect(b.deduplicated).toBe(false);
    expect(fs.readdirSync(workDir)).toHaveLength(2);
    expect(fs.readFileSync(a.path, 'utf8')).toBe('AAAA');
    expect(fs.readFileSync(b.path, 'utf8')).toBe('BBBB');
  });

  it('D5 · SHA-256 计算失败时不写映射、不删除源文件', () => {
    const src = makeMp4(finalDir, 'final-hash-fail.mp4', 'bytes');
    const store = makeStore();
    // 让 openSync 抛错 → 指纹算不出来
    const brokenFs = Object.assign({}, fs, {
      openSync: function () { throw new Error('模拟打开文件失败'); }
    });
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store, fs: brokenFs });
    const r = archiveFinalVideoForWork('w1', src);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('archive-hash-failed');
    // 没有写映射
    expect(store.getSettingKv('finalVideo:w1')).toBeFalsy();
    // 源文件保留
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.readFileSync(src, 'utf8')).toBe('bytes');
  });

  it('D6 · 复用已有归档文件时正确写入新作品映射', () => {
    const src = makeMp4(finalDir, 'final-reuse.mp4', 'REUSE-BYTES');
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });

    const a = archiveFinalVideoForWork('w1', src);
    const b = archiveFinalVideoForWork('w2', src);
    // w2 的映射指向 w1 已归档的同一个文件
    expect(store.getSettingKv('finalVideo:w2')).toBe(a.path);
    expect(store.getSettingKv('finalVideo:w1')).toBe(a.path);
    // 既有文件没有被覆盖 / 删除
    expect(fs.readFileSync(a.path, 'utf8')).toBe('REUSE-BYTES');
    expect(fs.readdirSync(workDir)).toHaveLength(1);
  });

  it('D7 · 去重不复用位于 work-videos/ 之外的历史文件', () => {
    // 某个映射指向受管目录之外的文件 → 不参与去重，也不被复用
    const outside = makeMp4(os.tmpdir(), 'rokit-outside-dedup-' + Date.now() + '.mp4', 'SAME');
    const src = makeMp4(finalDir, 'final-dedup.mp4', 'SAME');
    const store = makeStore({ kv: { 'finalVideo:w9': outside } });
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });
    try {
      const r = archiveFinalVideoForWork('w1', src);
      expect(r.ok).toBe(true);
      // 没有复用目录外的文件，而是正常复制进 work-videos/
      expect(path.dirname(r.path)).toBe(path.resolve(workDir));
      expect(fs.readdirSync(workDir)).toHaveLength(1);
    } finally {
      try { fs.unlinkSync(outside); } catch (_e) {}
    }
  });

  it('D8 · 去重只看映射里引用的归档，不扫描目录里的历史孤儿文件', () => {
    // work-videos/ 里已有一个内容相同、但**没有任何映射**的文件 → 不复用
    fs.mkdirSync(workDir, { recursive: true });
    makeMp4(workDir, 'orphan.mp4', 'ORPHAN-BYTES');
    const src = makeMp4(finalDir, 'final-orphan.mp4', 'ORPHAN-BYTES');
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });
    const r = archiveFinalVideoForWork('w1', src);
    expect(r.ok).toBe(true);
    expect(r.deduplicated).toBe(false);
    // 孤儿文件仍在（没有删除），另生成一份新归档
    expect(fs.readdirSync(workDir)).toHaveLength(2);
    expect(fs.existsSync(path.join(workDir, 'orphan.mp4'))).toBe(true);
  });

  it('D9 · 源文件已在 work-videos/ 内时直接复用（不参与内容去重）', () => {
    fs.mkdirSync(workDir, { recursive: true });
    const already = makeMp4(workDir, 'already.mp4', 'ALREADY');
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns({ store: store });
    const r = archiveFinalVideoForWork('w1', already);
    expect(r.ok).toBe(true);
    expect(r.copied).toBe(false);
    expect(r.reused).toBe(true);
    expect(fs.readdirSync(workDir)).toEqual(['already.mp4']);
  });

  it('D10 · SHA-256 用流式读取，且与一次性读取结果一致', () => {
    const big = path.join(finalDir, 'final-big.mp4');
    // 造一个跨 1MB 分块边界的大文件
    fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 12345, 0x41));
    const store = makeStore();
    const { _fileSha256 } = loadArchiveFns({ store: store });
    const expected = crypto.createHash('sha256').update(fs.readFileSync(big)).digest('hex');
    expect(_fileSha256(big)).toBe(expected);
  });
});

// =========================================================================
// A3 · 草稿映射释放 IPC（只删草稿键）
// =========================================================================
describe('A3 · 草稿映射释放（releaseDraftFinalVideoMapping）', () => {
  const DRAFT = 'draft_abc123_x9';

  it('R1 · 补挂成功后删除对应草稿映射（只删键，不删文件）', () => {
    const store = makeStore({
      kv: {
        ['finalVideo:' + DRAFT]: 'C:/ud/work-videos/final-1.mp4',
        'finalVideo:w1': 'C:/ud/work-videos/final-1.mp4'
      }
    });
    const { releaseDraftFinalVideoMapping } = loadArchiveFns({ store: store });
    const r = releaseDraftFinalVideoMapping(DRAFT, 'w1', 'C:/ud/work-videos/final-1.mp4');
    expect(r.ok).toBe(true);
    expect(r.released).toBe(true);
    // 草稿键已删除，真实作品映射保留
    expect(store.getSettingKv('finalVideo:' + DRAFT)).toBeFalsy();
    expect(store.getSettingKv('finalVideo:w1')).toBe('C:/ud/work-videos/final-1.mp4');
  });

  it('R2 · 目标映射路径不匹配时保留草稿映射', () => {
    const store = makeStore({
      kv: {
        ['finalVideo:' + DRAFT]: 'C:/ud/work-videos/final-1.mp4',
        'finalVideo:w1': 'C:/ud/work-videos/OTHER.mp4'
      }
    });
    const { releaseDraftFinalVideoMapping } = loadArchiveFns({ store: store });
    const r = releaseDraftFinalVideoMapping(DRAFT, 'w1', 'C:/ud/work-videos/final-1.mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('target-path-mismatch');
    // 草稿映射保留
    expect(store.getSettingKv('finalVideo:' + DRAFT)).toBe('C:/ud/work-videos/final-1.mp4');
  });

  it('R3 · 目标映射不存在时保留草稿映射', () => {
    const store = makeStore({ kv: { ['finalVideo:' + DRAFT]: 'C:/ud/work-videos/final-1.mp4' } });
    const { releaseDraftFinalVideoMapping } = loadArchiveFns({ store: store });
    const r = releaseDraftFinalVideoMapping(DRAFT, 'w1', 'C:/ud/work-videos/final-1.mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-target-mapping');
    expect(store.getSettingKv('finalVideo:' + DRAFT)).toBe('C:/ud/work-videos/final-1.mp4');
  });

  it('R4 · 真实作品 ID 不允许通过草稿释放 IPC 删除', () => {
    const store = makeStore({
      kv: { 'finalVideo:w1': 'C:/ud/work-videos/final-1.mp4' }
    });
    const { releaseDraftFinalVideoMapping } = loadArchiveFns({ store: store });
    // 把真实作品 ID 当作草稿传入 → 必须拒绝
    const r = releaseDraftFinalVideoMapping('w1', 'w1', 'C:/ud/work-videos/final-1.mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not-a-draft-owner');
    // 真实作品映射仍在
    expect(store.getSettingKv('finalVideo:w1')).toBe('C:/ud/work-videos/final-1.mp4');
  });

  it('R5 · 非法草稿 ID 格式被拒绝', () => {
    const store = makeStore({ kv: { 'finalVideo:w1': 'C:/ud/work-videos/final-1.mp4' } });
    const { releaseDraftFinalVideoMapping } = loadArchiveFns({ store: store });
    expect(releaseDraftFinalVideoMapping('w1', 'w1', 'x').ok).toBe(false);
    expect(releaseDraftFinalVideoMapping('DRAFT_bad', 'w1', 'x').ok).toBe(false);
    expect(releaseDraftFinalVideoMapping('draft_', 'w1', 'x').ok).toBe(false);
    expect(releaseDraftFinalVideoMapping('', 'w1', 'x').error).toBe('missing-draft-owner');
    // 真实作品映射未被动
    expect(store.getSettingKv('finalVideo:w1')).toBe('C:/ud/work-videos/final-1.mp4');
  });

  it('R6 · workId 本身是草稿时拒绝', () => {
    const store = makeStore({ kv: { ['finalVideo:' + DRAFT]: 'C:/ud/work-videos/final-1.mp4' } });
    const { releaseDraftFinalVideoMapping } = loadArchiveFns({ store: store });
    const r = releaseDraftFinalVideoMapping(DRAFT, DRAFT, 'C:/ud/work-videos/final-1.mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('work-id-is-draft');
    expect(store.getSettingKv('finalVideo:' + DRAFT)).toBe('C:/ud/work-videos/final-1.mp4');
  });

  it('R7 · 删除失败时保留草稿映射', () => {
    const store = makeStore({
      failDelete: true,
      kv: {
        ['finalVideo:' + DRAFT]: 'C:/ud/work-videos/final-1.mp4',
        'finalVideo:w1': 'C:/ud/work-videos/final-1.mp4'
      }
    });
    const { releaseDraftFinalVideoMapping } = loadArchiveFns({ store: store });
    const r = releaseDraftFinalVideoMapping(DRAFT, 'w1', 'C:/ud/work-videos/final-1.mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('draft-release-failed');
    // 草稿映射保留
    expect(store.getSettingKv('finalVideo:' + DRAFT)).toBe('C:/ud/work-videos/final-1.mp4');
  });

  it('R8 · 草稿映射本来就不存在时视为已释放（幂等）', () => {
    const store = makeStore({ kv: { 'finalVideo:w1': 'C:/ud/work-videos/final-1.mp4' } });
    const { releaseDraftFinalVideoMapping } = loadArchiveFns({ store: store });
    const r = releaseDraftFinalVideoMapping(DRAFT, 'w1', 'C:/ud/work-videos/final-1.mp4');
    expect(r.ok).toBe(true);
    expect(r.released).toBe(false);
  });

  it('R9 · IPC 通道已注册，preload 已暴露', () => {
    expect(MAIN_SRC).toMatch(/ipcMain\.handle\('work-video:release-draft-mapping'/);
    expect(PRELOAD_SRC).toMatch(/workVideoReleaseDraftMapping:\s*\(draftOwner, workId, expectedPath\)/);
  });
});

describe('A2 · 归档 IPC 通道（独立于 markPub / 发布链路）', () => {
  it('main.js 注册了独立的 work-video:archive 通道', () => {
    expect(MAIN_SRC).toMatch(/ipcMain\.handle\('work-video:archive'/);
    expect(MAIN_SRC).toMatch(/archiveFinalVideoForWork\(workId, videoPath\)/);
  });

  it('preload 暴露 workVideoArchive', () => {
    expect(PRELOAD_SRC).toMatch(/workVideoArchive:\s*\(workId, videoPath\)\s*=>\s*ipcRenderer\.invoke\('work-video:archive'/);
  });

  it('归档逻辑没有塞进 markPub（markPub 不含归档调用）', () => {
    const markPub = extractFn(HTML_SRC, 'window.markPub=function(id){');
    expect(markPub).not.toMatch(/workVideoArchive/);
    expect(markPub).not.toMatch(/_archiveFinalVideoAfterPublish/);
  });
});

// =========================================================================
// B · 渲染层触发条件（index.html 真实源码）
// =========================================================================

// 从 index.html 切出渲染层辅助函数
function loadRendererFns() {
  const src = [
    extractFn(HTML_SRC, 'function _curVideoOwnerKey(){'),
    // v1.22.7：诊断日志助手（被上面的函数调用；不改变任何业务行为）
    extractFn(HTML_SRC, 'function _workVideoDiag(stage, data){'),
    extractFn(HTML_SRC, 'function _archiveFinalVideoAfterPublish(videoPath, ownerKey){'),
    extractFn(HTML_SRC, 'function _rebindArchiveToSettledWork(workId, fromOwner){'),
    extractFn(HTML_SRC, 'function _releaseDraftMappingAfterRebind(draftOwner, workId, expectedPath, archiveResult){'),
    extractFn(HTML_SRC, 'function _restoreFinalVideoForWork(workId){')
  ].join('\n');
  const factory = new Function(
    'window', 'state', 'toast', 'console',
    src + '\nreturn { archive: _archiveFinalVideoAfterPublish, rebind: _rebindArchiveToSettledWork, release: _releaseDraftMappingAfterRebind, restore: _restoreFinalVideoForWork, owner: _curVideoOwnerKey };'
  );
  return factory;
}

// 渲染层运行环境
function makeRendererEnv(opts) {
  const o = opts || {};
  const calls = { archive: [], toasts: [], get: [], release: [] };
  const state = o.state || { planOwnerId: 'w1', curWork: 'w1' };
  const win = {
    api: {
      workVideoArchive: function (workId, videoPath) {
        calls.archive.push({ workId: workId, videoPath: videoPath });
        return o.archiveResult !== undefined
          ? Promise.resolve(o.archiveResult)
          : Promise.resolve({ ok: true, path: videoPath });
      },
      planGetFinalVideo: function (id) {
        calls.get.push(id);
        return o.getResult !== undefined
          ? Promise.resolve(o.getResult)
          : Promise.resolve({ ok: false, error: 'no-final-video' });
      },
      workVideoReleaseDraftMapping: function (draftOwner, workId, expectedPath) {
        calls.release.push({ draftOwner: draftOwner, workId: workId, expectedPath: expectedPath });
        return Promise.resolve({ ok: true, released: true });
      }
    }
  };
  const toast = function (m, level) { calls.toasts.push({ m: m, level: level }); };
  const quietConsole = { log: function () {}, warn: function () {}, error: function () {} };
  const api = loadRendererFns()(win, state, toast, quietConsole);
  return { api: api, calls: calls, state: state, win: win };
}

describe('B1 · 渲染层归档辅助函数', () => {
  it('归档失败只提示，不抛错、不改写任何发布结果', async () => {
    const env = makeRendererEnv({ archiveResult: { ok: false, error: 'archive-copy-failed', detail: '磁盘写入失败' } });
    const r = await env.api.archive('C:/rokit/final/final-1.mp4');
    expect(r.ok).toBe(false);
    expect(env.calls.toasts.length).toBe(1);
    expect(String(env.calls.toasts[0].m)).toMatch(/归档失败/);
  });

  it('归档成功时不弹失败提示', async () => {
    const env = makeRendererEnv();
    const r = await env.api.archive('C:/rokit/final/final-1.mp4');
    expect(r.ok).toBe(true);
    expect(env.calls.toasts.length).toBe(0);
    // 传入的作品 ID 与本次使用的成品视频路径
    expect(env.calls.archive[0].workId).toBe('w1');
    expect(env.calls.archive[0].videoPath).toBe('C:/rokit/final/final-1.mp4');
  });

  it('没有归属（作品与草稿都没有）时不发起归档', async () => {
    const env = makeRendererEnv({ state: { planOwnerId: '', curWork: '' } });
    const r = await env.api.archive('C:/rokit/final/final-1.mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-owner');
    expect(env.calls.archive.length).toBe(0);
  });
});

describe('B1b · 作品落库后把归档改挂到真实作品 ID', () => {
  it('草稿归属 → 真实作品 ID：目标尚无映射时按真实 ID 再归档一次（复用已归档路径）', async () => {
    const env = makeRendererEnv({ state: { planOwnerId: 'draft_abc', curWork: '' } });
    // 第一次归档落在草稿归属上，返回归档后的路径
    env.win.api.workVideoArchive = function (workId, videoPath) {
      env.calls.archive.push({ workId: workId, videoPath: videoPath });
      return Promise.resolve({ ok: true, path: 'C:/rokit/work-videos/final-1.mp4' });
    };
    await env.api.archive('C:/rokit/final/final-1.mp4');
    expect(env.calls.archive[0].workId).toBe('draft_abc');
    // 作品落库后：目标作品还没有映射 → 改挂
    env.win.api.planGetFinalVideo = function (id) {
      env.calls.get.push(id);
      return Promise.resolve({ ok: false, error: 'no-final-video' });
    };
    env.api.rebind('w1', 'draft_abc');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(env.calls.get).toContain('w1');
    expect(env.calls.archive.length).toBe(2);
    expect(env.calls.archive[1].workId).toBe('w1');
    // 复用已归档路径（主进程会直接复用，不复制到自身）
    expect(env.calls.archive[1].videoPath).toBe('C:/rokit/work-videos/final-1.mp4');
  });

  it('目标作品已有映射（迁移已处理）→ 不重复归档', async () => {
    const env = makeRendererEnv({ state: { planOwnerId: 'draft_abc', curWork: '' } });
    await env.api.archive('C:/rokit/final/final-1.mp4');
    env.win.api.planGetFinalVideo = function (id) {
      env.calls.get.push(id);
      return Promise.resolve({ ok: true, workId: id, path: 'C:/rokit/work-videos/final-1.mp4' });
    };
    env.api.rebind('w1', 'draft_abc');
    await Promise.resolve();
    await Promise.resolve();
    expect(env.calls.archive.length).toBe(1);   // 没有第二次归档
  });

  it('归档归属不是本次迁移的来源 → 不改挂（绝不串作品）', async () => {
    const env = makeRendererEnv({ state: { planOwnerId: 'draft_abc', curWork: '' } });
    await env.api.archive('C:/rokit/final/final-1.mp4');
    env.win.api.planGetFinalVideo = function (id) {
      env.calls.get.push(id);
      return Promise.resolve({ ok: false, error: 'no-final-video' });
    };
    // 本轮迁移的来源是另一个草稿 → 与归档归属不符 → 什么都不做
    env.api.rebind('w1', 'draft_other');
    await Promise.resolve();
    await Promise.resolve();
    expect(env.calls.get.length).toBe(0);
    expect(env.calls.archive.length).toBe(1);
  });

  it('fromOwner 为空 → 不补挂（归属来源不明，绝不猜）', async () => {
    const env = makeRendererEnv({ state: { planOwnerId: 'draft_abc', curWork: '' } });
    await env.api.archive('C:/rokit/final/final-1.mp4');
    env.win.api.planGetFinalVideo = function (id) {
      env.calls.get.push(id);
      return Promise.resolve({ ok: false, error: 'no-final-video' });
    };
    env.api.rebind('w1', '');
    await Promise.resolve();
    await Promise.resolve();
    expect(env.calls.get.length).toBe(0);
    expect(env.calls.archive.length).toBe(1);
    expect(env.calls.release.length).toBe(0);
  });

  it('last.path 为空 → 不回退到临时源路径，也不复制', async () => {
    const env = makeRendererEnv({ state: { planOwnerId: 'draft_abc', curWork: '' } });
    // 归档成功但主进程没有返回 path
    env.win.api.workVideoArchive = function (workId, videoPath) {
      env.calls.archive.push({ workId: workId, videoPath: videoPath });
      return Promise.resolve({ ok: true });        // 没有 path
    };
    await env.api.archive('C:/rokit/final/final-1.mp4');
    env.win.api.planGetFinalVideo = function (id) {
      env.calls.get.push(id);
      return Promise.resolve({ ok: false, error: 'no-final-video' });
    };
    env.api.rebind('w1', 'draft_abc');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // 不得用临时源路径再归档一次
    expect(env.calls.archive.length).toBe(1);
    expect(env.calls.archive[0].workId).toBe('draft_abc');
    expect(env.calls.release.length).toBe(0);
  });

  it('补挂成功后释放草稿映射', async () => {
    const env = makeRendererEnv({ state: { planOwnerId: 'draft_abc', curWork: '' } });
    env.win.api.workVideoArchive = function (workId, videoPath) {
      env.calls.archive.push({ workId: workId, videoPath: videoPath });
      return Promise.resolve({ ok: true, path: 'C:/rokit/work-videos/final-1.mp4' });
    };
    await env.api.archive('C:/rokit/final/final-1.mp4');
    // 目标作品还没有映射 → 补挂
    env.win.api.planGetFinalVideo = function (id) {
      env.calls.get.push(id);
      // 第一次查（补挂前）：无映射；第二次查（释放前）：已有映射且路径一致
      if (env.calls.get.filter(function (x) { return x === id; }).length === 1) {
        return Promise.resolve({ ok: false, error: 'no-final-video' });
      }
      return Promise.resolve({ ok: true, workId: id, path: 'C:/rokit/work-videos/final-1.mp4' });
    };
    env.win.api.workVideoReleaseDraftMapping = function (draftOwner, workId, expectedPath) {
      env.calls.release.push({ draftOwner: draftOwner, workId: workId, expectedPath: expectedPath });
      return Promise.resolve({ ok: true, released: true });
    };
    env.api.rebind('w1', 'draft_abc');
    for (let i = 0; i < 8; i++) await Promise.resolve();
    // 释放调用：草稿归属 + 真实作品 ID + 预期归档路径
    expect(env.calls.release.length).toBe(1);
    expect(env.calls.release[0].draftOwner).toBe('draft_abc');
    expect(env.calls.release[0].workId).toBe('w1');
    expect(env.calls.release[0].expectedPath).toBe('C:/rokit/work-videos/final-1.mp4');
  });

  it('补挂失败 → 保留草稿映射与视频文件（不调用释放 IPC）', async () => {
    const env = makeRendererEnv({ state: { planOwnerId: 'draft_abc', curWork: '' } });
    env.win.api.workVideoArchive = function (workId, videoPath) {
      env.calls.archive.push({ workId: workId, videoPath: videoPath });
      if (workId === 'draft_abc') {
        return Promise.resolve({ ok: true, path: 'C:/rokit/work-videos/final-1.mp4' });
      }
      // 补挂失败
      return Promise.resolve({ ok: false, error: 'archive-copy-failed', detail: '复制失败' });
    };
    await env.api.archive('C:/rokit/final/final-1.mp4');
    env.win.api.planGetFinalVideo = function (id) {
      env.calls.get.push(id);
      return Promise.resolve({ ok: false, error: 'no-final-video' });
    };
    env.win.api.workVideoReleaseDraftMapping = function () {
      env.calls.release.push({});
      return Promise.resolve({ ok: true });
    };
    env.api.rebind('w1', 'draft_abc');
    for (let i = 0; i < 8; i++) await Promise.resolve();
    // 补挂失败 → 没有释放
    expect(env.calls.release.length).toBe(0);
    // 归档调用了两次（草稿 + 失败的补挂）
    expect(env.calls.archive.length).toBe(2);
  });

  it('launch() 在计划归属链落定后调用改挂逻辑，并带上本轮来源归属', () => {
    const fn = extractFn(HTML_SRC, 'window.launch=function(){');
    expect(fn).toMatch(/_rebindArchiveToSettledWork\(w\.id,\s*_planFrom\)/);
  });
});

// ---------- 8 · GitHub：视频 + 文章都成功才归档 ----------
// 抽取 autoPubGithub（单发）与火箭队列的 github 分支，在沙箱里执行真实源码

// 通用沙箱：把生产源码片段放进一个 async IIFE，注入依赖后执行
function runSnippet(code, deps) {
  const names = Object.keys(deps);
  const vals = names.map(function (n) { return deps[n]; });
  // v1.22.7：诊断日志助手（发布成功调用点会调用它；不改变任何业务行为）
  const diagHelper = extractFn(HTML_SRC, 'function _workVideoDiag(stage, data){');
  const body = 'return (async function(){\n' + diagHelper + '\n' + code + '\n})();';
  const factory = Reflect.construct(Function, names.concat([body]));
  return factory.apply(null, vals);
}

// GitHub 相关的公共辅助函数（页面状态文案）
const GH_HELPERS = [
  extractFn(HTML_SRC, 'function githubPagesLive(pages){'),
  extractFn(HTML_SRC, 'function githubPagesStatusText(r){'),
  extractFn(HTML_SRC, 'function githubVideoFailureText(r){')
].join('\n');

function makeGithubDeps(opts) {
  const o = opts || {};
  const calls = { archive: [], pubs: [], toasts: [] };
  const state = {
    copies: { github: { title: '标题', body: '正文' } },
    project: { name: 'Demo', intro: '简介' },
    __captionFinalVideo: { path: 'C:/rokit/final/final-1.mp4' }
  };
  const win = {
    publishGithubVideo: function () {
      calls.video = o.videoResult || { ok: true, video: { videoPath: 'videos/demo.mp4' } };
      return Promise.resolve(calls.video);
    },
    publishGithubPages: function () { return Promise.resolve(o.pagesResult || { ok: true, pages: null }); },
    buildGithubArticleBody: function (b) { return b; },
    api: {
      githubPutFile: function () {
        return Promise.resolve(o.putResult !== undefined ? o.putResult : { ok: true, content: { html_url: 'https://gh/x' } });
      }
    }
  };
  return {
    calls: calls,
    state: state,
    win: win,
    deps: {
      window: win,
      state: state,
      genCopy: function () { return null; },
      buildArticlePath: function () { return 'posts/demo.md'; },
      toast: function (m) { calls.toasts.push(m); },
      markPub: function (pid, r) { calls.pubs.push({ pid: pid, r: r }); },
      esc: function (s) { return String(s); },
      pf: function () { return { name: 'GitHub' }; },
      githubPagesLive: function (p) { return !!p && p.deployStatus === 'built'; },
      githubPagesStatusText: function () { return '网页状态'; },
      githubVideoFailureText: function () { return '视频失败'; },
      _archiveFinalVideoAfterPublish: function (p) {
        calls.archive.push(p);
        return o.archiveFails ? Promise.reject(new Error('归档异常')) : Promise.resolve({ ok: true });
      }
    }
  };
}

describe('B2 · GitHub 归档触发条件', () => {
  it('8a · 视频与文章都成功 → 触发归档', async () => {
    const env = makeGithubDeps();
    const code = GH_HELPERS + '\n' + extractFn(HTML_SRC, 'window.autoPubGithub=async function(){') +
      '\nreturn await window.autoPubGithub();';
    const r = await runSnippet(code, env.deps);
    expect(r.ok).toBe(true);
    expect(env.calls.archive.length).toBe(1);
    expect(env.calls.archive[0]).toBe('C:/rokit/final/final-1.mp4');
    // 发布记录仍是成功
    expect(env.calls.pubs.some(function (p) { return p.r.status === 'ok'; })).toBe(true);
  });

  it('8b · 视频上传失败（文章未发）→ 不归档', async () => {
    const env = makeGithubDeps({ videoResult: { ok: false, error: 'video-upload', detail: '上传失败' } });
    const code = GH_HELPERS + '\n' + extractFn(HTML_SRC, 'window.autoPubGithub=async function(){') +
      '\nreturn await window.autoPubGithub();';
    const r = await runSnippet(code, env.deps);
    expect(r.ok).toBe(false);
    expect(env.calls.archive.length).toBe(0);
  });

  it('8c · 文章上传失败（视频已成功）→ 不归档', async () => {
    const env = makeGithubDeps({ putResult: { ok: false, error: 'network', detail: '网络异常' } });
    const code = GH_HELPERS + '\n' + extractFn(HTML_SRC, 'window.autoPubGithub=async function(){') +
      '\nreturn await window.autoPubGithub();';
    const r = await runSnippet(code, env.deps);
    expect(r.ok).toBe(false);
    // 关键：文章失败时**不归档**（发布记录仍是 failed）
    expect(env.calls.archive.length).toBe(0);
    expect(env.calls.pubs.some(function (p) { return p.r.status === 'failed'; })).toBe(true);
  });

  it('8d · 没有成品视频（纯文章发布）→ 不归档', async () => {
    const env = makeGithubDeps();
    env.state.__captionFinalVideo = null;
    env.win.publishGithubVideo = function () { return Promise.resolve({ ok: true, video: null }); };
    const code = GH_HELPERS + '\n' + extractFn(HTML_SRC, 'window.autoPubGithub=async function(){') +
      '\nreturn await window.autoPubGithub();';
    const r = await runSnippet(code, env.deps);
    expect(r.ok).toBe(true);
    expect(env.calls.archive.length).toBe(0);
  });

  it('8e · 归档失败不改变 GitHub 的发布成功状态（仍记 ok）', async () => {
    const env = makeGithubDeps({ archiveFails: true });
    const code = GH_HELPERS + '\n' + extractFn(HTML_SRC, 'window.autoPubGithub=async function(){') +
      '\nreturn await window.autoPubGithub();';
    const r = await runSnippet(code, env.deps);
    expect(r.ok).toBe(true);
    expect(env.calls.pubs.some(function (p) { return p.r.status === 'ok'; })).toBe(true);
  });

  it('8f · 火箭队列的 github 分支同样在视频+文章都成功后才归档', async () => {
    const env = makeGithubDeps();
    const branch = extractBranch(HTML_SRC, "if(pid==='github'){");
    // do/while：分支里的 continue 会跳到条件判断 → 退出循环
    const code = 'var okCount=0;var pid="github";var box={innerHTML:""};\n' +
      GH_HELPERS + '\ndo { ' + branch + ' } while(false);';
    const deps = Object.assign({}, env.deps, { pid: 'github', box: { innerHTML: '' } });
    await runSnippet(code, deps);
    expect(env.calls.archive.length).toBe(1);
    expect(env.calls.archive[0]).toBe('C:/rokit/final/final-1.mp4');
  });

  it('8g · 火箭队列的 github 分支：文章上传失败 → 不归档', async () => {
    const env = makeGithubDeps({ putResult: { ok: false, error: 'network', detail: '网络异常' } });
    const branch = extractBranch(HTML_SRC, "if(pid==='github'){");
    const code = 'var okCount=0;var pid="github";var box={innerHTML:""};\n' +
      GH_HELPERS + '\ndo { ' + branch + ' } while(false);';
    const deps = Object.assign({}, env.deps, { pid: 'github', box: { innerHTML: '' } });
    await runSnippet(code, deps);
    expect(env.calls.archive.length).toBe(0);
  });
});

// 切出 if(pid==='xxx'){ ... } 分支（含配平花括号）
function extractBranch(src, header) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error('找不到分支：' + header);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('分支花括号不配平：' + header);
}

// ---------- 9 / 10 · YouTube：只有 status:'ok' 才归档 ----------
describe('B3 · YouTube 归档触发条件', () => {
  function runYoutubeBranch(launchResult, opts) {
    const o = opts || {};
    const branch = extractBranch(HTML_SRC, "if(pid==='youtube'){");
    const calls = { archive: [], pubs: [] };
    const win = {
      api: { pubLaunch: function () { return Promise.resolve(launchResult); } }
    };
    const code = 'var okCount=0;var pid="youtube";var box={innerHTML:""};' +
      'var document={getElementById:function(){return null;}};\n' +
      'do { ' + branch + ' } while(false);';
    const deps = {
      window: win,
      state: { project: { name: 'Demo' }, copies: {}, __captionFinalVideo: { path: 'C:/rokit/final/final-1.mp4' } },
      youtubePublishPayload: function () {
        return { title: '标题', finalVideoPath: 'C:/rokit/final/final-1.mp4', finalVideoName: 'final-1.mp4' };
      },
      esc: function (s) { return String(s); },
      bindYoutubeProgress: function () {},
      unbindYoutubeProgress: function () {},
      markPub: function (pid, r) { calls.pubs.push({ pid: pid, r: r }); },
      _archiveFinalVideoAfterPublish: function (p) {
        calls.archive.push(p);
        return o.archiveFails ? Promise.reject(new Error('归档异常')) : Promise.resolve({ ok: true });
      },
      pid: 'youtube',
      box: { innerHTML: '' }
    };
    return runSnippet(code, deps).then(function () { return calls; });
  }

  it('9a · status==\'ok\' → 触发归档', async () => {
    const calls = await runYoutubeBranch({ status: 'ok', videoId: 'abc12345678', url: 'https://yt/x' });
    expect(calls.archive.length).toBe(1);
    expect(calls.archive[0]).toBe('C:/rokit/final/final-1.mp4');
    expect(calls.pubs.some(function (p) { return p.r.status === 'ok'; })).toBe(true);
  });

  it('9b · status!==\'ok\' → 不归档', async () => {
    const calls = await runYoutubeBranch({ status: 'manual', error: 'NOT_CONNECTED' });
    expect(calls.archive.length).toBe(0);
    expect(calls.pubs.some(function (p) { return p.r.status === 'failed'; })).toBe(true);
  });

  it('9c · status==\'need_file\' → 不归档', async () => {
    const calls = await runYoutubeBranch({ status: 'need_file', note: '文件不可读' });
    expect(calls.archive.length).toBe(0);
  });

  it('10 · 归档失败不改变 YouTube 的发布成功状态（仍记 ok）', async () => {
    const calls = await runYoutubeBranch({ status: 'ok', videoId: 'abc12345678' }, { archiveFails: true });
    // 发布记录仍然是成功（归档失败没有改写它）
    expect(calls.pubs.length).toBe(1);
    expect(calls.pubs[0].r.status).toBe('ok');
  });
});

// ---------- 11 / 12 · 作品重新打开时读回映射视频 ----------
describe('B4 · 作品重新打开时读回归档视频', () => {
  it('11 · 有映射且文件有效 → 恢复该作品可复用的成品视频状态', async () => {
    const env = makeRendererEnv({
      state: { planOwnerId: 'w1', curWork: 'w1' },
      getResult: { ok: true, workId: 'w1', path: 'C:/rokit/work-videos/final-1.mp4', size: 1024 }
    });
    env.api.restore('w1');
    await Promise.resolve();
    await Promise.resolve();
    expect(env.calls.get).toEqual(['w1']);
    expect(env.state.__captionFinalVideo).toBeTruthy();
    expect(env.state.__captionFinalVideo.path).toBe('C:/rokit/work-videos/final-1.mp4');
    expect(env.state.__captionFinalVideo.bytes).toBe(1024);
  });

  it('12 · 无映射 → 保持原有行为（不建立映射、不加载任何视频）', async () => {
    const env = makeRendererEnv({
      state: { planOwnerId: 'w1', curWork: 'w1' },
      getResult: { ok: false, error: 'no-final-video' }
    });
    env.api.restore('w1');
    await Promise.resolve();
    await Promise.resolve();
    expect(env.state.__captionFinalVideo).toBeFalsy();
  });

  it('12b · 映射存在但文件失效 → 保持原有行为', async () => {
    const env = makeRendererEnv({
      state: { planOwnerId: 'w1', curWork: 'w1' },
      getResult: { ok: false, error: 'file-missing', storedPath: 'C:/rokit/work-videos/gone.mp4' }
    });
    env.api.restore('w1');
    await Promise.resolve();
    await Promise.resolve();
    expect(env.state.__captionFinalVideo).toBeFalsy();
  });

  it('12c · 切换作品后迟到的响应被丢弃（不把别的作品的视频加载进来）', async () => {
    const env = makeRendererEnv({
      state: { planOwnerId: 'w1', curWork: 'w1' },
      getResult: { ok: true, workId: 'w1', path: 'C:/rokit/work-videos/final-1.mp4' }
    });
    env.api.restore('w1');
    // 用户已切换到别的作品
    env.state.curWork = 'w2';
    await Promise.resolve();
    await Promise.resolve();
    expect(env.state.__captionFinalVideo).toBeFalsy();
  });

  it('openWork 中在清空成品状态后调用读回逻辑', () => {
    const fn = extractFn(HTML_SRC, 'window.openWork=function(id){');
    const clearAt = fn.indexOf('state.__captionFinalVideo=null;');
    const restoreAt = fn.indexOf('_restoreFinalVideoForWork(id)');
    expect(clearAt).toBeGreaterThan(0);
    expect(restoreAt).toBeGreaterThan(clearAt);
  });
});
