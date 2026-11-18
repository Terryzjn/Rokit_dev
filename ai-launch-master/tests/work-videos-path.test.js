// Rokit · 受管成品视频目录（work-videos/）路径支持（第二批）—— 定向测试
//
// 覆盖需求点：
//   1  两个受管目录中的合法 MP4 均可通过主进程路径校验
//   2  外部路径 / 路径穿越 / 目录本身 / 非 MP4 / 不存在 / 空文件 均被拒绝
//   3  isInsideFinalVideoDir() 正确识别两个目录，拒绝外部路径
//   4  caption:read-final 接受新目录并拒绝外部路径
//   5  caption:save-final 接受新目录作为源，同时保持原目标目录行为
//
// 全部使用临时目录 + mock electron，**不创建真实的 work-videos/ 目录**，
// 不复制、移动、删除任何媒体文件（测试用的都是临时目录里的假文件）。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const VS_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'video-source.js'), 'utf8');

let ud = '';          // 临时 userData 目录
let finalDir = '';   // <ud>/temp/videos/final
let workDir = '';    // <ud>/work-videos
let savedDir = '';   // <ud>/saved-videos

beforeEach(function () {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-workvideos-'));
  finalDir = path.join(ud, 'temp', 'videos', 'final');
  workDir = path.join(ud, 'work-videos');
  savedDir = path.join(ud, 'saved-videos');
  fs.mkdirSync(finalDir, { recursive: true });
  // 注意：work-videos/ 只在**临时目录**里创建用于测试，生产目录不会被创建
  fs.mkdirSync(workDir, { recursive: true });
});

afterEach(function () {
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_e) {}
});

// ---------- 从生产源码提取 main.js 的两个校验函数 ----------
// main.js 依赖 electron.app / fs / path，无法直接 require（会拉起整个主进程）。
// 这里按花括号配平切出函数体，用 new Function 注入依赖执行 —— 被测的是**真实源码**。
function loadMainFns() {
  const start = MAIN_SRC.indexOf('function managedFinalVideoRoots()');
  const end = MAIN_SRC.indexOf('function resolveFinalVideoFile');
  if (start < 0 || end < 0) throw new Error('源码中找不到 managedFinalVideoRoots');
  const block = MAIN_SRC.slice(start, end);
  // 取出 isInsideFinalVideoDir（它定义在 resolveFinalVideoFile 之后）
  const s2 = MAIN_SRC.indexOf('function isInsideFinalVideoDir');
  const e2 = MAIN_SRC.indexOf('// 只校验一个成品视频路径是否可用');
  if (s2 < 0 || e2 < 0) throw new Error('源码中找不到 isInsideFinalVideoDir');
  const block2 = MAIN_SRC.slice(s2, e2);
  // 取出 resolveFinalVideoFile 本体
  const s3 = end;
  const e3 = MAIN_SRC.indexOf('// ---------- 作品最新成品视频映射');
  if (e3 < 0) throw new Error('源码中找不到 resolveFinalVideoFile 结尾');
  const block3 = MAIN_SRC.slice(s3, e3);

  const factory = new Function(
    'app', 'fs', 'path',
    block + '\n' + block3 + '\n' + block2 +
    '\nreturn { resolveFinalVideoFile: resolveFinalVideoFile, isInsideFinalVideoDir: isInsideFinalVideoDir, managedFinalVideoRoots: managedFinalVideoRoots };'
  );
  return factory(
    { getPath: function () { return ud; } },
    fs,
    path
  );
}

