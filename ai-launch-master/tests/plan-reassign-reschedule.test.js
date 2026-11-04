'use strict';

// Rokit · 任务 D：草稿计划归属转正时重新计算计划执行时间（定向测试）
//
// 覆盖用户确认的业务规则与全部安全要求：
//   R1  草稿 owner 转正为真实作品 ID 后，尚未执行任务的执行时间按真实作品的 created_at 重算
//   R2  原有的「天数偏移」与「指定时刻」被完整保留（不被改成从转正时间重新计时）
//   R3  时区换算规则与保存计划时完全一致（本地日历日 + N 天 + 本地 HH:mm → UTC ISO）
//   R4  已执行 / 已失败 / 已取消 / 执行中 / 待人工核实的任务：时间与状态一律不变
//   R5  无法可靠还原原始时间设置时：保留原值 + 记录明确原因（不猜测、不覆盖）
//   R6  不因转正重算而触发重复发布：幂等闸门、失败终止、人工核实规则原样保留
//   R7  SQLite 与 JSON 两种存储模式行为一致；重启后仍然是重算后的时间
//   R8  renderer → preload → IPC → store 全链路真的打通
//   R9  全程不执行任何真实平台发布、不修改生产数据库、不开启真实发送开关
//
// 跑的是生产代码：electron/store.js（reassignPlanOwner 及其时间重算）
//
// 所有测试都用临时目录里的独立数据库，不触碰用户真实作品与发布记录。

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const STORE_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'store.js'), 'utf8').replace(/\r\n/g, '\n');
const PRELOAD_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'preload.js'), 'utf8').replace(/\r\n/g, '\n');
const PLAN_IPC_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'plan-ipc.js'), 'utf8').replace(/\r\n/g, '\n');
const INDEX_SRC = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

let tmpDir;
let dbPath;
let restoreBlock = null;

/* ---------- 从源码里按花括号配平切出一个函数（用于行为级验证） ---------- */
function extractBlock(src, header) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error('源码中找不到：' + header);
  const open = src.indexOf('{', start + header.length - 1);
  if (open < 0) throw new Error('缺少花括号：' + header);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('花括号不配平：' + header);
}

beforeEach(() => {
  tmpDir = H.makeTmpDir();
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  if (restoreBlock) { restoreBlock(); restoreBlock = null; }
  H.rmTmpDir(tmpDir);
  const id = require.resolve(path.join(H.ROOT, 'electron', 'store'));
  delete require.cache[id];
});

// 载入 store（按模式屏蔽驱动）
function loadStore(mode) {
  if (restoreBlock) { restoreBlock(); restoreBlock = null; }
  const id = require.resolve(path.join(H.ROOT, 'electron', 'store'));
  delete require.cache[id];
  restoreBlock = H.installDriverBlock(mode === 'json');
  return require(path.join(H.ROOT, 'electron', 'store'));
}
function newStore(mode) {
  const { Store } = loadStore(mode || 'sqlite');
  return new Store(dbPath);
}

// 草稿归属（works 表里查不到这一行）
const DRAFT = 'draft_abc123';

// 一个确定的作品创建时间（固定值，便于断言本地日历日的换算）
const WORK_CREATED = '2026-03-10T02:00:00.000Z';

/**
 * 独立实现「本地日历日 + N 天 + 本地 HH:mm → UTC ISO」，
 * 不调用生产代码，用来验证 store 的重算结果与这条规则一致。
 */
function expectedLocal(baseIso, offsetDays, timeOfDay) {
  const d = new Date(baseIso);
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay);
  const hh = m ? parseInt(m[1], 10) : 20;
  const mm = m ? parseInt(m[2], 10) : 0;
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays, hh, mm, 0, 0);
  return t.toISOString();
}

// 建一个真实作品 + 一个草稿归属下的计划，返回任务数组
//   本文件只看「时间重算 / 归属迁移」：把新任务降级为模拟候选（等价旧 auto_publish=0），
//   避免任务因 real_only=1 而影响后续模拟口径的断言。
function setupDraftPlan(store, opts) {
  opts = opts || {};
  const workId = opts.workId || 'w1';
  const createdAt = opts.createdAt || WORK_CREATED;
  H.seedWork(store, workId, '作品 ' + workId, createdAt);
  store.savePlanStages(DRAFT, [
    H.stage(opts.stageId || 'ps_1', {
      offsetDays: opts.offsetDays === undefined ? 2 : opts.offsetDays,
      timeOfDay: opts.timeOfDay || '10:30',
      platforms: opts.platforms || ['github']
    })
  ]);
  return H.demoteToSimulated(store, DRAFT);
}

