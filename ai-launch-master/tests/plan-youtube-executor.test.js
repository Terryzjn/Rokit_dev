
// Rokit · 首秀计划 YouTube 真实发布 —— 定向测试
//
// 覆盖用户要求的全部验证点：
//   Y1  正常执行时调用 YouTube 上传入口
//   Y2  上传参数中的 privacyStatus 始终为 'public'
//   Y3  标题、正文、标签和视频路径正确传递
//   Y4  pending 记录创建失败时不调用上传入口
//   Y5  上传成功后记录 video_id、url
//   Y6  上传结果不确定时进入 needs_review
//   Y7  needs_review 不会触发自动重传
//   Y8  上传失败不会自动重试
//   Y9  YouTube 执行器不依赖渲染窗口
//   Y10 不传 categoryId
//   Y11 非 YouTube 任务 / 模拟任务不进入真实发布
//   Y12 OAuth 未授权 → 人工处理状态（后台不弹授权窗口）
//
// 全部使用临时数据库 + 注入的 mock 上传入口，
// **没有任何真实 YouTube API 调用 / 真实 OAuth 授权 / 真实视频上传 / 真实计划执行**。

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
function loadYoutubeExecutor() {
  const id = require.resolve(path.join(H.ROOT, 'electron', 'plan-youtube-executor'));
  delete require.cache[id];
  return require(path.join(H.ROOT, 'electron', 'plan-youtube-executor'));
}

/* ---------- 造数据 ---------- */
function seedWork(store, id) {
  store.saveWork({
    id: id, name: '作品 ' + id, type: 'tool', intro: 'intro', url: '',
    status: '首秀中', queue: '主推', star: 0, dl: 0, play: '0', next: '',
    created_at: new Date().toISOString()
  });
  return store.listWorks().filter(w => w.id === id)[0];
}
function seedYoutubeStage(store, workId, stageId, copy) {
  store.savePlanStages(workId, [{
    id: stageId, title: '阶段 ' + stageId, desc: '', offsetDays: 0, timeOfDay: '20:00',
    platforms: ['youtube'],
    copy: copy || {
      youtube: {
        title: 'v1.0.0 发布', body: '这是发布说明', tags: ['tool', 'release'],
        videoPath: 'C:/videos/final-abc.mp4'
      }
    }
  }]);
  return store.listPlanTasks(workId).filter(t => t.platform_id === 'youtube' && t.stage_id === stageId)[0];
}

/**
 * 注入式 YouTube 执行器（绝不触网）。
 * over.publishVideo：替换上传入口返回值
 * over.addPubThrows：让 addPub 抛错（模拟本地记录写不进去）
 * over.addPubReturns：让 addPub 返回指定值（undefined / null 等"未真正落库"的情形）
 * over.noPublishVideo：完全不注入 publishVideo（模拟内部配置缺失）
 */
function makeYoutubeExec(store, over) {
  over = over || {};
  const calls = { upload: [], addPub: [] };
  const baseStore = store;
  const wrappedStore = Object.create(baseStore);
  wrappedStore.addPub = function (payload) {
    calls.addPub.push(payload);
    if (over.addPubThrows) throw new Error('disk full');
    if (Object.prototype.hasOwnProperty.call(over, 'addPubReturns')) return over.addPubReturns;
    return baseStore.addPub(payload);
  };

  const execOpts = {
    getStore: () => wrappedStore,
    resolveWorkFinalVideo: over.resolveWorkFinalVideo || (async function () {
      return { ok: false, error: 'no-final-video', detail: '未找到最终成品视频' };
    }),
    getToken: over.getToken || (async function () { return { access_token: 'test-token' }; })
  };
  if (!over.noPublishVideo) {
    execOpts.publishVideo = async function (payload) {
      calls.upload.push(payload);
      if (over.publishVideo) return over.publishVideo(payload);
      return {
        status: 'ok', platformId: 'youtube',
        videoId: 'vid-123', url: 'https://www.youtube.com/watch?v=vid-123',
        requestedPrivacy: 'public', actualPrivacy: 'public',
        fileSize: 12345, mimeType: 'video/mp4'
      };
    };
  }

  const exec = loadYoutubeExecutor().createYoutubePlanExecutor(execOpts);
  return { exec, calls, store: wrappedStore };
}

function pubsOf(store, workId) {
  return store.listPubs ? store.listPubs(workId) : [];
}

