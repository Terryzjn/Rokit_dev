// Rokit · 推广渠道扩展（v1.5）
// 1) GitHub L1 直发：通过 GitHub Contents API 在指定 Repository 写入/更新 Markdown 文件
//    需要用户配置 GitHub Token（Fine-grained PAT 需 Contents: Read and write）
//    v1.21：Token 统一由 secrets.getOauthToken('github') 读取（设置 → GitHub 发布 写入）
// 2) healthCheck：探测每个内置平台 / 自定义渠道是否仍可达 + 关键 DOM 选择器是否变更
//
// 所有网络请求统一走 fetchWithTimeout，避免阻塞。

'use strict';

const fetch = globalThis.fetch;

// 默认超时（健康度探测走短超时）
const HC_TIMEOUT_MS = 8000;
// Contents API 默认超时
const RELEASE_TIMEOUT_MS = 20000;

function fetchWithTimeout(url, opt, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms || HC_TIMEOUT_MS);
  return fetch(url, Object.assign({ signal: ctrl.signal }, opt || {}))
    .finally(function () { clearTimeout(t); });
}

// 从 GitHub URL 提取 owner/repo
function repoFromLink(url) {
  if (!url) return null;
  const m = /^https?:\/\/(www\.)?github\.com\/([^/?#]+\/[^/?#]+)/i.exec(String(url));
  if (!m) return null;
  return m[2].replace(/\.git$/i, '');
}

// 尝试从 work.url / type 等推导首个 GitHub 链接（用于 pickerLaunchUrl）
function pickLaunchUrl(work) {
  if (!work) return null;
  const url = work.url || '';
  const r = repoFromLink(url);
  return r ? 'https://github.com/' + r : null;
}

// 健康度探测
//   kind: 'github' | 'v2ex' | 'ph' | 'custom' | ...
//   cfg : 渠道配置 { api_base, webhook, ... }
// 返回 { ok: boolean, status?: number, error?: string, lastCheck: ISOString }
async function checkHealth(kind, cfg) {
  const lastCheck = new Date().toISOString();
  const k = String(kind || '').toLowerCase();
  // 内置平台：只探可达性，不做表单选择器断言（避免误报）
  if (k === 'github') {
    // 选 GitHub 任一公开仓库 README 端点，HEAD 一下
    try {
      const r = await fetchWithTimeout('https://api.github.com/zen', { method: 'GET' }, HC_TIMEOUT_MS);
      return { ok: r.ok, status: r.status, lastCheck: lastCheck };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), lastCheck: lastCheck };
    }
  }
  if (k === 'v2ex') {
    try {
      const r = await fetchWithTimeout('https://www.v2ex.com/api/topics/hot.json', { method: 'GET' }, HC_TIMEOUT_MS);
      return { ok: r.ok, status: r.status, lastCheck: lastCheck };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), lastCheck: lastCheck };
    }
  }
  if (k === 'ph') {
    try {
      const r = await fetchWithTimeout('https://www.producthunt.com/', { method: 'GET' }, HC_TIMEOUT_MS);
      return { ok: r.ok, status: r.status, lastCheck: lastCheck };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), lastCheck: lastCheck };
    }
  }
  // 自定义渠道：尝试 webhook（POST）→ 失败再 fallback 到 api_base（POST）
  if (k === 'custom') {
    const url = (cfg && (cfg.webhook || cfg.api_base)) || '';
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: '未配置 api_base 或 webhook', lastCheck: lastCheck };
    }
    try {
      const r = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true, ts: lastCheck })
      }, HC_TIMEOUT_MS);
      return { ok: r.ok, status: r.status, lastCheck: lastCheck };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), lastCheck: lastCheck };
    }
  }
  // 其它内置平台：粗略 HEAD 主页
  const home = ({
    juejin: 'https://juejin.cn/',
    csdn: 'https://blog.csdn.net/',
    zhihu: 'https://www.zhihu.com/',
    weibo: 'https://weibo.com/',
    x: 'https://x.com/',
    facebook: 'https://www.facebook.com/',
    bilibili: 'https://www.bilibili.com/',
    douyin: 'https://www.douyin.com/',
    xiaohongshu: 'https://www.xiaohongshu.com/',
    youtube: 'https://www.youtube.com/'
  })[k];
  if (!home) return { ok: false, error: 'unknown-kind', lastCheck: lastCheck };
  try {
    const r = await fetchWithTimeout(home, { method: 'GET' }, HC_TIMEOUT_MS);
    return { ok: r.ok, status: r.status, lastCheck: lastCheck };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), lastCheck: lastCheck };
  }
}

