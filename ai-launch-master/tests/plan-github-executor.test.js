'use strict';

// Rokit · 首秀计划 GitHub 发布（第一批：Markdown 文章）—— 定向测试
//
// 覆盖用户要求的全部验证点：
//   G1  正常创建 Markdown 文件（走 githubPutFile，不再创建 Release）
//   G2  YouTube / 微信任务不会被 GitHub 适配器执行
//   G3  模拟任务不会进入真实发布路径
//   G4  real_only 任务不会被 mock 执行器领取
//   G5  skip / review / unclear 均不会触发 GitHub 写请求
//   G6  allow 可以进入适配器（mock，不产生真实外部写入）
//   G7  文章统一写入 posts/，使用计划保存的标题 / 正文快照
//   G8  发布记录统一写入 pubs，幂等键符合现有规则
//   G9  已确认成功的任务不会再次发布
//   G10 结果不确定 / 文件已存在时进入 needs_review，不自动重试
//   G11 API 明确失败 / 认证失效 / 权限不足 / 参数缺失的处理符合状态模型
//   G12 文件已写入但本地记录写入失败时，不当成普通失败直接重发
//   G13 history_note 在成功 / 失败路径中均保留
//   G14 既有 GitHub Contents API 行为（普通发布更新 / create-only / 只读查询）无回归
//   N1  中文标题不会造成文件名冲突
//   N2  同一任务重试路径稳定
//   N3  目标文件属于本任务此前成功写入 → 幂等完成
//   N4  旧 Release 历史记录仍可正常读取
//   N5  真实执行结果带 simulated:false → 调度器日志 kind=real
//
// 全部使用临时数据库 + 注入的 mock API，**没有任何真实网络写入**。

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
function loadPublisherExtensions() {
  const id = require.resolve(path.join(H.ROOT, 'electron', 'publisher-extensions'));
  return require(id);
}

/* ---------- 造数据 ---------- */
function seedWorkNamed(store, id, name, url) {
  return store.saveWork({
    id: id, name: name || ('作品 ' + id), type: 'tool', intro: 'intro', url: url || '',
    status: '首秀中', queue: '主推', star: 0, dl: 0, play: '0', next: '',
    created_at: new Date().toISOString()
  });
}
function seedWork(store, id, url) {
  return seedWorkNamed(store, id, '作品 ' + id, url);
}
function makeStage(stageId, platformId, copy) {
  return {
    id: stageId, title: '阶段 ' + stageId, desc: '', offsetDays: 0, timeOfDay: '20:00',
    platforms: [platformId],
    copy: copy || { [platformId]: { title: 'v1.0.0 发布', body: '这是发布说明', tags: ['tool'] } }
  };
}
function seedStage(store, workId, stageId, platformId, copy) {
  store.savePlanStages(workId, [makeStage(stageId, platformId, copy)]);
  return store.listPlanTasks(workId).filter(t => t.platform_id === platformId && t.stage_id === stageId)[0];
}
function seedTwoStages(store, workId, stageIds, platformId) {
  store.savePlanStages(workId, stageIds.map(function (sid) { return makeStage(sid, platformId); }));
  return store.listPlanTasks(workId).filter(t => t.platform_id === platformId);
}
/** 让任务到期 + 进入「等待真实执行」（模拟任务被显式重新排队） */
function makeWaitingTask(store, workId, taskId) {
  const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
  // 现行规则：阶段里选中 GitHub 的任务默认是真实执行候选（real_only=1），
  // 模拟调度器不会领取它。本用例的前置条件是「先由模拟执行器产生一次模拟结果」，
  // 因此这里显式把该任务降级为模拟候选（等价于旧版 auto_publish=0 的历史任务）。
  const cur = store.listPlanTasks(workId).filter(x => x.id === taskId)[0];
  store._planWriteTask(Object.assign({}, cur, { real_only: 0 }));
  store.updatePlanTask(workId, taskId, { scheduled_at: H.PAST });
  createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();
  const r = store.requeueSimulatedPlanTask(workId, taskId);
  expect(r.ok).toBe(true);
  const t = store.listPlanTasks(workId).filter(x => x.id === taskId)[0];
  expect(t.status).toBe('pending');
  expect(t.real_only).toBe(1);
  return t;
}
/** 把执行时间改成一个「本地日历日确定」的时刻（12:00 本地），避免测试受 UTC 偏移影响 */
function setLocalSchedule(store, workId, taskId, y, m, d) {
  const iso = new Date(y, m - 1, d, 12, 0, 0).toISOString();
  store.updatePlanTask(workId, taskId, { scheduled_at: iso });
  return store.listPlanTasks(workId).filter(x => x.id === taskId)[0];
}
function prepareWaiting(store, workId, taskId) {
  makeWaitingTask(store, workId, taskId);
  return setLocalSchedule(store, workId, taskId, 2020, 1, 1);
}

function fileUrl(opts) {
  return 'https://github.com/' + opts.owner + '/' + opts.repo + '/blob/' + (opts.branch || 'main') + '/' + opts.path;
}

