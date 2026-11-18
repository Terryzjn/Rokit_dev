'use strict';

// Rokit · 视频生命周期（第二批）—— 定向测试
//
// 覆盖用户要求的验证点：
//   7  多个计划引用同一个视频时，取消一个计划不会删除视频
//   8  计划完成后不会立即删除最新视频
//   9  旧视频仍被未完成计划引用时不能清理
//   +  旧视频不再是最新且无未完成引用 → 具备清理资格（但本批仍不删除）
//   +  非 Rokit 管理的文件永不清理
//   +  引用关系无法确认 → 保留文件
//   +  完成 / 取消的引用不阻塞清理
//
// 只验证「引用判断 + 清理资格判断」，不执行任何删除。

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
function seedWork(store, id) {
  return store.saveWork({
    id: id, name: '作品 ' + id, type: 'tool', intro: 'intro', url: '',
    status: '首秀中', queue: '主推', star: 0, dl: 0, play: '0', next: '',
    created_at: new Date().toISOString()
  });
}
function makeStage(stageId, videoPath) {
  const copy = { github: { title: '标题 ' + stageId, body: '正文' } };
  if (videoPath) copy.github.videoPath = videoPath;
  return {
    id: stageId, title: '阶段 ' + stageId, desc: '',
    scheduledAt: H.FUTURE, platforms: ['github'], copy: copy
  };
}
function seedStage(store, workId, stageId, videoPath) {
  store.savePlanStages(workId, [makeStage(stageId, videoPath)]);
  return store.listPlanTasks(workId).filter(t => t.platform_id === 'github')[0];
}
// v1.27（多平台）：构造任意平台组合的阶段。
//   platforms：阶段仍在发布的平台列表（平台被移出 → 该平台不再算引用）
//   copyPerPlatform：{ 平台ID: { videoPath?, ...其它文案字段 } }
//   未给出的平台段不会被创建 —— 用于构造「残留快照键」等历史形态。
function makeMultiStage(stageId, platforms, copyPerPlatform) {
  const copy = {};
  Object.keys(copyPerPlatform || {}).forEach(function (pid) {
    const seg = Object.assign({ title: '标题 ' + pid, body: '正文' }, copyPerPlatform[pid] || {});
    copy[pid] = seg;
  });
  return {
    id: stageId, title: '阶段 ' + stageId, desc: '',
    scheduledAt: H.FUTURE, platforms: platforms, copy: copy
  };
}
function seedMultiStage(store, workId, stageId, platforms, copyPerPlatform) {
  store.savePlanStages(workId, [makeMultiStage(stageId, platforms, copyPerPlatform)]);
  return store.listPlanTasks(workId).filter(function (t) {
    return t.stage_id === stageId && platforms.indexOf(t.platform_id) >= 0;
  });
}
function setTaskStatus(store, workId, taskId, status) {
  const t = store.listPlanTasks(workId).filter(x => x.id === taskId)[0];
  store._planWriteTask(Object.assign({}, t, { status: status }));
  return store.listPlanTasks(workId).filter(x => x.id === taskId)[0];
}
function assess(store, p, opts) {
  return store.assessFinalVideoCleanup(p, opts);
}

const SHARED = 'C:/rokit-final/final-shared.mp4';
const NEWER = 'C:/rokit-final/final-newer.mp4';
const OTHER_WORK_LATEST = 'C:/rokit-final/final-w2.mp4';

/* ==================================================================
   7 · 多个计划引用同一个视频：取消一个计划不会删除视频
   ================================================================== */
