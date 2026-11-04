'use strict';

// Rokit · 第二阶段：模拟调度器定向测试
//
// 覆盖用户要求的全部调度器验证点：
//   S1  未到期任务不执行
//   S2  到期任务进入模拟执行流程（pending → running → done / draft_pending）
//   S3  成功任务不重复执行
//   S4  失败任务保留错误信息
//   S5  应用重启后到期任务能够恢复
//   S6  关闭应用期间不执行任务
//   S7  遗留 running 任务不会被错误标记为成功
//   S8  已取消 / 已完成 / 待核实任务不会被错误重新执行
//   S9  同一阶段多个平台任务相互独立
//   S10 多个作品的到期任务互不干扰
//   S11 修改计划时间后，调度器使用最新持久化时间
//   S12 数据库或模拟执行器异常不会导致所有任务永久停止
//   S13 重复领取和重复扫描不会产生重复执行
//   S14 SQLite 与 JSON 两种存储模式的行为保持一致
//   S15 整个第二阶段不发生真实平台发布或外部写入
//
// 跑的是生产代码：
//   - electron/store.js（真实 SQLite / JSON 存储层）
//   - electron/plan-scheduler.js（真实调度器 + 真实模拟执行器）
//
// 所有测试都用临时目录里的独立数据库，不触碰用户真实作品与发布记录。

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const SCHEDULER_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'plan-scheduler.js'), 'utf8').replace(/\r\n/g, '\n');

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

// 载入 store（按模式屏蔽驱动）
//   注意：必须先还原上一次的拦截，否则嵌套安装会泄漏（后续用例全部退化成 JSON 模式）
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
function loadScheduler() {
  const id = require.resolve(path.join(H.ROOT, 'electron', 'plan-scheduler'));
  delete require.cache[id];
  return require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
}

// 建一个作品 + 计划，返回任务
//   本文件专门验证模拟调度器的既有行为：造好计划后把任务降级为模拟候选
//   （等价于旧版 auto_publish=0 的历史任务），否则新规则下 GitHub 任务是 real_only=1，
//   模拟调度器不会领取。
function setupWork(store, workId, platforms, offsetDays) {
  H.seedWork(store, workId, '作品 ' + workId);
  store.savePlanStages(workId, [H.stage('ps_' + workId, {
    platforms: platforms || ['github'],
    offsetDays: offsetDays === undefined ? 0 : offsetDays,
    title: '阶段 ' + workId
  })]);
  return H.demoteToSimulated(store, workId);
}

function taskOf(store, workId, platformId) {
  return store.listPlanTasks(workId).filter(function (t) { return t.platform_id === platformId; })[0];
}

/* ==================================================================
   S1 · 未到期任务不执行
   ================================================================== */
describe('S1 · 未到期任务不执行', () => {
  it('计划时间在未来的任务不会被领取，也不会被执行', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.FUTURE });

    const scheduler = createPlanScheduler({ getStore: () => store });
    const out = scheduler.scanOnce();

    expect(out.claimed).toHaveLength(0);
    expect(out.done).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
    expect(store.listPlanTasks('w1')[0].started_at).toBe('');
  });

  it('调度器没有启动时不会有任何任务被执行', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    const scheduler = createPlanScheduler({ getStore: () => store, intervalMs: 10 });
    // 只创建不 start()：定时器不存在，任务保持待执行
    return new Promise(function (resolve) {
      setTimeout(function () {
        expect(store.listPlanTasks('w1')[0].status).toBe('pending');
        resolve();
      }, 60);
    });
  });
});

/* ==================================================================
   S2 · 到期任务进入模拟执行流程
   ================================================================== */