// 从一段源码里按花括号配平切出「匿名函数表达式」（不依赖结尾标记）。
function pickAnonymousFn(src, fromIndex) {
  const start = src.indexOf('function', fromIndex);
  if (start < 0) throw new Error('找不到 function');
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error('找不到花括号');
  let depth = 1;
  i++;
  while (i < src.length && depth > 0) {
    const ch = src.charAt(i);
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error('花括号不配平');
  return src.slice(start, i);
}

// ---------- video-source.js 的两个 IPC ----------
// 同样用源码提取：取受管目录函数 + 两个 handler 的函数体，用 new Function 注入依赖执行。
// 被测的是**生产源码本体**，不是重写的等价实现。
function loadVideoSourceHandlers() {
  const start = VS_SRC.indexOf('function managedFinalVideoRoots()');
  const end = VS_SRC.indexOf('// ---------- VideoSource 枚举 ----------');
  if (start < 0 || end < 0) throw new Error('video-source.js 找不到受管目录函数');
  const helpers = VS_SRC.slice(start, end);

  const readIdx = VS_SRC.indexOf("ipcMain.handle('caption:read-final'");
  const saveIdx = VS_SRC.indexOf("ipcMain.handle('caption:save-final'");
  const readBody = 'var captionReadFinal = ' + pickAnonymousFn(VS_SRC, readIdx) + ';';
  const saveBody = 'var captionSaveFinal = ' + pickAnonymousFn(VS_SRC, saveIdx) + ';';

  const factory = new Function(
    'app', 'fs', 'path', 'logger',
    helpers + '\n' + readBody + '\n' + saveBody +
    '\nreturn { read: captionReadFinal, save: captionSaveFinal };'
  );
  return factory(
    { getPath: function () { return ud; } },
    fs,
    path,
    { info: function () {}, warn: function () {}, error: function () {} }
  );
}

// 造一个合法 MP4 假文件（内容非空）
function makeMp4(dir, name, size) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(size || 4096, 1));
  return p;
}

/* ==================================================================
   1 · 主进程路径校验：两个受管目录都接受
   ================================================================== */
describe('1 · resolveFinalVideoFile() 接受两个受管目录', function () {
  it('1a. temp/videos/final 下的合法 MP4 → 通过（原有语义不变）', function () {
    const f = loadMainFns();
    const p = makeMp4(finalDir, 'final-123.mp4');
    const r = f.resolveFinalVideoFile(p);
    expect(r.ok).toBe(true);
    expect(r.filePath).toBe(path.resolve(p));
    expect(r.size).toBe(4096);
  });

  it('1b. work-videos 下的合法 MP4 → 通过（新增能力）', function () {
    const f = loadMainFns();
    const p = makeMp4(workDir, 'work-456.mp4');
    const r = f.resolveFinalVideoFile(p);
    expect(r.ok).toBe(true);
    expect(r.filePath).toBe(path.resolve(p));
  });

  it('1c. work-videos 下的子目录里的 MP4 → 通过', function () {
    const f = loadMainFns();
    const sub = path.join(workDir, 'nested');
    fs.mkdirSync(sub, { recursive: true });
    const p = makeMp4(sub, 'deep.mp4');
    expect(f.resolveFinalVideoFile(p).ok).toBe(true);
  });
});

/* ==================================================================
   2 · 各类非法路径一律拒绝
   ================================================================== */
describe('2 · 非法路径一律拒绝（不放宽到任意路径）', function () {
  it('2a. userData 根下的散落文件 → path-not-allowed', function () {
    const f = loadMainFns();
    const p = path.join(ud, 'original-local-video.mp4');
    fs.writeFileSync(p, Buffer.alloc(4096, 1));
    const r = f.resolveFinalVideoFile(p);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('path-not-allowed');
  });

  it('2b. 两个受管目录之外（如 temp/videos/source/）→ path-not-allowed', function () {
    const f = loadMainFns();
    const other = path.join(ud, 'temp', 'videos', 'source');
    fs.mkdirSync(other, { recursive: true });
    const p = makeMp4(other, 'va-abc.mp4');
    expect(f.resolveFinalVideoFile(p).error).toBe('path-not-allowed');
  });

  it('2c. 路径穿越（work-videos/../escape.mp4）→ path-not-allowed', function () {
    const f = loadMainFns();
    const p = path.join(workDir, '..', 'escape.mp4');
    fs.writeFileSync(p, Buffer.alloc(4096, 1));
    expect(f.resolveFinalVideoFile(p).error).toBe('path-not-allowed');
  });

  it('2d. 目录本身 → path-not-allowed（目录不是合法文件）', function () {
    const f = loadMainFns();
    expect(f.resolveFinalVideoFile(finalDir).error).toBe('path-not-allowed');
    expect(f.resolveFinalVideoFile(workDir).error).toBe('path-not-allowed');
  });

  it('2e. 非 .mp4 扩展名 → not-mp4', function () {
    const f = loadMainFns();
    const p = path.join(workDir, 'not-video.txt');
    fs.writeFileSync(p, 'hello');
    expect(f.resolveFinalVideoFile(p).error).toBe('not-mp4');
  });

  it('2f. 文件不存在 → file-missing', function () {
    const f = loadMainFns();
    expect(f.resolveFinalVideoFile(path.join(workDir, 'missing.mp4')).error).toBe('file-missing');
  });

  it('2g. 空文件 → file-empty', function () {
    const f = loadMainFns();
    const p = path.join(workDir, 'empty.mp4');
    fs.writeFileSync(p, Buffer.alloc(0));
    expect(f.resolveFinalVideoFile(p).error).toBe('file-empty');
  });

  it('2h. 路径为空 / 非字符串 → no-final-video', function () {
    const f = loadMainFns();
    expect(f.resolveFinalVideoFile(null).error).toBe('no-final-video');
    expect(f.resolveFinalVideoFile('').error).toBe('no-final-video');
    expect(f.resolveFinalVideoFile(123).error).toBe('no-final-video');
  });
});

