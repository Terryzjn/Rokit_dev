'use strict';

// Rokit · Phase 3A 最小安全修正：恢复对账 + UI 状态一致性 —— 定向测试
//
// 覆盖本次修正的全部要求：
//   R1 同 pub_key 的 'ok' 发布记录存在、任务为 pending → 恢复后变 done 并回填 Release ID / URL
//   R2 只有 pending 发布记录 → 不得恢复为 done
//   R3 模拟成功记录 / 其他作品记录 / 其他平台记录 → 不得误判为真实成功
//   R4 已取消 / 状态已变 / 并发重新领取 → 恢复不得覆盖新状态
//   R5 成功记录已存在时：恢复与后续扫描都不得再次调用 GitHub 创建 Release 的 POST
//   R6 finishPlanTask() 前崩溃的完整模拟 → 重启恢复后任务状态与发布记录一致
//   R7 调度器徽标文案与实际状态一致（模拟模式 / 常驻真实模式）
//   R8 重新排队提示明确说明「等待真实执行」的前置条件（不再依赖全局开关）
//
// 全部使用临时数据库 + 注入的 mock API，**没有任何真实网络写入**。

const fs = require('fs');
const path = require('path');
const H = require('./helpers/plan-store');

const HTML = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = H.makeTmpDir();
  dbPath = path.join(tmpDir, 'test.db');
});
afterEach(() => {
  H.restoreDrivers();
  H.rmTmpDir(tmpDir);
  const id = require.resolve(path.join(H.ROOT, 'electron', 'store'));
  delete require.cache[id];
});

function newStore(mode) {
  const { Store } = H.loadStoreFresh(mode === 'json');
  return new Store(dbPath);
}
function loadScheduler() {
  const id = require.resolve(path.join(H.ROOT, 'electron', 'plan-scheduler'));
  delete require.cache[id];
  return require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
}
function loadGithubExecutor() {
  const id = require.resolve(path.join(H.ROOT, 'electron', 'plan-github-executor'));
  delete require.cache[id];
  return require(path.join(H.ROOT, 'electron', 'plan-github-executor'));
}
function seedWork(store, id, url) {
  return store.saveWork({
    id: id, name: '作品 ' + id, type: 'tool', intro: 'intro', url: url || '',
    status: '首秀中', queue: '主推', star: 0, dl: 0, play: '0', next: '',
    created_at: new Date().toISOString()
  });
}
function seedStage(store, workId, stageId, platformId) {
  store.savePlanStages(workId, [{
    id: stageId, title: '阶段 ' + stageId, desc: '', offsetDays: 0, timeOfDay: '20:00',
    platforms: [platformId],
    copy: { [platformId]: { title: 'v1.0.0 发布', body: '这是发布说明', tags: ['tool'] } }
  }]);
  return store.listPlanTasks(workId).filter(t => t.platform_id === platformId)[0];
}
/** 模拟：任务已被模拟执行过，并被显式重新排队 → pending + real_only=1 */
function makeWaitingTask(store, workId, taskId) {
  const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
  // 现行规则：阶段里选中 GitHub 的任务默认是真实执行候选（real_only=1），
  // 模拟调度器不会领取它。本用例要求先在模拟执行器上产出一份模拟结果，
  // 因此显式降级为模拟候选（等价于旧版 auto_publish=0 的历史任务）。
  const cur = store.listPlanTasks(workId).filter(t => t.id === taskId)[0];
  store._planWriteTask(Object.assign({}, cur, { real_only: 0 }));
  store.updatePlanTask(workId, taskId, { scheduled_at: H.PAST });
  createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();
  const r = store.requeueSimulatedPlanTask(workId, taskId);
  expect(r.ok).toBe(true);
  return store.listPlanTasks(workId).filter(t => t.id === taskId)[0];
}

/* ==================================================================
   R1 / R2 / R3 / R4 · 对账判定
   ================================================================== */
