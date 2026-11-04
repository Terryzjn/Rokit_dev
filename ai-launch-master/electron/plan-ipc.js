// Rokit · 首秀计划 IPC 注册
// 从 main.js 抽出的计划配置 / 平台执行任务相关通道；
// store 由调用方注入，不直接依赖 Electron 或数据库，便于行为测试。
//
// 行为约定（与 works-crud-ipc 保持一致）：
//   - 同步执行：不做 async / await / Promise 包装
//   - 参数原样透传：不校验、不转换、不克隆
//   - 返回值保持对象身份：不复制、不重新构造
//   - store 在每次 handler 调用时读取（getStore()），不在注册时捕获实例
//
// 隔离约定：
//   - 每个通道都必须带作品 ID（workId），store 层据此校验归属；
//     一个作品的计划不会被另一个作品读取或覆盖。
//   - 删除阶段与取消任务是两个独立通道：删除阶段只影响该阶段的配置，
//     取消任务保留「已取消」状态与历史，不物理删除执行历史。
'use strict';

function registerPlanIpc(ipcMain, deps) {
  deps = deps || {};
  const getStore = deps.getStore;

  // 读取某作品的计划配置 + 平台执行任务
  ipcMain.handle('plan:list', (_e, workId) => {
    const store = getStore();
    return { stages: store.listPlanStages(workId), tasks: store.listPlanTasks(workId) };
  });

  // 保存某作品的整份计划配置（阶段增 / 改 / 删一次到位，任务按平台自动同步）
  ipcMain.handle('plan:save', (_e, workId, stages) => getStore().savePlanStages(workId, stages));

  // 删除单个阶段（只影响该阶段；其未执行任务被取消，已执行历史保留）
  ipcMain.handle('plan:delete-stage', (_e, workId, stageId) => getStore().deletePlanStage(workId, stageId));

  // 删除整份计划（该作品的全部阶段配置）
  //   未执行任务 → 取消（不再是 pending，调度器不会再选中它）；
  //   已执行历史与发布记录（pubs）→ 一律保留；
  //   正在执行 / 结果未知的真实任务 → 拒绝删除（见 store.deletePlan 的安全边界）。
  ipcMain.handle('plan:delete', (_e, workId) => getStore().deletePlan(workId));

  // 列出任务：workId 为空表示全部作品（「发布计划」全局视图用）
  ipcMain.handle('plan:tasks', (_e, workId) => getStore().listPlanTasks(workId));

  // 全部作品的计划配置 + 任务（「发布计划」全局视图用）
  ipcMain.handle('plan:all', (_e) => {
    const store = getStore();
    return { stages: store.listAllPlanStages(), tasks: store.listPlanTasks('') };
  });

  // 取消一个尚未执行的任务（保留已取消状态与历史）
  ipcMain.handle('plan:cancel-task', (_e, workId, taskId) => getStore().cancelPlanTask(workId, taskId));

  // 修改尚未执行任务的执行时间 / 备注（已完成的任务结果不可改写）
  ipcMain.handle('plan:update-task', (_e, workId, taskId, patch) => getStore().updatePlanTask(workId, taskId, patch));

  // 作品 ID 变更（新建作品落定 / 草稿转正）：把计划与任务改挂到新作品
  //   草稿归属转正为真实作品时，尚未执行任务的执行时间会按真实作品的 created_at 重算
  //   （原有天数偏移与指定时刻不变）；无法可靠还原时保留原值并返回原因（reschedule_kept）。
  ipcMain.handle('plan:reassign', (_e, fromOwner, toOwner) => {
    const store = getStore();
    const res = store.reassignPlanOwner(fromOwner, toOwner);
    // 草稿归属转正时，同时把「作品最新成品视频」映射迁到真实作品 ID。
    //   目标已有映射时不覆盖；迁移失败不影响计划归属迁移本身的结论。
    if (res && res.ok === true && typeof deps.migrateWorkFinalVideo === 'function') {
      try { deps.migrateWorkFinalVideo(fromOwner, toOwner); } catch (_e) {}
    }
    return res;
  });

  // ---- 作品最新成品视频映射（settings_kv，不新增数据库表） ----
  //   写入前主进程用 resolveFinalVideoFile 做 userData/video/final 白名单校验；
  //   读取时再次校验路径与文件是否存在。
  ipcMain.handle('plan:save-final-video', (_e, workId, videoPath) => {
    if (typeof deps.saveWorkFinalVideo !== 'function') {
      return { ok: false, error: 'unsupported' };
    }
    return deps.saveWorkFinalVideo(workId, videoPath);
  });

  ipcMain.handle('plan:get-final-video', (_e, workId) => {
    if (typeof deps.getWorkFinalVideo !== 'function') {
      return { ok: false, error: 'unsupported' };
    }
    return deps.getWorkFinalVideo(workId);
  });

  // 调度器状态（只读）：供页面显示「模拟调度器是否在运行 / 上次扫描时间」
  //   注意：这里**只读状态**，不提供任何手动触发执行的通道
  //   （页面刷新 / 编辑计划 / 打开作品都不应该触发任务执行）。
  ipcMain.handle('plan:scheduler-status', (_e) => {
    const getScheduler = deps.getScheduler;
    if (typeof getScheduler !== 'function') return { running: false, available: false, mode: 'mock' };
    const scheduler = getScheduler();
    if (!scheduler || typeof scheduler.status !== 'function') return { running: false, available: false, mode: 'mock' };
    const st = scheduler.status() || {};
    return Object.assign({ available: true }, st);
  });

  // 存储信息（只读）：当前数据库文件、数据目录、存储模式与驱动
  //   目的：让用户明确知道自己的数据写在哪个文件、用的哪种后端，
  //   避免 JSON 兜底被静默启用却毫无察觉。
  ipcMain.handle('plan:store-info', (_e) => {
    const store = getStore();
    if (!store || typeof store.storeInfo !== 'function') {
      return { available: false, mode: 'unknown', driver: 'unknown', file: '', dir: '' };
    }
    const info = store.storeInfo() || {};
    return Object.assign({ available: true }, info);
  });

  // 把一条「模拟完成」的任务重新排队 → 进入「等待真实执行」状态。
  //   只能操作模拟任务（simulated=1）；真实任务永远不受影响。
  //   可选传 opts.stage_id / opts.platform_id 做归属校验（不匹配直接拒绝）。
  ipcMain.handle('plan:requeue-simulated', (_e, workId, taskId, opts) => {
    const store = getStore();
    if (!store || typeof store.requeueSimulatedPlanTask !== 'function') {
      return { ok: false, error: '当前环境不支持重新排队' };
    }
    return store.requeueSimulatedPlanTask(workId, taskId, opts || {});
  });

  // 发布前幂等安全检查（只读）：给未来的真实平台执行器用
  //   allow / skip / review / unclear 四种结论，本次不触发任何真实发布。
  ipcMain.handle('plan:publish-guard', (_e, workId, taskId) => {
    const store = getStore();
    if (!store || typeof store.checkPlanPublishGuard !== 'function') {
      return { decision: 'unclear', reason: '当前环境没有发布前检查能力' };
    }
    return store.checkPlanPublishGuard(workId, taskId);
  });

  // ---------- 「待核实」任务的人工处理（仅 YouTube 首秀计划） ----------
  //
  // 背景：YouTube 上传结果不确定（进程退出 / 网络中断 / 未拿到 videoId）时，
  //   任务停在 status='needs_review'。系统**不自动重传**（上传不可撤销，
  //   重复上传会产生重复的公开视频），必须由用户人工核实后显式决定。
  //
  // 两条通道都不调用任何上传接口：
  //   - confirm-published：只写"已发布"事实（任务 → done + 发布记录 → ok）
  //   - confirm-retry：只把任务重新排回待执行队列（→ pending，real_only=1），
  //     真正执行仍由调度器按既有安全检查接手。
  //
  // 二次确认：A 需要 opts.confirmed === true；B 需要 opts.confirmed === true。
  ipcMain.handle('plan:confirm-published', (_e, workId, taskId, opts) => {
    const o = opts || {};
    if (o.confirmed !== true) {
      return { ok: false, error: 'confirmation-required', detail: '确认已发布需要二次确认' };
    }
    const store = getStore();
    if (!store || typeof store.confirmNeedsReviewPublished !== 'function') {
      return { ok: false, error: '当前环境不支持人工确认发布结果' };
    }
    return store.confirmNeedsReviewPublished(workId, taskId, {
      platform_ref: o.platform_ref,
      platform_url: o.platform_url,
      stage_id: o.stage_id
    });
  });

  ipcMain.handle('plan:confirm-retry', (_e, workId, taskId, opts) => {
    const o = opts || {};
    if (o.confirmed !== true) {
      return { ok: false, error: 'confirmation-required', detail: '确认未发布并允许重试需要二次确认' };
    }
    const store = getStore();
    if (!store || typeof store.requeueNeedsReviewRetry !== 'function') {
      return { ok: false, error: '当前环境不支持重新排队' };
    }
    return store.requeueNeedsReviewRetry(workId, taskId, {
      stage_id: o.stage_id,
      platform_id: o.platform_id
    });
  });

  // ---------- 逾期计划（跨平台通用管理机制） ----------
  // 判定规则：
  //   - 执行时间已过 + 任务仍是 pending → 逾期（**所有平台**：GitHub / YouTube /
  //     微信公众号 / 后续接入的平台）；
  //   - 不再以 real_only 作为条件：real_only 只决定「到期后由真实还是模拟执行器接手」，
  //     与「是否属于逾期计划」无关；用它过滤会让 real_only=0 的任务在启动扫描时
  //     被模拟执行器消费掉（status 变成 done / draft_pending），永远进不了逾期提醒。
  //   - running / needs_review（结果不确定）→ 绝不当作普通逾期重发；
  //   - done / cancelled / failed / draft_pending / 未到期 → 不提醒。
  // 用户操作全部复用现有调度器（claim / 闸门 / finish）与状态回写，不绕过安全检查。
  const OVERDUE_DELAY_MS = 24 * 60 * 60 * 1000;

  // 平台显示名（仅用于弹窗展示；平台身份本身仍以任务的 platform_id 为准）
  const OVERDUE_PLATFORM_LABEL = {
    github: 'GitHub',
    youtube: 'YouTube',
    wechat: '微信公众号'
  };
  function _overduePlatformLabel(platformId) {
    const pid = String(platformId || '');
    return OVERDUE_PLATFORM_LABEL[pid] || pid;
  }

  // 该平台的逾期任务是否**需要成品视频**（决定「立即执行」前的视频可用性闸门）。
  //   - github / youtube：要发布成品视频 → 视频不可用必须拒绝执行，绝不降级为纯文章；
  //   - wechat：文章草稿平台，**不需要**成品视频 → 既不读阶段视频快照，也不读
  //     「作品最新成品视频」映射，更不会因为作品视频被删 / 路径不在白名单而被拒绝
  //     （否则公众号逾期任务会因为一个与它无关的视频而永远执行不了）。
  //   未列出的平台一律按"需要视频"处理（保守：宁可拒绝，也不误发缺视频的内容）。
  const OVERDUE_VIDEO_FREE_PLATFORMS = ['wechat'];
  function _overduePlatformNeedsVideo(platformId) {
    return OVERDUE_VIDEO_FREE_PLATFORMS.indexOf(String(platformId || '')) < 0;
  }

  function _overdueNow(opts) {
    const v = opts && opts.now;
    if (v) {
      const d = new Date(String(v));
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  }

  function _taskById(store, workId, taskId) {
    const id = String(taskId || '');
    if (!id || !store || typeof store.listPlanTasks !== 'function') return null;
    return (store.listPlanTasks(String(workId || '')) || []).filter(t => t && String(t.id) === id)[0] || null;
  }

  // 逾期操作只接受「pending」状态的任务（**不限平台**）
  //   - 不再限定 GitHub：逾期处理是首秀计划的通用机制，所有接入平台一视同仁；
  //   - 不再要求 real_only=1：real_only 只决定执行器归属，不决定任务是否逾期；
  //   - 仍严格要求 status='pending'：done / cancelled / failed / draft_pending /
  //     running / needs_review 都不是「逾期待处理」，绝不被用户操作改写。
  function _findOverdueTask(store, workId, taskId) {
    const owner = String(workId || '');
    const id = String(taskId || '');
    if (!owner || !id) return { ok: false, error: 'missing-work-or-task' };
    if (!store || typeof store.listPlanTasks !== 'function') return { ok: false, error: 'store-unavailable' };
    const t = _taskById(store, owner, id);
    if (!t) return { ok: false, error: 'task-not-found' };
    if (String(t.status) !== 'pending') {
      return { ok: false, error: 'task-not-pending', status: String(t.status || '') };
    }
    return { ok: true, task: t };
  }

  function _stageForTask(store, task) {
    if (!task || !store || typeof store.listPlanStages !== 'function') return null;
    return (store.listPlanStages(String(task.work_id || '')) || [])
      .filter(s => s && String(s.id) === String(task.stage_id))[0] || null;
  }

  // 视频是否存在：计划快照优先，其次作品最新成品视频映射；两者都没有 → 纯文章。
  //   所有路径都必须经过主进程白名单校验（不读目录、不扫描、不推断）。
  //
  //   ★ 快照按**任务自己的平台**读取：
  //     GitHub   → copy.github.videoPath
  //     YouTube  → copy.youtube.videoPath
  //     其它平台（如微信公众号）→ 读各自平台的 copy 段；没有该段就没有快照，
  //     **绝不回退去读别的平台**（例如公众号任务不会去读 copy.github.videoPath）。
  //
  //   ★ 不需要视频的平台（微信公众号）：
  //     直接返回 required=false 的"无视频"结果 —— 既不读快照，也不回落到
  //     「作品最新成品视频」映射，因此永远不会因为作品视频失效而判成"缺少视频"。
  function _overdueVideo(store, task) {
    const st = _stageForTask(store, task);
    const pid = String((task && task.platform_id) || '');
    // 公众号等纯文章平台：没有视频这回事，source='none'（渲染层显示"本阶段将仅发布文章"）
    if (!_overduePlatformNeedsVideo(pid)) {
      return { source: 'none', ok: false, path: '', error: '', detail: '', required: false };
    }
    const copy = (st && st.copy && typeof st.copy === 'object') ? st.copy : null;
    const platCopy = (copy && copy[pid] && typeof copy[pid] === 'object') ? copy[pid] : null;
    const snap = platCopy ? String(platCopy.videoPath || '') : '';
    if (snap) {
      let chk = { ok: false, error: 'video-check-unavailable', detail: '' };
      if (typeof deps.checkFinalVideoPath === 'function') {
        try {
          chk = deps.checkFinalVideoPath(snap) || chk;
        } catch (e) {
          chk = { ok: false, error: 'video-check-failed', detail: String((e && e.message) || e) };
        }
      }
      return {
        source: 'snapshot', ok: chk.ok === true, path: snap, required: true,
        error: String(chk.error || ''), detail: String(chk.detail || '')
      };
    }
    if (typeof deps.getWorkFinalVideo === 'function') {
      let m = { ok: false, error: 'no-final-video' };
      try {
        m = deps.getWorkFinalVideo(String(task.work_id || '')) || m;
      } catch (e) {
        m = { ok: false, error: 'video-check-failed', detail: String((e && e.message) || e) };
      }
      if (m.ok === true) {
        return { source: 'work-latest', ok: true, path: String(m.path || ''), error: '', detail: '', required: true };
      }
      if (String(m.error || '') === 'no-final-video') {
        return { source: 'none', ok: false, path: '', error: '', detail: '' };
      }
      return {
        source: 'work-latest', ok: false, path: String(m.storedPath || ''), required: true,
        error: String(m.error || ''), detail: String(m.detail || '')
      };
    }
    return { source: 'none', ok: false, path: '', error: '', detail: '' };
  }

  // 列出逾期计划（只读）。
  //   启动检查必须在「计划恢复 + 任务状态对账」之后：这里先幂等调用 scheduler.recover()。
  //   多个逾期计划一次返回，由页面集中在一个窗口展示。
  ipcMain.handle('plan:overdue', (_e, opts) => {
    if (typeof deps.getScheduler === 'function') {
      const scheduler = deps.getScheduler();
      if (scheduler && typeof scheduler.recover === 'function') {
        try { scheduler.recover(); } catch (_e) {}
      }
    }
    const store = getStore();
    if (!store || typeof store.listPlanTasks !== 'function') {
      return { ok: false, error: 'store-unavailable', items: [] };
    }
    const nowD = _overdueNow(opts);
    const now = nowD.toISOString();
    const nameById = {};
    try {
      (typeof store.listWorks === 'function' ? (store.listWorks() || []) : []).forEach(w => {
        if (w && w.id) nameById[String(w.id)] = String(w.name || '');
      });
    } catch (_e) {}
    const items = (store.listPlanTasks('') || [])
      .filter(t => t
        // 跨平台：不限定 platform_id（GitHub / YouTube / 微信公众号 / 后续平台）
        && String(t.status) === 'pending'
        // 计划时间必须存在且已经到期
        && String(t.scheduled_at || '')
        && String(t.scheduled_at) <= now)
      .map(t => {
        const at = new Date(String(t.scheduled_at));
        const ms = isNaN(at.getTime()) ? 0 : Math.max(0, nowD.getTime() - at.getTime());
        const platformId = String(t.platform_id || '');
        return {
          workId: String(t.work_id || ''),
          workName: nameById[String(t.work_id || '')] || '',
          stageId: String(t.stage_id || ''),
          stageTitle: String(t.stage_title || ''),
          taskId: String(t.id || ''),
          platform: platformId,
          platformLabel: _overduePlatformLabel(platformId),
          scheduledAt: String(t.scheduled_at || ''),
          now: now,
          overdueMs: ms,
          status: String(t.status || ''),
          simulated: Number(t.simulated) ? 1 : 0,
          realOnly: Number(t.real_only) ? 1 : 0,
          note: String(t.note || ''),
          video: _overdueVideo(store, t)
        };
      })
      .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
    return { ok: true, now: now, items: items };
  });

  // A. 立即执行：解除暂停标记 → 把执行时间改为当前时刻 → 走现有调度器扫描。
  //   领取 / 资格校验 / 发布前闸门 / 幂等 / 结果落库全部沿用调度器，不在这里重实现。
  ipcMain.handle('plan:overdue-run', (_e, workId, taskId, opts) => {
    const store = getStore();
    if (!store) return { ok: false, error: 'store-unavailable' };
    const found = _findOverdueTask(store, workId, taskId);
    if (!found.ok) return found;

    const video = _overdueVideo(store, found.task);
    // 快照 / 映射存在但不可用 → 按视频发布失败处理，绝不降级为纯文章
    //   （只针对**需要视频**的平台；公众号等纯文章平台 required=false，不受此闸门约束，
    //     否则会因为一个与它无关的成品视频被删而永远执行不了）
    if (video.required !== false && video.ok === false
      && (video.source === 'snapshot' || video.source === 'work-latest')) {
      return { ok: false, error: 'video-unavailable', detail: video.detail || '', video: video };
    }

    const scheduler = (typeof deps.getScheduler === 'function') ? deps.getScheduler() : null;
    if (!scheduler || typeof scheduler.scanOnce !== 'function') {
      return { ok: false, error: 'scheduler-unavailable' };
    }

    if (typeof store.clearPlanTaskHold === 'function') store.clearPlanTaskHold(found.task.id);
    const nowD = _overdueNow(opts);
    const bumped = new Date(nowD.getTime() - 1000).toISOString();
    const upd = store.updatePlanTask(workId, found.task.id, { scheduled_at: bumped });
    if (!upd || upd.ok === false) {
      return { ok: false, error: 'reschedule-failed', detail: String((upd && upd.error) || '') };
    }

    let scan = null;
    try {
      scan = scheduler.scanOnce(nowD.toISOString());
    } catch (e) {
      return { ok: false, error: 'scan-failed', detail: String((e && e.message) || e) };
    }
    const settle = (scan && scan.settled) ? scan.settled : Promise.resolve(scan);
    return Promise.resolve(settle).then(function () {
      const after = _taskById(store, workId, found.task.id);
      const skipped = (scan && Array.isArray(scan.skipped))
        ? (scan.skipped.filter(s => String(s.id) === String(found.task.id))[0] || null)
        : null;
      const status = after ? String(after.status || '') : '';
      return {
        ok: true,
        executed: !!after && status !== 'pending',
        status: status,
        task: after,
        note: after ? String(after.note || '') : '',
        skipped_reason: skipped ? String(skipped.reason || '') : '',
        video: video
      };
    });
  });

  // B. 延后一天：以「用户点击处理的当前时刻」为基准 +24 小时。
  //   保留视频 / 正文 / 其它计划内容；任务与阶段时间一起更新，确保不再被判定为逾期。
  ipcMain.handle('plan:overdue-delay', (_e, workId, taskId, opts) => {
    const store = getStore();
    if (!store) return { ok: false, error: 'store-unavailable' };
    const found = _findOverdueTask(store, workId, taskId);
    if (!found.ok) return found;
    const nowD = _overdueNow(opts);
    const nextIso = new Date(nowD.getTime() + OVERDUE_DELAY_MS).toISOString();

    if (typeof store.clearPlanTaskHold === 'function') store.clearPlanTaskHold(found.task.id);
    const upd = store.updatePlanTask(workId, found.task.id, { scheduled_at: nextIso });
    if (!upd || upd.ok === false) {
      return { ok: false, error: 'reschedule-failed', detail: String((upd && upd.error) || '') };
    }
    let stageUpdated = false;
    if (typeof store.updatePlanStageScheduledAt === 'function') {
      const r = store.updatePlanStageScheduledAt(workId, found.task.stage_id, nextIso);
      stageUpdated = !!(r && r.ok === true);
    }
    return {
      ok: true, scheduledAt: nextIso, task: upd.task, stage_updated: stageUpdated,
      video_kept: true, content_kept: true
    };
  });

  // C. 放弃计划：必须二次确认（opts.confirmed === true）。
  //   标记取消 + 解除该计划对视频的引用；不立即删除视频文件。
  ipcMain.handle('plan:overdue-abandon', (_e, workId, taskId, opts) => {
    const o = opts || {};
    if (o.confirmed !== true) {
      return { ok: false, error: 'confirmation-required', detail: '放弃逾期计划需要二次确认' };
    }
    const store = getStore();
    if (!store) return { ok: false, error: 'store-unavailable' };
    const found = _findOverdueTask(store, workId, taskId);
    if (!found.ok) return found;
    const canceled = store.cancelPlanTask(workId, found.task.id);
    if (!canceled || canceled.ok === false) {
      return { ok: false, error: 'cancel-failed', detail: String((canceled && canceled.error) || '') };
    }
    if (typeof store.clearPlanTaskHold === 'function') store.clearPlanTaskHold(found.task.id);
    let detach = { ok: true, changed: false };
    if (typeof store.detachPlanVideoReference === 'function') {
      try {
        // 按任务自己的平台解绑视频引用：放弃 YouTube 计划不会去动 copy.github.videoPath
        detach = store.detachPlanVideoReference(workId, found.task.stage_id, {
          platformId: String(found.task.platform_id || '')
        }) || detach;
      } catch (e) {
        detach = { ok: false, error: String((e && e.message) || e) };
      }
    }
    return {
      ok: true, canceled: true, task: canceled.task, detach: detach,
      video_kept: true, video_deleted: false
    };
  });

}

module.exports = { registerPlanIpc };
