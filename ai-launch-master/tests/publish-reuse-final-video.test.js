//
// v1.27 · 再次发布时复用作品关联的最终成品视频（第一阶段）
//
// 覆盖需求点：
//   1. 统一解析逻辑 _resolveFinalVideoForPublish()：
//        · 优先使用当前有效的 state.__captionFinalVideo.path
//        · 内存无路径时调用既有 window.api.planGetFinalVideo(workId) 读作品关联视频
//        · 明确区分三种状态：none（无关联视频）/ ok（有关联且文件有效）/
//          invalid（有关联记录但文件不存在或路径无效）
//        · 映射失效时**不回退**原始视频
//   2. 异步恢复竞态：openWork 必须保存读回 Promise，发布入口先 await 它
//   3. 统一入口：GitHub 单发 / GitHub 批量 / GitHub Pages / YouTube 单发 / YouTube 批量
//      都必须走同一套解析逻辑
//   4. GitHub：无关联视频 → 保持纯文章；有关联记录但失效 → 明确失败（不静默降级）
//   5. YouTube：无关联视频 → 明确提示；有关联记录但失效 → 提示视频文件不可用（不改用原始视频）
//   6. 归档使用本次实际发布的最终视频路径，不因路径恢复而重复复制 / 重复建立映射
//
// 策略：全部从 index.html 真实源码切出函数体执行，**不复制**实现；
//   绝不调用真实平台 API、绝不读写生产 work-videos/ 目录。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

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

// ---------- 加载渲染层解析相关函数 ----------
function loadResolverFns() {
  const src = [
    extractFn(HTML_SRC, 'function _curVideoOwnerKey(){'),
    extractFn(HTML_SRC, 'function _workVideoDiag(stage, data){'),
    extractFn(HTML_SRC, 'function _restoreFinalVideoForWork(workId){'),
    extractFn(HTML_SRC, 'function _awaitFinalVideoRestore(){'),
    extractFn(HTML_SRC, 'function _resolveFinalVideoForPublish(){')
  ].join('\n');
  const factory = new Function(
    'window', 'state', 'toast', 'console',
    src + '\nreturn { restore: _restoreFinalVideoForWork, resolve: _resolveFinalVideoForPublish, owner: _curVideoOwnerKey };'
  );
  return factory;
}

function makeEnv(opts) {
  const o = opts || {};
  const calls = { get: [], archive: [] };
  const state = o.state || { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: null };
  const win = {
    api: {
      planGetFinalVideo: function (id) {
        calls.get.push(id);
        return o.getResult !== undefined
          ? Promise.resolve(o.getResult)
          : Promise.resolve({ ok: false, error: 'no-final-video' });
      }
    }
  };
  const quietConsole = { log: function () {}, warn: function () {}, error: function () {} };
  const api = loadResolverFns()(win, state, function () {}, quietConsole);
  return { api: api, calls: calls, state: state, win: win };
}