function taskOf(store, owner, platformId) {
  return store.listPlanTasks(owner).filter(function (t) { return t.platform_id === platformId; })[0];
}

/* ==================================================================
   R1 · 草稿转正 → 按真实作品的 created_at 重算执行时间
   ================================================================== */
describe('R1 · 草稿归属转正后按真实作品 created_at 重算执行时间', () => {
  it('pending 任务的执行时间变成「真实作品创建日 + 偏移天数 + 指定时刻」', () => {
    const store = newStore();
    const before = setupDraftPlan(store, { offsetDays: 2, timeOfDay: '10:30' });
    expect(before).toHaveLength(1);
    // 草稿归属下保存时用的是「保存时刻」当基准 —— 与真实作品创建日无关
    expect(before[0].scheduled_at).not.toBe(expectedLocal(WORK_CREATED, 2, '10:30'));

    const res = store.reassignPlanOwner(DRAFT, 'w1');
    expect(res.ok).toBe(true);
    expect(res.rescheduled).toHaveLength(1);

    const after = taskOf(store, 'w1', 'github');
    expect(after.work_id).toBe('w1');
    expect(after.scheduled_at).toBe(expectedLocal(WORK_CREATED, 2, '10:30'));
  });

  it('重算不是「从转正时刻重新计时」：结果与转正时刻无关', () => {
    const store = newStore();
    setupDraftPlan(store, { offsetDays: 0, timeOfDay: '09:00' });

    // 转正前的旧值（基于保存时刻）
    const oldValue = store.listPlanTasks(DRAFT)[0].scheduled_at;

    store.reassignPlanOwner(DRAFT, 'w1');
    const after = taskOf(store, 'w1', 'github');

    // 新值必须等于「作品创建日 + 0 天 + 09:00」，而不是「现在 + 0 天 + 09:00」
    expect(after.scheduled_at).toBe(expectedLocal(WORK_CREATED, 0, '09:00'));
    expect(after.scheduled_at).not.toBe(oldValue);
    // 明确断言：不是以转正时刻（现在）为基准
    const nowLocal = new Date();
    const nowBased = new Date(
      nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate(), 9, 0, 0, 0
    ).toISOString();
    expect(after.scheduled_at).not.toBe(nowBased);
  });

  it('多阶段多平台：每条 pending 任务按各自阶段的时间设置重算', () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品 w1', WORK_CREATED);
    store.savePlanStages(DRAFT, [
      H.stage('ps_a', { offsetDays: 0, timeOfDay: '08:00', platforms: ['github', 'wechat'] }),
      H.stage('ps_b', { offsetDays: 5, timeOfDay: '21:15', platforms: ['youtube'] })
    ]);

    const res = store.reassignPlanOwner(DRAFT, 'w1');
    expect(res.rescheduled).toHaveLength(3);

    expect(taskOf(store, 'w1', 'github').scheduled_at).toBe(expectedLocal(WORK_CREATED, 0, '08:00'));
    expect(taskOf(store, 'w1', 'wechat').scheduled_at).toBe(expectedLocal(WORK_CREATED, 0, '08:00'));
    expect(taskOf(store, 'w1', 'youtube').scheduled_at).toBe(expectedLocal(WORK_CREATED, 5, '21:15'));
  });

  it('重算后旧草稿归属下不再有任务，阶段与任务都挂到新作品上', () => {
    const store = newStore();
    setupDraftPlan(store);
    store.reassignPlanOwner(DRAFT, 'w1');

    expect(store.listPlanTasks(DRAFT)).toHaveLength(0);
    expect(store.listPlanStages(DRAFT)).toHaveLength(0);
    expect(store.listPlanStages('w1')).toHaveLength(1);
    expect(store.listPlanTasks('w1')).toHaveLength(1);
  });
});

/* ==================================================================
   R2 · 原始天数偏移与指定时刻被完整保留
   ================================================================== */
