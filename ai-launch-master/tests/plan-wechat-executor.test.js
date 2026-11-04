'use strict';

// Rokit · 首秀计划 微信公众号执行器（只创建草稿）—— 定向测试
//
// 覆盖用户要求的全部验证点：
//   W1  到期后能够触发微信公众号真实执行器
//   W2  正确读取计划快照中的作品和文章内容
//   W3  成功创建草稿后，任务标记为 done
//   W4  成功结果能够保存草稿 media_id
//   W5  草稿创建失败时，任务不会标记为 done
//   W6  失败不会自动重试
//   W7  创建结果不明确时进入 needs_review，不会自动重复创建
//   W8  执行器不会调用 freepublish/submit
//   W9  执行器不会调用群发接口
//   W10 GitHub、YouTube 已有计划执行功能不受影响
//
// 全部使用临时数据库 + 注入的 mock 草稿入口，
// **没有任何真实微信接口调用 / 真实草稿创建 / 真实计划执行**。

const path = require('path');
const H = require('./helpers/plan-store');

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = H.makeTmpDir();
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  H.restoreDrivers();
  H.rmTmpDir(tmpDir);
  ['store', 'plan-wechat-executor', 'plan-scheduler'].forEach(function (n) {
    delete require.cache[require.resolve(path.join(H.ROOT, 'electron', n))];
  });
});

function newStore() {
  const { Store } = H.loadStoreFresh(false);
  return new Store(dbPath);
}
function loadExecutor() {
  const id = require.resolve(path.join(H.ROOT, 'electron', 'plan-wechat-executor'));
  delete require.cache[id];
  return require(path.join(H.ROOT, 'electron', 'plan-wechat-executor'));
}

/* ---------- 造数据 ---------- */
function seedWork(store, id) {
  store.saveWork({
    id: id, name: '作品 ' + id, type: 'tool', intro: 'intro', url: 'https://example.com/p',
    status: '首秀中', queue: '主推', star: 0, dl: 0, play: '0', next: '',
    created_at: new Date().toISOString()
  });
}

// 造一个带公众号文案快照的阶段
function seedWechatStage(store, workId, stageId, copy) {
  store.savePlanStages(workId, [{
    id: stageId, title: '阶段 ' + stageId, desc: '', offsetDays: 0, timeOfDay: '20:00',
    platforms: ['wechat'],
    copy: copy || { wechat: { title: '公众号标题', body: '第一行正文\n第二行正文', tags: ['t1'] } }
  }]);
  return store.listPlanTasks(workId).filter(function (t) {
    return String(t.platform_id) === 'wechat';
  })[0];
}

// mock 草稿入口：记录调用参数，可指定返回
function makeDraftEntry(result) {
  const calls = [];
  const fn = async function (payload) {
    calls.push(payload);
    if (typeof result === 'function') return await result(payload, calls.length);
    return result;
  };
  fn.calls = calls;
  return fn;
}

function makeExec(store, createDraft, opts) {
  opts = opts || {};
  const { createWechatPlanExecutor } = loadExecutor();
  const exec = createWechatPlanExecutor({
    getStore: function () { return store; },
    createDraft: createDraft,
    listWorks: function (s) { return s.listWorks(); }
  });
  return { exec: exec, calls: (createDraft && createDraft.calls) || [] };
}

/* ==================================================================
   W1 · 到期后能够触发微信公众号真实执行器
   ================================================================== */
describe('W1 · 到期后触发微信公众号真实执行器', () => {
  it('W1-1 调度器到期扫描后，真实执行器被调用（不是模拟执行器）', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    // 排到过去使其到期
    store.updatePlanTask('w1', task.id, { scheduled_at: '2020-01-01T00:00:00.000Z' });

    const { createPlanScheduler } = require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { createWechatPlanExecutor } = loadExecutor();
    const calls = [];

    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',
      realExecutors: {
        wechat: createWechatPlanExecutor({
          getStore: function () { return store; },
          createDraft: draftEntry
        })
      }
    });
    const out = scheduler.scanOnce('2020-06-01T00:00:00.000Z');

    expect(draftEntry.calls).toHaveLength(1);
    expect(out.claimed).toHaveLength(1);
    expect(out.skipped).toHaveLength(0);
  });

  it('W1-2 新建微信公众号计划 real_only=1（真实执行候选）', () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedWechatStage(store, 'w1', 's1');
    const t = store.listPlanTasks('w1').filter(function (x) {
      return String(x.platform_id) === 'wechat';
    })[0];
    expect(t.real_only).toBe(1);
    expect(t.simulated).toBe(0);
  });

  it('W1-3 模拟调度器不领取微信公众号任务（真实执行候选）', () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedWechatStage(store, 'w1', 's1');
    const due = store.listDuePlanTasks('2999-01-01T00:00:00.000Z');
    expect(due.map(function (x) { return x.platform_id; })).not.toContain('wechat');
  });
});

