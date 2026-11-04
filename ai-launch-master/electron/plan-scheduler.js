// Rokit · 首秀计划调度器（第二阶段：模拟执行 / 第三阶段 A：GitHub 真实发布）
//
// 边界（务必保持）：
//   - 普通任务只调用本地模拟执行器；真实平台执行只对「用户在该阶段勾选自动发布」的任务
//     （real_only=1）生效，且必须先通过发布前幂等检查；
//   - 调度器只负责「扫描到期任务 → 领取 → 调用执行器 → 保存结果」，
//     页面逻辑（index.html）不参与执行，也没有任何触发执行的入口；
//   - 应用退出时必须 stop()，关闭期间不会有任何任务被执行。
//
// 与真实发布的隔离：
//   - 模拟执行器返回的 platform_ref 一律带 'mock:' 前缀，platform_url 恒为空；
//   - 绝不写入真实平台 ID / 真实发布 URL / 伪造的外部成功凭证。
//
// 真实路径的三重保险（见 checkRealExecutionGate）：
//   1) 只有 real_only=1 的任务才可能进入真实路径；
//   2) 必须先通过 checkPlanPublishGuard：skip / review / unclear 一律不发布；
//   3) 模拟任务（simulated=1）直接拒绝。
//
// 一次发送失败即终止（不自动重试、不自动重新入队）：
//   - 明确失败（平台明确拒绝）→ status='failed'：任务终止，不再进入任何待执行队列；
//   - 结果未知（超时 / 连接中断 / 进程中断）→ status='needs_review'：转人工核实，绝不盲目重发；
//   - 成功 → status='done'：不再重复发送。
'use strict';

const DEFAULT_INTERVAL_MS = 30000;   // 扫描间隔：30 秒（避免高频无意义轮询）
const MOCK_FAIL_MARKER = 'MOCK_FAIL'; // 模拟失败的可控触发条件（写进阶段标题或任务备注即可）

// 真实执行器闸门
//   规则（与 store.checkPlanPublishGuard 同一套判定）：
//   - 模拟任务（simulated=1）→ 一律不执行（必须先显式重新排队）
//   - 已精确匹配到确认成功的发布记录 → 不执行（不得重复发布）
//   - 只能模糊匹配 / 状态待核实 → 不执行（必须人工确认）
//   - 结果不确定 → 不执行（不得盲目重试）
//   - 其余（明确没有成功发布记录）→ 允许执行
function checkRealExecutionGate(store, task) {
  try {
    if (task && task.simulated) {
      return { allow: false, reason: '模拟任务：不得进入真实发布路径（需先显式重新排队）' };
    }
    if (store && typeof store.checkPlanPublishGuard === 'function') {
      const g = store.checkPlanPublishGuard(task.work_id, task.id) || {};
      // skip / review / unclear 一律不得自动发布；只有 allow 才能继续
      if (g.decision === 'allow') {
        return { allow: true, reason: g.reason || '', decision: 'allow' };
      }
      const prefix = task && task.real_only ? '等待真实执行的任务' : '任务';
      return {
        allow: false,
        decision: g.decision || 'unknown',
        reason: g.reason || (prefix + '发布前检查未通过：' + (g.decision || 'unknown'))
      };
    }
    // 没有可用的检查接口 → 保守拒绝，绝不"默认放行"
    return { allow: false, reason: '缺少发布前幂等检查能力，保守拒绝执行' };
  } catch (e) {
    return { allow: false, reason: '发布前检查异常，保守拒绝执行：' + String((e && e.message) || e) };
  }
}

// 模拟执行器：pending → running → done / failed / draft_pending
//   - 微信公众号：只「创建草稿」，不自动群发 → draft_pending
//   - GitHub / YouTube：模拟成功 → done
//   - 失败：阶段标题或任务备注里含 MOCK_FAIL 时确定性失败（不依赖网络）
function createMockPlanExecutor(opts) {
  opts = opts || {};
  const failMarker = String(opts.failMarker || MOCK_FAIL_MARKER);
  return function mockExecutor(task) {
    const t = task || {};
    const pid = String(t.platform_id || '');
    const stageTitle = String(t.stage_title || '');
    const note = String(t.note || '');

    // 可控失败条件（不发起任何网络请求）
    if (stageTitle.indexOf(failMarker) >= 0 || note.indexOf(failMarker) >= 0) {
      return {
        ok: false,
        simulated: true,
        error: '模拟执行失败（可控测试条件：' + failMarker + '）'
      };
    }

    if (pid === 'wechat') {
      // 微信后续仍然只创建草稿，不自动群发
      return {
        ok: true,
        simulated: true,
        status: 'draft_pending',
        platform_ref: 'mock:wechat:' + String(t.id || ''),
        platform_url: '',
        note: '模拟：已创建公众号草稿，等待人工确认群发（未真实调用任何接口）'
      };
    }

    return {
      ok: true,
      simulated: true,
      status: 'done',
      platform_ref: 'mock:' + pid + ':' + String(t.id || ''),
      platform_url: '',
      note: '模拟执行成功（未真实发布）'
    };
  };
}

