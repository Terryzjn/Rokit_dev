//
// Rokit · 手动确认发布成功 → 归档最终成品视频（v1.30）—— 定向测试
//
// 覆盖需求：
//   M1  手动确认成功后触发归档（markPubManual 确认回调）
//   M2  六个平台 + 报告列出的其他手动成功入口均接入共享逻辑
//   M3  手动记录没有 URL / video_id 时仍然归档
//   M4  纯文案发布（无成品视频）不触发视频归档，也不报错
//   M5  归档 owner 用 _curVideoOwnerKey()（草稿归属），**不是**旧 curWork
//   M6  改名派生新作品后，归档最终正确关联新作品
//   M7  归档失败不改变发布成功状态、不删除源视频
//   M8  同一视频重复触发归档不产生重复文件（主进程真实源码 SHA-256 去重）
//   M9  绝不把原始 source 视频（state.videoAsset）当作最终成品归档
//
// 策略：全部从 index.html / electron/main.js 真实源码切出函数体执行，
//   **不复制**实现；不写真实 work-videos/ 目录、不调用任何真实平台 API、
//   不读写生产数据库 .userdata/ai-launch-master.db。
//

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

// ---------- 按花括号配平切出函数体 ----------
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

// ---------- 渲染层：归档相关函数集合 ----------
const RENDER_SRC = [
  extractFn(HTML_SRC, 'function _curVideoOwnerKey(){'),
  extractFn(HTML_SRC, 'function _workVideoDiag(stage, data){'),
  extractFn(HTML_SRC, 'function _archiveFinalVideoAfterPublish(videoPath, ownerKey){'),
  extractFn(HTML_SRC, 'function _resolveFinalVideoForManualArchive(){'),
  extractFn(HTML_SRC, 'function _archiveFinalVideoOnManualSuccess(){'),
  extractFn(HTML_SRC, 'function _rebindArchiveToSettledWork(workId, fromOwner){'),
  extractFn(HTML_SRC, 'function _releaseDraftMappingAfterRebind(draftOwner, workId, expectedPath, archiveResult){')
].join('\n');

function loadRenderFns() {
  const factory = new Function(
    'window', 'state', 'toast', 'console',
    RENDER_SRC + '\nreturn {'
    + ' owner: _curVideoOwnerKey,'
    + ' archive: _archiveFinalVideoAfterPublish,'
    + ' resolveManual: _resolveFinalVideoForManualArchive,'
    + ' manualSuccess: _archiveFinalVideoOnManualSuccess,'
    + ' rebind: _rebindArchiveToSettledWork,'
    + ' release: _releaseDraftMappingAfterRebind };'
  );
  return factory;
}

// ---------- 渲染层运行环境 ----------
function makeEnv(opts) {
  const o = opts || {};
  const calls = { archive: [], get: [], release: [], toasts: [] };
  const state = o.state || { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: null };
  const win = {
    api: {
      workVideoArchive: function (workId, videoPath) {
        calls.archive.push({ workId: workId, videoPath: videoPath });
        if (o.archiveResult !== undefined) return Promise.resolve(o.archiveResult);
        return Promise.resolve({ ok: true, path: 'C:/rokit/work-videos/final-1.mp4' });
      },
      planGetFinalVideo: function (id) {
        calls.get.push(id);
        return Promise.resolve(o.getResult !== undefined
          ? o.getResult
          : { ok: false, error: 'no-final-video' });
      },
      workVideoReleaseDraftMapping: function (draftOwner, workId, expectedPath) {
        calls.release.push({ draftOwner: draftOwner, workId: workId, expectedPath: expectedPath });
        return Promise.resolve({ ok: true, released: true });
      }
    }
  };
  const toast = function (m, level) { calls.toasts.push({ m: String(m), level: level }); };
  const quietConsole = { log: function () {}, warn: function () {}, error: function () {} };
  const api = loadRenderFns()(win, state, toast, quietConsole);
  return { api: api, calls: calls, state: state, win: win };
}