// 批量健康度探测：channels: [{ kind, ...cfg }] -> { kind: result }
async function checkAllHealth(channels) {
  if (!Array.isArray(channels)) return {};
  const tasks = channels.map(async function (c) {
    const r = await checkHealth(c && c.kind, c || {});
    return { key: c && c.kind, result: r };
  });
  const arr = await Promise.all(tasks);
  const out = {};
  for (const item of arr) {
    if (item && item.key) out[item.key] = item.result;
  }
  return out;
}

// v1.10：从 GitHub 错误响应里提取 JSON message 字段
//   GitHub API 错误体通常是 { "message": "...", "documentation_url": "...", ... }
//   把 message 拼到 detail，方便用户定位（不打印 Authorization header / token）
async function extractGhError(res, status, defaultMsg, fallbackDetail) {
  let ghMsg = '';
  try {
    const j = await res.json().catch(function () { return null; });
    if (j && typeof j.message === 'string' && j.message) ghMsg = j.message;
    else if (fallbackDetail) ghMsg = String(fallbackDetail).slice(0, 200);
  } catch (_e) {
    if (fallbackDetail) ghMsg = String(fallbackDetail).slice(0, 200);
  }
  return {
    ok: false,
    status: status,
    error: defaultMsg,
    detail: ghMsg ? (defaultMsg + '（GitHub: ' + ghMsg + '）') : defaultMsg
  };
}

// GitHub Contents API 单文件大小硬上限。
//   官方文档：该端点不支持 > 100MB 的文件（1–100MB 建议改用 raw 媒体类型拉取）。
//   超过上限时我们明确报错，绝不自动压缩或改写视频。
const GH_MAX_FILE_BYTES = 100 * 1024 * 1024;

// GitHub L1 直发：把文章作为 Markdown 文件创建/更新到目标 Repository
//   token: GitHub PAT（Fine-grained PAT 需 Contents: Read and write + 目标仓库在 Repository access 中）
//   opts: {
//     owner, repo,         // 仓库
//     path,                // 文件路径，如 'posts/test.md'
//     message,             // commit message（可选）
//     content,             // 文件原始内容（字符串；Main 端自动 base64 编码）
//     branch               // 分支（默认 main）
//   }
//   流程：先 GET /contents/{path}?ref={branch} 探测文件是否存在 + 拿 sha（不存在则 404），
//         再 PUT /contents/{path}（带 sha 时是 update，不带是 create）
// 返回 { ok, action: 'created'|'updated', content: { path, sha, html_url, ... }, commit: { ... }, error? }
async function githubPutFile(token, opts) {
  if (!token) return { ok: false, error: 'missing-token' };
  if (!opts || !opts.owner || !opts.repo || !opts.path) {
    return { ok: false, error: 'missing-params', detail: 'owner / repo / path 必填' };
  }
  const rawContent = typeof opts.content === 'string' ? opts.content : '';
  return githubPutContent(token, opts, Buffer.from(rawContent, 'utf8'));
}

