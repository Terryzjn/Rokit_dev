'use strict';

// Rokit · 第三批：启动逾期计划检查 + 用户处理（仅 GitHub 首秀计划）
//
// 覆盖需求第 10-15 项：
//   10 逾期计划能在启动恢复后被识别
//   11 延后一天按处理时刻增加 24 小时
//   12 取消计划需要二次确认
//   13 发布结果不确定时不会重复自动发布
//   14 多个逾期计划集中展示
//   15 关闭弹窗后计划仍然保留，下一次启动仍可处理
//
// 全部使用临时目录里的独立数据库，不触碰用户生产数据库；不调用任何真实平台 API。

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const NOW = '2026-10-30T04:00:00.000Z';   // 固定「当前时间」，让 +24h 断言可复现
const NEXT_DAY = '2026-10-31T04:00:00.000Z';
const VIDEO_OK = 'C:\\videos\\final\\v1.mp4';

let tmpDir;
let dbPath;

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

function loadPlanIpc() {
  return require(path.join(H.ROOT, 'electron', 'plan-ipc'));
}
function loadScheduler() {
  return require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
}

function makeIpc(store, extraDeps) {
  const handlers = new Map();
  const ipcMain = { handle: function (ch, fn) { handlers.set(ch, fn); } };
  const storeRef = { current: store };
  loadPlanIpc().registerPlanIpc(ipcMain, Object.assign({
    getStore: function () { return storeRef.current; }
  }, extraDeps || {}));
  return { handlers: handlers, storeRef: storeRef };
}

// 造一个 GitHub 首秀计划（默认 real_only=1），并把执行时间改成过去
function seedOverdue(store, workId, opts) {
  opts = opts || {};
  H.seedWork(store, workId, '作品 ' + workId);
  store.savePlanStages(workId, [H.stage('ps_' + workId, {
    platforms: opts.platforms || ['github'],
    copy: opts.copy || {}
  })]);
  const task = store.listPlanTasks(workId)[0];
  store.updatePlanTask(workId, task.id, { scheduled_at: opts.at || H.PAST });
  return store.listPlanTasks(workId)[0];
}

function videoDeps(over) {
  over = over || {};
  return {
    checkFinalVideoPath: function (p) {
      if (typeof over.check === 'function') return over.check(p);
      return { ok: true, filePath: String(p), size: 1024 };
    },
    getWorkFinalVideo: function (wid) {
      if (typeof over.resolve === 'function') return over.resolve(wid);
      return { ok: false, error: 'no-final-video', workId: wid };
    }
  };
}

function realScheduler(store, over) {
  over = over || {};
  const calls = [];
  const { createPlanScheduler } = loadScheduler();
  const scheduler = createPlanScheduler({
    getStore: function () { return store; },
    executorKind: 'real',
    realExecutors: {
      github: function (task) {
        calls.push(String(task.id));
        if (typeof over.executor === 'function') return over.executor(task);
        return {
          ok: true, simulated: false, status: 'done',
          platform_ref: 'gh:' + String(task.id),
          platform_url: 'https://github.com/example/repo',
          note: 'GitHub 已发布'
        };
      }
    }
  });
  return { calls: calls, scheduler: scheduler };
}

/* ==================================================================
   10 · 逾期识别：启动恢复后仍能识别（不再自动重复提醒其它状态）
   ================================================================== */