describe('R1 · 恢复对账：同 pub_key 的已确认成功记录可推进任务', () => {
  it('ok 记录 + pending 任务 → 对账后 done，并回填 Release ID / URL', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    expect(t.status).toBe('pending');

    // 模拟"发布已成功、发布记录已落库、任务行也已写入真实标识，但任务结算前崩溃"
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: 'https://github.com/owner/repo/releases/tag/v0.1.0',
      pub_key: t.pub_key, time: new Date().toISOString()
    });
    store.markPlanTaskReleaseInfo('w1', t.id, {
      platform_ref: '987654', platform_url: 'https://github.com/owner/repo/releases/tag/v0.1.0'
    });

    const res = store.reconcilePlanTasks();
    expect(res.reconciled).toBe(1);

    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.platform_ref).toBe('987654');
    expect(after.platform_url).toBe('https://github.com/owner/repo/releases/tag/v0.1.0');
    expect(after.real_only).toBe(0);
    expect(after.note).toContain('恢复对账');
    expect(after.finished_at).toBeTruthy();
  });

  it('任务行没有平台 ID 时：仍然 done，并只回填发布记录里的链接（不臆造 ID）', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: 'https://github.com/owner/repo/releases/tag/v0.1.0', pub_key: t.pub_key
    });

    store.reconcilePlanTasks();
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.platform_url).toBe('https://github.com/owner/repo/releases/tag/v0.1.0');
    expect(after.platform_ref).toBe('');                    // 没有就保持空，绝不编造
    expect(after.note).toContain('本地未记录平台返回 ID');
  });

  it('JSON fallback 模式行为一致', () => {
    const store = newStore('json');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: 'https://github.com/owner/repo/releases/tag/v0.1.0', pub_key: t.pub_key
    });
    store.markPlanTaskReleaseInfo('w1', t.id, { platform_ref: '42', platform_url: 'https://x/1' });

    expect(store.reconcilePlanTasks().reconciled).toBe(1);
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.platform_ref).toBe('42');
    // 链接以发布记录为准（发布记录是权威来源）
    expect(after.platform_url).toBe('https://github.com/owner/repo/releases/tag/v0.1.0');
  });
});

describe('R2 · 只有 pending 发布记录时不得恢复为 done', () => {
  it('pubs 状态为 pending → 任务保持 pending', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'pending',
      url: '', pub_key: t.pub_key
    });

    expect(store.reconcilePlanTasks().reconciled).toBe(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });

  it('pubs 状态为 failed → 任务保持 pending', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'failed',
      error: 'boom', pub_key: t.pub_key
    });

    expect(store.reconcilePlanTasks().reconciled).toBe(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });
});

describe('R3 · 不得把别的记录误判成当前任务的真实成功', () => {
  it('其他作品的 ok 记录（pub_key 相同也不认）→ 不推进', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    seedWork(store, 'w2', 'https://github.com/owner/repo2');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    // 故意用同一 pub_key，但 work_id 不同
    store.addPub({
      work_id: 'w2', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: 'https://github.com/owner/repo2/releases/tag/v0.1.0', pub_key: t.pub_key
    });

    expect(store.reconcilePlanTasks().reconciled).toBe(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });

  it('其他平台的 ok 记录 → 不推进', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    store.addPub({
      work_id: 'w1', platform: 'YouTube', platform_id: 'youtube', status: 'ok',
      url: 'https://youtu.be/xxx', pub_key: t.pub_key
    });

    expect(store.reconcilePlanTasks().reconciled).toBe(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });

  it('模拟任务（simulated=1）即便有 ok 记录也不升级为真实成功', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    // 选中 GitHub 的任务默认 real_only=1（模拟调度器不领取），先降级为模拟候选
    store._planWriteTask(Object.assign({}, task, { real_only: 0 }));
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();
    const t = store.listPlanTasks('w1')[0];
    expect(t.simulated).toBe(1);
    // 人为把它改成 pending（模拟任务仍是 simulated=1）
    store._planWriteTask(Object.assign({}, t, { status: 'pending' }));
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: 'https://github.com/owner/repo/releases/tag/v0.1.0', pub_key: t.pub_key
    });

    expect(store.reconcilePlanTasks().reconciled).toBe(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });

  it('needs_review / failed / cancelled 的任务不会被对账改动', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: 'https://github.com/owner/repo/releases/tag/v0.1.0', pub_key: t.pub_key
    });
    store._planWriteTask(Object.assign({}, store.listPlanTasks('w1')[0], { status: 'needs_review' }));
    expect(store.reconcilePlanTasks().reconciled).toBe(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('needs_review');

    store._planWriteTask(Object.assign({}, store.listPlanTasks('w1')[0], { status: 'cancelled' }));
    expect(store.reconcilePlanTasks().reconciled).toBe(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('cancelled');
  });
});

