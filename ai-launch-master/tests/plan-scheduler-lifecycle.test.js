'use strict';

// Rokit · 任务 C：调度链路生命周期（定向测试）
//
// 覆盖用户要求的全部调度链路验证点：
//   C-L1  调度器启动后会真的扫描（不是只创建了定时器）
//   C-L2  到期任务进入执行流程（pending → running → done / failed）
//   C-L3  执行完成后状态**写回数据库**（不是只改内存）
//   C-L4  进程重启后能正确恢复（遗留 running → 重新排队 / 转人工核实）
//   C-L5  failed 任务不会被自动重发
//   C-L6  needs_review 任务不会被自动重发
//   C-L7  成功任务不会重复执行
//   C-L8  real_only=0 的任务**不会**走真实发布路径（只有勾选「自动发布」的任务才可能真实执行）
//   C-L9  删除计划后调度器不再选中该计划的任务
//   C-L10 整个过程没有调用任何真实平台 API
//
// 安全约束（严格遵守）：
//   - 全程使用临时目录里的独立数据库；
//   - 只注入**假的**执行器（记录调用、不发网络请求），
//     绝不在测试里调用真实 GitHub / YouTube / 微信接口；
//   - 不写入任何 settings_kv 设置行（总开关已移除，调度器不再依赖任何设置开关）。
//
// 跑的是生产代码：
//   - electron/store.js（真实 SQLite / JSON 存储层）
//   - electron/plan-scheduler.js（真实调度器 + 真实模拟执行器）

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const SCHEDULER_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'plan-scheduler.js'), 'utf8').replace(/\r\n/g, '\n');
const MAIN_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

let tmpDir;
let dbPath;
let restoreBlock = null;

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

function loadStore(mode) {
  if (restoreBlock) { restoreBlock(); restoreBlock = null; }
  const id = require.resolve(path.join(H.ROOT, 'electron', 'store'));
  delete require.cache[id];
  restoreBlock = H.installDriverBlock(mode === 'json');
  return require(path.join(H.ROOT, 'electron', 'store'));
}
function newStore(mode, file) {
  const { Store } = loadStore(mode || 'sqlite');
  return new Store(file || dbPath);
}
function loadScheduler() {
  const id = require.resolve(path.join(H.ROOT, 'electron', 'plan-scheduler'));
  delete require.cache[id];
  return require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
}

// 建一个作品 + 一个阶段（每个平台一条任务），并把任务时间改成到期
//   本文件验证模拟调度器：造好计划后把任务降级为模拟候选（等价旧 auto_publish=0 历史任务）；
//   需要真实执行资质的用例会在 seed 之后显式写回 real_only=1。
function setupDueWork(store, workId, platforms, dueIso) {
  H.seedWork(store, workId, '作品 ' + workId);
  store.savePlanStages(workId, [H.stage('ps_' + workId, { platforms: platforms || ['github'] })]);
  store.listPlanTasks(workId).forEach(function (t) {
    store.updatePlanTask(workId, t.id, { scheduled_at: dueIso || H.PAST });
  });
  return H.demoteToSimulated(store, workId);
}

// 假执行器：只记录调用，**不发任何网络请求**
function fakeExecutor(log, resultFn) {
  return function (task) {
    log.push({ id: task.id, status: task.status, platform_id: task.platform_id });
    return resultFn ? resultFn(task) : { ok: true, status: 'done', simulated: true, platform_ref: 'mock:' + task.platform_id + ':' + task.id, platform_url: '' };
  };
}

/* ==================================================================
   C-L1 · 调度器启动后会真的扫描
   ================================================================== */
describe('C-L1 · 调度器启动后会真的扫描', () => {
  it('start() 之后扫描计数增加，状态里能看出最近一次扫描时间', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github']);

    const scheduler = createPlanScheduler({ getStore: () => store, intervalMs: 10 });
    expect(scheduler.status().scans).toBe(0);
    expect(scheduler.status().running).toBe(false);

    scheduler.start();
    const st = scheduler.status();
    expect(st.running).toBe(true);
    expect(st.scans).toBeGreaterThan(0);          // 启动即扫描了一次
    expect(st.last_scan).toBeTruthy();
    expect(st.last_error).toBe('');

    scheduler.stop();
    expect(scheduler.status().running).toBe(false);
  });

  it('定时器会持续触发扫描（不是只在启动时扫一次）', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({ getStore: () => store, intervalMs: 15 });
    scheduler.start();
    const first = scheduler.status().scans;

    return new Promise(function (resolve) {
      setTimeout(function () {
        const after = scheduler.status().scans;
        scheduler.stop();
        expect(after).toBeGreaterThan(first);     // 扫描确实在持续发生
        resolve();
      }, 120);
    });
  });

  it('main.js 在启动时真的调用了 planScheduler.start()', () => {
    const i = MAIN_SRC.indexOf('createPlanScheduler');
    // 窗口需覆盖 createPlanScheduler → 执行器注入 → planScheduler.start() 的整段
    const block = MAIN_SRC.slice(Math.max(0, i - 300), i + 1400);
    expect(block).toContain('planScheduler');
    expect(block).toContain('.start()');
    // 启动后立刻记录状态：证明这不是"创建了对象但没启动"
    expect(block).toContain("'[plan-scheduler] started'");
  });
});

