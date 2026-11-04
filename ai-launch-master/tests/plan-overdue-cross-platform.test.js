'use strict';

// Rokit · 首秀计划跨平台逾期检测（第一批实施）
//
// 覆盖需求：
//   1  GitHub 逾期 pending 任务可以被检测和保护
//   2  YouTube 逾期 pending 任务可以被检测和保护，即使 real_only=0
//   3  微信公众号逾期 pending 任务可以被检测和保护，即使 real_only=0
//   4  未逾期任务不会被保护
//   5  非 pending 任务不会被误判为逾期
//   6  模拟任务与真实任务原有执行资格不被改变
//   7  GitHub 视频快照读取正常
//   8  YouTube 视频快照读取正常
//   9  微信公众号没有视频快照时不会错误读取其他平台路径
//   10 逾期保护后，调度器不会绕过保护自动执行这些任务
//
// 全部使用临时目录里的独立数据库，不触碰用户生产数据库；
// 不调用任何真实平台 API，不执行真实上传，不修改真实计划状态。

const path = require('path');
const H = require('./helpers/plan-store');

const NOW = '2026-10-30T04:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const VIDEO_OK = 'C:\\videos\\final\\v1.mp4';

let tmpDir, dbPath;

beforeEach(() => {
  tmpDir = H.makeTmpDir();
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  H.restoreDrivers();
  H.rmTmpDir(tmpDir);
  ['store', 'plan-ipc', 'plan-scheduler'].forEach(function (n) {
    delete require.cache[require.resolve(path.join(H.ROOT, 'electron', n))];
  });
});

function newStore(mode) {
  const { Store } = H.loadStoreFresh(mode === 'json');
  return new Store(dbPath);
}

function makeIpc(store, extraDeps) {
  const handlers = new Map();
  const ipcMain = { handle: function (ch, fn) { handlers.set(ch, fn); } };
  const storeRef = { current: store };
  require(path.join(H.ROOT, 'electron', 'plan-ipc')).registerPlanIpc(ipcMain, Object.assign({
    getStore: function () { return storeRef.current; }
  }, extraDeps || {}));
  return { handlers: handlers, storeRef: storeRef };
}

// 造一个多平台首秀计划，并把所有任务排到过去（模拟"关闭软件等待逾期"）
function seedPlan(store, workId, platforms, opts) {
  opts = opts || {};
  H.seedWork(store, workId, '作品 ' + workId);
  store.savePlanStages(workId, [{
    id: 'ps_' + workId,
    title: '阶段 ' + workId,
    desc: '',
    offsetDays: 0,
    timeOfDay: '20:00',
    platforms: platforms,
    copy: opts.copy || {}
  }]);
  const tasks = store.listPlanTasks(workId);
  tasks.forEach(function (t) {
    store.updatePlanTask(workId, t.id, { scheduled_at: opts.at || PAST });
  });
  return store.listPlanTasks(workId);
}

// 记录调度器实际执行了哪些任务
function trackingScheduler(store, opts) {
  opts = opts || {};
  const calls = [];
  const { createPlanScheduler } = require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
  const scheduler = createPlanScheduler({
    getStore: function () { return store; },
    executorKind: opts.kind || 'real',
    holdMissedOverdueOnStart: opts.holdOnStart !== false,
    realExecutors: {
      github: function (task) {
        calls.push('gh:' + String(task.id));
        return { ok: true, simulated: false, status: 'done', platform_ref: 'gh:' + task.id };
      },
      youtube: function (task) {
        calls.push('yt:' + String(task.id));
        return { ok: true, simulated: false, status: 'done', platform_ref: 'yt:' + task.id };
      }
    }
  });
  return { calls: calls, scheduler: scheduler };
}

function videoDeps() {
  return {
    checkFinalVideoPath: function (p) {
      return { ok: true, filePath: String(p), size: 1024 };
    },
    getWorkFinalVideo: function () {
      return { ok: false, error: 'no-final-video' };
    }
  };
}

