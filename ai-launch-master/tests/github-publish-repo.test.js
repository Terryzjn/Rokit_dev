// Rokit · 「GitHub 发布仓库」绑定校验（v1.10）单元测试
//
// 覆盖：
//   - parseGithubRepo：URL → owner/repo
//   - verifyPublishRepoPush：GET /repos/{owner}/{repo} → { ok, push, ... }
//   - 未配置 publishRepo 时 publish 流程应拒绝
//
// 同 github-stats.test.js 的策略：把被测函数以 export 形式复制一份测试版本，
// 避免 require electron/oauth.js 时把 electron 主进程拉起。

// ---- parseGithubRepo：复制自 electron/oauth.js ----
const GH_OWNER_BLACKLIST = /^(settings|login|logout|signup|join|explore|topics|trending|collections|events|sponsors|orgs|marketplace|pricing|features|enterprise|customer-stories|security|team|jobs|sitemap|mobile|contact|about|notifications|search|new|home|privacy|terms|pulls|issues|discussions|wiki|projects)$/i;
function parseGithubRepo(rawUrl) {
  if (!rawUrl) return null;
  let s = String(rawUrl).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_e) { return null; }
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = (parts[1] || '').replace(/\.git$/i, '').replace(/[?#].*$/i, '');
  if (!owner || !repo) return null;
  if (GH_OWNER_BLACKLIST.test(owner)) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { owner: owner, repo: repo, url: 'https://github.com/' + owner + '/' + repo };
}

// ---- verifyPublishRepoPush：复制自 electron/oauth.js ----
async function verifyPublishRepoPush(fetchImpl, token, repo) {
  const url = 'https://api.github.com/repos/' + encodeURIComponent(repo.owner) + '/' + encodeURIComponent(repo.repo);
  try {
    const res = await fetchImpl(url, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Rokit-OAuth/1.0'
      }
    });
    if (res.status === 200) {
      const j = await res.json().catch(function () { return null; });
      const push = !!(j && j.permissions && j.permissions.push === true);
      return { ok: true, status: 200, push: push, full_name: j && j.full_name || (repo.owner + '/' + repo.repo) };
    }
    if (res.status === 404) {
      let msg = '';
      try { const j = await res.json().catch(function () { return null; }); msg = j && j.message ? String(j.message) : ''; } catch (_e) {}
      return { ok: false, status: 404, error: 'repo_not_found', detail: msg || '仓库不存在或 Token 无权访问' };
    }
    if (res.status === 401) {
      return { ok: false, status: 401, error: 'invalid_token', detail: 'Token 无效或已过期' };
    }
    if (res.status === 403) {
      let msg = '';
      try { const j = await res.json().catch(function () { return null; }); msg = j && j.message ? String(j.message) : ''; } catch (_e) {}
      return { ok: false, status: 403, error: 'forbidden', detail: msg || 'Token 没有访问该仓库的权限' };
    }
    return { ok: false, status: res.status, error: 'http_' + res.status, detail: 'HTTP ' + res.status };
  } catch (e) {
    return { ok: false, error: 'network', detail: String(e && e.message || e) };
  }
}

// fetch 包装：把 vi.fn().mockResolvedValue(...) 转成 verifyPublishRepoPush 期待的形态
function fakeFetchWith(handler) {
  return async function (url, init) {
    const r = handler(url, init);
    if (r && typeof r.then === 'function') return await r;
    return r;
  };
}

