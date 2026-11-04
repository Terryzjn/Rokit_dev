// Rokit · YouTube 首秀计划「待核实」任务人工处理 —— 定向测试
//
// 覆盖用户要求的全部验证点：
//   R1  needs_review 任务可以进入「确认已发布」流程
//   R2  Video ID 或链接无效时拒绝提交
//   R3  确认已发布后，任务状态和发布记录正确
//   R4  已有发布记录时不会重复创建
//   R5  needs_review 任务可以进入「确认未发布，允许重试」流程
//   R6  重试授权只重新排队，不直接上传
//   R7  非 needs_review 任务不能执行这两种操作
//   R8  连续点击 / 重复提交不会重复处理
//   R9  数据写入失败时保留 needs_review
//   R10 普通 YouTube 发布与第一批执行器不受影响
//
// 全部使用临时数据库 + 注入的 mock 上传入口：
//   **没有任何真实 YouTube API 调用 / 真实 OAuth 授权 / 真实视频上传 / 真实计划执行**。

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
  const id = require.resolve(path.join(H.ROOT, 'electron', 'store'));
  delete require.cache[id];
});

function newStore() {
  const { Store } = H.loadStoreFresh(false);
  return new Store(dbPath);
}
function loadPlanIpc() {
  const id = require.resolve(path.join(H.ROOT, 'electron', 'plan-ipc'));
  delete require.cache[id];
  return require(path.join(H.ROOT, 'electron', 'plan-ipc'));
}

/** 造一条 YouTube 计划任务，并把它置为 needs_review（模拟上传结果不确定） */
function seedNeedsReviewTask(store, opts) {
  opts = opts || {};
  const workId = opts.workId || 'w1';
  const stageId = opts.stageId || 's1';
  H.seedWork(store, workId, '作品 ' + workId);
  store.savePlanStages(workId, [{
    id: stageId, title: '阶段 ' + stageId, desc: '', offsetDays: 0, timeOfDay: '20:00',
    platforms: ['youtube'],
    copy: { youtube: { title: 'v1 发布', body: '说明', tags: ['t'] } }
  }]);
  let task = store.listPlanTasks(workId).filter(t => t.platform_id === 'youtube')[0];
  // 置为 needs_review：真实上传结果不确定
  store._planWriteTask(Object.assign({}, task, {
    status: 'needs_review',
    real_only: 1,
    error: 'upload-exception（socket hang up）',
    note: '上传过程中抛出未预期异常',
    finished_at: new Date().toISOString()
  }));
  // 造一条"结果不确定"的发布记录（pending），与真实执行器行为一致
  store.addPub({
    work_id: workId, platform: 'YouTube', platform_id: 'youtube',
    status: 'pending', title: 'v1 发布', body: '说明', tags: 't',
    time: '', url: '', error: 'upload-exception（socket hang up）', video_id: '',
    pub_key: task.pub_key
  });
  return store.listPlanTasks(workId).filter(t => t.platform_id === 'youtube')[0];
}

function taskOf(store, workId) {
  return store.listPlanTasks(workId).filter(t => t.platform_id === 'youtube')[0];
}
function pubsOf(store) {
  return store.listPubs ? store.listPubs() : [];
}
function youtubePubs(store) {
  return pubsOf(store).filter(p => p && p.platform_id === 'youtube');
}

/** 假 ipcMain：捕获注册的 handler */
function fakeIpc() {
  const handlers = {};
  return {
    handlers,
    handle: function (ch, fn) { handlers[ch] = fn; }
  };
}

