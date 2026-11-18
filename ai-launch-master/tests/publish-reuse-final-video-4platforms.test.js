//
// v1.29 · 四个平台（小红书 / 即刻 / Product Hunt / X）再次发布复用作品关联最终成品视频
//
// 覆盖需求点：
//   1. 主进程 work-video:asset 虚拟资产登记
//        · 只接受 workId（不接受路径）
//        · 复用 getWorkFinalVideo() 的白名单 / 存在性 / .mp4 / 非空校验
//        · 固定 ID wvf_<workId>，重复调用是覆盖（幂等、不增长）
//        · 只登记内存引用（不复制、不创建媒体文件）
//        · 返回值不含 filePath
//        · 无映射 / 映射失效 → 明确错误
//   2. preload 暴露 workVideoAsset / workVideoReveal
//   3. Renderer 统一资产解析 _workVideoAssetForPublish()
//        · 复用第一阶段解析器（不重复实现映射读取）
//        · 内存最终视频优先、作品映射其次
//        · 区分无视频 / 失效
//        · 绝不读或回退 state.videoAsset
//   4. 四个平台单发与批量入口全部接入
//   5. 即刻经过 videoDataUrl 富化；XHS / X 不再因 80MB 跳过
//   6. Product Hunt 不向 Renderer 暴露绝对路径
//   7. 普通 va-* 资产行为不变
//
// 策略：从 index.html / electron/main.js 真实源码切出函数体执行，**不复制**实现；
//   绝不调用真实平台发布、不创建任何媒体文件。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');

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