describe('10 · 启动恢复后识别逾期计划', () => {
  it('到期的 GitHub 真实任务被识别为逾期，并带上 7 项展示字段', () => {
    const store = newStore('sqlite');
    const task = seedOverdue(store, 'w1', { copy: { github: { title: '标题', body: '正文', videoPath: VIDEO_OK } } });
    const h = makeIpc(store, videoDeps());

    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.ok).toBe(true);
    expect(res.items).toHaveLength(1);
    const it = res.items[0];
    expect(it.workId).toBe('w1');
    expect(it.workName).toBe('作品 w1');
    expect(it.platform).toBe('github');
    expect(it.platformLabel).toBe('GitHub');
    expect(it.taskId).toBe(task.id);
    expect(it.scheduledAt).toBe(H.PAST);
    expect(it.now).toBe(NOW);
    expect(it.overdueMs).toBeGreaterThan(0);
    expect(it.status).toBe('pending');
    expect(it.realOnly).toBe(1);
    expect(it.video.source).toBe('snapshot');
    expect(it.video.ok).toBe(true);
  });

  it('未到期 / 已完成 / 已取消 / 结果待核实 / 执行中 都不算逾期', () => {
    const store = newStore('sqlite');

    // 未到期
    H.seedWork(store, 'wFuture', '未来作品');
    store.savePlanStages('wFuture', [H.stage('ps_wFuture', { platforms: ['github'] })]);
    store.updatePlanTask('wFuture', store.listPlanTasks('wFuture')[0].id, { scheduled_at: H.FUTURE });

    // 已完成（真实）
    seedOverdue(store, 'wDone');
    const doneTask = store.listPlanTasks('wDone')[0];
    store.claimPlanTask(doneTask.id, H.PAST);
    store.finishPlanTask(doneTask.id, H.PAST, { ok: true, simulated: false, status: 'done' });

    // 已取消
    seedOverdue(store, 'wCancel');
    store.cancelPlanTask('wCancel', store.listPlanTasks('wCancel')[0].id);

    // 结果待核实（真实执行结果不确定 → real_only 被清除）
    seedOverdue(store, 'wReview');
    const rv = store.listPlanTasks('wReview')[0];
    store.claimPlanTask(rv.id, H.PAST);
    store.finishPlanTask(rv.id, H.PAST, { ok: true, simulated: false, status: 'needs_review', note: '结果未知' });

    // 执行中
    seedOverdue(store, 'wRun');
    const runTask = store.listPlanTasks('wRun')[0];
    store.claimPlanTask(runTask.id, H.PAST);

    const h = makeIpc(store, videoDeps());
    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items).toHaveLength(0);
    expect(store.listPlanTasks('wReview')[0].status).toBe('needs_review');
    expect(store.listPlanTasks('wRun')[0].status).toBe('running');
  });

  it('plan:overdue 先执行计划恢复 + 任务对账（recover 幂等）', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1', { copy: { github: { title: 't', body: 'b', videoPath: VIDEO_OK } } });
    const { scheduler } = realScheduler(store);
    let recovered = 0;
    const orig = scheduler.recover;
    scheduler.recover = function () { recovered++; return orig.apply(null, arguments); };
    const h = makeIpc(store, Object.assign(videoDeps(), { getScheduler: function () { return scheduler; } }));
    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(recovered).toBe(1);
    expect(res.items).toHaveLength(1);
  });

  it('关闭期间到期的真实任务在启动时被暂停，调度器不会抢先自动执行', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1');
    const { calls, scheduler } = realScheduler(store);

    const held = store.holdMissedPlanTasks(NOW);
    expect(held.held).toHaveLength(1);
    const t = store.listPlanTasks('w1')[0];
    expect(store.isPlanTaskHeld(t.id, t.scheduled_at)).toBe(true);

    const out = scheduler.scanOnce(NOW);
    expect(calls).toHaveLength(0);
    expect(out.claimed).toHaveLength(0);
    expect(out.skipped.map(function (s) { return s.reason; }).join('')).toContain('逾期计划等待用户处理');
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });
});

/* ==================================================================
   11 · 延后一天：以用户处理时刻为基准 +24h，内容全部保留
   ================================================================== */