describe('YouTube needs_review 人工处理 · store 层', () => {
  it('R1 needs_review 任务可以进入「确认已发布」流程', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);
    expect(task.status).toBe('needs_review');

    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });

    expect(res.ok).toBe(true);
    expect(res.task.status).toBe('done');
  });

  it('R3 确认已发布后，任务状态和发布记录正确', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });

    const after = taskOf(store, 'w1');
    expect(after.status).toBe('done');
    expect(after.platform_ref).toBe('dQw4w9WgXcQ');
    expect(after.platform_url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(after.real_only).toBe(0);
    expect(after.error).toBe('');
    expect(after.finished_at).toBeTruthy();

    // 发布记录：同一条 pending → ok（不新增），带 video_id 与 url
    const recs = youtubePubs(store);
    expect(recs.length).toBe(1);
    expect(recs[0].status).toBe('ok');
    expect(recs[0].video_id).toBe('dQw4w9WgXcQ');
    expect(recs[0].url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    // 旧错误被清空（确认已发布后不应残留失败原因）
    expect(recs[0].error).toBe('');
    // 标题等既有内容保留（不被空串覆盖）
    expect(recs[0].title).toBe('v1 发布');
  });

  it('R4 已有发布记录时不会重复创建（连续确认两次也不会多出记录）', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);
    expect(youtubePubs(store).length).toBe(1);

    store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });

    // 再次调用（状态已不是 needs_review → 拒绝），且记录数不变
    const again = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    expect(again.ok).toBe(false);
    expect(youtubePubs(store).length).toBe(1);
  });

  it('R4b 没有既有记录时按 pub_key 新建一条（pub_key 不变，幂等可复用）', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);
    // 删掉既有 pending 记录，模拟"记录缺失"
    store.deletePubs({ pub_key: task.pub_key });
    expect(youtubePubs(store).length).toBe(0);

    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });

    expect(res.ok).toBe(true);
    const recs = youtubePubs(store);
    expect(recs.length).toBe(1);
    expect(recs[0].pub_key).toBe(task.pub_key);
    expect(recs[0].status).toBe('ok');
  });

  it('R5 needs_review 任务可以进入「确认未发布，允许重试」流程', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const res = store.requeueNeedsReviewRetry('w1', task.id, {});

    expect(res.ok).toBe(true);
    const after = taskOf(store, 'w1');
    expect(after.status).toBe('pending');
    expect(after.real_only).toBe(1);
    // 本次不确定上传的临时执行状态已清除
    expect(after.platform_ref).toBe('');
    expect(after.platform_url).toBe('');
    expect(after.error).toBe('');
    expect(after.finished_at).toBe('');
    expect(after.started_at).toBe('');
    // 原状态归档进 history_note（不丢历史）
    expect(after.history_note).toContain('原待核实结果');
    // 计划时间不变（仍由计划时间决定何时执行）
    expect(after.scheduled_at).toBe(task.scheduled_at);
  });

  it('R6 重试授权只重新排队，不直接上传（幂等闸门放行，但没人被调用）', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    store.requeueNeedsReviewRetry('w1', task.id, {});

    // 幂等闸门现在放行（此前 pending 记录被改为 failed → 可确认"没有成功发布"）
    const guard = store.checkPlanPublishGuard('w1', task.id);
    expect(guard.decision).toBe('allow');

    // 但任务只是 pending —— 没有任何执行器被调用（本方法不碰上传）
    const after = taskOf(store, 'w1');
    expect(after.status).toBe('pending');
    expect(after.platform_ref).toBe('');
    // 发布记录被改为 failed（同一条，不新增）
    const recs = youtubePubs(store);
    expect(recs.length).toBe(1);
    expect(recs[0].status).toBe('failed');
  });

  it('R6b 重新排队后调度器可正常领取（走既有闸门，不绕过调度器）', async () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);
    // 让它到期
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });

    store.requeueNeedsReviewRetry('w1', task.id, {});

    const schedId = require.resolve(path.join(H.ROOT, 'electron', 'plan-scheduler'));
    delete require.cache[schedId];
    const { createPlanScheduler } = require(schedId);
    let uploadCalls = 0;
    const sch = createPlanScheduler({
      getStore: () => store,
      executorKind: 'real',
      realExecutors: {
        youtube: async function () { uploadCalls++; return { ok: false, error: 'stub' }; }
      },
      logger: { info() {}, warn() {}, error() {} }
    });
    const out = await sch.scanOnce().settled;

    // 调度器正常领取并交给真实执行器（说明"重新排队"确实接入了调度链路）
    expect(out.claimed.filter(id => id === task.id).length).toBe(1);
    expect(uploadCalls).toBe(1);
  });

  it('R7 非 needs_review 任务不能执行这两种操作', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);
    // 改成 pending
    store._planWriteTask(Object.assign({}, taskOf(store, 'w1'), { status: 'pending' }));

    const a = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    const b = store.requeueNeedsReviewRetry('w1', task.id, {});
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(taskOf(store, 'w1').status).toBe('pending');
  });

  it('R7b 非 YouTube 平台的任务不能走这个人工处理入口', () => {
    const store = newStore();
    H.seedWork(store, 'w1', '作品');
    store.savePlanStages('w1', [{
      id: 's1', title: '阶段', desc: '', offsetDays: 0, timeOfDay: '20:00',
      platforms: ['github'], copy: {}
    }]);
    const t = store.listPlanTasks('w1')[0];
    store._planWriteTask(Object.assign({}, t, { status: 'needs_review' }));

    const a = store.confirmNeedsReviewPublished('w1', t.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    expect(a.ok).toBe(false);
    expect(store.listPlanTasks('w1')[0].status).toBe('needs_review');
  });

  it('R8 连续点击 / 重复提交不会重复处理', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const r1 = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    const r2 = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);           // 第二次被拒（状态已改变）
    expect(youtubePubs(store).length).toBe(1);   // 没有多出第二条发布记录
    expect(taskOf(store, 'w1').status).toBe('done');
  });

  it('R8b 重新排队同样只能成功一次', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const r1 = store.requeueNeedsReviewRetry('w1', task.id, {});
    const r2 = store.requeueNeedsReviewRetry('w1', task.id, {});

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(youtubePubs(store).length).toBe(1);
  });

  it('R9 数据写入失败时保留 needs_review（发布记录写失败）', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    // 让发布记录写入失败（存储层故障）
    const orig = store._planPubUpsert.bind(store);
    store._planPubUpsert = function () { throw new Error('disk full'); };

    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });

    store._planPubUpsert = orig;
    expect(res.ok).toBe(false);
    expect(res.error).toBe('pubs-write-failed');
    // 状态保留原样（绝不半途改成 done）
    expect(taskOf(store, 'w1').status).toBe('needs_review');
    expect(taskOf(store, 'w1').platform_ref).toBe('');
  });

  it('R9d 发布记录写入返回失败结果时同样保留 needs_review', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const orig = store._planPubUpsert.bind(store);
    store._planPubUpsert = function () { return { ok: false, error: 'write-failed' }; };

    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });

    store._planPubUpsert = orig;
    expect(res.ok).toBe(false);
    expect(res.error).toBe('pubs-write-failed');
    expect(taskOf(store, 'w1').status).toBe('needs_review');
  });

  it('R9b 缺少视频 ID 或链接时拒绝提交，状态不变', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const noId = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: '', platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    const noUrl = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ', platform_url: ''
    });

    expect(noId.ok).toBe(false);
    expect(noUrl.ok).toBe(false);
    expect(taskOf(store, 'w1').status).toBe('needs_review');
    expect(youtubePubs(store)[0].status).toBe('pending');   // 未被改动
  });

  it('R9c 跨作品 / 跨阶段归属校验不通过时拒绝', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const wrongStage = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      stage_id: 'other-stage'
    });
    expect(wrongStage.ok).toBe(false);

    const wrongWork = store.confirmNeedsReviewPublished('other-work', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    expect(wrongWork.ok).toBe(false);
    expect(taskOf(store, 'w1').status).toBe('needs_review');
  });
});