describe('R2 · 原有天数偏移与指定时刻被完整保留', () => {
  it('不同 offsetDays / timeOfDay 组合都被原样保留', () => {
    const cases = [
      { off: 0, tod: '00:00' },
      { off: 1, tod: '07:05' },
      { off: 3, tod: '12:00' },
      { off: 30, tod: '23:59' },
      { off: 365, tod: '06:30' }
    ];
    cases.forEach(function (c, i) {
      const store = newStore();
      const workId = 'w_' + i;
      H.seedWork(store, workId, '作品', WORK_CREATED);
      store.savePlanStages(DRAFT, [
        H.stage('ps_' + i, { offsetDays: c.off, timeOfDay: c.tod, platforms: ['github'] })
      ]);
      store.reassignPlanOwner(DRAFT, workId);
      expect(taskOf(store, workId, 'github').scheduled_at).toBe(expectedLocal(WORK_CREATED, c.off, c.tod));
    });
  });

  it('阶段配置里的 offset_days / time_of_day 本身不被改写', () => {
    const store = newStore();
    setupDraftPlan(store, { offsetDays: 4, timeOfDay: '11:11' });
    store.reassignPlanOwner(DRAFT, 'w1');

    const stage = store.listPlanStages('w1')[0];
    expect(stage.offset_days).toBe(4);
    expect(stage.time_of_day).toBe('11:11');
  });

  it('任务上的其它配置（平台、阶段、幂等键）不被重算过程改动', () => {
    const store = newStore();
    const before = setupDraftPlan(store, { platforms: ['github', 'wechat'] });
    store.reassignPlanOwner(DRAFT, 'w1');

    const after = store.listPlanTasks('w1');
    expect(after).toHaveLength(2);
    after.forEach(function (t, i) {
      expect(t.platform_id).toBe(before[i].platform_id);
      expect(t.stage_id).toBe(before[i].stage_id);
      expect(t.pub_key).toBe(before[i].pub_key);
      expect(t.stage_seq).toBe(before[i].stage_seq);
      expect(t.stage_title).toBe(before[i].stage_title);
    });
  });
});

/* ==================================================================
   R3 · 时区换算规则与保存计划时完全一致
   ================================================================== */
describe('R3 · 时区换算规则与保存计划时一致', () => {
  it('重算结果与「直接以真实作品保存同一份计划」的结果一致', () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品 w1', WORK_CREATED);
    // 参照组：直接保存到真实作品名下（走 savePlanStages 这条既有路径）
    store.savePlanStages('w1', [
      H.stage('ps_ref', { offsetDays: 3, timeOfDay: '14:45', platforms: ['github'] })
    ]);
    const reference = taskOf(store, 'w1', 'github').scheduled_at;

    // 实验组：先存到草稿归属，转正后重算
    store.savePlanStages(DRAFT, [
      H.stage('ps_test', { offsetDays: 3, timeOfDay: '14:45', platforms: ['github'] })
    ]);
    store.reassignPlanOwner(DRAFT, 'w1');

    expect(taskOf(store, 'w1', 'github').scheduled_at).toBe(reference);
  });

  it('换算基准是「本地日历日」而不是 UTC 日', () => {
    const store = newStore();
    // 创建时刻落在 UTC 日的末尾：本地日历日与 UTC 日不同
    const created = '2026-03-10T22:30:00.000Z';
    H.seedWork(store, 'w1', '作品 w1', created);
    store.savePlanStages(DRAFT, [
      H.stage('ps_1', { offsetDays: 0, timeOfDay: '00:30', platforms: ['github'] })
    ]);
    store.reassignPlanOwner(DRAFT, 'w1');

    const after = taskOf(store, 'w1', 'github');
    const local = new Date(after.scheduled_at);
    const base = new Date(created);
    expect(local.getFullYear()).toBe(base.getFullYear());
    expect(local.getMonth()).toBe(base.getMonth());
    expect(local.getDate()).toBe(base.getDate());
    expect(local.getHours()).toBe(0);
    expect(local.getMinutes()).toBe(30);
  });
});

/* ==================================================================
   R4 · 已执行 / 执行中 / 待核实的任务一律不变
   ================================================================== */