describe('S2 · 到期任务进入模拟执行流程', () => {
  it('pending → running → done（GitHub / YouTube 模拟成功）', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    const seen = [];
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function (task) {
        seen.push(task.status);          // 领取后应是 running
        return { ok: true, status: 'done', platform_ref: 'mock:github:' + task.id };
      }
    });
    const out = scheduler.scanOnce();

    expect(seen).toEqual(['running']);
    expect(out.claimed).toHaveLength(1);
    expect(out.done).toHaveLength(1);
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.started_at).toBeTruthy();
    expect(after.finished_at).toBeTruthy();
  });

  it('公众号任务模拟完成后进入「草稿待发布」（不自动群发）', () => {
    const store = newStore();
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['wechat']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    scheduler.scanOnce();

    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('draft_pending');
    expect(after.platform_url).toBe('');
    expect(after.platform_ref.indexOf('mock:')).toBe(0);
  });

  it('模拟执行结果明确标记为模拟（不写真实平台 ID / 真实链接）', () => {
    const store = newStore();
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github', 'youtube']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    store.updatePlanTask('w1', tasks[1].id, { scheduled_at: H.PAST });

    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    scheduler.scanOnce();

    store.listPlanTasks('w1').forEach(function (t) {
      expect(t.platform_ref).toMatch(/^mock:/);
      expect(t.platform_url).toBe('');
      expect(t.note).toContain('模拟');
    });
  });
});

/* ==================================================================
   S3 · 成功任务不重复执行
   ================================================================== */
describe('S3 · 成功任务不重复执行', () => {
  it('重复扫描不会再次执行已完成的任务', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    let calls = 0;
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    scheduler.scanOnce();
    scheduler.scanOnce();
    scheduler.scanOnce();

    expect(calls).toBe(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
  });

  it('应用重启后不会批量重复执行已经成功的任务', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    let calls = 0;
    const s1 = createPlanScheduler({
      getStore: () => store,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    s1.scanOnce();
    expect(calls).toBe(1);

    // 模拟重启：新的 store 实例 + 新的调度器
    const store2 = newStore();
    const s2 = createPlanScheduler({
      getStore: () => store2,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    s2.scanOnce();
    expect(calls).toBe(1);
    expect(store2.listPlanTasks('w1')[0].status).toBe('done');
  });
});

/* ==================================================================
   S4 · 失败任务保留错误信息
   ================================================================== */
describe('S4 · 失败任务保留错误信息', () => {
  it('模拟失败时状态为 failed 且保留错误信息', () => {
    const store = newStore();
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    // 可控失败条件：阶段标题里带 MOCK_FAIL（不依赖任何网络请求）
    store.savePlanStages('w1', [H.stage('ps_w1', { platforms: ['github'], title: 'MOCK_FAIL 阶段' })]);
    // 重存阶段后任务仍是真实执行候选（real_only=1），模拟口径需降级为模拟候选
    H.demoteToSimulated(store, 'w1');
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
    const out = scheduler.scanOnce();

    expect(out.failed).toHaveLength(1);
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('failed');
    expect(after.error).toContain('模拟执行失败');
    expect(after.finished_at).toBeTruthy();
  });

  it('模拟执行器抛异常时任务失败并记录原因，其它任务继续处理', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github', 'youtube']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    store.updatePlanTask('w1', tasks[1].id, { scheduled_at: H.PAST });

    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function (task) {
        if (task.platform_id === 'github') throw new Error('模拟执行器炸了');
        return { ok: true, status: 'done' };
      }
    });
    scheduler.scanOnce();

    const after = store.listPlanTasks('w1');
    const gh = after.filter(t => t.platform_id === 'github')[0];
    const yt = after.filter(t => t.platform_id === 'youtube')[0];
    expect(gh.status).toBe('failed');
    expect(gh.error).toContain('模拟执行器炸了');
    expect(yt.status).toBe('done');   // 其它任务不受影响
  });
});

/* ==================================================================
   S5 / S7 · 重启恢复
   ================================================================== */