// GitHub L1 直发：上传二进制文件（成品 MP4 / 封面 JPEG）。
//   与 githubPutFile 走同一套 Contents API + 同一套 token / publishRepo 绑定，
//   唯一区别是内容来自 Buffer 而不是 UTF-8 字符串 —— 绝不能把二进制当文本编码。
//   opts: { owner, repo, path, message?, branch? } + opts.buffer（Buffer）
// 返回结构与 githubPutFile 一致，额外带 bytes。
async function githubPutBinary(token, opts) {
  if (!token) return { ok: false, error: 'missing-token' };
  if (!opts || !opts.owner || !opts.repo || !opts.path) {
    return { ok: false, error: 'missing-params', detail: 'owner / repo / path 必填' };
  }
  if (!Buffer.isBuffer(opts.buffer) || opts.buffer.length <= 0) {
    return { ok: false, error: 'empty-file', detail: '待上传内容为空' };
  }
  // 大小校验放在读取之后、上传之前：明确报错，不静默跳过、不压缩
  if (opts.buffer.length > GH_MAX_FILE_BYTES) {
    return {
      ok: false,
      error: 'file-too-large',
      size: opts.buffer.length,
      max: GH_MAX_FILE_BYTES,
      detail: '文件 ' + (opts.buffer.length / 1024 / 1024).toFixed(1) + 'MB 超过 GitHub Contents API 上限 100MB，请压缩后再发布'
    };
  }
  const r = await githubPutContent(token, opts, opts.buffer);
  if (r && r.ok) r.bytes = opts.buffer.length;
  return r;
}

// 共享实现：Contents API 的「探测 sha → PUT」两步走。
//   buffer 必须是 Buffer；本函数只把它编码成 base64，绝不写进日志或错误信息。
async function githubPutContent(token, opts, buffer) {
  const branch = opts.branch || 'main';
  const message = opts.message || ('Publish via Rokit');
  const filePath = String(opts.path).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!filePath) return { ok: false, error: 'missing-params', detail: 'path 非法' };

  // v1.10：发布前安全日志（绝不打印 Authorization / 完整 token / 文件内容 / base64）
  //   用途：用户报告"发错仓库"时能直接看到本次到底请求了哪个 URL
  try {
    const logger = (() => { try { return require('./logger'); } catch (_e) { return null; } })();
    const payload = {
      method: 'PUT',
      target: opts.owner + '/' + opts.repo,
      path: filePath,
      branch: branch,
      contentBytes: buffer.length
    };
    if (logger && typeof logger.info === 'function') {
      logger.info('[GitHub Publisher] request', payload);
    }
    // 兼容：受限环境日志写不到 userData 时，也保证用户能从 PowerShell 启动窗口看到
    try { console.error('[GitHub Publisher] request ' + JSON.stringify(payload)); } catch (_e) {}
  } catch (_e) { /* 日志失败不影响发布 */ }

  // 1) 探测文件：GET .../contents/{path}?ref={branch}
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const getUrl = 'https://api.github.com/repos/' + encodeURIComponent(opts.owner) + '/' + encodeURIComponent(opts.repo) + '/contents/' + encodedPath + '?ref=' + encodeURIComponent(branch);
  let sha = null;
  try {
    const getRes = await fetchWithTimeout(getUrl, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Rokit-L1/1.5'
      }
    }, RELEASE_TIMEOUT_MS);
    if (getRes.status === 200) {
      const data = await getRes.json().catch(function () { return null; });
      sha = data && data.sha ? String(data.sha) : null;
    } else if (getRes.status === 404) {
      sha = null; // 文件不存在 → 直接创建
    } else if (getRes.status === 401) {
      return extractGhError(getRes, 401, 'Token 失效或权限不足（需 Contents: Read）');
    } else if (getRes.status === 403) {
      return extractGhError(getRes, 403, 'Token 权限不足（Fine-grained PAT 需勾选 Contents: Read and write + 目标仓库在 Repository access 中）');
    } else {
      let detail = '';
      try { detail = (await getRes.text()).slice(0, 300); } catch (_) {}
      return { ok: false, status: getRes.status, error: detail || ('HTTP ' + getRes.status) };
    }
  } catch (e) {
    return { ok: false, error: 'network:' + String((e && e.message) || e) };
  }

  // 2) PUT .../contents/{path}
  const putUrl = 'https://api.github.com/repos/' + encodeURIComponent(opts.owner) + '/' + encodeURIComponent(opts.repo) + '/contents/' + encodedPath;
  const contentBase64 = buffer.toString('base64');
  const putBody = sha
    ? { message: message, content: contentBase64, branch: branch, sha: sha }
    : { message: message, content: contentBase64, branch: branch };

  let putRes;
  try {
    putRes = await fetchWithTimeout(putUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Rokit-L1/1.5',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(putBody)
    }, RELEASE_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, error: 'network:' + String((e && e.message) || e) };
  }

  if (!putRes.ok) {
    let detail = '';
    try { detail = (await putRes.text()).slice(0, 300); } catch (_) {}
    if (putRes.status === 401) return extractGhError(putRes, 401, 'Token 失效或权限不足（需 Contents: Read and write）');
    if (putRes.status === 403) return extractGhError(putRes, 403, 'Token 权限不足（Fine-grained PAT 需勾选 Contents: Read and write + 目标仓库在 Repository access 中）');
    if (putRes.status === 404) return extractGhError(putRes, 404, '仓库不存在或 Token 无权访问');
    if (putRes.status === 409) return extractGhError(putRes, 409, '文件冲突（sha 不匹配，并发更新？）');
    if (putRes.status === 422) return extractGhError(putRes, 422, '参数非法', detail);
    return { ok: false, status: putRes.status, error: detail || ('HTTP ' + putRes.status) };
  }

  const j = await putRes.json().catch(function () { return null; });
  return {
    ok: true,
    action: sha ? 'updated' : 'created',
    content: j && j.content ? {
      path: j.content.path,
      sha: j.content.sha,
      html_url: j.content.html_url,
      size: j.content.size
    } : null,
    commit: j && j.commit ? {
      sha: j.commit.sha,
      message: j.commit.message,
      html_url: j.commit.html_url
    } : null
  };
}