describe('R4 · 非 pending 任务的时间与状态都不被改动', () => {
  const CASES = [
    { status: 'done', label: '已完成' },
    { status: 'failed', label: '已失败' },
    { status: 'draft_pending', label: '草稿待发布' },
    { status: 'cancelled', label: '已取消' },
    { status: 'running', label: '执行中' },
    { status: 'needs_review', label: '待人工核实' }
  ];

  CASES.forEach(function (c) {
    it(c.label + '的任务：时间、状态与结果都不被转正重算改动', () => {
      const store = newStore();
      const before = setupDraftPlan(store, { offsetDays: 2, timeOfDay: '10:30' });
      const originalTime = before[0].scheduled_at;

      // 把任务改成指定状态，并写入可核验的历史信息
      store._planWriteTask(Object.assign({}, before[0], {
        status: c.status,
        platform_ref: 'ref-' + c.status,
        platform_url: 'https://example.com/' + c.status,
        error: c.status === 'failed' ? '模拟失败' : '',
        started_at: '2026-01-01T00:00:00.000Z',
        finished_at: '2026-01-01T00:00:05.000Z'
      }));

      const res = store.reassignPlanOwner(DRAFT, 'w1');
      expect(res.ok).toBe(true);
      expect(res.rescheduled).toHaveLength(0);

      const after = taskOf(store, 'w1', 'github');
      expect(after.status).toBe(c.status);
      expect(after.scheduled_at).toBe(originalTime);       // 时间没被重算
      expect(after.platform_ref).toBe('ref-' + c.status);  // 历史标识没被抹掉
      expect(after.platform_url).toBe('https://example.com/' + c.status);
      expect(after.started_at).toBe('2026-01-01T00:00:00.000Z');
      expect(after.finished_at).toBe('2026-01-01T00:00:05.000Z');
      if (c.status === 'failed') expect(after.error).toContain('模拟失败');
    });
  });

  it('同一次转正里：pending 被重算，同批的 needs_review 不动', () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品 w1', WORK_CREATED);
    store.savePlanStages(DRAFT, [
      H.stage('ps_a', { offsetDays: 1, timeOfDay: '09:00', platforms: ['github'] }),
      H.stage('ps_b', { offsetDays: 1, timeOfDay: '09:00', platforms: ['wechat'] })
    ]);
    const before = store.listPlanTasks(DRAFT);
    const reviewTask = before.filter(t => t.platform_id === 'wechat')[0];
    const reviewTime = reviewTask.scheduled_at;
    store._planWriteTask(Object.assign({}, reviewTask, { status: 'needs_review' }));

    store.reassignPlanOwner(DRAFT, 'w1');

    const gh = taskOf(store, 'w1', 'github');
    const wc = taskOf(store, 'w1', 'wechat');
    expect(gh.scheduled_at).toBe(expectedLocal(WORK_CREATED, 1, '09:00'));
    expect(wc.status).toBe('needs_review');
    expect(wc.scheduled_at).toBe(reviewTime);
  });
});

/* ==================================================================
   R5 · 无法可靠还原原始时间设置时的安全处理
   ================================================================== */