// =========================================================================
// A · 统一解析逻辑：三种状态
// =========================================================================
describe('A · _resolveFinalVideoForPublish · 三种状态明确区分', () => {
  it('A1 · 无关联视频 → status:\'none\'（可按纯文章处理）', async () => {
    const env = makeEnv({ getResult: { ok: false, error: 'no-final-video' } });
    const r = await env.api.resolve();
    expect(r.status).toBe('none');
    expect(r.path).toBe('');
    expect(r.hasMapping).toBe(false);
    // 读的是当前作品的作品 ID
    expect(env.calls.get).toEqual(['w1']);
  });

  it('A2 · 有关联记录且文件有效 → status:\'ok\'，路径取自映射', async () => {
    const env = makeEnv({
      getResult: { ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 2048 }
    });
    const r = await env.api.resolve();
    expect(r.status).toBe('ok');
    expect(r.path).toBe('C:/ud/work-videos/final-1.mp4');
    expect(r.bytes).toBe(2048);
    expect(r.source).toBe('work-latest');
    // 有效映射会恢复成内存里的可复用成品
    expect(env.state.__captionFinalVideo.path).toBe('C:/ud/work-videos/final-1.mp4');
  });

  it('A3 · 有关联记录但文件失效 → status:\'invalid\'（必须明确失败，不降级）', async () => {
    const env = makeEnv({
      getResult: { ok: false, error: 'file-missing', detail: '成品视频文件不存在', storedPath: 'C:/ud/work-videos/gone.mp4' }
    });
    const r = await env.api.resolve();
    expect(r.status).toBe('invalid');
    expect(r.path).toBe('');
    expect(r.hasMapping).toBe(true);
    expect(r.error).toBe('file-missing');
    // 绝不恢复任何视频 → 不可能回退到原始视频
    expect(env.state.__captionFinalVideo).toBeFalsy();
  });

  it('A4 · 路径无效（非白名单目录）同样判定为 invalid', async () => {
    const env = makeEnv({
      getResult: { ok: false, error: 'path-not-allowed', detail: '只能上传 Rokit 生成的成品视频', storedPath: 'C:/evil/x.mp4' }
    });
    const r = await env.api.resolve();
    expect(r.status).toBe('invalid');
    expect(r.error).toBe('path-not-allowed');
    expect(env.state.__captionFinalVideo).toBeFalsy();
  });

  it('A5 · 内存已有成品 → 优先使用内存路径，不发起 IPC', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: { path: 'C:/ud/temp/videos/final/final-x.mp4', bytes: 100 } },
      getResult: { ok: true, workId: 'w1', path: 'C:/ud/work-videos/other.mp4' }
    });
    const r = await env.api.resolve();
    expect(r.status).toBe('ok');
    expect(r.path).toBe('C:/ud/temp/videos/final/final-x.mp4');
    expect(r.source).toBe('memory');
    // 内存有成品 → 一次 IPC 都不发
    expect(env.calls.get.length).toBe(0);
  });

  it('A6 · 读取异常 → invalid（明确失败，不静默降级）', async () => {
    const env = makeEnv({
      getResult: undefined
    });
    env.win.api.planGetFinalVideo = function () { return Promise.reject(new Error('模拟 IPC 异常')); };
    const r = await env.api.resolve();
    expect(r.status).toBe('invalid');
    expect(r.error).toBe('exception');
  });

  it('A7 · 绝不回退到原始视频（解析器不读 state.videoAsset）', () => {
    const fn = extractFn(HTML_SRC, 'function _resolveFinalVideoForPublish(){');
    expect(fn).not.toMatch(/state\.videoAsset/);
    expect(fn).not.toMatch(/videoAssetId/);
  });
});

// =========================================================================
// B · 异步恢复竞态
// =========================================================================
describe('B · 打开作品后的异步恢复竞态', () => {
  it('B1 · _restoreFinalVideoForWork 返回 Promise（读回可被等待）', () => {
    const env = makeEnv({ getResult: { ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 10 } });
    const p = env.api.restore('w1');
    expect(p && typeof p.then === 'function').toBe(true);
  });

  it('B2 · openWork 把读回 Promise 存进 state.__finalVideoRestorePromise', () => {
    const fn = extractFn(HTML_SRC, 'window.openWork=function(id){');
    const at = fn.indexOf('state.__finalVideoRestorePromise');
    expect(at).toBeGreaterThan(0);
    expect(fn).toMatch(/state\.__finalVideoRestorePromise\s*=\s*_restoreFinalVideoForWork\(id\)/);
    // 清空成品状态的顺序不变（先清，再读回）
    const clearAt = fn.indexOf('state.__captionFinalVideo=null;');
    expect(clearAt).toBeGreaterThan(0);
    expect(at).toBeGreaterThan(clearAt);
  });

  it('B3 · 切换作品时清空上一部作品的解析状态（不串作品）', () => {
    const fn = extractFn(HTML_SRC, 'window.openWork=function(id){');
    expect(fn).toMatch(/state\.__publishFinalVideo\s*=\s*null/);
  });

  it('B4 · 发布入口先 await 读回完成，再解析视频路径（竞态被消除）', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: null, __finalVideoRestorePromise: null },
      getResult: { ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 1024 }
    });
    // 模拟 openWork 发起读回（尚未返回）
    let release;
    env.win.api.planGetFinalVideo = function () {
      return new Promise(function (res) { release = function () { res({ ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 1024 }); }; });
    };
    env.state.__finalVideoRestorePromise = env.api.restore('w1');
    // 发布入口此刻调用解析 → 必须等待
    const pending = env.api.resolve();
    let settled = false;
    pending.then(function () { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    // 读回还没完成 → 解析**不能**已经出结果
    expect(settled).toBe(false);
    // 放行读回
    release();
    const r = await pending;
    expect(r.status).toBe('ok');
    expect(r.path).toBe('C:/ud/work-videos/final-1.mp4');
  });

  it('B5 · 读回响应迟到（已切换作品）→ 丢弃，不写入任何作品的视频状态', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1' },
      getResult: { ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 1024 }
    });
    env.api.restore('w1');
    // 用户切到别的作品
    env.state.curWork = 'w2';
    await Promise.resolve();
    await Promise.resolve();
    expect(env.state.__captionFinalVideo).toBeFalsy();
    expect(env.state.__publishFinalVideo).toBeFalsy();
  });

  it('B6 · 读回响应迟到且是失效映射 → 也不写入失效结论（避免误判）', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1' },
      getResult: { ok: false, error: 'file-missing', storedPath: 'C:/ud/work-videos/gone.mp4' }
    });
    env.api.restore('w1');
    env.state.curWork = 'w2';
    await Promise.resolve();
    await Promise.resolve();
    expect(env.state.__publishFinalVideo).toBeFalsy();
  });

  it('B7 · 解析期间切换作品 → 丢弃本次映射结果', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: null },
      getResult: { ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 1024 }
    });
    let release;
    env.win.api.planGetFinalVideo = function () {
      return new Promise(function (res) { release = function () { res({ ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 1024 }); }; });
    };
    const pending = env.api.resolve();
    // 等解析器真正发起 IPC（它在 await 读回之后才调）
    await Promise.resolve();
    await Promise.resolve();
    env.state.curWork = 'w2';
    release();
    const r = await pending;
    // 别的作品的视频绝不进来
    expect(r.path).toBe('');
    expect(env.state.__captionFinalVideo).toBeFalsy();
  });
});