// 作品最新成品视频映射**失效**（文件被删 / 路径不在白名单）
function brokenVideoDeps() {
  return {
    checkFinalVideoPath: function () {
      return { ok: false, error: 'file-missing', detail: '成品视频文件不存在' };
    },
    getWorkFinalVideo: function () {
      return { ok: false, error: 'file-missing', storedPath: 'C:\\videos\\final\\gone.mp4', detail: '成品视频文件不存在' };
    }
  };
}

// 作品最新成品视频映射**有效**
function validWorkVideoDeps() {
  return {
    checkFinalVideoPath: function (p) {
      return { ok: true, filePath: String(p), size: 1024 };
    },
    getWorkFinalVideo: function () {
      return { ok: true, path: VIDEO_OK, size: 1024 };
    }
  };
}

// 带微信公众号真实执行器桩的调度器（只用于本组用例，不改动既有 trackingScheduler）
function trackingSchedulerWithWechat(store) {
  const calls = [];
  const { createPlanScheduler } = require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
  const scheduler = createPlanScheduler({
    getStore: function () { return store; },
    executorKind: 'real',
    holdMissedOverdueOnStart: false,
    realExecutors: {
      github: function (task) {
        calls.push('gh:' + String(task.id));
        return { ok: true, simulated: false, status: 'done', platform_ref: 'gh:' + task.id };
      },
      youtube: function (task) {
        calls.push('yt:' + String(task.id));
        return { ok: true, simulated: false, status: 'done', platform_ref: 'yt:' + task.id };
      },
      wechat: function (task) {
        calls.push('wx:' + String(task.id));
        return { ok: true, simulated: false, status: 'done', platform_ref: 'wx:' + task.id };
      }
    }
  });
  return { calls: calls, scheduler: scheduler };
}

function taskOf(store, workId, platformId) {
  return store.listPlanTasks(workId).filter(function (t) {
    return String(t.platform_id) === String(platformId);
  })[0];
}

/* ==================================================================
   1 · GitHub 逾期任务可以被检测和保护
   ================================================================== */
describe('1 · GitHub 逾期任务可检测可保护', () => {
  it('GitHub 逾期 pending 任务出现在 plan:overdue 列表里', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github']);
    const h = makeIpc(store, videoDeps());

    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.ok).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].platform).toBe('github');
    expect(res.items[0].platformLabel).toBe('GitHub');
    expect(res.items[0].status).toBe('pending');
    expect(res.items[0].scheduledAt).toBe(PAST);
  });

  it('GitHub 逾期任务在启动时被打上保护标记', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github']);

    const held = store.holdMissedPlanTasks(NOW);
    expect(held.held).toHaveLength(1);
    const t = taskOf(store, 'w1', 'github');
    expect(store.isPlanTaskHeld(t.id, t.scheduled_at)).toBe(true);
  });
});

/* ==================================================================
   2 · YouTube 逾期任务可以被检测和保护
   ================================================================== */
describe('2 · YouTube 逾期任务可检测可保护', () => {
  it('YouTube 逾期 pending 任务出现在 plan:overdue 列表里', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube']);
    const h = makeIpc(store, videoDeps());

    // YouTube 已接入真实发布通道 → 真实执行候选（real_only=1）
    const t = taskOf(store, 'w1', 'youtube');
    expect(t.real_only).toBe(1);

    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.ok).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].platform).toBe('youtube');
    expect(res.items[0].platformLabel).toBe('YouTube');
    expect(res.items[0].status).toBe('pending');
  });

  it('YouTube 逾期任务在启动时被打上保护标记', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube']);

    const held = store.holdMissedPlanTasks(NOW);
    expect(held.held).toHaveLength(1);
    expect(held.held[0].platformId).toBe('youtube');
    const t = taskOf(store, 'w1', 'youtube');
    expect(store.isPlanTaskHeld(t.id, t.scheduled_at)).toBe(true);
  });
});

/* ==================================================================
   3 · 微信公众号逾期任务可以被检测和保护
   ================================================================== */