describe('首秀计划 · YouTube 真实发布适配器', () => {
  it('Y1 正常执行时调用 YouTube 上传入口', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store);

    const r = await exec(task);

    expect(calls.upload.length).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('done');
  });

  it('Y2 privacyStatus 始终为 public（且不传 categoryId）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store);

    await exec(task);

    expect(calls.upload[0].privacyStatus).toBe('public');
    expect(calls.upload[0].categoryId).toBeUndefined();
  });

  it('Y3 标题、正文、标签、视频路径正确传递', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store);

    await exec(task);

    const p = calls.upload[0];
    expect(p.title).toBe('v1.0.0 发布');
    expect(p.description).toBe('这是发布说明');
    expect(p.tags).toEqual(['tool', 'release']);
    expect(p.finalVideoPath).toBe('C:/videos/final-abc.mp4');
  });

  it('Y4 pending 记录创建失败时不调用上传入口', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store, { addPubThrows: true });

    const r = await exec(task);

    expect(calls.upload.length).toBe(0);      // 绝不开始上传
    expect(r.ok).toBe(false);
    expect(r.error).toContain('pubs-write-failed');
  });

  it('Y5 上传成功后记录 video_id 与 url（且同一 pub_key 只更新不新增）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store);

    const r = await exec(task);

    expect(r.platform_ref).toBe('vid-123');
    expect(r.platform_url).toBe('https://www.youtube.com/watch?v=vid-123');
    // 发布记录：pending → ok 是同一条（pub_key 相同）
    expect(calls.addPub.length).toBe(2);
    expect(calls.addPub[0].status).toBe('pending');
    expect(calls.addPub[1].status).toBe('ok');
    expect(calls.addPub[1].video_id).toBe('vid-123');
    expect(calls.addPub[1].url).toBe('https://www.youtube.com/watch?v=vid-123');
    expect(calls.addPub[0].pub_key).toBe(calls.addPub[1].pub_key);
  });

  it('Y6 上传结果不确定（抛异常）时进入 needs_review', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec } = makeYoutubeExec(store, {
      publishVideo: async function () { throw new Error('socket hang up'); }
    });

    const r = await exec(task);

    expect(r.ok).toBe(true);
    expect(r.status).toBe('needs_review');
    expect(r.error).toContain('upload-exception');
  });

  it('Y6b 上传成功但本地记录写失败时进入 needs_review（不触发第二次上传）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store);

    // 让第二次 addPub（ok 那次）抛错
    let n = 0;
    const origAdd = store.addPub.bind(store);
    store.addPub = function (payload) {
      n++;
      if (n === 2) throw new Error('disk full');
      return origAdd(payload);
    };

    const r = await exec(task);

    expect(calls.upload.length).toBe(1);       // 只上传了一次
    expect(r.status).toBe('needs_review');
    expect(r.error).toContain('pubs-write-failed');
  });

  it('Y7 needs_review 不会被调度器自动重传（真实调度器端到端验证）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store, {
      publishVideo: async function () { throw new Error('socket hang up'); }
    });

    await exec(task);
    // 手工把任务置为 needs_review（模拟调度器 finishPlanTask 的落库结果）
    const cur = store.listPlanTasks('w1').filter(t => t.id === task.id)[0];
    store._planWriteTask(Object.assign({}, cur, {
      status: 'needs_review',
      scheduled_at: new Date(Date.now() - 86400000).toISOString()   // 已到期
    }));

    // 1) 到期扫描名单里没有它（listDuePlanTasks 只取 status='pending'）
    const due = store.listDuePlanTasks(new Date(Date.now() + 86400000).toISOString(), { forRealExecutor: true });
    expect(due.filter(t => t.id === task.id).length).toBe(0);

    // 2) 真实调度器扫描一轮：不会领取、不会调用上传入口
    const schedId = require.resolve(path.join(H.ROOT, 'electron', 'plan-scheduler'));
    delete require.cache[schedId];
    const { createPlanScheduler } = require(schedId);
    const sch = createPlanScheduler({
      getStore: () => store,
      executorKind: 'real',
      realExecutors: { youtube: exec },
      logger: { info() {}, warn() {}, error() {} }
    });
    const out = await sch.scanOnce().settled;
    expect(out.claimed.filter(id => id === task.id).length).toBe(0);
    expect(calls.upload.length).toBe(1);          // 仍然只有第一次那一次
    const after = store.listPlanTasks('w1').filter(t => t.id === task.id)[0];
    expect(after.status).toBe('needs_review');      // 状态未被自动改动

    // 3) 恢复对账只处理 pending，不会把它推进成 done
    store.reconcilePlanTasks(new Date().toISOString());
    const after2 = store.listPlanTasks('w1').filter(t => t.id === task.id)[0];
    expect(after2.status).toBe('needs_review');
  });

  it('Y8 上传明确失败不会自动重试（失败即终止，由用户手动重新排队）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store, {
      publishVideo: async function () {
        // API_4XX = YouTube 明确拒绝 → 确定没有创建视频
        return { status: 'manual', platformId: 'youtube', error: 'API_4XX', note: '请求被拒绝' };
      }
    });

    const r = await exec(task);

    expect(r.ok).toBe(false);
    expect(r.error).toContain('API_4XX');
    expect(calls.upload.length).toBe(1);        // 只尝试一次
    // 发布记录已更新为 failed（同一 pub_key）
    expect(calls.addPub[1].status).toBe('failed');
  });

  it('Y8b 网络结果不确定（NETWORK / 5xx / 未预期异常）→ needs_review，不当成明确失败', async () => {
    for (const code of ['NETWORK', 'API_5XX', 'UNEXPECTED', 'TOKEN_REFRESH_FAILED']) {
      const store = newStore();
      seedWork(store, 'w1');
      const task = seedYoutubeStage(store, 'w1', 's1');
      const { exec, calls } = makeYoutubeExec(store, {
        publishVideo: async function () {
          return { status: 'manual', platformId: 'youtube', error: code, note: '结果不确定' };
        }
      });

      const r = await exec(task);

      expect(r.status, code).toBe('needs_review');
      // 发布记录保持 pending（"可能已发出"），绝不写成 failed
      expect(calls.addPub[1].status, code).toBe('pending');
      expect(calls.upload.length, code).toBe(1);
    }
  });

  it('Y8c 授权类失败 → needs_review（后台不弹 OAuth 窗口），且发布记录保持 pending', async () => {
    for (const code of ['NOT_CONNECTED', 'YOUTUBE_REAUTH_REQUIRED', 'SCOPE_INSUFFICIENT']) {
      const store = newStore();
      seedWork(store, 'w1');
      const task = seedYoutubeStage(store, 'w1', 's1');
      const { exec, calls } = makeYoutubeExec(store, {
        publishVideo: async function () {
          return { status: 'need_login', platformId: 'youtube', error: code, note: '需要重新授权' };
        }
      });

      const r = await exec(task);

      expect(r.status, code).toBe('needs_review');
      expect(calls.addPub[1].status, code).toBe('pending');
      expect(r.note).toContain('不会弹出');
    }
  });

  it('Y9 YouTube 执行器不依赖渲染窗口（不注入也不访问任何 window / UI 依赖）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store);

    // 全局没有 window / document：执行器仍必须能跑完
    expect(typeof globalThis.window).toBe('undefined');
    const r = await exec(task);

    expect(r.ok).toBe(true);
    // 上传 payload 里不含任何进度回调 / 窗口引用
    expect(calls.upload[0].onProgress).toBeUndefined();
    expect(calls.upload[0].window).toBeUndefined();
  });

  it('Y11 非 YouTube 任务与模拟任务都不进入真实发布', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store);

    const other = await exec(Object.assign({}, task, { platform_id: 'github' }));
    expect(other.ok).toBe(false);
    expect(calls.upload.length).toBe(0);

    const sim = await exec(Object.assign({}, task, { simulated: 1 }));
    expect(sim.ok).toBe(false);
    expect(calls.upload.length).toBe(0);
  });

  it('Y12 OAuth 未授权 → 人工处理状态，且不调用上传入口', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store, {
      getToken: async function () { return null; }
    });

    const r = await exec(task);

    expect(calls.upload.length).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('needs_review');
    expect(r.error).toContain('youtube-not-authorized');
    expect(r.note).toContain('不会弹出');
  });

  it('Y13 快照缺失视频时回退到作品最新成品视频', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    // 快照里没有 videoPath
    const task = seedYoutubeStage(store, 'w1', 's1', {
      youtube: { title: 't', body: 'b', tags: [] }
    });
    const { exec, calls } = makeYoutubeExec(store, {
      resolveWorkFinalVideo: async function () {
        return { ok: true, path: 'C:/videos/work-latest.mp4' };
      }
    });

    await exec(task);

    expect(calls.upload[0].finalVideoPath).toBe('C:/videos/work-latest.mp4');
  });

  it('Y14 快照与回退都拿不到视频时明确失败，且不上传任何原始视频', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1', {
      youtube: { title: 't', body: 'b', tags: [] }
    });
    const { exec, calls } = makeYoutubeExec(store);

    const r = await exec(task);

    expect(calls.upload.length).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('missing-final-video');
  });

  it('Y15 阶段缺少 YouTube 文案快照时明确失败', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1', { youtube: { title: '', body: 'b', tags: [] } });
    const { exec, calls } = makeYoutubeExec(store);

    const r = await exec(task);

    expect(calls.upload.length).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('missing-copy');
  });
});

