//
// 覆盖「我的作品」YouTube 播放量的刷新链路与显示规则：
//
//   A. refreshGithubStats 控制流
//      - 无 GitHub 链接但有 YouTube 视频 ID → YouTube 查询仍执行
//      - 同时有 GitHub 与 YouTube → 两类统计都正常返回
//      - 两边都没有目标 → 返回空数组（不抛错）
//
//   B. 播放量显示规则（三处共用ytViewsText）
//      - 无有效 YouTube 视频 ID → '—'（不展示历史遗留的 yt_views）
//      - 有视频 ID 但无统计值（null）→ '—'
//      - API 返回 0 → '0'（合法的真实零播放，不能当缺失值）
//      - API 返回 6 → '6'
//
//   C. 失败语义
//      - API 失败 → 不写入 0，保留最后一次有效值
//      - 空items / 缺 viewCount → 抛错，不转成 0
//
//   D. 源码断言：三处渲染统一走 ytViewsText，防止实现与测试副本漂移
//
//策略：被测函数位于 electron/main.js（require 会拉起 electron），
//  这里与 tests/youtube-stats.test.js 保持一致 —— 复制纯函数实现进行测试。

'use strict';

const fs = require('fs');
const path = require('path');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

// ============================================================
// parseYoutubeVideoId：复制自 index.html / main.js（同构）
// ============================================================
function parseYoutubeVideoId(rawUrl) {
  if (!rawUrl) return null;
  var s = String(rawUrl).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  var u;
  try { u = new URL(s); } catch (_e) { return null; }
  var host = String(u.hostname || '').toLowerCase();
  var id = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/').filter(Boolean)[0] || null;
  } else if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
    var p = u.pathname;
    if (p === '/watch') id = u.searchParams.get('v');
    else {
      var m = p.match(/^\/(shorts|embed|live)\/([^/?#]+)/);
      if (m) id = m[2];
    }
  }
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
  return null;
}

// ============================================================
// ytViewsText：复制自 index.html
// ============================================================
function ytViewsText(w) {
  if (!w) return '—';
  var vid = parseYoutubeVideoId(w.yt_url) || parseYoutubeVideoId(w.url);
  if (!vid) return '—';
  if (w.yt_views === null || w.yt_views === undefined) return '—';
  var n = Number(w.yt_views);
  if (!isFinite(n) || n < 0) return '—';
  return n.toLocaleString();
}

// ============================================================
// refreshGithubStats 控制流副本（只保留与「目标筛选 / YouTube 是否执行」相关的骨架，
// fetch 全部打桩，不触网、不落库）
// ============================================================
function makeRefreshHarness(opts) {
  opts = opts || {};
  var calls = { gh: [], yt: [], saved: [] };

  async function fetchYoutubeViewCountStub(videoId) {
    calls.yt.push(videoId);
    if (opts.ytThrows) {
      var e = new Error(opts.ytThrows.message || 'boom');
      e.ytReason = opts.ytThrows.reason || 'network';
      throw e;
    }
    return { ok: true, views: opts.ytViews };
  }

  async function refreshGithubStats(works) {
    // --- GitHub 段（骨架）---
    var targets = (works || []).filter(function (w) {
      return w && w.id && typeof w.url === 'string' && /github\.com/i.test(w.url);
    });
    // 修复后：无 GitHub 目标时**不 return**，只跳过 GitHub 处理
    var updates = [];
    if (targets.length) {
      targets.forEach(function (w) {
        calls.gh.push(w.id);
        updates.push({ id: w.id, ok: true, stars: 1, downloads: 2 });
      });
    }

    // --- YouTube 段 ---
    var ytTargets = (works || []).filter(function (w) {
      if (!w || !w.id) return false;
      if (w.wantYt === false) return false;
      return !!(parseYoutubeVideoId(w.yt_url) || parseYoutubeVideoId(w.url));
    });
    if (ytTargets.length) {
      var byId = {};
      updates.forEach(function (u) { if (u && u.id) byId[u.id] = u; });
      await Promise.allSettled(ytTargets.map(async function (w) {
        var vid = parseYoutubeVideoId(w.yt_url) || parseYoutubeVideoId(w.url);
        var entry = byId[w.id];
        if (!entry) { entry = { id: w.id, ok: true, ytOnly: true }; updates.push(entry); byId[w.id] = entry; }
        try {
          var yr = await fetchYoutubeViewCountStub(vid);
          entry.yt_views = yr.views;
          entry.yt_updated_at = new Date().toISOString();
          if (opts.persist) calls.saved.push({ id: w.id, yt_views: yr.views });
        } catch (ye) {
          entry.yt_views_error = String((ye && ye.message) || ye);
          entry.yt_reason = (ye && ye.ytReason) || 'unknown';
        }
      }));
    }
    return updates;
  }

  return { refreshGithubStats, calls };
}

const VID = 'iI9Ni29NEvU';
const OLD_VID = '5JRY8vxUs4w';
const YT_URL = 'https://www.youtube.com/watch?v=' + VID;

// ============================================================
// A. 控制流
// ============================================================
describe('refreshGithubStats · YouTube 段不再被 GitHub 早退阻断', () => {
  it('无 GitHub 链接但有 YouTube 视频 ID：YouTube 查询仍会执行', async () => {
    const h = makeRefreshHarness({ ytViews: 6 });
    const res = await h.refreshGithubStats([
      { id: 'w9', url: '', yt_url: YT_URL, wantYt: true }
    ]);
    expect(h.calls.gh).toHaveLength(0);
    expect(h.calls.yt).toEqual([VID]);
    expect(res.find(u => u.id === 'w9').yt_views).toBe(6);
  });

  it('有 GitHub 链接且有 YouTube 视频 ID：两类统计均正常返回', async () => {
    const h = makeRefreshHarness({ ytViews: 6 });
    const res = await h.refreshGithubStats([
      { id: 'w1', url: 'https://github.com/o/r', yt_url: YT_URL, wantYt: true }
    ]);
    expect(h.calls.gh).toEqual(['w1']);
    expect(h.calls.yt).toEqual([VID]);
    const e = res.find(u => u.id === 'w1');
    expect(e.ok).toBe(true);
    expect(e.stars).toBe(1);
    expect(e.yt_views).toBe(6);
  });

  it('两边都没有目标：返回空数组且不抛错', async () => {
    const h = makeRefreshHarness({ ytViews: 6 });
    const res = await h.refreshGithubStats([
      { id: 'w2', url: '', yt_url: '', wantYt: true }
    ]);
    expect(res).toEqual([]);
    expect(h.calls.yt).toHaveLength(0);
  });

  it('YouTube 链接写在 url 字段时也能查到（字段优先级：yt_url → url）', async () => {
    const h = makeRefreshHarness({ ytViews: 3 });
    await h.refreshGithubStats([
      { id: 'w3', url: 'https://youtu.be/' + VID, yt_url: '', wantYt: true }
    ]);
    expect(h.calls.yt).toEqual([VID]);
  });

  it('wantYt === false 时不查询（前端缓存策略生效）', async () => {
    const h = makeRefreshHarness({ ytViews: 6 });
    await h.refreshGithubStats([
      { id: 'w4', url: '', yt_url: YT_URL, wantYt: false }
    ]);
    expect(h.calls.yt).toHaveLength(0);
  });

  it('每个作品按自己的视频 ID 查询，互不串号', async () => {
    const h = makeRefreshHarness({ ytViews: 6 });
    await h.refreshGithubStats([
      { id: 'wa', url: '', yt_url: YT_URL, wantYt: true },
      { id: 'wb', url: '', yt_url: 'https://youtu.be/' + OLD_VID, wantYt: true }
    ]);
    expect(h.calls.yt.sort()).toEqual([VID, OLD_VID].sort());
  });
});

// ============================================================
// B. 显示规则
// ============================================================
describe('ytViewsText · 播放量显示规则', () => {
  it('没有有效 YouTube 视频 ID：显示 —', () => {
    expect(ytViewsText({ id: 'w1', yt_url: '', yt_views: 123 })).toBe('—');
    expect(ytViewsText({ id: 'w1', yt_url: '', url: 'https://github.com/o/r', yt_views: 123 })).toBe('—');
  });

  it('yt_url 格式非法（无法解析出 11 位ID）：显示 —', () => {
    expect(ytViewsText({ id: 'w1', yt_url: 'https://www.youtube.com/feed/subscriptions', yt_views: 123 })).toBe('—');
    expect(ytViewsText({ id: 'w1', yt_url: 'https://www.youtube.com/watch?v=tooshort', yt_views: 123 })).toBe('—');
  });

  it('有视频 ID 但无统计值（null / undefined）：显示 —', () => {
    expect(ytViewsText({ id: 'w1', yt_url: YT_URL, yt_views: null })).toBe('—');
    expect(ytViewsText({ id: 'w1', yt_url: YT_URL })).toBe('—');
  });

  it('API 返回 0：显示 0（合法零播放，不能当缺失值）', () => {
    expect(ytViewsText({ id: 'w1', yt_url: YT_URL, yt_views: 0 })).toBe('0');
  });

  it('API 返回 6：显示 6', () => {
    expect(ytViewsText({ id: 'w1', yt_url: YT_URL, yt_views: 6 })).toBe('6');
  });

  it('大数值按千分位显示', () => {
    expect(ytViewsText({ id: 'w1', yt_url: YT_URL, yt_views: 1234567 })).toBe('1,234,567');
  });

  it('传入非数字 / 负数：显示 — 而不是伪造 0', () => {
    expect(ytViewsText({ id: 'w1', yt_url: YT_URL, yt_views: 'abc' })).toBe('—');
    expect(ytViewsText({ id: 'w1', yt_url: YT_URL, yt_views: -1 })).toBe('—');
  });

  it('work对象为 undefined：安全返回 —', () => {
    expect(ytViewsText(undefined)).toBe('—');
    expect(ytViewsText(null)).toBe('—');
  });

  it('非 YouTube 域名的 url 不会被误判为有效视频 ID', () => {
    expect(ytViewsText({ id: 'w1', yt_url: '', url: 'https://github.com/o/r', yt_views: 5 })).toBe('—');
  });
});

// ============================================================
// C. 失败语义
// ============================================================
describe('失败语义 · 绝不伪造 0', () => {
  it('API 失败：结果里是错误原因，不含 yt_views', async () => {
    const h = makeRefreshHarness({ ytThrows: { message: 'YouTube 网络错误（TypeError）：fetch failed', reason: 'network' } });
    const res = await h.refreshGithubStats([
      { id: 'w1', url: '', yt_url: YT_URL, wantYt: true }
    ]);
    const e = res.find(u => u.id === 'w1');
    expect(e.yt_views).toBeUndefined();      // 没有伪造 0
    expect(e.yt_reason).toBe('network');
  });

  it('API 失败时不触发落库（保留最后一次有效值）', async () => {
    const h = makeRefreshHarness({ ytThrows: { message: 'x', reason: 'video-not-found' }, persist: true });
    await h.refreshGithubStats([{ id: 'w1', url: '', yt_url: YT_URL, wantYt: true }]);
    expect(h.calls.saved).toHaveLength(0);
  });

  it('API 成功 0 时才落库 0（与失败区分开）', async () => {
    const h = makeRefreshHarness({ ytViews: 0, persist: true });
    await h.refreshGithubStats([{ id: 'w1', url: '', yt_url: YT_URL, wantYt: true }]);
    expect(h.calls.saved).toEqual([{ id: 'w1', yt_views: 0 }]);
  });

  it('API 返回 6：落库值为 6', async () => {
    const h = makeRefreshHarness({ ytViews: 6, persist: true });
    await h.refreshGithubStats([{ id: 'w1', url: '', yt_url: YT_URL, wantYt: true }]);
    expect(h.calls.saved).toEqual([{ id: 'w1', yt_views: 6 }]);
  });
});

// ============================================================
// D. 源码断言：防止实现与测试副本漂移
// ============================================================
describe('源码断言 · 三处渲染统一走 ytViewsText', () => {
  it('index.html 定义了 ytViewsText', () => {
    expect(htmlSrc).toContain('function ytViewsText(w)');
    // 规则：复用 parseYoutubeVideoId，而不是简单判断 yt_url 非空
    expect(htmlSrc).toMatch(/function ytViewsText\(w\)\{[\s\S]*?parseYoutubeVideoId\(w\.yt_url\)/);
  });

  it('renderWorks 卡片渲染（L17195附近）走 ytViewsText', () => {
    const line = htmlSrc.split('\n').find(l => l.includes('>播放<b>'));
    expect(line).toBeTruthy();
    expect(line).toContain('ytViewsText(w)');
    expect(line).not.toContain("yt_views==null?'--'");
  });

  it('局部 DOM 更新走 ytViewsText', () => {
    expect(htmlSrc).toContain('if (boxes[2]) boxes[2].textContent = ytViewsText(w);');
  });

  it('悬停预览走 ytViewsText', () => {
    const line = htmlSrc.split('\n').find(l => l.includes('<div class="wp-lbl">播放</div>'));
    expect(line).toBeTruthy();
    expect(line).toContain('ytViewsText(work)');
  });

  it('index.html 中不再存在裸的 yt_views==null 三元表达式', () => {
    expect(htmlSrc).not.toContain("w.yt_views==null?'--'");
    expect(htmlSrc).not.toContain("work.yt_views==null?'--'");
    expect(htmlSrc).not.toContain("w.yt_views == null ? '--'");
  });

  it('main.js 在无 GitHub 目标时不再提前 return []', () => {
    // 旧的早退写法（return [] 会阻断 YouTube 段）必须已消失
    expect(mainSrc).not.toMatch(/=== no targets to refresh ===[\s\S]{0,80}return \[\];/);
    expect(mainSrc).toContain('=== no GitHub targets, skip GitHub stats only ===');
  });

  it('main.js 的 YouTube 段仍在 GitHub 段之后且位置未变', () => {
    const ghIdx = mainSrc.indexOf('var targets = (works || []).filter');
    const ytIdx = mainSrc.indexOf('var ytTargets = (works || []).filter');
    expect(ghIdx).toBeGreaterThan(-1);
    expect(ytIdx).toBeGreaterThan(ghIdx);
  });
});