describe('YouTube needs_review 人工处理 · JSON 兜底存储分支', () => {
  it('R3j JSON 兜底模式下同样正确处理（SQLite 之外的另一条生产分支）', () => {
    const { Store } = H.loadStoreFresh(true);   // 两个驱动都屏蔽 → JSON 兜底
    const store = new Store(path.join(tmpDir, 'json-fallback.json'));
    const task = seedNeedsReviewTask(store);

    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });

    expect(res.ok).toBe(true);
    const after = taskOf(store, 'w1');
    expect(after.status).toBe('done');
    expect(after.platform_ref).toBe('dQw4w9WgXcQ');
    expect(after.real_only).toBe(0);
    const recs = youtubePubs(store);
    expect(recs.length).toBe(1);
    expect(recs[0].status).toBe('ok');
    expect(recs[0].video_id).toBe('dQw4w9WgXcQ');
  });

  it('R5j JSON 兜底模式下重新排队同样正确', () => {
    const { Store } = H.loadStoreFresh(true);
    const store = new Store(path.join(tmpDir, 'json-fallback2.json'));
    const task = seedNeedsReviewTask(store);

    const res = store.requeueNeedsReviewRetry('w1', task.id, {});

    expect(res.ok).toBe(true);
    const after = taskOf(store, 'w1');
    expect(after.status).toBe('pending');
    expect(after.real_only).toBe(1);
    expect(after.platform_ref).toBe('');
    expect(after.history_note).toContain('原待核实结果');
  });
});