describe('R5 · 无法还原原始时间设置时保留原值并记录原因', () => {
  it('目标归属不是真实作品（没有 created_at）→ 保留原值 + 记录原因', () => {
    const store = newStore();
    const before = setupDraftPlan(store);
    const originalTime = before[0].scheduled_at;

    // 转正到一个并不存在的作品 ID：没有可靠的时间基准
    const res = store.reassignPlanOwner(DRAFT, 'w_not_exists');
    expect(res.ok).toBe(true);
    expect(res.rescheduled).toHaveLength(0);
    expect(res.reschedule_kept.length).toBeGreaterThan(0);
    expect(res.reschedule_kept[0].reason).toBeTruthy();

    const after = taskOf(store, 'w_not_exists', 'github');
    expect(after.scheduled_at).toBe(originalTime);   // 原值被保留
    expect(after.status).toBe('pending');            // 状态没变
    expect(after.note).toContain('未重算执行时间');  // 原因被记录下来
  });

  it('阶段配置缺失 → 保留原值 + 记录原因', () => {
    const store = newStore();
    const before = setupDraftPlan(store);
    const originalTime = before[0].scheduled_at;

    // 删掉阶段配置行（模拟数据损坏 / 阶段被外部删除）
    store.run('DELETE FROM plan_stages WHERE id = ?', ['ps_1']);

    const res = store.reassignPlanOwner(DRAFT, 'w1');
    expect(res.rescheduled).toHaveLength(0);
    expect(res.reschedule_kept[0].reason).toContain('阶段配置');

    const after = taskOf(store, 'w1', 'github');
    expect(after.scheduled_at).toBe(originalTime);
    expect(after.note).toContain('未重算执行时间');
  });

  it('阶段的 time_of_day 被改成非法值 → 保留原值 + 记录原因（不猜时刻）', () => {
    const store = newStore();
    const before = setupDraftPlan(store);
    const originalTime = before[0].scheduled_at;

    // 直接写坏时刻：绝不能猜成 20:00 或任何默认值
    store.run('UPDATE plan_stages SET time_of_day = ? WHERE id = ?', ['99:99', 'ps_1']);

    const res = store.reassignPlanOwner(DRAFT, 'w1');
    expect(res.rescheduled).toHaveLength(0);
    expect(res.reschedule_kept[0].reason).toContain('指定时刻');

    const after = taskOf(store, 'w1', 'github');
    expect(after.scheduled_at).toBe(originalTime);
    expect(after.note).toContain('未重算执行时间');
  });

  it('阶段的 offset_days 被改成非法值 → 保留原值 + 记录原因（不猜天数）', () => {
    const store = newStore();
    const before = setupDraftPlan(store);
    const originalTime = before[0].scheduled_at;

    store.run('UPDATE plan_stages SET offset_days = ? WHERE id = ?', [-5, 'ps_1']);

    const res = store.reassignPlanOwner(DRAFT, 'w1');
    expect(res.rescheduled).toHaveLength(0);
    expect(res.reschedule_kept[0].reason).toContain('天数偏移');

    const after = taskOf(store, 'w1', 'github');
    expect(after.scheduled_at).toBe(originalTime);
    expect(after.note).toContain('未重算执行时间');
  });

  it('真实作品之间改挂（不是草稿转正）→ 不重算，不动时间', () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品 w1', WORK_CREATED);
    H.seedWork(store, 'w2', '作品 w2', '2026-06-01T00:00:00.000Z');
    store.savePlanStages('w1', [
      H.stage('ps_1', { offsetDays: 2, timeOfDay: '10:30', platforms: ['github'] })
    ]);
    const originalTime = taskOf(store, 'w1', 'github').scheduled_at;

    const res = store.reassignPlanOwner('w1', 'w2');
    expect(res.ok).toBe(true);
    expect(res.rescheduled).toHaveLength(0);
    expect(res.reschedule_kept).toHaveLength(0);

    expect(taskOf(store, 'w2', 'github').scheduled_at).toBe(originalTime);
  });
});

/* ==================================================================
   R6 · 不因转正重算而触发重复发布；既有安全规则原样保留
   ================================================================== */
describe('R6 · 转正重算不触发重复发布，既有安全规则保留', () => {
  it('转正重算只改时间，不改状态、不新增发布记录', () => {
    const store = newStore();
    setupDraftPlan(store);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github',
      status: 'ok', pub_key: 'plan|' + DRAFT + '|ps_1|github', url: 'https://example.com/r'
    });

    const res = store.reassignPlanOwner(DRAFT, 'w1');

    // 状态没变（仍是待执行，没有被「顺手执行」）
    expect(taskOf(store, 'w1', 'github').status).toBe('pending');
    // 发布记录没有被新增或删除
    expect(store.listPubs()).toHaveLength(1);
    expect(store.listPubs()[0].url).toBe('https://example.com/r');
  });

  it('已有确认发布记录时幂等闸门仍然拒绝再次发布', () => {
    const store = newStore();
    setupDraftPlan(store);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github',
      status: 'ok', pub_key: 'plan|' + DRAFT + '|ps_1|github', url: 'https://example.com/r'
    });
    store.reassignPlanOwner(DRAFT, 'w1');

    const guard = store.checkPlanPublishGuard('w1', 'pt_ps_1_github');
    expect(guard.decision).toBe('skip');
    expect(guard.reason).toContain('不得再次发布');
  });

  it('已确认失败的任务在转正后仍是终止状态，不会被重算复活', () => {
    const store = newStore();
    const before = setupDraftPlan(store);
    store._planWriteTask(Object.assign({}, before[0], { status: 'failed', error: '明确失败' }));

    store.reassignPlanOwner(DRAFT, 'w1');

    const after = taskOf(store, 'w1', 'github');
    expect(after.status).toBe('failed');
    const guard = store.checkPlanPublishGuard('w1', after.id);
    expect(guard.decision).toBe('unclear');
    expect(guard.reason).toContain('不会自动重试');
  });

  it('转正后不会凭空出现任何真实平台调用（只用 mock 执行器验证）', async () => {
    const store = newStore();
    setupDraftPlan(store);
    const calls = [];
    store.reassignPlanOwner(DRAFT, 'w1');

    // 用一个会记录调用的 mock 执行器跑一次到期扫描
    const { createPlanScheduler } = require('../electron/plan-scheduler');
    const sched = createPlanScheduler({
      getStore: function () { return store; },
      realExecutors: { github: async function (t) { calls.push(t); return { ok: true }; } },
      executorKind: function () { return 'mock'; }
    });
    const task = taskOf(store, 'w1', 'github');
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    await sched.scanOnce(new Date().toISOString());

    expect(calls).toHaveLength(0);   // 真实执行器一次都没被调用
  });

  it('真实发送开关保持关闭（本次改动不触碰该设置）', () => {
    const store = newStore();
    setupDraftPlan(store);
    store.reassignPlanOwner(DRAFT, 'w1');
    expect(String(store.getSettingKv('plan_real_publish') || '')).not.toBe('1');
  });
});

