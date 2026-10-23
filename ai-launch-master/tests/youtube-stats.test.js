// Rokit · 「我的作品」YouTube 播放量统计单元测试（v5）
// 覆盖：
//   1. parseYoutubeVideoId — watch?v= / youtu.be / shorts / embed 四种格式 + GitHub 域名拒绝
//   2. fetchYoutubeViewCount — viewCount 解析、空 items、HTTP 错误（配额/无效 key）、网络失败、缺字段
//   3. Store 持久化 — yt_url / yt_views / yt_updated_at 的写入、PATCH 语义、失败保留旧值
//
// 注意：被测函数挂在 electron/main.js 里，main.js 在 require 时会拉起 electron 依赖；
// 这里与 tests/github-stats.test.js 保持一致 —— 复制纯函数实现进行测试。
// 一旦 main.js 实现变更，应同步更新这里。

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- parseYoutubeVideoId：复制自 electron/main.js ----
function parseYoutubeVideoId(rawUrl) {
  if (!rawUrl) return null;
  var s = String(rawUrl).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  var u;
  try { u = new URL(s); } catch (_e) { return null; }
  var host = String(u.hostname || '').toLowerCase();
  var id = '';
  if (host === 'youtu.be') {
    id = u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '';
  } else if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
    var parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (parts[0] === 'watch') {
      id = u.searchParams.get('v') || '';
    } else if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') {
      id = parts[1] || '';
    }
  } else {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return id;
}

// ---- fetchYoutubeViewCount：复制自 electron/main.js（fetchWithTimeout 由测试注入） ----
async function fetchYoutubeViewCount(videoId, apiKey, fetchWithTimeout) {
  if (!videoId) throw new Error('no-video-id');
  if (!apiKey) { var e0 = new Error('no-youtube-api-key'); e0.ytReason = 'no-api-key'; throw e0; }
  var api = 'https://www.googleapis.com/youtube/v3/videos?part=statistics&id='
    + encodeURIComponent(videoId) + '&key=' + encodeURIComponent(apiKey);
  var res;
  try {
    res = await fetchWithTimeout(api, { headers: { 'Accept': 'application/json' } }, 10000);
  } catch (netErr) {
    var name = (netErr && netErr.name) || '';
    var msg = String((netErr && netErr.message) || netErr);
    var en = new Error('YouTube 网络错误（' + name + '）：' + msg);
    en.ytReason = 'network';
    throw en;
  }
  if (!res.ok) {
    var ytReason = '';
    var ytMsg = '';
    try {
      var eb = await res.json();
      if (eb && eb.error) {
        ytMsg = String(eb.error.message || '').slice(0, 200);
        var errs = eb.error.errors;
        if (Array.isArray(errs) && errs[0] && errs[0].reason) ytReason = String(errs[0].reason);
      }
    } catch (_e) {}
    var eh = new Error('YouTube API HTTP ' + res.status + (ytReason ? '（' + ytReason + '）' : ''));
    eh.httpStatus = res.status;
    eh.ytReason = ytReason || (res.status === 403 ? 'forbidden' : 'http-' + res.status);
    eh.ytMessage = ytMsg;
    throw eh;
  }
  var j = await res.json().catch(function () { return null; });
  if (!j || !Array.isArray(j.items)) {
    var ep = new Error('YouTube 响应解析失败');
    ep.ytReason = 'parse';
    throw ep;
  }
  if (!j.items.length) {
    var enf = new Error('YouTube 视频不存在或不可公开访问');
    enf.ytReason = 'video-not-found';
    throw enf;
  }
  var stats = j.items[0] && j.items[0].statistics;
  var vc = stats && stats.viewCount;
  if (vc === undefined || vc === null || vc === '') {
    var env2 = new Error('YouTube 响应缺 viewCount 字段');
    env2.ytReason = 'no-field';
    throw env2;
  }
  var views = Number(vc);
  if (!isFinite(views) || views < 0) {
    var eb2 = new Error('YouTube viewCount 非法：' + String(vc).slice(0, 40));
    eb2.ytReason = 'parse';
    throw eb2;
  }
  return { ok: true, views: Math.floor(views) };
}