// 执行器异常的归类：**明确失败** 与 **结果未知** 必须严格区分
//   - 模拟执行路径：模拟执行没有任何外部副作用（不写真实平台、不发网络请求），
//     所以异常就是"明确失败"→ 任务终止（failed），不再自动重试、不再重新入队。
//   - 真实执行路径：异常 / 超时 / 连接中断 → **无法确认平台是否已收到内容**
//     → 转 needs_review（人工核实路径）。系统不自动重发，也不自动重新排队。
function classifyExecError(err, isRealPath) {
  const msg = String((err && err.message) || err);
  if (!isRealPath) {
    return { ok: false, error: '执行器异常：' + msg };
  }
  return {
    ok: true,
    status: 'needs_review',
    error: '执行器异常（结果未知）：' + msg,
    note: '真实发布过程中断，无法确认平台是否已收到内容；请先到平台核实，确认后再决定手动发送或重新创建计划。系统不会自动重发，也不会自动重新排队'
  };
}

// 调度器
//   deps:
//     getStore       —— 取 store 的函数（每次调用时取，不在创建时捕获实例）
//     mockExecutor   —— 模拟执行器（默认 createMockPlanExecutor）：普通待执行任务走它
//     executorKind   —— 'mock'（纯模拟）/ 'real'（常驻真实执行模式）；也可以传函数（每次扫描时求值）
//     realExecutors  —— **按平台注册**的真实执行器：{ github: fn, ... }
//                        只有注册过的平台才可能走真实发布；未注册的平台一律跳过
//                        （YouTube / 微信本阶段没有注册 → 明确不执行）
//     executor       —— 通用真实执行器（兼容旧调用；只有 realExecutors 里没有该平台时才兜底）
//     intervalMs     —— 扫描间隔（默认 30s）
//     logger         —— 日志（默认空实现）
//
//   真实路径的三重保险：
//     1) 只有 real_only=1 的任务才可能进入真实路径（阶段里显式勾选了「自动发布」）
//     2) 执行前必须通过 checkPlanPublishGuard：skip / review / unclear 一律不执行
//     3) 模拟任务（simulated=1）由闸门直接拒绝
//   普通待执行任务在任何模式下都走模拟执行器（保留 mock 测试能力）。
function createPlanScheduler(deps) {
  deps = deps || {};
  const getStore = deps.getStore;
  const defaultMockExecutor = createMockPlanExecutor(deps.executorOptions);
  const realExecutors = deps.realExecutors || {};
  const executor = deps.executor || null;          // 通用真实执行器（兼容旧调用 / 测试注入）
  const intervalMs = Number(deps.intervalMs || DEFAULT_INTERVAL_MS);
  const logger = deps.logger || { info: function () {}, warn: function () {}, error: function () {} };

  // 模拟执行器选取：
  //   - mock 模式下，兼容旧注入方式（deps.executor 当作模拟执行器）；
  //   - real 模式下，普通待执行任务**始终**用模拟执行器（不会自动真实发布）。
  function pickMockExecutor(kind) {
    if (deps.mockExecutor) return deps.mockExecutor;
    if (kind !== 'real' && executor) return executor;
    return defaultMockExecutor;
  }

  // 当前执行模式（executorKind 可以是字符串，也可以是函数）
  function currentKind() {
    const k = (typeof deps.executorKind === 'function') ? deps.executorKind() : deps.executorKind;
    return String(k || 'mock') === 'real' ? 'real' : 'mock';
  }
  // 取某个平台的真实执行器（没注册 → null）
  function realExecutorFor(platformId) {
    const pid = String(platformId || '');
    if (Object.prototype.hasOwnProperty.call(realExecutors, pid) && realExecutors[pid]) {
      return realExecutors[pid];
    }
    if (executor) return executor;                  // 兼容：显式注入的通用执行器
    return null;
  }

  let timer = null;
  let started = false;
  let scanning = false;          // 同一时刻只允许一个扫描在跑
  let lastScan = '';
  let lastError = '';
  let scans = 0;
  let executed = 0;
  let failed = 0;
  let review = 0;

  function log(fn, payload) {
    try { logger[fn]('[plan-scheduler] ' + payload); } catch (_e) {}
  }

  // 扫描一次：找出到期任务 → 逐个领取 → 执行 → 落库
  //   单个任务出错不影响其它任务（异常被就地捕获并记录）。
  //   真实执行器是异步的（网络请求）：同步执行器照旧同步落库；
  //   异步执行器的结果在 Promise 完成后落库，out.settled 等待全部结算。
  function scanOnce(nowIso) {
    if (scanning) return { ok: true, skipped: true, reason: 'scan already in progress', settled: Promise.resolve() };
    scanning = true;
    const now = String(nowIso || new Date().toISOString());
    const out = { ok: true, claimed: [], done: [], failed: [], review: [], skipped: [], now: now };
    const pending = [];
    const kind = currentKind();
    const store = getStore();

    // 落库 + 记账（同步 / 异步执行器共用）
    function finishTask(taskId, runToken, result) {
      const fin = store.finishPlanTask(taskId, runToken, result || { ok: false, error: '执行器无返回' });
      if (fin && fin.ok) {
        const st = fin.task && fin.task.status;
        const realResult = !!(result && result.simulated === false);
        log('info', 'task result ' + taskId + ' kind=' + (realResult ? 'real' : 'mock') + ' status=' + st);
        if (st === 'failed') {
          out.failed.push(taskId);
          failed++;
        } else if (st === 'needs_review') {
          // 结果未知：等人工核实，既不算成功也不算失败（绝不自动重发）
          out.review.push(taskId);
          review++;
        } else {
          out.done.push(taskId);
          executed++;
        }
      } else {
        out.skipped.push({ id: taskId, reason: (fin && fin.error) || 'finish failed' });
      }
      return fin;
    }

    try {
      const due = store.listDuePlanTasks(now, { forRealExecutor: kind === 'real' }) || [];
      if (due.length) log('info', 'scan mode=' + kind + ' due=' + due.length);
      due.forEach(task => {
        try {
          // ---- 调度资格判定 ----
          //   real_only=1（用户显式「重新排队」等待真实执行）→ 只有注册了真实执行器的平台才走真实路径
          //   其余待执行任务 → 一律走模拟执行器（保留 mock 测试能力，绝不自动真实发布）
          const useReal = !!task.real_only;
          // 逾期暂停：关闭期间到期的真实计划任务在启动时被标记，等待用户在逾期提醒中处理。
          //   调度器不自动执行它们（仍然保持 pending，不代表取消），直到用户明确选择。
          if (useReal && typeof store.isPlanTaskHeld === 'function'
            && store.isPlanTaskHeld(task.id, task.scheduled_at)) {
            out.skipped.push({ id: task.id, reason: '逾期计划等待用户处理，不自动执行' });
            return;
          }
          let execFn = pickMockExecutor(kind);
          if (useReal) {
            const realAdapter = realExecutorFor(task.platform_id);
            if (!realAdapter) {
              out.skipped.push({
                id: task.id,
                reason: '该平台尚未接入真实发布（' + String(task.platform_id || '') + '）'
              });
              return;
            }
            // 真实执行器闸门：模拟任务 / 已确认成功 / 待人工确认 / 结果不确定 一律不执行
            const gate = checkRealExecutionGate(store, task);
            if (!gate.allow) {
              out.skipped.push({ id: task.id, reason: gate.reason });
              return;   // forEach 回调：用 return 跳过当前任务
            }
            execFn = realAdapter;
          }

          // 领取：条件更新保证同一个任务只会被一个扫描周期领走
          const claim = store.claimPlanTask(task.id, now);
          if (!claim || claim.ok === false) {
            out.skipped.push({ id: task.id, reason: (claim && claim.error) || 'not claimable' });
            return;
          }
          out.claimed.push(task.id);

          // 执行
          let result = null;
          try {
            result = execFn(claim.task, { now: now, mode: useReal ? 'real' : 'mock' });
          } catch (e) {
            result = classifyExecError(e, useReal);
          }

          if (result && typeof result.then === 'function') {
            // 异步执行器（真实平台）：结果回来后再落库
            const p = result.then(
              function (res) { return finishTask(task.id, claim.run_token, res); },
              function (e) {
                return finishTask(task.id, claim.run_token, classifyExecError(e, useReal));
              }
            );
            pending.push(p);
          } else {
            finishTask(task.id, claim.run_token, result);
          }
        } catch (e) {
          const reason = String((e && e.message) || e);
          out.skipped.push({ id: task.id, reason: reason });
          log('warn', 'task failed: ' + task.id + ' ' + reason);
        }
      });
      scans++;
      lastScan = now;
      lastError = '';
      if (out.skipped.length) {
        out.skipped.forEach(function (s) {
          log('info', 'task skipped ' + s.id + ' reason=' + s.reason);
        });
      }
      if (due.length) {
        log('info', 'scan summary mode=' + kind + ' due=' + due.length + ' claimed=' + out.claimed.length +
          ' done=' + out.done.length + ' failed=' + out.failed.length + ' review=' + out.review.length +
          ' skipped=' + out.skipped.length);
      }
    } catch (e) {
      lastError = String((e && e.message) || e);
      out.ok = false;
      out.error = lastError;
      log('warn', 'scan failed: ' + lastError);
    } finally {
      scanning = false;
    }
    out.settled = Promise.all(pending).then(function () { return out; });
    return out;
  }

  // 重启恢复：处理上次退出时遗留的 running 任务
  //   绝**不**把它们当成成功任务（那会伪造发布历史）。
  //   模拟执行的遗留任务 → 重新排队（模拟没有外部副作用，恢复能力保留）。
  //   真实发布的遗留任务 → 结果未知（可能已经发布）→ 转 needs_review，**不自动重发**。
  //   紧接着做一次「发布记录 ↔ 任务状态」对账：
  //   真实发布已成功、成功记录已落库、但任务结算前崩溃 → 任务会停在 pending，
  //   这里按严格的 pub_key + 作品 + 平台匹配把它推进到 done。
  function recover() {
    try {
      const store = getStore();
      const r = store.recoverStuckPlanTasks();
      let rec = { ok: true, reconciled: 0 };
      if (typeof store.reconcilePlanTasks === 'function') {
        rec = store.reconcilePlanTasks() || rec;
      }
      if (r && r.recovered) log('info', 'recovered stuck running tasks: ' + r.recovered);
      if (rec && rec.reconciled) log('info', 'reconciled published tasks: ' + rec.reconciled);
      return {
        ok: true,
        recovered: (r && r.recovered) || 0,
        reconciled: (rec && rec.reconciled) || 0,
        needs_review: (r && r.needs_review) || 0
      };
    } catch (e) {
      lastError = String((e && e.message) || e);
      log('warn', 'recover failed: ' + lastError);
      return { ok: false, error: lastError };
    }
  }

  function start() {
    if (started) return status();
    started = true;
    // 启动即恢复：先把上次遗留的 running 任务重新排队
    recover();
    // 关闭期间到期的真实计划任务：先暂停自动执行，交由「逾期计划」提醒让用户选择
    //   （只对本次启动前已经到期、仍在等待真实执行的 GitHub 任务打标；
    //     未到期 / 模拟任务的行为完全不变）。
    if (deps.holdMissedOverdueOnStart && typeof getStore === 'function') {
      try {
        const store = getStore();
        if (store && typeof store.holdMissedPlanTasks === 'function') {
          const h = store.holdMissedPlanTasks();
          if (h && Array.isArray(h.held) && h.held.length) {
            log('info', 'held missed overdue tasks: ' + h.held.length);
          }
        }
      } catch (e) {
        log('warn', 'hold missed overdue tasks failed: ' + String((e && e.message) || e));
      }
    }
    // 立即扫描一次（把关闭期间到期的任务补上）
    try { scanOnce(); } catch (e) { log('warn', 'initial scan failed: ' + String((e && e.message) || e)); }
    timer = setInterval(function () {
      try { scanOnce(); } catch (e) { log('warn', 'scan failed: ' + String((e && e.message) || e)); }
    }, intervalMs);
    // 不阻止进程退出
    if (timer && typeof timer.unref === 'function') { try { timer.unref(); } catch (_e) {} }
    log('info', 'started, interval=' + intervalMs + 'ms');
    return status();
  }

  function stop() {
    if (timer) {
      try { clearInterval(timer); } catch (_e) {}
      timer = null;
    }
    started = false;
    log('info', 'stopped');
    return status();
  }

  function status() {
    let counts = {};
    try {
      const store = getStore();
      (store.listPlanTasks('') || []).forEach(t => { counts[t.status] = (counts[t.status] || 0) + 1; });
    } catch (_e) {}
    const kind = currentKind();
    return {
      running: started,
      interval_ms: intervalMs,
      last_scan: lastScan,
      last_error: lastError,
      counts: counts,
      scans: scans,
      executed: executed,
      failed: failed,
      review: review,
      mode: kind,
      executor_kind: kind,
      real_platforms: Object.keys(realExecutors || {}).filter(function (k) { return !!realExecutors[k]; })
    };
  }

  return { start: start, stop: stop, scanOnce: scanOnce, recover: recover, status: status };
}

module.exports = {
  createPlanScheduler: createPlanScheduler,
  createMockPlanExecutor: createMockPlanExecutor,
  checkRealExecutionGate: checkRealExecutionGate,
  DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  MOCK_FAIL_MARKER: MOCK_FAIL_MARKER
};