/* ==================================================================
   第一批边界问题核查
   ================================================================== */
describe('边界问题一：上传成功但没有 videoId', () => {
  it('B1-1 上传返回成功但没有 videoId → 发布记录仍为 pending，不写成 failed', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store, {
      publishVideo: async function () {
        // status:'ok' 但没有 videoId / url（接口报告成功却没带回 id）
        return { status: 'ok', platformId: 'youtube', requestedPrivacy: 'public', actualPrivacy: 'public' };
      }
    });

    const r = await exec(task);

    // 记录保持 pending（"可能已发出去了"），绝不写成 failed
    expect(calls.addPub.length).toBe(2);
    expect(calls.addPub[0].status).toBe('pending');
    expect(calls.addPub[1].status).toBe('pending');
    // 不伪造 videoId / url
    expect(calls.addPub[1].video_id).toBe('');
    expect(calls.addPub[1].url).toBe('');
  });

  it('B1-2 计划任务进入 needs_review（且不伪造标识）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec } = makeYoutubeExec(store, {
      publishVideo: async function () {
        return { status: 'ok', platformId: 'youtube' };
      }
    });

    const r = await exec(task);

    expect(r.ok).toBe(true);
    expect(r.status).toBe('needs_review');
    expect(r.error).toContain('no-video-id');
    // 不伪造 videoId / 视频链接
    expect(r.platform_ref).toBeUndefined();
    expect(r.platform_url).toBeUndefined();
    // 提示用户去 YouTube 后台人工核实
    expect(r.note).toContain('YouTube 后台');
  });

  it('B1-3 后续调度扫描不会再次上传', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store, {
      publishVideo: async function () {
        return { status: 'ok', platformId: 'youtube' };   // 成功但无 videoId
      }
    });

    await exec(task);
    // 任务落成 needs_review（模拟调度器 finishPlanTask 的落库结果）+ 保持到期
    const cur = store.listPlanTasks('w1').filter(t => t.id === task.id)[0];
    store._planWriteTask(Object.assign({}, cur, {
      status: 'needs_review',
      scheduled_at: new Date(Date.now() - 86400000).toISOString()
    }));

    // 真实调度器扫描一轮：不会领取、不会再上传
    const schedId = require.resolve(path.join(H.ROOT, 'electron', 'plan-scheduler'));
    delete require.cache[schedId];
    const { createPlanScheduler } = require(schedId);
    const sch = createPlanScheduler({
      getStore: () => store,
      executorKind: 'real',
      realExecutors: { youtube: exec },
      logger: { info() {}, warn() {}, error() {} }
    });
    const out = await sch.scanOnce().settled;
    expect(out.claimed.filter(id => id === task.id).length).toBe(0);
    expect(calls.upload.length).toBe(1);        // 仍然只有第一次那一次
    expect(store.listPlanTasks('w1').filter(t => t.id === task.id)[0].status).toBe('needs_review');
  });
});