/* ==================================================================
   R7 · SQLite / JSON 一致 + 重启后仍是重算后的时间
   ================================================================== */
describe('R7 · 两种存储模式一致，重启后仍然有效', () => {
  it('JSON 兜底模式得到与 SQLite 相同的结果', () => {
    const store = newStore('json');
    setupDraftPlan(store, { offsetDays: 2, timeOfDay: '10:30' });
    store.reassignPlanOwner(DRAFT, 'w1');
    expect(taskOf(store, 'w1', 'github').scheduled_at).toBe(expectedLocal(WORK_CREATED, 2, '10:30'));
  });

  it('JSON 模式下无法还原时同样保留原值并记录原因', () => {
    const store = newStore('json');
    const before = setupDraftPlan(store);
    const originalTime = before[0].scheduled_at;

    const res = store.reassignPlanOwner(DRAFT, 'w_not_exists');
    expect(res.rescheduled).toHaveLength(0);
    expect(res.reschedule_kept.length).toBeGreaterThan(0);
    expect(taskOf(store, 'w_not_exists', 'github').scheduled_at).toBe(originalTime);
  });

  it('进程重启（重新打开数据库）后仍然是重算后的时间', () => {
    const store = newStore();
    setupDraftPlan(store, { offsetDays: 2, timeOfDay: '10:30' });
    store.reassignPlanOwner(DRAFT, 'w1');
    const expected = expectedLocal(WORK_CREATED, 2, '10:30');

    const reopened = newStore();
    expect(taskOf(reopened, 'w1', 'github').scheduled_at).toBe(expected);
  });

  it('重启后调度器按重算后的时间判断到期（不再用旧的错误基准）', () => {
    const store = newStore();
    setupDraftPlan(store, { offsetDays: 2, timeOfDay: '10:30' });
    store.reassignPlanOwner(DRAFT, 'w1');

    const reopened = newStore();
    const task = taskOf(reopened, 'w1', 'github');
    // 重算后的时间落在过去（作品创建于 2026-03-10，今天更晚）→ 应被判定为到期
    expect(reopened.listDuePlanTasks(new Date().toISOString()).map(t => t.id)).toContain(task.id);
  });
});

/* ==================================================================
   R7b · 真实生产顺序：先 saveWork 落库，再 planReassign 转正
   ================================================================== */