describe('11 · 延后一天按处理时刻 +24 小时', () => {
  it('10-30 12:00 处理 → 10-31 12:00（UTC ISO 精确 +24h）', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1', {
      copy: { github: { title: '标题', body: '正文', tags: ['x'], videoPath: VIDEO_OK } }
    });
    const h = makeIpc(store, videoDeps());
    const task = store.listPlanTasks('w1')[0];

    const res = h.handlers.get('plan:overdue-delay')({}, 'w1', task.id, { now: NOW });
    expect(res.ok).toBe(true);
    expect(res.scheduledAt).toBe(NEXT_DAY);
    expect(res.stage_updated).toBe(true);
    expect(res.video_kept).toBe(true);
    expect(res.content_kept).toBe(true);

    const after = store.listPlanTasks('w1')[0];
    expect(after.scheduled_at).toBe(NEXT_DAY);
    expect(after.status).toBe('pending');
    expect(after.real_only).toBe(1);

    // 视频 / 标题 / 正文全部保留
    const stage = store.listPlanStages('w1')[0];
    expect(stage.copy.github.videoPath).toBe(VIDEO_OK);
    expect(stage.copy.github.title).toBe('标题');
    expect(stage.copy.github.body).toBe('正文');
    expect(stage.scheduled_at).toBe(NEXT_DAY);

    // 同一个「当前时间」下不再被判定为逾期
    const again = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(again.items).toHaveLength(0);
  });

  it('JSON 兜底路径行为一致', () => {
    const store = newStore('json');
    seedOverdue(store, 'w1', { copy: { github: { title: '标题', body: '正文', videoPath: VIDEO_OK } } });
    const h = makeIpc(store, videoDeps());
    const task = store.listPlanTasks('w1')[0];
    const res = h.handlers.get('plan:overdue-delay')({}, 'w1', task.id, { now: NOW });
    expect(res.ok).toBe(true);
    expect(res.scheduledAt).toBe(NEXT_DAY);
    expect(store.listPlanTasks('w1')[0].scheduled_at).toBe(NEXT_DAY);
    expect(store.listPlanStages('w1')[0].copy.github.videoPath).toBe(VIDEO_OK);
  });
});

/* ==================================================================
   12 · 放弃计划：必须二次确认；取消 + 解除视频引用；不删视频
   ================================================================== */
describe('12 · 放弃计划需要二次确认', () => {
  it('未确认时拒绝，任务保持待执行、视频引用保持不变', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1', { copy: { github: { title: '标题', body: '正文', videoPath: VIDEO_OK } } });
    const h = makeIpc(store, videoDeps());
    const task = store.listPlanTasks('w1')[0];

    const res = h.handlers.get('plan:overdue-abandon')({}, 'w1', task.id, {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('confirmation-required');

    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
    expect(store.listPlanStages('w1')[0].copy.github.videoPath).toBe(VIDEO_OK);
  });

  it('确认后标记取消并解除视频引用，但保留标题 / 正文与视频映射', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1', { copy: { github: { title: '标题', body: '正文', tags: ['x'], videoPath: VIDEO_OK } } });
    store.upsertSettingKv('finalVideo:w1', VIDEO_OK);
    const h = makeIpc(store, videoDeps());
    const task = store.listPlanTasks('w1')[0];

    const res = h.handlers.get('plan:overdue-abandon')({}, 'w1', task.id, { confirmed: true });
    expect(res.ok).toBe(true);
    expect(res.canceled).toBe(true);
    expect(res.detach.changed).toBe(true);
    expect(res.video_deleted).toBe(false);
    expect(res.video_kept).toBe(true);

    expect(store.listPlanTasks('w1')[0].status).toBe('cancelled');
    const stage = store.listPlanStages('w1')[0];
    expect(stage.copy.github.videoPath).toBeUndefined();
    expect(stage.copy.github.title).toBe('标题');
    expect(stage.copy.github.body).toBe('正文');
    expect(stage.copy.github.tags).toEqual(['x']);

    // 作品最新视频映射仍在（不删除视频，清理资格另行判断）
    expect(store.getSettingKv('finalVideo:w1')).toBe(VIDEO_OK);
  });

  it('取消后不再出现在逾期列表', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1');
    const h = makeIpc(store, videoDeps());
    const task = store.listPlanTasks('w1')[0];
    h.handlers.get('plan:overdue-abandon')({}, 'w1', task.id, { confirmed: true });
    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items).toHaveLength(0);
  });
});

/* ==================================================================
   13 · 发布结果不确定（running / needs_review）不会重复自动发布
   ================================================================== */