describe('3 · 微信公众号逾期任务可检测可保护', () => {
  it('微信公众号逾期 pending 任务出现在 plan:overdue 列表里', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['wechat']);
    const h = makeIpc(store, videoDeps());

    // 公众号已接入真实草稿创建通道 → 真实执行候选（real_only=1）
    const t = taskOf(store, 'w1', 'wechat');
    expect(t.real_only).toBe(1);

    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.ok).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].platform).toBe('wechat');
    expect(res.items[0].platformLabel).toBe('微信公众号');
  });

  it('微信公众号逾期任务在启动时被打上保护标记', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['wechat']);

    const held = store.holdMissedPlanTasks(NOW);
    expect(held.held).toHaveLength(1);
    expect(held.held[0].platformId).toBe('wechat');
    const t = taskOf(store, 'w1', 'wechat');
    expect(store.isPlanTaskHeld(t.id, t.scheduled_at)).toBe(true);
  });

  it('三个平台同时逾期时全部被检出并全部被保护', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github', 'youtube', 'wechat']);
    const h = makeIpc(store, videoDeps());

    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items).toHaveLength(3);
    expect(res.items.map(function (i) { return i.platform; }).sort()).toEqual(['github', 'wechat', 'youtube']);

    const held = store.holdMissedPlanTasks(NOW);
    expect(held.held).toHaveLength(3);
    ['github', 'youtube', 'wechat'].forEach(function (pid) {
      const t = taskOf(store, 'w1', pid);
      expect(store.isPlanTaskHeld(t.id, t.scheduled_at)).toBe(true);
    });
  });
});

/* ==================================================================
   4 · 未逾期任务不会被保护
   ================================================================== */
describe('4 · 未逾期任务不会被保护', () => {
  it('计划时间还没到的任务既不进逾期列表，也不被打保护标记', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github', 'youtube', 'wechat'], { at: FUTURE });
    const h = makeIpc(store, videoDeps());

    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items).toHaveLength(0);

    const held = store.holdMissedPlanTasks(NOW);
    expect(held.held).toHaveLength(0);
    ['github', 'youtube', 'wechat'].forEach(function (pid) {
      const t = taskOf(store, 'w1', pid);
      expect(store.isPlanTaskHeld(t.id, t.scheduled_at)).toBe(false);
    });
  });

  it('没有计划时间的任务不会被保护', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube']);
    const t = taskOf(store, 'w1', 'youtube');
    store._planWriteTask(Object.assign({}, t, { scheduled_at: '' }));

    const held = store.holdMissedPlanTasks(NOW);
    expect(held.held).toHaveLength(0);
  });
});

/* ==================================================================
   5 · 非 pending 任务不会被误判为逾期
   ================================================================== */
describe('5 · 非 pending 任务不误判', () => {
  it('done / cancelled / failed / draft_pending / running / needs_review 都不算逾期', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube']);
    const h = makeIpc(store, videoDeps());
    const t = taskOf(store, 'w1', 'youtube');

    ['done', 'cancelled', 'failed', 'draft_pending', 'running', 'needs_review'].forEach(function (st) {
      store._planWriteTask(Object.assign({}, taskOf(store, 'w1', 'youtube'), {
        status: st,
        scheduled_at: PAST
      }));
      const res = h.handlers.get('plan:overdue')({}, { now: NOW });
      expect(res.items).toHaveLength(0);
    });

    // 保护标记也只针对 pending
    store._planWriteTask(Object.assign({}, taskOf(store, 'w1', 'youtube'), {
      status: 'done', scheduled_at: PAST
    }));
    const held = store.holdMissedPlanTasks(NOW);
    expect(held.held).toHaveLength(0);
  });
});

/* ==================================================================
   6 · 模拟任务与真实任务的原有执行资格不被改变
   ================================================================== */
