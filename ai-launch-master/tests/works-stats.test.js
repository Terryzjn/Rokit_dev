'use strict';

// Works stats extraction · behavioral harness for renderer-utils/works-stats.js
//
// The module is loaded exactly like the browser does: a plain script that
// publishes window.RokitWorksStats, then create(deps) injects the small set of
// host dependencies. No jsdom / Electron required.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'renderer-utils', 'works-stats.js');
const SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function loadFactory(root) {
  const host = root || {};
  // The module is a browser script, not CommonJS. Passing window explicitly
  // mirrors the <script> load without leaking globals into the test process.
  new Function('window', SOURCE)(host);
  return host.RokitWorksStats;
}

function makeCard(id, opts) {
  opts = opts || {};
  const classes = new Set(opts.classes || []);
  const boxes = (opts.boxes || ['0', '0', '-']).map((text) => ({ textContent: text }));
  return {
    id,
    classes,
    boxes,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); }
    },
    querySelectorAll(selector) {
      return selector === '.wm .wv b' ? this.boxes : [];
    }
  };
}

function makeDoc(cards, btn) {
  return {
    getElementById(id) {
      return id === 'refreshWorksBtn' ? btn : null;
    },
    querySelectorAll(selector) {
      if (selector === '.wcard:not(.wsample)') {
        return cards.filter((card) => !card.classes.has('wsample'));
      }
      if (selector === '.wcard.ghs-loading') {
        return cards.filter((card) => card.classes.has('ghs-loading'));
      }
      return [];
    },
    querySelector(selector) {
      const match = /^\[data-work-id="(.+)"\]$/.exec(selector);
      if (!match) return null;
      return cards.find((card) => card.id === match[1] && !card.classes.has('wsample')) || null;
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(options) {
  options = options || {};
  const works = options.works || [];
  const cards = options.cards || [];
  const btn = options.btn || { disabled: false, textContent: '↻ 刷新' };
  const doc = makeDoc(cards, btn);
  const toast = vi.fn();
  const ytViewsText = options.ytViewsText || ((w) => `yt:${w && w.yt_views != null ? w.yt_views : '-'}`);
  const findWork = (id) => works.find((w) => w.id === id) || null;
  const root = options.root || {};
  root.document = doc;

  const api = options.api || {
    refreshGithubStats: vi.fn(async () => ({ ok: true, updates: [] })),
    saveWork: vi.fn(() => Promise.resolve())
  };

  const factory = loadFactory(root);
  const deps = {
    state: { works },
    findWork,
    ytViewsText,
    toast,
    api,
    document: doc
  };
  const stats = factory.create(deps);

  return { stats, refresh: stats.refresh, ghs: stats.ghs, toast, api, doc, btn, cards, works, root };
}

function payloadById(payload) {
  return payload.reduce((acc, item) => {
    acc[item.id] = item;
    return acc;
  }, {});
}

let warnSpy;
let logSpy;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('works-stats · refresh flow', () => {
  it('all success: updates GitHub + YouTube fields, persists per-field, refreshes cards and restores UI', async () => {
    const works = [
      {
        id: 'w1',
        name: 'Alpha',
        url: 'https://github.com/acme/alpha',
        yt_url: 'https://youtu.be/abc',
        yt_views: null
      },
      {
        id: 'w2',
        name: 'Beta',
        url: 'https://github.com/acme/beta'
      }
    ];
    const card1 = makeCard('w1');
    const card2 = makeCard('w2');
    const sample = makeCard('sample_w1', { classes: ['wsample'] });
    const pending = deferred();
    const api = {
      refreshGithubStats: vi.fn(() => pending.promise),
      saveWork: vi.fn(() => Promise.resolve())
    };
    const h = setup({ works, cards: [card1, card2, sample], api });

    const run = h.refresh();

    expect(api.refreshGithubStats).toHaveBeenCalledTimes(1);
    expect(api.refreshGithubStats.mock.calls[0][0]).toEqual([
      {
        id: 'w1',
        url: 'https://github.com/acme/alpha',
        yt_url: 'https://youtu.be/abc',
        name: 'Alpha',
        wantYt: true
      },
      {
        id: 'w2',
        url: 'https://github.com/acme/beta',
        yt_url: '',
        name: 'Beta',
        wantYt: false
      }
    ]);
    expect(h.btn.disabled).toBe(true);
    expect(h.btn.textContent).toBe('↻ 刷新中...');
    expect(card1.classes.has('ghs-loading')).toBe(true);
    expect(card2.classes.has('ghs-loading')).toBe(true);
    expect(sample.classes.has('ghs-loading')).toBe(false);

    pending.resolve({
      ok: true,
      updates: [
        {
          id: 'w1',
          ok: true,
          stars: 10,
          downloads: 20,
          visitors: 30,
          full_name: 'acme/alpha',
          yt_views: 100,
          yt_updated_at: '2026-10-20T00:00:00.000Z'
        },
        { id: 'w2', ok: true, stars: 1, downloads: 2, visitors: 3 }
      ]
    });
    await run;

    expect(works[0]).toMatchObject({
      star: 10,
      dl: 20,
      visitors: 30,
      githubFullName: 'acme/alpha',
      yt_views: 100,
      yt_updated_at: '2026-10-20T00:00:00.000Z'
    });
    expect(works[1]).toMatchObject({ star: 1, dl: 2, visitors: 3 });
    expect(works[1].yt_views).toBeUndefined();

    expect(api.saveWork).toHaveBeenCalledTimes(3);
    expect(api.saveWork).toHaveBeenCalledWith({
      id: 'w1',
      yt_views: 100,
      yt_updated_at: '2026-10-20T00:00:00.000Z'
    });
    expect(api.saveWork).toHaveBeenCalledWith({ id: 'w1', star: 10, dl: 20, visitors: 30 });
    expect(api.saveWork).toHaveBeenCalledWith({ id: 'w2', star: 1, dl: 2, visitors: 3 });

    expect(card1.boxes.map((b) => b.textContent)).toEqual(['10', '20', 'yt:100']);
    expect(card2.boxes.map((b) => b.textContent)).toEqual(['1', '2', 'yt:-']);

    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith('GitHub 数据刷新完成', 'ok', 1800);
    expect(h.ghs.lastRefreshAt).toBeGreaterThan(0);
    expect(h.ghs.isRefreshing).toBe(false);
    expect(h.btn.disabled).toBe(false);
    expect(h.btn.textContent).toBe('↻ 刷新');
    expect(card1.classes.has('ghs-loading')).toBe(false);
    expect(card2.classes.has('ghs-loading')).toBe(false);
  });

  it('partial failure: keeps old values, saves only successful fields, warns once', async () => {
    const works = [
      {
        id: 'w1',
        name: 'Alpha',
        url: 'https://github.com/acme/alpha',
        star: 9,
        dl: 8,
        visitors: 7
      },
      {
        id: 'w2',
        name: 'Beta',
        url: 'https://github.com/acme/beta',
        star: 6,
        dl: 3
      }
    ];
    const card1 = makeCard('w1');
    const card2 = makeCard('w2');
    const api = {
      refreshGithubStats: vi.fn(async () => ({
        ok: true,
        updates: [
          {
            id: 'w1',
            ok: true,
            stars: 11,
            downloads: null,
            visitors: null,
            downloads_error: 'downloads endpoint failed',
            visitors_error: 'visitors endpoint failed'
          },
          {
            id: 'w2',
            ok: false,
            error: 'request timed out',
            kind: 'timeout',
            status: null,
            code: 'ETIMEDOUT'
          }
        ]
      })),
      saveWork: vi.fn(() => Promise.resolve())
    };
    const h = setup({ works, cards: [card1, card2], api });

    await h.refresh();

    expect(works[0].star).toBe(11);
    expect(works[0].dl).toBe(8);
    expect(works[0].visitors).toBe(7);
    expect(works[1].star).toBe(6);
    expect(works[1].dl).toBe(3);

    expect(api.saveWork).toHaveBeenCalledTimes(1);
    expect(api.saveWork).toHaveBeenCalledWith({ id: 'w1', star: 11 });
    expect(api.saveWork.mock.calls.some((call) => call[0].dl === 0 || call[0].visitors === 0)).toBe(false);

    expect(card1.boxes.map((b) => b.textContent)).toEqual(['11', '8', 'yt:-']);
    expect(card2.boxes.map((b) => b.textContent)).toEqual(['6', '3', 'yt:-']);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledWith('部分 GitHub 数据刷新失败（1 个保留旧数据）', 'warn', 2600);
    expect(h.ghs.isRefreshing).toBe(false);
  });

  it('all failure: never writes 0 and never overwrites existing values', async () => {
    const works = [
      {
        id: 'w1',
        name: 'Alpha',
        url: 'https://github.com/acme/alpha',
        star: 9,
        dl: 8,
        visitors: 7,
        yt_url: 'https://youtu.be/abc',
        yt_views: 50,
        yt_updated_at: new Date().toISOString()
      }
    ];
    const card = makeCard('w1');
    const api = {
      refreshGithubStats: vi.fn(async () => ({
        ok: true,
        updates: [
          {
            id: 'w1',
            ok: false,
            error: 'rate limited',
            kind: 'http',
            status: 504,
            code: 'ETIMEDOUT',
            gh_message: 'rate limited'
          }
        ]
      })),
      saveWork: vi.fn(() => Promise.resolve())
    };
    const h = setup({ works, cards: [card], api });

    await h.refresh();

    expect(works[0]).toMatchObject({ star: 9, dl: 8, visitors: 7, yt_views: 50 });
    expect(api.saveWork).not.toHaveBeenCalled();
    expect(card.boxes.map((b) => b.textContent)).toEqual(['9', '8', 'yt:50']);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.toast.mock.calls[0][0]).toBe(
      'GitHub Star 失败 （Alpha） ： HTTP 状态异常 · HTTP 504 · ETIMEDOUT · GitHub: rate limited'
    );
    expect(h.toast.mock.calls[0][1]).toBe(true);
    expect(h.toast.mock.calls[0][2]).toBe(4500);
    expect(h.ghs.lastRefreshAt).toBeGreaterThan(0);
    expect(h.ghs.isRefreshing).toBe(false);
  });
});

describe('works-stats · cache and concurrency', () => {
  it('computes wantYt from force, cache TTL and YouTube links', async () => {
    const now = Date.now();
    const fresh = new Date(now - 60 * 60 * 1000).toISOString();
    const stale = new Date(now - 7 * 60 * 60 * 1000).toISOString();
    const works = [
      { id: 'a', name: 'A', url: 'https://github.com/acme/a', yt_url: 'https://youtu.be/a', yt_views: 5, yt_updated_at: fresh },
      { id: 'b', name: 'B', url: 'https://github.com/acme/b', yt_url: 'https://youtu.be/b', yt_views: null },
      {
        id: 'c',
        name: 'C',
        url: 'https://www.youtube.com/watch?v=ccccccccccc',
        yt_views: 5,
        yt_updated_at: stale
      },
      { id: 'd', name: 'D', url: 'https://github.com/acme/d' },
      { id: 'e', name: 'E', url: 'https://github.com/acme/e', yt_url: 'https://youtu.be/e', yt_views: 5 },
      { id: 'f', name: 'F', url: 'https://github.com/acme/f', yt_url: '   ', yt_views: 5, yt_updated_at: fresh }
    ];
    const api = {
      refreshGithubStats: vi.fn(async () => ({ ok: true, updates: [] })),
      saveWork: vi.fn(() => Promise.resolve())
    };
    const h = setup({ works, api });

    await h.refresh();
    let payload = payloadById(api.refreshGithubStats.mock.calls[0][0]);
    expect(payload.a.wantYt).toBe(false);
    expect(payload.b.wantYt).toBe(true);
    expect(payload.c.wantYt).toBe(true);
    expect(payload.d.wantYt).toBe(false);
    expect(payload.e.wantYt).toBe(true);
    expect(payload.f.wantYt).toBe(false);

    api.refreshGithubStats.mockClear();
    await h.refresh({ force: true });
    payload = payloadById(api.refreshGithubStats.mock.calls[0][0]);
    expect(payload.a.wantYt).toBe(true);
    expect(payload.b.wantYt).toBe(true);
    expect(payload.c.wantYt).toBe(true);
    expect(payload.d.wantYt).toBe(false);
    expect(payload.e.wantYt).toBe(true);
    expect(payload.f.wantYt).toBe(false);

    expect(api.saveWork).not.toHaveBeenCalled();
    expect(h.ghs.isRefreshing).toBe(false);
  });

  it('skips a concurrent refresh and only unlocks after the first one settles', async () => {
    const works = [{ id: 'w1', name: 'Alpha', url: 'https://github.com/acme/alpha' }];
    const card = makeCard('w1');
    const pending = deferred();
    const api = {
      refreshGithubStats: vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce({ ok: true, updates: [] }),
      saveWork: vi.fn(() => Promise.resolve())
    };
    const h = setup({ works, cards: [card], api });

    const first = h.refresh();
    const second = h.refresh();

    expect(api.refreshGithubStats).toHaveBeenCalledTimes(1);
    await second;
    expect(logSpy).toHaveBeenCalledWith('[GitHubStats] refresh already in progress, skip');
    expect(h.ghs.isRefreshing).toBe(true);
    expect(h.btn.disabled).toBe(true);
    expect(card.classes.has('ghs-loading')).toBe(true);

    pending.resolve({ ok: true, updates: [] });
    await first;

    expect(h.ghs.isRefreshing).toBe(false);
    expect(h.btn.disabled).toBe(false);
    expect(h.btn.textContent).toBe('↻ 刷新');
    expect(card.classes.has('ghs-loading')).toBe(false);

    await h.refresh();
    expect(api.refreshGithubStats).toHaveBeenCalledTimes(2);
  });
});

describe('works-stats · failure cleanup', () => {
  it('restores button and loading state when the IPC result is not ok', async () => {
    const works = [{ id: 'w1', name: 'Alpha', url: 'https://github.com/acme/alpha' }];
    const card = makeCard('w1');
    const sample = makeCard('sample_w1', { classes: ['wsample'] });
    const api = {
      refreshGithubStats: vi.fn(async () => ({ ok: false, error: 'socket closed' })),
      saveWork: vi.fn(() => Promise.resolve())
    };
    const h = setup({ works, cards: [card, sample], api });

    await h.refresh();

    expect(api.saveWork).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[GitHubStats] IPC failed:', 'socket closed');
    expect(h.toast).toHaveBeenCalledWith('GitHub 刷新失败：socket closed', 'warn', 3000);
    expect(h.ghs.lastRefreshAt).toBe(0);
    expect(h.ghs.isRefreshing).toBe(false);
    expect(h.btn.disabled).toBe(false);
    expect(h.btn.textContent).toBe('↻ 刷新');
    expect(card.classes.has('ghs-loading')).toBe(false);
    expect(sample.classes.has('ghs-loading')).toBe(false);
  });

  it('restores button and loading state when refreshGithubStats throws', async () => {
    const works = [{ id: 'w1', name: 'Alpha', url: 'https://github.com/acme/alpha' }];
    const card = makeCard('w1');
    const api = {
      refreshGithubStats: vi.fn(async () => {
        throw new Error('kaput');
      }),
      saveWork: vi.fn(() => Promise.resolve())
    };
    const h = setup({ works, cards: [card], api });

    await h.refresh();

    expect(warnSpy).toHaveBeenCalledWith('[GitHubStats] unexpected error:', 'kaput');
    expect(h.toast).toHaveBeenCalledWith('GitHub 刷新异常：kaput', 'warn', 3000);
    expect(h.ghs.lastRefreshAt).toBe(0);
    expect(h.ghs.isRefreshing).toBe(false);
    expect(h.btn.disabled).toBe(false);
    expect(h.btn.textContent).toBe('↻ 刷新');
    expect(card.classes.has('ghs-loading')).toBe(false);
  });

  it('warns without starting a refresh when there are no real works', async () => {
    const works = [{ id: 'sample_w1', isSample: true }];
    const sample = makeCard('sample_w1', { classes: ['wsample'] });
    const api = {
      refreshGithubStats: vi.fn(async () => ({ ok: true, updates: [] })),
      saveWork: vi.fn(() => Promise.resolve())
    };
    const h = setup({ works, cards: [sample], api });

    await h.refresh();

    expect(api.refreshGithubStats).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('还没有真实作品，先点「+ 登记新作品」', 'warn');
    expect(h.ghs.isRefreshing).toBe(false);
    expect(h.ghs.lastRefreshAt).toBe(0);
    expect(h.btn.disabled).toBe(false);
    expect(h.btn.textContent).toBe('↻ 刷新');
    expect(sample.classes.has('ghs-loading')).toBe(false);
  });
});

describe('works-stats · YouTube-only semantics', () => {
  it('persists YouTube-only success and keeps prior values on no-auth failure', async () => {
    const works = [
      {
        id: 'w1',
        name: 'Alpha',
        url: 'https://github.com/acme/alpha',
        star: 9,
        yt_url: 'https://youtu.be/a',
        yt_views: 50,
        yt_updated_at: new Date().toISOString()
      },
      {
        id: 'w2',
        name: 'Beta',
        url: 'https://github.com/acme/beta',
        star: 6,
        yt_url: 'https://youtu.be/b',
        yt_views: 70,
        yt_updated_at: new Date().toISOString()
      }
    ];
    const api = {
      refreshGithubStats: vi.fn(async () => ({
        ok: true,
        updates: [
          {
            id: 'w1',
            ytOnly: true,
            yt_views: 42,
            yt_updated_at: '2026-10-24T00:00:00.000Z'
          },
          {
            id: 'w2',
            ytOnly: true,
            yt_views_error: 'unauthorized',
            yt_reason: 'no-auth',
            yt_http_status: 401
          }
        ]
      })),
      saveWork: vi.fn(() => Promise.resolve())
    };
    const h = setup({ works, api });

    await h.refresh();

    expect(works[0].yt_views).toBe(42);
    expect(works[0].yt_updated_at).toBe('2026-10-24T00:00:00.000Z');
    expect(works[0].star).toBe(9);
    expect(works[1].yt_views).toBe(70);
    expect(works[1].star).toBe(6);
    expect(api.saveWork).toHaveBeenCalledTimes(1);
    expect(api.saveWork).toHaveBeenCalledWith({
      id: 'w1',
      yt_views: 42,
      yt_updated_at: '2026-10-24T00:00:00.000Z'
    });
    expect(h.toast).toHaveBeenCalledWith(
      'YouTube 未授权，播放量未更新；请到「推广渠道」完成 YouTube 授权',
      'warn',
      4200
    );
    expect(h.ghs.isRefreshing).toBe(false);
  });
});

describe('works-stats · dependency bridge', () => {
  it('resolves api and document from the host window when not injected', async () => {
    const works = [{ id: 'w1', name: 'Alpha', url: 'https://github.com/acme/alpha' }];
    const btn = { disabled: false, textContent: '↻ 刷新' };
    const card = makeCard('w1');
    const doc = makeDoc([card], btn);
    const root = { document: doc };
    const toast = vi.fn();
    const factory = loadFactory(root);
    const stats = factory.create({
      state: { works },
      findWork: (id) => works.find((w) => w.id === id) || null,
      ytViewsText: (w) => `yt:${w.yt_views != null ? w.yt_views : '-'}`,
      toast
    });

    // api is looked up at call time, not captured at create() time.
    root.api = {
      refreshGithubStats: vi.fn(async () => ({
        ok: true,
        updates: [{ id: 'w1', ok: true, stars: 4, downloads: 5, visitors: 6 }]
      })),
      saveWork: vi.fn(() => Promise.resolve())
    };

    await stats.refresh();

    expect(root.api.refreshGithubStats).toHaveBeenCalledTimes(1);
    expect(works[0]).toMatchObject({ star: 4, dl: 5, visitors: 6 });
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('↻ 刷新');
    expect(card.boxes.map((b) => b.textContent)).toEqual(['4', '5', 'yt:-']);
    expect(toast).toHaveBeenCalledWith('GitHub 数据刷新完成', 'ok', 1800);
  });
});

describe('works-stats · index.html wiring', () => {
  it('loads the module and keeps only the compatibility bridge', () => {
    const tag = '<script src="renderer-utils/works-stats.js"></script>';
    expect(INDEX).toContain(tag);
    expect(INDEX.indexOf(tag)).toBeLessThan(INDEX.indexOf('window.RokitWorksStats.create'));
    expect(INDEX).toContain('var worksStats = window.RokitWorksStats.create({');
    expect(INDEX).toContain('window.__ghs = worksStats.ghs;');
    expect(INDEX).toContain('window.refreshWorksGithubStats = worksStats.refresh;');

    // The old business implementation must not remain in the host file.
    expect(INDEX).not.toContain('window.refreshWorksGithubStats = async function');
    expect(INDEX).not.toContain('var YT_CACHE_TTL = 6*3600*1000;');
    expect(INDEX).not.toContain('refresh already in progress, skip');
  });

  it('keeps the first-entry refresh timing in go(works)', () => {
    const start = INDEX.indexOf("if(r==='works'){");
    expect(start).toBeGreaterThan(-1);
    const block = INDEX.slice(start, start + 900);
    expect(block).toContain('renderWorks();');
    expect(block).toContain('window.__ghs && !window.__ghs.worksFirstLoaded');
    expect(block).toContain('window.__ghs.worksFirstLoaded = true;');
    expect(block).toContain(
      "if(typeof window.refreshWorksGithubStats==='function') window.refreshWorksGithubStats();"
    );
    expect(block).toContain('}, 600);');
    expect(INDEX).toContain('onclick="refreshWorksGithubStats({force:true})"');
  });

  it('keeps the refresh entry signature and core invariants in the module', () => {
    expect(SOURCE).toContain('async function refreshWorksGithubStats(opts)');
    expect(SOURCE).toContain('6*3600*1000');
    expect(SOURCE).toContain('__ghs.isRefreshing');
    expect(SOURCE).toContain('u.ytOnly');
    expect(SOURCE).toContain('getApi().saveWork');
    expect(SOURCE).toContain('return { refresh: refreshWorksGithubStats, ghs: __ghs };');
    expect(SOURCE).not.toMatch(/^\s*(import|export)\s/m);
  });
});