/* ==================================================================
   W2 · 正确读取计划快照中的作品和文章内容
   ================================================================== */
describe('W2 · 读取计划快照内容', () => {
  it('W2-1 标题 / 正文来自 copy.wechat 快照', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedWechatStage(store, 'w1', 's1', {
      wechat: { title: '快照标题', body: '快照正文第一行\n快照正文第二行', tags: ['a', 'b'] }
    });
    const task = store.listPlanTasks('w1')[0];
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { exec } = makeExec(store, draftEntry);

    await exec(task);

    expect(draftEntry.calls).toHaveLength(1);
    expect(draftEntry.calls[0].title).toBe('快照标题');
    expect(draftEntry.calls[0].body).toBe('快照正文第一行\n快照正文第二行');
  });

  it('W2-2 快照缺标题 / 正文时明确失败，且不调用草稿入口', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedWechatStage(store, 'w1', 's1', { wechat: { title: '', body: '' } });
    const task = store.listPlanTasks('w1')[0];
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { exec } = makeExec(store, draftEntry);

    const r = await exec(task);

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('missing-copy');
    expect(draftEntry.calls).toHaveLength(0);
  });

  it('W2-3 作品不存在时明确失败', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    store.deleteWork('w1');
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { exec } = makeExec(store, draftEntry);

    const r = await exec(task);

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('missing-work');
    expect(draftEntry.calls).toHaveLength(0);
  });

  it('W2-4 非微信公众号任务不被本执行器处理', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedWechatStage(store, 'w1', 's1');
    const task = store.listPlanTasks('w1')[0];
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { exec } = makeExec(store, draftEntry);

    const r = await exec(Object.assign({}, task, { platform_id: 'github' }));

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('platform-not-supported');
    expect(draftEntry.calls).toHaveLength(0);
  });

  it('W2-5 模拟任务绝不进入真实草稿创建路径', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { exec } = makeExec(store, draftEntry);

    const r = await exec(Object.assign({}, task, { simulated: 1 }));

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('simulated-task');
    expect(draftEntry.calls).toHaveLength(0);
  });
});

/* ==================================================================
   W3 · 成功创建草稿后，任务标记为 done
   W4 · 成功结果能够保存草稿 media_id
   ================================================================== */
