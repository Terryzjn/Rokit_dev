// Rokit · GitHub 文章 + 最终 MP4 同仓发布
//
// 覆盖需求第七节的验证点（全部使用模拟数据 / 测试替身，不发起真实发布）：
//   1. 单发流程与批量发射流程都能携带最终视频资源
//   2. 上传的 MP4 来源是最终成品（state.__captionFinalVideo.path），不是原始视频
//   3. 二进制文件上传方式正确（base64 编码原始字节，不是 UTF-8 文本）
//   4. 封面引用与 MP4 路径一致（同一 slug）
//   5. 文章正文及原有发布参数保持不变（path / branch / message 不变）
//   6. 文件不存在 / 过大 / 封面提取失败 / 视频上传失败 / 文章上传失败时状态准确
//   7. 不泄露本地绝对路径和密钥
//   8. 没有视频的原有文章发布流程不受影响
//   9. XTTS-v2 / 字幕编辑器 / 冻结时间轴 / 其他平台未被修改
//
// 策略：publisher-extensions.js 顶层 require('./oauth') 会拉起 electron，
//   故按仓库既有做法（github-publish-repo.test.js）用 vi.mock 隔离 oauth 后
//   直接 require 真实模块；纯路径 / 文案逻辑用同构副本测试并加源码断言防漂移。

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// publisher-extensions.js 在模块加载时就捕获了 globalThis.fetch，
// 所以替身必须在 require 之前装好；这里用一个可变的 handlers 槽位来切换每个用例的响应。
const __fetchState = { handlers: null, calls: [] };
globalThis.fetch = async function (url, init) {
  const method = (init && init.method) || 'GET';
  const body = init && init.body ? JSON.parse(init.body) : null;
  const rec = { url: String(url), method: method, body: body, headers: (init && init.headers) || {} };
  __fetchState.calls.push(rec);
  const handlers = __fetchState.handlers;
  // handlers 以 method 为键；值可以是单个响应，也可以是按该 method 调用次序排布的数组
  let h = handlers ? handlers[method] : undefined;
  if (Array.isArray(h)) h = h[__fetchState.calls.filter((c) => c.method === method).length - 1];
  if (typeof h === 'function') h = h(__fetchState.calls);
  if (!h) throw new Error('unexpected request: ' + method + ' ' + url);
  return h;
};

vi.mock('../electron/oauth', () => ({
  getTokenForInternal: async () => ({ access_token: 'test-token', publishRepo: { owner: 'acme', repo: 'posts' } }),
  start: async () => ({ ok: true }),
  status: async () => ({ ok: true }),
  disconnect: async () => ({ ok: true }),
  saveCredential: async () => ({ ok: true }),
  refresh: async () => ({ ok: true }),
  getValidAccessToken: async () => 'test-token'
}));

const pubex = require('../electron/publisher-extensions');

// ---------------------------------------------------------------- fetch 替身
function makeRes(status, body, ok) {
  return {
    status: status,
    ok: ok !== undefined ? ok : (status >= 200 && status < 300),
    json: async () => body,
    text: async () => JSON.stringify(body || {})
  };
}

// 切换本用例的响应，返回本次调用记录数组
function installFetch(handlers) {
  __fetchState.handlers = handlers;
  __fetchState.calls = [];
  return __fetchState.calls;
}