describe('YouTube needs_review 人工处理 · IPC 层', () => {
  it('IPC：未二次确认时拒绝（两条通道）', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);
    const ipc = fakeIpc();
    loadPlanIpc().registerPlanIpc(ipc, { getStore: () => store });

    const a = ipc.handlers['plan:confirm-published'](null, 'w1', task.id, {});
    const b = ipc.handlers['plan:confirm-retry'](null, 'w1', task.id, {});
    expect(a.ok).toBe(false);
    expect(a.error).toBe('confirmation-required');
    expect(b.ok).toBe(false);
    expect(b.error).toBe('confirmation-required');
    expect(taskOf(store, 'w1').status).toBe('needs_review');
  });

  it('IPC：确认已发布通道正常工作', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);
    const ipc = fakeIpc();
    loadPlanIpc().registerPlanIpc(ipc, { getStore: () => store });

    const res = ipc.handlers['plan:confirm-published'](null, 'w1', task.id, {
      confirmed: true,
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      stage_id: task.stage_id
    });

    expect(res.ok).toBe(true);
    expect(taskOf(store, 'w1').status).toBe('done');
    expect(youtubePubs(store).length).toBe(1);
    expect(youtubePubs(store)[0].status).toBe('ok');
  });

  it('IPC：确认未发布通道正常工作（只重新排队）', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);
    const ipc = fakeIpc();
    loadPlanIpc().registerPlanIpc(ipc, { getStore: () => store });

    const res = ipc.handlers['plan:confirm-retry'](null, 'w1', task.id, {
      confirmed: true,
      stage_id: task.stage_id,
      platform_id: 'youtube'
    });

    expect(res.ok).toBe(true);
    const after = taskOf(store, 'w1');
    expect(after.status).toBe('pending');
    expect(after.real_only).toBe(1);
    expect(after.platform_ref).toBe('');
    // 不会直接上传
    expect(after.platform_url).toBe('');
  });
});

describe('YouTube needs_review 人工处理 · 渲染层校验规则', () => {
  it('R2 Video ID 格式无效时拒绝（11 位 [A-Za-z0-9_-]）', () => {
    const src = require('fs').readFileSync(path.join(H.ROOT, 'index.html'), 'utf8');
    expect(src).toContain("var YT_ID_RE=/^[A-Za-z0-9_-]{11}$/;");
    // 校验分支存在：ID 格式不合法 → 提示并 return（不提交）
    expect(src).toContain('请填写有效的 YouTube 视频 ID');
    // 链接里的 ID 与填写的不一致 → 拒绝
    expect(src).toContain('与填写的视频 ID');
    // 无法从链接解析出 ID → 拒绝
    expect(src).toContain('无法从链接中解析出 YouTube 视频 ID');
  });

  it('R2b 两个按钮只在 YouTube + needs_review 时出现', () => {
    const src = require('fs').readFileSync(path.join(H.ROOT, 'index.html'), 'utf8');
    expect(src).toContain("var canReview=(t.platform_id==='youtube'&&t.status==='needs_review');");
    expect(src).toContain('确认已发布');
    expect(src).toContain('确认未发布，允许重试');
    // 确认未发布的警告文案
    expect(src).toContain('只有在确认 YouTube 上不存在本次上传的视频时，才允许重新执行');
    expect(src).toContain('若原视频实际已经上传，重新执行可能产生重复公开视频');
  });
});