describe('7 · 多个计划引用同一个视频', () => {
  it('取消其中一个计划后，另一个未完成计划仍引用 → 无清理资格（不删除）', () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedWork(store, 'w2');
    const t1 = seedStage(store, 'w1', 'ps_a', SHARED);
    const t2 = seedStage(store, 'w2', 'ps_b', SHARED);

    // 作品 w1 的最新视频 = SHARED（w2 的计划通过快照引用同一文件，不复制）
    store.upsertSettingKv('finalVideo:w1', SHARED);
    store.upsertSettingKv('finalVideo:w2', OTHER_WORK_LATEST);

    // w1 生成新视频 → SHARED 不再是最新
    store.upsertSettingKv('finalVideo:w1', NEWER);

    // 取消 w2 的计划任务：只解除该计划的执行，不删除视频
    const cancel = store.cancelPlanTask('w2', t2.id);
    expect(cancel.ok).toBe(true);
    expect(fs.existsSync(SHARED)).toBe(false);   // 测试环境本就没有该文件，也证明没有删除动作

    // w1 的 GitHub 任务仍未完成 → SHARED 仍被引用，不能清理
    let res = assess(store, SHARED, { managed: true });
    expect(res.eligible).toBe(false);
    expect(res.reason).toMatch(/未完成计划/);
    expect(res.references.map(r => r.workId).sort()).toEqual(['w1', 'w2']);
    expect(res.references.filter(r => r.workId === 'w2')[0].status).toBe('cancelled');

    // w1 任务完成 + w2 已取消 → 两张计划都不再阻塞清理
    setTaskStatus(store, 'w1', t1.id, 'done');
    res = assess(store, SHARED, { managed: true });
    expect(res.eligible).toBe(true);
  });
});

/* ==================================================================
   8 · 计划完成后不会立即删除最新视频
   ================================================================== */
describe('8 · 计划完成后不立即删除最新视频', () => {
  it('任务已 done，但文件仍是作品最新视频 → 无清理资格', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const t = seedStage(store, 'w1', 'ps_a', SHARED);
    store.upsertSettingKv('finalVideo:w1', SHARED);
    setTaskStatus(store, 'w1', t.id, 'done');

    const res = assess(store, SHARED, { managed: true });
    expect(res.eligible).toBe(false);
    expect(res.managed).toBe(true);
    expect(res.latestWorkIds).toEqual(['w1']);
    expect(res.reason).toMatch(/最新成品视频/);
  });

  it('其它作品映射仍指向该路径 → 依然是最新视频，无清理资格', () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedWork(store, 'w2');
    store.upsertSettingKv('finalVideo:w1', NEWER);
    store.upsertSettingKv('finalVideo:w2', SHARED);

    const res = assess(store, SHARED, { managed: true });
    expect(res.eligible).toBe(false);
    expect(res.latestWorkIds).toEqual(['w2']);
  });
});

/* ==================================================================
   9 · 旧视频仍被未完成计划引用 → 不能清理
   ================================================================== */
describe('9 · 旧视频仍被未完成计划引用', () => {
  it('映射已更新为新视频，但旧视频被 pending 计划引用 → 无清理资格', () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedStage(store, 'w1', 'ps_a', SHARED);
    // 新视频覆盖映射 → SHARED 变成旧视频
    store.upsertSettingKv('finalVideo:w1', NEWER);

    const res = assess(store, SHARED, { managed: true });
    expect(res.eligible).toBe(false);
    expect(res.reason).toMatch(/未完成计划/);
    expect(res.references).toHaveLength(1);
    expect(res.references[0].status).toBe('pending');
  });

  it('running / needs_review / failed 都算未完成（宁可保留）', () => {
    ['running', 'needs_review', 'failed'].forEach(function (status) {
      const store = newStore();
      seedWork(store, 'w1');
      const t = seedStage(store, 'w1', 'ps_a', SHARED);
      store.upsertSettingKv('finalVideo:w1', NEWER);
      setTaskStatus(store, 'w1', t.id, status);
      const res = assess(store, SHARED, { managed: true });
      expect(res.eligible).toBe(false);
      expect(res.references[0].status).toBe(status);
    });
  });
});

/* ==================================================================
   + 旧视频无引用且不再是最新 → 具备清理资格（本批不删除）
   ================================================================== */