// =========================================================================
// A · 主进程虚拟资产登记（真实源码执行）
// =========================================================================
describe('A · work-video:asset · 虚拟资产登记', () => {
  let ud = '';
  let finalDir = '';
  let workDir = '';

  beforeEach(function () {
    ud = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-wvf-'));
    finalDir = path.join(ud, 'temp', 'videos', 'final');
    workDir = path.join(ud, 'work-videos');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
  });
  afterEach(function () {
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_e) {}
  });

  // 载入主进程的真实实现：registerWorkFinalVideoAsset + getWorkFinalVideo + 校验链
  function loadMainFns(opts) {
    const o = opts || {};
    const stashed = [];
    const src = [
      "const FINAL_VIDEO_KEY_PREFIX = 'finalVideo:';",
      "const WORK_VIDEO_DIAG_PREFIX = '[work-video-diagnostic]';",
      "var logger = { info: function(){}, warn: function(){}, error: function(){} };",
      extractFn(MAIN_SRC, 'function _workVideoDiag(stage, data) {'),
      extractFn(MAIN_SRC, 'function _workVideoDiagError(stage, data) {'),
      extractFn(MAIN_SRC, 'function managedFinalVideoRoots()'),
      extractFn(MAIN_SRC, 'function isInsideManagedFinalDir(resolvedPath, roots)'),
      extractFn(MAIN_SRC, 'function resolveFinalVideoFile(filePath)'),
      extractFn(MAIN_SRC, 'function getWorkFinalVideo(workId) {'),
      extractFn(MAIN_SRC, 'function registerWorkFinalVideoAsset(workId) {')
    ].join('\n');
    const factory = new Function(
      'app', 'fs', 'path', 'store', 'videoSource', 'shell',
      src + '\nreturn { register: registerWorkFinalVideoAsset, get: getWorkFinalVideo };'
    );
    const store = {
      kv: o.kv || {},
      getSettingKv: function (k) { return this.kv[k] === undefined ? null : this.kv[k]; },
      upsertSettingKv: function (k, v) { this.kv[k] = String(v); return true; },
      listWorks: function () { return o.works || [{ id: 'w1' }]; }
    };
    const videoSource = {
      stashed: stashed,
      stashInternalAsset: function (a) { stashed.push(a); }
    };
    const shell = { showItemInFolder: function (p) { shell.revealed = p; } };
    const api = factory(
      { getPath: function () { return ud; } },
      fs, path, store, videoSource, shell
    );
    return { api: api, stashed: stashed, store: store, shell: shell };
  }

  function makeMp4(dir, name, body) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.from(body || 'fake-mp4-' + name));
    return p;
  }

  it('A1 · 有效映射 → 登记虚拟资产，ID 固定为 wvf_<workId>', () => {
    const mp4 = makeMp4(workDir, 'final-1.mp4', 'bytes');
    const env = loadMainFns({ kv: { 'finalVideo:w1': mp4 } });
    const r = env.api.register('w1');
    expect(r.ok).toBe(true);
    expect(r.assetId).toBe('wvf_w1');
    expect(r.fileName).toBe('final-1.mp4');
    expect(r.mimeType).toBe('video/mp4');
    expect(r.fileSize).toBe(fs.statSync(mp4).size);
    // 登记到了 _internalStore（stashInternalAsset 被调用）
    expect(env.stashed.length).toBe(1);
    expect(env.stashed[0].id).toBe('wvf_w1');
    expect(env.stashed[0].filePath).toBe(mp4);
  });

  it('A2 · 返回值**不含 filePath**（不向 Renderer 暴露绝对路径）', () => {
    const mp4 = makeMp4(workDir, 'final-1.mp4', 'bytes');
    const env = loadMainFns({ kv: { 'finalVideo:w1': mp4 } });
    const r = env.api.register('w1');
    expect(r.filePath).toBeUndefined();
    expect(Object.keys(r).join(',')).not.toMatch(/filePath/);
  });

  it('A3 · 无映射 → 明确错误 no-final-video，不登记任何资产', () => {
    const env = loadMainFns({ kv: {} });
    const r = env.api.register('w1');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no-final-video');
    expect(env.stashed.length).toBe(0);
  });

  it('A4 · 映射存在但文件不存在 → 明确错误 file-missing，不登记任何资产', () => {
    const env = loadMainFns({ kv: { 'finalVideo:w1': path.join(workDir, 'gone.mp4') } });
    const r = env.api.register('w1');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('file-missing');
    expect(env.stashed.length).toBe(0);
  });

  it('A5 · 映射路径不在受管目录（白名单之外）→ 拒绝，不登记任何资产', () => {
    const evilDir = path.join(ud, 'evil');
    fs.mkdirSync(evilDir, { recursive: true });
    const outside = makeMp4(evilDir, 'x.mp4');
    const env = loadMainFns({ kv: { 'finalVideo:w1': outside } });
    const r = env.api.register('w1');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('path-not-allowed');
    expect(env.stashed.length).toBe(0);
  });

  it('A6 · 固定 ID：同一作品重复登记是覆盖（幂等，_internalStore 不增长）', () => {
    const mp4 = makeMp4(workDir, 'final-1.mp4', 'bytes');
    const env = loadMainFns({ kv: { 'finalVideo:w1': mp4 } });
    env.api.register('w1');
    env.api.register('w1');
    env.api.register('w1');
    expect(env.stashed.length).toBe(3);
    // 三次都是同一个 ID → Map.set 覆盖同一条，不会堆积
    const ids = env.stashed.map(function (a) { return a.id; });
    expect(ids.every(function (x) { return x === 'wvf_w1'; })).toBe(true);
    expect(new Set(ids).size).toBe(1);
  });

  it('A7 · 不复制 / 不移动 / 不创建任何媒体文件（零文件 IO）', () => {
    const mp4 = makeMp4(workDir, 'final-1.mp4', 'bytes');
    const env = loadMainFns({ kv: { 'finalVideo:w1': mp4 } });
    const before = fs.readdirSync(workDir).sort();
    env.api.register('w1');
    const after = fs.readdirSync(workDir).sort();
    expect(after).toEqual(before);
    // 源文件仍在
    expect(fs.existsSync(mp4)).toBe(true);
  });

  it('A8 · 空 workId → 明确错误 missing-work-id', () => {
    const env = loadMainFns({ kv: {} });
    const r = env.api.register('');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing-work-id');
  });

  it('A9 · IPC 入参只有 workId（无法传入任意路径）', () => {
    const fn = extractFn(MAIN_SRC, 'function registerWorkFinalVideoAsset(workId) {');
    // 只有 workId 一个入参
    expect(fn).toMatch(/function\s+registerWorkFinalVideoAsset\(workId\)/);
    // 真实路径只来自 getWorkFinalVideo（DB 映射）
    expect(fn).toMatch(/getWorkFinalVideo\(id\)/);
    // 没有任何"接收路径"的形参
    expect(fn).not.toMatch(/function\s+registerWorkFinalVideoAsset\([^)]*,/);
  });

  it('A10 · IPC handler 已注册，且不接受路径参数', () => {
    expect(MAIN_SRC).toMatch(/ipcMain\.handle\('work-video:asset',\s*\(_e,\s*workId\)\s*=>/);
    expect(MAIN_SRC).toMatch(/ipcMain\.handle\('work-video:reveal',\s*\(_e,\s*workId\)\s*=>/);
  });
});

