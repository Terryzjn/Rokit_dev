// Rokit · 推广渠道扩展（v1.5）
// 1) GitHub L1 直发：通过 GitHub Contents API 在指定 Repository 写入/更新 Markdown 文件
//    需要用户配置 GitHub PAT（Fine-grained PAT 需 Contents: Read and write）
//    PAT 走 secrets.getGithubPat() 或 OAuth token 加密存储
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
  const branch = opts.branch || 'main';
  const message = opts.message || ('Publish via Rokit');
  const rawContent = typeof opts.content === 'string' ? opts.content : '';
  const filePath = String(opts.path).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!filePath) return { ok: false, error: 'missing-params', detail: 'path 非法' };

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
      return { ok: false, status: 401, error: 'Token 失效或权限不足（需 Contents: Read）' };
    } else if (getRes.status === 403) {
      return { ok: false, status: 403, error: 'Token 权限不足（Fine-grained PAT 需勾选 Contents: Read and write + 目标仓库在 Repository access 中）' };
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
  const contentBase64 = Buffer.from(rawContent, 'utf8').toString('base64');
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
    if (putRes.status === 401) return { ok: false, status: 401, error: 'Token 失效或权限不足（需 Contents: Read and write）' };
    if (putRes.status === 403) return { ok: false, status: 403, error: 'Token 权限不足（Fine-grained PAT 需勾选 Contents: Read and write + 目标仓库在 Repository access 中）' };
    if (putRes.status === 404) return { ok: false, status: 404, error: '仓库不存在或 Token 无权访问' };
    if (putRes.status === 409) return { ok: false, status: 409, error: '文件冲突（sha 不匹配，并发更新？）' };
    if (putRes.status === 422) return { ok: false, status: 422, error: '参数非法：' + (detail || '') };
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
  githubPickRepo,
  oauthCreatePost
};