// ============================================================
// GitHub Pages
//
// 发布源约束（官方文档硬限制）：
//   source.path 只接受 '/' 或 '/docs'，**不支持自定义目录如 /site**。
//   因此站点内容必须放在 docs/ 下，不能覆盖仓库根目录。
//   build_type: 'legacy'（分支目录直出，不需要 GitHub Actions）。
//
// 所需权限：
//   读取 Pages 状态  → OAuth repo scope / fine-grained「Pages: read」
//   创建 Pages 站点  → 还需「Pages: write」+「Administration: write」
//   触发构建        → 「Pages: write」
//   注意：Contents 权限**不足以**修改 Pages 设置。
// ============================================================

// 站点内容目录（Pages 发布源固定为 docs/）
const GH_PAGES_DIR = 'docs';
// 站点资源与页面的稳定前缀
const GH_PAGES_ASSET_DIR = GH_PAGES_DIR + '/assets';
const GH_PAGES_POST_DIR = GH_PAGES_DIR + '/posts';

// 单个 HTML 页面大小上限（站点页面本就很小，设一个宽松但明确的界）
const GH_PAGES_HTML_MAX = 2 * 1024 * 1024;

function ghHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Rokit-L1/1.5'
  };
}

// 读 Pages 站点状态。
// 返回 { enabled, htmlUrl, sourceBranch, sourcePath, status, needsPermission } 或 { enabled:false, error }
async function githubGetPages(token, owner, repo) {
  if (!token) return { enabled: false, error: 'missing-token' };
  const url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/pages';
  let res;
  try {
    res = await fetchWithTimeout(url, { method: 'GET', headers: ghHeaders(token) }, 15000);
  } catch (e) {
    return { enabled: false, error: 'network:' + String((e && e.message) || e) };
  }
  // 404 = 该仓库还没启用 Pages（最常见情况，不代表出错）
  if (res.status === 404) return { enabled: false, error: 'pages-not-enabled' };
  if (res.status === 401) return { enabled: false, error: 'unauthorized', needsPermission: false };
  if (res.status === 403) return { enabled: false, error: 'forbidden', needsPermission: true };
  if (!res.ok) {
    let d = '';
    try { d = (await res.text()).slice(0, 200); } catch (_e) {}
    return { enabled: false, error: d || ('HTTP ' + res.status) };
  }
  const j = await res.json().catch(function () { return null; });
  const src = (j && j.source) || {};
  return {
    enabled: true,
    htmlUrl: (j && j.html_url) || '',
    status: (j && j.status) || '',
    sourceBranch: src.branch || '',
    sourcePath: src.path || '',
    // 站点是否正从 docs/ 提供内容；不是的话我们会提示需要切换
    servesDocs: src.path === '/docs',
    public: !!(j && j.public)
  };
}