// =========================================================================
// C · 统一入口：五类入口都走同一套解析逻辑
// =========================================================================
describe('C · 入口统一性', () => {
  it('C1 · GitHub 单发 / 批量 / Pages 三类入口都调用统一解析器', () => {
    const single = extractFn(HTML_SRC, 'window.publishGithubVideo = async function(articlePath){');
    const pages = extractFn(HTML_SRC, 'window.publishGithubPages = async function(opts){');
    const batch = HTML_SRC.slice(
      HTML_SRC.indexOf("if(pid==='github'){"),
      HTML_SRC.indexOf('okCount++;markPub', HTML_SRC.indexOf("if(pid==='github'){"))
    );
    expect(single).toMatch(/_resolveFinalVideoForPublish\(\)/);
    expect(pages).toMatch(/_resolveFinalVideoForPublish\(\)/);
    // 批量：经由 publishGithubVideo / publishGithubPages → 间接统一
    expect(batch).toMatch(/publishGithubVideo/);
    expect(batch).toMatch(/publishGithubPages/);
  });

  it('C2 · YouTube 单发 / 批量都经由 youtubePublishPayload（内部走统一解析器）', () => {
    const payload = extractFn(HTML_SRC, 'function youtubePublishPayload(){');
    expect(payload).toMatch(/_resolveFinalVideoForPublish\(\)/);
    const single = extractFn(HTML_SRC, 'window.autoPub=function(id){');
    expect(single).toMatch(/youtubePublishPayload\(\)/);
    const batch = HTML_SRC.slice(
      HTML_SRC.indexOf("if(pid==='youtube'){"),
      HTML_SRC.indexOf("if(pid==='youtube'){") + 4000
    );
    expect(batch).toMatch(/youtubePublishPayload\(\)/);
  });

  it('C3 · 五个入口都不再直接用 state.videoAsset 作为视频来源', () => {
    const single = extractFn(HTML_SRC, 'window.publishGithubVideo = async function(articlePath){');
    const pages = extractFn(HTML_SRC, 'window.publishGithubPages = async function(opts){');
    const payload = extractFn(HTML_SRC, 'function youtubePublishPayload(){');
    [single, pages, payload].forEach(function (fn) {
      expect(fn).not.toMatch(/state\.videoAsset/);
    });
  });

  it('C4 · 解析器只读作品关联映射（finalVideo:<workId>），不新增 IPC', () => {
    const fn = extractFn(HTML_SRC, 'function _resolveFinalVideoForPublish(){');
    expect(fn).toMatch(/planGetFinalVideo/);
    // preload / 主进程未新增通道（本批只改 index.html）
    const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
    const before = (preload.match(/planGetFinalVideo/g) || []).length;
    expect(before).toBe(1);
  });
});