describe('6 · 原有执行资格不被改变', () => {
  it('已接入真实发布通道的平台 real_only=1，未接入的仍为 0', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github', 'youtube', 'wechat']);
    // github / youtube / wechat 均已接入真实发布通道 → 真实执行候选
    expect(taskOf(store, 'w1', 'github').real_only).toBe(1);
    expect(taskOf(store, 'w1', 'youtube').real_only).toBe(1);
    expect(taskOf(store, 'w1', 'wechat').real_only).toBe(1);
  });

  it('逾期检测不改变任务的 real_only / simulated', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github', 'youtube']);
    const h = makeIpc(store, videoDeps());
    h.handlers.get('plan:overdue')({}, { now: NOW });
    store.holdMissedPlanTasks(NOW);

    expect(taskOf(store, 'w1', 'github').real_only).toBe(1);
    expect(taskOf(store, 'w1', 'youtube').real_only).toBe(1);
    expect(taskOf(store, 'w1', 'youtube').simulated).toBe(0);
    expect(taskOf(store, 'w1', 'github').simulated).toBe(0);
  });

  it('未逾期的 normal pending 任务照常进入到期名单（真实路径）', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube'], { at: PAST });
    // 未打保护标记 → 仍在名单里（真实调度器照常处理）
    const due = store.listDuePlanTasks(NOW, { forRealExecutor: true });
    expect(due.map(function (t) { return t.platform_id; })).toContain('youtube');
  });

  it('real_only=1 的任务仍然只被真实执行器接手（模拟名单不含它）', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github', 'youtube', 'wechat'], { at: PAST });
    const dueMock = store.listDuePlanTasks(NOW);
    // 三个平台都是真实执行候选 → 模拟名单全都不含
    expect(dueMock.map(function (t) { return t.platform_id; })).not.toContain('github');
    expect(dueMock.map(function (t) { return t.platform_id; })).not.toContain('youtube');
    expect(dueMock.map(function (t) { return t.platform_id; })).not.toContain('wechat');
  });
});

/* ==================================================================
   7-9 · 视频快照按平台读取
   ================================================================== */
describe('7-9 · 逾期视频快照按平台读取', () => {
  it('GitHub 任务读 copy.github.videoPath', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github'], {
      copy: { github: { title: 'T', body: 'B', videoPath: VIDEO_OK } }
    });
    const h = makeIpc(store, videoDeps());
    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].video.source).toBe('snapshot');
    expect(res.items[0].video.path).toBe(VIDEO_OK);
    expect(res.items[0].video.ok).toBe(true);
  });

  it('YouTube 任务读 copy.youtube.videoPath', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube'], {
      copy: { youtube: { title: 'T', body: 'B', videoPath: VIDEO_OK } }
    });
    const h = makeIpc(store, videoDeps());
    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].video.source).toBe('snapshot');
    expect(res.items[0].video.path).toBe(VIDEO_OK);
    expect(res.items[0].video.ok).toBe(true);
  });

  it('YouTube 任务绝不读 GitHub 的快照（阶段里只有 github 段时）', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube'], {
      copy: { github: { title: 'T', body: 'B', videoPath: VIDEO_OK } }
    });
    const h = makeIpc(store, videoDeps());
    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items).toHaveLength(1);
    // 不得把 GitHub 的路径当成 YouTube 的快照
    expect(res.items[0].video.source).not.toBe('snapshot');
    expect(res.items[0].video.path).not.toBe(VIDEO_OK);
  });

  it('微信公众号没有视频快照时不会错误读取其它平台路径', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['wechat'], {
      copy: { github: { title: 'T', body: 'B', videoPath: VIDEO_OK } }
    });
    const h = makeIpc(store, videoDeps());
    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].platform).toBe('wechat');
    expect(res.items[0].video.source).not.toBe('snapshot');
    expect(res.items[0].video.path).not.toBe(VIDEO_OK);
  });

  it('放弃 YouTube 计划只解绑 youtube 快照，不动 copy.github', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube'], {
      copy: {
        github: { title: 'G', body: 'B', videoPath: VIDEO_OK },
        youtube: { title: 'Y', body: 'B', videoPath: VIDEO_OK }
      }
    });
    const h = makeIpc(store, videoDeps());
    const t = taskOf(store, 'w1', 'youtube');

    const res = h.handlers.get('plan:overdue-abandon')({}, 'w1', t.id, { confirmed: true });
    expect(res.ok).toBe(true);

    const copy = store.listPlanStages('w1')[0].copy;
    expect(copy.youtube.videoPath).toBeUndefined();
    // GitHub 的快照原封不动
    expect(copy.github.videoPath).toBe(VIDEO_OK);
    expect(copy.github.title).toBe('G');
  });
});

/* ==================================================================
   10 · 逾期保护后，调度器不会绕过保护自动执行
   ================================================================== */