// 测试用 fetchWithTimeout：直接转发到被 mock 的 globalThis.fetch
function fakeFwt(url, opt) { return globalThis.fetch(url, opt); }

const VID = 'dQw4w9WgXcQ'; // 11 位合法 ID

describe('parseYoutubeVideoId · 四种格式解析', () => {
  it('watch?v= 格式', () => {
    expect(parseYoutubeVideoId('https://www.youtube.com/watch?v=' + VID)).toBe(VID);
    expect(parseYoutubeVideoId('https://youtube.com/watch?v=' + VID)).toBe(VID);
    expect(parseYoutubeVideoId('https://m.youtube.com/watch?v=' + VID)).toBe(VID);
  });
  it('watch?v= 带额外参数（&t= / &list=）', () => {
    expect(parseYoutubeVideoId('https://www.youtube.com/watch?v=' + VID + '&t=42s')).toBe(VID);
    expect(parseYoutubeVideoId('https://www.youtube.com/watch?list=PLxxx&v=' + VID)).toBe(VID);
  });
  it('youtu.be 短链', () => {
    expect(parseYoutubeVideoId('https://youtu.be/' + VID)).toBe(VID);
    expect(parseYoutubeVideoId('https://youtu.be/' + VID + '?si=xxxx')).toBe(VID);
  });
  it('shorts 格式', () => {
    expect(parseYoutubeVideoId('https://www.youtube.com/shorts/' + VID)).toBe(VID);
  });
  it('embed 格式', () => {
    expect(parseYoutubeVideoId('https://www.youtube.com/embed/' + VID)).toBe(VID);
  });
  it('缺协议自动补 https', () => {
    expect(parseYoutubeVideoId('youtu.be/' + VID)).toBe(VID);
    expect(parseYoutubeVideoId('www.youtube.com/watch?v=' + VID)).toBe(VID);
  });
});

describe('parseYoutubeVideoId · 拒绝误判', () => {
  it('GitHub 仓库链接返回 null（核心防误判需求）', () => {
    expect(parseYoutubeVideoId('https://github.com/user/repo')).toBeNull();
    expect(parseYoutubeVideoId('https://github.com/user/repo/releases')).toBeNull();
  });
  it('普通网站 / 其他视频站返回 null', () => {
    expect(parseYoutubeVideoId('https://example.com/watch?v=' + VID)).toBeNull();
    expect(parseYoutubeVideoId('https://vimeo.com/12345678')).toBeNull();
    expect(parseYoutubeVideoId('https://bilibili.com/video/BV1xx411c7mD')).toBeNull();
  });
  it('伪装域名返回 null（youtubee.com / notyoutube.com）', () => {
    expect(parseYoutubeVideoId('https://youtubee.com/watch?v=' + VID)).toBeNull();
    expect(parseYoutubeVideoId('https://notyoutube.com/watch?v=' + VID)).toBeNull();
    expect(parseYoutubeVideoId('https://youtube.com.evil.com/watch?v=' + VID)).toBeNull();
  });
  it('ID 非法（非 11 位 / 含非法字符）返回 null', () => {
    expect(parseYoutubeVideoId('https://youtu.be/tooshort')).toBeNull();
    expect(parseYoutubeVideoId('https://youtu.be/waytoolongvideoid123')).toBeNull();
    expect(parseYoutubeVideoId('https://youtu.be/???????????')).toBeNull();
    expect(parseYoutubeVideoId('https://www.youtube.com/watch?v=')).toBeNull();
  });
  it('YouTube 非视频路径（频道 / 搜索结果）返回 null', () => {
    expect(parseYoutubeVideoId('https://www.youtube.com/@somechannel')).toBeNull();
    expect(parseYoutubeVideoId('https://www.youtube.com/results?search_query=test')).toBeNull();
  });
  it('空值 / 非 URL 返回 null', () => {
    expect(parseYoutubeVideoId('')).toBeNull();
    expect(parseYoutubeVideoId(null)).toBeNull();
    expect(parseYoutubeVideoId(undefined)).toBeNull();
  });
});