// ------------------------------------------------ 1) 二进制上传方式（真模块）
describe('githubPutBinary · 二进制上传', () => {
  beforeEach(() => { vi.resetModules(); });

  it('按原始字节 base64 编码，不做 UTF-8 文本转换', async () => {
    // 含 0x00/0xFF 等非 UTF-8 安全字节的二进制
    const bin = Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const calls = installFetch({
      GET: makeRes(404, {}),
      PUT: makeRes(201, { content: { path: 'videos/demo.mp4', sha: 's1', html_url: 'u1' }, commit: { sha: 'c1' } })
    });
    const r = await pubex.githubPutBinary('t', {
      owner: 'acme', repo: 'posts', path: 'videos/demo.mp4', buffer: bin, branch: 'main'
    });
    expect(r.ok).toBe(true);
    expect(r.bytes).toBe(bin.length);

    const put = calls.find((c) => c.method === 'PUT');
    // 关键：base64 必须等于原始 Buffer 的 base64
    expect(put.body.content).toBe(bin.toString('base64'));
    // 若被当成 UTF-8 文本处理，字节数会变化 —— 这里显式反证
    expect(put.body.content).not.toBe(Buffer.from(bin.toString('latin1'), 'utf8').toString('base64'));
    expect(put.body.branch).toBe('main');
  });

  it('文件已存在时带 sha 走 update，不带 sha 走 create', async () => {
    const bin = Buffer.from('abc');
    const calls = installFetch({
      GET: makeRes(200, { sha: 'oldsha' }),
      PUT: makeRes(200, { content: { path: 'videos/demo.mp4', sha: 'n', html_url: 'u' }, commit: { sha: 'c' } })
    });
    const r = await pubex.githubPutBinary('t', { owner: 'acme', repo: 'posts', path: 'videos/demo.mp4', buffer: bin });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('updated');
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.body.sha).toBe('oldsha');
  });

  it('空 Buffer 被拒绝', async () => {
    installFetch({});
    const r = await pubex.githubPutBinary('t', { owner: 'a', repo: 'b', path: 'videos/x.mp4', buffer: Buffer.alloc(0) });
    expect(r).toMatchObject({ ok: false, error: 'empty-file' });
  });

  it('超过 100MB 上限明确报错，不静默跳过也不压缩', async () => {
    const calls = installFetch({});
    // 构造 >100MB 的稀疏 buffer（只测长度判断，不真读文件）
    const big = Buffer.alloc(pubex.GH_MAX_FILE_BYTES + 1);
    const r = await pubex.githubPutBinary('t', { owner: 'a', repo: 'b', path: 'videos/big.mp4', buffer: big });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('file-too-large');
    expect(r.max).toBe(100 * 1024 * 1024);
    // 关键：超限时不应发出任何网络请求
    expect(calls.length).toBe(0);
  });

  it('401 / 403 / 404 / 422 分别映射为可读错误，不吞掉失败', async () => {
    for (const code of [401, 403, 404, 422]) {
      // GET 探测走 404（文件不存在 → create），PUT 才返回目标错误码
      installFetch({ GET: makeRes(404, {}), PUT: makeRes(code, { message: 'boom-' + code }, false) });
      const r = await pubex.githubPutBinary('t', { owner: 'a', repo: 'b', path: 'videos/x.mp4', buffer: Buffer.from('z') });
      expect(r.ok).toBe(false);
      // 错误码以 status 或错误文案形式保留，不能被吞掉
      expect(String(r.status || r.error || r.detail)).toContain(String(code));
    }
  });

  it('网络异常返回 network 错误，不报告成功', async () => {
    installFetch({ GET: async () => { throw new Error('ECONNRESET'); } });
    const r = await pubex.githubPutBinary('t', { owner: 'a', repo: 'b', path: 'videos/x.mp4', buffer: Buffer.from('z') });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/network/);
  });

  it('githubPutFile 仍按 UTF-8 编码文本（原文案行为不变）', async () => {
    const calls = installFetch({
      GET: makeRes(404, {}),
      PUT: makeRes(201, { content: { path: 'posts/a.md', sha: 's', html_url: 'u' }, commit: { sha: 'c' } })
    });
    const r = await pubex.githubPutFile('t', { owner: 'acme', repo: 'posts', path: 'posts/a.md', content: '你好' });
    expect(r.ok).toBe(true);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.body.content).toBe(Buffer.from('你好', 'utf8').toString('base64'));
  });
});

// ------------------------------------- 2) 最终视频路径白名单（同构副本 + 源码断言）
// 复制自 electron/main.js resolveFinalVideoFile，验证路径约束不被放宽
function resolveFinalVideoFile(filePath, allowedRoot) {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: 'no-final-video', detail: '尚未生成成品视频，请先完成字幕与配音生成' };
  }
  const resolved = path.resolve(filePath);
  if (!allowedRoot) return { ok: false, error: 'no-allowed-root' };
  const rel = path.relative(allowedRoot, resolved);
  if (!rel || rel.indexOf('..') === 0 || path.isAbsolute(rel)) {
    return { ok: false, error: 'path-not-allowed', detail: '只能上传 Rokit 生成的成品视频' };
  }
  if (path.extname(resolved).toLowerCase() !== '.mp4') {
    return { ok: false, error: 'not-mp4', detail: '成品视频必须是 .mp4' };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: 'file-missing', detail: '成品视频文件不存在' };
  }
  const st = fs.statSync(resolved);
  if (!st.isFile() || st.size <= 0) return { ok: false, error: 'file-empty' };
  return { ok: true, filePath: resolved, size: st.size };
}