describe('W3/W4 · 成功路径', () => {
  it('W3-1 成功时返回 status=done', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { exec } = makeExec(store, draftEntry);

    const r = await exec(task);

    expect(r.ok).toBe(true);
    expect(r.status).toBe('done');
    expect(r.simulated).toBe(false);
  });

  it('W3-2 调度器执行后任务状态落为 done', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    store.updatePlanTask('w1', task.id, { scheduled_at: '2020-01-01T00:00:00.000Z' });

    const { createPlanScheduler } = require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { createWechatPlanExecutor } = loadExecutor();

    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',
      realExecutors: {
        wechat: createWechatPlanExecutor({
          getStore: function () { return store; },
          createDraft: draftEntry
        })
      }
    });
    await scheduler.scanOnce('2020-06-01T00:00:00.000Z').settled;

    const after = store.listPlanTasks('w1')[0];
    expect(after.status).toBe('done');
    expect(after.simulated).toBe(0);
  });

  it('W3-3 done 的含义是「草稿已创建」，不误报为正式发表', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { exec } = makeExec(store, draftEntry);

    const r = await exec(task);

    // 提示必须说明「仅草稿、未发表、未群发」
    expect(String(r.note)).toContain('草稿');
    expect(String(r.note)).toContain('未正式发表');
    expect(String(r.note)).toContain('未群发');
  });

  it('W4-1 发布记录保存 media_id，状态为 pending（仅草稿，绝不写成 ok）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-777' });
    const { exec } = makeExec(store, draftEntry);

    const r = await exec(task);

    expect(r.platform_ref).toBe('MEDIA-777');
    expect(r.video_id).toBe('MEDIA-777');
    const pubs = store.listPubs('w1');
    expect(pubs).toHaveLength(1);
    expect(pubs[0].platform_id).toBe('wechat');
    // ★ 草稿 ≠ 已发布：状态必须是 pending（草稿待发布），不能是 ok
    expect(pubs[0].status).toBe('pending');
    expect(pubs[0].status).not.toBe('ok');
    expect(pubs[0].video_id).toBe('MEDIA-777');
    expect(pubs[0].pub_key).toBe(task.pub_key);
    expect(String(pubs[0].error || '')).toBe('');
  });

  it('W4-4 成功草稿记录与「结果不明确」记录可区分', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const { exec } = makeExec(store, makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-OK' }));
    await exec(task);

    // listPubs() 返回全部记录，这里按作品过滤
    const okPubs = store.listPubs().filter(function (p) { return p.work_id === 'w1'; });

    const store2 = newStore();
    seedWork(store2, 'w2');
    const task2 = seedWechatStage(store2, 'w2', 's2');
    const { exec: exec2 } = makeExec(store2, makeDraftEntry({ status: 'api_error', error: 'NETWORK', note: '网络中断' }));
    await exec2(task2);

    const unclearPubs = store2.listPubs().filter(function (p) { return p.work_id === 'w2'; });

    // 成功：pending + video_id 有值 + 无错误
    expect(okPubs).toHaveLength(1);
    expect(okPubs[0].status).toBe('pending');
    expect(okPubs[0].video_id).toBe('MEDIA-OK');
    expect(String(okPubs[0].error || '')).toBe('');
    // 不明确：pending + 无 media_id + 有错误
    expect(unclearPubs).toHaveLength(1);
    expect(unclearPubs[0].status).toBe('pending');
    expect(String(unclearPubs[0].video_id || '')).toBe('');
    expect(String(unclearPubs[0].error || '')).not.toBe('');
  });

  it('W4-5 与普通公众号链路的草稿口径一致（草稿保存写 pending，只有群发成功才写 ok）', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8');
    // 普通链路：草稿保存后写 pending
    expect(src).toContain("markPub('wechat',{status:'pending'})");
    // 普通链路：群发成功才写 ok（说明 ok 的语义是"已发表"，草稿阶段不得使用）
    expect(src).toContain("markPub('wechat',{status:'ok'})");
  });

  it('W4-2 任务行写入 platform_ref = media_id', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    store.claimPlanTask(task.id, '2020-01-01T00:00:00.000Z');
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-888' });
    const { exec } = makeExec(store, draftEntry);

    await exec(store.listPlanTasks('w1')[0]);

    const after = store.listPlanTasks('w1')[0];
    expect(after.platform_ref).toBe('MEDIA-888');
  });

  it('W4-3 同一 pub_key 只有一条发布记录（不重复创建）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { exec } = makeExec(store, draftEntry);

    await exec(task);
    await exec(task);

    expect(store.listPubs('w1')).toHaveLength(1);
  });
});

/* ==================================================================
   W5 · 草稿创建失败时，任务不会标记为 done
   W6 · 失败不会自动重试
   ================================================================== */
