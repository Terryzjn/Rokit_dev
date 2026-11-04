'use strict';

// Rokit · 首秀计划成品视频持久化（第一批）—— 定向测试
//
// 覆盖用户要求的验证点：
//   1  快照为空、作品映射存在 → 能找到视频并执行视频上传 + Pages
//   2  快照存在 → 优先使用快照（不再读取作品映射）
//   3  映射不存在 → 明确记录「本阶段无成品视频，仅发布文章」
//   4  映射存在但文件丢失 / 校验失败 → 按视频失败处理，绝不静默降级
//   5  作品 A 不会读取作品 B 的视频
//   6  生成新视频后更新作品映射（同一作品只保留一个最新视频）
//   +  草稿归属转正时迁移映射（plan:reassign）
//   +  渲染层 / 主进程 / preload 的接线与安全约束（源码断言）
//
// 全部使用临时数据库 + 注入的 mock API，**没有任何真实网络写入**。

const path = require('path');
const fs = require('fs');
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

function seedWork(store, id) {
  return store.saveWork({
    id: id, name: '作品 ' + id, type: 'tool', intro: 'intro', url: '',
    status: '首秀中', queue: '主推', star: 0, dl: 0, play: '0', next: '',
    created_at: new Date().toISOString()
  });
}
function makeStage(stageId, copy) {
  return {
    id: stageId, title: '阶段 ' + stageId, desc: '', offsetDays: 0, timeOfDay: '20:00',
    platforms: ['github'],
    copy: copy || { github: { title: 'v1.0.0 发布', body: '这是发布说明', tags: ['tool'] } }
  };
}
function seedStage(store, workId, stageId, copy) {
  store.savePlanStages(workId, [makeStage(stageId, copy)]);
  return store.listPlanTasks(workId).filter(t => t.platform_id === 'github' && t.stage_id === stageId)[0];
}
function prepareWaiting(store, workId, taskId) {
  const { createPlanScheduler, createMockPlanExecutor } = loadScheduler();
  const cur = store.listPlanTasks(workId).filter(x => x.id === taskId)[0];
  store._planWriteTask(Object.assign({}, cur, { real_only: 0 }));
  store.updatePlanTask(workId, taskId, { scheduled_at: H.PAST });
  createPlanScheduler({ getStore: () => store, executor: createMockPlanExecutor() }).scanOnce();
  const r = store.requeueSimulatedPlanTask(workId, taskId);
  expect(r.ok).toBe(true);
  store.updatePlanTask(workId, taskId, { scheduled_at: new Date(2020, 0, 1, 12, 0, 0).toISOString() });
  return store.listPlanTasks(workId).filter(x => x.id === taskId)[0];
}