describe('边界问题二：publishVideo 依赖检查顺序', () => {
  it('B2-1 未注入 publishVideo → 明确错误，且不写 pending 记录、不调用上传', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store, { noPublishVideo: true });

    const r = await exec(task);

    // 明确错误
    expect(r.ok).toBe(false);
    expect(r.error).toContain('publish-entry-missing');
    // 不创建无意义的 pending 发布记录
    expect(calls.addPub.length).toBe(0);
    // 不调用上传入口
    expect(calls.upload.length).toBe(0);
  });

  it('B2-2 正常上传时 pending 仍必须先于实际上传落库', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const order = [];
    const baseStore = store;
    const wrappedStore = Object.create(baseStore);
    wrappedStore.addPub = function (payload) {
      order.push('addPub:' + payload.status);
      return baseStore.addPub(payload);
    };
    const { createYoutubePlanExecutor } = loadYoutubeExecutor();
    const exec = createYoutubePlanExecutor({
      getStore: () => wrappedStore,
      publishVideo: async function () {
        order.push('upload');
        return { status: 'ok', platformId: 'youtube', videoId: 'vid-1', url: 'https://www.youtube.com/watch?v=vid-1' };
      },
      resolveWorkFinalVideo: async function () { return { ok: false, error: 'no-final-video' }; },
      getToken: async function () { return { access_token: 't' }; }
    });

    await exec(task);

    // pending 必须排在 upload 之前
    expect(order.indexOf('addPub:pending')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('addPub:pending')).toBeLessThan(order.indexOf('upload'));
  });
});