// =========================================================================
// D · GitHub：无关联视频保持纯文章；有关联记录但失效必须明确失败
// =========================================================================
describe('D · GitHub 三态行为', () => {
  async function runPublishVideo(getResult, state) {
    const src = [
      extractFn(HTML_SRC, 'function articleBaseName(name){'),
      extractFn(HTML_SRC, 'function _curVideoOwnerKey(){'),
      extractFn(HTML_SRC, 'function _workVideoDiag(stage, data){'),
      extractFn(HTML_SRC, 'function _restoreFinalVideoForWork(workId){'),
      extractFn(HTML_SRC, 'function _awaitFinalVideoRestore(){'),
      extractFn(HTML_SRC, 'function _resolveFinalVideoForPublish(){'),
      extractFn(HTML_SRC, 'window.publishGithubVideo = async function(articlePath){')
    ].join('\n');
    const calls = { putVideo: [] };
    const st = state || { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: null, copies: {}, project: { name: 'Demo' } };
    const win = {
      api: {
        planGetFinalVideo: function () {
          return Promise.resolve(getResult);
        },
        githubPutVideo: function (p) {
          calls.putVideo.push(p);
          return Promise.resolve({ ok: true, videoPath: 'videos/demo.mp4', coverPath: 'videos/demo-cover.jpg' });
        }
      }
    };
    const factory = new Function('window', 'state', 'console',
      src + '\nreturn window.publishGithubVideo;');
    const fn = factory(win, st, { log: function () {}, warn: function () {}, error: function () {} });
    const r = await fn('posts/demo.md');
    return { r: r, calls: calls, state: st };
  }

  it('D1 · 无关联视频 → 纯文章发布（ok:true, video:null），不上传视频', async () => {
    const env = await runPublishVideo({ ok: false, error: 'no-final-video' });
    expect(env.r.ok).toBe(true);
    expect(env.r.video).toBeFalsy();
    expect(env.calls.putVideo.length).toBe(0);
  });

  it('D2 · 有关联记录且文件有效 → 上传该成品视频', async () => {
    const env = await runPublishVideo({ ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 512 });
    expect(env.r.ok).toBe(true);
    expect(env.r.video).toBeTruthy();
    expect(env.calls.putVideo.length).toBe(1);
    expect(env.calls.putVideo[0].finalVideoPath).toBe('C:/ud/work-videos/final-1.mp4');
  });

  it('D3 · 有关联记录但文件失效 → **明确失败**，绝不静默降级为纯文章', async () => {
    const env = await runPublishVideo({ ok: false, error: 'file-missing', detail: '成品视频文件不存在', storedPath: 'C:/ud/work-videos/gone.mp4' });
    expect(env.r.ok).toBe(false);
    expect(env.r.stage).toBe('final-video');
    expect(env.r.error).toBe('file-missing');
    expect(env.r.videoStatus).toBe('invalid');
    // 绝不上传视频、绝不发成纯文章
    expect(env.calls.putVideo.length).toBe(0);
    expect(env.r.video).toBeFalsy();
  });
});

// =========================================================================
// E · GitHub Pages：失效时明确失败（不静默跳过）
// =========================================================================
describe('E · GitHub Pages 三态行为', () => {
  async function runPages(getResult) {
    const src = [
      extractFn(HTML_SRC, 'function articleBaseName(name){'),
      extractFn(HTML_SRC, 'function _curVideoOwnerKey(){'),
      extractFn(HTML_SRC, 'function _workVideoDiag(stage, data){'),
      extractFn(HTML_SRC, 'function _restoreFinalVideoForWork(workId){'),
      extractFn(HTML_SRC, 'function _awaitFinalVideoRestore(){'),
      extractFn(HTML_SRC, 'function _resolveFinalVideoForPublish(){'),
      extractFn(HTML_SRC, 'window.publishGithubPages = async function(opts){')
    ].join('\n');
    const calls = { publishPages: [] };
    const st = { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: null, copies: {}, project: { name: 'Demo' } };
    const win = {
      api: {
        planGetFinalVideo: function () { return Promise.resolve(getResult); },
        githubPublishPages: function (p) {
          calls.publishPages.push(p);
          return Promise.resolve({ ok: true, pageUrl: 'https://x', deployStatus: 'built' });
        }
      }
    };
    const factory = new Function('window', 'state', 'console',
      src + '\nreturn window.publishGithubPages;');
    const fn = factory(win, st, { log: function () {}, warn: function () {}, error: function () {} });
    const r = await fn({ title: 'T', body: 'B' });
    return { r: r, calls: calls };
  }

  it('E1 · 无关联视频 → 跳过网页（保留纯文章流程）', async () => {
    const env = await runPages({ ok: false, error: 'no-final-video' });
    expect(env.r.ok).toBe(true);
    expect(env.r.pages).toBeFalsy();
    expect(env.r.skipped).toBe('no-final-video');
    expect(env.calls.publishPages.length).toBe(0);
  });

  it('E2 · 有关联记录且文件有效 → 用该成品视频发网页', async () => {
    const env = await runPages({ ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 512 });
    expect(env.r.ok).toBe(true);
    expect(env.calls.publishPages.length).toBe(1);
    expect(env.calls.publishPages[0].finalVideoPath).toBe('C:/ud/work-videos/final-1.mp4');
  });

  it('E3 · 有关联记录但文件失效 → 明确失败（不静默跳过）', async () => {
    const env = await runPages({ ok: false, error: 'file-missing', storedPath: 'C:/ud/work-videos/gone.mp4' });
    expect(env.r.ok).toBe(false);
    expect(env.r.stage).toBe('final-video');
    expect(env.r.videoStatus).toBe('invalid');
    expect(env.calls.publishPages.length).toBe(0);
  });
});