describe('parseGithubRepo · 解析 GitHub 仓库 URL', () => {
  it('https://github.com/owner/repo → { owner, repo, url }', () => {
    expect(parseGithubRepo('https://github.com/username/my-project')).toEqual({
      owner: 'username',
      repo: 'my-project',
      url: 'https://github.com/username/my-project'
    });
  });
  it('尾斜杠 / .git / 子路径都能解析', () => {
    expect(parseGithubRepo('https://github.com/u/r/')).toEqual({ owner: 'u', repo: 'r', url: 'https://github.com/u/r' });
    expect(parseGithubRepo('https://github.com/u/r.git')).toEqual({ owner: 'u', repo: 'r', url: 'https://github.com/u/r' });
    expect(parseGithubRepo('https://github.com/u/r/issues/123')).toEqual({ owner: 'u', repo: 'r', url: 'https://github.com/u/r' });
    expect(parseGithubRepo('github.com/u/r')).toEqual({ owner: 'u', repo: 'r', url: 'https://github.com/u/r' });
  });
  it('非 GitHub 域 → null', () => {
    expect(parseGithubRepo('https://example.com/u/r')).toBeNull();
    expect(parseGithubRepo('https://gitlab.com/u/r')).toBeNull();
  });
  it('GitHub 保留路径（/login、/settings、/explore）应拒绝', () => {
    expect(parseGithubRepo('https://github.com/login/anything')).toBeNull();
    expect(parseGithubRepo('https://github.com/explore')).toBeNull();
    expect(parseGithubRepo('https://github.com/settings/profile')).toBeNull();
  });
  it('空字符串 / 非 URL 应返回 null', () => {
    expect(parseGithubRepo('')).toBeNull();
    expect(parseGithubRepo(null)).toBeNull();
    expect(parseGithubRepo('not a url')).toBeNull();
  });
});

describe('verifyPublishRepoPush · /repos 权限校验', () => {
  beforeEach(() => { vi.resetModules(); });

  it('200 + permissions.push=true → ok=true, push=true', async () => {
    const fakeFetch = fakeFetchWith(vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ full_name: 'accountB/projectB', permissions: { push: true } })
    }));
    const r = await verifyPublishRepoPush(fakeFetch, 'ghp_x', { owner: 'accountB', repo: 'projectB' });
    expect(r).toMatchObject({ ok: true, push: true, full_name: 'accountB/projectB' });
  });

  it('200 + permissions.push=false → ok=true, push=false（必须阻止保存 publishRepo）', async () => {
    const fakeFetch = fakeFetchWith(vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ full_name: 'accountB/projectB', permissions: { push: false } })
    }));
    const r = await verifyPublishRepoPush(fakeFetch, 'ghp_x', { owner: 'accountB', repo: 'projectB' });
    expect(r.ok).toBe(true);
    expect(r.push).toBe(false);
  });

  it('404 → ok=false, error=repo_not_found', async () => {
    const fakeFetch = fakeFetchWith(vi.fn().mockResolvedValue({
      status: 404,
      json: async () => ({ message: 'Not Found' })
    }));
    const r = await verifyPublishRepoPush(fakeFetch, 'ghp_x', { owner: 'no', repo: 'such' });
    expect(r).toMatchObject({ ok: false, status: 404, error: 'repo_not_found' });
    expect(r.detail).toMatch(/Not Found|仓库不存在/);
  });

  it('401 → ok=false, error=invalid_token', async () => {
    const fakeFetch = fakeFetchWith(vi.fn().mockResolvedValue({
      status: 401,
      json: async () => ({ message: 'Bad credentials' })
    }));
    const r = await verifyPublishRepoPush(fakeFetch, 'ghp_x', { owner: 'a', repo: 'b' });
    expect(r).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
  });

  it('403 → ok=false, error=forbidden（用于区分 Traffic API 403 与发布 403）', async () => {
    const fakeFetch = fakeFetchWith(vi.fn().mockResolvedValue({
      status: 403,
      json: async () => ({ message: 'Resource not accessible by personal access token' })
    }));
    const r = await verifyPublishRepoPush(fakeFetch, 'ghp_x', { owner: 'a', repo: 'b' });
    expect(r).toMatchObject({ ok: false, status: 403, error: 'forbidden' });
    expect(r.detail).toMatch(/Resource not accessible/);
  });

  it('网络异常 → ok=false, error=network', async () => {
    const fakeFetch = fakeFetchWith(vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const r = await verifyPublishRepoPush(fakeFetch, 'ghp_x', { owner: 'a', repo: 'b' });
    expect(r).toMatchObject({ ok: false, error: 'network' });
  });
});
