// Rokit · 主推队列 + 状态机（v1.5 PRD 第七节）
//
// 主推作品由本模块在应用启动时自动选择：
//   - status='launching' 优先 > status='pending'
//   - 同优先级：priority DESC, launched_at ASC（null 视为最新）, created_at ASC
//   - archived / stable 超过 14 天 → 不参与主推
//   - 所有作品均为 archived / stable → 兜底返回 least-bad，避免空指针
//
// 状态机（status）：pending → launching → operating → stable → archived
// 状态机（queue_state）：queued / main / parked（main 是被选中的主推）

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const STABLE_THRESHOLD_DAYS = 14;

// 工具：作品距今天数（按 launched_at；缺则用 created_at；都没有按 0）
function ageDays(work, now) {
  const t = work.launched_at || work.created_at;
  if (!t) return 0;
  const d = new Date(t).getTime();
  if (!Number.isFinite(d)) return 0;
  return Math.max(0, (now - d) / DAY_MS);
}

// pickMain：从一组作品中选主推。
//   排序键：status 优先级（launching > pending > operating > stable > archived）→ priority DESC → launched_at ASC（null 优先）→ created_at ASC
//   排除：archived、stable 且 ageDays >= stableThresholdDays
//   兜底：若全部被排除，返回「优先级最高的」一个（least-bad），避免主推永远为空
// 注意：本函数会就地 mutate 输入数组中的作品的 queue_state（main / parked）。
function pickMain(works, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const stableThresholdDays = opts.stableThresholdDays != null ? opts.stableThresholdDays : STABLE_THRESHOLD_DAYS;
  const statusRank = { launching: 0, pending: 1, operating: 2, stable: 3, archived: 4 };
  if (!Array.isArray(works) || !works.length) return null;

  // 过滤候选
  const candidates = works.filter(function (w) {
    if (!w) return false;
    const s = w.status || 'launching';
    if (s === 'archived') return false;
    if (s === 'stable' && ageDays(w, now) >= stableThresholdDays) return false;
    return true;
  });

  function score(w) {
    const s = w.status || 'launching';
    return [
      statusRank[s] != null ? statusRank[s] : 9,
      -(Number(w.priority) || 0),
      // launched_at null 视为最新 → 0；其它取 +timestamp（越大越靠后）
      w.launched_at ? new Date(w.launched_at).getTime() : 0,
      new Date(w.created_at || 0).getTime() || 0
    ];
  }
  function compare(a, b) {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
    return 0;
  }

  let chosen = null;
  if (candidates.length) {
    candidates.sort(compare);
    chosen = candidates[0];
  } else {
    // 兜底：返回按同样规则的 least-bad
    const sorted = works.slice().sort(compare);
    chosen = sorted[0] || null;
  }
  if (!chosen) return null;

  // 就地 mutate：把当前 main 的旧主推标 parked，新主推标 main
  for (const w of works) {
    if (!w) continue;
    if (w.id === chosen.id) {
      w.queue_state = 'main';
      if (!w.launched_at) w.launched_at = new Date(now).toISOString();
    } else if (w.queue_state === 'main') {
      w.queue_state = 'parked';
    }
  }
  return chosen;
}

// schedule(store, opts) → { main, demoted:[], promoted:[] }
//   - 拉取所有作品
//   - 调用 pickMain 选出主推
//   - 把变化写回 store（不动 status，只动 queue_state + launched_at）
//   - 返回对比结果供 UI 弹 toast
async function schedule(store, opts) {
  if (!store) return { main: null, demoted: [], promoted: [] };
  const works = store.listWorks ? store.listWorks() : [];
  if (!Array.isArray(works) || !works.length) return { main: null, demoted: [], promoted: [] };

  // 必须在 pickMain 之前捕旧主推：pickMain 会就地把旧主推 mutate 为 parked
  const previousMain = works.find(function (w) { return w.queue_state === 'main'; });

  const current = pickMain(works, opts);
  if (!current) return { main: null, demoted: [], promoted: [] };

  const demoted = [];
  const promoted = [];
  if (previousMain && previousMain.id !== current.id) {
    demoted.push(previousMain.id);
  }
  if (!previousMain || previousMain.id !== current.id) {
    promoted.push(current.id);
  }

  // 写回（带 launched_at / last_active_at 时间戳）
  const nowIso = new Date().toISOString();
  if (store.saveWork) {
    for (const w of works) {
      if (!w || !w.id) continue;
      const patch = {
        id: w.id,
        queue_state: w.queue_state || (w.id === current.id ? 'main' : 'queued'),
        priority: Number(w.priority) || 0,
        launched_at: w.launched_at || null,
        last_active_at: w.id === current.id ? nowIso : (w.last_active_at || null),
        // 保留其他字段
        name: w.name, type: w.type, intro: w.intro, url: w.url,
        status: w.status, queue: w.queue,
        star: w.star, dl: w.dl, play: w.play, next: w.next,
        created_at: w.created_at
      };
      try { store.saveWork(patch); } catch (_e) { /* 单条失败不影响整体 */ }
    }
  }

  return { main: current.id, work: current, demoted: demoted, promoted: promoted };
}

module.exports = {
  pickMain: pickMain,
  schedule: schedule,
  STABLE_THRESHOLD_DAYS: STABLE_THRESHOLD_DAYS
};