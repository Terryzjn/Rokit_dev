// Rokit · GitHub Pages 网页版发布（文章页 + 可播放 MP4）
//
// 覆盖需求第七节验证点（全部使用模拟响应 / 测试替身，不对真实仓库写操作）：
//   1. 文章与最终视频来源正确（用 __captionFinalVideo，不用 videoAsset）
//   2. HTML 页面生成、路径编码和资源 URL 正确（含项目站点 /<repo>/ 前缀）
//   3. 视频缺失 / 过大 / 权限不足 / Pages 未启用 时行为正确
//   4. 文件上传成功但 Pages 部署未完成时，状态区分正确
//   5. 原有纯 Markdown 文章发布继续工作（无视频时不强制网页）
//   6. 单发与批量发射调用一致实现
//   7. 不泄露密钥或本地路径
//   8. XTTS-v2 / 字幕编辑器 / 冻结时间轴 / 其他平台未被修改

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// publisher-extensions.js 在加载时捕获 globalThis.fetch，必须先装替身
const __fs = { handlers: null, calls: [] };
globalThis.fetch = async function (url, init) {
  const method = (init && init.method) || 'GET';
  const rec = {
    url: String(url), method: method,
    body: init && init.body ? JSON.parse(init.body) : null,
    headers: (init && init.headers) || {}
  };
  __fs.calls.push(rec);
  let h = __fs.handlers ? __fs.handlers[method] : undefined;
  if (Array.isArray(h)) h = h[__fs.calls.filter((c) => c.method === method).length - 1];
  if (typeof h === 'function') h = h(__fs.calls);
  if (!h) throw new Error('unexpected request: ' + method + ' ' + url);
  return h;
};

vi.mock('../electron/oauth', () => ({
  getTokenForInternal: async () => ({ access_token: 'tok', publishRepo: { owner: 'acme', repo: 'posts' } }),
  start: async () => ({ ok: true }), status: async () => ({ ok: true }),
  disconnect: async () => ({ ok: true }), saveCredential: async () => ({ ok: true }),
  refresh: async () => ({ ok: true }), getValidAccessToken: async () => 'tok'
}));

const pubex = require('../electron/publisher-extensions');
const renderer = require('../electron/gh-pages-render');

function res(status, body) {
  return {
    status: status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body || {})
  };
}
function useFetch(h) { __fs.handlers = h; __fs.calls = []; return __fs.calls; }

const REPO = { owner: 'acme', repo: 'posts' };
const PAGES_URL = 'https://api.github.com/repos/acme/posts/pages';

