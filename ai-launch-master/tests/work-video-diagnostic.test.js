// Rokit · 成品视频归档链路诊断日志（v1.22.7）—— 定向测试
//
// 本批目标只有一个：让下一次真实运行能准确定位归档链路在哪个阶段中断。
// 因此测试的核心断言是：
//   1. 诊断日志覆盖到了链路上的每个关键阶段（renderer / ipc / main 三层）；
//   2. **诊断日志不改变任何业务结果**（返回值、调用次数、调用时机、判定条件全部不变）。
//
// 全部使用隔离临时目录 + mock，不发起真实发布、不碰生产数据库。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

// ---------- 按花括号配平切出具名函数 ----------
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
// A · 前缀与转发机制（renderer 日志必须能落到 rokit.log）
// =========================================================================
describe('A · 诊断日志前缀与持久化转发', () => {
  it('A1 · renderer 与主进程使用同一个 [work-video-diagnostic] 前缀', () => {
    expect(HTML_SRC).toMatch(/\[work-video-diagnostic\]/);
    expect(MAIN_SRC).toMatch(/const WORK_VIDEO_DIAG_PREFIX = '\[work-video-diagnostic\]'/);
  });

  it('A2 · renderer 诊断日志用 console 输出（主进程靠 console-message 转发）', () => {
    const fn = extractFn(HTML_SRC, 'function _workVideoDiag(stage, data){');
    expect(fn).toMatch(/console\.log\('\[work-video-diagnostic\] '/);
    // 日志本身必须包在 try/catch 里（失败不影响业务）
    expect(fn).toMatch(/try\{/);
    expect(fn).toMatch(/catch\(_e\)\{\}/);
  });

  it('A3 · 主窗口挂了 console-message 转发器，把带前缀的页面日志写进主 logger', () => {
    // 转发器函数存在
    expect(MAIN_SRC).toMatch(/function _attachWorkVideoDiagForwarder\(win\)/);
    const fwd = extractFn(MAIN_SRC, 'function _attachWorkVideoDiagForwarder(win) {');
    expect(fwd).toMatch(/console-message/);
    expect(fwd).toMatch(/WORK_VIDEO_DIAG_PREFIX/);
    expect(fwd).toMatch(/logger\[lv\]\(text\)/);
    // 转发器挂到主窗口
    expect(MAIN_SRC).toMatch(/_attachWorkVideoDiagForwarder\(win\)/);
  });

  it('A4 · 转发器兼容 Electron 36 的两种 console-message 签名', () => {
    const fwd = extractFn(MAIN_SRC, 'function _attachWorkVideoDiagForwarder(win) {');
    // 新版：第一个参数是 details 对象（details.message）
    expect(fwd).toMatch(/d\.message/);
    expect(fwd).toMatch(/d\.level/);
    // 旧版：第三个参数是文本
    expect(fwd).toMatch(/args\[2\]/);
  });

  it('A5 · 只转发带前缀的行，其它页面日志不转发', () => {
    const fwd = extractFn(MAIN_SRC, 'function _attachWorkVideoDiagForwarder(win) {');
    expect(fwd).toMatch(/text\.indexOf\(WORK_VIDEO_DIAG_PREFIX\) !== 0\) return/);
  });
});

// =========================================================================
// B · renderer 侧诊断覆盖点
// =========================================================================
describe('B · renderer 诊断覆盖点', () => {
  it('B1 · _persistFinalVideoForWork 记录：入口 / owner / API 存在 / IPC 发出 / 返回 / 异常', () => {
    const fn = extractFn(HTML_SRC, 'function _persistFinalVideoForWork(videoPath){');
    expect(fn).toMatch(/renderer\.persist\.enter/);
    expect(fn).toMatch(/renderer\.persist\.owner/);
    expect(fn).toMatch(/renderer\.persist\.no-api/);
    expect(fn).toMatch(/renderer\.persist\.api-check/);
    expect(fn).toMatch(/renderer\.persist\.ipc-returned/);
    expect(fn).toMatch(/renderer\.persist\.ipc-threw/);
    expect(fn).toMatch(/renderer\.persist\.ipc-sync-threw/);
    // owner 诊断必须包含实际值
    expect(fn).toMatch(/owner:owner/);
    expect(fn).toMatch(/hasOwner:!!owner/);
  });

  it('B2 · _archiveFinalVideoAfterPublish 记录：入口 / owner / API 存在 / IPC 发出 / 返回 / 异常', () => {
    const fn = extractFn(HTML_SRC, 'function _archiveFinalVideoAfterPublish(videoPath, ownerKey){');
    expect(fn).toMatch(/renderer\.archive\.enter/);
    expect(fn).toMatch(/renderer\.archive\.owner/);
    expect(fn).toMatch(/renderer\.archive\.api-check/);
    expect(fn).toMatch(/renderer\.archive\.ipc-sent/);
    expect(fn).toMatch(/renderer\.archive\.ipc-returned/);
    expect(fn).toMatch(/renderer\.archive\.ipc-threw/);
    expect(fn).toMatch(/renderer\.archive\.ipc-sync-threw/);
  });

  it('B3 · _rebindArchiveToSettledWork 记录入口与守卫依据', () => {
    const fn = extractFn(HTML_SRC, 'function _rebindArchiveToSettledWork(workId, fromOwner){');
    expect(fn).toMatch(/renderer\.rebind\.enter/);
    expect(fn).toMatch(/renderer\.rebind\.target-check/);
    expect(fn).toMatch(/renderer\.rebind\.rebind-done/);
    expect(fn).toMatch(/renderer\.rebind\.threw/);
    // 入口诊断必须包含 lastArchive 的关键字段（用于判断"归档是否曾成功"）
    expect(fn).toMatch(/lastOwner/);
    expect(fn).toMatch(/lastPath/);
    expect(fn).toMatch(/hasLastPath/);
  });

  it('B4 · _releaseDraftMappingAfterRebind 记录入口与目标校验', () => {
    const fn = extractFn(HTML_SRC, 'function _releaseDraftMappingAfterRebind(draftOwner, workId, expectedPath, archiveResult){');
    expect(fn).toMatch(/renderer\.release-draft\.enter/);
    expect(fn).toMatch(/renderer\.release-draft\.target-check/);
    expect(fn).toMatch(/renderer\.release-draft\.ipc-returned/);
    expect(fn).toMatch(/renderer\.release-draft\.threw/);
  });

  it('B5 · _restoreFinalVideoForWork 记录入口与读取结果', () => {
    const fn = extractFn(HTML_SRC, 'function _restoreFinalVideoForWork(workId){');
    expect(fn).toMatch(/renderer\.restore\.enter/);
    expect(fn).toMatch(/renderer\.restore\.ipc-returned/);
    expect(fn).toMatch(/renderer\.restore\.dropped/);
    expect(fn).toMatch(/renderer\.restore\.threw/);
  });

  it('B6 · 合成成功点记录路径与归属键', () => {
    const fn = extractFn(HTML_SRC, 'function _capBurnFinal(onDone){');
    expect(fn).toMatch(/renderer\.burn\.success/);
  });

  it('B7 · 四个发布成功调用点都记录了触发条件的布尔值', () => {
    // GitHub 单发
    expect(HTML_SRC).toMatch(/renderer\.publish\.github\.single\.success/);
    expect(HTML_SRC).toMatch(/renderer\.publish\.github\.single\.archive-done/);
    // GitHub 批量
    expect(HTML_SRC).toMatch(/renderer\.publish\.github\.batch\.success/);
    expect(HTML_SRC).toMatch(/renderer\.publish\.github\.batch\.archive-done/);
    // YouTube 单发
    expect(HTML_SRC).toMatch(/renderer\.publish\.youtube\.single\.success/);
    expect(HTML_SRC).toMatch(/renderer\.publish\.youtube\.single\.archive-done/);
    // YouTube 批量
    expect(HTML_SRC).toMatch(/renderer\.publish\.youtube\.batch\.success/);
    expect(HTML_SRC).toMatch(/renderer\.publish\.youtube\.batch\.archive-done/);
  });

  it('B8 · 每个发布成功点都记录了触发条件的各项布尔值', () => {
    const sites = [
      ['renderer.publish.github.single.success', /hasVideo:!!vid\.video[\s\S]*hasPublishVideoPath:!!_publishVideoPath[\s\S]*trigger:!!\(vid\.video && _publishVideoPath\)/],
      ['renderer.publish.github.batch.success', /hasVideo:!!\(gvid&&gvid\.video\)[\s\S]*hasGvidPath:!!gvidPath[\s\S]*trigger:!!\(gvid&&gvid\.video&&gvidPath\)/],
      ['renderer.publish.youtube.batch.success', /status:String\(\(ytR&&ytR\.status\)\|\|''\)[\s\S]*hasFinalVideoPath:!!ytPayload\.finalVideoPath[\s\S]*trigger:!!ytPayload\.finalVideoPath/],
      ['renderer.publish.youtube.single.success', /status:String\(\(r&&r\.status\)\|\|''\)[\s\S]*hasFinalVideoPath:!!ytP\.finalVideoPath[\s\S]*trigger:!!ytP\.finalVideoPath/]
    ];
    sites.forEach(function (s) {
      expect(HTML_SRC).toMatch(s[0]);
      expect(HTML_SRC).toMatch(s[1]);
    });
  });
});

// =========================================================================
// C · 主进程侧诊断覆盖点
// =========================================================================
describe('C · 主进程诊断覆盖点', () => {
  it('C1 · plan:save-final-video IPC 收到请求时有记录', () => {
    expect(MAIN_SRC).toMatch(/ipc\.plan\.save-final-video\.received/);
    expect(MAIN_SRC).toMatch(/ipc\.plan\.save-final-video\.returned/);
    // 这两个阶段在 saveWorkFinalVideo() 内部记录（plan:save-final-video 是其唯一调用方）
    const fn = extractFn(MAIN_SRC, 'function saveWorkFinalVideo(workId, videoPath) {');
    expect(fn).toMatch(/ipc\.plan\.save-final-video\.received/);
    expect(fn).toMatch(/ipc\.plan\.save-final-video\.returned/);
  });

  it('C2 · work-video:archive IPC 收到请求时有记录', () => {
    expect(MAIN_SRC).toMatch(/ipc\.work-video\.archive\.received/);
    expect(MAIN_SRC).toMatch(/ipc\.work-video\.archive\.returned/);
    expect(MAIN_SRC).toMatch(/ipc\.work-video\.archive\.exception/);
  });

  it('C3 · work-video:release-draft-mapping IPC 收到请求时有记录', () => {
    expect(MAIN_SRC).toMatch(/ipc\.work-video\.release-draft\.received/);
    expect(MAIN_SRC).toMatch(/ipc\.work-video\.release-draft\.returned/);
  });

  it('C4 · archiveFinalVideoForWork 记录了全部关键阶段', () => {
    const fn = extractFn(MAIN_SRC, 'function archiveFinalVideoForWork(workId, videoPath) {');
    expect(fn).toMatch(/main\.archive\.enter/);
    expect(fn).toMatch(/main\.archive\.owner-ok/);
    expect(fn).toMatch(/main\.archive\.owner-rejected/);
    expect(fn).toMatch(/main\.archive\.path-ok/);
    expect(fn).toMatch(/main\.archive\.path-rejected/);
    expect(fn).toMatch(/main\.archive\.dir-resolved/);
    expect(fn).toMatch(/main\.archive\.hash-ok/);
    expect(fn).toMatch(/main\.archive\.hash-failed/);
    expect(fn).toMatch(/main\.archive\.dedup-checked/);
    expect(fn).toMatch(/main\.archive\.mkdir-ok/);
    expect(fn).toMatch(/main\.archive\.copy-target/);
    expect(fn).toMatch(/main\.archive\.copy-verified/);
    expect(fn).toMatch(/main\.archive\.map-written/);
    expect(fn).toMatch(/main\.archive\.exception/);
  });

  it('C5 · saveWorkFinalVideo 记录了入口 / owner / 路径 / 映射写入', () => {
    const fn = extractFn(MAIN_SRC, 'function saveWorkFinalVideo(workId, videoPath) {');
    expect(fn).toMatch(/main\.save-final-video\.owner-ok/);
    expect(fn).toMatch(/main\.save-final-video\.owner-rejected/);
    expect(fn).toMatch(/main\.save-final-video\.path-ok/);
    expect(fn).toMatch(/main\.save-final-video\.path-rejected/);
    expect(fn).toMatch(/main\.save-final-video\.map-write-failed/);
  });

  it('C6 · 诊断日志不记录敏感数据（无 token / cookie / authorization 字样）', () => {
    const diagLines = [];
    MAIN_SRC.split('\n').forEach(function (l, i) {
      if (/_workVideoDiag\(|_workVideoDiagError\(/.test(l)) diagLines.push(l);
    });
    HTML_SRC.split('\n').forEach(function (l) {
      if (/_workVideoDiag\(/.test(l)) diagLines.push(l);
    });
    diagLines.forEach(function (l) {
      expect(l).not.toMatch(/token|cookie|authorization|access_token|refresh_token/i);
    });
  });
});

// =========================================================================
// D · 诊断日志不改变业务结果（核心回归）
// =========================================================================
describe('D · 诊断日志不改变业务结果', () => {
  // 从 index.html 切出 renderer 侧函数，注入 mock，验证返回值/调用次数不变
  function loadRendererFns() {
    const src = [
      extractFn(HTML_SRC, 'function _curVideoOwnerKey(){'),
      extractFn(HTML_SRC, 'function _workVideoDiag(stage, data){'),
      extractFn(HTML_SRC, 'function _persistFinalVideoForWork(videoPath){'),
      extractFn(HTML_SRC, 'function _archiveFinalVideoAfterPublish(videoPath, ownerKey){'),
      extractFn(HTML_SRC, 'function _restoreFinalVideoForWork(workId){')
    ].join('\n');
    const factory = new Function(
      'window', 'state', 'toast', 'console',
      src + '\nreturn { persist: _persistFinalVideoForWork, archive: _archiveFinalVideoAfterPublish, restore: _restoreFinalVideoForWork, owner: _curVideoOwnerKey };'
    );
    return factory;
  }

  function makeEnv(opts) {
    const o = opts || {};
    const calls = { save: [], archive: [], get: [], logs: [] };
    const state = o.state || { planOwnerId: 'w1', curWork: '' };
    const quietConsole = {
      log: function (m) { calls.logs.push(String(m)); },
      warn: function () {}, error: function () {}
    };
    const win = {
      api: {
        planSaveFinalVideo: function (owner, p) {
          calls.save.push({ owner: owner, path: p });
          return o.saveResult !== undefined ? Promise.resolve(o.saveResult) : Promise.resolve({ ok: true });
        },
        workVideoArchive: function (owner, p) {
          calls.archive.push({ owner: owner, path: p });
          return o.archiveResult !== undefined ? Promise.resolve(o.archiveResult) : Promise.resolve({ ok: true, path: p });
        },
        planGetFinalVideo: function (id) {
          calls.get.push(id);
          return o.getResult !== undefined ? Promise.resolve(o.getResult) : Promise.resolve({ ok: false, error: 'no-final-video' });
        }
      }
    };
    const api = loadRendererFns()(win, state, function () {}, quietConsole);
    return { api: api, calls: calls, state: state, win: win };
  }

  it('D1 · _persistFinalVideoForWork：返回值/调用次数不变（owner 非空时仍调用一次 IPC）', () => {
    const env = makeEnv();
    env.api.persist('C:/ud/temp/videos/final/final-x.mp4');
    expect(env.calls.save.length).toBe(1);
    expect(env.calls.save[0].owner).toBe('w1');
    expect(env.calls.save[0].path).toBe('C:/ud/temp/videos/final/final-x.mp4');
    // 诊断日志确实产生了
    expect(env.calls.logs.some(function (l) { return l.indexOf('[work-video-diagnostic]') === 0; })).toBe(true);
  });

  it('D2 · _persistFinalVideoForWork：owner 为空时仍**不调用** IPC（行为不变）', () => {
    const env = makeEnv({ state: { planOwnerId: '', curWork: '' } });
    env.api.persist('C:/ud/temp/videos/final/final-x.mp4');
    expect(env.calls.save.length).toBe(0);
    // 但诊断日志必须记录了这一点（否则线上无法定位）
    expect(env.calls.logs.some(function (l) { return l.indexOf('renderer.persist.owner') >= 0; })).toBe(true);
    expect(env.calls.logs.some(function (l) { return l.indexOf('hasOwner=false') >= 0; })).toBe(true);
  });

  it('D3 · _archiveFinalVideoAfterPublish：返回值与 IPC 调用不变', async () => {
    const env = makeEnv();
    const r = await env.api.archive('C:/ud/temp/videos/final/final-x.mp4');
    expect(r.ok).toBe(true);
    expect(env.calls.archive.length).toBe(1);
    expect(env.calls.archive[0].owner).toBe('w1');
    expect(env.calls.archive[0].path).toBe('C:/ud/temp/videos/final/final-x.mp4');
  });

  it('D4 · _archiveFinalVideoAfterPublish：owner 为空时仍返回 no-owner 且不发 IPC', async () => {
    const env = makeEnv({ state: { planOwnerId: '', curWork: '' } });
    const r = await env.api.archive('C:/ud/temp/videos/final/final-x.mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-owner');
    expect(env.calls.archive.length).toBe(0);
  });

  it('D5 · _archiveFinalVideoAfterPublish：IPC 不存在时仍返回 ipc-unavailable 且不发 IPC', async () => {
    const env = makeEnv();
    delete env.win.api.workVideoArchive;
    const r = await env.api.archive('C:/ud/temp/videos/final/final-x.mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('ipc-unavailable');
    expect(env.calls.archive.length).toBe(0);
    // 诊断日志记录了 API 缺失
    expect(env.calls.logs.some(function (l) { return l.indexOf('hasArchiveApi=false') >= 0; })).toBe(true);
  });

  it('D6 · _archiveFinalVideoAfterPublish：归档失败时返回值与 toast 行为不变', async () => {
    const env = makeEnv({ archiveResult: { ok: false, error: 'archive-copy-failed', detail: '复制失败' } });
    const r = await env.api.archive('C:/ud/temp/videos/final/final-x.mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('archive-copy-failed');
    expect(env.calls.archive.length).toBe(1);
    // 诊断日志记录了 error
    expect(env.calls.logs.some(function (l) { return l.indexOf('error=archive-copy-failed') >= 0; })).toBe(true);
  });

  it('D7 · _restoreFinalVideoForWork：读回行为不变（无映射时不动 state）', async () => {
    const env = makeEnv({ state: { planOwnerId: 'w1', curWork: 'w1' } });
    env.api.restore('w1');
    await Promise.resolve();
    await Promise.resolve();
    expect(env.state.__captionFinalVideo).toBeFalsy();
    expect(env.calls.get.length).toBe(1);
  });

  it('D8 · _restoreFinalVideoForWork：有映射时恢复成品视频状态（不变）', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1' },
      getResult: { ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 1024 }
    });
    env.api.restore('w1');
    await Promise.resolve();
    await Promise.resolve();
    expect(env.state.__captionFinalVideo.path).toBe('C:/ud/work-videos/final-1.mp4');
    expect(env.state.__captionFinalVideo.bytes).toBe(1024);
  });
});

// =========================================================================
// E · 主进程归档行为不变（诊断日志不影响返回值与副作用）
// =========================================================================
describe('E · 主进程归档行为不变', () => {
  let ud = '';
  let finalDir = '';
  let workDir = '';

  beforeEach(function () {
    ud = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-diag-'));
    finalDir = path.join(ud, 'temp', 'videos', 'final');
    workDir = path.join(ud, 'work-videos');
    fs.mkdirSync(finalDir, { recursive: true });
  });
  afterEach(function () {
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_e) {}
  });

  function loadMainFns(store, fsMock) {
    const src = [
      "const FINAL_VIDEO_KEY_PREFIX = 'finalVideo:';",
      "const WORK_VIDEO_DIAG_PREFIX = '[work-video-diagnostic]';",
      // 诊断日志用的 mock logger（记录调用，便于断言"日志没改变业务"）
      "var __diag = [];",
      extractFn(MAIN_SRC, 'function _workVideoDiag(stage, data) {')
        .replace(/logger\.info\(WORK_VIDEO_DIAG_PREFIX \+ ' ' \+ stage, payload\);/, '__diag.push(stage);')
        .replace(/logger\.error\(WORK_VIDEO_DIAG_PREFIX \+ ' ' \+ stage, payload\);/, '__diag.push(stage);'),
      extractFn(MAIN_SRC, 'function _workVideoDiagError(stage, data) {')
        .replace(/logger\.error\(WORK_VIDEO_DIAG_PREFIX \+ ' ' \+ stage, payload\);/, '__diag.push(stage);'),
      extractFn(MAIN_SRC, 'function managedFinalVideoRoots()'),
      extractFn(MAIN_SRC, 'function isInsideManagedFinalDir(resolvedPath, roots)'),
      extractFn(MAIN_SRC, 'function resolveFinalVideoFile(filePath)'),
      extractFn(MAIN_SRC, 'function normalizeVideoOwnerId(workId)'),
      extractFn(MAIN_SRC, 'function workVideosDir()'),
      extractFn(MAIN_SRC, 'function _fileSha256(filePath)'),
      extractFn(MAIN_SRC, 'function _findArchivedBySha256(sha, dir, srcSize)'),
      extractFn(MAIN_SRC, 'function _uniqueArchivePath(dir, fileName)'),
      extractFn(MAIN_SRC, 'function archiveFinalVideoForWork(workId, videoPath)')
    ].join('\n');
    const factory = new Function('app', 'fs', 'path', 'store', 'crypto',
      src + '\nreturn { archive: archiveFinalVideoForWork, diag: function(){ return __diag; } };');
    return factory(
      { getPath: function () { return ud; } },
      fsMock || fs, path, store, require('crypto')
    );
  }

  function makeStore() {
    const kv = {};
    const works = [{ id: 'w1' }, { id: 'w2' }];
    return {
      kv: kv,
      listWorks: function () { return works; },
      getSettingKv: function (k) { return kv[k] === undefined ? null : kv[k]; },
      upsertSettingKv: function (k, v) { kv[k] = String(v); return true; },
      deleteSettingKv: function (k) { delete kv[k]; return { ok: true }; },
      _listSettingKv: function (p) {
        return Object.keys(kv).filter(function (k) { return k.indexOf(p) === 0; })
          .map(function (k) { return { k: k, v: kv[k] }; });
      }
    };
  }

  it('E1 · 归档成功：返回值、映射、文件都正确，且诊断日志覆盖关键阶段', () => {
    const store = makeStore();
    const src = path.join(finalDir, 'final-a.mp4');
    fs.writeFileSync(src, 'BYTES');
    const M = loadMainFns(store);
    const r = M.archive('w1', src);
    expect(r.ok).toBe(true);
    expect(r.copied).toBe(true);
    expect(store.getSettingKv('finalVideo:w1')).toBe(r.path);
    expect(fs.existsSync(r.path)).toBe(true);
    // 诊断阶段齐全
    const d = M.diag();
    ['main.archive.enter', 'main.archive.owner-ok', 'main.archive.path-ok',
      'main.archive.dir-resolved', 'main.archive.hash-ok', 'main.archive.dedup-checked',
      'main.archive.mkdir-ok', 'main.archive.copy-target', 'main.archive.copy-verified',
      'main.archive.map-written'].forEach(function (s) {
      expect(d).toContain(s);
    });
  });

  it('E2 · 归档失败：返回值不变，且失败阶段被记录', () => {
    const store = makeStore();
    const src = path.join(finalDir, 'final-b.mp4');
    fs.writeFileSync(src, 'BYTES');
    const brokenFs = Object.assign({}, fs, {
      copyFileSync: function () { throw new Error('EACCES'); }
    });
    const M = loadMainFns(store, brokenFs);
    const r = M.archive('w1', src);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('archive-copy-failed');
    expect(store.getSettingKv('finalVideo:w1')).toBeFalsy();
    expect(M.diag()).toContain('main.archive.copy-failed');
  });

  it('E3 · 同一视频归档两次：仍然只产生一份文件（去重行为不变）', () => {
    const store = makeStore();
    const src = path.join(finalDir, 'final-c.mp4');
    fs.writeFileSync(src, 'BYTES');
    const M = loadMainFns(store);
    const a = M.archive('w1', src);
    const b = M.archive('w2', src);
    expect(a.path).toBe(b.path);
    expect(fs.readdirSync(workDir)).toHaveLength(1);
  });
});