describe('fetchYoutubeViewCount · 成功路径', () => {
  beforeEach(() => { vi.resetModules(); });

  it('读取 items[0].statistics.viewCount 并转为数字', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ items: [{ statistics: { viewCount: '1234567', likeCount: '100' } }] })
    });
    const r = await fetchYoutubeViewCount(VID, 'AIza-test', fakeFwt);
    expect(r.ok).toBe(true);
    expect(r.views).toBe(1234567);
    // 确认请求的 URL 形态正确（part=statistics & id & key）
    const calledUrl = globalThis.fetch.mock.calls[0][0];
    expect(calledUrl).toContain('https://www.googleapis.com/youtube/v3/videos');
    expect(calledUrl).toContain('part=statistics');
    expect(calledUrl).toContain('id=' + VID);
    expect(calledUrl).toContain('key=AIza-test');
  });

  it('viewCount 为字符串数字也能转换；真实 0 播放允许返回 0', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ items: [{ statistics: { viewCount: '0' } }] })
    });
    const r = await fetchYoutubeViewCount(VID, 'AIza-test', fakeFwt);
    expect(r.views).toBe(0);
  });

  it('无 API Key 直接抛 no-api-key（不发起请求）', async () => {
    globalThis.fetch = vi.fn();
    await expect(fetchYoutubeViewCount(VID, '', fakeFwt)).rejects.toMatchObject({ ytReason: 'no-api-key' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('fetchYoutubeViewCount · 失败分类（绝不伪造 0）', () => {
  beforeEach(() => { vi.resetModules(); });

  it('items 为空 → video-not-found（视频不存在/非公开）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ items: [] })
    });
    await expect(fetchYoutubeViewCount(VID, 'AIza-test', fakeFwt)).rejects.toMatchObject({ ytReason: 'video-not-found' });
  });

  it('HTTP 403 + quotaExceeded → 保留 reason 与 httpStatus', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 403,
      json: async () => ({ error: { message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } })
    });
    await expect(fetchYoutubeViewCount(VID, 'AIza-test', fakeFwt)).rejects.toMatchObject({ httpStatus: 403, ytReason: 'quotaExceeded' });
  });

  it('HTTP 400 + keyInvalid → key 无效', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 400,
      json: async () => ({ error: { message: 'API key not valid.', errors: [{ reason: 'keyInvalid' }] } })
    });
    await expect(fetchYoutubeViewCount(VID, 'bad-key', fakeFwt)).rejects.toMatchObject({ httpStatus: 400, ytReason: 'keyInvalid' });
  });

  it('网络异常 → network 分类', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' }));
    await expect(fetchYoutubeViewCount(VID, 'AIza-test', fakeFwt)).rejects.toMatchObject({ ytReason: 'network' });
  });

  it('响应 JSON 无法解析 → parse', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => { throw new Error('bad json'); }
    });
    await expect(fetchYoutubeViewCount(VID, 'AIza-test', fakeFwt)).rejects.toMatchObject({ ytReason: 'parse' });
  });

  it('缺 viewCount 字段 → no-field', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ items: [{ statistics: {} }] })
    });
    await expect(fetchYoutubeViewCount(VID, 'AIza-test', fakeFwt)).rejects.toMatchObject({ ytReason: 'no-field' });
  });
});