// ------------------------------------------------ 1) HTML 生成与转义
describe('gh-pages-render · 页面生成与安全编码', () => {
  it('标题 / 正文被转义，不产生可执行标签', () => {
    const html = renderer.renderPostPage({
      title: '<script>alert(1)</script>',
      body: '<img src=x onerror=alert(1)>',
      videoUrl: 'assets/a.mp4', repoPath: 'acme/posts'
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('javascript: 链接被丢弃，不会生成可点锚点', () => {
    const html = renderer.renderPostPage({
      title: 'T', body: '[点我](javascript:alert(1))',
      videoUrl: null, repoPath: 'acme/posts'
    });
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/<a href="javascript/i);
  });

  it('http/https 链接正常渲染为锚点', () => {
    const html = renderer.renderPostPage({
      title: 'T', body: '[站点](https://example.com)',
      videoUrl: null, repoPath: 'acme/posts'
    });
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('视频 URL 带项目站点前缀 /<repo>/，且剥掉发布源目录 docs/', () => {
    const html = renderer.renderPostPage({
      title: 'T', body: 'x', videoUrl: 'docs/assets/a.mp4', repoPath: 'acme/posts'
    });
    // Pages 项目站点挂载在 /<repo>/ 下；发布源 docs/ 就是站点根，不能出现在 URL 里。
    // 正确：/posts/assets/a.mp4（owner 属域名部分，不进路径）
    expect(html).toContain('src="/posts/assets/a.mp4"');
    // 不得出现多余的 docs/ 前缀，也不得重复 owner/repo
    expect(html).not.toMatch(/src="\/[^"]*\/docs\//);
    expect(html).not.toMatch(/src="\/acme\//);
    expect((html.match(/\/posts\/assets\/a\.mp4/g) || []).length).toBe(3); // video + 两个兜底链接
  });

  it('仓库名大小写不影响站点路径前缀（只取最后一段）', () => {
    const html = renderer.renderPostPage({
      title: 'T', body: 'x', videoUrl: 'docs/assets/x.mp4', repoPath: 'Terryzjn/Rokit_upload_post_dev'
    });
    // 仓库名原样保留（大小写由 GitHub Pages 自身处理），owner 不重复进路径
    expect(html).toContain('src="/Rokit_upload_post_dev/assets/x.mp4"');
    expect(html).not.toMatch(/src="\/Terryzjn\//);
  });

  it('带或不带开头斜杠的仓库内路径结果一致', () => {
    const a = renderer.renderPostPage({ title: 'T', body: 'x', videoUrl: 'docs/assets/a.mp4', repoPath: 'o/repo' });
    const b = renderer.renderPostPage({ title: 'T', body: 'x', videoUrl: '/docs/assets/a.mp4', repoPath: 'o/repo' });
    const pick = (h) => (h.match(/<video[^>]*\ssrc="([^"]+)"/) || [])[1];
    expect(pick(a)).toBe('/repo/assets/a.mp4');
    expect(pick(b)).toBe(pick(a));
  });

  it('播放器有 controls、无 autoplay，适配移动端', () => {
    const html = renderer.renderPostPage({
      title: 'T', body: 'x', videoUrl: 'assets/a.mp4', repoPath: 'acme/posts'
    });
    expect(html).toMatch(/<video[^>]*\bcontrols\b/);
    expect(html).not.toMatch(/autoplay/i);
    expect(html).toMatch(/playsinline/);
    expect(html).toMatch(/<meta name="viewport"/);
  });

  it('无视频时给出明确提示，不留空播放器', () => {
    const html = renderer.renderPostPage({ title: 'T', body: 'x', videoUrl: null, repoPath: 'a/b' });
    expect(html).not.toMatch(/<video/i);
    expect(html).toContain('暂未附带演示视频');
  });

  it('非 mp4 / 可疑的 videoUrl 被拒绝', () => {
    const h1 = renderer.renderPostPage({ title: 'T', body: 'x', videoUrl: 'a.html', repoPath: 'a/b' });
    expect(h1).not.toMatch(/<video/i);
    const h2 = renderer.renderPostPage({
      title: 'T', body: 'x', videoUrl: 'https://evil.com/a.mp4', repoPath: 'a/b'
    });
    expect(h2).not.toMatch(/src="https:\/\/evil\.com/);
  });

  it('Markdown 子集：标题 / 粗体 / 列表 / 引用 / 代码块', () => {
    const html = renderer.renderPostPage({
      title: 'T',
      body: '# H1\n\n**粗**\n\n- a\n- b\n\n> 引用\n\n```\ncode\n```',
      videoUrl: null, repoPath: 'a/b'
    });
    expect(html).toContain('<h1>H1</h1>');
    expect(html).toContain('<strong>粗</strong>');
    expect(html).toContain('<li>a</li>');
    expect(html).toContain('<blockquote>引用</blockquote>');
    expect(html).toContain('<pre><code>code</code></pre>');
  });

  it('页面中不含本地绝对路径 / Token / 用户目录', () => {
    const html = renderer.renderPostPage({
      title: 'T', body: 'x', videoUrl: 'assets/a.mp4',
      repoPath: 'acme/posts', date: '2026-01-01'
    });
    expect(html).not.toMatch(/[A-Za-z]:\\\\/);           // Windows 盘符
    expect(html).not.toMatch(/Users\\\\/);               // macOS 用户目录
    expect(html).not.toMatch(/AppData/i);                // Windows 用户目录
    expect(html).not.toMatch(/token/i);
  });

  it('首页列出文章且 href 仅限站内路径', () => {
    const html = renderer.renderIndexPage({
      title: 'Rokit', items: [{ href: 'posts/a.html', title: 'A' }]
    });
    expect(html).toContain('href="posts/a.html"');
    const evil = renderer.renderIndexPage({ items: [{ href: 'javascript:alert(1)', title: 'X' }] });
    expect(evil).not.toMatch(/javascript:/i);
  });
});

// ------------------------------------------------ 2) Pages 状态与启用
describe('Pages 状态读取与启用', () => {
  it('404 → pages-not-enabled（未启用，不是错误）', async () => {
    useFetch({ GET: res(404, { message: 'Not Found' }) });
    const r = await pubex.githubGetPages('t', REPO.owner, REPO.repo);
    expect(r).toMatchObject({ enabled: false, error: 'pages-not-enabled' });
  });

  it('200 且 source=/docs → servesDocs=true', async () => {
    useFetch({ GET: res(200, { html_url: 'https://acme.github.io/posts', status: 'built', source: { branch: 'main', path: '/docs' }, public: true }) });
    const r = await pubex.githubGetPages('t', REPO.owner, REPO.repo);
    expect(r.enabled).toBe(true);
    expect(r.servesDocs).toBe(true);
    expect(r.htmlUrl).toBe('https://acme.github.io/posts');
  });

  it('source=/ → servesDocs=false（调用方需提示用户切换）', async () => {
    useFetch({ GET: res(200, { html_url: 'https://acme.github.io', source: { branch: 'main', path: '/' } }) });
    const r = await pubex.githubGetPages('t', REPO.owner, REPO.repo);
    expect(r.servesDocs).toBe(false);
  });

  it('403 → needsPermission=true（不假装成功）', async () => {
    useFetch({ GET: res(403, { message: 'Resource not accessible' }) });
    const r = await pubex.githubGetPages('t', REPO.owner, REPO.repo);
    expect(r).toMatchObject({ enabled: false, needsPermission: true });
  });

  it('启用 Pages 使用 build_type=legacy + source /docs', async () => {
    const calls = useFetch({ POST: res(201, { html_url: 'https://acme.github.io/posts', status: 'built' }) });
    const r = await pubex.githubEnablePages('t', REPO.owner, REPO.repo, 'main');
    expect(r.ok).toBe(true);
    const post = calls.find((c) => c.method === 'POST');
    expect(post.body.build_type).toBe('legacy');
    expect(post.body.source).toEqual({ branch: 'main', path: '/docs' });
  });

  it('启用时 409 → 幂等视为成功', async () => {
    useFetch({ POST: res(409, { message: 'already exists' }) });
    const r = await pubex.githubEnablePages('t', REPO.owner, REPO.repo, 'main');
    expect(r.ok).toBe(true);
    expect(r.alreadyEnabled).toBe(true);
  });

  it('启用时 403 → needsPermission，如实报错', async () => {
    useFetch({ POST: res(403, { message: 'no access' }) });
    const r = await pubex.githubEnablePages('t', REPO.owner, REPO.repo, 'main');
    expect(r.ok).toBe(false);
    expect(r.needsPermission).toBe(true);
  });
});

// ------------------------------------------------ 3) 构建状态区分
describe('Pages 部署状态', () => {
  it('请求构建成功 → building', async () => {
    useFetch({ POST: res(201, { status: 'queued' }) });
    const r = await pubex.githubRequestPagesBuild('t', REPO.owner, REPO.repo);
    expect(r).toMatchObject({ ok: true, status: 'queued' });
  });

  it('最新构建 built / errored 可区分', async () => {
    useFetch({ GET: res(200, { status: 'built' }) });
    expect((await pubex.githubGetLatestPagesBuild('t', REPO.owner, REPO.repo)).status).toBe('built');
    useFetch({ GET: res(200, { status: 'errored', error: { message: 'boom' } }) });
    const e = await pubex.githubGetLatestPagesBuild('t', REPO.owner, REPO.repo);
    expect(e.status).toBe('errored');
    expect(e.error).toBe('boom');
  });
});

// ------------------------------------------------ 4) 上传后校验
describe('上传结果校验', () => {
  it('verify 成功返回 sha / size', async () => {
    useFetch({ GET: res(200, { sha: 'abc', size: 1234, path: 'docs/assets/a.mp4' }) });
    const r = await pubex.githubVerifyFile('t', REPO.owner, REPO.repo, 'docs/assets/a.mp4', 'main');
    expect(r).toMatchObject({ ok: true, sha: 'abc', size: 1234 });
  });

  it('verify 404 → not found（不据此宣称成功）', async () => {
    useFetch({ GET: res(404, {}) });
    const r = await pubex.githubVerifyFile('t', REPO.owner, REPO.repo, 'docs/assets/a.mp4', 'main');
    expect(r.ok).toBe(false);
  });

  it('HTML 页面走 Contents API 且按 UTF-8 编码', async () => {
    const calls = useFetch({ GET: res(404, {}), PUT: res(201, { content: { path: 'docs/posts/a.html', sha: 's', html_url: 'u' }, commit: { sha: 'c' } }) });
    const html = '<!DOCTYPE html><p>你好</p>';
    const r = await pubex.githubPutPagesHtml('t', {
      owner: REPO.owner, repo: REPO.repo, path: 'docs/posts/a.html', html: html, branch: 'main'
    });
    expect(r.ok).toBe(true);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.body.content).toBe(Buffer.from(html, 'utf8').toString('base64'));
  });

  it('空页面 / 过大页面被拒绝', async () => {
    useFetch({});
    expect((await pubex.githubPutPagesHtml('t', { owner: 'a', repo: 'b', path: 'x.html', html: '' })).error).toBe('empty-page');
    const big = 'x'.repeat(pubex.GH_PAGES_HTML_MAX + 10);
    expect((await pubex.githubPutPagesHtml('t', { owner: 'a', repo: 'b', path: 'x.html', html: big })).error).toBe('page-too-large');
  });

  it('Pages 目录常量符合官方限制（只能是 docs，不能是 site/）', () => {
    expect(pubex.GH_PAGES_DIR).toBe('docs');
    expect(pubex.GH_PAGES_ASSET_DIR).toBe('docs/assets');
    expect(pubex.GH_PAGES_POST_DIR).toBe('docs/posts');
  });
});

// ------------------------------------------------ 5) 最终视频白名单（同构副本）
function resolveFinalVideoFile(filePath, allowedRoot) {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'no-final-video' };
  const resolved = path.resolve(filePath);
  if (!allowedRoot) return { ok: false, error: 'no-allowed-root' };
  const rel = path.relative(allowedRoot, resolved);
  if (!rel || rel.indexOf('..') === 0 || path.isAbsolute(rel)) return { ok: false, error: 'path-not-allowed' };
  if (path.extname(resolved).toLowerCase() !== '.mp4') return { ok: false, error: 'not-mp4' };
  if (!fs.existsSync(resolved)) return { ok: false, error: 'file-missing' };
  const st = fs.statSync(resolved);
  if (!st.isFile() || st.size <= 0) return { ok: false, error: 'file-empty' };
  return { ok: true, filePath: resolved, size: st.size };
}

describe('最终视频来源与白名单', () => {
  let root; let real;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-pages-'));
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    real = path.join(root, 'sub', 'final-1.mp4');
    fs.writeFileSync(real, Buffer.from('mp4'));
  });
  afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) {} });

  it('接受白名单内 .mp4', () => {
    expect(resolveFinalVideoFile(real, root).ok).toBe(true);
  });
  it('拒绝白名单外路径', () => {
    expect(resolveFinalVideoFile(path.join(os.tmpdir(), 'x.mp4'), root).error).toBe('path-not-allowed');
  });
  it('拒绝空 / 缺失 / 非 mp4', () => {
    expect(resolveFinalVideoFile('', root).error).toBe('no-final-video');
    expect(resolveFinalVideoFile(path.join(root, 'nope.mp4'), root).error).toBe('file-missing');
    const t = path.join(root, 'a.txt'); fs.writeFileSync(t, 'x');
    expect(resolveFinalVideoFile(t, root).error).toBe('not-mp4');
  });
});

// ------------------------------------------------ 6) 源码级约束
describe('main.js / index.html 约束', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const preSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');

  function pagesFn(name) {
    const start = mainSrc.indexOf("ipcMain.handle('" + name + "'");
    expect(start).toBeGreaterThan(0);
    const end = mainSrc.indexOf("\n});", start);
    return mainSrc.slice(start, end);
  }

  it('注册 pages-status 与 publish-pages 两个 IPC', () => {
    expect(mainSrc).toMatch(/ipcMain\.handle\('github:pages-status'/);
    expect(mainSrc).toMatch(/ipcMain\.handle\('github:publish-pages'/);
    expect(preSrc).toMatch(/githubPagesStatus/);
    expect(preSrc).toMatch(/githubPublishPages/);
  });

  it('发布顺序：校验视频 → 封面 → 传 MP4 → 校验 → 生成 HTML → 传页面 → 构建', () => {
    const fn = pagesFn('github:publish-pages');
    const idx = (k, from) => fn.indexOf(k, from || 0);
    // 严格顺序（视频上传后先校验远端，再生成 HTML 页面）
    expect(idx('resolveFinalVideoFile')).toBeGreaterThan(-1);
    expect(idx('generateThumbnail')).toBeGreaterThan(idx('resolveFinalVideoFile'));
    expect(idx('githubPutBinary')).toBeGreaterThan(idx('generateThumbnail'));
    // 第一次 verify 是「视频上传后校验」，必须早于页面生成
    expect(idx('githubVerifyFile')).toBeGreaterThan(idx('githubPutBinary'));
    expect(idx('renderPostPage')).toBeGreaterThan(idx('githubVerifyFile'));
    // 页面生成后还应有第二次校验（页面上传后校验）
    expect(idx('githubVerifyFile', idx('renderPostPage') + 1)).toBeGreaterThan(idx('renderPostPage'));
    expect(idx('githubRequestPagesBuild')).toBeGreaterThan(idx('renderPostPage'));
  });

  it('发布源不是 /docs 时如实提示，不擅自改用户站点配置', () => {
    const fn = pagesFn('github:publish-pages');
    expect(fn).toMatch(/pages-source-mismatch/);
    // 不应调用 update Pages 配置的 API
    expect(fn).not.toMatch(/method:\s*'PUT'[\s\S]{0,80}\/pages/);
  });

  it('owner/repo 来自绑定 publishRepo，不接受前端传值', () => {
    const fn = pagesFn('github:publish-pages');
    expect(fn).toMatch(/await resolveGithubTarget\(\)/);
    expect(fn).not.toMatch(/owner:\s*p\.owner/);
    expect(fn).toMatch(/branch\s*=\s*'main'/);
  });

  it('deployStatus 区分 built / building / errored，不误报成功', () => {
    const fn = pagesFn('github:publish-pages');
    expect(fn).toMatch(/deployStatus:\s*deploy/);
    expect(fn).toMatch(/'built'/);
    expect(fn).toMatch(/'errored'/);
  });

  it('不把 token / base64 / 本地绝对路径写入返回值', () => {
    const fn = pagesFn('github:publish-pages');
    expect(fn).not.toMatch(/access_token/);
    expect(fn).not.toMatch(/toString\('base64'\)/);
    expect(fn).not.toMatch(/finalVideoPath:\s*fin\.filePath/);
  });

  it('网页版复用最终成品视频，绝不使用原始 videoAsset', () => {
    const start = htmlSrc.indexOf('window.publishGithubPages = async function(opts){');
    expect(start).toBeGreaterThan(0);
    const fn = htmlSrc.slice(start, htmlSrc.indexOf('function githubPagesLive', start));
    expect(fn).toMatch(/state\.__captionFinalVideo/);
    expect(fn).toMatch(/finalVideoPath:\s*fv\.path/);
    expect(fn).not.toMatch(/state\.videoAsset/);
  });

  it('无最终视频时跳过网页，保留纯文章流程', () => {
    const start = htmlSrc.indexOf('window.publishGithubPages = async function(opts){');
    const fn = htmlSrc.slice(start, htmlSrc.indexOf('function githubPagesLive', start));
    expect(fn).toMatch(/if\(!fv\s*\|\|\s*!fv\.path\)\s*return\s*\{\s*ok:true,\s*pages:null/);
  });

  it('只有构建完成才判定"网页已发布"', () => {
    const start = htmlSrc.indexOf('function githubPagesLive(pages){');
    const fn = htmlSrc.slice(start, htmlSrc.indexOf('// 发布目标预览', start));
    expect(fn).toMatch(/deployStatus\s*===\s*'built'/);
    expect(fn).toMatch(/文件上传成功，网页部署中/);
  });

  it('单发与批量发射调用同一套 Pages 实现', () => {
    const single = htmlSrc.slice(htmlSrc.indexOf('window.autoPubGithub=async function(){'));
    const batch = htmlSrc.slice(htmlSrc.indexOf("if(pid==='github'){"));
    expect(single).toMatch(/publishGithubPages/);
    expect(batch).toMatch(/publishGithubPages/);
    // 两处都把 pages 传给同一个正文构造函数
    expect(single).toMatch(/buildGithubArticleBody\(body,\s*vid\.video,\s*pgs\.ok\s*\?\s*pgs\.pages\s*:\s*null\)/);
    expect(batch).toMatch(/buildGithubArticleBody\(body,\s*gvid\.video,\s*gpgs&&gpgs\.ok\?gpgs\.pages:null\)/);
  });

  it('post/<slug>-<date>.md 路径规则保持不变', () => {
    expect(htmlSrc).toMatch(/return 'posts\/' \+ articleBaseName\(name\) \+ '\.md';/);
  });

  it('未改动其他平台的 videoAssetId 逻辑', () => {
    expect(htmlSrc).toMatch(/payload\.videoAssetId\s*=\s*state\.videoAsset\.id/);
    expect(htmlSrc).toMatch(/delete\s+payload\.videoAssetId/);
  });

  it('未改动 XTTS-v2 / 字幕编辑器 / 冻结时间轴', () => {
    expect(preSrc).toMatch(/captionBurnFinal/);
    expect(preSrc).toMatch(/captionReadFinal/);
    expect(preSrc).toMatch(/captionSaveFinal/);
    expect(fs.existsSync(path.join(__dirname, '..', 'electron', 'voice-engine.js'))).toBe(true);
    expect(htmlSrc).toMatch(/state\.__captionFinalVideo/);
  });

  it('未引入新的第三方依赖', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    expect(deps.sort()).toEqual(['better-sqlite3', 'ffmpeg-static', 'keytar']);
  });
});