describe('最终视频路径白名单 · resolveFinalVideoFile', () => {
  let root;
  let realFile;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-final-'));
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    realFile = path.join(root, 'sub', 'final-123.mp4');
    fs.writeFileSync(realFile, Buffer.from('fake-mp4-bytes'));
  });
  afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) {} });

  it('接受白名单目录内的 .mp4', () => {
    const r = resolveFinalVideoFile(realFile, root);
    expect(r.ok).toBe(true);
    expect(r.size).toBeGreaterThan(0);
  });

  it('拒绝白名单之外的任意路径（不能借 IPC 读任意文件）', () => {
    expect(resolveFinalVideoFile(path.join(os.tmpdir(), 'secrets.txt'), root).error).toBe('path-not-allowed');
    expect(resolveFinalVideoFile(root + path.sep + '..' + path.sep + 'escape.mp4', root).error).toBe('path-not-allowed');
  });

  it('拒绝非 .mp4', () => {
    const txt = path.join(root, 'sub', 'a.txt');
    fs.writeFileSync(txt, 'x');
    expect(resolveFinalVideoFile(txt, root).error).toBe('not-mp4');
  });

  it('拒绝空路径与不存在的文件', () => {
    expect(resolveFinalVideoFile('', root).error).toBe('no-final-video');
    expect(resolveFinalVideoFile(null, root).error).toBe('no-final-video');
    expect(resolveFinalVideoFile(path.join(root, 'nope.mp4'), root).error).toBe('file-missing');
  });

  it('拒绝零字节文件', () => {
    const empty = path.join(root, 'sub', 'empty.mp4');
    fs.writeFileSync(empty, '');
    expect(resolveFinalVideoFile(empty, root).error).toBe('file-empty');
  });

  it('main.js 真实源码使用同一套白名单约束', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    const start = src.indexOf('function resolveFinalVideoFile(');
    expect(start).toBeGreaterThan(0);
    const fn = src.slice(start, src.indexOf('\n}', start) + 2);
    expect(fn).toMatch(/userData'\),\s*'video',\s*'final'/);
    expect(fn).toMatch(/rel\.indexOf\('\.\.'\)\s*===\s*0/);
    expect(fn).toMatch(/path\.isAbsolute\(rel\)/);
    expect(fn).toMatch(/'\.mp4'/);
  });
});

// ------------------------------------------- 3) 相对路径规则与正文追加（同构副本）
// 复制自 index.html articleBaseName / githubRelativeFromPosts / appendVideoSection
function articleBaseName(name, now) {
  var s = String(name || 'project').trim().toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!s) s = 'project';
  var d = now || new Date();
  var pad = function (n) { return n < 10 ? ('0' + n) : ('' + n); };
  var ds = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  return s + '-' + ds;
}
function githubRelPrefix(articlePath) {
  var p = String(articlePath || '').replace(/^\/+/, '');
  var dir = p.indexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '';
  var depth = dir ? dir.split('/').filter(Boolean).length : 0;
  return new Array(Math.max(depth, 1) + 1).join('../');
}
function appendVideoSection(body, up) {
  var rel = githubRelPrefix(up.articlePath);
  return String(body || '').replace(/\s+$/, '')
    + '\n\n---\n\n## 视频演示\n\n'
    + '[![' + rel + up.coverPath + '](' + rel + up.videoPath + ')\n\n'
    + '[点击封面打开视频](' + rel + up.videoPath + ')\n';
}
function buildGithubArticleBody(body, video) {
  if (!video) return body;
  return appendVideoSection(body, video);
}