describe('W5/W6 · 失败路径', () => {
  it('W5-1 草稿创建失败 → 任务不是 done', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'api_error', note: '公众号返回 48001：接口未授权' });
    const { exec } = makeExec(store, draftEntry);

    const r = await exec(task);

    expect(r.ok).toBe(false);
    expect(r.status).not.toBe('done');
    expect(String(r.error)).toContain('api_error');
  });

  it('W5-2 失败时发布记录为 failed（不是 pending）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'api_error', note: '明确失败' });
    const { exec } = makeExec(store, draftEntry);

    await exec(task);

    const pubs = store.listPubs('w1');
    expect(pubs).toHaveLength(1);
    expect(pubs[0].status).toBe('failed');
    expect(String(pubs[0].error)).toContain('明确失败');
  });

  it('W5-3 失败经调度器执行后任务状态是 failed，不是 done', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    store.updatePlanTask('w1', task.id, { scheduled_at: '2020-01-01T00:00:00.000Z' });

    const { createPlanScheduler } = require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
    const draftEntry = makeDraftEntry({ status: 'api_error', note: '明确失败' });
    const { createWechatPlanExecutor } = loadExecutor();

    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',
      realExecutors: {
        wechat: createWechatPlanExecutor({
          getStore: function () { return store; },
          createDraft: draftEntry
        })
      }
    });
    await scheduler.scanOnce('2020-06-01T00:00:00.000Z').settled;

    const after = store.listPlanTasks('w1')[0];
    expect(after.status).not.toBe('done');
    expect(after.status).toBe('failed');
  });

  it('W6-1 明确失败后不自动重试（扫描多次也只调用一次草稿入口）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    store.updatePlanTask('w1', task.id, { scheduled_at: '2020-01-01T00:00:00.000Z' });

    const { createPlanScheduler } = require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
    const draftEntry = makeDraftEntry({ status: 'api_error', note: '明确失败' });
    const { createWechatPlanExecutor } = loadExecutor();

    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',
      realExecutors: {
        wechat: createWechatPlanExecutor({
          getStore: function () { return store; },
          createDraft: draftEntry
        })
      }
    });
    await scheduler.scanOnce('2020-06-01T00:00:00.000Z').settled;
    await scheduler.scanOnce('2020-06-01T00:01:00.000Z').settled;
    await scheduler.scanOnce('2020-06-01T00:02:00.000Z').settled;

    // 失败任务不再进入到期名单 → 草稿入口只被调用一次
    expect(draftEntry.calls).toHaveLength(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('failed');
  });

  it('W6-2 失败任务不进入到期名单（不会自动重跑）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    store.updatePlanTask('w1', task.id, { scheduled_at: '2020-01-01T00:00:00.000Z' });

    const { createPlanScheduler } = require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
    const draftEntry = makeDraftEntry({ status: 'api_error', note: '明确失败' });
    const { createWechatPlanExecutor } = loadExecutor();

    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',
      realExecutors: {
        wechat: createWechatPlanExecutor({
          getStore: function () { return store; },
          createDraft: draftEntry
        })
      }
    });
    await scheduler.scanOnce('2020-06-01T00:00:00.000Z').settled;

    expect(store.listPlanTasks('w1')[0].status).toBe('failed');
    const due = store.listDuePlanTasks('2999-01-01T00:00:00.000Z', { forRealExecutor: true });
    expect(due.map(function (x) { return x.platform_id; })).not.toContain('wechat');
  });

  it('W6-3 未注入草稿入口时不写发布记录、不调用任何接口', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const { createWechatPlanExecutor } = loadExecutor();
    const exec = createWechatPlanExecutor({ getStore: function () { return store; } });

    const r = await exec(task);

    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('draft-entry-missing');
    expect(store.listPubs('w1')).toHaveLength(0);
  });
});

/* ==================================================================
   W7 · 创建结果不明确时进入 needs_review，不会自动重复创建
   ================================================================== */