/* ==================================================================
   C-L2 · 到期任务进入执行流程
   ================================================================== */
describe('C-L2 · 到期任务进入执行流程', () => {
  it('start() 后到期任务被领取并执行，状态从 pending 变成 done', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupDueWork(store, 'w1', ['github']);

    const log = [];
    const scheduler = createPlanScheduler({
      getStore: () => store,
      intervalMs: 10,
      executor: fakeExecutor(log)
    });
    scheduler.start();
    scheduler.stop();

    expect(log).toHaveLength(1);
    expect(log[0].id).toBe(tasks[0].id);
    expect(log[0].status).toBe('running');      // 领取之后才是 running
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
  });

  it('多平台任务各自独立进入执行流程', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github', 'wechat', 'youtube']);

    const log = [];
    const scheduler = createPlanScheduler({
      getStore: () => store,
      intervalMs: 10,
      executor: fakeExecutor(log, function (task) {
        if (task.platform_id === 'youtube') return { ok: false, error: '模拟失败', simulated: true };
        if (task.platform_id === 'wechat') return { ok: true, status: 'draft_pending', simulated: true };
        return { ok: true, status: 'done', simulated: true };
      })
    });
    scheduler.scanOnce();

    expect(log).toHaveLength(3);
    const after = store.listPlanTasks('w1');
    expect(after.filter(t => t.platform_id === 'github')[0].status).toBe('done');
    expect(after.filter(t => t.platform_id === 'wechat')[0].status).toBe('draft_pending');
    expect(after.filter(t => t.platform_id === 'youtube')[0].status).toBe('failed');
  });
});

/* ==================================================================
   C-L3 · 执行结果写回数据库
   ================================================================== */
describe('C-L3 · 执行结果写回数据库（不是只改内存）', () => {
  it('重新打开数据库后仍能看到执行结果与时间戳', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github']);

    const scheduler = createPlanScheduler({
      getStore: () => store,
      intervalMs: 10,
      executor: fakeExecutor([])
    });
    scheduler.scanOnce();

    const reopened = newStore();
    const t = reopened.listPlanTasks('w1')[0];
    expect(t.status).toBe('done');
    expect(t.started_at).toBeTruthy();
    expect(t.finished_at).toBeTruthy();
    expect(t.platform_ref).toBe('mock:github:pt_ps_w1_github');
    expect(t.platform_url).toBe('');            // 模拟执行不写真实链接
  });

  it('失败结果（含原因）同样写回数据库', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github']);

    const scheduler = createPlanScheduler({
      getStore: () => store,
      intervalMs: 10,
      executor: fakeExecutor([], function () { return { ok: false, error: '模拟失败：授权失效', simulated: true }; })
    });
    scheduler.scanOnce();

    const reopened = newStore();
    const t = reopened.listPlanTasks('w1')[0];
    expect(t.status).toBe('failed');
    expect(t.error).toContain('授权失效');
  });
});

/* ==================================================================
   C-L4 · 进程重启后能正确恢复
   ================================================================== */