// ============================================================================
// 双表写入原子性（plan_tasks + pubs）
//
// 验收要求：两张表必须「同成同败」。
//   绝不留下：
//     - pubs.status='ok' + plan_tasks.status='needs_review'（操作 A 半成功）
//     - plan_tasks.status='pending' + pubs.status='pending'（操作 B 危险组合 →
//       幂等闸门既无 ok 也无 failed 记录 → 返回 allow 放行重传）
//
// 全部断言**数据库最终状态**，不只看函数返回值。
// 不调用真实 YouTube API / 不执行真实上传 / 不真实执行计划任务。
// ============================================================================
describe('双表原子性 · 操作 A（确认已发布）', () => {
  /** 拦截 store.run：只对匹配 sqlPrefix 的语句返回 changes=0，其余原样执行 */
  function breakTaskUpdate(store, sqlPrefix) {
    const orig = store.run.bind(store);
    store.run = function (sql, args) {
      if (typeof sql === 'string' && sql.indexOf(sqlPrefix) === 0) {
        return { changes: 0, lastInsertRowid: 0 };
      }
      return orig(sql, args);
    };
    return function restore() { store.run = orig; };
  }

  it('A2 发布记录写成功但任务更新 changes=0 → 两张表都恢复原状', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    // 让任务的条件更新命中 0 行（模拟状态被其它操作抢先改掉）
    const restore = breakTaskUpdate(store, "UPDATE plan_tasks SET status='done'");
    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    restore();

    expect(res.ok).toBe(false);
    expect(res.error).toBe('task status changed');

    // ★ 关键断言：发布记录必须回到 pending（不能停在 ok）
    const recs = youtubePubs(store);
    expect(recs.length).toBe(1);
    expect(recs[0].status).toBe('pending');
    expect(recs[0].video_id).toBe('');
    expect(recs[0].url).toBe('');

    // 任务也必须保持 needs_review
    const after = taskOf(store, 'w1');
    expect(after.status).toBe('needs_review');
    expect(after.platform_ref).toBe('');
    expect(after.platform_url).toBe('');
  });

  it('A3 任务更新抛异常 → 两张表都恢复原状', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    // 让任务更新直接抛错（模拟存储层故障）
    const orig = store.run.bind(store);
    store.run = function (sql, args) {
      if (typeof sql === 'string' && sql.indexOf("UPDATE plan_tasks SET status='done'") === 0) {
        throw new Error('disk full');
      }
      return orig(sql, args);
    };
    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    store.run = orig;

    expect(res.ok).toBe(false);
    // ★ 发布记录回到 pending（事务已回滚第 1 步的写入）
    const recs = youtubePubs(store);
    expect(recs.length).toBe(1);
    expect(recs[0].status).toBe('pending');
    expect(recs[0].video_id).toBe('');
    const after = taskOf(store, 'w1');
    expect(after.status).toBe('needs_review');
  });

  it('A4 事务 COMMIT 失败 → 不得返回成功，且两张表都未提交', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    // 让 COMMIT 抛错（模拟提交阶段故障）
    const origExec = store.exec.bind(store);
    store.exec = function (sql) {
      if (typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT') {
        throw new Error('commit failed');
      }
      return origExec(sql);
    };
    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    store.exec = origExec;

    // ★ COMMIT 失败绝不返回成功
    expect(res.ok).toBe(false);
    expect(res.error).toBe('TX_COMMIT_FAILED');
    expect(String(res.detail || '')).toContain('commit failed');

    // ★ 两张表都未提交（发布记录回到 pending，任务仍是 needs_review）
    const recs = youtubePubs(store);
    expect(recs.length).toBe(1);
    expect(recs[0].status).toBe('pending');
    expect(taskOf(store, 'w1').status).toBe('needs_review');
  });

  it('A5 BEGIN 失败 → 抛错，绝不降级为无事务执行', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const origExec = store.exec.bind(store);
    store.exec = function (sql) {
      if (typeof sql === 'string' && sql.trim().toUpperCase() === 'BEGIN') {
        throw new Error('cannot begin');
      }
      return origExec(sql);
    };
    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    store.exec = origExec;

    expect(res.ok).toBe(false);
    expect(res.error).toBe('TX_BEGIN_FAILED');
    // 两张表都没动
    expect(youtubePubs(store)[0].status).toBe('pending');
    expect(taskOf(store, 'w1').status).toBe('needs_review');
  });

  it('A6 回滚也失败时，错误信息必须保留原始错误并明确报告', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    // 任务更新抛错 + ROLLBACK 也抛错
    const origRun = store.run.bind(store);
    store.run = function (sql, args) {
      if (typeof sql === 'string' && sql.indexOf("UPDATE plan_tasks SET status='done'") === 0) {
        throw new Error('primary failure');
      }
      return origRun(sql, args);
    };
    const origExec = store.exec.bind(store);
    store.exec = function (sql) {
      if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') {
        throw new Error('rollback broken');
      }
      return origExec(sql);
    };
    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    store.run = origRun;
    store.exec = origExec;

    expect(res.ok).toBe(false);
    expect(res.error).toBe('TX_ROLLBACK_FAILED');
    // 原始错误信息必须保留（不能被回滚错误覆盖）
    expect(String(res.detail || '')).toContain('primary failure');
    // 回滚失败必须明确报告（不伪装成干净回滚）
    expect(String(res.detail || '')).toContain('rollback broken');
  });
});