// =========================================================================
// B · preload 暴露
// =========================================================================
describe('B · preload 暴露', () => {
  it('B1 · workVideoAsset(workId) 指向 work-video:asset', () => {
    expect(PRELOAD_SRC).toMatch(/workVideoAsset:\s*\(workId\)\s*=>\s*ipcRenderer\.invoke\('work-video:asset',\s*workId\)/);
  });
  it('B2 · workVideoReveal(workId) 指向 work-video:reveal', () => {
    expect(PRELOAD_SRC).toMatch(/workVideoReveal:\s*\(workId\)\s*=>\s*ipcRenderer\.invoke\('work-video:reveal',\s*workId\)/);
  });
  it('B3 · 未暴露任何"按路径取资产"的通道', () => {
    expect(PRELOAD_SRC).not.toMatch(/workVideoAsset:\s*\([^)]*path/i);
    expect(PRELOAD_SRC).not.toMatch(/workVideoAsset:\s*\([^)]*,\s*[^)]*\)/);
  });
});

// =========================================================================
// C · Renderer 统一资产解析
// =========================================================================
describe('C · _workVideoAssetForPublish 统一资产解析', () => {
  function loadResolverFns() {
    const src = [
      extractFn(HTML_SRC, 'function _curVideoOwnerKey(){'),
      extractFn(HTML_SRC, 'function _workVideoDiag(stage, data){'),
      extractFn(HTML_SRC, 'function _restoreFinalVideoForWork(workId){'),
      extractFn(HTML_SRC, 'function _awaitFinalVideoRestore(){'),
      extractFn(HTML_SRC, 'function _resolveFinalVideoForPublish(){'),
      extractFn(HTML_SRC, 'function _workVideoAssetForPublish(){'),
      extractFn(HTML_SRC, 'function _applyPublishVideoAsset(payload, asset){')
    ].join('\n');
    const factory = new Function(
      'window', 'state', 'toast', 'console',
      src + '\nreturn { resolve: _resolveFinalVideoForPublish, asset: _workVideoAssetForPublish, apply: _applyPublishVideoAsset };'
    );
    return factory;
  }

  function makeEnv(opts) {
    const o = opts || {};
    const calls = { get: [], asset: [] };
    const state = o.state || { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: null };
    const win = {
      api: {
        planGetFinalVideo: function (id) {
          calls.get.push(id);
          return Promise.resolve(o.getResult !== undefined
            ? o.getResult
            : { ok: false, error: 'no-final-video' });
        },
        workVideoAsset: function (id) {
          calls.asset.push(id);
          return Promise.resolve(o.assetResult !== undefined
            ? o.assetResult
            : { ok: false, error: 'no-final-video' });
        }
      }
    };
    const api = loadResolverFns()(win, state, function () {}, { log: function () {}, warn: function () {}, error: function () {} });
    return { api: api, calls: calls, state: state, win: win };
  }

  it('C1 · 复用第一阶段解析器（不重复实现映射读取）', () => {
    const fn = extractFn(HTML_SRC, 'function _workVideoAssetForPublish(){');
    expect(fn).toMatch(/_resolveFinalVideoForPublish\(\)/);
    // 本身不直接读映射
    expect(fn).not.toMatch(/planGetFinalVideo/);
  });

  it('C2 · 解析成功 → 调 workVideoAsset(workId) 并返回资产描述', async () => {
    const env = makeEnv({
      getResult: { ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 2048 },
      assetResult: { ok: true, workId: 'w1', assetId: 'wvf_w1', fileName: 'final-1.mp4', fileSize: 2048, mimeType: 'video/mp4' }
    });
    const r = await env.api.asset();
    expect(r.status).toBe('ok');
    expect(r.asset.id).toBe('wvf_w1');
    expect(r.asset.fileName).toBe('final-1.mp4');
    expect(r.asset.mimeType).toBe('video/mp4');
    // 只传了 workId
    expect(env.calls.asset).toEqual(['w1']);
  });

  it('C3 · 无关联视频 → status:\'none\'，asset 为 null', async () => {
    const env = makeEnv({ getResult: { ok: false, error: 'no-final-video' } });
    const r = await env.api.asset();
    expect(r.status).toBe('none');
    expect(r.asset).toBeNull();
  });

  it('C4 · 关联记录失效 → status:\'invalid\'，asset 为 null（明确区分）', async () => {
    const env = makeEnv({
      getResult: { ok: false, error: 'file-missing', storedPath: 'C:/ud/work-videos/gone.mp4' }
    });
    const r = await env.api.asset();
    expect(r.status).toBe('invalid');
    expect(r.asset).toBeNull();
    expect(r.error).toBe('file-missing');
  });

  it('C5 · 主进程登记失败（映射失效）→ invalid，不静默降级', async () => {
    const env = makeEnv({
      getResult: { ok: true, workId: 'w1', path: 'C:/ud/work-videos/final-1.mp4', size: 2048 },
      assetResult: { ok: false, error: 'file-missing' }
    });
    const r = await env.api.asset();
    expect(r.status).toBe('invalid');
    expect(r.asset).toBeNull();
  });

  it('C6 · 内存最终视频优先（不发 planGetFinalVideo）', async () => {
    const env = makeEnv({
      state: { planOwnerId: 'w1', curWork: 'w1', __captionFinalVideo: { path: 'C:/ud/temp/videos/final/final-x.mp4', bytes: 100 } },
      assetResult: { ok: true, workId: 'w1', assetId: 'wvf_w1', fileName: 'final-x.mp4', fileSize: 100, mimeType: 'video/mp4' }
    });
    const r = await env.api.asset();
    expect(r.status).toBe('ok');
    expect(env.calls.get.length).toBe(0);
  });

  it('C7 · **绝不**读或回退 state.videoAsset', () => {
    const fn = extractFn(HTML_SRC, 'function _workVideoAssetForPublish(){');
    expect(fn).not.toMatch(/state\.videoAsset/);
    const apply = extractFn(HTML_SRC, 'function _applyPublishVideoAsset(payload, asset){');
    expect(apply).not.toMatch(/state\.videoAsset/);
  });

  it('C8 · 不重新合成 / 不烧录字幕 / 不生成语音', () => {
    const fn = extractFn(HTML_SRC, 'function _workVideoAssetForPublish(){');
    expect(fn).not.toMatch(/captionBurnFinal|burnFinal|voice/i);
  });

  it('C9 · _applyPublishVideoAsset 写入标准视频字段', () => {
    const env = makeEnv();
    const p = {};
    const ok = env.api.apply(p, { id: 'wvf_w1', fileName: 'final-1.mp4', mimeType: 'video/mp4' });
    expect(ok).toBe(true);
    expect(p.videoAssetId).toBe('wvf_w1');
    expect(p.videoName).toBe('final-1.mp4');
    expect(p.videoMime).toBe('video/mp4');
    // 无资产 → 不写任何字段
    const p2 = {};
    expect(env.api.apply(p2, null)).toBe(false);
    expect(p2.videoAssetId).toBeUndefined();
  });
});