// 启用 Pages（build_type=legacy，来源 main + /docs）。
//   409 = 已启用（不是失败）；403 多为缺少 Pages/Administration 权限。
async function githubEnablePages(token, owner, repo, branch) {
  if (!token) return { ok: false, error: 'missing-token' };
  const url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/pages';
  const body = {
    build_type: 'legacy',
    source: { branch: branch || 'main', path: '/' + GH_PAGES_DIR }
  };
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: Object.assign(ghHeaders(token), { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    }, 20000);
  } catch (e) {
    return { ok: false, error: 'network:' + String((e && e.message) || e) };
  }
  if (res.status === 201 || res.status === 200) {
    const j = await res.json().catch(function () { return null; });
    return { ok: true, htmlUrl: (j && j.html_url) || '', status: (j && j.status) || '' };
  }
  // 已存在：视为成功（幂等）
  if (res.status === 409) return { ok: true, alreadyEnabled: true, htmlUrl: '' };
  let msg = '';
  try {
    const t = await res.text();
    msg = t.slice(0, 200);
    try { const jj = JSON.parse(t); if (jj && jj.message) msg = jj.message; } catch (_e) {}
  } catch (_e) {}
  return {
    ok: false,
    status: res.status,
    error: 'enable-failed',
    needsPermission: res.status === 403 || res.status === 401,
    detail: msg || ('HTTP ' + res.status)
  };
}

// 请求一次 Pages 构建（不新增 commit，只让 GitHub 重新构建）
async function githubRequestPagesBuild(token, owner, repo) {
  if (!token) return { ok: false, error: 'missing-token' };
  const url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/pages/builds';
  let res;
  try {
    res = await fetchWithTimeout(url, { method: 'POST', headers: ghHeaders(token) }, 15000);
  } catch (e) {
    return { ok: false, error: 'network:' + String((e && e.message) || e) };
  }
  if (res.status === 201) {
    const j = await res.json().catch(function () { return null; });
    return { ok: true, status: (j && j.status) || 'queued' };
  }
  return { ok: false, status: res.status, error: 'build-request-failed', needsPermission: res.status === 403 };
}

// 查最近一次构建状态：built / building / errored
async function githubGetLatestPagesBuild(token, owner, repo) {
  if (!token) return { ok: false, error: 'missing-token' };
  const url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/pages/builds/latest';
  let res;
  try {
    res = await fetchWithTimeout(url, { method: 'GET', headers: ghHeaders(token) }, 15000);
  } catch (e) {
    return { ok: false, error: 'network:' + String((e && e.message) || e) };
  }
  if (!res.ok) return { ok: false, status: res.status, error: 'no-build-yet' };
  const j = await res.json().catch(function () { return null; });
  return {
    ok: true,
    status: (j && j.status) || '',
    error: (j && j.error && j.error.message) || '',
    commit: (j && j.commit) || ''
  };
}

