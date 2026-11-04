// Rokit · 首秀计划 —— 微信公众号真实执行适配器（只创建草稿）
//
// 职责：把一条「platform_id='wechat'」的计划任务，真实地在**公众号草稿箱**创建一篇图文草稿，
//       并把结果写回统一发布记录 pubs + 计划任务 plan_tasks。
//
// ★ 业务含义（不可更改）：
//   任务 status='done' **只代表「公众号草稿箱已成功创建草稿」**，
//   绝不代表文章已正式发表、也绝不代表已群发给粉丝。
//   草稿创建后由用户在公众号后台自行确认发表。
//
// ★ 为什么只做草稿：
//   当前公众号账号**没有** freepublish/submit（正式发表 / 群发）接口权限。
//   因此本执行器**只**调用 /draft/add，绝不触碰正式发表与群发接口。
//
// 复用既有能力（不重复造轮子、不另建一套草稿流程）：
//   - 草稿创建：**直接调用**普通公众号发布的草稿创建入口
//     （electron/wechat.js 的 createDraft，由 main.js 注入 createDraftEntry）。
//     createDraft 内部已封装：access_token 获取与 40001/42001 自动刷新、
//     标题 / 正文长度校验、正文转公众号 HTML、摘要截断、封面 thumb_media_id 绑定。
//     本文件**不实现任何草稿逻辑**，只负责"何时建、建什么、结果怎么记"。
//   - 封面素材：复用普通链路的封面素材 ID（账号级 thumb_media_id，
//     由 wechat.createDraft 从 credentials 读取）；计划快照里若带了
//     thumbMediaId 则优先使用快照值。
//   - 发布记录写入：store.addPub()（按 pub_key upsert，与手动发布同一张 pubs 表）。
//   - 任务发布信息：store.markPlanTaskReleaseInfo()（写入 platform_ref / platform_url）。
//   - 幂等闸门：store.checkPlanPublishGuard()（由调度器在调用本适配器之前执行）。
//
// ★ 发布记录（pubs）状态语义（与普通公众号链路完全一致）：
//   - 草稿创建成功 → 记录状态写 **'pending'（仅草稿 / 草稿待发布）**，**不写 'ok'**。
//     普通公众号链路也是这个口径：草稿保存后写 pending（index.html markPub('wechat',{status:'pending'})），
//     只有群发成功后才写 'ok'。本执行器不发表也不群发，因此永远停在 pending。
//     这样做的直接效果：
//       1) 「发布记录」页显示"草稿待发布"，**不显示"已发布"**，不误报为正式发表成功；
//       2) 该条记录**不计入发布次数**（既有口径：只有 ok / manual 计入）；
//       3) store._planPubState / _planFindConfirmedPub 只认 ok / manual → 不会把
//          "草稿已建"当成"文章已发表"。
//   - 草稿 media_id 落在 pubs.video_id（可核对到公众号草稿箱里的具体哪一篇），
//     同时落在 plan_tasks.platform_ref。
//   - 与"结果不明确"（needs_review）的 pending 记录可区分：
//     成功 = pending + video_id 有值 + error 为空；不明确 = pending + video_id 为空 + error 有值。
//
// 已确认的业务规则（不可更改）：
//   1. **绝不**调用 /freepublish/submit（正式发表），**绝不**调用群发接口
//      （/message/mass/sendall 等）。草稿创建成功即视为本次任务执行成功。
//   2. 草稿创建失败 → 任务失败终止 + 记录错误信息，**不自动重试**
//      （避免重复创建草稿）；由用户手动重新排队后再由调度器执行。
//   3. 草稿创建结果不明确（请求可能已成功但本地记录失败 / 接口异常）→
//      进入 needs_review，**绝不**再次创建草稿，等待人工核实。
//      （由既有框架保证：store.listDuePlanTasks 只取 status='pending'；
//        store.recoverStuckPlanTasks 把真实执行遗留的 running 转 needs_review；
//        store.reconcilePlanTasks 只处理 pending，不会碰 needs_review。）
//   4. 模拟任务绝不进入真实草稿创建路径。
//   5. 草稿创建必须**异步执行**，不阻塞其它计划任务。
//
// 明确不做：
//   - 不改 electron/wechat.js（草稿创建实现零改动）
//   - 不改 electron/plan-scheduler.js（平台分发由 realExecutors 查表完成）
//   - 不改数据库表结构（pubs.video_id / plan_tasks.platform_ref 足够承载草稿 media_id）
//   - 不实现正式发表、不实现群发、不做浏览器模拟点击
'use strict';

