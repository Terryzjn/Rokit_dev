// Rokit · 临时成品视频自动清除（第五批）—— 定向测试
//
// 覆盖用户要求的验证点：
//   V1  temp/videos/ 下不再需要的临时成品视频能在作品流程最终完成后自动清理
//   V2  清理避开当前流程仍在使用的文件（仍是作品最新视频 / 被未完成计划引用 / 引用关系无法确认）
//   V3  work-videos/ 保留（作品关联归档生命周期不变）
//   V4  videos/、saved-videos/ 保留（用户主动保存 / 保留的资产）
//   V5  voice-profiles/ 保留（用户原始音源）
//   V6  清理在后台执行、失败有明确日志、不误删其它文件
//   V7  temp/voices/ 的 AI 语音清理（既有功能）未被本批破坏
//
// 策略：全部使用**真实生产源码**（electron/video-temp-cleanup.js）执行，
//   只在**临时测试目录**里创建/删除文件；绝不触碰用户目录（真实 userData）
//   里的任何文件，绝不读写生产数据库。
//

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8').replace(/\r\n/g, '\n');

// —— 主进程模块（真实生产代码）——
const cleanup = require(path.join(ROOT, 'electron', 'video-temp-cleanup.js'));

// ---------- 渲染层：从 index.html 真实源码切出函数 ----------
function extractFn(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = HTML_SRC.match(re);
  if (!m) throw new Error('源码中找不到函数：' + name);
  let i = m.index + m[0].length, depth = 1;
  while (i < HTML_SRC.length && depth > 0) {
    const ch = HTML_SRC.charAt(i++);
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  if (depth !== 0) throw new Error('花括号不配平：' + name);
  return HTML_SRC.slice(m.index, i);
}

// 按花括号配平切出 `window.xxx = function(){...}` 形式的源码块
function extractBlock(header) {
  const start = HTML_SRC.indexOf(header);
  if (start < 0) throw new Error('源码中找不到：' + header);
  const open = HTML_SRC.indexOf('{', start + header.length - 1);
  if (open < 0) throw new Error('缺少花括号：' + header);
  let depth = 0;
  for (let i = open; i < HTML_SRC.length; i++) {
    const ch = HTML_SRC[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return HTML_SRC.slice(start, i + 1);
    }
  }
  throw new Error('花括号不配平：' + header);
}

// ---------- 测试用临时目录（每次用例独立） ----------
let tmpRoot = '';
function makeTmp() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-videotemp-test-'));
  return tmpRoot;
}
function cleanupTmp() {
  if (!tmpRoot) return;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
  tmpRoot = '';
}

// 构造一棵与真实 userData 同构的目录树
function makeUserData() {
  const ud = makeTmp();
  const dirs = {
    ud: ud,
    final: path.join(ud, 'temp', 'videos', 'final'),
    source: path.join(ud, 'temp', 'videos', 'source'),
    work: path.join(ud, 'temp', 'videos', 'work'),
    recorder: path.join(ud, 'temp', 'videos', 'recorder'),
    voices: path.join(ud, 'temp', 'voices'),
    workVideos: path.join(ud, 'work-videos'),
    savedVideos: path.join(ud, 'saved-videos'),
    videos: path.join(ud, 'videos'),
    voiceProfiles: path.join(ud, 'voice-profiles')
  };
  Object.keys(dirs).forEach(function (k) {
    if (k === 'ud') return;
    fs.mkdirSync(dirs[k], { recursive: true });
  });
  return dirs;
}

// 造一个假的 store：只提供 assessFinalVideoCleanup（真实接口形状）
function makeStore(verdictFn) {
  return {
    assessFinalVideoCleanup: function (videoPath, opts) {
      return verdictFn(videoPath, opts);
    }
  };
}
const ELIGIBLE = { ok: true, eligible: true, managed: true, latestWorkIds: [], references: [], reason: 'ok' };

/* ==================================================================
   V1 · 作品流程最终完成后自动清理
   ================================================================== */