describe('R4 · 恢复不得覆盖已改变的状态', () => {
  it('任务已被取消 → 不推进为 done', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: 'https://github.com/owner/repo/releases/tag/v0.1.0', pub_key: t.pub_key
    });
    store.cancelPlanTask('w1', t.id);

    expect(store.reconcilePlanTasks().reconciled).toBe(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('cancelled');
  });

  it('任务已被重新领取（running）→ 不推进为 done', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: 'https://github.com/owner/repo/releases/tag/v0.1.0', pub_key: t.pub_key
    });
    store.claimPlanTask(t.id);

    expect(store.reconcilePlanTasks().reconciled).toBe(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('running');
  });

  it('markPlanTaskReleaseInfo 不会写入已取消 / 已完成的任务', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    store.cancelPlanTask('w1', t.id);
    const res = store.markPlanTaskReleaseInfo('w1', t.id, { platform_ref: 'x', platform_url: 'u' });
    expect(res.ok).toBe(false);
    const after = store.listPlanTasks('w1')[0];
    expect(after.platform_ref).toBe('');
    expect(after.status).toBe('cancelled');
  });

  it('markPlanTaskReleaseInfo 不会覆盖其它作品的任务', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    seedWork(store, 'w2', 'https://github.com/owner/repo2');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);
    const res = store.markPlanTaskReleaseInfo('w2', t.id, { platform_ref: 'x', platform_url: 'u' });
    expect(res.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].platform_ref).toBe('');
  });
});

/* ==================================================================
   R5 / R6 · 崩溃窗口：不重复 POST + 恢复后一致
   ================================================================== */
describe('R5 / R6 · 结算前崩溃：恢复后不重复写入文章，且状态与发布记录一致', () => {
  function makeGithubExec(store, over) {
    over = over || {};
    const calls = { get: [], put: [] };
    const exec = loadGithubExecutor().createGithubPlanExecutor({
      getStore: () => store,
      getToken: over.getToken || (async () => ({ access_token: 'test-token', publishRepo: { owner: 'owner', repo: 'repo' } })),
      getFile: over.getFile || (async function (token, opts) {
        calls.get.push({ token: token, opts: opts });
        return { ok: true, exists: false };
      }),
      // 普通自动发布的文章提交入口（github:put-file）替身
      publishFile: async function (opts) {
        if (over.putFile) return over.putFile('test-token', opts);
        calls.put.push({ token: 'test-token', opts: opts });
        return {
          ok: true,
          action: 'created',
          content: {
            path: opts.path,
            sha: 'sha-1',
            html_url: 'https://github.com/' + opts.owner + '/' + opts.repo + '/blob/' + (opts.branch || 'main') + '/' + opts.path,
            size: String(opts.content || '').length
          }
        };
      },
      // 普通自动发布的视频上传入口（github:put-video）替身（本文件用例不含视频）
      publishVideo: over.publishVideo || (async function (payload) {
        return { ok: true, videoPath: payload.videoPath, coverPath: payload.coverPath };
      }),
      listWorks: function (st) { return st.listWorks(); }
    });
    return { exec: exec, calls: calls };
  }

  it('模拟"结算前崩溃"：重启恢复后任务变 done，发布记录与任务一致，且不再写入', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store);
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({
      getStore: () => store, executorKind: 'real', realExecutors: { github: exec }
    });
    const out = scheduler.scanOnce();
    await out.settled;
    expect(calls.put).toHaveLength(1);

    // 模拟崩溃：把任务行回退成"领取后未结算"的状态（发布记录与真实标识仍在）
    const cur = store.listPlanTasks('w1')[0];
    expect(cur.status).toBe('done');
    store._planWriteTask(Object.assign({}, cur, { status: 'running', finished_at: '' }));

    // 重启：恢复 → 对账
    const { createPlanScheduler: cs2 } = loadScheduler();
    const scheduler2 = cs2({
      getStore: () => store, executorKind: 'real', realExecutors: { github: makeGithubExec(store).exec }
    });
    const rec = scheduler2.recover();
    expect(rec.reconciled).toBe(1);

    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.platform_ref).toMatch(/^posts\/w1-\d{8}-psa\.md$/);
    expect(after.platform_url).toContain('/blob/main/posts/w1-');
    // 发布记录与任务一致
    const pubs = store.listPubs().filter(p => p.pub_key === t.pub_key);
    expect(pubs).toHaveLength(1);
    expect(pubs[0].status).toBe('ok');
    expect(pubs[0].url).toBe(after.platform_url);
  });

  it('恢复与后续扫描都不会再次写入同一篇文章', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store);
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({
      getStore: () => store, executorKind: 'real', realExecutors: { github: exec }
    });
    await scheduler.scanOnce().settled;
    expect(calls.put).toHaveLength(1);

    // 模拟结算前崩溃 → 重启恢复
    const cur = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, cur, { status: 'running', finished_at: '' }));

    const { exec: exec2, calls: calls2 } = makeGithubExec(store);
    const { createPlanScheduler: cs2 } = loadScheduler();
    const scheduler2 = cs2({
      getStore: () => store, executorKind: 'real', realExecutors: { github: exec2 }
    });
    scheduler2.recover();
    await scheduler2.scanOnce().settled;

    expect(calls2.put).toHaveLength(0);           // 没有再次写入
    expect(calls2.get).toHaveLength(0);           // 任务已被对账为 done，根本不再进入调度
    expect(store.listPlanTasks('w1')[0].status).toBe('done');
    // 发布记录没有被重复写入
    expect(store.listPubs().filter(p => p.pub_key === t.pub_key)).toHaveLength(1);
  });

  it('发布记录已存在但任务行没有标识时：恢复后回填链接，且不再写入', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = makeWaitingTask(store, 'w1', task.id);

    // 直接构造"记录已落库、任务行没有任何标识"的崩溃现场
    const url = 'https://github.com/owner/repo/blob/main/posts/w1-20200101-psa.md';
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: url, pub_key: t.pub_key
    });

    const { exec, calls } = makeGithubExec(store, {
      // 真实环境里文件已存在（create-only 预检会看到）
      getFile: async function () {
        return { ok: true, exists: true, file: { path: 'posts/w1-20200101-psa.md', sha: 'abc', html_url: url } };
      }
    });
    const { createPlanScheduler } = loadScheduler();
    const scheduler = createPlanScheduler({
      getStore: () => store, executorKind: 'real', realExecutors: { github: exec }
    });
    scheduler.recover();
    await scheduler.scanOnce().settled;

    expect(calls.put).toHaveLength(0);            // 没有重复写入
    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.platform_url).toBe(url);
  });
});