/** 注入式 GitHub 适配器（绝不触网）；resolveWorkFinalVideo 由用例替换 */
function makeGithubExec(store, over) {
  over = over || {};
  const calls = { get: [], put: [], video: [], pages: [], resolve: [] };
  const exec = loadGithubExecutor().createGithubPlanExecutor({
    getStore: () => store,
    getToken: async () => ({ access_token: 'test-token', publishRepo: { owner: 'owner', repo: 'repo' } }),
    getFile: async function (token, opts) {
      calls.get.push({ token: token, opts: opts });
      return { ok: true, exists: false };
    },
    publishFile: async function (opts) {
      calls.put.push({ token: 'test-token', opts: opts });
      return {
        ok: true, action: 'created',
        content: { path: opts.path, sha: 'sha-1', html_url: 'https://github.com/owner/repo/blob/main/' + opts.path }
      };
    },
    publishVideo: over.publishVideo || (async function (payload) {
      calls.video.push({ payload: payload });
      return {
        ok: true, videoPath: payload.videoPath, coverPath: payload.coverPath,
        videoHtmlUrl: 'https://github.com/owner/repo/blob/main/' + payload.videoPath,
        coverHtmlUrl: 'https://github.com/owner/repo/blob/main/' + payload.coverPath,
        videoBytes: 1, coverBytes: 1
      };
    }),
    publishPages: over.publishPages || (async function (payload) {
      calls.pages.push({ payload: payload });
      const slug = String(payload.slug || '');
      return {
        ok: true, uploaded: true, deployStatus: 'built',
        pageUrl: 'https://owner.github.io/repo/posts/' + slug + '.html',
        siteUrl: 'https://owner.github.io/repo/',
        videoUrl: 'https://owner.github.io/repo/docs/assets/' + slug + '.mp4',
        coverUrl: 'https://owner.github.io/repo/docs/assets/' + slug + '-cover.jpg',
        videoPath: 'docs/assets/' + slug + '.mp4',
        coverPath: 'docs/assets/' + slug + '-cover.jpg',
        pagePath: 'docs/posts/' + slug + '.html'
      };
    }),
    resolveWorkFinalVideo: async function (workId) {
      calls.resolve.push({ workId: workId });
      if (over.resolveWorkFinalVideo) return over.resolveWorkFinalVideo(workId);
      return { ok: false, error: 'no-final-video', workId: workId };
    },
    listWorks: function (st) { return st.listWorks(); }
  });
  return { exec: exec, calls: calls };
}
function runReal(store, exec) {
  const { createPlanScheduler } = loadScheduler();
  return createPlanScheduler({
    getStore: () => store, executorKind: 'real', realExecutors: { github: exec },
    logger: { info: function () {}, warn: function () {}, error: function () {} }
  }).scanOnce();
}
function taskOf(store, workId, taskId) {
  return store.listPlanTasks(workId).filter(x => x.id === taskId)[0];
}

const SNAPSHOT_VIDEO = 'C:/rokit-final/snapshot-001.mp4';
const WORK_VIDEO = 'C:/rokit-final/work-latest-002.mp4';

/* ==================================================================
   1 · 快照为空 + 作品映射存在 → 视频上传 + Pages
   ================================================================== */
describe('1 · 快照为空但作品映射存在', () => {
  it('从作品最新成品视频回退读取，执行视频上传 + Pages，任务 done', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = prepareWaiting(store, 'w1', seedStage(store, 'w1', 'ps_a', { github: { title: 'v1.0.0 发布', body: '这是发布说明' } }).id);

    const { exec, calls } = makeGithubExec(store, {
      resolveWorkFinalVideo: async function (workId) {
        return { ok: true, workId: workId, path: WORK_VIDEO, size: 1024 };
      }
    });
    const out = runReal(store, exec);
    await out.settled;

    // 映射按 workId 精确读取（不扫描目录、不猜归属）
    expect(calls.resolve).toEqual([{ workId: 'w1' }]);
    expect(calls.video).toHaveLength(1);
    expect(calls.video[0].payload.finalVideoPath).toBe(WORK_VIDEO);
    expect(calls.video[0].payload.videoPath).toBe('videos/w1-20200101-psa.mp4');
    expect(calls.pages).toHaveLength(1);
    expect(calls.pages[0].payload.finalVideoPath).toBe(WORK_VIDEO);
    expect(calls.pages[0].payload.slug).toBe('w1-20200101-psa');
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0].opts.content).toMatch(/## 视频演示/);
    expect(calls.put[0].opts.content).toMatch(/## 在线阅读与播放/);

    const t = taskOf(store, 'w1', task.id);
    expect(t.status).toBe('done');
    expect(t.note).toMatch(/作品最新成品视频/);
  });
});

/* ==================================================================
   2 · 快照存在 → 优先使用快照
   ================================================================== */
describe('2 · 计划快照优先', () => {
  it('快照存在时不读取作品映射，视频使用快照路径', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = prepareWaiting(store, 'w1', seedStage(store, 'w1', 'ps_a', {
      github: { title: 'v1.0.0 发布', body: '这是发布说明', videoPath: SNAPSHOT_VIDEO }
    }).id);

    const { exec, calls } = makeGithubExec(store, {
      resolveWorkFinalVideo: async function () {
        return { ok: true, path: WORK_VIDEO };
      }
    });
    const out = runReal(store, exec);
    await out.settled;

    expect(calls.resolve).toHaveLength(0);           // 快照优先：不读映射
    expect(calls.video).toHaveLength(1);
    expect(calls.video[0].payload.finalVideoPath).toBe(SNAPSHOT_VIDEO);
    expect(calls.pages[0].payload.finalVideoPath).toBe(SNAPSHOT_VIDEO);
    expect(taskOf(store, 'w1', task.id).note).toMatch(/计划快照/);
  });
});