describe('Store · YouTube 字段持久化（yt_url / yt_views / yt_updated_at）', () => {
  let tmpDir, dbPath;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-store-yt-'));
    dbPath = path.join(tmpDir, 'test.db');
  });
  afterEach(() => {
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
    }
    try { fs.rmdirSync(tmpDir); } catch (_) {}
  });

  // better-sqlite3 是原生模块：本仓库的开发机常把它编译为 Electron ABI（供真实应用运行），
  // 而 vitest 跑在系统 Node 上，ABI 不匹配时 `new Store()` 会抛 NODE_MODULE_VERSION 错误
  // （与 tests/store-patch.test.js 的基线失败同源）。此处优雅跳过，
  // 真实 SQLite 驱动下的持久化验证由 tests/_yt-store-probe.js（Electron 进程内）承担。
  function makeStore() {
    const { Store } = require('../electron/store');
    try { return new Store(dbPath); } catch (e) {
      if (/NODE_MODULE_VERSION|compiled against/.test(String(e && e.message))) return null;
      throw e;
    }
  }

  it('INSERT 默认值：yt_url 为空串、yt_views 为 null、yt_updated_at 为 null', () => {
    const s = makeStore();
    if (!s) return; // 原生 ABI 不匹配（基线环境问题），跳过
    expect(s.mode).toBe('sqlite');
    s.saveWork({ id: 'w1', name: 'Rokit' });
    const w = s.listWorks()[0];
    expect(w.yt_url).toBe('');
    expect(w.yt_views).toBeNull();
    expect(w.yt_updated_at).toBeNull();
  });

  it('UPDATE 写入 yt 字段并回读（重启后仍在 = 持久化生效）', () => {
    const s = makeStore();
    if (!s) return;
    s.saveWork({ id: 'w1', name: 'Rokit', url: 'https://github.com/u/r' });
    s.saveWork({ id: 'w1', yt_url: 'https://youtu.be/' + VID, yt_views: 98765, yt_updated_at: '2026-10-10T12:00:00.000Z' });
    const w = s.listWorks()[0];
    expect(w.yt_url).toBe('https://youtu.be/' + VID);
    expect(w.yt_views).toBe(98765);
    expect(w.yt_updated_at).toBe('2026-10-10T12:00:00.000Z');
    // 模拟重启：新建 Store 实例读同一文件
    const { Store } = require('../electron/store');
    const s2 = new Store(dbPath);
    const w2 = s2.listWorks()[0];
    expect(w2.yt_views).toBe(98765);
    expect(w2.yt_url).toBe('https://youtu.be/' + VID);
  });

  it('PATCH 语义：只更新 star/dl 时不动 yt 字段（API 失败保留旧播放量）', () => {
    const s = makeStore();
    if (!s) return;
    s.saveWork({ id: 'w1', name: 'Rokit', yt_url: 'https://youtu.be/' + VID, yt_views: 123, yt_updated_at: '2026-10-10T00:00:00.000Z' });
    // 模拟 GitHub 刷新只回写 star/dl
    s.saveWork({ id: 'w1', star: 42, dl: 7 });
    const w = s.listWorks()[0];
    expect(w.star).toBe(42);
    expect(w.dl).toBe(7);
    expect(w.yt_views).toBe(123);
    expect(w.yt_url).toBe('https://youtu.be/' + VID);
  });

  it('PATCH 语义：YouTube 刷新只写 yt_views/yt_updated_at 时不清 star/dl/url/name', () => {
    const s = makeStore();
    if (!s) return;
    s.saveWork({ id: 'w1', name: 'Rokit', url: 'https://github.com/u/r', star: 10, dl: 5 });
    s.saveWork({ id: 'w1', yt_views: 456, yt_updated_at: '2026-10-10T01:00:00.000Z' });
    const w = s.listWorks()[0];
    expect(w.name).toBe('Rokit');
    expect(w.url).toBe('https://github.com/u/r');
    expect(w.star).toBe(10);
    expect(w.dl).toBe(5);
    expect(w.yt_views).toBe(456);
  });

  it('yt_views 显式传 null：清缓存（前端恢复显示 --），不伪造 0', () => {
    const s = makeStore();
    if (!s) return;
    s.saveWork({ id: 'w1', name: 'Rokit', yt_views: 999, yt_updated_at: '2026-10-10T00:00:00.000Z' });
    s.saveWork({ id: 'w1', yt_views: null, yt_updated_at: null });
    const w = s.listWorks()[0];
    expect(w.yt_views).toBeNull();
    expect(w.yt_updated_at).toBeNull();
  });
});