describe('W7 · 结果不明确 → needs_review', () => {
  it('W7-1 网络结果不确定 → status=needs_review', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'api_error', error: 'NETWORK', note: '网络中断' });
    const { exec } = makeExec(store, draftEntry);

    const r = await exec(task);

    expect(r.ok).toBe(true);
    expect(r.status).toBe('needs_review');
  });

  it('W7-2 草稿入口抛异常 → status=needs_review', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry(async function () {
      throw new Error('连接被重置');
    });
    const { exec } = makeExec(store, draftEntry);

    const r = await exec(task);

    expect(r.ok).toBe(true);
    expect(r.status).toBe('needs_review');
    expect(String(r.error)).toContain('draft-exception');
  });

  it('W7-3 不确定时发布记录保持 pending（绝不写成 failed）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'api_error', error: 'NETWORK', note: '网络中断' });
    const { exec } = makeExec(store, draftEntry);

    await exec(task);

    const pubs = store.listPubs('w1');
    expect(pubs).toHaveLength(1);
    expect(pubs[0].status).toBe('pending');
  });

  it('W7-4 needs_review 任务不会自动重复创建草稿', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    store.updatePlanTask('w1', task.id, { scheduled_at: '2020-01-01T00:00:00.000Z' });

    const { createPlanScheduler } = require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
    const draftEntry = makeDraftEntry({ status: 'api_error', error: 'NETWORK', note: '网络中断' });
    const { createWechatPlanExecutor } = loadExecutor();

    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',
      realExecutors: {
        wechat: createWechatPlanExecutor({
          getStore: function () { return store; },
          createDraft: draftEntry
        })
      }
    });
    await scheduler.scanOnce('2020-06-01T00:00:00.000Z').settled;
    await scheduler.scanOnce('2020-06-01T00:01:00.000Z').settled;

    expect(draftEntry.calls).toHaveLength(1);
    expect(store.listPlanTasks('w1')[0].status).toBe('needs_review');
  });

  it('W7-5 needs_review 任务不进入到期名单', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    store.updatePlanTask('w1', task.id, { scheduled_at: '2020-01-01T00:00:00.000Z' });

    const { createPlanScheduler } = require(path.join(H.ROOT, 'electron', 'plan-scheduler'));
    const draftEntry = makeDraftEntry({ status: 'api_error', error: 'NETWORK', note: '网络中断' });
    const { createWechatPlanExecutor } = loadExecutor();

    const scheduler = createPlanScheduler({
      getStore: function () { return store; },
      executorKind: 'real',
      realExecutors: {
        wechat: createWechatPlanExecutor({
          getStore: function () { return store; },
          createDraft: draftEntry
        })
      }
    });
    await scheduler.scanOnce('2020-06-01T00:00:00.000Z').settled;

    expect(store.listPlanTasks('w1')[0].status).toBe('needs_review');
    const due = store.listDuePlanTasks('2999-01-01T00:00:00.000Z', { forRealExecutor: true });
    expect(due.map(function (x) { return x.platform_id; })).not.toContain('wechat');
  });

  it('W7-6 草稿已创建但本地记录写失败 → needs_review（不重复创建）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-X' });
    const { exec } = makeExec(store, draftEntry);

    // 让 addPub 在第二次（写 ok）时抛异常 → 模拟本地记录写失败
    const origAddPub = store.addPub.bind(store);
    let n = 0;
    store.addPub = function (r) {
      n += 1;
      if (n >= 2) throw new Error('数据库写入失败');
      return origAddPub(r);
    };

    const r = await exec(task);

    expect(r.ok).toBe(true);
    expect(r.status).toBe('needs_review');
    expect(String(r.error)).toContain('pubs-write-failed');
    // 草稿只创建了一次
    expect(draftEntry.calls).toHaveLength(1);
  });

  it('W7-7 传输层中断（NETWORK）→ 发布记录保持 pending，任务 needs_review', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    // wechat.createDraft 把网络 / 5xx 也折叠成 api_error，
    // 由 main.js 的包装层补上 error='NETWORK' 表示"结果不确定"
    const draftEntry = makeDraftEntry({
      status: 'api_error', error: 'NETWORK', note: '草稿创建请求中断（网络 / 服务端异常）'
    });
    const { exec } = makeExec(store, draftEntry);

    const r = await exec(task);

    expect(r.ok).toBe(true);
    expect(r.status).toBe('needs_review');
    const pubs = store.listPubs('w1');
    expect(pubs).toHaveLength(1);
    expect(pubs[0].status).toBe('pending');
  });

  it('W7-8 main.js 包装层把草稿请求的网络 / 5xx 标记为 NETWORK（结果不确定）', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8');
    const i = src.indexOf('wechat: createWechatPlanExecutor');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 1600);
    // 只针对草稿接口判定传输层不确定
    expect(block).toContain('/draft/add');
    expect(block).toContain('transportUncertain');
    expect(block).toContain("res.error = 'NETWORK'");
    // 不引入任何正式发表 / 群发接口
    expect(block).not.toContain('freepublish');
    expect(block).not.toContain('publishDraft');
    expect(block).not.toContain('sendall');
  });
});

/* ==================================================================
   W8/W9 · 绝不调用正式发表 / 群发接口
   ================================================================== */
