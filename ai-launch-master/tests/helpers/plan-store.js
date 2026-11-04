'use strict';

// Rokit · 计划相关测试的共享辅助
//
// 说明：
//   本机 better-sqlite3 的原生模块与当前 Node ABI 不匹配（NODE_MODULE_VERSION 135 vs 137），
//   这是改动前就存在的环境问题，按项目要求**不重建原生模块**。
//   这里在测试进程内按需屏蔽驱动：
//     - SQLite 场景：只屏蔽 better-sqlite3 → store 走 Node 内置 node:sqlite（同样是真 SQLite）
//     - JSON 兜底场景：两个都屏蔽 → store 走 JSON 文件兜底
//   两条路径都是生产代码的真实分支。
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');

function installDriverBlock(blockNodeSqlite) {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'better-sqlite3' || (blockNodeSqlite && request === 'node:sqlite')) {
      const e = new Error("Cannot find module '" + request + "'");
      e.code = 'MODULE_NOT_FOUND';
      throw e;
    }
    return orig.call(this, request, parent, isMain);
  };
  return function restore() { Module._load = orig; };
}

// 载入一份全新的 store 模块（每次都会重新解析驱动）
//   注意：拦截 Module._load 时**必须先还原上一次**，
//   否则嵌套安装会泄漏（被拦掉的驱动会一直生效，后续用例全部退化）。
let currentRestore = null;
function restoreDrivers() {
  if (currentRestore) { currentRestore(); currentRestore = null; }
}
function loadStoreFresh(blockNodeSqlite) {
  restoreDrivers();
  const id = require.resolve(path.join(ROOT, 'electron', 'store'));
  delete require.cache[id];
  currentRestore = installDriverBlock(!!blockNodeSqlite);
  return require(path.join(ROOT, 'electron', 'store'));
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-plan2-'));
}

function rmTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

// 建一个作品
function seedWork(store, id, name, createdAt) {
  return store.saveWork({
    id: id,
    name: name || id,
    type: 'tool',
    intro: 'intro ' + id,
    url: '',
    status: '首秀中',
    queue: '主推',
    star: 0, dl: 0, play: '0',
    next: '',
    created_at: createdAt || new Date().toISOString()
  });
}

// 构造一个计划阶段
function stage(id, o) {
  o = o || {};
  return {
    id: id,
    title: o.title || ('阶段 ' + id),
    desc: o.desc || '',
    offsetDays: o.offsetDays === undefined ? 0 : o.offsetDays,
    timeOfDay: o.timeOfDay || '20:00',
    platforms: o.platforms || ['github'],
    copy: o.copy || {}
  };
}

// 把任务时间改成过去的某个 ISO（让它到期）
function setDue(store, workId, taskId, iso) {
  return store.updatePlanTask(workId, taskId, { scheduled_at: iso });
}

// 把指定归属下「尚未执行」的任务降级为模拟候选（real_only=0）
//   现行规则：阶段里选中 GitHub 的任务默认就是真实执行候选（real_only=1），
//   模拟调度器不会领取。专门验证「模拟执行器 / 重排 / 旧模拟任务」的用例需要
//   等价于旧版 auto_publish=0 的历史数据，因此在造好计划后显式降级。
//   注意：调用方若随后显式写入 real_only=1，以显式写入为准（不要覆盖）。
function demoteToSimulated(store, workId) {
  store.listPlanTasks(workId).forEach(function (t) {
    if (t.real_only) store._planWriteTask(Object.assign({}, t, { real_only: 0 }));
  });
  return store.listPlanTasks(workId);
}

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

module.exports = {
  ROOT: ROOT,
  installDriverBlock: installDriverBlock,
  loadStoreFresh: loadStoreFresh,
  restoreDrivers: restoreDrivers,
  makeTmpDir: makeTmpDir,
  rmTmpDir: rmTmpDir,
  seedWork: seedWork,
  stage: stage,
  setDue: setDue,
  demoteToSimulated: demoteToSimulated,
  PAST: PAST,
  FUTURE: FUTURE
};