describe('10 · 逾期保护后调度器不自动执行', () => {
  it('启动扫描不会消费掉三个平台的逾期任务（全部保持 pending）', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github', 'youtube', 'wechat']);

    const { calls, scheduler } = trackingScheduler(store);
    scheduler.start();

    ['github', 'youtube', 'wechat'].forEach(function (pid) {
      const t = taskOf(store, 'w1', pid);
      expect(t.status).toBe('pending');
      expect(store.isPlanTaskHeld(t.id, t.scheduled_at)).toBe(true);
    });
    // 真实执行器一次都没被调用
    expect(calls).toHaveLength(0);
  });

  it('启动后 plan:overdue 能列出三个平台的逾期任务', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github', 'youtube', 'wechat']);

    const { scheduler } = trackingScheduler(store);
    scheduler.start();

    const h = makeIpc(store, videoDeps());
    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items).toHaveLength(3);
    expect(res.items.map(function (i) { return i.platform; }).sort()).toEqual(['github', 'wechat', 'youtube']);
  });

  it('保护标记清除后，任务重新进入到期名单', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube']);
    store.holdMissedPlanTasks(NOW);

    // 用户处理（延后一天）会清除标记
    const h = makeIpc(store, videoDeps());
    const t = taskOf(store, 'w1', 'youtube');
    const res = h.handlers.get('plan:overdue-delay')({}, 'w1', t.id, { now: NOW });
    expect(res.ok).toBe(true);
    expect(store.isPlanTaskHeld(t.id, t.scheduled_at)).toBe(false);

    // 延后后时间在未来 → 未到期 → 不在名单里
    expect(store.listDuePlanTasks(NOW, { forRealExecutor: true })).toHaveLength(0);
  });

  it('放弃逾期任务后任务变为 cancelled，不再是逾期', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube']);
    store.holdMissedPlanTasks(NOW);

    const h = makeIpc(store, videoDeps());
    const t = taskOf(store, 'w1', 'youtube');
    const res = h.handlers.get('plan:overdue-abandon')({}, 'w1', t.id, { confirmed: true });
    expect(res.ok).toBe(true);
    expect(taskOf(store, 'w1', 'youtube').status).toBe('cancelled');

    const list = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(list.items).toHaveLength(0);
  });

  it('GitHub 逾期任务：调度器记录「逾期计划等待用户处理」的跳过原因', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github']);
    store.holdMissedPlanTasks(NOW);

    const { calls, scheduler } = trackingScheduler(store);
    const out = scheduler.scanOnce(NOW);
    expect(calls).toHaveLength(0);
    expect(out.claimed).toHaveLength(0);
    expect(out.skipped.map(function (s) { return s.reason; }).join('')).toContain('逾期计划等待用户处理');
    expect(taskOf(store, 'w1', 'github').status).toBe('pending');
  });

  it('YouTube 逾期任务同样受保护：真实执行器不被调用，任务保持 pending', () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube']);
    store.holdMissedPlanTasks(NOW);

    // YouTube 已是真实执行候选（real_only=1）→ 走 scheduler 的 hold 分支
    expect(taskOf(store, 'w1', 'youtube').real_only).toBe(1);

    const { calls, scheduler } = trackingScheduler(store);
    const out = scheduler.scanOnce(NOW);
    expect(calls).toHaveLength(0);
    expect(out.claimed).toHaveLength(0);
    expect(out.skipped.map(function (s) { return s.reason; }).join('')).toContain('逾期计划等待用户处理');
    expect(taskOf(store, 'w1', 'youtube').status).toBe('pending');
  });

  it('清除保护标记后，YouTube 逾期任务由真实执行器接手', async () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube']);
    store.holdMissedPlanTasks(NOW);

    const { calls, scheduler } = trackingScheduler(store);
    // 注入调度器：plan:overdue-run 自身会走扫描（不绕过调度器）
    const h = makeIpc(store, Object.assign({ getScheduler: function () { return scheduler; } }, videoDeps()));
    const t = taskOf(store, 'w1', 'youtube');
    // 该通道返回 Promise（内部等待扫描结算）
    const res = await h.handlers.get('plan:overdue-run')({}, 'w1', t.id, { now: NOW, confirmed: true });
    expect(res.ok).toBe(true);

    // 真实 YouTube 执行器被调用（不是模拟执行器）
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('yt:');
    expect(taskOf(store, 'w1', 'youtube').status).toBe('done');
  });
});