describe('边界问题三：store.addPub() 返回值判定', () => {
  it('B3-1 addPub 抛异常 → 不开始上传', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store, { addPubThrows: true });

    const r = await exec(task);

    expect(calls.upload.length).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('pubs-write-failed');
  });

  it('B3-2 addPub 返回 undefined（未真正落库）→ 不开始上传', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store, { addPubReturns: undefined });

    const r = await exec(task);

    expect(calls.upload.length).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('pubs-write-failed');
  });

  it('B3-3 addPub 返回 null → 不开始上传', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store, { addPubReturns: null });

    const r = await exec(task);

    expect(calls.upload.length).toBe(0);
    expect(r.ok).toBe(false);
  });

  it('B3-4 addPub 返回合法成功值（行对象）→ 发布流程正常走完', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = seedYoutubeStage(store, 'w1', 's1');
    const { exec, calls } = makeYoutubeExec(store);

    const r = await exec(task);

    // 合法成功返回值（addPub 返回已落库的行对象）不能被误判为失败
    expect(r.ok).toBe(true);
    expect(r.status).toBe('done');
    expect(calls.upload.length).toBe(1);
    expect(calls.addPub[1].status).toBe('ok');
    expect(calls.addPub[1].video_id).toBe('vid-123');
  });

  it('B3-5 addPub 真实实现的返回值确实是 truthy 行对象（两种驱动）', () => {
    // 直接验证 store.addPub 的真实返回约定：成功返回行对象（truthy），不是 {ok:true}
    const store = newStore();
    const row = store.addPub({
      work_id: 'w1', platform: 'YouTube', platform_id: 'youtube',
      status: 'pending', title: 't', body: 'b', tags: '', time: '',
      url: '', error: '', video_id: '', pub_key: 'plan|w1|s1|youtube'
    });
    expect(row).toBeTruthy();
    expect(typeof row).toBe('object');
    expect(row.status).toBe('pending');
    expect(row.pub_key).toBe('plan|w1|s1|youtube');
    // 行对象上没有 ok 字段 → 不能用 res.ok === true 判定
    expect(row.ok).toBeUndefined();
  });
});

/* ==================================================================
   真实执行资格：YouTube 新建计划必须进入真实发布通道
   （修复前 YouTube 被写成 real_only=0 → 到期走模拟执行器）
   ================================================================== */