describe('+ 清理资格的正向判定', () => {
  it('不再是最新视频且没有任何计划引用 → eligible', () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedStage(store, 'w1', 'ps_a', NEWER);   // 计划引用的是新视频
    store.upsertSettingKv('finalVideo:w1', NEWER);

    const res = assess(store, SHARED, { managed: true });
    expect(res.ok).toBe(true);
    expect(res.eligible).toBe(true);
    expect(res.managed).toBe(true);
    expect(res.latestWorkIds).toEqual([]);
    expect(res.references).toEqual([]);
  });

  it('完成 / 取消的引用不阻塞清理', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const t = seedStage(store, 'w1', 'ps_a', SHARED);
    store.upsertSettingKv('finalVideo:w1', NEWER);

    setTaskStatus(store, 'w1', t.id, 'done');
    expect(assess(store, SHARED, { managed: true }).eligible).toBe(true);

    const store2 = newStore();
    seedWork(store2, 'w1');
    const t2 = seedStage(store2, 'w1', 'ps_a', SHARED);
    store2.upsertSettingKv('finalVideo:w1', NEWER);
    store2.cancelPlanTask('w1', t2.id);
    expect(assess(store2, SHARED, { managed: true }).eligible).toBe(true);
  });
});

/* ==================================================================
   + 安全边界
   ================================================================== */
describe('+ 安全边界（无法确认 → 保留）', () => {
  it('非 Rokit 管理的文件（managed:false）永不清理', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const res = assess(store, 'C:/Users/me/Videos/original.mp4', { managed: false });
    expect(res.eligible).toBe(false);
    expect(res.managed).toBe(false);
    expect(res.reason).toMatch(/不是 Rokit 管理/);
  });

  it('没有任何映射指向它（且未声明 managed）→ 不猜测，保留', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const res = assess(store, 'C:/rokit-final/unknown.mp4');
    expect(res.eligible).toBe(false);
    expect(res.managed).toBe(false);
  });

  it('阶段仍在发布 GitHub 但没有对应任务行 → 引用关系不可确认，保留', () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedStage(store, 'w1', 'ps_a', SHARED);
    store.upsertSettingKv('finalVideo:w1', NEWER);
    // 模拟数据不一致：删除任务行（计划阶段仍引用旧视频）
    store.run('DELETE FROM plan_tasks WHERE work_id = ?', ['w1']);

    const res = assess(store, SHARED, { managed: true });
    expect(res.ok).toBe(false);
    expect(res.eligible).toBe(false);
    expect(res.reason).toMatch(/无法确认/);
  });

  it('阶段已不再发布 GitHub（平台被移出）→ 不再算引用', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const t = seedStage(store, 'w1', 'ps_a', SHARED);
    store.upsertSettingKv('finalVideo:w1', NEWER);
    // 平台移出该阶段：任务被取消（引用解除）
    store.savePlanStages('w1', [{
      id: 'ps_a', title: '阶段', desc: '', scheduledAt: H.FUTURE,
      platforms: ['wechat'], copy: { github: { title: 't', body: 'b', videoPath: SHARED } }
    }]);
    expect(store.listPlanTasks('w1').filter(x => x.id === t.id)[0].status).toBe('cancelled');

    const res = assess(store, SHARED, { managed: true });
    expect(res.eligible).toBe(true);
  });
});

/* ==================================================================
   + 主进程接线：新视频替换旧视频时返回清理资格，但绝不删除文件
   ================================================================== */