describe('S5 · 应用重启后到期任务能够恢复', () => {
  it('重启后扫描一次即可执行到期任务', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    // 重启：新的 store 实例读到同样的持久化数据
    const store2 = newStore();
    const scheduler = createPlanScheduler({
      getStore: () => store2,
      executor: function () { return { ok: true, status: 'done' }; }
    });
    scheduler.scanOnce();

    expect(store2.listPlanTasks('w1')[0].status).toBe('done');
  });

  it('未来任务在重启后继续等待到期', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.FUTURE });

    const store2 = newStore();
    const scheduler = createPlanScheduler({ getStore: () => store2 });
    scheduler.scanOnce();

    expect(store2.listPlanTasks('w1')[0].status).toBe('pending');
  });
});

describe('S7 · 遗留 running 任务不会被错误标记为成功', () => {
  it('重启恢复把 running 重新排队，而不是直接当作成功', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    // 模拟：执行到一半应用被关掉（状态停在 running，没有结果）
    const claim = store.claimPlanTask(tasks[0].id);
    expect(claim.ok).toBe(true);
    expect(store.listPlanTasks('w1')[0].status).toBe('running');

    // 重启：新的 store + 新的调度器
    const store2 = newStore();
    const scheduler = createPlanScheduler({ getStore: () => store2 });
    const rec = scheduler.recover();

    expect(rec.recovered).toBe(1);
    const after = store2.listPlanTasks('w1')[0];
    // 关键：绝不能直接是 done（那会伪造从未发生过的成功）
    expect(after.status).toBe('pending');
    expect(after.note).toContain('重启恢复');
    expect(after.platform_url).toBe('');
    expect(after.platform_ref).toBe('');
  });

  it('启动流程（start）会先恢复再扫描，遗留任务最终由模拟执行器真实执行', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    store.claimPlanTask(tasks[0].id);   // 遗留 running

    const store2 = newStore();
    let calls = 0;
    const scheduler = createPlanScheduler({
      getStore: () => store2,
      executor: function () { calls++; return { ok: true, status: 'done', platform_ref: 'mock:github:x' }; }
    });
    scheduler.start();
    scheduler.stop();

    expect(calls).toBe(1);   // 真实重新执行了一次，不是"假定成功"
    expect(store2.listPlanTasks('w1')[0].status).toBe('done');
    expect(store2.listPlanTasks('w1')[0].platform_ref).toBe('mock:github:x');
  });
});

/* ==================================================================
   S6 · 关闭应用期间不执行任务
   ================================================================== */
describe('S6 · 关闭应用期间不执行任务', () => {
  it('stop() 之后定时器不再触发任务执行', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);

    let calls = 0;
    const scheduler = createPlanScheduler({
      getStore: () => store,
      intervalMs: 15,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    scheduler.start();
    scheduler.stop();
    expect(scheduler.status().running).toBe(false);

    // 关闭期间把任务改成到期；定时器已停，不应被执行
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    return new Promise(function (resolve) {
      setTimeout(function () {
        expect(calls).toBe(0);
        expect(store.listPlanTasks('w1')[0].status).toBe('pending');
        resolve();
      }, 120);
    });
  });

  it('main.js 在 before-quit 时停止调度器', () => {
    const MAIN_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    expect(MAIN_SRC).toContain("app.on('before-quit'");
    const i = MAIN_SRC.indexOf("app.on('before-quit'");
    const block = MAIN_SRC.slice(i, i + 400);
    expect(block).toContain('planScheduler.stop()');
  });
});

/* ==================================================================
   S8 · 非待执行任务不会被重新执行
   ================================================================== */