describe('V1 · 临时成品视频自动清理', () => {
  afterEach(function () { cleanupTmp(); });

  it('V1-1. 不再需要的 final-*.mp4 被删除', () => {
    const d = makeUserData();
    const f = path.join(d.final, 'final-123-abc.mp4');
    fs.writeFileSync(f, 'x');

    const r = cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), { root: d.final });

    expect(r.removedCount).toBe(1);
    expect(fs.existsSync(f)).toBe(false);
    expect(r.failed.length).toBe(0);
  });

  it('V1-2. 同目录下的非成品文件（sub-*.ass / frz-*）保留', () => {
    const d = makeUserData();
    const ass = path.join(d.final, 'sub-123.ass');
    const frz = path.join(d.final, 'frz-123-0.png');
    fs.writeFileSync(ass, 'x');
    fs.writeFileSync(frz, 'x');

    cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), { root: d.final });

    expect(fs.existsSync(ass)).toBe(true);
    expect(fs.existsSync(frz)).toBe(true);
  });

  it('V1-3. 目录不存在时静默跳过，不抛异常', () => {
    const missing = path.join(makeTmp(), 'not-exist');
    let r;
    expect(function () {
      r = cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), { root: missing });
    }).not.toThrow();
    expect(r.removedCount).toBe(0);
    expect(r.failed.length).toBe(0);
  });

  it('V1-4. store 缺少 assessFinalVideoCleanup 能力 → 完全不清理', () => {
    const d = makeUserData();
    const f = path.join(d.final, 'final-1.mp4');
    fs.writeFileSync(f, 'x');

    const r = cleanup.cleanupTempFinalVideos({}, { root: d.final });

    expect(r.ok).toBe(false);
    expect(r.removedCount).toBe(0);
    expect(fs.existsSync(f)).toBe(true);
  });
});

/* ==================================================================
   V2 · 清理避开当前流程仍在使用的文件
   ================================================================== */