// 上传站点 HTML 页面（走与文章同一套 Contents API 绑定与二进制安全约束）
async function githubPutPagesHtml(token, opts) {
  const html = typeof opts.html === 'string' ? opts.html : '';
  if (!html) return { ok: false, error: 'empty-page' };
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > GH_PAGES_HTML_MAX) {
    return { ok: false, error: 'page-too-large', size: bytes, max: GH_PAGES_HTML_MAX, detail: '页面过大' };
  }
  return githubPutContent(token, Object.assign({}, opts, { content: undefined }), Buffer.from(html, 'utf8'));
}

// 校验远端文件确实存在（SHA / size 比对），避免"只凭请求发出就宣称成功"
async function githubVerifyFile(token, owner, repo, filePath, branch) {
  if (!token) return { ok: false, error: 'missing-token' };
  const encodedPath = String(filePath).split('/').map(encodeURIComponent).join('/');
  const url = 'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo)
    + '/contents/' + encodedPath + '?ref=' + encodeURIComponent(branch || 'main');
  let res;
  try {
    res = await fetchWithTimeout(url, { method: 'GET', headers: ghHeaders(token) }, 15000);
  } catch (e) {
    return { ok: false, error: 'network:' + String((e && e.message) || e) };
  }
  if (res.status !== 200) return { ok: false, status: res.status, error: 'verify-not-found' };
  const j = await res.json().catch(function () { return null; });
  if (!j || !j.sha) return { ok: false, error: 'verify-no-sha' };
  return { ok: true, sha: j.sha, size: j.size, path: j.path };
}

// 调 GitHub /user/repos 找一个最近推送的仓库（兜底目标）
// 用于：step 2 没填仓库地址时，授权后直接发到最近推送的那个仓库
async function githubPickRepo(token) {
  if (!token) return null;
  try {
    const resp = await fetchWithTimeout(
      'https://api.github.com/user/repos?sort=pushed&direction=desc&per_page=1&affiliation=owner',
      {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'Rokit-L1/1.5'
        }
      },
      15000
    );
    if (!resp.ok) return null;
    const arr = await resp.json().catch(function () { return null; });
    if (arr && arr[0] && arr[0].owner && arr[0].name) {
      return { owner: arr[0].owner.login, repo: arr[0].name };
    }
    return null;
  } catch (_e) {
    return null;
  }
}

// ============================================================
// OAuth L1 直发（Phase 1：GitHub）
//   - 不接 token 入参；由 Main 内部从 secrets.getOauthToken(providerId) 读
//   - Renderer 永远拿不到 token
//   - providerId=github → 复用上面的 githubCreateRelease
// ============================================================
const oauth = require('./oauth');

async function oauthCreatePost(providerId, opts) {
  if (!providerId) return { ok: false, error: 'missing-providerId' };
  if (providerId === 'github') {
    const tokenRec = await oauth.getTokenForInternal('github');
    if (!tokenRec || !tokenRec.access_token) {
      return { ok: false, error: 'not_connected', detail: '尚未完成 GitHub OAuth 授权，请到「推广渠道」点击授权按钮' };
    }
    return githubPutFile(tokenRec.access_token, opts);
  }
  return { ok: false, error: 'provider_not_implemented', providerId };
}

module.exports = {
  repoFromLink,
  pickLaunchUrl,
  checkHealth,
  checkAllHealth,
  githubPutFile,
  githubPutBinary,
  githubPickRepo,
  oauthCreatePost,
  githubGetPages,
  githubEnablePages,
  githubRequestPagesBuild,
  githubGetLatestPagesBuild,
  githubPutPagesHtml,
  githubVerifyFile,
  GH_MAX_FILE_BYTES,
  GH_PAGES_DIR,
  GH_PAGES_ASSET_DIR,
  GH_PAGES_POST_DIR,
  GH_PAGES_HTML_MAX
};