describe('S8 · 已取消 / 已完成 / 待核实任务不会被错误重新执行', () => {
  it('三种状态的任务都不会被调度器领取', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github', 'wechat', 'youtube']);

    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    store.updatePlanTask('w1', tasks[1].id, { scheduled_at: H.PAST });
    store.updatePlanTask('w1', tasks[2].id, { scheduled_at: H.PAST });

    store.cancelPlanTask('w1', tasks[0].id);                       // cancelled
    const doneTask = tasks[1];
    store._planWriteTask(Object.assign({}, doneTask, {             // done
      status: 'done', started_at: new Date().toISOString(), finished_at: new Date().toISOString()
    }));
    store._planWriteTask(Object.assign({}, tasks[2], {             // needs_review
      status: 'needs_review'
    }));

    let calls = 0;
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    const out = scheduler.scanOnce();

    expect(calls).toBe(0);
    expect(out.claimed).toHaveLength(0);
    const after = store.listPlanTasks('w1');
    expect(after.filter(t => t.platform_id === 'github')[0].status).toBe('cancelled');
    expect(after.filter(t => t.platform_id === 'wechat')[0].status).toBe('done');
    expect(after.filter(t => t.platform_id === 'youtube')[0].status).toBe('needs_review');
  });

  it('草稿待发布（微信）不会被当成待执行任务重新执行', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['wechat']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    store._planWriteTask(Object.assign({}, tasks[0], { status: 'draft_pending' }));

    let calls = 0;
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function () { calls++; return { ok: true, status: 'done' }; }
    });
    scheduler.scanOnce();

    expect(calls).toBe(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('draft_pending');
  });
});

/* ==================================================================
   S9 / S10 · 多平台、多作品互不干扰
   ================================================================== */
describe('S9 · 同一阶段多个平台任务相互独立', () => {
  it('三个平台各自产生独立结果，一个失败不影响其它两个', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github', 'wechat', 'youtube']);
    tasks.forEach(t => store.updatePlanTask('w1', t.id, { scheduled_at: H.PAST }));

    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function (task) {
        if (task.platform_id === 'youtube') return { ok: false, error: '模拟失败' };
        if (task.platform_id === 'wechat') return { ok: true, status: 'draft_pending' };
        return { ok: true, status: 'done' };
      }
    });
    scheduler.scanOnce();

    const after = store.listPlanTasks('w1');
    expect(after.filter(t => t.platform_id === 'github')[0].status).toBe('done');
    expect(after.filter(t => t.platform_id === 'wechat')[0].status).toBe('draft_pending');
    expect(after.filter(t => t.platform_id === 'youtube')[0].status).toBe('failed');
  });
});

describe('S10 · 多个作品的到期任务互不干扰', () => {
  it('两个作品的到期任务各自执行，结果互不影响', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const t1 = setupWork(store, 'w1', ['github']);
    const t2 = setupWork(store, 'w2', ['wechat']);
    store.updatePlanTask('w1', t1[0].id, { scheduled_at: H.PAST });
    store.updatePlanTask('w2', t2[0].id, { scheduled_at: H.PAST });

    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function (task) {
        return task.work_id === 'w1'
          ? { ok: true, status: 'done' }
          : { ok: false, error: '另一个作品的模拟失败' };
      }
    });
    scheduler.scanOnce();

    expect(store.listPlanTasks('w1')[0].status).toBe('done');
    expect(store.listPlanTasks('w2')[0].status).toBe('failed');
    expect(store.listPlanTasks('w2')[0].error).toContain('另一个作品');
  });
});

/* ==================================================================
   S11 · 使用最新持久化时间
   ================================================================== */
describe('S11 · 修改计划时间后调度器使用最新持久化时间', () => {
  it('把任务改到过去之后会被执行', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.FUTURE });

    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function () { return { ok: true, status: 'done' }; }
    });
    scheduler.scanOnce();
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');   // 未到期

    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    scheduler.scanOnce();
    expect(store.listPlanTasks('w1')[0].status).toBe('done');      // 改到过去后到期
  });

  it('把已经到期的任务改到未来后不再执行', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.FUTURE });

    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function () { return { ok: true, status: 'done' }; }
    });
    scheduler.scanOnce();
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });
});

/* ==================================================================
   S12 · 异常隔离
   ================================================================== */