describe('R7b · 生产顺序（saveWork → planReassign）下重算生效', () => {
  it('作品先落库再转正 → 任务时间按作品的 created_at 重算', () => {
    const store = newStore();
    // 计划先存到草稿归属下（此时 works 表里还没有这个作品）
    store.savePlanStages(DRAFT, [
      H.stage('ps_1', { offsetDays: 2, timeOfDay: '10:30', platforms: ['github'] })
    ]);
    expect(store.listPlanTasks(DRAFT)).toHaveLength(1);

    // 生产顺序：launch() 先 saveWork(w)，再 planReassign(draft → w.id)
    store.saveWork({
      id: 'w1', name: '测试自动发送的文章', type: 'tool', intro: 'x', url: '',
      status: '首秀中', queue: '主推', star: 0, dl: 0, play: '0', next: '',
      created_at: WORK_CREATED
    });
    const res = store.reassignPlanOwner(DRAFT, 'w1');

    expect(res.rescheduled).toHaveLength(1);
    expect(res.reschedule_kept).toHaveLength(0);
    expect(taskOf(store, 'w1', 'github').scheduled_at).toBe(expectedLocal(WORK_CREATED, 2, '10:30'));
  });

  it('作品落库后没有 created_at 时保留原值并记录原因（不猜基准）', () => {
    const store = newStore();
    store.savePlanStages(DRAFT, [
      H.stage('ps_1', { offsetDays: 2, timeOfDay: '10:30', platforms: ['github'] })
    ]);
    const originalTime = store.listPlanTasks(DRAFT)[0].scheduled_at;

    // 直接把作品的 created_at 清空（模拟数据缺失）
    store.saveWork({ id: 'w1', name: '作品', type: 'tool', intro: '', url: '', status: '首秀中', queue: '', star: 0, dl: 0, play: '0', next: '' });
    store.run('UPDATE works SET created_at = ? WHERE id = ?', ['', 'w1']);

    const res = store.reassignPlanOwner(DRAFT, 'w1');
    expect(res.rescheduled).toHaveLength(0);
    expect(res.reschedule_kept.length).toBeGreaterThan(0);
    expect(taskOf(store, 'w1', 'github').scheduled_at).toBe(originalTime);
    expect(taskOf(store, 'w1', 'github').note).toContain('未重算执行时间');
  });

  it('重复转正（同一草稿再转一次）不会二次改写时间', () => {
    const store = newStore();
    setupDraftPlan(store, { offsetDays: 2, timeOfDay: '10:30' });
    store.reassignPlanOwner(DRAFT, 'w1');
    const first = taskOf(store, 'w1', 'github').scheduled_at;

    // 草稿下已经没有任务了，再转一次应当什么都不做
    const res = store.reassignPlanOwner(DRAFT, 'w1');
    expect(res.rescheduled).toHaveLength(0);
    expect(taskOf(store, 'w1', 'github').scheduled_at).toBe(first);
  });

  it('转正后再重算一次（重新保存计划）得到同一个时间（幂等）', () => {
    const store = newStore();
    setupDraftPlan(store, { offsetDays: 2, timeOfDay: '10:30' });
    store.reassignPlanOwner(DRAFT, 'w1');
    const first = taskOf(store, 'w1', 'github').scheduled_at;

    // 再用同一份配置保存一次（等价于用户打开计划编辑后保存）
    store.savePlanStages('w1', [
      H.stage('ps_1', { offsetDays: 2, timeOfDay: '10:30', platforms: ['github'] })
    ]);
    expect(taskOf(store, 'w1', 'github').scheduled_at).toBe(first);
  });

  it('「未重算」备注不会盖掉后续删除计划时的「计划已删除」结论', () => {
    const store = newStore();
    setupDraftPlan(store);
    // 转正到不存在的作品 → 写入「未重算」备注
    store.reassignPlanOwner(DRAFT, 'w_not_exists');
    expect(taskOf(store, 'w_not_exists', 'github').note).toContain('未重算执行时间');

    // 随后删除这份计划 → 两个结论都必须可见
    const res = store.deletePlan('w_not_exists');
    expect(res.ok).toBe(true);
    const after = taskOf(store, 'w_not_exists', 'github');
    expect(after.status).toBe('cancelled');
    expect(after.note).toContain('未重算执行时间');
    expect(after.note).toContain('计划已删除');
  });
});

/* ==================================================================
   R8 · renderer → preload → IPC → store 全链路
   ================================================================== */