describe('C-L4 · 进程重启后能正确恢复', () => {
  it('遗留的模拟 running 任务会被重新排队并真正再执行一次', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupDueWork(store, 'w1', ['github']);
    store.claimPlanTask(tasks[0].id);           // 模拟：执行到一半进程退出
    expect(store.listPlanTasks('w1')[0].status).toBe('running');

    const reopened = newStore();
    const log = [];
    const scheduler = createPlanScheduler({
      getStore: () => reopened,
      intervalMs: 10,
      executor: fakeExecutor(log)
    });
    scheduler.start();
    scheduler.stop();

    expect(log).toHaveLength(1);
    expect(reopened.listPlanTasks('w1')[0].status).toBe('done');
  });

  it('遗留的**真实** running 任务转为待人工核实，绝不自动重发', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupDueWork(store, 'w1', ['github']);
    // 标记成"等待真实执行"的遗留任务（real_only=1）
    store._planWriteTask(Object.assign({}, tasks[0], {
      status: 'running', real_only: 1, simulated: 0,
      started_at: new Date().toISOString()
    }));

    const reopened = newStore();
    const log = [];
    const scheduler = createPlanScheduler({
      getStore: () => reopened,
      intervalMs: 10,
      executor: fakeExecutor(log)
    });
    scheduler.start();
    scheduler.stop();

    expect(log).toHaveLength(0);                  // 没有被执行（没有重复发送）
    const t = reopened.listPlanTasks('w1')[0];
    expect(t.status).toBe('needs_review');
    expect(t.note).toContain('人工核实');
  });

  it('重启后未到期的任务继续等待，不会被提前执行', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    H.seedWork(store, 'w1', '作品 w1');
    store.savePlanStages('w1', [H.stage('ps_w1', { platforms: ['github'] })]);
    store.updatePlanTask('w1', store.listPlanTasks('w1')[0].id, { scheduled_at: H.FUTURE });

    const reopened = newStore();
    const log = [];
    const scheduler = createPlanScheduler({
      getStore: () => reopened,
      intervalMs: 10,
      executor: fakeExecutor(log)
    });
    scheduler.start();
    scheduler.stop();

    expect(log).toHaveLength(0);
    expect(reopened.listPlanTasks('w1')[0].status).toBe('pending');
  });
});

/* ==================================================================
   C-L5 / C-L6 / C-L7 · 不重复执行
   ================================================================== */
describe('C-L5 · failed 任务不会被自动重发', () => {
  it('扫描多少次都不会重新执行已失败的任务', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github']);

    const log = [];
    const scheduler = createPlanScheduler({
      getStore: () => store,
      intervalMs: 10,
      executor: fakeExecutor(log, function () { return { ok: false, error: '模拟失败', simulated: true }; })
    });
    scheduler.scanOnce();
    scheduler.scanOnce();
    scheduler.scanOnce();

    expect(log).toHaveLength(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('failed');
    // 明确失败 = 终止状态：闸门也不允许再发
    const guard = store.checkPlanPublishGuard('w1', store.listPlanTasks('w1')[0].id);
    expect(guard.decision).toBe('unclear');
  });

  it('真实（非模拟）任务确认失败后，闸门明确写明「不会自动重试」', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github']);
    const t = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, t, {
      status: 'failed', simulated: 0, error: '已确认失败：授权失效'
    }));

    const guard = store.checkPlanPublishGuard('w1', t.id);
    expect(guard.decision).toBe('unclear');
    expect(guard.reason).toContain('不会自动重试');
    expect(guard.matched.failed_task).toBe(true);
  });

  it('重启后已失败的任务同样不会被自动重发', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github']);
    store._planWriteTask(Object.assign({}, store.listPlanTasks('w1')[0], {
      status: 'failed', error: '模拟失败'
    }));

    const reopened = newStore();
    const log = [];
    const scheduler = createPlanScheduler({
      getStore: () => reopened,
      intervalMs: 10,
      executor: fakeExecutor(log)
    });
    scheduler.start();
    scheduler.stop();

    expect(log).toHaveLength(0);
    expect(reopened.listPlanTasks('w1')[0].status).toBe('failed');
  });
});

describe('C-L6 · needs_review 任务不会被自动重发', () => {
  it('扫描多少次都不会重新执行待人工核实的任务', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github']);
    store._planWriteTask(Object.assign({}, store.listPlanTasks('w1')[0], {
      status: 'needs_review', simulated: 0
    }));

    const log = [];
    const scheduler = createPlanScheduler({
      getStore: () => store,
      intervalMs: 10,
      executor: fakeExecutor(log)
    });
    scheduler.scanOnce();
    scheduler.scanOnce();

    expect(log).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('needs_review');
  });

  it('重启后待人工核实的任务同样不会被自动重发', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github']);
    store._planWriteTask(Object.assign({}, store.listPlanTasks('w1')[0], {
      status: 'needs_review', simulated: 0
    }));

    const reopened = newStore();
    const log = [];
    const scheduler = createPlanScheduler({
      getStore: () => reopened,
      intervalMs: 10,
      executor: fakeExecutor(log)
    });
    scheduler.start();
    scheduler.stop();

    expect(log).toHaveLength(0);
    expect(reopened.listPlanTasks('w1')[0].status).toBe('needs_review');
  });
});