describe('V2 · 避开仍在使用的文件', () => {
  afterEach(function () { cleanupTmp(); });

  it('V2-1. 仍是作品最新视频（eligible:false）→ 保留', () => {
    const d = makeUserData();
    const f = path.join(d.final, 'final-latest.mp4');
    fs.writeFileSync(f, 'x');

    const r = cleanup.cleanupTempFinalVideos(
      makeStore(() => ({ ok: true, eligible: false, managed: true, reason: '仍是作品最新成品视频' })),
      { root: d.final }
    );

    expect(r.removedCount).toBe(0);
    expect(fs.existsSync(f)).toBe(true);
    expect(r.skipped.length).toBe(1);
  });

  it('V2-2. 被未完成计划引用 → 保留（多平台引用保护由 store 判定，本模块不自行放行）', () => {
    const d = makeUserData();
    const f = path.join(d.final, 'final-referenced.mp4');
    fs.writeFileSync(f, 'x');

    const r = cleanup.cleanupTempFinalVideos(
      makeStore(() => ({ ok: true, eligible: false, managed: true, reason: '仍被未完成计划引用' })),
      { root: d.final }
    );

    expect(r.removedCount).toBe(0);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('V2-3. 引用关系无法确认（ok:false）→ 保留', () => {
    const d = makeUserData();
    const f = path.join(d.final, 'final-unknown.mp4');
    fs.writeFileSync(f, 'x');

    const r = cleanup.cleanupTempFinalVideos(
      makeStore(() => ({ ok: false, eligible: false, managed: true, reason: '计划引用关系无法确认，保留文件' })),
      { root: d.final }
    );

    expect(r.removedCount).toBe(0);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('V2-4. 当前会话仍在用的路径（protectPaths）→ 保留', () => {
    const d = makeUserData();
    const keep = path.join(d.final, 'final-inuse.mp4');
    const other = path.join(d.final, 'final-other.mp4');
    fs.writeFileSync(keep, 'x');
    fs.writeFileSync(other, 'x');

    const r = cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), {
      root: d.final,
      protectPaths: [keep]
    });

    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(other)).toBe(false);
    expect(r.removedCount).toBe(1);
  });

  it('V2-5. 非 Rokit 管理的文件（isManaged=false）→ 保留', () => {
    const d = makeUserData();
    const f = path.join(d.final, 'final-foreign.mp4');
    fs.writeFileSync(f, 'x');

    const r = cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), {
      root: d.final,
      isManaged: function () { return false; }
    });

    expect(r.removedCount).toBe(0);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('V2-6. 判定函数抛异常 → 保留该文件并记入 failed（不误删）', () => {
    const d = makeUserData();
    const f = path.join(d.final, 'final-throw.mp4');
    fs.writeFileSync(f, 'x');

    const r = cleanup.cleanupTempFinalVideos(makeStore(() => { throw new Error('boom'); }), { root: d.final });

    expect(r.removedCount).toBe(0);
    expect(fs.existsSync(f)).toBe(true);
    expect(r.failed.length).toBe(1);
    expect(String(r.failed[0].error)).toMatch(/before-delete-failed/);
  });
});

/* ==================================================================
   V9 · 空路径规范化（收尾修复）
   ------------------------------------------------------------------
   背景：path.resolve('') 返回**当前工作目录**。若不短路，
   一个空路径会被规范化成 cwd 并误加入「保护路径集合」，
   语义完全错误（"没有要保护的东西" ≠ "要保护 cwd 这个文件"）。
   ================================================================== */
describe('V9 · 空路径规范化', () => {
  afterEach(function () { cleanupTmp(); });

  it('V9-1. norm() 对 null / undefined / 空串返回空串（不是 cwd）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'video-temp-cleanup.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // 必须有显式的空值短路
    expect(src).toMatch(/if \(p === null \|\| p === undefined\) return '';/);
    expect(src).toMatch(/if \(!raw\) return '';/);
    // 不允许直接 path.resolve(String(p || ''))
    expect(src).not.toMatch(/path\.resolve\(String\(p \|\| ''\)\)/);
  });

  it('V9-2. 空字符串不再被规范化成 cwd（保护集合不污染）', () => {
    const d = makeUserData();
    const f = path.join(d.final, 'final-normalized.mp4');
    fs.writeFileSync(f, 'x');

    // protectPaths 含空串 → 空串必须被忽略，不能当成 cwd 去保护
    const r = cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), {
      root: d.final,
      protectPaths: ['', null, undefined]
    });

    // 空路径既不保护任何东西，也不阻断删除
    expect(r.removedCount).toBe(1);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('V9-3. protectPaths 全为空时，文件仍按正常规则删除', () => {
    const d = makeUserData();
    const f = path.join(d.final, 'final-all-empty.mp4');
    fs.writeFileSync(f, 'x');

    const r = cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), {
      root: d.final,
      protectPaths: []
    });

    expect(r.removedCount).toBe(1);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('V9-4. 绝对路径仍然正确保护', () => {
    const d = makeUserData();
    const keep = path.join(d.final, 'final-abs.mp4');
    fs.writeFileSync(keep, 'x');

    const r = cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), {
      root: d.final,
      protectPaths: [keep]
    });

    expect(fs.existsSync(keep)).toBe(true);
    expect(r.removedCount).toBe(0);
  });

  it('V9-5. Windows 分隔符与大小写归一后仍然正确保护', () => {
    const d = makeUserData();
    const keep = path.join(d.final, 'final-case.mp4');
    fs.writeFileSync(keep, 'x');

    // 反斜杠 → 正斜杠 + 全大写：Windows 下应指向同一个文件
    const alt = keep.replace(/\\/g, '/').toUpperCase();
    const r = cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), {
      root: d.final,
      protectPaths: [alt]
    });

    expect(fs.existsSync(keep)).toBe(true);
    expect(r.removedCount).toBe(0);
  });

  it('V9-6. 相对路径按 cwd 解析后比较（不误伤其它文件）', () => {
    const d = makeUserData();
    const f = path.join(d.final, 'final-rel.mp4');
    fs.writeFileSync(f, 'x');

    // 相对路径 'final-rel.mp4' 解析到 cwd 下（不是 final 目录）→ 不保护目标文件
    const r = cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), {
      root: d.final,
      protectPaths: ['final-rel.mp4']
    });

    expect(fs.existsSync(f)).toBe(false);
    expect(r.removedCount).toBe(1);
  });

  it('V9-7. main.js 只把有效的非空路径加入 protectPaths', () => {
    const start = MAIN_SRC.indexOf("ipcMain.handle('video-temp:cleanup'");
    expect(start).toBeGreaterThan(0);
    const end = MAIN_SRC.indexOf('// v1.20.6：挂载 voice-engine:* IPC', start);
    const block = MAIN_SRC.slice(start, end);
    // 空路径不进入数组
    expect(block).toMatch(/protectPaths: \(String\(protectPath \|\| ''\)\.trim\(\)\) \? \[String\(protectPath\)\] : \[\]/);
    // 不允许把空串无条件放进数组
    expect(block).not.toMatch(/protectPaths: \[String\(protectPath \|\| ''\)\]/);
  });
});