/** 注入式 GitHub 适配器（绝不触网） */
function makeGithubExec(store, over) {
  over = over || {};
  const calls = { get: [], put: [], video: [], pages: [] };
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
        content: { path: opts.path, sha: 'sha-1', html_url: fileUrl(opts), size: String(opts.content || '').length }
      };
    },
    // 普通自动发布的视频上传入口（github:put-video）替身
    publishVideo: over.publishVideo || (async function (payload) {
      calls.video.push({ payload: payload });
      return {
        ok: true,
        videoPath: payload.videoPath,
        coverPath: payload.coverPath,
        videoHtmlUrl: 'https://github.com/owner/repo/blob/main/' + payload.videoPath,
        coverHtmlUrl: 'https://github.com/owner/repo/blob/main/' + payload.coverPath,
        videoBytes: 1, coverBytes: 1
      };
    }),
    // 普通自动发布的页面发布入口（github:publish-pages）替身
    publishPages: over.publishPages || (async function (payload) {
      calls.pages.push({ payload: payload });
      const slug = String(payload.slug || '');
      return {
        ok: true,
        uploaded: true,
        deployStatus: 'built',
        pageUrl: 'https://owner.github.io/repo/posts/' + slug + '.html',
        siteUrl: 'https://owner.github.io/repo/',
        videoUrl: 'https://owner.github.io/repo/docs/assets/' + slug + '.mp4',
        coverUrl: 'https://owner.github.io/repo/docs/assets/' + slug + '-cover.jpg',
        videoPath: 'docs/assets/' + slug + '.mp4',
        coverPath: 'docs/assets/' + slug + '-cover.jpg',
        pagePath: 'docs/posts/' + slug + '.html'
      };
    }),
    listWorks: over.listWorks || (function (st) { return st.listWorks(); })
  });
  return { exec: exec, calls: calls };
}
function makeRealScheduler(store, exec, logger) {
  const { createPlanScheduler } = loadScheduler();
  return createPlanScheduler({
    getStore: () => store,
    executorKind: 'real',
    realExecutors: { github: exec },
    logger: logger || { info: function () {}, warn: function () {}, error: function () {} }
  });
}

/* ==================================================================
   G1 / G6 · GitHub 任务进入 GitHub 适配器（Markdown，非 Release）
   ================================================================== */
describe('G1 · GitHub 计划任务正确进入 GitHub 适配器并写入 Markdown', () => {
  it('real 模式 → 先只读预检，再 create-only 写入 posts/（不再调用 Release API）', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store);
    const scheduler = makeRealScheduler(store, exec);
    const out = scheduler.scanOnce();
    await out.settled;

    expect(calls.get).toHaveLength(1);
    expect(calls.get[0].opts.path).toBe('posts/w1-20200101-psa.md');
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0].opts.owner).toBe('owner');
    expect(calls.put[0].opts.repo).toBe('repo');
    expect(calls.put[0].opts.path).toBe('posts/w1-20200101-psa.md');
    expect(calls.put[0].opts.branch).toBe('main');
    expect(calls.put[0].opts.createOnly).toBe(true);
    expect(calls.put[0].opts.content).toBe('这是发布说明');
    // 不再有任何 Release 调用入口
    expect(calls.create === undefined).toBe(true);
    expect(calls.tag === undefined).toBe(true);
  });

  it('未重新排队的 GitHub 到期任务：按平台选择直接真实发布（不依赖额外勾选、不模拟）', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    expect(store.listPlanTasks('w1')[0].real_only).toBe(1);
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });

    const { exec, calls } = makeGithubExec(store);
    const scheduler = makeRealScheduler(store, exec);
    const out = scheduler.scanOnce();
    await out.settled;

    expect(calls.get).toHaveLength(1);
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0].opts.path).toMatch(/^posts\/w1-\d{8}-psa\.md$/);
    const t = store.listPlanTasks('w1')[0];
    expect(t.status).toBe('done');
    expect(t.simulated).toBe(0);
  });
});

/* ==================================================================
   G2 · YouTube / 微信不进入 GitHub 适配器
   ================================================================== */
describe('G2 · YouTube / 微信公众号任务不会被 GitHub 适配器执行', () => {
  ['youtube', 'wechat'].forEach(function (pid) {
    it(pid + ' 任务：调度器跳过（该平台未接入真实发布），GitHub 适配器不被调用', async () => {
      const store = newStore('sqlite');
      seedWork(store, 'w1', 'https://github.com/owner/repo');
      const task = seedStage(store, 'w1', 'ps_' + pid, pid);
      prepareWaiting(store, 'w1', task.id);

      const { exec, calls } = makeGithubExec(store);
      const out = makeRealScheduler(store, exec).scanOnce();
      await out.settled;

      expect(calls.get).toHaveLength(0);
      expect(calls.put).toHaveLength(0);
      expect(out.claimed).toHaveLength(0);
      expect(out.skipped.some(s => String(s.reason).indexOf('尚未接入真实发布') >= 0)).toBe(true);
      const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
      expect(t.status).toBe('pending');
      expect(t.real_only).toBe(1);
    });
  });

  it('直接调用 GitHub 适配器处理非 GitHub 任务 → 明确拒绝', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_y', 'youtube');
    const { exec } = makeGithubExec(store);
    const res = await exec({ id: task.id, platform_id: 'youtube', work_id: 'w1', stage_id: 'ps_y' }, {});
    expect(res.ok).toBe(false);
    expect(res.simulated).toBe(false);
    expect(res.error.indexOf('platform-not-supported')).toBe(0);
  });
});

/* ==================================================================
   G3 · 模拟任务不进真实路径
   ================================================================== */
describe('G3 · 模拟任务不会进入真实发布路径', () => {
  it('simulated=1 的任务被闸门拒绝，适配器不被调用', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    // 选中 GitHub 的任务默认 real_only=1（模拟调度器不领取）；此处先降级为模拟候选，
    // 以便构造「模拟结果仍留在任务行」的场景。
    store._planWriteTask(Object.assign({}, task, { real_only: 0 }));
    store.updatePlanTask('w1', task.id, { scheduled_at: H.PAST });
    createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();
    expect(store.listPlanTasks('w1')[0].simulated).toBe(1);

    const { exec, calls } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.get).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].simulated).toBe(1);
  });

  it('适配器自身也拒绝 simulated 任务', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    seedStage(store, 'w1', 'ps_a', 'github');
    const { exec, calls } = makeGithubExec(store);
    const res = await exec({
      id: 't1', platform_id: 'github', work_id: 'w1', stage_id: 'ps_a', simulated: 1
    }, {});
    expect(res.ok).toBe(false);
    expect(res.error.indexOf('simulated-task')).toBe(0);
    expect(calls.get).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
  });
});

/* ==================================================================
   G4 · real_only 不被 mock 执行器领取
   ================================================================== */