/* ==================================================================
   11 · 公众号「立即执行」不需要视频（最小修复）
   ------------------------------------------------------------------
   背景：微信公众号是文章草稿平台，不依赖成品视频。
     修复前，逾期弹窗点「立即执行」时，视频可用性闸门与平台无关：
     只要作品存在失效的成品视频映射，公众号任务也会被判成
     "视频不可用（video-unavailable）"而无法执行。
   本组用例覆盖：
     11-1 公众号 + 无视频映射        → 允许立即执行
     11-2 公众号 + 作品视频映射失效  → 仍允许立即执行
     11-3 公众号 + 存在有效视频映射  → 显示"不需要视频"，不依赖该视频
     11-4 GitHub  + 视频映射失效     → 仍然拒绝立即执行（闸门未变）
     11-5 YouTube+ 视频映射失效      → 仍然拒绝立即执行（闸门未变）
     11-6 三平台其他逾期处理行为保持不变（检测 / hold / 延后 / 放弃）
   ================================================================== */
describe('11 · 公众号立即执行不需要视频', () => {
  it('11-1 微信公众号 + 无视频映射：允许立即执行', async () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['wechat'], {
      copy: { wechat: { title: 'WX 标题', body: 'WX 正文' } }
    });
    const { calls, scheduler } = trackingSchedulerWithWechat(store);
    const h = makeIpc(store, Object.assign({
      getScheduler: function () { return scheduler; }
    }, videoDeps()));
    const t = taskOf(store, 'w1', 'wechat');

    const res = await h.handlers.get('plan:overdue-run')({}, 'w1', t.id, { now: NOW });

    expect(res.ok).toBe(true);
    expect(res.error).not.toBe('video-unavailable');
    expect(res.executed).toBe(true);
    expect(res.status).toBe('done');
    // 走的是真实执行器（微信平台已注册真实通道）
    expect(calls.filter(function (c) { return c.indexOf('wx:') === 0; })).toHaveLength(1);
    expect(taskOf(store, 'w1', 'wechat').status).toBe('done');
  });

  it('11-2 微信公众号 + 作品视频映射失效：仍允许立即执行', async () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['wechat'], {
      copy: { wechat: { title: 'WX 标题', body: 'WX 正文' } }
    });
    const { calls, scheduler } = trackingSchedulerWithWechat(store);
    // 作品最新成品视频映射失效（文件被删 / 路径不在白名单）
    const h = makeIpc(store, Object.assign({
      getScheduler: function () { return scheduler; }
    }, brokenVideoDeps()));
    const t = taskOf(store, 'w1', 'wechat');

    const res = await h.handlers.get('plan:overdue-run')({}, 'w1', t.id, { now: NOW });

    // ★ 修复点：公众号不需要视频，不再被 video-unavailable 拦截
    expect(res.ok).toBe(true);
    expect(res.error).not.toBe('video-unavailable');
    expect(res.executed).toBe(true);
    expect(res.status).toBe('done');
    expect(calls.filter(function (c) { return c.indexOf('wx:') === 0; })).toHaveLength(1);
    expect(taskOf(store, 'w1', 'wechat').status).toBe('done');
  });

  it('11-3 微信公众号 + 存在有效视频映射：显示不需要视频，且不依赖该视频', async () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['wechat'], {
      copy: { wechat: { title: 'WX 标题', body: 'WX 正文' } }
    });
    const { scheduler } = trackingSchedulerWithWechat(store);
    const h = makeIpc(store, Object.assign({
      getScheduler: function () { return scheduler; }
    }, validWorkVideoDeps()));

    // 逾期列表里的视频信息：公众号不展示 / 不依赖作品视频
    const list = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].platform).toBe('wechat');
    expect(list.items[0].video.source).toBe('none');
    expect(list.items[0].video.required).toBe(false);
    expect(list.items[0].video.path).toBe('');
    expect(list.items[0].video.path).not.toBe(VIDEO_OK);

    // 立即执行照常成功（不会因为作品存在视频而被改变行为）
    const t = taskOf(store, 'w1', 'wechat');
    const res = await h.handlers.get('plan:overdue-run')({}, 'w1', t.id, { now: NOW });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('done');
  });

  it('11-4 GitHub + 视频映射失效：仍然拒绝立即执行', async () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github'], {
      copy: { github: { title: 'G', body: 'B', videoPath: VIDEO_OK } }
    });
    const { calls, scheduler } = trackingSchedulerWithWechat(store);
    const h = makeIpc(store, Object.assign({
      getScheduler: function () { return scheduler; }
    }, brokenVideoDeps()));
    const t = taskOf(store, 'w1', 'github');

    const res = await h.handlers.get('plan:overdue-run')({}, 'w1', t.id, { now: NOW });

    // GitHub 确实需要成品视频 → 闸门保持原样：拒绝执行，不降级为纯文章
    expect(res.ok).toBe(false);
    expect(res.error).toBe('video-unavailable');
    expect(calls).toHaveLength(0);
    expect(taskOf(store, 'w1', 'github').status).toBe('pending');
  });

  it('11-5 YouTube + 视频映射失效：仍然拒绝立即执行', async () => {
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['youtube'], {
      copy: { youtube: { title: 'Y', body: 'B', videoPath: VIDEO_OK } }
    });
    const { calls, scheduler } = trackingSchedulerWithWechat(store);
    const h = makeIpc(store, Object.assign({
      getScheduler: function () { return scheduler; }
    }, brokenVideoDeps()));
    const t = taskOf(store, 'w1', 'youtube');

    const res = await h.handlers.get('plan:overdue-run')({}, 'w1', t.id, { now: NOW });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('video-unavailable');
    expect(calls).toHaveLength(0);
    expect(taskOf(store, 'w1', 'youtube').status).toBe('pending');
  });

  it('11-6 三平台的其它逾期处理行为保持不变', () => {
    // (a) 逾期检测：三平台都能检出
    const store = newStore('sqlite');
    seedPlan(store, 'w1', ['github', 'youtube', 'wechat'], {
      copy: {
        github: { title: 'G', body: 'B', videoPath: VIDEO_OK },
        youtube: { title: 'Y', body: 'B', videoPath: VIDEO_OK },
        wechat: { title: 'WX', body: 'B' }
      }
    });
    const h = makeIpc(store, videoDeps());
    const list = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(list.items.map(function (i) { return i.platform; }).sort())
      .toEqual(['github', 'wechat', 'youtube']);

    // (b) 启动保护：三平台都被打上 hold 标记
    const held = store.holdMissedPlanTasks(NOW);
    expect(held.held.map(function (x) { return x.platformId; }).sort())
      .toEqual(['github', 'wechat', 'youtube']);

    // (c) 延后一天：仍走原有逻辑（+24h、任务保持 pending）
    const t = taskOf(store, 'w1', 'wechat');
    const delayed = h.handlers.get('plan:overdue-delay')({}, 'w1', t.id, { now: NOW });
    expect(delayed.ok).toBe(true);
    expect(delayed.scheduledAt).toBe(new Date(new Date(NOW).getTime() + 24 * 60 * 60 * 1000).toISOString());
    expect(taskOf(store, 'w1', 'wechat').status).toBe('pending');

    // (d) 放弃计划：仍走原有逻辑（标记取消 + 按平台解绑视频引用）
    const t2 = taskOf(store, 'w1', 'github');
    const abandoned = h.handlers.get('plan:overdue-abandon')({}, 'w1', t2.id, { confirmed: true });
    expect(abandoned.ok).toBe(true);
    expect(taskOf(store, 'w1', 'github').status).toBe('cancelled');
    // 放弃 github 只解绑 copy.github.videoPath，其它平台的快照不受影响
    const copy = store.listPlanStages('w1')[0].copy;
    expect(copy.github.videoPath).toBeUndefined();
    expect(copy.github.title).toBe('G');
    expect(copy.youtube.videoPath).toBe(VIDEO_OK);
    expect(copy.wechat.title).toBe('WX');
    expect(copy.wechat.videoPath).toBeUndefined();
  });
});