describe('双表原子性 · 操作 B（确认未发布，允许重试）', () => {
  it('B2 任务更新成功但发布记录抛异常 → 两张表都恢复原状', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const orig = store._planPubUpsert.bind(store);
    store._planPubUpsert = function () { throw new Error('disk full'); };
    const res = store.requeueNeedsReviewRetry('w1', task.id, {});
    store._planPubUpsert = orig;

    // ★ 失败必须返回 ok:false（绝不吞掉异常后返回 ok:true）
    expect(res.ok).toBe(false);
    expect(res.error).toBe('pubs-write-failed');

    // ★ 任务必须回到 needs_review（不能停在 pending）
    const after = taskOf(store, 'w1');
    expect(after.status).toBe('needs_review');
    expect(after.real_only).toBe(1);

    // ★ 发布记录必须保持原来的 pending
    const recs = youtubePubs(store);
    expect(recs.length).toBe(1);
    expect(recs[0].status).toBe('pending');
    expect(recs[0].error).toBe('upload-exception（socket hang up）');
  });

  it('B3 任务更新成功但发布记录返回 ok:false → 两张表都恢复原状', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const orig = store._planPubUpsert.bind(store);
    store._planPubUpsert = function () { return { ok: false, error: 'write-failed' }; };
    const res = store.requeueNeedsReviewRetry('w1', task.id, {});
    store._planPubUpsert = orig;

    expect(res.ok).toBe(false);
    expect(res.error).toBe('pubs-write-failed');
    expect(taskOf(store, 'w1').status).toBe('needs_review');
    expect(youtubePubs(store)[0].status).toBe('pending');
  });

  it('B4 事务 COMMIT 失败 → 不得返回成功，且两张表都未提交', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const origExec = store.exec.bind(store);
    store.exec = function (sql) {
      if (typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT') {
        throw new Error('commit failed');
      }
      return origExec(sql);
    };
    const res = store.requeueNeedsReviewRetry('w1', task.id, {});
    store.exec = origExec;

    expect(res.ok).toBe(false);
    expect(res.error).toBe('TX_COMMIT_FAILED');
    expect(taskOf(store, 'w1').status).toBe('needs_review');
    expect(youtubePubs(store)[0].status).toBe('pending');
  });

  it('B5 失败后不得出现「可被调度器执行」的危险放行', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const orig = store._planPubUpsert.bind(store);
    store._planPubUpsert = function () { throw new Error('disk full'); };
    const res = store.requeueNeedsReviewRetry('w1', task.id, {});
    store._planPubUpsert = orig;

    expect(res.ok).toBe(false);

    // ★ 真正的危险条件是「闸门放行」**且**「任务进入真实调度器的到期扫描名单」。
    //   checkPlanPublishGuard 对 needs_review 任务返回 'allow' 是**既有全局语义**
    //   （本次禁止修改），它本身不会导致执行 —— 调度器只扫描 status='pending' 的任务
    //   （listDuePlanTasks），needs_review 永远不在其中。
    //   修复前后的差别在于：修复前任务被留在 'pending'（会进扫描名单），
    //   修复后任务回到 'needs_review'（进不了扫描名单）→ 不会被真的重传。
    expect(taskOf(store, 'w1').status).toBe('needs_review');
    expect(youtubePubs(store)[0].status).toBe('pending');

    // ★ 关键断言：即使计划时间已过，任务也绝不能出现在真实调度器的扫描名单里
    H.setDue(store, 'w1', task.id, H.PAST);
    const due = store.listDuePlanTasks(new Date().toISOString(), { forRealExecutor: true });
    expect(due.filter(t => t.id === task.id).length).toBe(0);

    // ★ 对照：修复前的遗留组合（任务=pending + 发布记录=pending）确实会被放行 →
    //   证明本测试断言的是真实危险条件，而不是形式上的字符串比较。
    const dangerStore = newStore();
    const dangerTask = seedNeedsReviewTask(dangerStore);
    dangerStore._planWriteTask(Object.assign({}, taskOf(dangerStore, 'w1'), {
      status: 'pending', real_only: 1
    }));
    H.setDue(dangerStore, 'w1', dangerTask.id, H.PAST);
    const dangerDue = dangerStore.listDuePlanTasks(new Date().toISOString(), { forRealExecutor: true });
    expect(dangerDue.filter(t => t.id === dangerTask.id).length).toBe(1);
    expect(dangerStore.checkPlanPublishGuard('w1', dangerTask.id).decision).toBe('allow');
  });

  it('B6 任务更新 changes=0 → 两张表都不动', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const origRun = store.run.bind(store);
    store.run = function (sql, args) {
      if (typeof sql === 'string' && sql.indexOf("UPDATE plan_tasks SET status='pending'") === 0) {
        return { changes: 0, lastInsertRowid: 0 };
      }
      return origRun(sql, args);
    };
    const res = store.requeueNeedsReviewRetry('w1', task.id, {});
    store.run = origRun;

    expect(res.ok).toBe(false);
    expect(res.error).toBe('task status changed');
    expect(taskOf(store, 'w1').status).toBe('needs_review');
    // 发布记录未被改动（仍是 pending，不是 failed）
    expect(youtubePubs(store)[0].status).toBe('pending');
  });
});