// =========================================================================
// F · YouTube：无视频明确提示；关联记录失效明确提示文件不可用
// =========================================================================
describe('F · YouTube 三态行为', () => {
  async function runPayload(getResult) {
    const src = [
      extractFn(HTML_SRC, 'function _curVideoOwnerKey(){'),
      extractFn(HTML_SRC, 'function _workVideoDiag(stage, data){'),
      extractFn(HTML_SRC, 'function _restoreFinalVideoForWork(workId){'),
      extractFn(HTML_SRC, 'function _awaitFinalVideoRestore(){'),
      extractFn(HTML_SRC, 'function _resolveFinalVideoForPublish(){'),
      extractFn(HTML_SRC, 'function youtubePublishPayload(){')
    ].join('\n');
    const st = { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: null, copies: {}, project: { name: 'Demo' } };
    const win = {
      api: { planGetFinalVideo: function () { return Promise.resolve(getResult); } }
    };
    const factory = new Function('window', 'state', 'console',
      src + '\nreturn youtubePublishPayload;');
    const fn = factory(win, st, { log: function () {}, warn: function () {}, error: function () {} });
    const r = await fn();
    return { r: r, state: st };
  }

  it('F1 · 无关联视频 → finalVideoPath 为空且 videoStatus=\'none\'', async () => {
    const env = await runPayload({ ok: false, error: 'no-final-video' });
    expect(env.r.finalVideoPath).toBeFalsy();
    expect(env.r.videoStatus).toBe('none');
  });

  it('F2 · 有关联记录且文件有效 → finalVideoPath 指向该成品视频', async () => {
    const env = await runPayload({ ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 512 });
    expect(env.r.finalVideoPath).toBe('C:/ud/work-videos/final-1.mp4');
    expect(env.r.videoStatus).toBe('ok');
    expect(env.r.finalVideoName).toBe('final-1.mp4');
  });

  it('F3 · 有关联记录但文件失效 → videoStatus=\'invalid\'，绝不改用原始视频', async () => {
    const env = await runPayload({ ok: false, error: 'file-missing', storedPath: 'C:/ud/work-videos/gone.mp4' });
    expect(env.r.finalVideoPath).toBeFalsy();
    expect(env.r.videoStatus).toBe('invalid');
    expect(env.r.videoError).toBe('file-missing');
    // payload 里绝不出现原始视频通道
    expect(env.r.videoAssetId).toBeUndefined();
  });

  it('F4 · YouTube 两个入口都区分「无视频」与「视频失效」两种提示', () => {
    const single = extractFn(HTML_SRC, 'window.autoPub=function(id){');
    const batch = HTML_SRC.slice(
      HTML_SRC.indexOf("if(pid==='youtube'){"),
      HTML_SRC.indexOf("if(pid==='youtube'){") + 4000
    );
    [single, batch].forEach(function (seg) {
      expect(seg).toMatch(/videoStatus==='invalid'/);
      expect(seg).toMatch(/尚未生成最终成品视频/);
    });
  });
});