describe('C-L7 · 成功任务不会重复执行', () => {
  it('重启 + 多次扫描后，执行器只被调用一次', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github']);

    const log = [];
    const s1 = createPlanScheduler({
      getStore: () => store, intervalMs: 10, executor: fakeExecutor(log)
    });
    s1.start();
    s1.stop();
    expect(log).toHaveLength(1);

    const reopened = newStore();
    const s2 = createPlanScheduler({
      getStore: () => reopened, intervalMs: 10, executor: fakeExecutor(log)
    });
    s2.start();
    s2.stop();

    expect(log).toHaveLength(1);                  // 没有重复执行
    expect(reopened.listPlanTasks('w1')[0].status).toBe('done');
  });
});

/* ==================================================================
   C-L8 · real_only=0 → 不走真实发布路径
   ================================================================== */
describe('C-L8 · real_only=0 时不会走真实发布路径', () => {
  it('普通待执行任务在任何模式下都只走模拟执行器', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github']);

    const mockLog = [];
    const realLog = [];
    const scheduler = createPlanScheduler({
      getStore: () => store,
      intervalMs: 10,
      executorKind: 'real',                        // 常驻真实模式（总开关已移除）
      mockExecutor: fakeExecutor(mockLog),
      realExecutors: { github: fakeExecutor(realLog) }
    });
    scheduler.scanOnce();

    expect(mockLog).toHaveLength(1);               // 走了模拟执行器
    expect(realLog).toHaveLength(0);               // 没有走真实执行器
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
  });

  it('real_only=1 的任务在模拟模式下被跳过（不会进入任何执行器）', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupDueWork(store, 'w1', ['github']);
    store._planWriteTask(Object.assign({}, tasks[0], { real_only: 1 }));

    const mockLog = [];
    const realLog = [];
    const scheduler = createPlanScheduler({
      getStore: () => store,
      intervalMs: 10,
      executorKind: 'mock',                        // 模拟模式（real_only=1 任务不会被选中）
      mockExecutor: fakeExecutor(mockLog),
      realExecutors: { github: fakeExecutor(realLog) }
    });
    const out = scheduler.scanOnce();

    expect(mockLog).toHaveLength(0);
    expect(realLog).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
    expect(out.claimed).toHaveLength(0);
  });

  it('真实模式下未注册平台的 real_only 任务被跳过（不会误发）', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupDueWork(store, 'w1', ['youtube']);
    store._planWriteTask(Object.assign({}, tasks[0], { real_only: 1 }));

    const realLog = [];
    const scheduler = createPlanScheduler({
      getStore: () => store,
      intervalMs: 10,
      executorKind: 'real',
      realExecutors: { github: fakeExecutor(realLog) }   // 只注册了 github
    });
    const out = scheduler.scanOnce();

    expect(realLog).toHaveLength(0);
    expect(out.skipped.length).toBe(1);
    expect(out.skipped[0].reason).toContain('尚未接入真实发布');
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });

  it('真实模式下幂等闸门判定为「已发布 / 待核实 / 不确定」时一律不执行', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();

    // 每个闸门场景用**独立的数据库文件 + 独立作品**，避免上一场景的发布记录/任务影响下一场景
    function runWithGuard(workId, mutate) {
      const s = newStore('sqlite', path.join(tmpDir, workId + '.db'));
      const { createPlanScheduler: cps } = loadScheduler();
      const ts = setupDueWork(s, workId, ['github']);
      mutate(s, ts[0], workId);
      const mockLog = [];
      const realLog = [];
      const sch = cps({
        getStore: () => s,
        intervalMs: 10,
        executorKind: 'real',
        mockExecutor: fakeExecutor(mockLog),
        realExecutors: { github: fakeExecutor(realLog) }
      });
      const out = sch.scanOnce();
      return {
        store: s,
        workId: workId,
        mockCalls: mockLog.length,
        realCalls: realLog.length,
        skipped: out.skipped,
        claimed: out.claimed,
        task: s.listPlanTasks(workId)[0]
      };
    }

    // 把任务标记为「等待真实执行」（只有 real_only=1 的任务才会进入真实路径与幂等闸门）
    function markRealOnly(s, workId) {
      const cur = s.listPlanTasks(workId)[0];
      s._planWriteTask(Object.assign({}, cur, { real_only: 1, simulated: 0 }));
    }

    // ① 已确认成功（幂等键精确命中）→ skip
    const r1 = runWithGuard('wg1', function (s, t, wid) {
      markRealOnly(s, wid);
      s.addPub({ work_id: wid, platform: 'GitHub', platform_id: 'github', status: 'ok', pub_key: t.pub_key });
    });
    expect(r1.realCalls).toBe(0);
    expect(r1.mockCalls).toBe(0);
    expect(r1.skipped.length).toBe(1);
    expect(r1.skipped[0].reason).toContain('不得再次发布');
    expect(r1.task.status).toBe('pending');       // 不执行、也不改变状态

    // ② 同作品同平台有别的成功记录 → review（人工确认）
    const r2 = runWithGuard('wg2', function (s, t, wid) {
      markRealOnly(s, wid);
      // 人工记录带平台链接 → 构成重复发布风险证据 → review
      s.addPub({
        work_id: wid, platform: 'GitHub', platform_id: 'github', status: 'manual',
        pub_key: 'other-key', url: 'https://github.com/o/r/releases/tag/v0.1.0'
      });
    });
    expect(r2.realCalls).toBe(0);
    expect(r2.mockCalls).toBe(0);
    expect(r2.skipped.length).toBe(1);
    expect(r2.skipped[0].reason).toContain('需人工确认');
    expect(r2.task.status).toBe('pending');

    // ③ 已确认失败 → 终止：任务根本不在待执行队列里，调度器不会碰它；
    //    闸门本身也明确写明「不会自动重试」。
    const r3 = runWithGuard('wg3', function (s, t, wid) {
      s.addPub({ work_id: wid, platform: 'GitHub', platform_id: 'github', status: 'failed', pub_key: 'f1' });
      s._planWriteTask(Object.assign({}, s.listPlanTasks(wid)[0], { status: 'failed', error: '已确认失败' }));
    });
    expect(r3.realCalls).toBe(0);
    expect(r3.mockCalls).toBe(0);
    expect(r3.claimed).toHaveLength(0);             // 已失败的任务不会被领取
    expect(r3.task.status).toBe('failed');
    const g3 = r3.store.checkPlanPublishGuard('wg3', r3.task.id);
    expect(g3.decision).toBe('unclear');
    expect(g3.reason).toContain('不会自动重试');
  });

  it('总开关已移除：main.js 不再读取 plan_real_publish，调度器常驻 real 模式', () => {
    expect(MAIN_SRC).not.toContain('plan_real_publish');
    expect(MAIN_SRC).not.toContain('isPlanRealPublishEnabled');
    expect(MAIN_SRC).toContain("executorKind: 'real'");
  });
});