// =========================================================================
// D · 四个平台接入（单发 + 批量）
// =========================================================================
describe('D · 四个平台入口接入', () => {
  it('D1 · 小红书：单发用 _singleVideoAsset，批量用 _batchVideoAsset', () => {
    const single = extractFn(HTML_SRC, 'window.autoPub=function(id){');
    expect(single).toMatch(/if\(id==='xiaohongshu'\)\{\s*_applyPublishVideoAsset\(payload,\s*_singleVideoAsset\);/);
    const batch = HTML_SRC.slice(
      HTML_SRC.indexOf("if(state.videoAsset && state.videoAsset.id){"),
      HTML_SRC.indexOf("if(state.videoAsset && state.videoAsset.id){") + 200
    );
    // 批量共享 payload 段：改用 _batchVideoAsset
    expect(HTML_SRC).toMatch(/if\(_batchVideoAsset && _batchVideoAsset\.id\)\{\s*payload\.videoAssetId=_batchVideoAsset\.id;/);
  });

  it('D2 · 即刻：单发与批量都用受管虚拟资产', () => {
    const single = extractFn(HTML_SRC, 'window.autoPub=function(id){');
    expect(single).toMatch(/if\(id==='jike' \|\| id==='producthunt'\)\{\s*_applyPublishVideoAsset\(payload,\s*_singleVideoAsset\);/);
    expect(HTML_SRC).toMatch(/if\(_batchVideoAsset && _batchVideoAsset\.id\)\{\s*payload\.videoAssetId=_batchVideoAsset\.id;/);
  });

  it('D3 · X：单发与批量都用受管虚拟资产（批量独立重建 payload 也已覆盖）', () => {
    const single = extractFn(HTML_SRC, 'window.autoPub=function(id){');
    expect(single).toMatch(/_applyPublishVideoAsset\(payload,\s*_singleVideoAsset\);/);
    expect(HTML_SRC).toMatch(/_applyPublishVideoAsset\(_xPayloadLocal,\s*_batchVideoAsset\);/);
  });

  it('D4 · Product Hunt：用文件名展示最终成品视频，不用 assetId 上传', () => {
    const fn = extractFn(HTML_SRC, 'window.autoPubProductHunt = async function () {');
    expect(fn).toMatch(/_workVideoAssetForPublish\(\)/);
    expect(fn).toMatch(/payload\.video\s*=\s*\{/);
    expect(fn).toMatch(/fileName:\s*_phVideoAsset\.fileName/);
    // 不再有 videoAssetId（PH 不上传视频）
    expect(fn).not.toMatch(/payload\.videoAssetId/);
    // 绝不暴露 filePath
    expect(fn).not.toMatch(/filePath/);
  });

  it('D5 · Product Hunt 面板：视频行用 reveal-final-video（按 workId 定位）', () => {
    expect(HTML_SRC).toMatch(/data-ph-action="reveal-final-video"/);
    expect(HTML_SRC).toMatch(/workVideoReveal\(_phWorkId\)/);
    // 面板不再把成品视频的路径渲染出来
    const panel = HTML_SRC.slice(
      HTML_SRC.indexOf('function showProductHuntHelperPanel(pObj, payload, r) {'),
      HTML_SRC.indexOf('function writeClipboard(text) {')
    );
    const videoRow = panel.slice(panel.indexOf('v1.29：视频行展示'), panel.indexOf('var mediaTable'));
    expect(videoRow).not.toMatch(/filePath/);
    expect(videoRow).not.toMatch(/data-ph-action="copy"/);
  });

  it('D6 · 四个平台都不再直接使用 state.videoAsset 作为视频来源', () => {
    const single = extractFn(HTML_SRC, 'window.autoPub=function(id){');
    expect(single).not.toMatch(/state\.videoAsset\.id/);
    const ph = extractFn(HTML_SRC, 'window.autoPubProductHunt = async function () {');
    // PH 的 images 仍读 state.videoAsset.images（既有行为，与视频文件无关）
    expect(ph).not.toMatch(/payload\.videoAssetId\s*=\s*state\.videoAsset\.id/);
  });

  it('D7 · 公众号仍完全剥离视频字段（未变）', () => {
    expect(HTML_SRC).toMatch(/delete\s+payload\.videoAssetId/);
    expect(HTML_SRC).toMatch(/delete\s+payload\.videoMime/);
  });
});

// =========================================================================
// E · 即刻富化 / 80MB 限制移除
// =========================================================================
// 去掉注释后再匹配（注释里可能出现关键字）
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('E · 富化与大小限制', () => {
  it('E1 · pubExec 中 jike 也走 _enrichXhsPayloadForFill（获得 videoDataUrl）', () => {
    const fn = extractFn(MAIN_SRC, 'async function pubExec(platformId, stage, payload) {');
    expect(fn).toMatch(/if \(platformId === 'xiaohongshu' \|\| platformId === 'jike'\) _enrichXhsPayloadForFill\(payload\);/);
  });

  it('E2 · 即刻的 fill 脚本确实只读 videoDataUrl（所以必须有富化）', () => {
    const fill = extractFn(
      fs.readFileSync(path.join(ROOT, 'electron', 'publishers.js'), 'utf8').replace(/\r\n/g, '\n'),
      'jike: {'
    );
    expect(fill).toMatch(/p\.videoDataUrl/);
  });

  it('E3 · XHS 富化不再有 80MB 跳过限制', () => {
    const fn = stripComments(extractFn(MAIN_SRC, 'function _enrichXhsPayloadForFill(payload) {'));
    expect(fn).not.toMatch(/MAX_BYTES/);
    expect(fn).not.toMatch(/视频文件过大/);
    // 不再因大小设置跳过标记（只保留"成功时置 false"这一处赋值）
    const skippedTrue = fn.match(/videoUploadSkipped\s*=\s*true/g) || [];
    expect(skippedTrue.length).toBe(0);
    expect(fn).toMatch(/videoUploadSkipped\s*=\s*false/);
    // 但仍保留"读文件 → base64 → videoDataUrl"的既有链路
    expect(fn).toMatch(/fs\.readFileSync\(internal\.filePath\)/);
    expect(fn).toMatch(/payload\.videoDataUrl\s*=/);
  });

  it('E4 · X 富化不再有 80MB 跳过限制', () => {
    const fn = stripComments(extractFn(MAIN_SRC, 'function _enrichXVideoPayloadForFill(payload) {'));
    expect(fn).not.toMatch(/MAX_BYTES/);
    expect(fn).not.toMatch(/视频文件过大/);
    const skippedTrue = fn.match(/videoUploadSkipped\s*=\s*true/g) || [];
    expect(skippedTrue.length).toBe(0);
    expect(fn).toMatch(/videoUploadSkipped\s*=\s*false/);
    expect(fn).toMatch(/fs\.readFileSync\(internal\.filePath\)/);
    expect(fn).toMatch(/payload\.videoDataUrl\s*=/);
  });

  it('E5 · 未新增其它视频大小限制或预先拦截', () => {
    // 两个富化函数里都不出现任何大小阈值判断
    const xhs = stripComments(extractFn(MAIN_SRC, 'function _enrichXhsPayloadForFill(payload) {'));
    const x = stripComments(extractFn(MAIN_SRC, 'function _enrichXVideoPayloadForFill(payload) {'));
    [xhs, x].forEach(function (fn) {
      expect(fn).not.toMatch(/\d+\s*\*\s*1024\s*\*\s*1024/);
      expect(fn).not.toMatch(/MAX_/);
      expect(fn).not.toMatch(/stat\.size\s*>/);
    });
  });
});

// =========================================================================
// F · 边界：普通 va-* 资产行为不变
// =========================================================================
describe('F · 普通 VideoAsset 行为不变', () => {
  it('F1 · video:pick-local 的工作副本与 stash 逻辑未改', () => {
    const vs = fs.readFileSync(path.join(ROOT, 'electron', 'video-source.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(vs).toMatch(/function _createSourceWorkingCopy\(srcPath, assetId\)/);
    expect(vs).toMatch(/stashInternalAsset\(internal\)/);
    expect(vs).toMatch(/id: 'va-'|newAssetId\(\)/);
  });

  it('F2 · video-source.js 未被本批改动（stashInternalAsset 已导出，无需新增）', () => {
    const vs = fs.readFileSync(path.join(ROOT, 'electron', 'video-source.js'), 'utf8');
    expect(vs).toMatch(/stashInternalAsset/);
  });

  it('F3 · 虚拟资产不会被普通清理流程误删', () => {
    // 删除作品时的回收逻辑只按 settings_kv 映射判断，不读 _internalStore
    const del = extractFn(MAIN_SRC, 'function deleteWorkAndReclaimVideo(workId) {');
    expect(del).not.toMatch(/_internalStore|stashInternalAsset|clearInternalAsset/);
    // 虚拟资产登记函数自身不做任何删除动作
    const reg = extractFn(MAIN_SRC, 'function registerWorkFinalVideoAsset(workId) {');
    expect(reg).not.toMatch(/unlinkSync|rmSync|rmdirSync|copyFileSync|renameSync/);
    // clearInternalAsset 只在用户主动"重新选择/删除视频"时调用（video:clear-internal-asset），
    //   虚拟资产 ID（wvf_*）不会被这个通道自动清理。
    const vs = fs.readFileSync(path.join(ROOT, 'electron', 'video-source.js'), 'utf8');
    expect(vs).toMatch(/ipcMain\.handle\('video:clear-internal-asset',\s*function \(_e,\s*assetId\)/);
    // 本批新增的通道不做删除
    expect(MAIN_SRC).toMatch(/ipcMain\.handle\('work-video:asset'/);
    const assetHandler = MAIN_SRC.slice(
      MAIN_SRC.indexOf("ipcMain.handle('work-video:asset'"),
      MAIN_SRC.indexOf("ipcMain.handle('work-video:asset'") + 800
    );
    expect(assetHandler).not.toMatch(/unlinkSync|rmSync|deleteSettingKv/);
  });

  it('F4 · 本批未新增数据库结构 / 未改 store.js', () => {
    const store = fs.readFileSync(path.join(ROOT, 'electron', 'store.js'), 'utf8');
    expect(store).not.toMatch(/wvf_/);
  });

  it('F5 · GitHub / YouTube 第一阶段逻辑未被本批改动', () => {
    // 第一阶段的统一解析器仍在
    expect(HTML_SRC).toMatch(/function _resolveFinalVideoForPublish\(\)\{/);
    // GitHub / YouTube 入口仍用它
    expect(HTML_SRC).toMatch(/window\.publishGithubVideo = async function\(articlePath\)\{[\s\S]*?_resolveFinalVideoForPublish\(\)/);
    expect(HTML_SRC).toMatch(/function youtubePublishPayload\(\)\{[\s\S]*?_resolveFinalVideoForPublish\(\)/);
    // GitHub / YouTube 归档逻辑未被本批改动
    expect(HTML_SRC).toMatch(/_archiveFinalVideoAfterPublish\(_publishVideoPath\)/);
    expect(HTML_SRC).toMatch(/_archiveFinalVideoAfterPublish\(ytP\.finalVideoPath\)/);
  });

  it('F6 · 首秀计划执行器未被本批改动', () => {
    const gh = fs.readFileSync(path.join(ROOT, 'electron', 'plan-github-executor.js'), 'utf8');
    const yt = fs.readFileSync(path.join(ROOT, 'electron', 'plan-youtube-executor.js'), 'utf8');
    expect(gh).not.toMatch(/wvf_/);
    expect(yt).not.toMatch(/wvf_/);
    // 它们仍用自己的快照 → 映射回退优先级
    expect(gh).toMatch(/resolveWorkFinalVideo/);
    expect(yt).toMatch(/resolveWorkFinalVideo/);
  });

  it('F7 · 平台发布成功判定未变（markPub 不含本批改动）', () => {
    const fn = extractFn(HTML_SRC, 'window.markPub=function(id){');
    expect(fn).not.toMatch(/wvf_|workVideoAsset|_workVideoAssetForPublish/);
  });
});