describe('相对路径规则 · 封面与视频一致', () => {
  const d = new Date(2026, 0, 2); // 2026-01-02

  it('文章 / 视频 / 封面共用同一 slug', () => {
    const base = articleBaseName('My Demo', d);
    expect(base).toBe('my-demo-20260102');
    expect('posts/' + base + '.md').toBe('posts/my-demo-20260102.md');
    expect('videos/' + base + '.mp4').toBe('videos/my-demo-20260102.mp4');
    expect('videos/' + base + '-cover.jpg').toBe('videos/my-demo-20260102-cover.jpg');
  });

  it('从 posts/ 出发回退一级得到 ../ 前缀', () => {
    expect(githubRelPrefix('posts/my-demo-20260102.md')).toBe('../');
    expect(githubRelPrefix('a.md')).toBe('../');
  });

  it('嵌套目录按层级数回退到仓库根', () => {
    expect(githubRelPrefix('blog/2026/posts/a.md')).toBe('../../../');
    expect(githubRelPrefix('posts/deep/a.md')).toBe('../../');
  });

  it('正文追加：封面可点击打开 MP4，两者路径一致', () => {
    const base = articleBaseName('My Demo', d);
    const articlePath = 'posts/' + base + '.md';
    const video = {
      articlePath: articlePath,
      videoPath: 'videos/' + base + '.mp4',
      coverPath: 'videos/' + base + '-cover.jpg'
    };
    const out = buildGithubArticleBody('## My Demo\n\n正文。', video);
    expect(out).toContain('[![../videos/' + base + '-cover.jpg](../videos/' + base + '.mp4)');
    expect(out).toContain('[点击封面打开视频](../videos/' + base + '.mp4)');
    // 用户编辑过的正文原样保留
    expect(out.indexOf('## My Demo\n\n正文。')).toBe(0);
    // 不使用 <video> 标签
    expect(out).not.toMatch(/<video/i);
  });

  it('无视频时正文原样返回（不追加任何内容）', () => {
    const body = '## A\n\n原文';
    expect(buildGithubArticleBody(body, null)).toBe(body);
  });
});

// --------------------------------------------- 4) index.html 双入口接入（源码断言）
describe('index.html · 单发与批量发射均接入视频', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  it('单发 autoPubGithub 先发视频再发文章', () => {
    const start = src.indexOf('window.autoPubGithub=async function(){');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf('function renderRocketChoices(', start);
    const fn = src.slice(start, end);
    const vidAt = fn.indexOf('publishGithubVideo');
    const putAt = fn.indexOf('githubPutFile');
    expect(vidAt).toBeGreaterThan(0);
    expect(putAt).toBeGreaterThan(0);
    // 视频必须发生在文章上传之前
    expect(vidAt).toBeLessThan(putAt);
    expect(fn).toMatch(/content:\s*finalBody/);
    // 原有发布参数不变
    expect(fn).toMatch(/branch:\s*'main'/);
  });

  it('批量发射 github 分支同样先发视频再发文章', () => {
    const start = src.indexOf("if(pid==='github'){");
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf('okCount++;markPub', start);
    const fn = src.slice(start, end);
    const vidAt = fn.indexOf('publishGithubVideo');
    const putAt = fn.indexOf('githubPutFile');
    expect(vidAt).toBeGreaterThan(0);
    expect(putAt).toBeGreaterThan(0);
    expect(vidAt).toBeLessThan(putAt);
    expect(fn).toMatch(/content:window\.buildGithubArticleBody\(body,\s*gvid\.video,\s*gpgs&&gpgs\.ok\?gpgs\.pages:null\)/);
  });

  it('视频来源是 __captionFinalVideo.path，绝不使用原始视频 state.videoAsset', () => {
    const start = src.indexOf('window.publishGithubVideo = async function(articlePath){');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf('window.buildGithubArticleBody', start);
    const fn = src.slice(start, end);
    expect(fn).toMatch(/state\.__captionFinalVideo/);
    expect(fn).toMatch(/finalVideoPath:\s*fv\.path/);
    // 不得回退到原始视频资产
    expect(fn).not.toMatch(/state\.videoAsset/);
  });

  it('没有最终视频时保持纯文章发布（不强制要求视频）', () => {
    const start = src.indexOf('window.publishGithubVideo = async function(articlePath){');
    const end = src.indexOf('window.buildGithubArticleBody', start);
    const fn = src.slice(start, end);
    expect(fn).toMatch(/if\(!fv\s*\|\|\s*!fv\.path\)\s*return\s*\{\s*ok:true,\s*video:null\s*\}/);
  });

  it('不把 owner / repo 交给前端决定，也不引入 GitHub Pages / LFS', () => {
    expect(src).not.toMatch(/gh-pages/i);
    expect(src).not.toMatch(/github\.io/i);
    expect(src).not.toMatch(/git\s*lfs/i);
  });

  it('preload 暴露 githubPutVideo', () => {
    const pre = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
    expect(pre).toMatch(/githubPutVideo:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('github:put-video'/);
  });
});