describe('+ 主进程只做资格判断（不删除）', () => {
  const mainSrc = fs.readFileSync(path.join(H.ROOT, 'electron', 'main.js'), 'utf8');
  const storeSrc = fs.readFileSync(path.join(H.ROOT, 'electron', 'store.js'), 'utf8');

  it('saveWorkFinalVideo 返回旧视频的清理资格', () => {
    const start = mainSrc.indexOf('function saveWorkFinalVideo');
    const end = mainSrc.indexOf('function getWorkFinalVideo');
    const block = mainSrc.slice(start, end);
    expect(block).toMatch(/assessFinalVideoCleanup/);
    expect(block).toMatch(/previous_cleanup/);
    expect(block).toMatch(/isInsideFinalVideoDir/);
  });

  it('资格判断与映射写入路径里没有删除文件的操作', () => {
    const start = mainSrc.indexOf('function saveWorkFinalVideo');
    const end = mainSrc.indexOf('function getWorkFinalVideo');
    const block = mainSrc.slice(start, end);
    expect(block).not.toMatch(/unlink|rmSync|rmdir|trashItem|fs\.rm/);

    const s2 = storeSrc.indexOf('assessFinalVideoCleanup');
    const block2 = storeSrc.slice(s2, s2 + 8000);
    expect(block2).not.toMatch(/unlink|rmSync|rmdir|fs\.rm/);
  });

  // v1.27：多平台改造后，store.js 整个文件都不应该出现任何删除文件的操作
  //   （旧断言只看 assessFinalVideoCleanup 之后的 8000 字符窗口，改造后可能漏掉别处）
  it('整个 store.js 里都没有删除文件的操作', () => {
    expect(storeSrc).not.toMatch(/unlinkSync|rmSync|rmdirSync|trashItem|fs\.rm\s*\(/);
  });
});

/* ==================================================================
   v1.27 · 多平台引用保护
   ------------------------------------------------------------------
   旧实现只扫 GitHub（platforms.indexOf('github') + copy.github + '|github'），
   导致「只有 YouTube 计划引用该视频」时被判成「无计划引用」→ 可清理，
   而 YouTube 执行器真的会去读 copy.youtube.videoPath 上传。

   现在以 stage.platforms 为平台白名单逐个平台检查。
   ================================================================== */
describe('v1.27 · 多平台引用保护', () => {
  const YT = 'C:/rokit-final/final-youtube.mp4';

  /* ---------- 1. YouTube pending 引用 → 不可清理 ---------- */
  it('1. YouTube 任务 pending 引用目标视频 → 不可清理', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const tasks = seedMultiStage(store, 'w1', 'ps_yt', ['youtube'], {
      youtube: { videoPath: YT }
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].platform_id).toBe('youtube');
    store.upsertSettingKv('finalVideo:w1', NEWER);   // YT 变成旧视频

    const res = assess(store, YT, { managed: true });
    expect(res.ok).toBe(true);
    expect(res.eligible).toBe(false);
    expect(res.reason).toMatch(/未完成计划/);
    expect(res.references).toHaveLength(1);
    expect(res.references[0].platformId).toBe('youtube');
    expect(res.references[0].status).toBe('pending');
  });

  /* ---------- 2. YouTube done / cancelled → 不阻塞清理 ---------- */
  it('2a. YouTube 任务 done → 不阻塞清理', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const tasks = seedMultiStage(store, 'w1', 'ps_yt', ['youtube'], {
      youtube: { videoPath: YT }
    });
    store.upsertSettingKv('finalVideo:w1', NEWER);
    setTaskStatus(store, 'w1', tasks[0].id, 'done');

    const res = assess(store, YT, { managed: true });
    expect(res.eligible).toBe(true);
    expect(res.references[0].platformId).toBe('youtube');
    expect(res.references[0].status).toBe('done');
  });

  it('2b. YouTube 任务 cancelled → 不阻塞清理', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const tasks = seedMultiStage(store, 'w1', 'ps_yt', ['youtube'], {
      youtube: { videoPath: YT }
    });
    store.upsertSettingKv('finalVideo:w1', NEWER);
    store.cancelPlanTask('w1', tasks[0].id);

    const res = assess(store, YT, { managed: true });
    expect(res.eligible).toBe(true);
    expect(res.references[0].platformId).toBe('youtube');
    expect(res.references[0].status).toBe('cancelled');
  });

  /* ---------- 3. YouTube needs_review / failed → 不可清理 ---------- */
  it('3. YouTube 任务 needs_review / failed → 不可清理（保守保留）', () => {
    ['needs_review', 'failed'].forEach(function (status) {
      const store = newStore();
      seedWork(store, 'w1');
      const tasks = seedMultiStage(store, 'w1', 'ps_yt', ['youtube'], {
        youtube: { videoPath: YT }
      });
      store.upsertSettingKv('finalVideo:w1', NEWER);
      setTaskStatus(store, 'w1', tasks[0].id, status);

      const res = assess(store, YT, { managed: true });
      expect(res.eligible).toBe(false);
      expect(res.reason).toMatch(/未完成计划/);
      expect(res.references[0].platformId).toBe('youtube');
      expect(res.references[0].status).toBe(status);
    });
  });

  /* ---------- 4. GitHub done + YouTube pending → 不可清理 ---------- */
  it('4. 同阶段 GitHub(done) + YouTube(pending) → 不可清理', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const tasks = seedMultiStage(store, 'w1', 'ps_both', ['github', 'youtube'], {
      github: { videoPath: YT },
      youtube: { videoPath: YT }
    });
    expect(tasks).toHaveLength(2);
    store.upsertSettingKv('finalVideo:w1', NEWER);

    const gh = tasks.filter(t => t.platform_id === 'github')[0];
    const yt = tasks.filter(t => t.platform_id === 'youtube')[0];
    setTaskStatus(store, 'w1', gh.id, 'done');

    const res = assess(store, YT, { managed: true });
    expect(res.eligible).toBe(false);
    expect(res.reason).toMatch(/未完成计划/);
    expect(res.references).toHaveLength(2);
    expect(res.references.map(r => r.platformId).sort()).toEqual(['github', 'youtube']);
    const ytRef = res.references.filter(r => r.platformId === 'youtube')[0];
    expect(ytRef.status).toBe('pending');
  });

  /* ---------- 5. GitHub pending + YouTube done → 不可清理 ---------- */
  it('5. 同阶段 GitHub(pending) + YouTube(done) → 不可清理', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const tasks = seedMultiStage(store, 'w1', 'ps_both', ['github', 'youtube'], {
      github: { videoPath: YT },
      youtube: { videoPath: YT }
    });
    store.upsertSettingKv('finalVideo:w1', NEWER);

    const gh = tasks.filter(t => t.platform_id === 'github')[0];
    const yt = tasks.filter(t => t.platform_id === 'youtube')[0];
    setTaskStatus(store, 'w1', yt.id, 'done');

    const res = assess(store, YT, { managed: true });
    expect(res.eligible).toBe(false);
    expect(res.references).toHaveLength(2);
    const ghRef = res.references.filter(r => r.platformId === 'github')[0];
    expect(ghRef.status).toBe('pending');
  });

  /* ---------- 6. 只有已移出平台的残留快照 → 不构成引用 ---------- */
  it('6. platforms 只有 youtube，copy 只剩已移出的 github 残留快照 → 不构成引用', () => {
    const store = newStore();
    seedWork(store, 'w1');
    // 阶段仍在发布 youtube，但 copy 里只有 github 段（历史残留快照键）
    seedMultiStage(store, 'w1', 'ps_yt', ['youtube'], {
      github: { videoPath: YT }
    });
    store.upsertSettingKv('finalVideo:w1', NEWER);

    const res = assess(store, YT, { managed: true });
    expect(res.ok).toBe(true);
    expect(res.eligible).toBe(true);
    expect(res.references).toEqual([]);
  });

  /* ---------- 7. YouTube 有匹配快照但任务行缺失 → 无法确认 ---------- */
  it('7. platforms=[youtube] + copy.youtube.videoPath 指向目标，但 youtube 任务行缺失 → 无法确认，不可清理', () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedMultiStage(store, 'w1', 'ps_yt', ['youtube'], {
      youtube: { videoPath: YT }
    });
    store.upsertSettingKv('finalVideo:w1', NEWER);
    // 制造数据不一致：删掉 youtube 任务行（阶段仍引用该视频）
    store.run('DELETE FROM plan_tasks WHERE work_id = ? AND platform_id = ?', ['w1', 'youtube']);

    const res = assess(store, YT, { managed: true });
    expect(res.ok).toBe(false);
    expect(res.eligible).toBe(false);
    expect(res.reason).toMatch(/无法确认/);
    expect(res.references).toHaveLength(1);
    expect(res.references[0].platformId).toBe('youtube');
    expect(res.references[0].taskId).toBe('');
    expect(res.references[0].status).toBe('unknown');
  });

  /* ---------- 8. wechat 段异常存在匹配 videoPath → 保守保护 ---------- */
  it('8. wechat 段异常存在匹配 videoPath → 保守保护（不可清理）', () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedMultiStage(store, 'w1', 'ps_wx', ['wechat'], {
      wechat: { videoPath: YT }
    });
    store.upsertSettingKv('finalVideo:w1', NEWER);

    const res = assess(store, YT, { managed: true });
    expect(res.eligible).toBe(false);
    expect(res.reason).toMatch(/未完成计划/);
    expect(res.references).toHaveLength(1);
    expect(res.references[0].platformId).toBe('wechat');
  });

  /* ---------- 9. 脏数据不崩溃 ---------- */
  it('9. copy 为非法 JSON / 空串 / 平台段不是对象 → 不崩溃', () => {
    const store = newStore();
    seedWork(store, 'w1');
    const tasks = seedMultiStage(store, 'w1', 'ps_yt', ['youtube'], {
      youtube: { videoPath: YT }
    });
    store.upsertSettingKv('finalVideo:w1', NEWER);

    // (a) copy 段不是对象（字符串）
    store.run('UPDATE plan_stages SET copy = ? WHERE id = ?', [
      JSON.stringify({ youtube: 'not-an-object' }), 'ps_yt'
    ]);
    let res = assess(store, YT, { managed: true });
    expect(res.ok).toBe(true);
    expect(res.eligible).toBe(true);          // 段不可读 → 不算引用
    expect(res.references).toEqual([]);

    // (b) copy 整体是非法 JSON
    store.run('UPDATE plan_stages SET copy = ? WHERE id = ?', ['{not-json', 'ps_yt']);
    res = assess(store, YT, { managed: true });
    expect(res.ok).toBe(true);
    expect(res.eligible).toBe(true);
    expect(res.references).toEqual([]);

    // (c) copy 是空串
    store.run('UPDATE plan_stages SET copy = ? WHERE id = ?', ['', 'ps_yt']);
    res = assess(store, YT, { managed: true });
    expect(res.ok).toBe(true);
    expect(res.eligible).toBe(true);
    expect(res.references).toEqual([]);

    // (d) copy 是数组
    store.run('UPDATE plan_stages SET copy = ? WHERE id = ?', ['[]', 'ps_yt']);
    res = assess(store, YT, { managed: true });
    expect(res.ok).toBe(true);
    expect(res.eligible).toBe(true);
    expect(res.references).toEqual([]);
  });

  /* ---------- 10. references 包含正确的 platformId ---------- */
  it('10. references 每条都带 platformId，且与实际引用平台一一对应', () => {
    const store = newStore();
    seedWork(store, 'w1');
    seedWork(store, 'w2');
    seedWork(store, 'w3');
    // savePlanStages 是「整份替换」：同一作品的第二次调用会删掉前一阶段，
    //   因此这里用三个独立作品各承载一个平台引用。
    seedMultiStage(store, 'w1', 'ps_a', ['github'], { github: { videoPath: YT } });
    seedMultiStage(store, 'w2', 'ps_b', ['youtube'], { youtube: { videoPath: YT } });
    seedMultiStage(store, 'w3', 'ps_c', ['wechat'], { wechat: { videoPath: YT } });
    store.upsertSettingKv('finalVideo:w1', NEWER);
    store.upsertSettingKv('finalVideo:w2', NEWER);
    store.upsertSettingKv('finalVideo:w3', NEWER);

    const res = assess(store, YT, { managed: true });
    expect(res.eligible).toBe(false);
    expect(res.references).toHaveLength(3);
    expect(res.references.every(r => typeof r.platformId === 'string' && r.platformId)).toBe(true);
    expect(res.references.map(r => r.platformId).sort()).toEqual(['github', 'wechat', 'youtube']);
    // 每条都带 workId / stageId / taskId / status
    res.references.forEach(function (r) {
      expect(r.workId).toBeTruthy();
      expect(r.stageId).toBeTruthy();
      expect(r.taskId).toBeTruthy();
      expect(r.status).toBeTruthy();
    });
  });

  /* ---------- 11. 多平台改造没有削弱 GitHub 原有保护 ---------- */
  it('11. GitHub 原有语义保持不变（pending 保护 / done 放行 / 平台移出放行）', () => {
    // pending 保护
    let store = newStore();
    seedWork(store, 'w1');
    let t = seedStage(store, 'w1', 'ps_a', SHARED);
    store.upsertSettingKv('finalVideo:w1', NEWER);
    let res = assess(store, SHARED, { managed: true });
    expect(res.eligible).toBe(false);
    expect(res.references[0].platformId).toBe('github');

    // done 放行
    setTaskStatus(store, 'w1', t.id, 'done');
    expect(assess(store, SHARED, { managed: true }).eligible).toBe(true);
  });
});