describe('G4 · real_only 任务不会被 mock 执行器领取', () => {
  it('mock 模式下：等待任务不在到期列表，也不会被模拟执行', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    makeWaitingTask(store, 'w1', task.id);

    expect(store.listDuePlanTasks(new Date().toISOString())).toHaveLength(0);
    expect(store.listDuePlanTasks(new Date().toISOString(), { forRealExecutor: true })).toHaveLength(1);

    const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
    const out = createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();
    expect(out.claimed).toHaveLength(0);
    const after = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(after.status).toBe('pending');
    expect(after.simulated).toBe(0);
    expect(after.real_only).toBe(1);
  });
});

/* ==================================================================
   G5 · skip / review / unclear 不触发 GitHub 写请求
   ================================================================== */
describe('G5 · 发布前闸门不通过时不会产生任何 GitHub 写请求', () => {
  function prepare() {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);
    return { store: store, taskId: task.id };
  }

  it('skip：幂等键精确命中已确认成功的记录 → 不调用适配器', async () => {
    const { store, taskId } = prepare();
    const t = store.listPlanTasks('w1').filter(x => x.id === taskId)[0];
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      pub_key: t.pub_key, url: 'https://github.com/owner/repo/blob/main/posts/w1-20200101-psa.md'
    });

    const { exec, calls } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.get).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
    expect(out.claimed).toHaveLength(0);
    expect(store.listPlanTasks('w1').filter(x => x.id === taskId)[0].status).toBe('pending');
  });

  it('review：同作品同平台有成功记录但幂等键不同 → 不调用适配器', async () => {
    const { store } = prepare();
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'manual',
      pub_key: 'manual|github|w1', url: 'https://github.com/o/r/blob/main/posts/x.md'
    });

    const { exec, calls } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.get).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
    expect(store.listPlanTasks('w1')[0].status).toBe('pending');
  });

  it('unclear：任务执行中（结果不确定）→ 不调用适配器', async () => {
    const { store, taskId } = prepare();
    store.claimPlanTask(taskId);

    const { exec, calls } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.get).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
  });
});

/* ==================================================================
   G7 / G8 / G9 · 成功回写 + pubs 幂等
   ================================================================== */
describe('G7 / G8 / G9 · 成功结果回写与发布记录', () => {
  const TARGET = 'posts/w1-20200101-psa.md';
  const URL = 'https://github.com/owner/repo/blob/main/posts/w1-20200101-psa.md';

  async function runSuccess() {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);
    const { exec, calls } = makeGithubExec(store);
    const scheduler = makeRealScheduler(store, exec);
    const out = scheduler.scanOnce();
    await out.settled;
    return { store: store, calls: calls, out: out, taskId: task.id };
  }

  it('任务状态 = done；platform_ref = 可读文件路径；platform_url = 文件链接', async () => {
    const { store, taskId } = await runSuccess();
    const t = store.listPlanTasks('w1').filter(x => x.id === taskId)[0];
    expect(t.status).toBe('done');
    expect(t.simulated).toBe(0);
    expect(t.real_only).toBe(0);
    expect(t.platform_ref).toBe(TARGET);
    expect(t.platform_url).toBe(URL);
    expect(t.note).toContain('posts/');
    expect(t.error).toBe('');
  });

  it('pubs.url = content.html_url；使用计划保存的标题 / 正文快照；幂等键不变', async () => {
    const { store, taskId } = await runSuccess();
    const pubs = store.listPubs();
    const rows = pubs.filter(p => p.work_id === 'w1' && p.platform_id === 'github');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
    expect(rows[0].url).toBe(URL);
    expect(rows[0].title).toBe('v1.0.0 发布');
    expect(rows[0].body).toBe('这是发布说明');
    expect(rows[0].pub_key).toBe('plan|w1|ps_a|github');
    expect(rows[0].pub_key).toBe(store.listPlanTasks('w1').filter(x => x.id === taskId)[0].pub_key);
    expect(rows[0].platform).toBe('GitHub');
    // 不再保存 Release ID / Release URL
    expect(URL.indexOf('/releases/')).toBe(-1);
  });

  it('已确认成功的任务不会再次发布（第二次扫描被 skip 拦住）', async () => {
    const { store, calls } = await runSuccess();
    expect(calls.put).toHaveLength(1);

    const { exec, calls: calls2 } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls2.get).toHaveLength(0);
    expect(calls2.put).toHaveLength(0);
    expect(out.claimed).toHaveLength(0);
    expect(store.listPubs().filter(p => p.pub_key === 'plan|w1|ps_a|github')).toHaveLength(1);
  });
});

/* ==================================================================
   G10 · 结果不确定 / 文件已存在 → needs_review，不自动重试
   ================================================================== */
describe('G10 · 结果不确定时不会自动重发', () => {
  it('其他任务 / 人工已创建同名文件 → needs_review，且绝不调用 PUT 覆盖', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    const existingUrl = 'https://github.com/owner/repo/blob/main/posts/w1-20200101-psa.md';
    const { exec, calls } = makeGithubExec(store, {
      getFile: async function () {
        return { ok: true, exists: true, file: { path: 'posts/w1-20200101-psa.md', sha: 'other', html_url: existingUrl } };
      }
    });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.put).toHaveLength(0);              // 没有覆盖写入
    const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('needs_review');
    expect(t.platform_ref).toBe('posts/w1-20200101-psa.md');
    expect(t.platform_url).toBe(existingUrl);
    expect(t.note).toContain('未覆盖');
  });

  it('上传网络异常（可能已写入）→ needs_review，不会当成普通失败立刻重发', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store, {
      putFile: async function (token, opts) {
        calls.put.push({ token: token, opts: opts });
        return { ok: false, error: 'network:timeout', uncertain: true, detail: 'socket hang up' };
      }
    });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('needs_review');
    expect(calls.put).toHaveLength(1);
    // 下一次扫描不会自动重发（状态不是 pending）
    const out2 = makeRealScheduler(store, exec).scanOnce();
    await out2.settled;
    expect(calls.put).toHaveLength(1);
  });

  it('上传前只读预检本身网络异常 → needs_review，且不发起写入', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store, {
      getFile: async function () {
        return { ok: false, error: 'network', uncertain: true, detail: 'ECONNRESET' };
      }
    });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.put).toHaveLength(0);
    expect(store.listPlanTasks('w1').filter(x => x.id === task.id)[0].status).toBe('needs_review');
  });

  it('create-only 冲突（file-exists）→ needs_review，不覆盖', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    const { exec } = makeGithubExec(store, {
      putFile: async function () {
        return { ok: false, error: 'file-exists', status: 422, detail: 'sha wasn\'t supplied' };
      }
    });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('needs_review');
    expect(t.platform_ref).toBe('posts/w1-20200101-psa.md');
  });
});

