// Rokit · queue 主推队列单元测试（v1.5）
// 目标：pickMain 选主推规则 + schedule 写回 store

describe('queue · pickMain', () => {
  const { pickMain } = require('../electron/queue');

  it('空数组应返回 null', () => {
    expect(pickMain([])).toBe(null);
    expect(pickMain(null)).toBe(null);
  });

  it('单一作品应被选为主推（默认 launching 状态）', () => {
    const works = [{ id: 'w1', name: 'A', status: 'launching' }];
    const main = pickMain(works);
    expect(main).not.toBeNull();
    expect(main.id).toBe('w1');
    expect(main.queue_state).toBe('main');
  });

  it('launching 状态应优先于 pending', () => {
    const works = [
      { id: 'w1', name: 'pending-A', status: 'pending', priority: 10 },
      { id: 'w2', name: 'launching-B', status: 'launching', priority: 1 }
    ];
    const main = pickMain(works);
    expect(main.id).toBe('w2');
    expect(works.find(w => w.id === 'w2').queue_state).toBe('main');
  });

  it('priority DESC 应在同状态生效', () => {
    const works = [
      { id: 'low', status: 'launching', priority: 1 },
      { id: 'high', status: 'launching', priority: 99 }
    ];
    const main = pickMain(works);
    expect(main.id).toBe('high');
  });

  it('archived 作品应被排除', () => {
    const works = [
      { id: 'arch', status: 'archived', priority: 999 },
      { id: 'live', status: 'launching', priority: 1 }
    ];
    const main = pickMain(works);
    expect(main.id).toBe('live');
  });

  it('stable + ageDays >= 14 应被排除（默认 stableThresholdDays=14）', () => {
    const now = Date.now();
    const fifteenDaysAgo = new Date(now - 15 * 86400000).toISOString();
    const works = [
      { id: 'old-stable', status: 'stable', launched_at: fifteenDaysAgo, priority: 999 },
      { id: 'fresh', status: 'launching', priority: 1 }
    ];
    const main = pickMain(works, { now: now });
    expect(main.id).toBe('fresh');
  });

  it('stable 但 < 14 天仍可参与主推（与 launching 同台竞技时 launching 优先）', () => {
    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 86400000).toISOString();
    const works = [
      { id: 'stable-recent', status: 'stable', launched_at: twoDaysAgo, priority: 999 },
      { id: 'launching', status: 'launching', priority: 1 }
    ];
    const main = pickMain(works, { now: now });
    // launching 状态名次高于 stable → launching 胜出
    expect(main.id).toBe('launching');
  });

  it('stable < 14 天 且无 launching 状态时：同 priority 下 launched_at ASC（旧者优先主推）', () => {
    const now = Date.now();
    const oldLaunched = new Date(now - 10 * 86400000).toISOString();
    const newLaunched = new Date(now - 2 * 86400000).toISOString();
    const works = [
      { id: 'fresh', status: 'stable', launched_at: newLaunched, priority: 1 },
      { id: 'old', status: 'stable', launched_at: oldLaunched, priority: 1 }
    ];
    const main = pickMain(works, { now: now });
    // 同 priority 下 launched_at 越久（timestamp 越大）越靠后 → 旧的胜
    expect(main.id).toBe('old');
  });

  it('stable < 14 天：priority DESC 优先于 launched_at', () => {
    const now = Date.now();
    const oldLaunched = new Date(now - 10 * 86400000).toISOString();
    const newLaunched = new Date(now - 2 * 86400000).toISOString();
    const works = [
      { id: 'fresh-high', status: 'stable', launched_at: newLaunched, priority: 99 },
      { id: 'old-low', status: 'stable', launched_at: oldLaunched, priority: 1 }
    ];
    const main = pickMain(works, { now: now });
    expect(main.id).toBe('fresh-high');
  });

  it('全部 archived 时应兜底返回 least-bad', () => {
    const works = [
      { id: 'a', status: 'archived', priority: 1 },
      { id: 'b', status: 'archived', priority: 99 }
    ];
    const main = pickMain(works);
    expect(main).not.toBeNull();
    expect(main.id).toBe('b'); // priority DESC
  });

  it('launched_at null 视为最新 → 与 created_at ASC 共同决定次序', () => {
    const works = [
      { id: 'old', status: 'launching', launched_at: null, created_at: '2024-01-01T00:00:00Z', priority: 1 },
      { id: 'new', status: 'launching', launched_at: null, created_at: '2024-12-01T00:00:00Z', priority: 1 }
    ];
    const main = pickMain(works);
    expect(main.id).toBe('old');
  });

  it('旧主推的 queue_state 应被 mutate 为 parked', () => {
    const works = [
      { id: 'old', status: 'launching', queue_state: 'main', priority: 1 },
      { id: 'new', status: 'launching', priority: 99 }
    ];
    pickMain(works);
    expect(works.find(w => w.id === 'old').queue_state).toBe('parked');
    expect(works.find(w => w.id === 'new').queue_state).toBe('main');
  });
});

describe('queue · schedule', () => {
  const { schedule } = require('../electron/queue');

  it('空作品应安全返回', async () => {
    const fakeStore = { listWorks: () => [], saveWork: () => {} };
    const r = await schedule(fakeStore);
    expect(r.main).toBe(null);
    expect(r.demoted).toEqual([]);
    expect(r.promoted).toEqual([]);
  });

  it('null store 应安全返回', async () => {
    const r = await schedule(null);
    expect(r.main).toBe(null);
  });

  it('首次调度：所有作品应被 promoted，无 demoted', async () => {
    const saved = [];
    const fakeStore = {
      listWorks: () => [
        { id: 'w1', status: 'launching', name: 'A' },
        { id: 'w2', status: 'pending', name: 'B' }
      ],
      saveWork: (w) => saved.push(w)
    };
    const r = await schedule(fakeStore);
    expect(r.main).toBe('w1');
    expect(r.promoted).toContain('w1');
    expect(r.demoted).toEqual([]);
    expect(saved.length).toBeGreaterThan(0);
    // 主推应带 main queue_state
    const main = saved.find(s => s.id === 'w1');
    expect(main.queue_state).toBe('main');
  });

  it('替换主推：旧 main 应被 demoted，新 main 应被 promoted', async () => {
    const fakeStore = {
      listWorks: () => [
        { id: 'old', status: 'stable', queue_state: 'main', priority: 99, name: 'Old', launched_at: new Date().toISOString() },
        { id: 'new', status: 'launching', priority: 999, name: 'New' }
      ],
      saveWork: () => {}
    };
    const r = await schedule(fakeStore);
    expect(r.main).toBe('new');
    expect(r.promoted).toContain('new');
    expect(r.demoted).toContain('old');
  });

  it('saveWork 抛错时 schedule 不应中断', async () => {
    const fakeStore = {
      listWorks: () => [{ id: 'w1', status: 'launching' }],
      saveWork: () => { throw new Error('save-fail'); }
    };
    const r = await schedule(fakeStore);
    expect(r.main).toBe('w1'); // 主推选择仍然成功
  });
});