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
});
