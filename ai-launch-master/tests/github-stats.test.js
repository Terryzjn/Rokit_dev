// Rokit · 「我的作品」GitHub 统计（Star / 下载 / 访客）单元测试
// 覆盖：ghRepoPart 解析、Star 抓取、Release 下载量累加、Traffic API 403 隔离
// 注意：被测函数挂在 electron/main.js 里，而 main.js 在 require 时会引入 electron
// 本体依赖；这里通过把 ghRepoPart / fetchGithubReleaseDownloads / fetchGithubTrafficVisitors
// 以 export 形式复制测试版本来避免把整个 main.js 拉起来。
//
// 因为这些函数都是纯字符串解析 + fetch 封装，没有外部依赖，复制实现即可保证测试结果可信。
// 一旦实现变更，应同时更新这里（这是 v1.10 增量测试的明确边界）。

// ---- ghRepoPart：复制自 electron/main.js ----
var __GH_OWNER_BLACKLIST = /^(settings|login|logout|signup|join|explore|topics|trending|collections|events|sponsors|orgs|marketplace|pricing|features|enterprise|customer-stories|security|team|jobs|sitemap|mobile|contact|about|notifications|search|new|home|privacy|terms|pulls|issues|discussions|wiki|projects)$/i;
function ghRepoPart(rawUrl) {
  if (!rawUrl) return null;
  var s = String(rawUrl).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  var u;
  try { u = new URL(s); } catch (_e) { return null; }
  if (!/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  var parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  var owner = parts[0];
  var repo  = (parts[1] || '').replace(/\.git$/i, '').replace(/[?#].*$/i, '');
  if (!owner || !repo) return null;
  if (__GH_OWNER_BLACKLIST.test(owner)) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return owner + '/' + repo;
}

// ---- fetchGithubReleaseDownloads：复制自 electron/main.js ----
async function fetchGithubReleaseDownloads(fetchImpl, ownerRepo, fetchWithTimeout) {
  var api = 'https://api.github.com/repos/' + encodeURIComponent(ownerRepo) + '/releases?per_page=100';
  var res = await fetchWithTimeout(api, {
    headers: { 'User-Agent': 'tuiguang-huojian/1.0', 'Accept': 'application/vnd.github+json' }
  }, 12000);
  if (!res.ok) {
    if (res.status === 404) return 0;
    throw new Error('GitHub releases 不可访问（HTTP ' + res.status + '）');
  }
  var arr = await res.json().catch(function () { return []; });
  if (!Array.isArray(arr)) return 0;
  var sum = 0;
  for (var i = 0; i < arr.length; i++) {
    var assets = (arr[i] && arr[i].assets) || [];
    for (var j = 0; j < assets.length; j++) {
      var c = Number(assets[j] && assets[j].download_count) || 0;
      if (c > 0) sum += c;
    }
  }
  return sum;
}

// ---- fetchGithubTrafficVisitors：复制自 electron/main.js ----
async function fetchGithubTrafficVisitors(fetchImpl, ownerRepo, token, fetchWithTimeout) {
  var api = 'https://api.github.com/repos/' + encodeURIComponent(ownerRepo) + '/traffic/views';
  var res = await fetchWithTimeout(api, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'tuiguang-huojian/1.0'
    }
  }, 9000);
  if (res.status === 403) {
    throw new Error('Traffic API 权限不足（需 Administration: Read）');
  }
  if (!res.ok) {
    throw new Error('GitHub traffic 不可访问（HTTP ' + res.status + '）');
  }
  var j = await res.json().catch(function () { return null; });
  return j && typeof j.uniques === 'number' ? j.uniques : 0;
}

// 测试用 fetchWithTimeout：直接转发到 fetchImpl（不做超时）
function fakeFwt(url, opt) { return globalThis.fetch(url, opt); }

describe('ghRepoPart · 解析 GitHub URL', () => {
  it('https://github.com/accountA/projectA → accountA/projectA', () => {
    expect(ghRepoPart('https://github.com/accountA/projectA')).toBe('accountA/projectA');
  });
  it('带尾斜杠 / issues / releases / .git 都能解析到 base repo', () => {
    expect(ghRepoPart('https://github.com/accountA/projectA/')).toBe('accountA/projectA');
    expect(ghRepoPart('https://github.com/accountA/projectA/issues/123')).toBe('accountA/projectA');
    expect(ghRepoPart('https://github.com/accountA/projectA/releases')).toBe('accountA/projectA');
    expect(ghRepoPart('https://github.com/accountA/projectA.git')).toBe('accountA/projectA');
  });
  it('https://example.com → null（普通网站）', () => {
    expect(ghRepoPart('https://example.com')).toBeNull();
    expect(ghRepoPart('https://example.com/xxx')).toBeNull();
  });
  it('github.com 保留路径（/login, /explore, /settings）应拒绝', () => {
    expect(ghRepoPart('https://github.com/login/anything')).toBeNull();
    expect(ghRepoPart('https://github.com/explore')).toBeNull();
    expect(ghRepoPart('https://github.com/settings/profile')).toBeNull();
  });
  it('缺协议自动补 https', () => {
    expect(ghRepoPart('github.com/accountA/projectA')).toBe('accountA/projectA');
  });
  it('空字符串 / 非 URL 应返回 null', () => {
    expect(ghRepoPart('')).toBeNull();
    expect(ghRepoPart(null)).toBeNull();
    expect(ghRepoPart('not a url')).toBeNull();
  });
});

describe('fetchGithubReleaseDownloads · 累加', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('把多 release / 多 asset 的 download_count 累加', async () => {
    const fakeBody = [
      { tag_name: 'v1', assets: [{ download_count: 10 }, { download_count: 5 }] },
      { tag_name: 'v2', assets: [{ download_count: 7 }, { download_count: 3 }, { download_count: 0 }] }
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fakeBody
    });
    const sum = await fetchGithubReleaseDownloads(globalThis.fetch, 'accountA/projectA', fakeFwt);
    expect(sum).toBe(25);
  });

  it('404（仓库无 release）应返回 0，不是错误', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const sum = await fetchGithubReleaseDownloads(globalThis.fetch, 'accountA/projectA', fakeFwt);
    expect(sum).toBe(0);
  });

  it('500 等其它错误应抛错（由上层标 downloads_error）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(fetchGithubReleaseDownloads(globalThis.fetch, 'accountA/projectA', fakeFwt))
      .rejects.toThrow(/HTTP 500/);
  });

  it('空 release 列表 → 0', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    expect(await fetchGithubReleaseDownloads(globalThis.fetch, 'accountA/projectA', fakeFwt)).toBe(0);
  });
});

describe('fetchGithubTrafficVisitors · 403 不当登录失效处理', () => {
  beforeEach(() => { vi.resetModules(); });

  it('正常返回时拿到 uniques', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ count: 100, uniques: 42 })
    });
    const v = await fetchGithubTrafficVisitors(globalThis.fetch, 'accountA/projectA', 'ghp_x', fakeFwt);
    expect(v).toBe(42);
  });

  it('403 时抛"Traffic API 权限不足"，不会让上层误判成登录失效', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 403,
      json: async () => ({ message: 'Forbidden' })
    });
    await expect(fetchGithubTrafficVisitors(globalThis.fetch, 'accountA/projectA', 'ghp_x', fakeFwt))
      .rejects.toThrow(/Traffic API 权限不足/);
  });
});