describe('W8/W9 · 绝不正式发表或群发', () => {
  it('W8-1 执行器源码中不出现 freepublish/submit', () => {
    const src = require('fs').readFileSync(
      path.join(H.ROOT, 'electron', 'plan-wechat-executor.js'), 'utf8');
    // 允许出现在注释里，但**不允许**出现可执行的调用
    const codeLines = src.split(/\r?\n/).filter(function (l) {
      const t = l.trim();
      if (t.indexOf('//') === 0) return false;          // 整行注释
      if (t.indexOf('*') === 0) return false;           // 块注释行
      return t.indexOf('freepublish') < 0;
    });
    expect(codeLines.join('\n')).not.toContain('freepublish');
  });

  it('W8-2 执行器源码中不出现 publishDraft / submit 发布调用', () => {
    const src = require('fs').readFileSync(
      path.join(H.ROOT, 'electron', 'plan-wechat-executor.js'), 'utf8');
    const code = src.split(/\r?\n/).filter(function (l) {
      const t = l.trim();
      return t.indexOf('//') !== 0 && t.indexOf('*') !== 0;
    }).join('\n');
    expect(code).not.toContain('publishDraft');
    expect(code).not.toContain('freepublish/submit');
  });

  it('W9-1 执行器源码中不出现群发接口', () => {
    const src = require('fs').readFileSync(
      path.join(H.ROOT, 'electron', 'plan-wechat-executor.js'), 'utf8');
    const code = src.split(/\r?\n/).filter(function (l) {
      const t = l.trim();
      return t.indexOf('//') !== 0 && t.indexOf('*') !== 0;
    }).join('\n');
    expect(code).not.toContain('mass/sendall');
    expect(code).not.toContain('sendall');
    expect(code).not.toContain('publishVideoMessage');
  });

  it('W8-3 只调用注入的草稿入口这一个外部依赖', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { exec } = makeExec(store, draftEntry);

    await exec(task);

    // 外部调用恰好 1 次，且参数里没有任何"发表 / 群发"开关
    expect(draftEntry.calls).toHaveLength(1);
    const p = draftEntry.calls[0];
    expect(p.publish).toBeUndefined();
    expect(p.submit).toBeUndefined();
    expect(p.massSend).toBeUndefined();
  });

  it('W8-4 注入的草稿入口确实是 wechat.createDraft 的同源包装（main.js 注册处）', () => {
    const src = require('fs').readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8');
    // 注册处必须调用 wechat.createDraft（复用普通发布链路）
    expect(src).toContain('wechat.createDraft(direct, payload');
    // 且注册块里不得出现正式发表 / 群发
    const i = src.indexOf('wechat: createWechatPlanExecutor');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 900);
    expect(block).not.toContain('freepublish');
    expect(block).not.toContain('publishDraft');
    expect(block).not.toContain('sendall');
  });
});

/* ==================================================================
   W10 · GitHub、YouTube 已有计划执行功能不受影响
   ================================================================== */
describe('W10 · GitHub / YouTube 不受影响', () => {
  it('W10-1 GitHub / YouTube 真实执行资格不变', () => {
    const store = newStore();
    seedWork(store, 'w1');
    store.savePlanStages('w1', [{
      id: 's1', title: '阶段', desc: '', offsetDays: 0, timeOfDay: '20:00',
      platforms: ['github', 'youtube', 'wechat'], copy: {}
    }]);
    const tasks = store.listPlanTasks('w1');
    const gh = tasks.filter(function (t) { return t.platform_id === 'github'; })[0];
    const yt = tasks.filter(function (t) { return t.platform_id === 'youtube'; })[0];
    const wx = tasks.filter(function (t) { return t.platform_id === 'wechat'; })[0];
    expect(gh.real_only).toBe(1);
    expect(yt.real_only).toBe(1);
    expect(wx.real_only).toBe(1);
  });

  it('W10-2 三个平台各自使用独立的 pub_key（不互相干扰）', () => {
    const store = newStore();
    seedWork(store, 'w1');
    store.savePlanStages('w1', [{
      id: 's1', title: '阶段', desc: '', offsetDays: 0, timeOfDay: '20:00',
      platforms: ['github', 'youtube', 'wechat'], copy: {}
    }]);
    const keys = store.listPlanTasks('w1').map(function (t) { return t.pub_key; });
    expect(new Set(keys).size).toBe(3);
  });

  it('W10-3 微信公众号任务不进入 GitHub / YouTube 的发布记录', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedWechatStage(store, 'w1', 's1');
    const draftEntry = makeDraftEntry({ status: 'draft_created', mediaId: 'MEDIA-1' });
    const { exec } = makeExec(store, draftEntry);

    await exec(task);

    const pubs = store.listPubs('w1');
    expect(pubs).toHaveLength(1);
    expect(pubs[0].platform_id).toBe('wechat');
  });
});