describe('13 · 结果不确定时不重复自动发布', () => {
  it('needs_review 任务不进入逾期列表，也不可能被「立即执行」重发', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1');
    const task = store.listPlanTasks('w1')[0];
    store.claimPlanTask(task.id, H.PAST);
    store.finishPlanTask(task.id, H.PAST, { ok: true, simulated: false, status: 'needs_review', note: '结果未知' });

    const { calls, scheduler } = realScheduler(store);
    const h = makeIpc(store, Object.assign(videoDeps(), { getScheduler: function () { return scheduler; } }));

    const list = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(list.items).toHaveLength(0);

    const run = h.handlers.get('plan:overdue-run')({}, 'w1', task.id, { now: NOW });
    expect(run.ok).toBe(false);
    expect(run.error).toBe('task-not-pending');
    expect(calls).toHaveLength(0);

    // 常规扫描也不会重发
    const out = scheduler.scanOnce(NOW);
    expect(calls).toHaveLength(0);
    expect(out.claimed).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('needs_review');
  });
});

/* ==================================================================
   14 · 多个逾期计划集中展示（一次返回，页面只开一个窗口）
   ================================================================== */
describe('14 · 多个逾期计划集中展示', () => {
  it('一次 plan:overdue 返回全部逾期计划，按原执行时间升序', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1', { at: '2020-01-01T00:00:00.000Z' });
    seedOverdue(store, 'w2', { at: '2020-02-01T00:00:00.000Z' });
    seedOverdue(store, 'w3', { at: '2020-03-01T00:00:00.000Z' });

    const h = makeIpc(store, videoDeps());
    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items).toHaveLength(3);
    expect(res.items.map(function (i) { return i.workId; })).toEqual(['w1', 'w2', 'w3']);
  });

  it('渲染层只构造一个逾期窗口，并在一个列表里渲染全部条目', () => {
    const html = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8');
    expect(html).toContain("var mid='__overdueModal'");
    expect(html).toContain('function openOverdueModal(items)');
    expect(html).toContain("'<div id=\"__odList\">'+items.map(_odRowHtml).join('')+'</div>'");
    expect(html).toContain('function checkOverduePlans()');
    expect(html).toContain('if(state.__overdueShown)return;');
    // 启动链末尾挂载（不阻塞其它功能）
    expect(html).toContain('checkOverduePlans();');
    // 三个操作按钮齐全
    expect(html).toContain('data-act="run">立即执行');
    expect(html).toContain('data-act="delay">延后一天');
    expect(html).toContain('data-act="abandon">放弃计划');
    // 放弃走 confirmModal 二次确认
    expect(html).toContain("title:'放弃逾期计划'");
    expect(html).toContain('{confirmed:true}');
  });

  it('preload 暴露了四个逾期通道，plan-ipc 注册了对应 IPC', () => {
    const preload = fs.readFileSync(path.join(H.ROOT, 'electron', 'preload.js'), 'utf8');
    expect(preload).toContain('planOverdue:');
    expect(preload).toContain("ipcRenderer.invoke('plan:overdue'");
    expect(preload).toContain('planOverdueRun:');
    expect(preload).toContain("ipcRenderer.invoke('plan:overdue-run'");
    expect(preload).toContain('planOverdueDelay:');
    expect(preload).toContain("ipcRenderer.invoke('plan:overdue-delay'");
    expect(preload).toContain('planOverdueAbandon:');
    expect(preload).toContain("ipcRenderer.invoke('plan:overdue-abandon'");

    const store = newStore('sqlite');
    const h = makeIpc(store, videoDeps());
    ['plan:overdue', 'plan:overdue-run', 'plan:overdue-delay', 'plan:overdue-abandon'].forEach(function (ch) {
      expect(h.handlers.has(ch)).toBe(true);
    });
  });
});

/* ==================================================================
   15 · 关闭弹窗后计划仍然保留，下一次启动仍可处理
   ================================================================== */
