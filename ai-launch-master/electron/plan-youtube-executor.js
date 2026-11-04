
// Rokit · 首秀计划 —— YouTube 真实发布适配器
//
// 职责：把一条「platform_id='youtube'」的计划任务，真实地上传成一条 YouTube 视频，
//       并把结果写回统一发布记录 pubs + 计划任务 plan_tasks。
//
// 复用既有能力（不重复造轮子、不新增第二套上传实现）：
//   - 视频上传：**直接调用**普通自动发布的 youtube 上传入口（main.js pubExecYouTube，
//     由 main.js 在创建执行器时注入 publishVideo）。
//     pubExecYouTube 内部已封装：成品视频白名单校验（resolveFinalVideoFile）、
//     OAuth 取令牌与自动刷新、scope 检查、Resumable 分块上传、实际可见性如实上报。
//     本文件不实现任何上传逻辑，只负责"何时传、传什么、结果怎么记"。
//   - 成品视频回退：main.js getWorkFinalVideo(workId)（settings_kv 的 finalVideo:<workId>，
//     读取时再次做白名单 + 文件存在性校验），由 main.js 注入 resolveWorkFinalVideo。
//   - 发布记录写入：store.addPub()（按 pub_key upsert，与手动发布同一张 pubs 表）。
//   - 任务发布信息：store.markPlanTaskReleaseInfo()（写入 platform_ref / platform_url）。
//   - 幂等闸门：store.checkPlanPublishGuard()（由调度器在调用本适配器之前执行）。
//
// 已确认的业务规则（不可更改）：
//   1. 隐私状态**始终固定为 'public'**（不读取 UI 值、不依赖渲染层）。
//   2. 不传 categoryId（YouTube 使用默认分类）。
//   3. 上传成功但本地记录前崩溃 / 执行结果无法确认 → 任务进入 needs_review。
//      needs_review **禁止自动重传**，必须人工确认后再处理。
//      （由既有框架保证：store.listDuePlanTasks 只取 status='pending'；
//        store.recoverStuckPlanTasks 把真实执行遗留的 running 转 needs_review；
//        store.reconcilePlanTasks 只处理 pending，不会碰 needs_review。）
//   4. 上传失败**不自动重试**，由用户手动重新排队。
//      （由既有框架保证：store.checkPlanPublishGuard 对 status='failed' 返回 unclear 拒绝执行。）
//   5. OAuth 未授权 / 授权过期 / 缺少上传权限 → **不在后台弹 OAuth 窗口**，
//      转入人工处理状态（needs_review），绝不尝试拉起浏览器授权。
//   6. 上传必须**异步执行**，不阻塞其它计划任务。
//      （调度器对 Promise 返回值走 pending 挂起，不阻塞下一轮扫描。）
//
// 明确不做：
//   - 不改 electron/youtube-publisher.js（上传实现零改动）
//   - 不改 electron/plan-scheduler.js（平台分发由 realExecutors 查表完成）
//   - 不改 store.js 与数据库表结构（pubs.video_id / plan_tasks.platform_ref 足够承载）
//   - 不改普通 YouTube 发布链路（pubExecYouTube 原样复用）
//   - 不依赖渲染窗口 / 进度 UI（后台执行不订阅 youtube:upload-progress）
'use strict';

// YouTube 隐私状态：固定 public（已确认的业务规则）。
const FIXED_PRIVACY_STATUS = 'public';