/* ==================================================================
   3 · isInsideFinalVideoDir()
   ================================================================== */
describe('3 · isInsideFinalVideoDir() 识别两个受管目录', function () {
  it('3a. 两个目录内的文件都返回 true', function () {
    const f = loadMainFns();
    expect(f.isInsideFinalVideoDir(path.join(finalDir, 'a.mp4'))).toBe(true);
    expect(f.isInsideFinalVideoDir(path.join(workDir, 'b.mp4'))).toBe(true);
  });

  it('3b. 目录之外的路径返回 false', function () {
    const f = loadMainFns();
    expect(f.isInsideFinalVideoDir(path.join(ud, 'random.mp4'))).toBe(false);
    expect(f.isInsideFinalVideoDir(path.join(ud, 'temp', 'videos', 'work', 'c.mp4'))).toBe(false);
  });

  it('3c. 路径穿越返回 false', function () {
    const f = loadMainFns();
    expect(f.isInsideFinalVideoDir(path.join(workDir, '..', 'x.mp4'))).toBe(false);
  });

  it('3d. 空路径返回 false', function () {
    const f = loadMainFns();
    expect(f.isInsideFinalVideoDir('')).toBe(false);
  });
});

/* ==================================================================
   4 · caption:read-final
   ================================================================== */
describe('4 · caption:read-final 接受新目录', function () {
  it('4a. work-videos 下的文件可读', function () {
    const h = loadVideoSourceHandlers();
    const p = makeMp4(workDir, 'read-me.mp4', 2048);
    const r = h.read({}, p);
    expect(r.ok).toBe(true);
    expect(r.mime).toBe('video/mp4');
    expect(r.size).toBe(2048);
    expect(Buffer.from(r.b64, 'base64').length).toBe(2048);
  });

  it('4b. temp/videos/final 下的文件仍可读（原有语义不变）', function () {
    const h = loadVideoSourceHandlers();
    const p = makeMp4(finalDir, 'read-me-too.mp4', 1024);
    const r = h.read({}, p);
    expect(r.ok).toBe(true);
    expect(r.size).toBe(1024);
  });

  it('4c. 外部路径 → path-not-allowed', function () {
    const h = loadVideoSourceHandlers();
    const p = path.join(ud, 'secret.mp4');
    fs.writeFileSync(p, Buffer.alloc(64, 1));
    const r = h.read({}, p);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('path-not-allowed');
  });

  it('4d. 路径穿越 → path-not-allowed', function () {
    const h = loadVideoSourceHandlers();
    const p = path.join(workDir, '..', 'escape.mp4');
    fs.writeFileSync(p, Buffer.alloc(64, 1));
    expect(h.read({}, p).error).toBe('path-not-allowed');
  });

  it('4e. 文件不存在 → file-missing', function () {
    const h = loadVideoSourceHandlers();
    expect(h.read({}, path.join(workDir, 'nope.mp4')).error).toBe('file-missing');
  });

  it('4f. 空路径 → no-path', function () {
    const h = loadVideoSourceHandlers();
    expect(h.read({}, '').error).toBe('no-path');
  });
});

/* ==================================================================
   5 · caption:save-final
   ================================================================== */