// ----------------------------------------- 5) main.js 发布目标不被前端覆盖（源码断言）
describe('main.js · github:put-video 安全与绑定约束', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  it('注册了 github:put-video，且 owner/repo 来自绑定 publishRepo', () => {
    expect(src).toMatch(/ipcMain\.handle\('github:put-video'/);
    const start = src.indexOf("ipcMain.handle('github:put-video'");
    const end = src.indexOf('\n});', start);
    const fn = src.slice(start, end);
    // 复用与 github:put-file 相同的绑定读取
    expect(fn).toMatch(/await resolveGithubTarget\(\)/);
    expect(fn).toMatch(/owner:\s*target\.publishRepo\.owner/);
    expect(fn).toMatch(/repo:\s*target\.publishRepo\.repo/);
    expect(fn).toMatch(/branch\s*=\s*'main'/);
    // 不接受前端传入的 owner/repo
    expect(fn).not.toMatch(/owner:\s*p\.owner/);
  });

  it('先校验最终视频 → 提取封面 → 传 MP4 → 传封面 → 返回真实仓库路径', () => {
    const start = src.indexOf("ipcMain.handle('github:put-video'");
    // 该 handler 结束于下一个 ipcMain.handle（Pages 相关），不要跨越过去
    const end = src.indexOf('\n});', start);
    const fn = src.slice(start, end);
    const iFin = fn.indexOf('resolveFinalVideoFile(p.finalVideoPath)');
    const iCover = fn.indexOf('generateThumbnail(fin.filePath');
    const iVid = fn.indexOf('path: p.videoPath');
    const iCoverUp = fn.indexOf('path: p.coverPath');
    expect(iFin).toBeGreaterThan(0);
    expect(iCover).toBeGreaterThan(iFin);
    expect(iVid).toBeGreaterThan(iCover);
    expect(iCoverUp).toBeGreaterThan(iVid);
    // 本 handler 内两次上传都走二进制通道
    expect(fn.match(/githubPutBinary\(/g) || []).toHaveLength(2);
    // 回传仓库内相对路径，不含本地绝对路径
    expect(fn).toMatch(/videoPath:\s*String\(p\.videoPath\)/);
    expect(fn).toMatch(/coverPath:\s*String\(p\.coverPath\)/);
  });

  it('任一步失败都不把整体报告为成功', () => {
    const start = src.indexOf("ipcMain.handle('github:put-video'");
    const end = src.indexOf('\n});', start);
    const fn = src.slice(start, end);
    // 封面失败 → 提前返回，不上传
    expect(fn).toMatch(/stage:\s*'cover'[\s\S]*?cover-extract-failed/);
    // 视频上传失败 → 提前返回
    expect(fn).toMatch(/stage:\s*'video-upload'/);
    // 封面上传失败 → 提前返回并带回恢复信息
    expect(fn).toMatch(/stage:\s*'cover-upload'[\s\S]*?videoPath:\s*p\.videoPath/);
  });

  it('日志与返回值不含 base64 内容或本地绝对路径', () => {
    const start = src.indexOf("ipcMain.handle('github:put-video'");
    const end = src.indexOf('\n});', start);
    const fn = src.slice(start, end);
    expect(fn).not.toMatch(/b64/);
    expect(fn).not.toMatch(/toString\('base64'\)/);
    expect(fn).not.toMatch(/access_token/);
  });

  it('未改动其它平台：公众号仍剥离视频字段，XHS / 即刻仍用原始 assetId', () => {
    // 公众号图文依旧剥离本地视频字段（v1.3 行为不变）
    expect(htmlSrc).toMatch(/delete\s+payload\.videoAssetId/);
    // 小红书 / 即刻 / X 依旧通过 videoAssetId + main 侧反查 filePath
    expect(htmlSrc).toMatch(/payload\.videoAssetId\s*=\s*state\.videoAsset\.id/);
    expect(src).toMatch(/getInternalAsset\(assetId\)/);
  });

  it('未改动 XTTS-v2 / 字幕编辑器 / 冻结时间轴等模块', () => {
    // 这些模块的 IPC 与关键标记仍在（本次未触碰）
    const pre = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
    expect(pre).toMatch(/captionBurnFinal/);
    expect(pre).toMatch(/captionReadFinal/);
    expect(pre).toMatch(/captionSaveFinal/);
    expect(pre).toMatch(/videoExtractFrame/);
    expect(htmlSrc).toMatch(/state\.__captionFinalVideo/);
    // voice-engine（XTTS-v2）源码存在且未被本次改动引用
    expect(fs.existsSync(path.join(__dirname, '..', 'electron', 'voice-engine.js'))).toBe(true);
  });
});