describe('S12 · 异常不会导致所有任务永久停止', () => {
  it('扫描整体出错时记录错误，后续扫描仍能正常工作', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    let boom = true;
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function () { return { ok: true, status: 'done' }; }
    });
    // 第一次扫描：让 store 抛错
    const orig = store.listDuePlanTasks.bind(store);
    store.listDuePlanTasks = function () { if (boom) throw new Error('数据库读取失败'); return orig(); };

    const first = scheduler.scanOnce();
    expect(first.ok).toBe(false);
    expect(first.error).toContain('数据库读取失败');
    expect(scheduler.status().last_error).toContain('数据库读取失败');

    // 第二次扫描：恢复正常
    boom = false;
    store.listDuePlanTasks = orig;
    const second = scheduler.scanOnce();
    expect(second.ok).toBe(true);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
  });

  it('单个任务出错不影响其它任务', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const t1 = setupWork(store, 'w1', ['github']);
    const t2 = setupWork(store, 'w2', ['youtube']);
    store.updatePlanTask('w1', t1[0].id, { scheduled_at: H.PAST });
    store.updatePlanTask('w2', t2[0].id, { scheduled_at: H.PAST });

    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function (task) {
        if (task.work_id === 'w1') throw new Error('单个任务异常');
        return { ok: true, status: 'done' };
      }
    });
    const out = scheduler.scanOnce();

    expect(out.ok).toBe(true);
    expect(store.listPlanTasks('w1')[0].status).toBe('failed');
    expect(store.listPlanTasks('w2')[0].status).toBe('done');
  });
});

/* ==================================================================
   S13 · 重复执行保护
   ================================================================== */
describe('S13 · 重复领取和重复扫描不会产生重复执行', () => {
  it('同一个任务只能被领取一次', () => {
    const store = newStore();
    setupWork(store, 'w1', ['github']);
    const id = store.listPlanTasks('w1')[0].id;

    const first = store.claimPlanTask(id);
    const second = store.claimPlanTask(id);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('running');
  });

  it('执行过程中再次触发扫描会被跳过（不会并发领取同一批任务）', () => {
    const store = newStore();
    const { createPlanScheduler } = loadScheduler();
    const tasks = setupWork(store, 'w1', ['github']);
    store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });

    let inner = null;
    const scheduler = createPlanScheduler({
      getStore: () => store,
      executor: function () {
        inner = scheduler.scanOnce();      // 执行中再次扫描
        return { ok: true, status: 'done' };
      }
    });
    scheduler.scanOnce();

    expect(inner).toBeTruthy();
    expect(inner.skipped).toBe(true);
    expect(inner.reason).toContain('in progress');
  });

  it('过期结果不会覆盖新状态（run_token 校验）', () => {
    const store = newStore();
    setupWork(store, 'w1', ['github']);
    const id = store.listPlanTasks('w1')[0].id;

    const claim = store.claimPlanTask(id, '2020-01-01T00:00:00.000Z');
    expect(claim.ok).toBe(true);
    // 用过期的 run_token 落库 → 被拒绝
    const stale = store.finishPlanTask(id, '2019-01-01T00:00:00.000Z', { ok: true, status: 'done' });
    expect(stale.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('running');

    // 用正确的 run_token → 落库成功
    const good = store.finishPlanTask(id, claim.run_token, { ok: true, status: 'done' });
    expect(good.ok).toBe(true);
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
  });

  it('任务 ID 由阶段 + 平台派生（不依赖 DAY 序号），重复创建不会产生第二条', () => {
    const store = newStore();
    setupWork(store, 'w1', ['github']);
    const id = store.listPlanTasks('w1')[0].id;
    expect(id).toBe('pt_ps_w1_github');

    store.savePlanStages('w1', [H.stage('ps_w1', { platforms: ['github'] })]);
    expect(store.listPlanTasks('w1')).toHaveLength(1);
    expect(store.listPlanTasks('w1')[0].id).toBe(id);
  });
});

/* ==================================================================
   S14 · SQLite 与 JSON 行为一致
   ================================================================== */