// =========================================================================
// M1 / M3 / M4 / M5 / M7 · 共享 helper 的行为
// =========================================================================
describe('M1 · 手动成功归档 helper · 行为', () => {
  it('M1-1 · 有内存成品 → 触发归档，owner = _curVideoOwnerKey()', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'draft_new', curWork: 'w1', __captionFinalVideo: { path: 'C:/rokit/temp/final-1.mp4' } }
    });
    const r = await env.api.manualSuccess();
    expect(r.ok).toBe(true);
    expect(env.calls.archive.length).toBe(1);
    expect(env.calls.archive[0].workId).toBe('draft_new');
    expect(env.calls.archive[0].videoPath).toBe('C:/rokit/temp/final-1.mp4');
    // 内存成品优先 → 不需要读映射
    expect(env.calls.get.length).toBe(0);
  });

  it('M3-1 · 记录没有 URL / video_id 时照样归档（不依赖链接）', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: { path: 'C:/rokit/temp/final-1.mp4' } }
    });
    const r = await env.api.manualSuccess();
    expect(r.ok).toBe(true);
    expect(env.calls.archive.length).toBe(1);
  });

  it('M4-1 · 纯文案发布（无内存成品 + 无映射）→ 不归档、不报错', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: null },
      getResult: { ok: false, error: 'no-final-video' }
    });
    const r = await env.api.manualSuccess();
    expect(r.ok).toBe(false);
    expect(r.status).toBe('none');
    expect(env.calls.archive.length).toBe(0);
    // 纯文案发布不产生任何失败提示
    expect(env.calls.toasts.length).toBe(0);
  });

  it('M5-1 · 草稿 owner 优先（planOwnerId 是草稿时，不用旧 curWork）', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'draft_mwg0f3kq_4zrht2', curWork: 'w1', __captionFinalVideo: null },
      getResult: { ok: true, workId: 'draft_mwg0f3kq_4zrht2', path: 'C:/rokit/temp/final-1.mp4' }
    });
    const r = await env.api.manualSuccess();
    expect(r.ok).toBe(true);
    // 读的是草稿归属的映射
    expect(env.calls.get).toEqual(['draft_mwg0f3kq_4zrht2']);
    // 归档 owner 是草稿，**不是**旧作品 w1
    expect(env.calls.archive[0].workId).toBe('draft_mwg0f3kq_4zrht2');
    expect(env.calls.archive[0].workId).not.toBe('w1');
  });

  it('M5-2 · 归属键来自 _curVideoOwnerKey()（planOwnerId 优先于 curWork）', async () => {
    const env = makeEnv({ state: { planOwnerId: 'draft_a', curWork: 'w1' } });
    expect(env.api.owner()).toBe('draft_a');
    const env2 = makeEnv({ state: { planOwnerId: '', curWork: 'w7' } });
    expect(env2.api.owner()).toBe('w7');
  });

  it('M6-1 · 映射存在但文件失效 → 明确提示，不归档、不回退原始视频', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: null, videoAsset: { id: 'va-1', filePath: 'C:/rokit/temp/source.webm' } },
      getResult: { ok: false, error: 'file-missing', detail: '成品视频文件不存在', storedPath: 'C:/rokit/work-videos/gone.mp4' }
    });
    const r = await env.api.manualSuccess();
    expect(r.ok).toBe(false);
    expect(r.status).toBe('invalid');
    expect(env.calls.archive.length).toBe(0);
    // 有明确提示
    expect(env.calls.toasts.some(function (t) { return t.m.indexOf('成品视频文件不可用') >= 0; })).toBe(true);
    // 绝不把原始 source 视频当最终成品归档
    expect(env.calls.archive.some(function (c) { return String(c.videoPath).indexOf('source.webm') >= 0; })).toBe(false);
  });

  it('M9-1 · 解析器绝不读 state.videoAsset（原始 source 视频）', () => {
    const fn = extractFn(HTML_SRC, 'function _resolveFinalVideoForManualArchive(){');
    expect(fn).not.toMatch(/state\.videoAsset/);
    const fn2 = extractFn(HTML_SRC, 'function _archiveFinalVideoOnManualSuccess(){');
    expect(fn2).not.toMatch(/state\.videoAsset/);
  });

  it('M9-2 · 原始视频存在但没有成品视频 → 绝不归档原始视频', async () => {
    const env = makeEnv({
      state: {
        planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: null,
        videoAsset: { id: 'va-1', filePath: 'C:/rokit/temp/videos/source/va-1.webm' }
      },
      getResult: { ok: false, error: 'no-final-video' }
    });
    await env.api.manualSuccess();
    expect(env.calls.archive.length).toBe(0);
  });

  it('M7-1 · 归档失败 → 只提示，不改写发布结果（不抛错）', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: { path: 'C:/rokit/temp/final-1.mp4' } },
      archiveResult: { ok: false, error: 'archive-copy-failed', detail: '磁盘写入失败' }
    });
    const r = await env.api.manualSuccess();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('archive-copy-failed');
    // 有失败提示，但没有抛异常（调用方不会被中断）
    expect(env.calls.toasts.some(function (t) { return t.m.indexOf('归档失败') >= 0; })).toBe(true);
  });

  it('M7-2 · 归档 IPC 抛异常 → 归档 helper 吞掉异常并提示，不影响发布结果', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: { path: 'C:/rokit/temp/final-1.mp4' } }
    });
    env.win.api.workVideoArchive = function () { return Promise.reject(new Error('IPC 炸了')); };
    const r = await env.api.manualSuccess();
    expect(r.ok).toBe(false);
    expect(env.calls.toasts.some(function (t) { return t.m.indexOf('归档') >= 0; })).toBe(true);
  });
});