describe('双表原子性 · JSON 兜底存储分支', () => {
  function newJsonStore(name) {
    const { Store } = H.loadStoreFresh(true);   // 两个驱动都屏蔽 → JSON 兜底
    return new Store(path.join(tmpDir, name));
  }

  it('J1 JSON 模式：发布记录抛异常 → 两张表都恢复原状（内存 + 磁盘）', () => {
    const store = newJsonStore('json-a1.json');
    const task = seedNeedsReviewTask(store);

    const orig = store._planPubUpsert.bind(store);
    store._planPubUpsert = function () { throw new Error('disk full'); };
    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    store._planPubUpsert = orig;

    expect(res.ok).toBe(false);
    expect(res.error).toBe('pubs-write-failed');
    // 内存状态
    expect(taskOf(store, 'w1').status).toBe('needs_review');
    expect(youtubePubs(store)[0].status).toBe('pending');
    // 磁盘状态（重新读文件确认已持久化为原状）
    const disk = JSON.parse(require('fs').readFileSync(store.jsonFile, 'utf8'));
    const dt = (disk.plan_tasks || []).filter(t => t && t.platform_id === 'youtube')[0];
    const dp = (disk.pubs || []).filter(p => p && p.platform_id === 'youtube')[0];
    expect(dt.status).toBe('needs_review');
    expect(dp.status).toBe('pending');
  });

  it('J2 JSON 模式：操作 B 的发布记录失败 → 任务与发布记录都恢复原状', () => {
    const store = newJsonStore('json-b2.json');
    const task = seedNeedsReviewTask(store);

    const orig = store._planPubUpsert.bind(store);
    store._planPubUpsert = function () { throw new Error('disk full'); };
    const res = store.requeueNeedsReviewRetry('w1', task.id, {});
    store._planPubUpsert = orig;

    expect(res.ok).toBe(false);
    expect(res.error).toBe('pubs-write-failed');
    expect(taskOf(store, 'w1').status).toBe('needs_review');
    expect(youtubePubs(store)[0].status).toBe('pending');

    // 磁盘状态同样保持原状
    const disk = JSON.parse(require('fs').readFileSync(store.jsonFile, 'utf8'));
    const dt = (disk.plan_tasks || []).filter(t => t && t.platform_id === 'youtube')[0];
    const dp = (disk.pubs || []).filter(p => p && p.platform_id === 'youtube')[0];
    expect(dt.status).toBe('needs_review');
    expect(dp.status).toBe('pending');
  });

  it('J3 JSON 模式：成功路径下两张表一起落盘（无中间态）', () => {
    const store = newJsonStore('json-ok.json');
    const task = seedNeedsReviewTask(store);

    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    expect(res.ok).toBe(true);

    const disk = JSON.parse(require('fs').readFileSync(store.jsonFile, 'utf8'));
    const dt = (disk.plan_tasks || []).filter(t => t && t.platform_id === 'youtube')[0];
    const dp = (disk.pubs || []).filter(p => p && p.platform_id === 'youtube')[0];
    expect(dt.status).toBe('done');
    expect(dp.status).toBe('ok');
    expect(dp.video_id).toBe('dQw4w9WgXcQ');
    // 仍然只有一条发布记录
    expect((disk.pubs || []).filter(p => p && p.platform_id === 'youtube').length).toBe(1);
  });

  it('J4 JSON 模式：事务内发现状态已被改动 → 两张表都不动', () => {
    const store = newJsonStore('json-changed.json');
    const task = seedNeedsReviewTask(store);

    // 模拟「前置校验通过之后、事务体执行到任务写入之前」状态被别的操作改掉：
    //   在 _planAtomicWrite 内部（前置校验已过）把内存里的任务行改成 cancelled。
    const origAtomic = store._planAtomicWrite.bind(store);
    store._planAtomicWrite = function (fn) {
      const list = store.data.plan_tasks;
      const t = list.filter(x => x && String(x.id) === task.id)[0];
      t.status = 'cancelled';
      return origAtomic(fn);
    };

    const res = store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    store._planAtomicWrite = origAtomic;

    expect(res.ok).toBe(false);
    expect(res.error).toBe('task status changed');
    // 任务仍是 cancelled（未被这次操作改写）
    expect(taskOf(store, 'w1').status).toBe('cancelled');
    // 发布记录保持 pending（未被这次操作改写）
    expect(youtubePubs(store)[0].status).toBe('pending');
  });
});