describe('真实执行资格 · PLAN_REAL_PLATFORMS', () => {
  function seedPlan(store, workId, stageId, platforms) {
    seedWork(store, workId);
    store.savePlanStages(workId, [{
      id: stageId, title: '阶段 ' + stageId, desc: '', offsetDays: 0, timeOfDay: '20:00',
      platforms: platforms, copy: {}
    }]);
    return store.listPlanTasks(workId);
  }
  function taskOf(store, workId, platformId) {
    return store.listPlanTasks(workId).filter(function (t) {
      return String(t.platform_id) === String(platformId);
    })[0];
  }

  it('Q1 新建 GitHub 计划 → real_only=1', () => {
    const store = newStore();
    seedPlan(store, 'w1', 's1', ['github']);
    expect(taskOf(store, 'w1', 'github').real_only).toBe(1);
  });

  it('Q2 新建 YouTube 计划 → real_only=1（本次修复的核心）', () => {
    const store = newStore();
    seedPlan(store, 'w1', 's1', ['youtube']);
    const t = taskOf(store, 'w1', 'youtube');
    expect(t.real_only).toBe(1);
    expect(t.simulated).toBe(0);
    expect(t.status).toBe('pending');
  });

  it('Q3 新建微信公众号计划 → real_only=1（已接入真实草稿创建通道）', () => {
    const store = newStore();
    seedPlan(store, 'w1', 's1', ['wechat']);
    const t = taskOf(store, 'w1', 'wechat');
    expect(t.real_only).toBe(1);
    expect(t.simulated).toBe(0);
  });

  it('Q4 其他不支持真实执行的平台仍然是 real_only=0', () => {
    const store = newStore();
    seedPlan(store, 'w1', 's1', ['xhs', 'v2ex', 'bilibili']);
    ['xhs', 'v2ex', 'bilibili'].forEach(function (pid) {
      const t = taskOf(store, 'w1', pid);
      if (t) expect(t.real_only).toBe(0);
    });
  });

  it('Q5 混合平台阶段：按平台分别判定，不互相影响', () => {
    const store = newStore();
    seedPlan(store, 'w1', 's1', ['github', 'youtube', 'wechat']);
    expect(taskOf(store, 'w1', 'github').real_only).toBe(1);
    expect(taskOf(store, 'w1', 'youtube').real_only).toBe(1);
    // 微信公众号同样已接入真实草稿创建通道
    expect(taskOf(store, 'w1', 'wechat').real_only).toBe(1);
  });

  it('Q6 simulated=1 的安全拦截仍然有效（模拟任务不得进入真实路径）', () => {
    const store = newStore();
    seedPlan(store, 'w1', 's1', ['youtube']);
    // 标记成已被模拟执行过的遗留任务
    store._planWriteTask(Object.assign({}, taskOf(store, 'w1', 'youtube'), {
      simulated: 1, real_only: 1
    }));
    const t = taskOf(store, 'w1', 'youtube');
    expect(t.simulated).toBe(1);
    // 模拟调度器不得领取 real_only=1 的任务
    const dueMock = store.listDuePlanTasks('2999-01-01T00:00:00.000Z');
    expect(dueMock.map(function (x) { return x.platform_id; })).not.toContain('youtube');
  });

  it('Q7 YouTube needs_review 不会被自动重传（不进入到期名单）', () => {
    const store = newStore();
    seedPlan(store, 'w1', 's1', ['youtube']);
    const t = taskOf(store, 'w1', 'youtube');
    store._planWriteTask(Object.assign({}, t, {
      status: 'needs_review', real_only: 0, scheduled_at: '2020-01-01T00:00:00.000Z'
    }));
    const due = store.listDuePlanTasks('2999-01-01T00:00:00.000Z', { forRealExecutor: true });
    expect(due.map(function (x) { return x.platform_id; })).not.toContain('youtube');
  });

  it('Q8 人工确认重试仍进入真实执行资格（requeueNeedsReviewRetry → real_only=1）', () => {
    const store = newStore();
    seedPlan(store, 'w1', 's1', ['youtube']);
    const t = taskOf(store, 'w1', 'youtube');
    store._planWriteTask(Object.assign({}, t, {
      status: 'needs_review', real_only: 0, scheduled_at: '2020-01-01T00:00:00.000Z'
    }));

    const res = store.requeueNeedsReviewRetry('w1', t.id, { stage_id: 's1' });
    expect(res.ok).toBe(true);
    const after = taskOf(store, 'w1', 'youtube');
    expect(after.status).toBe('pending');
    expect(after.real_only).toBe(1);
    // 重新入队 → 到期名单里可见（由调度器接手，不直接调用上传函数）
    const due = store.listDuePlanTasks('2999-01-01T00:00:00.000Z', { forRealExecutor: true });
    expect(due.map(function (x) { return x.platform_id; })).toContain('youtube');
  });

  it('Q9 已有 GitHub 计划行为不变（编辑计划后仍保持 real_only=1）', () => {
    const store = newStore();
    seedPlan(store, 'w1', 's1', ['github']);
    expect(taskOf(store, 'w1', 'github').real_only).toBe(1);
    // 重新保存同一阶段（编辑计划）→ 资格不变
    store.savePlanStages('w1', [{
      id: 's1', title: '阶段 s1', desc: '', offsetDays: 1, timeOfDay: '21:00',
      platforms: ['github'], copy: {}
    }]);
    expect(taskOf(store, 'w1', 'github').real_only).toBe(1);
    expect(taskOf(store, 'w1', 'github').status).toBe('pending');
  });
});