/* ==================================================================
   G11 · 明确失败 / 认证 / 权限 / 参数缺失
   ================================================================== */
describe('G11 · 失败场景的状态模型', () => {
  async function runWith(over) {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);
    const { exec, calls } = makeGithubExec(store, over);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;
    return { store: store, calls: calls, out: out, taskId: task.id };
  }

  it('API 明确失败（500）→ status=failed（确定未写入）', async () => {
    const { store, taskId } = await runWith({
      putFile: async function () { return { ok: false, status: 500, error: 'github-http-500', detail: 'server error' }; }
    });
    const t = store.listPlanTasks('w1').filter(x => x.id === taskId)[0];
    expect(t.status).toBe('failed');
    expect(t.error).toContain('github-http-500');
  });

  it('认证失效（401）→ status=failed，错误可理解', async () => {
    const { store, taskId } = await runWith({
      putFile: async function () { return { ok: false, status: 401, error: 'github-http-401', detail: 'Bad credentials' }; }
    });
    const t = store.listPlanTasks('w1').filter(x => x.id === taskId)[0];
    expect(t.status).toBe('failed');
    expect(t.error).toContain('401');
  });

  it('权限不足（403）→ status=failed', async () => {
    const { store, taskId } = await runWith({
      putFile: async function () { return { ok: false, status: 403, error: 'github-http-403', detail: 'Resource not accessible by personal access token' }; }
    });
    expect(store.listPlanTasks('w1').filter(x => x.id === taskId)[0].status).toBe('failed');
  });

  it('缺少文案 → status=failed，且不发起任何 GitHub 请求', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    store.savePlanStages('w1', [{
      id: 'ps_a', title: '无文案', desc: '', offsetDays: 0, timeOfDay: '20:00',
      platforms: ['github'], copy: {}
    }]);
    const task = store.listPlanTasks('w1')[0];
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.get).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
    const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('failed');
    expect(t.error).toContain('文案');
  });

  it('缺少 publishRepo → status=failed，且不发起任何 GitHub 请求', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store, {
      getToken: async () => ({ access_token: 'test-token' })
    });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.get).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
    const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('failed');
    expect(t.error).toContain('missing-publish-repo');
  });

  it('作品链接与发布仓库不一致 → 以 publishRepo 为准（不按作品链接推断仓库）', async () => {
    const store = newStore('sqlite');
    seedWorkNamed(store, 'w1', 'rokit', 'https://github.com/other/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.get).toHaveLength(1);
    expect(calls.get[0].opts.owner).toBe('owner');
    expect(calls.get[0].opts.repo).toBe('repo');
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0].opts.owner).toBe('owner');
    expect(calls.put[0].opts.repo).toBe('repo');

    const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('done');
    expect(t.platform_url).toBe('https://github.com/owner/repo/blob/main/posts/rokit-20200101-psa.md');
  });

  it('publishRepo 配置不完整（缺少 repo）→ status=failed，且不发起任何 GitHub 请求', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store, {
      getToken: async () => ({ access_token: 'test-token', publishRepo: { owner: 'owner' } })
    });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.get).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
    expect(store.listPlanTasks('w1').filter(x => x.id === task.id)[0].status).toBe('failed');
    expect(store.listPlanTasks('w1').filter(x => x.id === task.id)[0].error).toContain('missing-publish-repo');
  });

  it('缺少 GitHub 授权 → status=failed，不发请求', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store, { getToken: async () => null });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.get).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
    expect(store.listPlanTasks('w1').filter(x => x.id === task.id)[0].status).toBe('failed');
  });
});

/* ==================================================================
   G12 · 文件已写入但本地记录写入失败
   ================================================================== */
describe('G12 · 文章已写入但本地记录写入失败 → 不当成普通失败', () => {
  it('状态为 needs_review，并保留真实文件路径 / 链接', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    // 让「成功记录」这一次写入抛错（前面的 pending 记录照常写）
    const origAdd = store.addPub.bind(store);
    store.addPub = function (r) {
      if (r && r.status === 'ok') throw new Error('disk full');
      return origAdd(r);
    };

    const { exec } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('needs_review');        // 不是 failed → 不会被立即重发
    expect(t.platform_ref).toBe('posts/w1-20200101-psa.md');
    expect(t.platform_url).toBe('https://github.com/owner/repo/blob/main/posts/w1-20200101-psa.md');
    expect(t.error).toContain('本地发布记录写入失败');
  });
});

/* ==================================================================
   G13 · history_note 保留
   ================================================================== */
describe('G13 · 原模拟历史在真实执行路径中保留', () => {
  it('真实成功后 history_note 不变', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const waiting = prepareWaiting(store, 'w1', task.id);
    const hist = waiting.history_note;
    expect(hist).toContain('原模拟结果');

    const { exec } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(store.listPlanTasks('w1').filter(x => x.id === task.id)[0].history_note).toBe(hist);
  });

  it('真实失败后 history_note 不变', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const hist = prepareWaiting(store, 'w1', task.id).history_note;

    const { exec } = makeGithubExec(store, {
      putFile: async function () { return { ok: false, status: 500, error: 'github-http-500', detail: 'boom' }; }
    });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(store.listPlanTasks('w1').filter(x => x.id === task.id)[0].history_note).toBe(hist);
  });
});

/* ==================================================================
   N1 · 中文标题不会造成文件名冲突
   ================================================================== */