describe('R8 · 全链路真的打通', () => {
  function createIpcHarness() {
    const handlers = new Map();
    const ipcMain = { handle: vi.fn(function (channel, fn) { handlers.set(channel, fn); }) };
    const storeRef = { current: null };
    const { registerPlanIpc } = require('../electron/plan-ipc');
    registerPlanIpc(ipcMain, { getStore: function () { return storeRef.current; } });
    return { handlers: handlers, ipcMain: ipcMain, storeRef: storeRef };
  }

  it('plan:reassign 通道存在，且返回重算结果与未重算原因', () => {
    const h = createIpcHarness();
    expect(h.handlers.has('plan:reassign')).toBe(true);

    const store = newStore();
    h.storeRef.current = store;
    setupDraftPlan(store, { offsetDays: 2, timeOfDay: '10:30' });

    const res = h.handlers.get('plan:reassign')(null, DRAFT, 'w1');
    expect(res.ok).toBe(true);
    expect(res.rescheduled).toHaveLength(1);
    expect(res.reschedule_kept).toHaveLength(0);
    expect(taskOf(store, 'w1', 'github').scheduled_at).toBe(expectedLocal(WORK_CREATED, 2, '10:30'));
  });

  it('preload 暴露了 planReassign', () => {
    expect(PRELOAD_SRC).toContain('planReassign:');
    expect(PRELOAD_SRC).toContain("ipcRenderer.invoke('plan:reassign'");
  });

  it('renderer 在转正后按新归属继续走（planOwnerId 更新）', async () => {
    // ★ 行为级验证（不是源码字符串断言）：
    //   把生产代码里的 window.planTransferAfterSave 切出来，在沙箱里真实执行一次，
    //   断言「实际调用链」：
    //     1) planReassign 被调用，且实参就是（来源归属, 目标作品 ID）；
    //     2) 转正成功之后 state.planOwnerId / state.copiesOwner 才更新为目标归属；
    //     3) 转正失败时归属保持来源（不更新），并且失败原因被带回来（用户可感知）。
    const transferSrc = extractBlock(INDEX_SRC, 'window.planTransferAfterSave=function(w,fromOwner,needsMove){');
    const calls = [];
    const state = { planOwnerId: DRAFT, copiesOwner: DRAFT, planDirty: false, plan: [] };
    const win = {
      api: {
        saveWork: function (w) { return Promise.resolve({ id: w.id }); },
        planReassign: function (from, to) {
          calls.push({ from: from, to: to });
          return Promise.resolve({ ok: true, stages: [], tasks: [], rescheduled: [], reschedule_kept: [] });
        }
      }
    };
    const fn = new Function('state', 'window', 'toast', 'Promise',
      transferSrc + '\nreturn window.planTransferAfterSave;');
    const transfer = fn(state, win, function () {}, Promise);

    const res = await transfer({ id: 'w1' }, DRAFT, true);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].from).toBe(DRAFT);
    expect(calls[0].to).toBe('w1');
    expect(state.planOwnerId).toBe('w1');
    expect(state.copiesOwner).toBe('w1');

    // 失败路径：归属保持来源，失败原因带回（不静默吞掉）
    const state2 = { planOwnerId: DRAFT, copiesOwner: DRAFT, planDirty: false, plan: [] };
    const win2 = {
      api: {
        saveWork: function (w) { return Promise.resolve({ id: w.id }); },
        planReassign: function () { return Promise.resolve({ ok: false, error: '归属迁移失败' }); }
      }
    };
    const fn2 = new Function('state', 'window', 'toast', 'Promise',
      transferSrc + '\nreturn window.planTransferAfterSave;');
    const transfer2 = fn2(state2, win2, function () {}, Promise);
    const res2 = await transfer2({ id: 'w1' }, DRAFT, true);
    expect(res2.ok).toBe(false);
    expect(res2.reason).toContain('归属迁移失败');
    expect(state2.planOwnerId).toBe(DRAFT);
  });

  it('renderer 会把「未能重算」的原因告知用户（不静默吞掉）', () => {
    expect(INDEX_SRC).toContain('res.reschedule_kept');
    expect(INDEX_SRC).toContain('未能按作品创建时间重算');
  });

  it('生产代码里重算逻辑确实在 store 层（不是只在页面上算）', () => {
    expect(STORE_SRC).toContain('_planReschedulePlan');
    expect(STORE_SRC).toContain('_planScheduledAt(createdAt');
    // 只重算 pending
    expect(STORE_SRC).toContain("if (String(t.status || '') !== 'pending') return;");
  });
});

/* ==================================================================
   R9 · 没有真实发布、没有开启真实发送开关、没有动生产数据库
   ================================================================== */
describe('R9 · 安全边界', () => {
  it('本次改动没有引入任何真实平台 API 调用', () => {
    // store 层的重算只做数据库读写：源码里不出现任何 http / fetch / 发布调用
    const slice = STORE_SRC.slice(STORE_SRC.indexOf('reassignPlanOwner(fromOwner, toOwner)'), STORE_SRC.indexOf('reassignPlanOwner(fromOwner, toOwner)') + 6000);
    expect(slice).not.toMatch(/https?:\/\/[a-z]/i);
    expect(slice).not.toContain('fetch(');
    expect(slice).not.toContain('request(');
  });

  it('真实发送开关的默认值仍是关闭', () => {
    const store = newStore();
    expect(String(store.getSettingKv('plan_real_publish') || '')).not.toBe('1');
  });

  it('测试只使用临时目录里的数据库文件', () => {
    expect(dbPath.indexOf(tmpDir)).toBe(0);
    expect(fs.existsSync(path.join(H.ROOT, '.userdata', 'ai-launch-master.db'))).toBe(true); // 生产库存在但未被本测试触碰
  });
});