describe('双表原子性 · 事务确实是真事务（不是逻辑判断）', () => {
  it('T1 SQLite：操作 A 的两次写入确实落在同一个事务里（含 BEGIN/COMMIT）', () => {
    const store = newStore();
    seedNeedsReviewTask(store);

    const seq = [];
    const origExec = store.exec.bind(store);
    store.exec = function (sql) {
      seq.push(String(sql).trim().toUpperCase());
      return origExec(sql);
    };
    const origRun = store.run.bind(store);
    store.run = function (sql, args) {
      const s = String(sql);
      if (s.indexOf('UPDATE pubs') === 0) seq.push('UPDATE_PUBS');
      if (s.indexOf('UPDATE plan_tasks') === 0) seq.push('UPDATE_PLAN_TASKS');
      return origRun(sql, args);
    };

    store.confirmNeedsReviewPublished('w1', taskOf(store, 'w1').id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });

    store.exec = origExec;
    store.run = origRun;

    // 顺序必须是：BEGIN → 写 pubs → 写 plan_tasks → COMMIT
    expect(seq).toEqual(['BEGIN', 'UPDATE_PUBS', 'UPDATE_PLAN_TASKS', 'COMMIT']);
  });

  it('T2 SQLite：操作 B 的两次写入确实落在同一个事务里（含 BEGIN/COMMIT）', () => {
    const store = newStore();
    seedNeedsReviewTask(store);

    const seq = [];
    const origExec = store.exec.bind(store);
    store.exec = function (sql) {
      seq.push(String(sql).trim().toUpperCase());
      return origExec(sql);
    };
    const origRun = store.run.bind(store);
    store.run = function (sql, args) {
      const s = String(sql);
      if (s.indexOf('UPDATE plan_tasks') === 0) seq.push('UPDATE_PLAN_TASKS');
      if (s.indexOf('UPDATE pubs') === 0) seq.push('UPDATE_PUBS');
      return origRun(sql, args);
    };

    store.requeueNeedsReviewRetry('w1', taskOf(store, 'w1').id, {});

    store.exec = origExec;
    store.run = origRun;

    expect(seq).toEqual(['BEGIN', 'UPDATE_PLAN_TASKS', 'UPDATE_PUBS', 'COMMIT']);
  });

  it('T3 SQLite：失败时确实执行了 ROLLBACK（两张表被数据库回滚，不是内存假象）', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const seq = [];
    const origExec = store.exec.bind(store);
    store.exec = function (sql) {
      seq.push(String(sql).trim().toUpperCase());
      return origExec(sql);
    };
    // 任务更新抛错
    const origRun = store.run.bind(store);
    store.run = function (sql, args) {
      if (typeof sql === 'string' && sql.indexOf("UPDATE plan_tasks SET status='done'") === 0) {
        throw new Error('boom');
      }
      return origRun(sql, args);
    };

    store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });

    store.run = origRun;
    store.exec = origExec;

    // 事务被开启 → 回滚 → 提交从未发生
    expect(seq).toEqual(['BEGIN', 'ROLLBACK']);
    expect(seq.indexOf('COMMIT')).toBe(-1);
  });

  it('T4 SQLite：用**新连接**读库确认数据真的没被提交（跨连接视角）', () => {
    const store = newStore();
    const task = seedNeedsReviewTask(store);

    const origRun = store.run.bind(store);
    store.run = function (sql, args) {
      if (typeof sql === 'string' && sql.indexOf("UPDATE plan_tasks SET status='done'") === 0) {
        throw new Error('boom');
      }
      return origRun(sql, args);
    };
    store.confirmNeedsReviewPublished('w1', task.id, {
      platform_ref: 'dQw4w9WgXcQ',
      platform_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    });
    store.run = origRun;

    // 用独立的新 Store 实例（独立连接）读同一文件 → 看到的是磁盘上的真实状态
    const { Store } = H.loadStoreFresh(false);
    const fresh = new Store(dbPath);
    const t2 = fresh.listPlanTasks('w1').filter(t => t.platform_id === 'youtube')[0];
    const p2 = fresh.listPubs().filter(p => p && p.platform_id === 'youtube')[0];
    expect(t2.status).toBe('needs_review');
    expect(p2.status).toBe('pending');
    expect(p2.video_id).toBe('');
  });
});