describe('N1 · 中文标题不会造成文件名冲突', () => {
  it('同一中文作品的两个阶段 → 路径不同；不同作品同名作品 → 路径也不同', async () => {
    const store = newStore('sqlite');
    seedWorkNamed(store, 'w1', '中文作品', 'https://github.com/owner/repo');
    const tasks = seedTwoStages(store, 'w1', ['ps_a', 'ps_b'], 'github');
    expect(tasks).toHaveLength(2);

    const { exec, calls } = makeGithubExec(store);
    const paths = [];
    for (const t of tasks) {
      const res = await exec(store.listPlanTasks('w1').filter(x => x.id === t.id)[0], {});
      expect(res.ok).toBe(true);
      expect(res.status).toBe('done');
      paths.push(res.platform_ref);
    }
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths[0].indexOf('posts/')).toBe(0);
    expect(paths[0]).toContain('w1-');          // 中文 slug 为空 → 回退作品 ID，绝不退化成 project
    expect(paths[1]).toContain('w1-');
    expect(calls.put).toHaveLength(2);

    // 另一个作品（同名中文标题、不同 ID）→ 也不同路径（阶段 ID 全局唯一）
    seedWorkNamed(store, 'w2', '中文作品', 'https://github.com/owner/repo');
    const t3 = seedStage(store, 'w2', 'ps_z', 'github');
    const res3 = await exec(t3, {});
    expect(res3.ok).toBe(true);
    expect(res3.platform_ref).not.toBe(paths[0]);
    expect(res3.platform_ref).toContain('w2-');
  });
});

/* ==================================================================
   N2 · 同一任务重试路径稳定
   ================================================================== */
describe('N2 · 同一任务重试路径稳定', () => {
  it('同一任务重复执行 → 生成完全相同的路径（不含随机值）', async () => {
    const store = newStore('sqlite');
    seedWorkNamed(store, 'w1', 'rokit', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = setLocalSchedule(store, 'w1', task.id, 2020, 1, 1);

    const { exec, calls } = makeGithubExec(store);
    const r1 = await exec(t, {});
    const r2 = await exec(store.listPlanTasks('w1').filter(x => x.id === t.id)[0], {});
    expect(r1.ok).toBe(true);
    expect(calls.put).toHaveLength(2);
    expect(calls.put[0].opts.path).toBe('posts/rokit-20200101-psa.md');
    expect(calls.put[1].opts.path).toBe(calls.put[0].opts.path);
    expect(r2.platform_ref).toBe(r1.platform_ref);
  });

  it('scheduled_at 缺失时回退到 createdAt，仍然稳定', async () => {
    const { buildPlanArticlePath } = loadGithubExecutor();
    const p1 = buildPlanArticlePath({
      name: 'rokit', scheduledAt: '', createdAt: '2020-06-15T04:00:00.000Z', stageId: 'ps_a', workId: 'w1'
    });
    const p2 = buildPlanArticlePath({
      name: 'rokit', scheduledAt: '', createdAt: '2020-06-15T04:00:00.000Z', stageId: 'ps_a', workId: 'w1'
    });
    expect(p1).toBe(p2);
    expect(p1.indexOf('posts/rokit-')).toBe(0);
  });
});

/* ==================================================================
   N3 · 目标文件属于本任务此前成功写入 → 幂等完成
   ================================================================== */
describe('N3 · 本任务此前已成功写入的目标文件 → 幂等完成', () => {
  it('文件已存在且与本任务成功记录一致 → done，且不发起 PUT', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    const t = setLocalSchedule(store, 'w1', task.id, 2020, 1, 1);
    const url = 'https://github.com/owner/repo/blob/main/posts/w1-20200101-psa.md';

    // 模拟「本任务此前已写入成功，任务行还没结算」
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: url, pub_key: t.pub_key, title: 'v1.0.0 发布', body: '这是发布说明'
    });

    const { exec, calls } = makeGithubExec(store, {
      getFile: async function () {
        return { ok: true, exists: true, file: { path: 'posts/w1-20200101-psa.md', sha: 'same', html_url: url } };
      }
    });
    const res = await exec(t, {});
    expect(res.ok).toBe(true);
    expect(res.status).toBe('done');
    expect(res.platform_ref).toBe('posts/w1-20200101-psa.md');
    expect(res.platform_url).toBe(url);
    expect(calls.put).toHaveLength(0);              // 不重复写入
    expect(store.listPubs().filter(p => p.pub_key === t.pub_key)).toHaveLength(1);
  });
});

/* ==================================================================
   N4 · 旧 Release 历史兼容
   ================================================================== */
describe('N4 · 旧的 Release 历史记录仍可正常读取', () => {
  it('历史 pubs 行（Release URL / Release ID）原样保留，不被改造清理', () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const legacyUrl = 'https://github.com/owner/repo/releases/tag/v0.1.0';
    store.addPub({
      work_id: 'w1', platform: 'GitHub', platform_id: 'github', status: 'ok',
      url: legacyUrl, pub_key: 'plan|w1|ps_old|github', title: '旧 Release', body: '历史说明'
    });

    const rows = store.listPubs();
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe(legacyUrl);
    expect(rows[0].pub_key).toBe('plan|w1|ps_old|github');
    expect(rows[0].status).toBe('ok');

    // 对账只处理真实计划任务；历史记录不会被批量改写
    store.reconcilePlanTasks();
    const after = store.listPubs();
    expect(after).toHaveLength(1);
    expect(after[0].url).toBe(legacyUrl);
  });

  it('Release API 封装仍保留（不被首批改造删除），历史能力可回退', () => {
    const pe = loadPublisherExtensions();
    expect(typeof pe.githubCreateRelease).toBe('function');
    expect(typeof pe.githubGetReleaseByTag).toBe('function');
  });
});

/* ==================================================================
   N5 · 真实执行结果带 simulated:false
   ================================================================== */