// =========================================================================
// G · 归档：使用本次实际发布的路径，不重复复制 / 不改映射
// =========================================================================
describe('G · 归档与路径一致性', () => {
  it('G1 · GitHub 单发：归档路径取自统一解析结果', () => {
    const fn = extractFn(HTML_SRC, 'window.autoPubGithub=async function(){');
    expect(fn).toMatch(/state\.__publishFinalVideo/);
    expect(fn).toMatch(/_publishVideoPath/);
    // 归档用的是同一个 _publishVideoPath
    expect(fn).toMatch(/_archiveFinalVideoAfterPublish\(_publishVideoPath\)/);
  });

  it('G2 · GitHub 批量：归档路径取自统一解析结果', () => {
    const start = HTML_SRC.indexOf("if(pid==='github'){");
    const batch = HTML_SRC.slice(start, start + 6000);
    expect(batch).toMatch(/state\.__publishFinalVideo/);
    expect(batch).toMatch(/_archiveFinalVideoAfterPublish\(gvidPath\)/);
  });

  it('G3 · YouTube 归档仍用本次实际发布的 finalVideoPath', () => {
    const payload = extractFn(HTML_SRC, 'function youtubePublishPayload(){');
    expect(payload).toMatch(/finalVideoPath:\s*fvPath/);
    const single = extractFn(HTML_SRC, 'window.autoPub=function(id){');
    expect(single).toMatch(/_archiveFinalVideoAfterPublish\(ytP\.finalVideoPath\)/);
  });

  it('G4 · 恢复路径不触发新的映射写入（解析器只读映射，不写）', () => {
    const fn = extractFn(HTML_SRC, 'function _resolveFinalVideoForPublish(){');
    expect(fn).not.toMatch(/planSaveFinalVideo/);
    expect(fn).not.toMatch(/workVideoArchive/);
    expect(fn).not.toMatch(/upsert/);
  });

  it('G5 · 解析器不重新合成 / 不烧录字幕 / 不生成语音', () => {
    const fn = extractFn(HTML_SRC, 'function _resolveFinalVideoForPublish(){');
    expect(fn).not.toMatch(/captionBurnFinal/);
    expect(fn).not.toMatch(/voice/i);
    expect(fn).not.toMatch(/burnFinal/);
  });
});

// =========================================================================
// H · 本批边界：未改动其它平台 / 未改主进程与 preload
// =========================================================================
describe('H · 本批边界', () => {
  it('H1 · 小红书 / 即刻 / Product Hunt / X 改用受管虚拟资产（v1.29），公众号仍剥离视频字段', () => {
    // v1.29：四个平台改用统一解析出的受管虚拟资产（wvf_<workId>），
    //   不再直接读 state.videoAsset（原始视频工作副本）。
    expect(HTML_SRC).toMatch(/_applyPublishVideoAsset\(payload,\s*_singleVideoAsset\)/);
    expect(HTML_SRC).toMatch(/_applyPublishVideoAsset\(_xPayloadLocal,\s*_batchVideoAsset\)/);
    // 解析器绝不回退到原始视频
    const resolver = HTML_SRC.slice(
      HTML_SRC.indexOf('function _workVideoAssetForPublish(){'),
      HTML_SRC.indexOf('function _applyPublishVideoAsset(payload, asset){')
    );
    expect(resolver).not.toMatch(/state\.videoAsset/);
    // 公众号仍剥离视频字段（未变）
    expect(HTML_SRC).toMatch(/delete\s+payload\.videoAssetId/);
  });

  it('H2 · 公众号仍剥离视频字段（未变）', () => {
    expect(HTML_SRC).toMatch(/delete\s+payload\.videoAssetId/);
  });

  it('H3 · 主进程 / preload 未新增 IPC 通道', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
    expect((preload.match(/planGetFinalVideo/g) || []).length).toBe(1);
    const planIpc = fs.readFileSync(path.join(ROOT, 'electron', 'plan-ipc.js'), 'utf8');
    expect((planIpc.match(/ipcMain\.handle\('plan:get-final-video'/g) || []).length).toBe(1);
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    // 主进程只暴露既有的 getWorkFinalVideo 注入，未新增通道
    expect((main.match(/getWorkFinalVideo: getWorkFinalVideo/g) || []).length).toBe(1);
  });

  it('H4 · 平台发布成功判定未变（markPub 语义不受影响）', () => {
    const fn = extractFn(HTML_SRC, 'window.markPub=function(id){');
    expect(fn).toMatch(/status==='ok'/);
    expect(fn).not.toMatch(/_resolveFinalVideoForPublish/);
    expect(fn).not.toMatch(/publishFinalVideo/);
  });
});