describe('S14 · SQLite 与 JSON 两种存储模式行为一致', () => {
  it('两种模式下的调度结果完全一致', () => {
    function scenario(mode) {
      const store = newStore(mode);
      const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
      const t1 = setupWork(store, 'w1', ['github', 'wechat']);
      const t2 = setupWork(store, 'w2', ['youtube']);
      store.updatePlanTask('w1', t1[0].id, { scheduled_at: H.PAST });
      store.updatePlanTask('w1', t1[1].id, { scheduled_at: H.PAST });
      store.updatePlanTask('w2', t2[0].id, { scheduled_at: H.PAST });

      const scheduler = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() });
      const out = scheduler.scanOnce();

      return {
        claimed: out.claimed.slice().sort(),
        done: out.done.slice().sort(),
        failed: out.failed.slice().sort(),
        tasks: store.listPlanTasks('').map(function (t) {
          return { id: t.id, status: t.status, work: t.work_id, ref: t.platform_ref };
        }).sort(function (a, b) { return a.id < b.id ? -1 : 1; })
      };
    }
    const sq = scenario('sqlite');
    const js = scenario('json');
    expect(js).toEqual(sq);
    expect(sq.tasks.length).toBe(3);
  });

  it('两种模式下的重启恢复结果一致', () => {
    function scenario(mode) {
      const store = newStore(mode);
      const { createPlanScheduler } = loadScheduler();
      const tasks = setupWork(store, 'w1', ['github']);
      store.updatePlanTask('w1', tasks[0].id, { scheduled_at: H.PAST });
      store.claimPlanTask(tasks[0].id);   // 遗留 running

      const store2 = newStore(mode);
      const scheduler = createPlanScheduler({ getStore: () => store2 });
      scheduler.recover();
      const t = store2.listPlanTasks('w1')[0];
      return { status: t.status, note: t.note, url: t.platform_url };
    }
    const sq = scenario('sqlite');
    const js = scenario('json');
    expect(js).toEqual(sq);
    expect(sq.status).toBe('pending');
  });
});

/* ==================================================================
   S15 · 不发生真实平台发布或外部写入
   ================================================================== */
describe('S15 · 第二阶段不发生真实平台发布或外部写入', () => {
  it('调度器不包含任何网络请求', () => {
    expect(SCHEDULER_SRC).not.toMatch(/https?\.(get|post|request)|fetch\s*\(|net\.request|axios/i);
  });

  it('调度器不引用任何真实发布模块', () => {
    expect(SCHEDULER_SRC).not.toMatch(/publishers|youtube-publisher|github-publisher|wechat-draft|createDraft|publishVideo|publishRepo/i);
  });

  it('调度器只依赖 store，不直接碰数据库', () => {
    expect(SCHEDULER_SRC).not.toMatch(/better-sqlite3|node:sqlite|require\(['"]fs['"]\)/);
    expect(SCHEDULER_SRC).toContain('getStore');
  });

  it('模拟执行器永远返回 mock 前缀的平台引用，链接恒为空', () => {
    const { createMockPlanExecutor } = loadScheduler();
    const exec = createMockPlanExecutor();
    ['github', 'wechat', 'youtube'].forEach(function (pid) {
      const r = exec({ id: 'pt_x_' + pid, platform_id: pid, stage_title: '阶段', note: '' });
      expect(r.ok).toBe(true);
      expect(r.platform_ref.indexOf('mock:')).toBe(0);
      expect(r.platform_url).toBe('');
    });
  });

  it('main.js 启动调度器时没有引入任何发布模块', () => {
    const MAIN_SRC = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    const i = MAIN_SRC.indexOf("require('./plan-scheduler')");
    const block = MAIN_SRC.slice(Math.max(0, i - 300), i + 500);
    expect(block).not.toMatch(/publishers|youtube-publisher|createDraft|publishVideo/i);
    expect(block).toContain('createPlanScheduler');
  });
});