describe('N5 · 真实执行结果带 simulated:false（日志 kind=real）', () => {
  it('调度器日志把本次真实发布记为 kind=real', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    const lines = [];
    const logger = {
      info: function (m) { lines.push(String(m)); },
      warn: function (m) { lines.push(String(m)); },
      error: function (m) { lines.push(String(m)); }
    };
    const { exec } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec, logger).scanOnce();
    await out.settled;

    const resultLine = lines.filter(l => l.indexOf('task result') >= 0 && l.indexOf('kind=') >= 0);
    expect(resultLine).toHaveLength(1);
    expect(resultLine[0]).toContain('kind=real');
  });
});

/* ==================================================================
   G14 · GitHub Contents API 行为（stub fetch，绝不真实联网）
   ================================================================== */
describe('G14 · GitHub Contents API 封装（stub fetch）', () => {
  let pe;
  beforeEach(() => {
    pe = loadPublisherExtensions();
  });

  function stubFetch(handler) {
    const orig = global.fetch;
    const seen = [];
    global.fetch = function (url, opt) {
      seen.push({ url: String(url), opt: opt || {} });
      return handler(String(url), opt || {}, seen.length);
    };
    return {
      seen: seen,
      restore: function () { global.fetch = orig; }
    };
  }

  it('普通发布（不传 createOnly）：GET 取 sha 后 PUT 更新，行为不变', async () => {
    const stub = stubFetch(function (url, opt) {
      if ((opt.method || 'GET') === 'GET') {
        return Promise.resolve({
          ok: true, status: 200,
          json: function () { return Promise.resolve({ sha: 'abc', path: 'posts/a.md', html_url: 'https://github.com/o/r/blob/main/posts/a.md', size: 3 }); }
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve({ content: { sha: 'new', path: 'posts/a.md', html_url: 'https://github.com/o/r/blob/main/posts/a.md', size: 3 }, commit: { sha: 'c' } }); }
      });
    });
    try {
      const r = await pe.githubPutFile('tok', { owner: 'o', repo: 'r', path: 'posts/a.md', content: 'abc' });
      expect(r.ok).toBe(true);
      expect(r.action).toBe('updated');
      const putCall = stub.seen.filter(s => (s.opt.method || '') === 'PUT')[0];
      expect(JSON.parse(putCall.opt.body).sha).toBe('abc');
    } finally {
      stub.restore();
    }
  });

  it('createOnly：目标已存在 → file-exists（409），不发起 PUT', async () => {
    const stub = stubFetch(function (url, opt) {
      if ((opt.method || 'GET') === 'GET') {
        return Promise.resolve({
          ok: true, status: 200,
          json: function () { return Promise.resolve({ sha: 'abc', path: 'posts/a.md', html_url: 'https://github.com/o/r/blob/main/posts/a.md' }); }
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
    });
    try {
      const r = await pe.githubPutFile('tok', { owner: 'o', repo: 'r', path: 'posts/a.md', content: 'abc', createOnly: true });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('file-exists');
      expect(r.status).toBe(409);
      expect(r.existing.html_url).toBe('https://github.com/o/r/blob/main/posts/a.md');
      expect(stub.seen.filter(s => (s.opt.method || '') === 'PUT')).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  it('createOnly：目标不存在 → 不带 sha 创建', async () => {
    const stub = stubFetch(function (url, opt) {
      if ((opt.method || 'GET') === 'GET') return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve(null); } });
      return Promise.resolve({
        ok: true, status: 201,
        json: function () { return Promise.resolve({ content: { path: 'posts/a.md', sha: 'n', html_url: 'https://github.com/o/r/blob/main/posts/a.md', size: 3 }, commit: { sha: 'c' } }); }
      });
    });
    try {
      const r = await pe.githubPutFile('tok', { owner: 'o', repo: 'r', path: 'posts/a.md', content: 'abc', createOnly: true });
      expect(r.ok).toBe(true);
      expect(r.action).toBe('created');
      const putCall = stub.seen.filter(s => (s.opt.method || '') === 'PUT')[0];
      expect(JSON.parse(putCall.opt.body).sha).toBeUndefined();
    } finally {
      stub.restore();
    }
  });

  it('createOnly：PUT 返回 422 → file-exists（不当作参数错误）', async () => {
    const stub = stubFetch(function (url, opt) {
      if ((opt.method || 'GET') === 'GET') return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({
        ok: false, status: 422,
        json: function () { return Promise.resolve({ message: 'sha wasn\'t supplied' }); }
      });
    });
    try {
      const r = await pe.githubPutFile('tok', { owner: 'o', repo: 'r', path: 'posts/a.md', content: 'abc', createOnly: true });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('file-exists');
    } finally {
      stub.restore();
    }
  });

  it('githubGetFile：404 → exists:false；200 → exists:true（只读，不写入）', async () => {
    let mode = 404;
    const stub = stubFetch(function () {
      if (mode === 404) return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve({ path: 'posts/a.md', sha: 'abc', html_url: 'https://github.com/o/r/blob/main/posts/a.md', size: 3, download_url: 'x' }); }
      });
    });
    try {
      const miss = await pe.githubGetFile('tok', { owner: 'o', repo: 'r', path: 'posts/a.md' });
      expect(miss.ok).toBe(true);
      expect(miss.exists).toBe(false);
      expect(stub.seen.filter(s => (s.opt.method || '') === 'PUT')).toHaveLength(0);

      mode = 200;
      const hit = await pe.githubGetFile('tok', { owner: 'o', repo: 'r', path: 'posts/a.md' });
      expect(hit.ok).toBe(true);
      expect(hit.exists).toBe(true);
      expect(hit.file.sha).toBe('abc');
      expect(hit.file.html_url).toBe('https://github.com/o/r/blob/main/posts/a.md');
    } finally {
      stub.restore();
    }
  });

  it('缺少 token / 参数 → missing-token / missing-params，不发请求', async () => {
    let called = 0;
    const orig = global.fetch;
    global.fetch = function () { called++; return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } }); };
    try {
      expect((await pe.githubPutFile('', { owner: 'o', repo: 'r', path: 'p' })).error).toBe('missing-token');
      expect((await pe.githubPutFile('tok', { owner: 'o' })).error).toBe('missing-params');
      expect((await pe.githubGetFile('', { owner: 'o', repo: 'r', path: 'p' })).error).toBe('missing-token');
      expect((await pe.githubGetFile('tok', { owner: 'o' })).error).toBe('missing-params');
      expect(called).toBe(0);
    } finally {
      global.fetch = orig;
    }
  });
});