describe('5 · caption:save-final 接受新目录作为源', function () {
  it('5a. 源在 work-videos → 复制到 saved-videos（目标行为不变）', async function () {
    const h = loadVideoSourceHandlers();
    const src = makeMp4(workDir, 'archive.mp4', 4096);
    const r = await h.save({}, { filePath: src, defaultPath: '我的成品.mp4' });
    expect(r.ok).toBe(true);
    expect(path.dirname(r.path)).toBe(path.resolve(savedDir));
    expect(path.basename(r.path)).toBe('我的成品.mp4');
    expect(fs.statSync(r.path).size).toBe(4096);
    // 源文件仍在（只复制，不移动）
    expect(fs.existsSync(src)).toBe(true);
  });

  it('5b. 源在 temp/videos/final → 仍可复制（原有语义不变）', async function () {
    const h = loadVideoSourceHandlers();
    const src = makeMp4(finalDir, 'final-x.mp4', 2048);
    const r = await h.save({}, { filePath: src, defaultPath: 'y.mp4' });
    expect(r.ok).toBe(true);
    expect(path.dirname(r.path)).toBe(path.resolve(savedDir));
  });

  it('5c. 外部源 → path-not-allowed，且不产生目标文件', async function () {
    const h = loadVideoSourceHandlers();
    const src = path.join(ud, 'outside.mp4');
    fs.writeFileSync(src, Buffer.alloc(1024, 1));
    const r = await h.save({}, { filePath: src, defaultPath: 'z.mp4' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('path-not-allowed');
    expect(fs.existsSync(path.join(savedDir, 'z.mp4'))).toBe(false);
  });

  it('5d. 源不存在 → 明确失败', async function () {
    const h = loadVideoSourceHandlers();
    const r = await h.save({}, { filePath: path.join(workDir, 'gone.mp4'), defaultPath: 'z.mp4' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('成品文件不存在');
  });

  it('5e. 源为空文件 → 明确失败', async function () {
    const h = loadVideoSourceHandlers();
    const src = path.join(workDir, 'empty.mp4');
    fs.writeFileSync(src, Buffer.alloc(0));
    const r = await h.save({}, { filePath: src, defaultPath: 'z.mp4' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('为空');
  });

  it('5f. 同名不覆盖：追加 -1 / -2', async function () {
    const h = loadVideoSourceHandlers();
    const src = makeMp4(workDir, 'same.mp4', 1024);
    const r1 = await h.save({}, { filePath: src, defaultPath: '同名.mp4' });
    const r2 = await h.save({}, { filePath: src, defaultPath: '同名.mp4' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(path.basename(r1.path)).toBe('同名.mp4');
    expect(path.basename(r2.path)).toBe('同名-1.mp4');
  });
});

/* ==================================================================
   6 · 源码级约束
   ================================================================== */
describe('6 · 源码约束', function () {
  it('6a. 两个生产文件都包含受管目录列表（temp/videos/final + work-videos）', function () {
    expect(MAIN_SRC).toMatch(/'temp',\s*'videos',\s*'final'/);
    expect(MAIN_SRC).toMatch(/'work-videos'/);
    expect(VS_SRC).toMatch(/'temp',\s*'videos',\s*'final'/);
    expect(VS_SRC).toMatch(/'work-videos'/);
  });

  it('6b. 路径穿越防护在两处都保留', function () {
    expect(MAIN_SRC).toMatch(/rel\.indexOf\('\.\.'\) === 0 \|\| path\.isAbsolute\(rel\)/);
    expect(VS_SRC).toMatch(/rel\.indexOf\('\.\.'\) === 0 \|\| path\.isAbsolute\(rel\)/);
  });

  it('6c. 本批没有实现复制 / 归档 / 删除逻辑', function () {
    // work-videos 目录只出现在白名单计算里，不得出现 copyFileSync / unlinkSync 等写操作
    const wvLines = MAIN_SRC.split('\n').filter(function (l) { return l.indexOf('work-videos') >= 0; });
    wvLines.forEach(function (l) {
      expect(l).not.toMatch(/copyFileSync|unlinkSync|rmSync|rmdirSync|writeFileSync/);
    });
    const vsLines = VS_SRC.split('\n').filter(function (l) { return l.indexOf('work-videos') >= 0; });
    vsLines.forEach(function (l) {
      expect(l).not.toMatch(/copyFileSync|unlinkSync|rmSync|rmdirSync|writeFileSync/);
    });
  });

  it('6d. 第一批的映射生命周期改动未被破坏', function () {
    expect(MAIN_SRC).toMatch(/deleteSettingKv\(FINAL_VIDEO_KEY_PREFIX \+ from\)/);
  });
});