/* ==================================================================
   C-L9 · 删除计划后调度器不再选中
   ================================================================== */
describe('C-L9 · 删除计划后调度器不再选中该计划的任务', () => {
  it('删除 → 启动调度器 → 不会执行已删除计划的任务', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    setupDueWork(store, 'w1', ['github']);
    store.deletePlan('w1');

    const log = [];
    const scheduler = createPlanScheduler({
      getStore: () => store, intervalMs: 10, executor: fakeExecutor(log)
    });
    scheduler.start();
    scheduler.stop();

    expect(log).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('cancelled');
  });
});

/* ==================================================================
   C-L10 · 没有真实平台调用
   ================================================================== */
describe('C-L10 · 整个过程没有调用任何真实平台 API', () => {
  it('调度器源码里没有任何网络请求', () => {
    expect(SCHEDULER_SRC).not.toMatch(/https?\.(get|post|request)|fetch\s*\(|net\.request|axios/i);
  });

  it('调度器源码里没有引用任何真实发布模块', () => {
    expect(SCHEDULER_SRC).not.toMatch(/publishers|youtube-publisher|github-publisher|wechat-draft|createDraft|publishVideo|publishRepo/i);
  });

  it('模拟执行器只产生 mock 前缀的平台标识，链接恒为空', () => {
    const { createMockPlanExecutor } = loadScheduler();
    const exec = createMockPlanExecutor();
    ['github', 'wechat', 'youtube'].forEach(function (pid) {
      const r = exec({ id: 'pt_x_' + pid, platform_id: pid, stage_title: '阶段', note: '' });
      expect(r.ok).toBe(true);
      expect(r.platform_ref.indexOf('mock:')).toBe(0);
      expect(r.platform_url).toBe('');
      expect(r.simulated).toBe(true);
    });
  });

  it('本次测试没有写入任何 settings_kv 设置行', () => {
    const store = newStore();
    const rows = store.mode === 'sqlite'
      ? store.all('SELECT * FROM settings_kv')
      : (store.data.settings_kv ? Object.keys(store.data.settings_kv) : []);
    expect(rows).toHaveLength(0);
  });
});