// =========================================================================
// M6 · 改名派生新作品后，最终关联到新作品
// =========================================================================
describe('M6 · 草稿归档最终转正到新作品', () => {
  it('M6-2 · 草稿 owner 归档 → 作品落库后补挂到新作品 ID（复用已归档路径，不复制）', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'draft_new', curWork: 'w1', __captionFinalVideo: { path: 'C:/rokit/temp/final-1.mp4' } }
    });
    // 手动确认 → 归档落在草稿归属上
    await env.api.manualSuccess();
    expect(env.calls.archive.length).toBe(1);
    expect(env.calls.archive[0].workId).toBe('draft_new');

    // 作品落库（新作品 w3）→ launch() 的 rebind 链路
    env.win.api.planGetFinalVideo = function (id) {
      env.calls.get.push(id);
      // 目标作品尚无映射 → 需要补挂
      return Promise.resolve({ ok: false, error: 'no-final-video' });
    };
    env.state.__lastArchive = { owner: 'draft_new', source: 'C:/rokit/temp/final-1.mp4', path: 'C:/rokit/work-videos/final-1.mp4' };
    env.api.rebind('w3', 'draft_new');
    for (let i = 0; i < 8; i++) await Promise.resolve();

    // 补挂到新作品 w3，且复用已归档路径（主进程直接复用，不复制到自身）
    expect(env.calls.archive.length).toBe(2);
    expect(env.calls.archive[1].workId).toBe('w3');
    expect(env.calls.archive[1].videoPath).toBe('C:/rokit/work-videos/final-1.mp4');
    // 旧作品 w1 从未出现在归档里
    expect(env.calls.archive.some(function (c) { return c.workId === 'w1'; })).toBe(false);
  });

  it('M6-3 · 改名派生场景下映射解析不被「curWork !== owner」守卫丢弃', async () => {
    // curWork 仍是旧作品 w1，owner 是草稿 → 草稿映射必须能被读到
    const env = makeEnv({
      state: { planOwnerId: 'draft_new', curWork: 'w1', __captionFinalVideo: null },
      getResult: { ok: true, workId: 'draft_new', path: 'C:/rokit/temp/final-1.mp4' }
    });
    const r = await env.api.resolveManual();
    expect(r.status).toBe('ok');
    expect(r.path).toBe('C:/rokit/temp/final-1.mp4');
    expect(r.owner).toBe('draft_new');
  });

  it('M6-4 · 归档进行中归属已转正（planOwnerId 变成真实作品）→ 自动补挂到该作品', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'draft_new', curWork: 'w1', __captionFinalVideo: { path: 'C:/rokit/temp/final-1.mp4' } }
    });
    env.win.api.planGetFinalVideo = function (id) {
      env.calls.get.push(id);
      return Promise.resolve({ ok: false, error: 'no-final-video' });
    };
    // 归档 IPC 执行期间，作品恰好落库、归属已转正（state.planOwnerId 变成 w3）
    env.win.api.workVideoArchive = function (workId, videoPath) {
      env.calls.archive.push({ workId: workId, videoPath: videoPath });
      env.state.planOwnerId = 'w3';
      return Promise.resolve({ ok: true, path: 'C:/rokit/work-videos/final-1.mp4' });
    };
    await env.api.manualSuccess();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    const owners = env.calls.archive.map(function (c) { return c.workId; });
    // 先落在草稿上，随后自动补挂到真实作品 w3
    expect(owners[0]).toBe('draft_new');
    expect(owners).toContain('w3');
    // 旧作品 w1 从未出现在归档里（绝不串作品）
    expect(owners).not.toContain('w1');
    // 补挂复用已归档路径（主进程直接复用，不复制到自身）
    const rebindCall = env.calls.archive.filter(function (c) { return c.workId === 'w3'; })[0];
    expect(rebindCall.videoPath).toBe('C:/rokit/work-videos/final-1.mp4');
  });
});