/* ==================================================================
   V3/V4/V5 · 目录保护
   ================================================================== */
describe('V3-V5 · 受保护目录', () => {
  afterEach(function () { cleanupTmp(); });

  it('V3. work-videos/ 里的归档成品视频保留', () => {
    const d = makeUserData();
    const f = path.join(d.workVideos, 'final-archived.mp4');
    fs.writeFileSync(f, 'x');

    cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), { root: d.final });

    expect(fs.existsSync(f)).toBe(true);
  });

  it('V4. saved-videos/ 与 videos/ 里的文件保留', () => {
    const d = makeUserData();
    const saved = path.join(d.savedVideos, 'final-saved.mp4');
    const kept = path.join(d.videos, 'final-kept.mp4');
    fs.writeFileSync(saved, 'x');
    fs.writeFileSync(kept, 'x');

    cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), { root: d.final });

    expect(fs.existsSync(saved)).toBe(true);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('V5. voice-profiles/ 里的用户原始音源保留', () => {
    const d = makeUserData();
    const f = path.join(d.voiceProfiles, 'profile-source.mp3');
    fs.writeFileSync(f, 'x');

    cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), { root: d.final });

    expect(fs.existsSync(f)).toBe(true);
  });

  it('V3-2. 源目录 / 转码中间物 / 临时录屏目录里的文件不被本批触碰', () => {
    const d = makeUserData();
    const src = path.join(d.source, 'va-abcdef0123456789.mp4');
    const work = path.join(d.work, 'clip.mp4');
    const rec = path.join(d.recorder, 'rec.webm');
    [src, work, rec].forEach(p => fs.writeFileSync(p, 'x'));

    cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), { root: d.final });

    expect(fs.existsSync(src)).toBe(true);
    expect(fs.existsSync(work)).toBe(true);
    expect(fs.existsSync(rec)).toBe(true);
  });
});

/* ==================================================================
   V6 · 后台执行 / 失败日志 / 不误删
   ================================================================== */