/* ==================================================================
   3 · 映射不存在 → 纯文章，且明确标注
   ================================================================== */
describe('3 · 作品映射不存在', () => {
  it('允许纯文章发布，但任务结果明确标注「本阶段无成品视频，仅发布文章」', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = prepareWaiting(store, 'w1', seedStage(store, 'w1', 'ps_a').id);

    const { exec, calls } = makeGithubExec(store);   // 默认 resolver 返回 no-final-video
    const out = runReal(store, exec);
    await out.settled;

    expect(calls.video).toHaveLength(0);
    expect(calls.pages).toHaveLength(0);
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0].opts.content).toBe('这是发布说明');
    const t = taskOf(store, 'w1', task.id);
    expect(t.status).toBe('done');
    expect(t.note).toMatch(/本阶段无成品视频/);
    expect(t.note).toMatch(/仅发布文章/);
  });
});

/* ==================================================================
   4 · 映射存在但文件丢失 / 校验失败 → 不静默降级
   ================================================================== */
describe('4 · 映射存在但文件不可用', () => {
  it('按视频发布失败处理：视频与文章都不发布，任务 failed，记录 failed', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = prepareWaiting(store, 'w1', seedStage(store, 'w1', 'ps_a').id);

    const { exec, calls } = makeGithubExec(store, {
      resolveWorkFinalVideo: async function (workId) {
        return {
          ok: false, error: 'file-missing',
          detail: '成品视频文件不存在', workId: workId, storedPath: WORK_VIDEO
        };
      }
    });
    const out = runReal(store, exec);
    await out.settled;

    expect(calls.video).toHaveLength(0);
    expect(calls.put).toHaveLength(0);              // 绝不降级为纯文章
    const t = taskOf(store, 'w1', task.id);
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/file-missing/);
    const pub = store.listPubs().filter(p => p.pub_key === t.pub_key)[0];
    expect(pub.status).toBe('failed');
    expect(pub.error).toMatch(/成品视频文件不存在/);
  });

  it('resolver 抛异常也按失败处理（不吞掉、不降级）', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    const task = prepareWaiting(store, 'w1', seedStage(store, 'w1', 'ps_a').id);

    const { exec, calls } = makeGithubExec(store, {
      resolveWorkFinalVideo: async function () { throw new Error('boom'); }
    });
    const out = runReal(store, exec);
    await out.settled;

    expect(calls.put).toHaveLength(0);
    expect(taskOf(store, 'w1', task.id).status).toBe('failed');
  });
});

/* ==================================================================
   5 · 跨作品隔离：A 不会读取 B 的视频
   ================================================================== */
describe('5 · 作品 A 不会读取作品 B 的视频', () => {
  it('每个任务只用自己的 workId 解析视频映射', async () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedWork(store, 'w2');
    const t1 = prepareWaiting(store, 'w1', seedStage(store, 'w1', 'ps_a').id);
    const t2 = prepareWaiting(store, 'w2', seedStage(store, 'w2', 'ps_b').id);

    const map = { w1: 'C:/rokit-final/w1.mp4', w2: '' };
    const { exec, calls } = makeGithubExec(store, {
      resolveWorkFinalVideo: async function (workId) {
        if (!map[workId]) return { ok: false, error: 'no-final-video', workId: workId };
        return { ok: true, workId: workId, path: map[workId] };
      }
    });
    const out = runReal(store, exec);
    await out.settled;

    expect(calls.resolve.map(r => r.workId).sort()).toEqual(['w1', 'w2']);
    expect(calls.video).toHaveLength(1);
    expect(calls.video[0].payload.finalVideoPath).toBe(map.w1);
    expect(calls.video[0].payload.videoPath).toBe('videos/w1-20200101-psa.mp4');
    // w2 没有映射 → 纯文章，且不会拿到 w1 的视频
    expect(calls.put.map(p => p.opts.path).sort()).toEqual(['posts/w1-20200101-psa.md', 'posts/w2-20200101-psb.md']);
    expect(taskOf(store, 'w2', t2.id).note).toMatch(/本阶段无成品视频/);
    expect(taskOf(store, 'w1', t1.id).note).toMatch(/作品最新成品视频/);
  });
});