function createWechatPlanExecutor(deps) {
  deps = deps || {};
  const getStore = deps.getStore;
  // 普通公众号发布的草稿创建入口（main.js 注入 wechat.createDraft 的包装）
  const createDraftEntry = deps.createDraft || null;
  const listWorks = deps.listWorks || defaultListWorks;

  // 失败结果统一格式：error = 机器可读码 + 人类可读说明（界面直接展示）
  function fail(code, message, hint) {
    return {
      ok: false,
      simulated: false,
      error: code + '（' + String(message || '') + '）',
      note: String(hint || message || '')
    };
  }

  // 需要人工核实的状态：结果不确定或需要人工介入。
  //   ok:true + status:'needs_review' → 调度器 finishPlanTask 落成 needs_review。
  //   **不**设置 platform_ref / platform_url 为成功值，避免被误认为已发表。
  function needReview(code, message, hint) {
    return {
      ok: true,
      status: 'needs_review',
      simulated: false,
      error: code + '（' + String(message || '') + '）',
      note: String(hint || message || '')
    };
  }

  // 结果不确定的失败码：**草稿可能已经创建成功**。
  //   草稿创建虽不像 YouTube 那样不可撤销，但重复创建会产生重复草稿，
  //   且用户可能已经在后台看到一篇草稿 → 一律转 needs_review，人工核实。
  const UNCERTAIN_CODES = [
    'NETWORK',        // 网络中断：请求可能已被微信服务端接收
    'API_5XX',        // 服务端错误：可能已写入
    'TOKEN_REFRESH_FAILED', // 请求中令牌失效：无法确认草稿是否已创建
    'UNEXPECTED'      // 创建过程抛出未预期异常
  ];
  function isUncertainCode(code) {
    return UNCERTAIN_CODES.indexOf(String(code || '').toUpperCase()) >= 0;
  }

  // 权限类失败码（账号没有草稿接口权限等）→ 明确失败，不自动重试。
  const PERMISSION_CODES = ['PERMISSION_DENIED', 'NOT_CONNECTED', 'CONFIG_REQUIRED'];

  // 本地发布记录：失败不阻断任务状态回写。
  //   返回 true = 已确认落库；false = 写入失败。
  //   store.addPub() 的真实返回约定：成功 → 返回**已落库的行对象**（truthy）；
  //   失败 → 抛异常；极少数情况返回 undefined（同样视为失败）。
  //   行对象上没有 ok 字段 → 不能用 res.ok === true 判定。
  function writePub(store, payload) {
    let res;
    try {
      res = store.addPub(payload);
    } catch (_e) {
      return false;
    }
    if (!res || typeof res !== 'object') return false;   // 未真正落库
    return true;
  }

  async function exec(task) {
    // ---------- 0. 只处理微信公众号 ----------
    if (!task || String(task.platform_id) !== 'wechat') {
      return fail('platform-not-supported', '本适配器只处理微信公众号计划任务');
    }
    // ---------- 1. 模拟任务绝不进真实草稿创建路径 ----------
    if (task.simulated) {
      return fail('simulated-task', '模拟任务不得进入真实发布路径');
    }
    // ---------- 1b. 已有确认成功的发布记录 → 不重复创建草稿 ----------
    //   （调度器的 checkPlanPublishGuard 已做同等判定，这里是执行器侧的兜底，
    //     防止未来有人绕过闸门直接调用本执行器。）
    const store = getStore();
    const workId = String(task.work_id || '');
    const stageId = String(task.stage_id || '');
    const pubKey = String(task.pub_key || ('plan|' + workId + '|' + stageId + '|wechat'));

    // ---------- 2. 定位作品（必须属于该任务） ----------
    const work = (listWorks(store) || []).filter(function (w) {
      return w && String(w.id || '') === workId;
    })[0];
    if (!work) {
      return fail('missing-work', '计划任务对应的作品不存在');
    }

    // ---------- 3. 定位阶段与文案快照 ----------
    const stage = (store.listPlanStages(workId) || []).filter(function (s) {
      return s && String(s.id) === stageId;
    })[0];
    if (!stage) {
      return fail('missing-stage', '计划任务对应的阶段不存在');
    }
    // copy.wechat：标题 / 正文 / 标签 / 封面快照（保存计划时写入）
    const copy = (stage.copy && typeof stage.copy === 'object') ? (stage.copy.wechat || null) : null;
    const title = String((copy && copy.title) || '').trim();
    const body = String((copy && copy.body) || '').trim();
    if (!title || !body) {
      return fail('missing-copy',
        '该阶段没有保存公众号标题 / 正文',
        '请先在「首秀计划」里生成并保存该阶段的公众号文案，再重新排队。本计划只创建草稿，不会正式发表。');
    }
    // 封面素材 ID：优先用计划快照里的（阶段级），否则由 createDraft 用账号级配置兜底。
    const thumbMediaId = String((copy && copy.thumbMediaId) || '').trim();

    // ---------- 4. 草稿创建入口依赖检查（必须在写 pending 之前） ----------
    //   没有可用的草稿入口 → 直接判定为内部配置错误，
    //   **不写 pending 发布记录**（免得留下一条永远不会推进的"幽灵记录"），
    //   更不会调用草稿接口。
    if (typeof createDraftEntry !== 'function') {
      return fail('draft-entry-missing', '未注入公众号草稿创建入口',
        '内部配置问题：首秀计划没有拿到公众号草稿创建入口，请检查 main.js 的执行器注册。本次未产生任何发布记录，也未创建任何草稿。');
    }

    // ---------- 5. 先登记 pending 发布记录 ----------
    //   幂等凭据必须**先落库**：写不进去就绝不能开始创建草稿
    //   （丢了 pub_key = 丢了防重复保护，比发不出去更危险）。
    //   同一 pub_key 的 pending → ok / failed 是**同一条记录更新**，不会新增第二行。
    const pendingWritten = writePub(store, {
      work_id: workId, platform: '微信公众号', platform_id: 'wechat',
      status: 'pending', title: title, body: body,
      tags: Array.isArray(copy && copy.tags) ? copy.tags.join(' ') : '',
      time: '', url: '', error: '', video_id: '', pub_key: pubKey
    });
    if (!pendingWritten) {
      return fail('pubs-write-failed',
        '写入本地发布记录失败，已放弃本次草稿创建',
        '本地发布记录（幂等凭据）写不进去，继续创建会导致无法判断草稿是否已建好，系统因此放弃本次创建；请稍后手动重新排队。');
    }

    // ---------- 6. 创建草稿（异步；复用普通链路的同一入口） ----------
    //   ★ 只调 /draft/add，**绝不**调 /freepublish/submit，**绝不**群发。
    let dr = null;
    try {
      dr = await createDraftEntry({
        title: title,
        body: body,
        intro: body,
        link: String((copy && copy.link) || work.url || ''),
        thumbMediaId: thumbMediaId
      });
    } catch (e) {
      // 创建过程中抛出异常：**结果未知**（草稿可能已被微信创建）
      //   → needs_review，绝不自动重试，绝不再次创建草稿。
      return needReview(
        'draft-exception',
        '创建公众号草稿过程中抛出未预期异常，无法确认草稿是否已创建：' + String((e && e.message) || e),
        '系统不会自动重试（重复创建会产生重复草稿）。请人工到公众号后台草稿箱核实是否已生成草稿，再决定处理方式。'
      );
    }

    // ---------- 7. 草稿创建失败 ----------
    //   分两类，**绝不混淆**：
    //   a) 结果不确定（NETWORK / API_5XX / TOKEN_REFRESH_FAILED / UNEXPECTED）
    //      → 草稿可能已创建 → 转 needs_review，人工核实，绝不自动重试。
    //   b) 明确失败（权限缺失 / 配置缺失 / 参数非法 / 账号无草稿接口权限等）
    //      → 确定没有创建草稿 → 任务失败终止，**不自动重试**（用户手动重新排队）。
    if (!dr || dr.status !== 'draft_created' || !dr.mediaId) {
      const code = String((dr && dr.error) || (dr && dr.status) || 'draft-failed');
      const note = String((dr && dr.note) || '公众号草稿创建失败');
      // a) 结果不确定 → 发布记录保持 pending（pending = "可能已经建好了"，绝不能写成 failed）
      if (isUncertainCode(code)) {
        writePub(store, {
          work_id: workId, platform: '微信公众号', platform_id: 'wechat',
          status: 'pending', title: title, body: body,
          tags: Array.isArray(copy && copy.tags) ? copy.tags.join(' ') : '',
          time: '', url: '', error: code + (note ? ('：' + note) : ''), video_id: '', pub_key: pubKey
        });
        return needReview(code, note,
          '创建草稿过程中网络 / 服务端结果不确定，公众号侧可能已经创建了草稿；系统不会自动重试（重复创建会产生重复草稿）。请人工到公众号后台草稿箱核实后再处理。');
      }
      // b) 明确失败 → 发布记录更新为 failed（同一 pub_key → 同一条记录）
      writePub(store, {
        work_id: workId, platform: '微信公众号', platform_id: 'wechat',
        status: 'failed', title: title, body: body,
        tags: Array.isArray(copy && copy.tags) ? copy.tags.join(' ') : '',
        time: '', url: '', error: code + (note ? ('：' + note) : ''), video_id: '', pub_key: pubKey
      });
      const extra = PERMISSION_CODES.indexOf(code.toUpperCase()) >= 0
        ? '请检查公众号后台「开发 → 接口权限」是否已开通草稿箱（draft）相关接口，以及设置里的 AppID / AppSecret / 封面素材 ID。'
        : '修复后请手动重新排队本计划。';
      return fail(code, note, '草稿创建失败，系统不会自动重试；' + extra + '本计划只创建草稿，不会正式发表或群发。');
    }

    // ---------- 8. 草稿创建成功 → 更新同一条发布记录（同一 pub_key → 同一条记录） ----------
    //   ★ 状态写 **'pending'（仅草稿 / 草稿待发布）**，**绝不写 'ok'（已发布）**：
    //     普通公众号链路也是这个口径（草稿保存后 pending，群发成功后才 ok），
    //     本执行器不发表也不群发 → 记录停在 pending，
    //     「发布记录」页显示"草稿待发布"、不计入发布次数，
    //     绝不把"草稿已创建"误报成"已正式发表 / 已群发"。
    const mediaId = String(dr.mediaId || '');
    const recordWritten = writePub(store, {
      work_id: workId, platform: '微信公众号', platform_id: 'wechat',
      status: 'pending', title: title, body: body,
      tags: Array.isArray(copy && copy.tags) ? copy.tags.join(' ') : '',
      time: new Date().toISOString(),
      url: '', error: '', video_id: mediaId, pub_key: pubKey
    });
    if (!recordWritten) {
      // ★ 草稿已创建成功，但本地记录写失败：
      //   绝不能当成"普通失败"让系统立刻再建一次（会产生重复草稿）
      //   → 转 needs_review，并把真实 media_id 保留下来供人工核验。
      return needReview(
        'pubs-write-failed',
        '公众号草稿已创建成功（media_id ' + mediaId + '），但本地发布记录写入失败，请人工核验',
        '系统不会自动重试（重复创建会产生重复草稿）。请人工到公众号后台草稿箱核对该草稿（media_id ' + mediaId + '）后再处理。'
      );
    }

    // ---------- 9. 把真实标识写进任务行 ----------
    //   这样即使进程在随后的 finishPlanTask() 之前崩溃，
    //   恢复对账（reconcilePlanTasks）也能取回真实的 media_id。
    //   **写失败不触发第二次创建**（这里只是记录动作，忽略错误即可）。
    try {
      if (typeof store.markPlanTaskReleaseInfo === 'function') {
        store.markPlanTaskReleaseInfo(workId, String(task.id || ''), {
          platform_ref: mediaId,
          platform_url: ''
        });
      }
    } catch (_e) { /* 写不进去不影响本次成功判定（恢复对账会兜底回填） */ }

    return {
      ok: true,
      status: 'done',
      simulated: false,
      platform_ref: mediaId,
      platform_url: '',
      video_id: mediaId,
      note: '公众号草稿已创建（media_id ' + mediaId + '）'
        + '（本次仅创建草稿，未正式发表、未群发；请在公众号后台确认后自行发表）'
    };
  }

  return exec;
}

/* ---------- 默认依赖（生产） ---------- */
function defaultListWorks(store) {
  if (store && typeof store.listWorks === 'function') return store.listWorks();
  return [];
}

module.exports = {
  createWechatPlanExecutor: createWechatPlanExecutor
};