describe('V6 · 后台执行与失败处理', () => {
  afterEach(function () { cleanupTmp(); });

  it('V6-1. 清理只删普通文件，目录本身保留', () => {
    const d = makeUserData();
    fs.mkdirSync(path.join(d.final, 'final-dir.mp4'), { recursive: true });

    const r = cleanup.cleanupTempFinalVideos(makeStore(() => ELIGIBLE), { root: d.final });

    expect(r.removedCount).toBe(0);
    expect(fs.existsSync(path.join(d.final, 'final-dir.mp4'))).toBe(true);
    expect(fs.statSync(path.join(d.final, 'final-dir.mp4')).isDirectory()).toBe(true);
  });

  it('V6-2. 清理模块本身不删目录（无 rmSync / rmdirSync）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'electron', 'video-temp-cleanup.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/rmSync|rmdirSync|fs\.rm\s*\(/);
    // 只删文件
    expect(src).toMatch(/fs\.unlinkSync\(full\)/);
  });

  it('V6-3. 主进程注册了 video-temp:cleanup IPC，且带明确日志', () => {
    expect(MAIN_SRC).toMatch(/ipcMain\.handle\('video-temp:cleanup'/);
    expect(MAIN_SRC).toMatch(/logger\.info\('\[video-temp\] cleanup'/);
    expect(MAIN_SRC).toMatch(/logger\.warn\('\[video-temp\] cleanup failed'/);
    // 判定能力由 store 提供（已验收的多平台引用保护）
    expect(MAIN_SRC).toMatch(/cleanupTempFinalVideos\(store/);
    expect(MAIN_SRC).toMatch(/isManaged: function \(filePath\) \{ return isInsideFinalVideoDir\(filePath\); \}/);
  });

  it('V6-3b. 清理在后台低优先级执行（setImmediate 推迟到下一次事件循环）', () => {
    const start = MAIN_SRC.indexOf("ipcMain.handle('video-temp:cleanup'");
    expect(start).toBeGreaterThan(0);
    const end = MAIN_SRC.indexOf('// v1.20.6：挂载 voice-engine:* IPC', start);
    const block = MAIN_SRC.slice(start, end);
    // 用 setImmediate 把实际清理推迟，不占用调用方（UI）的时间
    expect(block).toMatch(/setImmediate\(/);
    // IPC 立即返回一个 Promise（不等清理完成）
    expect(block).toMatch(/return new Promise\(function \(resolve\)/);
  });

  it('V6-4. preload 暴露 videoTempCleanup，通道名与 IPC 一致', () => {
    expect(PRELOAD_SRC).toMatch(/videoTempCleanup: \(protectPath\) => ipcRenderer\.invoke\('video-temp:cleanup', protectPath \|\| ''\)/);
  });

  it('V6-5. 渲染层：清理入口在三个作品完成点都被调用，且失败静默', () => {
    const purge = extractFn('_capPurgeTempVideos');
    // 只调主进程入口，不在渲染层做任何删除判断
    expect(purge).toMatch(/window\.api\.videoTempCleanup\(/);
    expect(purge).not.toMatch(/unlink|rmSync|fs\.rm|deleteFile/i);
    // 失败静默（全程 try/catch）
    expect(purge).toMatch(/catch \(_e\) \{\}/);

    const savePlan = HTML_SRC.match(/window\.savePlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/);
    const skipPlan = HTML_SRC.match(/window\.skipPlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/);
    const launch = HTML_SRC.match(/window\.launch\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/);
    expect(savePlan).not.toBe(null);
    expect(skipPlan).not.toBe(null);
    expect(launch).not.toBe(null);
    expect(savePlan[0]).toMatch(/_capPurgeTempVideos\(\)/);
    expect(skipPlan[0]).toMatch(/_capPurgeTempVideos\(\)/);
    expect(launch[0]).toMatch(/_capPurgeTempVideos\(\)/);
  });

  /* ==================================================================
     V8 · 清理时序（收尾修复）：清理必须排在归属转正 + 归档补挂之后
     ================================================================== */
  it('V8-1. launch() 的清理排在 _planChain 与 _rebindArchiveToSettledWork 之后', () => {
    const launch = HTML_SRC.match(/window\.launch\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    // 清理调用点必须在 _planChain 的 then 回调内部
    const chainIdx = launch.indexOf('Promise.resolve(_planChain).then');
    const purgeIdx = launch.indexOf('_capPurgeTempVideos()');
    expect(chainIdx).toBeGreaterThan(-1);
    expect(purgeIdx).toBeGreaterThan(chainIdx);
    // 必须在 rebind 之后
    const rebindIdx = launch.indexOf('_rebindArchiveToSettledWork(w.id, _planFrom)');
    expect(rebindIdx).toBeGreaterThan(-1);
    expect(purgeIdx).toBeGreaterThan(rebindIdx);
    // 且排在 rebind 的 Promise 之后（补挂完成才清理）
    expect(launch).toMatch(/Promise\.resolve\(_rebindP\)[\s\S]{0,120}_capPurgeTempVideos\(\)/);
  });

  it('V8-2. launch() 的清理不早于 planReassign（归属转正）', () => {
    // _planChain 内部包含 planReassign；清理挂在 _planChain.then 之后即天然在其之后
    const launch = HTML_SRC.match(/window\.launch\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    const chainIdx = launch.indexOf('Promise.resolve(_planChain).then');
    const purgeIdx = launch.indexOf('_capPurgeTempVideos()');
    expect(chainIdx).toBeGreaterThan(-1);
    expect(purgeIdx).toBeGreaterThan(chainIdx);
    // launch() 主体（_planChain 发起之前）不得出现清理调用
    const beforeChain = launch.slice(0, chainIdx);
    expect(beforeChain).not.toMatch(/_capPurgeTempVideos\(\)/);
  });

  it('V8-3. 三个入口各自只发起一次清理请求（同一流程不重复清理）', () => {
    const launch = HTML_SRC.match(/window\.launch\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    const savePlan = HTML_SRC.match(/window\.savePlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    const skipPlan = HTML_SRC.match(/window\.skipPlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    // launch() 的正常路径只有 1 处清理（异常路径另有 1 处兜底，二者互斥）
    const normalPart = launch.slice(0, launch.indexOf('}, function(){'));
    expect((normalPart.match(/_capPurgeTempVideos\(\)/g) || []).length).toBe(1);
    // 两个入口各自只有一个清理调用点（且在条件分支里）
    expect((savePlan.match(/_capPurgeTempVideos\(\)/g) || []).length).toBe(1);
    expect((skipPlan.match(/_capPurgeTempVideos\(\)/g) || []).length).toBe(1);
  });

  it('V8-3b. _planChain 异常时仍会清理（不漏清）', () => {
    const launch = HTML_SRC.match(/window\.launch\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    // 异常分支（reject handler）里必须有一次清理
    expect(launch).toMatch(/\}, function\(\)\{[\s\S]{0,400}_capPurgeTempVideos\(\)/);
  });

  it('V8-4. 两个入口按 launch() 的返回值决定是否补一次清理（不重复、不遗漏）', () => {
    const savePlan = HTML_SRC.match(/window\.savePlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    const skipPlan = HTML_SRC.match(/window\.skipPlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    // launch() 的返回值被读取并用于判断
    expect(savePlan).toMatch(/var _launchScheduledCleanup=\(window\.launch\(\)===true\)/);
    expect(skipPlan).toMatch(/var _launchScheduledCleanup=\(window\.launch\(\)===true\)/);
    // 清理被条件包裹：只有 launch 早退（未安排清理）时才补
    expect(savePlan).toMatch(/if\(!_launchScheduledCleanup\)\{\s*try\{ _capPurgeTempVideos\(\); \}catch\(_e\)\{\}\s*\}/);
    expect(skipPlan).toMatch(/if\(!_launchScheduledCleanup\)\{\s*try\{ _capPurgeTempVideos\(\); \}catch\(_e\)\{\}\s*\}/);
  });

  it('V8-5. launch() 早退时返回 false（调用方据此补清理）', () => {
    const launch = HTML_SRC.match(/window\.launch\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    // 两个早退分支都返回 false
    expect(launch).toMatch(/if\(!doneIds\.length\)return false;/);
    expect(launch).toMatch(/if\(!doneIds\.length\)return false;/g);
    // 正常路径返回 true（已安排清理）
    expect(launch).toMatch(/return true;/);
  });

  /* ==================================================================
     V10 · 直接调用 launch() 的入口（发布清单页「完成发布」按钮）
     ------------------------------------------------------------------
     该入口不经过 savePlanAndGo / skipPlanAndGo，
     launch() 早退时必须由包装函数补一次清理。
     ================================================================== */
  it('V10-1. 存在 _launchWithTempVideoCleanup() 包装函数', () => {
    const wrapper = extractBlock('window._launchWithTempVideoCleanup=function(){');
    // 读 launch() 的返回值
    expect(wrapper).toMatch(/\(window\.launch\(\)===true\)/);
    // false 时补一次清理
    expect(wrapper).toMatch(/if\(!_scheduled\)\{\s*try\{ _capPurgeTempVideos\(\); \}catch\(_e\)\{\}\s*\}/);
    // 清理失败不影响流程（全程 try/catch）
    expect(wrapper).toMatch(/try\{ _scheduled=\(window\.launch\(\)===true\); \}catch\(_e\)\{\}/);
  });

  it('V10-2. 发布清单页的「完成发布」按钮改为调用包装函数', () => {
    // 不再有直接的 onclick="launch()"
    expect(HTML_SRC).not.toMatch(/onclick="launch\(\)"/);
    // 改为包装函数
    expect(HTML_SRC).toMatch(/onclick="_launchWithTempVideoCleanup\(\)"/);
  });

  it('V10-3. 全项目不再有直接调用 launch() 的入口', () => {
    // 去掉注释后统计真实调用点：3 处（savePlanAndGo / skipPlanAndGo / 包装函数）
    const codeOnly = HTML_SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const calls = codeOnly.match(/window\.launch\(\)/g) || [];
    expect(calls.length).toBe(3);
    // 每一处都读取了返回值
    expect((codeOnly.match(/\(window\.launch\(\)===true\)/g) || []).length).toBe(3);
  });

  it('V10-4. 包装函数不影响 savePlanAndGo / skipPlanAndGo（各自逻辑不变）', () => {
    const savePlan = HTML_SRC.match(/window\.savePlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    const skipPlan = HTML_SRC.match(/window\.skipPlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    // 两个入口仍然直接读 launch() 的返回值（不经过包装函数，避免二次兜底）
    expect(savePlan).toMatch(/var _launchScheduledCleanup=\(window\.launch\(\)===true\)/);
    expect(skipPlan).toMatch(/var _launchScheduledCleanup=\(window\.launch\(\)===true\)/);
    expect(savePlan).not.toMatch(/_launchWithTempVideoCleanup/);
    expect(skipPlan).not.toMatch(/_launchWithTempVideoCleanup/);
  });

  it('V10-5. 包装函数未引入全局状态或去重标志', () => {
    const wrapper = extractBlock('window._launchWithTempVideoCleanup=function(){');
    // 函数体（去掉定义头 `window._launchWithTempVideoCleanup=function(){`）
    const body = wrapper.slice(wrapper.indexOf('{') + 1);
    // 只用局部变量，不写任何全局状态
    expect(body).not.toMatch(/state\./);
    expect(body).not.toMatch(/window\._\w+\s*=/);
    expect(body).not.toMatch(/window\.\w+\s*=/);
    // 只有一个清理调用点
    expect((wrapper.match(/_capPurgeTempVideos\(\)/g) || []).length).toBe(1);
  });

  it('V10-6. 包装函数不影响 launch() 的业务逻辑与返回值语义', () => {
    const launch = HTML_SRC.match(/window\.launch\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    // launch() 本身未被包装函数改动
    expect(launch).toMatch(/return true;/);
    expect(launch).toMatch(/if\(!doneIds\.length\)return false;/);
    // launch() 内仍只有一个正常清理点 + 一个 reject 兜底
    const normalPart = launch.slice(0, launch.indexOf('}, function(){'));
    expect((normalPart.match(/_capPurgeTempVideos\(\)/g) || []).length).toBe(1);
  });

  it('V8-6. 清理异常不会破坏作品保存与流程完成（try/catch 包裹）', () => {
    const launch = HTML_SRC.match(/window\.launch\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/)[0];
    // 清理调用被 try/catch 包住，且不参与 _planChain 的结果分支
    expect(launch).toMatch(/try\{ _capPurgeTempVideos\(\); \}catch\(_e\)\{\}/);
    // 清理不在 _planChain 的 then 里"阻断"其它逻辑（它是独立的 then 链）
    expect(launch).toMatch(/Promise\.resolve\(_rebindP\)\.catch\(function\(\)\{\}\)\.then\(function\(\)\{/);
    // 发射结果卡片仍在同一层渲染（未因清理而延后或跳过）
    expect(launch).toMatch(/pushAIHtml\(/);
    expect(launch).toMatch(/renderFlow\(\);/);
  });

  it('V8-7. _rebindArchiveToSettledWork 返回 Promise（供清理等待）', () => {
    const fn = extractFn('_rebindArchiveToSettledWork');
    // 所有早退都返回已 resolve 的 Promise
    expect(fn).toMatch(/if\(!id\)return Promise\.resolve\(null\);/);
    expect(fn).toMatch(/if\(!src\)return Promise\.resolve\(null\);/);
    expect(fn).toMatch(/if\(!last\|\|!last\.path\)return Promise\.resolve\(null\);/);
    expect(fn).toMatch(/if\(String\(last\.owner\|\|''\)===id\)return Promise\.resolve\(null\);/);
    // 主链路返回 Promise
    expect(fn).toMatch(/return Promise\.resolve\(window\.api\.planGetFinalVideo\(id\)\)/);
    // 异常分支也返回 Promise
    expect(fn).toMatch(/catch\(function\(e\)\{[\s\S]{0,200}return null;/);
  });

  it('V6-6. 渲染层传入当前会话内存里的成品视频作为保护路径', () => {
    const purge = extractFn('_capPurgeTempVideos');
    expect(purge).toMatch(/state\.__captionFinalVideo/);
    expect(purge).toMatch(/window\.api\.videoTempCleanup\(_keep\)/);
  });

  it('V6-7. 渲染层不做删除判定（判定全部在主进程）', () => {
    // 渲染层不得出现任何删除资格判断逻辑
    const purge = extractFn('_capPurgeTempVideos');
    expect(purge).not.toMatch(/eligible|assessFinalVideoCleanup|isInsideFinalVideoDir/);
  });
});

/* ==================================================================
   V7 · 既有 AI 语音清理未被破坏
   ================================================================== */
describe('V7 · 既有 AI 语音清理未受影响', () => {
  afterEach(function () { cleanupTmp(); });

  it('V7-1. ai-voice-cleanup 仍然只清 temp/voices/，不碰 temp/videos/final/', () => {
    const cleanupAi = require(path.join(ROOT, 'electron', 'ai-voice-cleanup.js'));
    const voicesDir = path.join(os.tmpdir(), 'rokit-temp', 'voices');
    fs.mkdirSync(voicesDir, { recursive: true });
    const voiceFile = path.join(voicesDir, 'voice-999-0.wav');
    fs.writeFileSync(voiceFile, 'x');
    const finalDir = path.join(os.tmpdir(), 'rokit-temp', 'videos', 'final');
    fs.mkdirSync(finalDir, { recursive: true });
    const finalMp4 = path.join(finalDir, 'final-999.mp4');
    fs.writeFileSync(finalMp4, 'x');
    try {
      cleanupAi.cleanupAiVoiceFiles();
      expect(fs.existsSync(voiceFile)).toBe(false);
      // 成品视频不受 AI 语音清理影响
      expect(fs.existsSync(finalMp4)).toBe(true);
    } finally {
      try { fs.unlinkSync(finalMp4); } catch (_e) {}
      try { fs.rmSync(voicesDir, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  it('V7-2. 三个作品完成点仍然都调用 _capPurgeAiVoice()', () => {
    const savePlan = HTML_SRC.match(/window\.savePlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/);
    const skipPlan = HTML_SRC.match(/window\.skipPlanAndGo\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/);
    const launch = HTML_SRC.match(/window\.launch\s*=\s*function\s*\(\)\s*\{[\s\S]*?\n  \};/);
    expect(savePlan[0]).toMatch(/_capPurgeAiVoice\(\)/);
    expect(skipPlan[0]).toMatch(/_capPurgeAiVoice\(\)/);
    expect(launch[0]).toMatch(/_capPurgeAiVoice\(\)/);
  });

  it('V7-3. store.js 仍不含任何删除文件的操作（删除判定与删除动作分离）', () => {
    const storeSrc = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8');
    expect(storeSrc).not.toMatch(/unlinkSync|rmSync|rmdirSync|trashItem|fs\.rm\s*\(/);
  });
});