/* ==================================================================
   6 · 作品映射：同一作品只保留一个最新成品视频
   ================================================================== */
describe('6 · 生成新视频后更新作品映射', () => {
  it('settings_kv 中 finalVideo:<workId> 被新视频覆盖，且只保留一个键', () => {
    const store = newStore();
    seedWork(store, 'w1');

    store.upsertSettingKv('finalVideo:w1', 'C:/rokit-final/v1.mp4');
    expect(store.getSettingKv('finalVideo:w1')).toBe('C:/rokit-final/v1.mp4');

    store.upsertSettingKv('finalVideo:w1', 'C:/rokit-final/v2.mp4');
    expect(store.getSettingKv('finalVideo:w1')).toBe('C:/rokit-final/v2.mp4');

    // 另一个作品独立维护自己的映射
    store.upsertSettingKv('finalVideo:w2', 'C:/rokit-final/w2.mp4');
    expect(store.getSettingKv('finalVideo:w2')).toBe('C:/rokit-final/w2.mp4');
    expect(store.getSettingKv('finalVideo:w1')).toBe('C:/rokit-final/v2.mp4');

    // 同一个作品只有一条映射（不按视频数量累加）
    const keys = Object.keys(store.data && store.data.settings_kv ? store.data.settings_kv : {});
    if (keys.length) {
      expect(keys.filter(k => k === 'finalVideo:w1')).toHaveLength(1);
    }
  });

  it('主进程写入实现：复用白名单校验 + 精确 workId 键 + 返回旧值；不扫描目录推断', () => {
    const src = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8');
    const start = src.indexOf('function normalizeVideoOwnerId');
    const end = src.indexOf('// 取 GitHub 发布目标');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);

    // 白名单校验：写入与读取都必须过 resolveFinalVideoFile
    expect(block).toMatch(/function saveWorkFinalVideo/);
    expect(block).toMatch(/const fin = resolveFinalVideoFile\(videoPath\)/);
    expect(block).toMatch(/function getWorkFinalVideo/);
    expect(block).toMatch(/const fin = resolveFinalVideoFile\(String\(raw\)\)/);
    // workId 精确关联
    expect(block).toMatch(/FINAL_VIDEO_KEY_PREFIX \+ own\.id/);
    expect(block).toMatch(/FINAL_VIDEO_KEY_PREFIX \+ id/);
    // 覆盖同一个键（作品最新视频）
    expect(block).toMatch(/upsertSettingKv\(FINAL_VIDEO_KEY_PREFIX/);
    // 不允许通过扫描目录 / 挑选最新文件推断作品视频
    expect(block).not.toMatch(/readdir|readdirSync|opendir|fs\.readdir/);
    // 键名前缀与用户约定一致
    expect(src).toMatch(/const FINAL_VIDEO_KEY_PREFIX = 'finalVideo:'/);
    // 真实作品必须存在；草稿允许（转正时迁移）
    expect(block).toMatch(/unknown-work/);
    expect(block).toMatch(/\^draft_/);
  });
});

/* ==================================================================
   + 草稿归属转正时迁移映射（plan:reassign）
   ================================================================== */