/* ==================================================================
   R7 / R8 · UI 文案与实际模式一致
   ================================================================== */
describe('R7 / R8 · 计划中心文案与实际状态一致', () => {
  function extractBlock(src, header) {
    const i = src.indexOf(header);
    if (i < 0) throw new Error('block not found: ' + header);
    let depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; if (started && depth === 0) { j++; break; } }
    }
    return src.slice(i, j);
  }

  function makeBadgeSandbox() {
    const body = extractBlock(HTML, 'function paintPlanSchedulerBadge(){');
    const src = new Function(
      'state', 'window', 'document', 'planTaskTimeText', 'esc',
      body + '\nreturn paintPlanSchedulerBadge;'
    );
    const els = {};
    const document = {
      getElementById: function (id) {
        if (!els[id]) els[id] = { textContent: '', innerHTML: '' };
        return els[id];
      }
    };
    const esc = function (s) { return String(s == null ? '' : s); };
    const win = { api: { planSchedulerStatus: function () { return Promise.resolve(statusPayload); } } };
    let statusPayload = {};
    const fn = src({}, win, document, function (t) { return t.scheduled_at || ''; }, esc);
    return {
      // 徽标是异步渲染的（Promise.then），这里等一拍再读 DOM
      render: async function (payload) {
        statusPayload = payload;
        fn();
        await new Promise(function (r) { setTimeout(r, 0); });
        return { title: els.planCenterSchedTitle.textContent, sub: els.planCenterSchedSub.innerHTML };
      }
    };
  }

  it('模拟模式：明确说明不会真实发布', async () => {
    const box = makeBadgeSandbox();
    const r = await box.render({ available: true, running: true, mode: 'mock', executor_kind: 'mock', interval_ms: 30000, real_platforms: ['github'] });
    expect(r.title).toContain('模拟调度器');
    expect(r.sub).toContain('本地模拟执行');
    expect(r.sub).toContain('不会真的向 GitHub');
  });

  it('真实模式：明确说明处于真实发布模式、已接入平台与执行资格', async () => {
    const box = makeBadgeSandbox();
    const r = await box.render({ available: true, running: true, mode: 'real', executor_kind: 'real', interval_ms: 30000, real_platforms: ['github'] });
    expect(r.title).toContain('真实发布调度器');
    expect(r.sub).toContain('当前处于真实发布模式');
    expect(r.sub).toContain('github');
    expect(r.sub).toContain('posts/');
    expect(r.sub).not.toContain('不会真的向 GitHub');
  });

  it('重新排队提示包含：不会立即发布 / 等待真实执行 / 幂等检查 / 未接入平台说明', () => {
    const detail = extractBlock(HTML, 'window.planDetailRequeue=function(');
    expect(detail).toContain('不会立即发布');
    expect(detail).toContain('等待真实执行');
    expect(detail).toContain('发布前幂等检查');
    expect(detail).toContain('YouTube');
    expect(detail).not.toContain('第三阶段');
    // 总开关已移除：提示里不应再要求用户去开启「真实发布」开关
    expect(detail).not.toContain('开启');
  });
});