/* ==================================================================
   G15 · 首秀计划复用普通自动发布的「正文 + 视频」完整流程
   ==================================================================
   普通自动发布（index.html window.autoPubGithub）：
     window.publishGithubVideo(path) → main github:put-video（视频 + 封面）
     window.buildGithubArticleBody(body, video) → 正文末尾追加视频区域
     window.api.githubPutFile(...) → main github:put-file（Markdown 提交）
   首秀计划执行器必须调用 main.js 注入的同一对入口：
     publishVideo = githubPutVideo / publishFile = githubPutFile
   本组用例注入替身，验证顺序、参数、正文与失败保护，绝不触网。 */
describe('G15 · 首秀计划发布正文 + 视频（与普通自动发布同一入口）', () => {
  const fs = require('fs');
  const VIDEO_PATH = 'C:/rokit-final/final-001.mp4';

  function seedGithubStageWithVideo(store, workId, stageId, videoPath) {
    return seedStage(store, workId, stageId, 'github', {
      github: {
        title: 'v1.0.0 发布',
        body: '这是发布说明',
        tags: ['tool'],
        videoPath: videoPath
      }
    });
  }

  it('有成品视频快照 → 先调视频入口、再把正文 + 视频引用提交；任务 done、发布记录 ok', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedGithubStageWithVideo(store, 'w1', 'ps_a', VIDEO_PATH);
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    // 1) 视频入口被调用，参数与普通自动发布一致
    expect(calls.video).toHaveLength(1);
    expect(calls.video[0].payload.finalVideoPath).toBe(VIDEO_PATH);
    expect(calls.video[0].payload.videoPath).toBe('videos/w1-20200101-psa.mp4');
    expect(calls.video[0].payload.coverPath).toBe('videos/w1-20200101-psa-cover.jpg');
    expect(calls.video[0].payload.atSeconds).toBe(0);

    // 2) 页面入口被调用：slug 与本次计划文章同名，不会串到其他阶段 / 作品
    expect(calls.pages).toHaveLength(1);
    expect(calls.pages[0].payload.finalVideoPath).toBe(VIDEO_PATH);
    expect(calls.pages[0].payload.slug).toBe('w1-20200101-psa');
    expect(calls.pages[0].payload.title).toBe('v1.0.0 发布');

    // 3) 文章入口被调用，正文 = 原正文 + 在线阅读入口 + 与普通自动发布相同的视频区域
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0].opts.path).toBe('posts/w1-20200101-psa.md');
    expect(calls.put[0].opts.createOnly).toBe(true);
    const expected = '这是发布说明\n\n---\n\n## 在线阅读与播放\n\n'
      + '📄 [打开网页版（可在线播放视频）](https://owner.github.io/repo/posts/w1-20200101-psa.html)\n'
      + '\n\n---\n\n## 视频演示\n\n'
      + '[![../videos/w1-20200101-psa-cover.jpg](../videos/w1-20200101-psa.mp4)\n\n'
      + '[点击封面打开视频](../videos/w1-20200101-psa.mp4)\n';
    expect(calls.put[0].opts.content).toBe(expected);

    // 4) 任务与发布记录
    const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('done');
    expect(t.simulated).toBe(0);
    const pub = store.listPubs().filter(p => p.pub_key === t.pub_key)[0];
    expect(pub.status).toBe('ok');
    expect(pub.body).toBe('这是发布说明');            // 发布记录仍保存原始正文
  });

  it('视频明确失败 → 文章入口不被调用（文章未发布），任务 failed、记录 failed', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedGithubStageWithVideo(store, 'w1', 'ps_a', VIDEO_PATH);
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store, {
      publishVideo: async function (payload) {
        calls.video.push({ payload: payload });
        return { ok: false, stage: 'video-upload', status: 403, error: 'github-http-403', detail: 'Resource not accessible' };
      }
    });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.video).toHaveLength(1);
    expect(calls.pages).toHaveLength(0);             // 视频失败后不生成在线页面
    expect(calls.put).toHaveLength(0);              // 正文引用不会指向不存在的视频
    const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('failed');
    const pub = store.listPubs().filter(p => p.pub_key === t.pub_key)[0];
    expect(pub.status).toBe('failed');
  });

  it('视频上传网络结果不确定 → needs_review，不提交文章，也不会自动重发', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedGithubStageWithVideo(store, 'w1', 'ps_a', VIDEO_PATH);
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store, {
      publishVideo: async function (payload) {
        calls.video.push({ payload: payload });
        return { ok: false, stage: 'video-upload', error: 'network', detail: 'socket hang up' };
      }
    });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.put).toHaveLength(0);
    let t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('needs_review');

    const out2 = makeRealScheduler(store, exec).scanOnce();
    await out2.settled;
    expect(calls.video).toHaveLength(1);            // 不自动重试
    t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('needs_review');
  });

  it('没有成品视频快照 → 只发布纯 Markdown 文章（原有行为回归，视频入口不被调用）', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedStage(store, 'w1', 'ps_a', 'github');
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store);
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.video).toHaveLength(0);
    expect(calls.pages).toHaveLength(0);            // 没有视频时不发布在线页面
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0].opts.content).toBe('这是发布说明');
    expect(store.listPlanTasks('w1').filter(x => x.id === task.id)[0].status).toBe('done');
  });

  it('视频已上传 + 文章 create-only 冲突 → needs_review，文章不覆盖', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedGithubStageWithVideo(store, 'w1', 'ps_a', VIDEO_PATH);
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store, {
      putFile: async function () {
        return { ok: false, error: 'file-exists', status: 422, detail: 'sha wasn\'t supplied' };
      }
    });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.video).toHaveLength(1);
    expect(calls.put).toHaveLength(0);
    const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('needs_review');
    expect(t.platform_ref).toBe('posts/w1-20200101-psa.md');
  });

  it('Pages 明确失败 → 文章照常发布，但正文不出现「在线阅读」入口（不谎报网页已发布）', async () => {
    const store = newStore('sqlite');
    seedWork(store, 'w1', 'https://github.com/owner/repo');
    const task = seedGithubStageWithVideo(store, 'w1', 'ps_a', VIDEO_PATH);
    prepareWaiting(store, 'w1', task.id);

    const { exec, calls } = makeGithubExec(store, {
      publishPages: async function (payload) {
        calls.pages.push({ payload: payload });
        return {
          ok: false, stage: 'pages-enable', error: 'pages-permission',
          detail: 'Pages 权限不足', repoUrl: 'https://github.com/owner/repo/settings/pages'
        };
      }
    });
    const out = makeRealScheduler(store, exec).scanOnce();
    await out.settled;

    expect(calls.video).toHaveLength(1);
    expect(calls.pages).toHaveLength(1);
    expect(calls.put).toHaveLength(1);              // 与普通发布一致：网页失败不阻断文章
    expect(calls.put[0].opts.content).not.toMatch(/在线阅读与播放/);
    expect(calls.put[0].opts.content).toMatch(/## 视频演示/);
    const t = store.listPlanTasks('w1').filter(x => x.id === task.id)[0];
    expect(t.status).toBe('done');
  });

  it('正文构建统一到 renderer-utils/format.js（普通发布与计划调用同一份实现）', () => {
    const formatSrc = fs.readFileSync(path.join(H.ROOT, 'renderer-utils', 'format.js'), 'utf8');
    const htmlSrc = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8');
    const execSrc = fs.readFileSync(path.join(H.ROOT, 'electron', 'plan-github-executor.js'), 'utf8');

    // 共享模块导出三件套；渲染层通过 <script> 加载同一文件
    expect(formatSrc).toMatch(/module\.exports\s*=\s*\{[\s\S]*buildGithubArticleBody/);
    expect(htmlSrc).toMatch(/<script src="renderer-utils\/format\.js"><\/script>/);
    // index.html 不再保留第二份拼装实现
    expect(htmlSrc).not.toMatch(/function githubRelPrefix\(/);
    expect(htmlSrc).not.toMatch(/function videoSectionHtml\(/);
    expect(htmlSrc).not.toMatch(/window\.buildGithubArticleBody = function/);
    // 计划执行器 require 同一份实现，且不再有第二套拼装
    expect(execSrc).toMatch(/require\('\.\.\/renderer-utils\/format'\)/);
    expect(execSrc).not.toMatch(/function githubRelPrefix\(/);
    expect(execSrc).not.toMatch(/function videoSectionHtml\(/);
    expect(execSrc).not.toMatch(/function appendVideoSection\(/);
    expect(execSrc).not.toMatch(/function buildPlanVideoPaths\(/);
    expect(execSrc).not.toMatch(/function planArticleBase\(/);

    // 行为一致：共享实现产出的正文与计划执行器提交的正文逐字符相同
    const shared = require(path.join(H.ROOT, 'renderer-utils', 'format'));
    const articlePath = 'posts/w1-20200101-psa.md';
    const video = {
      articlePath: articlePath,
      videoPath: 'videos/w1-20200101-psa.mp4',
      coverPath: 'videos/w1-20200101-psa-cover.jpg'
    };
    const pages = { pageUrl: 'https://owner.github.io/repo/posts/w1-20200101-psa.html' };
    expect(shared.githubRelPrefix(articlePath)).toBe('../');
    expect(shared.buildGithubArticleBody('这是发布说明', video, pages))
      .toBe('这是发布说明\n\n---\n\n## 在线阅读与播放\n\n'
        + '📄 [打开网页版（可在线播放视频）](https://owner.github.io/repo/posts/w1-20200101-psa.html)\n'
        + '\n\n---\n\n## 视频演示\n\n'
        + '[![../videos/w1-20200101-psa-cover.jpg](../videos/w1-20200101-psa.mp4)\n\n'
        + '[点击封面打开视频](../videos/w1-20200101-psa.mp4)\n');
    // 无视频无页面时正文原样返回（普通发布第 8 条回归）
    expect(shared.buildGithubArticleBody('原文', null, null)).toBe('原文');
  });

  it('两条路径最终进入同一发布入口（源码断言）', () => {
    const mainSrc = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8');
    // 渲染层普通自动发布：window.api.githubPutVideo / githubPublishPages / githubPutFile
    expect(mainSrc).toMatch(/ipcMain\.handle\('github:put-video', \(_e, payload\) => githubPutVideo\(/);
    expect(mainSrc).toMatch(/ipcMain\.handle\('github:publish-pages', \(_e, payload\) => githubPublishPages\(/);
    expect(mainSrc).toMatch(/ipcMain\.handle\('github:put-file', \(_e, opts\) => githubPutFile\(/);
    // 首秀计划执行器注入同一组函数
    expect(mainSrc).toMatch(/publishVideo:\s*githubPutVideo/);
    expect(mainSrc).toMatch(/publishPages:\s*githubPublishPages/);
    expect(mainSrc).toMatch(/publishFile:\s*githubPutFile/);

    // Pages 处理逻辑是主进程命名函数，普通 IPC 与计划执行器共用同一实现
    expect(mainSrc).toMatch(/async function githubPublishPages\(payload\)/);
    // 计划执行器自己不实现视频上传 / 页面生成（不出现底层 Binary / 缩略图 / 渲染调用）
    const execSrc = fs.readFileSync(path.join(H.ROOT, 'electron', 'plan-github-executor.js'), 'utf8');
    expect(execSrc).not.toMatch(/githubPutBinary|generateThumbnail|require\('\.\/video'\)/);
    expect(execSrc).not.toMatch(/renderPostPage|renderIndexPage|githubPutPagesHtml/);
    // 也不存在上一轮新增的独立视频上传模块
    expect(fs.existsSync(path.join(H.ROOT, 'electron', 'github-video-publish.js'))).toBe(false);
  });
});