describe('+ 草稿转正迁移视频映射', () => {
  function harness(deps) {
    const { registerPlanIpc } = require('../electron/plan-ipc');
    const handlers = new Map();
    const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
    registerPlanIpc(ipcMain, deps);
    return handlers;
  }

  it('reassign 成功 → 调用 migrateWorkFinalVideo(from, to)', () => {
    const migrate = vi.fn();
    const reassign = vi.fn(() => ({ ok: true, stages: 1, tasks: 2 }));
    const handlers = harness({
      getStore: () => ({ reassignPlanOwner: reassign }),
      migrateWorkFinalVideo: migrate
    });
    const res = handlers.get('plan:reassign')({}, 'draft_x', 'w1');
    expect(res).toEqual({ ok: true, stages: 1, tasks: 2 });
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith('draft_x', 'w1');
  });

  it('reassign 失败 → 不迁移映射', () => {
    const migrate = vi.fn();
    const handlers = harness({
      getStore: () => ({ reassignPlanOwner: () => ({ ok: false, error: 'bad-owner' }) }),
      migrateWorkFinalVideo: migrate
    });
    handlers.get('plan:reassign')({}, 'draft_x', 'w1');
    expect(migrate).not.toHaveBeenCalled();
  });

  it('迁移实现：目标已有映射时不覆盖', () => {
    const src = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8');
    const start = src.indexOf('function migrateWorkFinalVideo');
    const end = src.indexOf('// 取 GitHub 发布目标');
    const block = src.slice(start, end);
    expect(block).toMatch(/if \(!store\.getSettingKv\(FINAL_VIDEO_KEY_PREFIX \+ to\)\)/);
  });
});

/* ==================================================================
   + 接线与安全约束（渲染层 / preload / 主进程）
   ================================================================== */
describe('+ 接线（渲染层 / preload / 主进程）', () => {
  const html = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(H.ROOT, 'electron', 'preload.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8');
  const ipcSrc = fs.readFileSync(path.join(H.ROOT, 'electron', 'plan-ipc.js'), 'utf8');

  it('成品视频生成成功后立即持久化（state.__captionFinalVideo 赋值之后）', () => {
    const setIdx = html.indexOf('state.__captionFinalVideo = {');
    const persistIdx = html.indexOf('_persistFinalVideoForWork(r.path)');
    const logIdx = html.indexOf('_capVoiceLog(\'burn-ok\'');
    expect(setIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(setIdx);
    expect(logIdx).toBeGreaterThan(persistIdx);
  });

  it('归属键取自当前作品（planOwnerId 优先，其次 curWork）', () => {
    const src = html.slice(html.indexOf('function _curVideoOwnerKey'), html.indexOf('function _persistFinalVideoForWork'));
    expect(src).toMatch(/state\.planOwnerId/);
    expect(src).toMatch(/state\.curWork/);
  });

  it('持久化只写当前作品映射；计划已完成 / 已取消不改快照；无归属不写', () => {
    const src = html.slice(html.indexOf('function _persistFinalVideoForWork'), html.indexOf('function _capBurnFinal'));
    expect(src).toMatch(/window\.api\.planSaveFinalVideo\(owner,fv\)/);
    expect(src).toMatch(/if\(!owner\)return/);
    expect(src).toMatch(/\['done','cancelled'\]/);
    // 内存计划必须与数据库阶段一致才调用 savePlan（避免覆盖用户已保存的计划）
    expect(src).toMatch(/dbIds\.length!==memIds\.length/);
  });

  it('preload 暴露写 / 读两个窄 IPC', () => {
    expect(preload).toMatch(/planSaveFinalVideo: \(workId, videoPath\) => ipcRenderer\.invoke\('plan:save-final-video'/);
    expect(preload).toMatch(/planGetFinalVideo: \(workId\) => ipcRenderer\.invoke\('plan:get-final-video'/);
  });

  it('主进程注册窄 IPC，并把读取函数注入计划执行器', () => {
    expect(mainSrc).toMatch(/saveWorkFinalVideo: saveWorkFinalVideo/);
    expect(mainSrc).toMatch(/getWorkFinalVideo: getWorkFinalVideo/);
    expect(mainSrc).toMatch(/resolveWorkFinalVideo: getWorkFinalVideo/);
    expect(ipcSrc).toMatch(/ipcMain\.handle\('plan:save-final-video'/);
    expect(ipcSrc).toMatch(/ipcMain\.handle\('plan:get-final-video'/);
  });

  it('执行器仍复用普通发布的三个入口（不复制实现）', () => {
    expect(mainSrc).toMatch(/publishVideo:\s*githubPutVideo/);
    expect(mainSrc).toMatch(/publishPages:\s*githubPublishPages/);
    expect(mainSrc).toMatch(/publishFile:\s*githubPutFile/);
  });
});