// =========================================================================
// M2 · 所有手动成功入口都接入共享逻辑（源码级）
// =========================================================================
describe('M2 · 手动成功入口接入', () => {
  const CALL = '_archiveFinalVideoOnManualSuccess(';

  it('M2-1 · markPubManual 确认回调接入归档', () => {
    const fn = extractFn(HTML_SRC, 'window.markPubManual=function(id){');
    expect(fn).toContain(CALL);
    // 必须在 markPub 之后（发布记录写完才归档）
    expect(fn.indexOf('markPub(id,{status:\'manual\',source:\'manual-mark\'') >= 0).toBe(true);
    expect(fn.indexOf(CALL)).toBeGreaterThan(fn.indexOf('markPub(id,{status:\'manual\',source:\'manual-mark\''));
  });

  it('M2-2 · 火箭批量：X / Product Hunt / 通用浏览器（两处）都接入', () => {
    const fn = extractFn(HTML_SRC, 'window.rocketGo=async function(){');
    const n = fn.split(CALL).length - 1;
    expect(n).toBe(4);
    // X 分支
    expect(fn).toMatch(/markPub\('x',\{status:'manual',error:''\}\);[\s\S]{0,200}?_archiveFinalVideoOnManualSuccess\(/);
    // Product Hunt 分支
    expect(fn).toMatch(/markPub\('producthunt',\{status:'manual',source:'auto'\}\);[\s\S]{0,200}?_archiveFinalVideoOnManualSuccess\(/);
    // 通用浏览器：filled→人工确认 与 「请在发布窗口手动完成」两处
    expect(fn).toMatch(/markPub\(pid,\{status:'manual',source:'auto'\}\);[\s\S]{0,200}?_archiveFinalVideoOnManualSuccess\(/);
  });

  it('M2-3 · 单发：X / 通用浏览器 / 小红书 / 旧 X 回退路径都接入', () => {
    const fn = extractFn(HTML_SRC, 'window.autoPub=function(id){');
    const n = fn.split(CALL).length - 1;
    expect(n).toBe(5);
    // X（browserXPublish 路径）
    expect(fn).toMatch(/markPub\('x',\{status:'manual',source:'auto'\}\);[\s\S]{0,200}?_archiveFinalVideoOnManualSuccess\(/);
    // 通用浏览器（pObj.auto → 平台侧人工完成）
    expect(fn).toMatch(/markPub\(id,\{status:'manual',source:'auto'\}\);[\s\S]{0,200}?_archiveFinalVideoOnManualSuccess\(/);
    // 小红书
    expect(fn).toMatch(/markPub\(id,\{status:'manual',source:'auto'\}\);[\s\S]{0,200}?_archiveFinalVideoOnManualSuccess\(/);
    // 旧 X 回退路径（markPub(id) 无参数）
    expect(fn).toMatch(/markPub\(id\);[\s\S]{0,200}?_archiveFinalVideoOnManualSuccess\(/);
  });

  it('M2-4 · 全量入口计数：1（markPubManual）+ 4（火箭）+ 5（单发）= 10 个调用点', () => {
    const n = HTML_SRC.split(CALL).length - 1;
    // 减去函数定义那一次
    expect(n).toBe(11);
  });

  it('M2-5 · 自动发送成功后的既有归档调用保持不变', () => {
    expect(HTML_SRC).toMatch(/_archiveFinalVideoAfterPublish\(_publishVideoPath\)/);
    expect(HTML_SRC).toMatch(/_archiveFinalVideoAfterPublish\(gvidPath\)/);
    expect(HTML_SRC).toMatch(/_archiveFinalVideoAfterPublish\(ytPayload\.finalVideoPath\)/);
    expect(HTML_SRC).toMatch(/_archiveFinalVideoAfterPublish\(ytP\.finalVideoPath\)/);
  });

  it('M2-6 · markPub 本身不含归档调用（幂等键 / 计数 / 写库语义不变）', () => {
    const fn = extractFn(HTML_SRC, 'window.markPub=function(id){');
    expect(fn).not.toMatch(/workVideoArchive/);
    expect(fn).not.toMatch(/_archiveFinalVideoAfterPublish/);
    expect(fn).not.toMatch(/_archiveFinalVideoOnManualSuccess/);
  });

  it('M2-7 · 失败分支不触发归档（只有成功才归档）', () => {
    const fn = extractFn(HTML_SRC, 'window.autoPub=function(id){');
    // failed 记录旁不得出现归档调用
    expect(fn).not.toMatch(/markPub\(id,\{status:'failed'[^}]*\}\);[\s\S]{0,120}?_archiveFinalVideoOnManualSuccess\(/);
    const rocket = extractFn(HTML_SRC, 'window.rocketGo=async function(){');
    expect(rocket).not.toMatch(/markPub\('x',\{status:'failed'[^}]*\}\);[\s\S]{0,120}?_archiveFinalVideoOnManualSuccess\(/);
    expect(rocket).not.toMatch(/markPub\('producthunt',\{status:'failed'[^}]*\}\);[\s\S]{0,120}?_archiveFinalVideoOnManualSuccess\(/);
  });

  it('M2-8 · preload / main.js / 数据库结构未被本批改动', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
    expect(preload).not.toMatch(/manualSuccess|manual-success/);
    expect(MAIN_SRC).not.toMatch(/manualSuccess|manual-success/);
    const store = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8');
    expect(store).not.toMatch(/manualSuccess|manual-success/);
  });
});

// =========================================================================
// M8 · 重复触发归档不产生重复文件（主进程真实源码）
// =========================================================================
describe('M8 · 重复归档不产生重复文件（主进程真实源码）', () => {
  let ud = '';
  let finalDir = '';
  let workDir = '';

  beforeEach(function () {
    ud = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-manual-archive-'));
    finalDir = path.join(ud, 'temp', 'videos', 'final');
    workDir = path.join(ud, 'work-videos');
    fs.mkdirSync(finalDir, { recursive: true });
  });

  afterEach(function () {
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_e) {}
  });

  function loadArchiveFns(store) {
    const src = [
      "const FINAL_VIDEO_KEY_PREFIX = 'finalVideo:';",
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
      extractFn(MAIN_SRC, 'function archiveFinalVideoForWork(workId, videoPath)')
    ].join('\n');
    const factory = new Function(
      'app', 'fs', 'path', 'store', 'crypto',
      src + '\nreturn { archiveFinalVideoForWork: archiveFinalVideoForWork };'
    );
    return factory(
      { getPath: function () { return ud; } },
      fs, path, store, crypto
    );
  }

  function makeStore() {
    const kv = {};
    return {
      kv: kv,
      listWorks: function () { return [{ id: 'w1' }, { id: 'w3' }]; },
      getSettingKv: function (k) { return kv[k] === undefined ? null : kv[k]; },
      upsertSettingKv: function (k, v) { kv[k] = String(v); return true; },
      deleteSettingKv: function (k) { delete kv[k]; return { ok: true }; },
      _listSettingKv: function (prefix) {
        return Object.keys(kv)
          .filter(function (k) { return k.indexOf(prefix) === 0; })
          .map(function (k) { return { k: k, v: kv[k] }; });
      }
    };
  }

  it('M8-1 · 同一视频连续归档 6 次（对应 6 个平台手动确认）→ 只产生一份归档文件', () => {
    const src = path.join(finalDir, 'final-p10a3i.mp4');
    fs.writeFileSync(src, Buffer.from('FINAL-BYTES-' + 'x'.repeat(64)));
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns(store);

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(archiveFinalVideoForWork('w3', src));
    }
    // 只复制了一次，其余 5 次命中 SHA-256 内容去重
    expect(results.filter(function (r) { return r.copied; }).length).toBe(1);
    expect(results.filter(function (r) { return r.deduplicated; }).length).toBe(5);
    // 归档目录里只有一个文件
    const files = fs.readdirSync(workDir).filter(function (f) { return /\.mp4$/.test(f); });
    expect(files.length).toBe(1);
    // 所有结果指向同一份归档
    const paths = results.map(function (r) { return r.path; });
    expect(new Set(paths).size).toBe(1);
    // 映射指向归档后的路径
    expect(store.getSettingKv('finalVideo:w3')).toBe(paths[0]);
    // 源文件保留（绝不删除临时源视频）
    expect(fs.existsSync(src)).toBe(true);
  });

  it('M8-2 · 归档失败不删除源视频（主进程语义）', () => {
    const src = path.join(finalDir, 'final-keep.mp4');
    fs.writeFileSync(src, Buffer.from('KEEP-BYTES'));
    const store = makeStore();
    const { archiveFinalVideoForWork } = loadArchiveFns(store);
    // 归属不存在的作品 → 主进程拒绝
    const r = archiveFinalVideoForWork('w_not_exist', src);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown-work');
    // 源文件仍在
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.readFileSync(src, 'utf8')).toBe('KEEP-BYTES');
  });
});