function createYoutubePlanExecutor(deps) {
  deps = deps || {};
  const getStore = deps.getStore;
  // 普通自动发布的 YouTube 上传入口（main.js 注入 pubExecYouTube）
  const publishVideo = deps.publishVideo || null;
  // 作品最新成品视频（settings_kv）：仅当计划快照为空时的只读回退。
  const resolveWorkFinalVideo = deps.resolveWorkFinalVideo || null;
  const listWorks = deps.listWorks || defaultListWorks;
  // OAuth 令牌（main.js 注入 oauth.getValidAccessToken('youtube')）。
  //   仅用于**提前判定是否已授权**：未授权时直接转人工处理，
  //   绝不在后台拉起 OAuth 窗口（后台没有可交互的渲染层）。
  const getToken = deps.getToken || null;

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
  //   **不**设置 platform_ref / platform_url 为成功值，避免被误认为已发布。
  function needReview(code, message, hint) {
    return {
      ok: true,
      status: 'needs_review',
      simulated: false,
      error: code + '（' + String(message || '') + '）',
      note: String(hint || message || '')
    };
  }

  // 结果不确定的失败码：**可能已经上传成功**（网络中断 / 5xx / 上传中令牌失效 / 未预期异常）。
  //   这类绝不能当成"明确失败"让系统重发 —— YouTube 上传不可撤销，
  //   重复上传会产生重复的公开视频 → 一律转 needs_review，人工核实。
  //   与 GitHub 首秀计划同一套判定思路（network / 5xx → 不确定）。
  const UNCERTAIN_CODES = [
    'NETWORK',        // 网络中断：最后一个分块可能已被服务端接收
    'API_5XX',        // 服务端错误：可能已写入
    'TOKEN_REFRESH_FAILED', // 上传中刷新令牌失败：已上传的分块无法确认
    'UNEXPECTED'      // 上传过程抛出未预期异常（pubExecYouTube 内部已捕获并转成该码）
  ];
  function isUncertainCode(code) {
    return UNCERTAIN_CODES.indexOf(String(code || '').toUpperCase()) >= 0;
  }
  // 授权类失败码：后台**不弹 OAuth 窗口** → 转人工处理。
  const AUTH_CODES = ['NOT_CONNECTED', 'YOUTUBE_REAUTH_REQUIRED', 'SCOPE_INSUFFICIENT'];
  function isAuthCode(code) {
    return AUTH_CODES.indexOf(String(code || '').toUpperCase()) >= 0;
  }

  // 本地发布记录：失败不阻断任务状态回写。
  //   返回 true = 已确认落库；false = 写入失败。
  //
  //   store.addPub() 的真实返回约定（已核对 electron/store.js L895-L962 并实测两种驱动）：
  //     · 成功 → 返回**已落库的那一行记录对象**（truthy）；
  //       - 插入分支：返回新构造的 row；
  //       - upsert 分支：返回 this.get('SELECT * FROM pubs WHERE pub_key = ?') 查出的行；
  //     · 失败 → **抛异常**（数据库写入错误等）；
  //     · 极少数情况下 upsert 分支的 SELECT 查不到行 → 返回 undefined（同样视为失败）。
  //   它**没有** {ok:true} 这类状态对象，因此：
  //     - 不能只看"有没有抛异常"就认定成功（可能返回 undefined）；
  //     - 也不能检查 res.ok === true（行对象上没有 ok 字段，会把合法成功误判为失败）。
  //   正确判定：无异常 且 返回值为 truthy 对象 → 成功。
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
    // ---------- 0. 只处理 YouTube ----------
    if (!task || String(task.platform_id) !== 'youtube') {
      return fail('platform-not-supported', '本适配器只处理 YouTube 计划任务');
    }
    // ---------- 1. 模拟任务绝不进真实发布路径 ----------
    if (task.simulated) {
      return fail('simulated-task', '模拟任务不得进入真实发布路径');
    }
    // ---------- 1b. 已有确认成功的发布记录 → 不重复上传 ----------
    //   （调度器的 checkPlanPublishGuard 已做同等判定，这里是执行器侧的兜底，
    //     防止未来有人绕过闸门直接调用本执行器。）
    const store = getStore();
    const workId = String(task.work_id || '');
    const stageId = String(task.stage_id || '');
    const pubKey = String(task.pub_key || ('plan|' + workId + '|' + stageId + '|youtube'));

    // ---------- 2. 定位作品（必须属于该任务） ----------
    const work = (listWorks(store) || []).filter(function (w) {
      return w && String(w.id || '') === workId;
    })[0];
    if (!work) {
      return fail('missing-work', '计划任务对应的作品不存在');
    }

    // ---------- 3. 定位阶段与文案快照 ----------
    const stage = (store.listPlanStages(workId) || []).filter(function (s) {
      return s && String(s.id || '') === stageId;
    })[0];
    if (!stage) {
      return fail('missing-stage', '计划任务对应的阶段不存在');
    }
    // copy.youtube：标题 / 正文 / 标签 / 成品视频快照（保存计划时写入）
    const copy = (stage.copy && typeof stage.copy === 'object') ? (stage.copy.youtube || null) : null;
    const title = String((copy && copy.title) || '').trim();
    const description = String((copy && copy.body) || '').trim();
    if (!title) {
      return fail('missing-copy', '该阶段没有保存 YouTube 标题', '请先在「首秀计划」里生成并保存该阶段的 YouTube 文案，再重新排队');
    }
    const tags = (copy && Array.isArray(copy.tags))
      ? copy.tags.map(function (t) { return String(t || ''); }).filter(Boolean)
      : [];

    // ---------- 4. OAuth 预检：未授权 / 过期 / 缺上传权限 → 转人工处理 ----------
    //   后台没有可交互的渲染层，**绝不**尝试拉起 OAuth 授权窗口。
    if (typeof getToken === 'function') {
      let token = null;
      try {
        token = await getToken();
      } catch (e) {
        token = null;
      }
      if (!token) {
        return needReview(
          'youtube-not-authorized',
          '尚未完成 YouTube 授权或授权已过期',
          '后台执行不会弹出 OAuth 授权窗口：请到「推广渠道 → YouTube」重新完成授权（需包含 youtube.upload 上传权限），再手动重新排队本计划。系统不会自动重试。'
        );
      }
    }

    // ---------- 5. 最终成品视频 ----------
    //   来源优先级（与 GitHub 首秀计划完全一致）：
    //     1) 计划快照 copy.youtube.videoPath（保存计划时写入；存在则严格使用它，
    //        避免计划引用的视频被该作品后来的新视频悄悄替换）
    //     2) 作品最新成品视频映射 finalVideo:<workId>（settings_kv，只读回退）
    //   两者都没有 / 文件不可用 → 明确失败。
    //   绝不上传原始本地视频 / AI 录屏原始 WebM（没有任何回退分支）。
    let finalVideoPath = String((copy && copy.videoPath) || '').trim();
    let videoSource = finalVideoPath ? 'snapshot' : 'none';
    if (!finalVideoPath && typeof resolveWorkFinalVideo === 'function') {
      let wr = null;
      try {
        wr = await resolveWorkFinalVideo(workId);
      } catch (e) {
        wr = { ok: false, error: 'exception', detail: String((e && e.message) || e) };
      }
      if (wr && wr.ok === true && wr.path) {
        finalVideoPath = String(wr.path);
        videoSource = 'work-latest';
      } else {
        const code = String((wr && wr.error) || 'final-video-unavailable');
        const detail = String((wr && wr.detail) || '');
        return fail(
          code === 'no-final-video' ? 'missing-final-video' : code,
          detail || '未找到可用的最终成品视频',
          '请先在「视频成片」步骤完成字幕与配音生成并保存成品，再重新排队本计划。系统不会上传原始视频。'
        );
      }
    }
    if (!finalVideoPath) {
      return fail('missing-final-video', '未找到可用的最终成品视频',
        '请先在「视频成片」步骤完成字幕与配音生成并保存成品，再重新排队本计划。系统不会上传原始视频。');
    }

    // ---------- 6. 上传入口依赖检查（必须在写 pending 之前） ----------
    //   没有可用的上传入口 → 直接判定为内部配置错误，
    //   **不写 pending 发布记录**（免得留下一条永远不会推进的"幽灵记录"），
    //   更不会调用上传入口。
    if (typeof publishVideo !== 'function') {
      return fail('publish-entry-missing', '未注入 YouTube 上传入口',
        '内部配置问题：首秀计划没有拿到 YouTube 上传入口，请检查 main.js 的执行器注册。本次未产生任何发布记录，也未发起上传。');
    }

    // ---------- 7. 先登记 pending 发布记录 ----------
    //   幂等凭据必须**先落库**：写不进去就绝不能开始上传
    //   （丢了 pub_key = 丢了防重复保护，比发不出去更危险）。
    //   同一 pub_key 的 pending → ok / failed 是**同一条记录更新**，不会新增第二行。
    const pendingWritten = writePub(store, {
      work_id: workId, platform: 'YouTube', platform_id: 'youtube',
      status: 'pending', title: title, body: description,
      tags: tags.join(' '),
      time: '', url: '', error: '', video_id: '', pub_key: pubKey
    });
    if (!pendingWritten) {
      return fail('pubs-write-failed',
        '写入本地发布记录失败，已放弃本次上传',
        '本地发布记录（幂等凭据）写不进去，继续上传会导致无法判断是否已发布，系统因此放弃本次上传；请稍后手动重新排队。');
    }

    // ---------- 8. 上传（异步；复用普通自动发布的同一入口） ----------
    //   privacyStatus 固定 'public'；不传 categoryId。
    //   不传 onProgress：后台执行不依赖渲染窗口 / 进度 UI。
    let up = null;
    try {
      up = await publishVideo({
        title: title,
        description: description,
        tags: tags,
        privacyStatus: FIXED_PRIVACY_STATUS,
        finalVideoPath: finalVideoPath
      });
    } catch (e) {
      // 上传过程中抛出异常：**结果未知**（可能已被 YouTube 接收）
      //   → needs_review，绝不自动重传。
      return needReview(
        'upload-exception',
        '上传过程中抛出未预期异常，无法确认 YouTube 是否已收到视频：' + String((e && e.message) || e),
        '系统不会自动重传（YouTube 上传不可撤销，重复上传会产生重复视频）。请人工到 YouTube 后台核实是否已生成视频，再决定处理方式。'
      );
    }

    // ---------- 9. 上传失败 ----------
    //   分三类，**绝不混淆**（YouTube 上传不可撤销，误判会导致重复公开视频）：
    //   a) 结果不确定（NETWORK / API_5XX / TOKEN_REFRESH_FAILED / UNEXPECTED）
    //      → 可能已上传成功 → 转 needs_review，人工核实，绝不自动重传。
    //   b) 授权类（NOT_CONNECTED / YOUTUBE_REAUTH_REQUIRED / SCOPE_INSUFFICIENT）
    //      → 后台不弹 OAuth 窗口 → 转 needs_review，人工重新授权后再手动排队。
    //   c) 其余明确失败（API_4XX / INVALID_METADATA / 视频文件问题等）
    //      → 确定没有创建视频 → 任务失败终止，**不自动重试**（用户手动重新排队）。
    if (!up || up.status !== 'ok') {
      const code = String((up && up.error) || 'upload-failed');
      const note = String((up && up.note) || 'YouTube 上传失败');
      // a) 结果不确定 → 发布记录保持 pending（与 GitHub 执行器同一约定：
      //    pending = "可能已经发出去了"，绝不能写成 failed）
      if (isUncertainCode(code)) {
        writePub(store, {
          work_id: workId, platform: 'YouTube', platform_id: 'youtube',
          status: 'pending', title: title, body: description,
          tags: tags.join(' '),
          time: '', url: '', error: code + (note ? ('：' + note) : ''), video_id: '', pub_key: pubKey
        });
        return needReview(code, note,
          '上传过程中网络/服务端结果不确定，YouTube 侧可能已经收到视频；系统不会自动重传（YouTube 上传不可撤销，重复上传会产生重复视频）。请人工到 YouTube 后台核实后再处理。');
      }
      // b) 授权类 → 后台不弹窗，转人工处理
      if (isAuthCode(code)) {
        writePub(store, {
          work_id: workId, platform: 'YouTube', platform_id: 'youtube',
          status: 'pending', title: title, body: description,
          tags: tags.join(' '),
          time: '', url: '', error: code + (note ? ('：' + note) : ''), video_id: '', pub_key: pubKey
        });
        return needReview(code, note,
          '后台执行不会弹出 OAuth 授权窗口：请到「推广渠道 → YouTube」重新完成授权（需包含 youtube.upload 上传权限），再手动重新排队。系统不会自动重试。');
      }
      // c) 明确失败 → 发布记录更新为 failed（同一 pub_key → 同一条记录）
      writePub(store, {
        work_id: workId, platform: 'YouTube', platform_id: 'youtube',
        status: 'failed', title: title, body: description,
        tags: tags.join(' '),
        time: '', url: '', error: code + (note ? ('：' + note) : ''), video_id: '', pub_key: pubKey
      });
      return fail(code, note, '上传失败，系统不会自动重试；修复后请手动重新排队本计划。');
    }

    // ---------- 10. 上传成功 → 更新发布记录为 ok（同一 pub_key → 同一条记录） ----------
    const videoId = String(up.videoId || '');
    if (!videoId) {
      // ★ 上传接口报告成功，但没有 videoId：
      //   YouTube 侧**可能已经创建了视频**，只是响应里没带回来 id。
      //   → 发布记录必须保持 pending（"可能已经发出去了"，绝不写成 failed）；
      //     写成 failed 会让 checkPlanPublishGuard 判定"此前明确失败，可重新执行"
      //     → 有可能再次上传，产生重复的公开视频。
      //   → 任务转 needs_review，人工去 YouTube 后台核实。
      //   → 绝不伪造 videoId，也绝不伪造视频链接（两者都留空，等人工确认）。
      writePub(store, {
        work_id: workId, platform: 'YouTube', platform_id: 'youtube',
        status: 'pending', title: title, body: description,
        tags: tags.join(' '),
        time: '', url: '', error: 'no-video-id', video_id: '', pub_key: pubKey
      });
      return needReview('no-video-id', '上传接口返回成功但未取得 videoId',
        '上传接口报告成功但没有返回 videoId，YouTube 侧可能已经创建了视频。系统不会自动重传（YouTube 上传不可撤销，重复上传会产生重复视频），也不会伪造 videoId 或视频链接。请人工前往 YouTube 后台核实该视频是否已发布后再处理。');
    }
    // 有真实 videoId → 链接取接口返回的 url；接口没给才用标准 watch 链接拼接
    //   （与普通自动发布 index.html L17878 / L19015 的规则一致）。
    const videoUrl = String(up.url || ('https://www.youtube.com/watch?v=' + videoId));

    const okWritten = writePub(store, {
      work_id: workId, platform: 'YouTube', platform_id: 'youtube',
      status: 'ok', title: title, body: description,
      tags: tags.join(' '),
      time: new Date().toISOString(),
      url: videoUrl, error: '', video_id: videoId, pub_key: pubKey
    });
    if (!okWritten) {
      // ★ 视频已上传成功，但本地记录写失败：
      //   绝不能当成"普通失败"让系统立刻重发（YouTube 上传不可撤销，
      //   重复上传会产生重复视频）→ 转 needs_review，并把真实标识保留下来供人工核验。
      return needReview(
        'pubs-write-failed',
        '视频已上传成功（videoId ' + videoId + '），但本地发布记录写入失败，请人工核验',
        '系统不会自动重传（YouTube 上传不可撤销）。请人工到 YouTube 后台核对该视频（videoId ' + videoId + '）后再处理。'
      );
    }

    // ---------- 11. 把真实标识写进任务行 ----------
    //   这样即使进程在随后的 finishPlanTask() 之前崩溃，
    //   恢复对账（reconcilePlanTasks）也能取回真实的 videoId / 链接。
    //   **写失败不触发第二次上传**（这里只是记录动作，忽略错误即可）。
    try {
      if (typeof store.markPlanTaskReleaseInfo === 'function') {
        store.markPlanTaskReleaseInfo(workId, String(task.id || ''), {
          platform_ref: videoId,
          platform_url: videoUrl
        });
      }
    } catch (_e) { /* 写不进去不影响本次成功判定（恢复对账会兜底回填链接） */ }

    return {
      ok: true,
      status: 'done',
      simulated: false,
      platform_ref: videoId,
      platform_url: videoUrl,
      video_id: videoId,
      // 实际生效的可见性（YouTube 未过审时会被降级为 private）——如实上报，不谎报 public。
      actual_privacy: String(up.actualPrivacy || ''),
      requested_privacy: String(up.requestedPrivacy || FIXED_PRIVACY_STATUS),
      note: 'YouTube 视频已发布：' + videoUrl
        + '（视频来源：' + (videoSource === 'work-latest' ? '作品最新成品视频' : '计划快照') + '）'
        + (up.actualPrivacy && up.actualPrivacy !== FIXED_PRIVACY_STATUS
          ? ('；注意：实际可见性为 ' + up.actualPrivacy + '（与请求的 ' + FIXED_PRIVACY_STATUS + ' 不一致）') : '')
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
  createYoutubePlanExecutor: createYoutubePlanExecutor,
  FIXED_PRIVACY_STATUS: FIXED_PRIVACY_STATUS
};