describe('15 · 暂不处理：计划与视频保留，下次启动仍可处理', () => {
  it('只读取逾期列表（不操作）后，任务、视频映射与暂停标记都保留', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1', { copy: { github: { title: '标题', body: '正文', videoPath: VIDEO_OK } } });
    store.upsertSettingKv('finalVideo:w1', VIDEO_OK);
    store.holdMissedPlanTasks(NOW);
    const h = makeIpc(store, videoDeps());

    h.handlers.get('plan:overdue')({}, { now: NOW });
    const t = store.listPlanTasks('w1')[0];
    expect(t.status).toBe('pending');
    expect(t.scheduled_at).toBe(H.PAST);
    expect(store.listPlanStages('w1')[0].copy.github.videoPath).toBe(VIDEO_OK);
    expect(store.getSettingKv('finalVideo:w1')).toBe(VIDEO_OK);
    expect(store.isPlanTaskHeld(t.id, t.scheduled_at)).toBe(true);
  });

  it('重开数据库（下次启动）后仍能识别并处理同一个逾期计划', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1', { copy: { github: { title: '标题', body: '正文', videoPath: VIDEO_OK } } });
    store.holdMissedPlanTasks(NOW);

    const reopened = newStore('sqlite');
    const h = makeIpc(reopened, videoDeps());
    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].taskId).toBe(reopened.listPlanTasks('w1')[0].id);

    const t = reopened.listPlanTasks('w1')[0];
    expect(reopened.isPlanTaskHeld(t.id, t.scheduled_at)).toBe(true);
    expect(reopened.listPlanStages('w1')[0].copy.github.videoPath).toBe(VIDEO_OK);
  });
});

/* ==================================================================
   A · 立即执行：复用调度器（领取 / 闸门 / 落库），不绕过安全检查
   ================================================================== */
describe('A · 立即执行复用现有调度器', () => {
  it('点击立即执行 → 解除暂停 → 调度器领取并执行 → 任务完成', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1', { copy: { github: { title: '标题', body: '正文', videoPath: VIDEO_OK } } });
    store.holdMissedPlanTasks(NOW);
    const { calls, scheduler } = realScheduler(store);
    const h = makeIpc(store, Object.assign(videoDeps(), { getScheduler: function () { return scheduler; } }));
    const task = store.listPlanTasks('w1')[0];

    return Promise.resolve(h.handlers.get('plan:overdue-run')({}, 'w1', task.id, { now: NOW })).then(function (res) {
      expect(res.ok).toBe(true);
      expect(res.executed).toBe(true);
      expect(res.status).toBe('done');
      expect(res.video.source).toBe('snapshot');
      expect(calls).toEqual([task.id]);
      expect(store.listPlanTasks('w1')[0].status).toBe('done');
      expect(store.isPlanTaskHeld(task.id, H.PAST)).toBe(false);
      // 走完调度器后不再出现在逾期列表
      const list = h.handlers.get('plan:overdue')({}, { now: NOW });
      expect(list.items).toHaveLength(0);
    });
  });

  it('计划快照视频不可用 → 拒绝立即执行，不降级为纯文章', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1', { copy: { github: { title: '标题', body: '正文', videoPath: 'C:\\videos\\missing.mp4' } } });
    const { calls, scheduler } = realScheduler(store);
    const h = makeIpc(store, Object.assign(
      videoDeps({ check: function () { return { ok: false, error: 'file-missing', detail: '文件不存在' }; } }),
      { getScheduler: function () { return scheduler; } }
    ));
    const task = store.listPlanTasks('w1')[0];

    const res = h.handlers.get('plan:overdue-run')({}, 'w1', task.id, { now: NOW });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('video-unavailable');
    expect(calls).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });

  it('无快照但作品映射可用 → 视频来源标记为 work-latest', () => {
    const store = newStore('sqlite');
    seedOverdue(store, 'w1');
    const h = makeIpc(store, videoDeps({ resolve: function () { return { ok: true, workId: 'w1', path: VIDEO_OK, size: 1024 }; } }));
    const res = h.handlers.get('plan:overdue')({}, { now: NOW });
    expect(res.items[0].video.source).toBe('work-latest');
    expect(res.items[0].video.ok).toBe(true);
  });
});
