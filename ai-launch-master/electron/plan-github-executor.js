'use strict';

// Rokit · 首秀计划 —— GitHub 真实发布适配器（第一批改造：Markdown 文章）
//
// 职责：把一条「platform_id='github'」的计划任务，真实地发布成一篇 Markdown 文章，
//       并把结果写回统一发布记录 pubs + 计划任务 plan_tasks。
//
// 复用既有能力（不重复造轮子）：
//   - 发布目标：GitHub 凭据记录（oauth-github）里绑定的 publishRepo（owner/repo）
//     —— 这是计划 GitHub 发布的**唯一**发布目标来源，与手动发布 github:put-file 同一数据源；
//     作品 URL 不参与仓库选择，publishRepo 缺失或不完整时直接失败，**绝不回退到作品链接推断仓库**
//   - 文件写入：publisher-extensions.githubPutFile（与普通自动发布完全同一条链路）
//   - 文件存在性预检：publisher-extensions.githubGetFile（只读，用来防止静默覆盖其他文章）
//   - 文章提交：**直接调用**普通自动发布的 github:put-file 入口（main.js githubPutFile，
//     由 main.js 在创建执行器时注入 publishFile）
//   - 视频 + 封面上传：**直接调用**普通自动发布的 github:put-video 入口（main.js githubPutVideo，
//     注入为 publishVideo）；本文件不实现第二套视频上传逻辑
//   - 在线阅读页面：**直接调用**普通自动发布的 github:publish-pages 入口（main.js githubPublishPages，
//     注入为 publishPages）；本文件不实现第二套页面 / 索引生成逻辑
//   - 文章 Markdown 拼装：renderer-utils/format.js 的 buildGithubArticleBody / videoSectionHtml，
//     与普通自动发布（index.html）调用的是同一份实现，本文件不再维护第二套拼装
//   - 发布记录写入：store.addPub()（按 pub_key upsert，与手动发布同一张 pubs 表）
//   - 幂等闸门：store.checkPlanPublishGuard()（由调度器在调用本适配器之前执行）
//
// 明确不做：
//   - 不创建 GitHub Release（不再使用固定 tag / Release 查询 / Release 创建）
//   - 不接入 YouTube / 微信（本文件只处理 github；其它平台由调度器直接跳过）
//   - 不修改现有手动发布链路、不改动 pubs 表结构与既有 pub_key 含义
//   - 不臆造仓库 / 路径 / URL：一切都以 GitHub API 返回为准
//   - 缺配置时返回可理解的失败，**绝不用错误数据继续发布**

// 普通自动发布与首秀计划共用的 Markdown 拼装实现（渲染层通过 <script> 加载同一文件）
const articleBody = require('../renderer-utils/format');

const POSTS_DIR = 'posts';           // 计划文章统一写入 posts/
const PUBLISH_BRANCH = 'main';       // 与普通自动发布一致
const DEFAULT_SLUG = 'project';      // slug 清洗后为空时的兜底值
// Pages slug 长度上限：与主进程 githubPublishPages 的校验一致（/^[a-z0-9._-]{1,60}$/i）。
//   超过上限时主进程会返回 bad-slug → 视频与 Markdown 文章已上传，但 Pages 页面不会生成。
//   只在首秀计划专属路径做保护，普通自动发布的 slug 生成逻辑不受影响。
const PAGES_SLUG_MAX = 60;

function pad2(n) {
  return n < 10 ? ('0' + n) : String(n);
}

// 文章 slug：与普通发布同源的清洗规则（ASCII、小写、40 字符以内）。
//   注意：这里**不**直接复用普通发布的 articleBaseName —— 中文标题清洗后可能为空，
//   本适配器在 slug 为空时会回退到作品 ID，避免不同作品全部退化成 'project'。
function articleSlug(name) {
  const s = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s;
}

// 阶段短 ID：把阶段 ID 清洗成纯字母数字，取末 16 位。
//   同一作品的阶段 ID 互不相同 → 不同阶段得到不同短 ID，避免同名文章互相覆盖。
function stageShortId(stageId) {
  let s = String(stageId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  s = s.slice(-16);
  return s || 'stage';
}

// 计划日期：按计划使用的**本地时区日历日**生成，绝不从 UTC 字符串截取。
//   scheduled_at 缺失 / 非法时回退到任务创建时间（同样取本地日历日），保证重试路径稳定。
function planDateStamp(scheduledAt, fallbackCreatedAt) {
  const candidates = [scheduledAt, fallbackCreatedAt];
  for (let i = 0; i < candidates.length; i++) {
    const raw = candidates[i];
    if (!raw) continue;
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    }
  }
  return '19700101';
}

// 计划文章基础名（同时也是传给主进程 githubPublishPages 的 Pages slug）：
//   <标题slug>-<YYYYMMDD>-<stage短ID>
// 长度规则（**只作用于首秀计划路径**，普通自动发布的 slug 逻辑不受影响）：
//   整体长度必须 ≤ PAGES_SLUG_MAX（主进程 slug 校验上限 60）。
//   超限时**只压缩「标题部分」**，日期与阶段短 ID 始终完整保留 ——
//   阶段短 ID 是区分「同一作品的不同阶段」的关键信息，截断整串会把它丢掉，
//   导致不同阶段的文章互相覆盖。
//   标题部分自身的清洗上限仍是 articleSlug 里的 40 字符，
//   所以普通长度标题的生成结果与既有规则完全一致。
function buildPlanBase(opts) {
  opts = opts || {};
  const date = planDateStamp(opts.scheduledAt, opts.createdAt);
  const stage = stageShortId(opts.stageId);
  const suffix = '-' + date + '-' + stage;
  let slug = articleSlug(opts.name);
  if (!slug) slug = articleSlug(opts.workId);
  if (!slug) slug = DEFAULT_SLUG;
  // 标题可用长度 = 60 - 后缀长度（日期 8 位 + 阶段短 ID ≤ 16 位 + 两个连字符 → 至少还剩 34）
  const budget = Math.max(1, PAGES_SLUG_MAX - suffix.length);
  if (slug.length > budget) {
    // 截断后可能留下尾部连字符，去掉（避免出现 'xx--20261031-xxx' 这种多余分隔）
    slug = slug.slice(0, budget).replace(/-+$/, '');
  }
  if (!slug) slug = DEFAULT_SLUG;   // 兜底：DEFAULT_SLUG 长度远小于 budget
  return slug + suffix;
}

// 稳定、唯一、可读的计划文章路径：
//   posts/<slug>-<YYYYMMDD>-<stage短ID>.md
//   同一个任务重试时输入完全相同 → 输出完全相同（不含任何随机值）。
function buildPlanArticlePath(opts) {
  return POSTS_DIR + '/' + buildPlanBase(opts) + '.md';
}

// ---------- 视频 / 封面路径与正文拼装 ----------
//
// 普通自动发布（index.html）：
//   文章 posts/<base>.md；视频 videos/<base>.mp4；封面 videos/<base>-cover.jpg；
//   正文由 renderer-utils/format.js:buildGithubArticleBody 拼接（在线阅读入口 + 视频区域）。
// 首秀计划的文章名按阶段区分，视频沿用同一「与文章同名」规则；
// 正文拼装直接调用同一份共享实现（articleBody.buildGithubArticleBody），
// 本文件不再维护第二套相对路径 / 视频区块 / Markdown 拼装逻辑。

/**
 * 结果语义（对齐 store.finishPlanTask 的入参）：
 *   ok:true  + simulated:false      → status='done'（真实发布成功）
 *   ok:true  + status:'needs_review' → 结果不确定（可能已写入）→ 待人工确认
 *   ok:false（默认）                → 明确失败（status='failed'）
 *
 * 注意：所有返回值都显式声明 simulated:false，避免调度器把真实执行误记为 kind=mock。
 */
function createGithubPlanExecutor(deps) {
  deps = deps || {};
  const getStore = deps.getStore;
  // 依赖注入点（测试用 mock 替换真实实现，避免任何真实网络写入）
  const getToken = deps.getToken || defaultGetToken;
  const getFile = deps.getFile || defaultGetFile;
  // 普通自动发布的完整发布入口（main.js 注入同一实现），不另起一套发布逻辑：
  //   文章提交 publishFile = githubPutFile（github:put-file）
  //   视频 + 封面 publishVideo = githubPutVideo（github:put-video）
  //   在线阅读页面 publishPages = githubPublishPages（github:publish-pages）
  const publishFile = deps.publishFile || defaultPublishFile;
  const publishVideo = deps.publishVideo || null;
  const publishPages = deps.publishPages || null;
  // 作品最新成品视频（settings_kv）：仅当计划快照为空时的只读回退。
  //   由 main.js 注入（内部按 userData/video/final 白名单 + 文件存在性校验）。
  const resolveWorkFinalVideo = deps.resolveWorkFinalVideo || null;
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

  // 本地发布记录：失败不阻断任务状态回写
  function writePub(store, payload) {
    try { store.addPub(payload); return true; } catch (_e) { return false; }
  }

  // 目标文件已存在时，判断它是不是**本任务此前成功写入**的那一篇。
  //   只有同 pub_key + 同作品 + 同平台 + status='ok' 才算本任务的成功记录；
  //   其他任务 / 人工创建的文件一律不算（绝不覆盖）。
  function findOwnPublishedPub(store, task, workId, htmlUrl) {
    const key = String((task && task.pub_key) || '');
    if (!key) return null;
    let rows = [];
    try { rows = store.listPubs() || []; } catch (_e) { return null; }
    const hit = rows.filter(function (p) {
      return p
        && String(p.pub_key || '') === key
        && String(p.work_id || '') === workId
        && String(p.platform_id || '') === 'github'
        && String(p.status || '') === 'ok';
    })[0];
    if (!hit) return null;
    // 有 URL 时必须与目标文件完全一致；没有 URL 视为「本任务写入但未回填链接」
    if (htmlUrl && String(hit.url || '') && String(hit.url) !== String(htmlUrl)) return null;
    return hit;
  }

  async function exec(task) {
    // ---------- 0. 只处理 GitHub ----------
    if (!task || String(task.platform_id) !== 'github') {
      return fail('platform-not-supported', '本适配器只处理 GitHub 计划任务');
    }
    // ---------- 1. 模拟任务绝不进真实发布路径 ----------
    if (task.simulated) {
      return fail('simulated-task', '模拟任务不得进入真实发布路径');
    }

    const store = getStore();
    const workId = String(task.work_id || '');
    const stageId = String(task.stage_id || '');

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
    const copy = (stage.copy && typeof stage.copy === 'object') ? (stage.copy.github || null) : null;
    const title = String((copy && copy.title) || '').trim();
    const body = String((copy && copy.body) || '').trim();
    if (!title && !body) {
      return fail('missing-copy', '该阶段没有保存 GitHub 发布文案', '请先在「首秀计划」里生成并保存该阶段的 GitHub 文案，再重新排队');
    }

    // ---------- 4. 认证（token 与绑定的发布仓库来自同一条 GitHub 凭据记录） ----------
    let tokenRec = null;
    try {
      tokenRec = await getToken();
    } catch (_e) {
      tokenRec = null;
    }
    const token = tokenRec && tokenRec.access_token ? String(tokenRec.access_token) : '';
    if (!token) {
      return fail('missing-token', '尚未完成 GitHub 授权', '请到「推广渠道 → GitHub」完成授权后再重新排队');
    }

    // ---------- 5. 发布仓库：唯一来源是凭据记录里绑定的 publishRepo ----------
    //   作品 URL 不参与仓库选择：publishRepo 缺失或配置不完整 → 明确失败，
    //   **绝不**从作品链接推断或回退仓库（与手动发布 github:put-file 同一口径）。
    const publishRepo = (tokenRec && tokenRec.publishRepo) ? tokenRec.publishRepo : null;
    if (!publishRepo || !publishRepo.owner || !publishRepo.repo) {
      return fail('missing-publish-repo', '尚未配置 GitHub 发布仓库', '请到「推广渠道 → GitHub → 添加 Personal Access Token」时填写「发布仓库」并保存；计划发布只使用你指定的发布仓库，不会从作品链接推断仓库');
    }
    const owner = String(publishRepo.owner);
    const repoName = String(publishRepo.repo);

    // ---------- 6. 稳定路径（同一任务重试完全相同） ----------
    const targetPath = buildPlanArticlePath({
      name: work.name,
      scheduledAt: task.scheduled_at,
      createdAt: task.created_at,
      stageId: stageId,
      workId: workId
    });
    // 文章内容 = 计划保存的正文快照（普通发布的文章格式就是原始 Markdown 正文，
    //   纯文本场景下不额外拼装任何 Release 内容）。只有正文为空时才用标题兜底。
    //   有视频时在末尾追加与普通自动发布相同的视频区域（见 8b）。
    let content = body || title;
    const pubKey = String(task.pub_key || ('plan|' + workId + '|' + stageId + '|github'));

    // ---------- 7. 上传前检查目标路径是否已存在（防止静默覆盖其他文章） ----------
    let fileInfo = null;
    try {
      fileInfo = await getFile(token, {
        owner: owner, repo: repoName, path: targetPath, branch: PUBLISH_BRANCH
      });
    } catch (e) {
      fileInfo = { ok: false, error: 'network', uncertain: true, detail: String((e && e.message) || e) };
    }

    if (fileInfo && fileInfo.ok === true && fileInfo.exists) {
      const existing = fileInfo.file || {};
      const existingUrl = String(existing.html_url || '');
      const own = findOwnPublishedPub(store, task, workId, existingUrl);
      if (own) {
        // 本任务此前已成功写入过同一路径 → 视为已发布，不重复写
        const url = existingUrl || String(own.url || '');
        try {
          if (typeof store.markPlanTaskReleaseInfo === 'function') {
            store.markPlanTaskReleaseInfo(workId, String(task.id || ''), {
              platform_ref: targetPath, platform_url: url
            });
          }
        } catch (_e) { /* 写不进去不影响成功判定 */ }
        return {
          ok: true, status: 'done', simulated: false,
          platform_ref: targetPath,
          platform_url: url,
          note: '目标文章已确认为本任务此前写入：' + targetPath
        };
      }
      // 其他任务 / 人工创建的文件 → 绝不覆盖，转人工确认
      writePub(store, {
        work_id: workId, platform: 'GitHub', platform_id: 'github',
        status: 'pending', title: title, body: body,
        tags: (copy && copy.tags && Array.isArray(copy.tags)) ? copy.tags.join(' ') : '',
        time: '', url: existingUrl, error: 'file-exists', video_id: '', pub_key: pubKey
      });
      return {
        ok: true, status: 'needs_review', simulated: false,
        error: 'file-exists（目标文件已存在：' + targetPath + '）',
        platform_ref: targetPath,
        platform_url: existingUrl,
        note: '目标路径 ' + targetPath + ' 已存在其他任务或人工创建的文章，本次未覆盖；请人工确认该文件归属后再处理'
      };
    }

    if (!fileInfo || fileInfo.ok !== true) {
      const code = String((fileInfo && fileInfo.error) || 'unknown');
      const detail = String((fileInfo && fileInfo.detail) || '');
      const uncertain = !!(fileInfo && fileInfo.uncertain) || /^network/i.test(code);
      if (uncertain) {
        writePub(store, {
          work_id: workId, platform: 'GitHub', platform_id: 'github',
          status: 'pending', title: title, body: body, error: code,
          url: '', pub_key: pubKey
        });
        return {
          ok: true, status: 'needs_review', simulated: false,
          error: code + '（' + String(detail || '结果不确定') + '）',
          platform_ref: targetPath,
          note: '检查目标文件是否存在时网络结果不确定（可能尚未写入，也可能已写入但本地未确认），系统不会自动重发；请人工核验'
        };
      }
      return fail(code, detail || '检查目标文件是否存在失败', '无法确认目标路径状态，已放弃本次发布；修复后可重新排队');
    }

    // ---------- 8. 先登记一条 pending 发布记录（同一 pub_key，失败/成功都更新同一条） ----------
    try {
      store.addPub({
        work_id: workId, platform: 'GitHub', platform_id: 'github',
        status: 'pending', title: title, body: body,
        tags: (copy && copy.tags && Array.isArray(copy.tags)) ? copy.tags.join(' ') : '',
        time: '', url: '', error: '', video_id: '', pub_key: pubKey
      });
    } catch (e) {
      // 本地记录写不进去：继续发布是不行的（丢了幂等凭据），直接判失败
      return {
        ok: false, simulated: false, error: 'pubs-write-failed',
        detail: '写入本地发布记录失败，已放弃本次发布：' + String((e && e.message) || e)
      };
    }

    // ---------- 8b. 视频 + 封面：直接调用普通自动发布的同一上传入口 ----------
    //   视频来源优先级：
    //     1) 计划快照 copy.github.videoPath（保存计划时写入；存在则严格使用它，
    //        避免计划引用的视频被该作品后来的新视频悄悄替换）
    //     2) 作品最新成品视频映射 finalVideo:<workId>（settings_kv，只读回退；
    //        仅在快照为空时使用，解决「作品重开后计划快照丢失」的问题）
    //     3) 两者都没有 → 纯 Markdown 文章，并在结果中明确标注「本阶段无成品视频」
    //   映射存在但文件不存在 / 校验失败 → 按视频发布失败处理，绝不静默降级为纯文章。
    //   上传失败时与普通自动发布一致：文章也不发布，避免正文引用不存在的视频。
    let video = null;
    let pages = null;
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
      } else if (!wr || String(wr.error || '') === 'no-final-video') {
        // 映射不存在：允许纯文章发布，但结果必须明确标注（不能静默降级）
        videoSource = 'none';
      } else {
        const code = String(wr.error || 'final-video-unavailable');
        const detail = String(wr.detail || '');
        try {
          store.addPub({
            work_id: workId, platform: 'GitHub', platform_id: 'github',
            status: 'failed', title: title, body: body,
            error: detail || code, url: '', pub_key: pubKey
          });
        } catch (_e) { /* 记录失败不影响任务状态回写 */ }
        return fail(code, detail || '作品最新成品视频不可用',
          '该作品已记录的成品视频不存在或未通过校验；文章未发布，请重新生成成品视频后重新排队');
      }
    }
    if (finalVideoPath) {
      if (typeof publishVideo !== 'function') {
        return fail('video-publisher-unavailable', '视频上传入口不可用', '计划执行器未注入普通自动发布的视频入口，已放弃本次发布');
      }
      // 视频 / 封面与计划文章同名（与普通自动发布「文章、视频、封面共用同一个 base」一致）
      const articleFile = targetPath.slice(targetPath.lastIndexOf('/') + 1);
      const articleBase = articleFile.replace(/\.md$/i, '');
      const videoPath = 'videos/' + articleBase + '.mp4';
      const coverPath = 'videos/' + articleBase + '-cover.jpg';
      let vr = null;
      try {
        vr = await publishVideo({
          finalVideoPath: finalVideoPath,   // main.js githubPutVideo 按 userData/video/final 白名单校验
          videoPath: videoPath,
          coverPath: coverPath,
          atSeconds: 0
        });
      } catch (e) {
        vr = { ok: false, stage: 'exception', error: 'exception', detail: String((e && e.message) || e) };
      }
      if (!vr || vr.ok !== true) {
        const code = String((vr && (vr.error || vr.stage)) || 'unknown');
        const detail = String((vr && vr.detail) || '');
        // 网络 / 5xx → 结果不确定（可能已上传）→ 转人工核验，不自动重发
        const uncertain = !!(vr && vr.uncertain) || /^network/i.test(code) || Number(vr && vr.status) >= 500;
        if (uncertain) {
          try {
            store.addPub({
              work_id: workId, platform: 'GitHub', platform_id: 'github',
              status: 'pending', title: title, body: body,
              error: detail || code, url: '', pub_key: pubKey
            });
          } catch (_e) { /* 记录失败不影响任务状态回写 */ }
          return {
            ok: true, status: 'needs_review', simulated: false,
            error: code + '（' + String(detail || '结果不确定') + '）',
            platform_ref: targetPath,
            note: '上传视频时网络结果不确定（可能已上传，也可能未上传），文章未发布；系统不会自动重发，请人工核验'
          };
        }
        try {
          store.addPub({
            work_id: workId, platform: 'GitHub', platform_id: 'github',
            status: 'failed', title: title, body: body,
            error: detail || code, url: '', pub_key: pubKey
          });
        } catch (_e) { /* 记录失败不影响任务状态回写 */ }
        return fail(code, detail || 'GitHub 视频上传失败', '视频未上传成功，文章也未发布；修复后可重新排队');
      }
      video = vr;

      // ---------- 8c. 在线阅读页面：直接调用普通自动发布的同一 Pages 入口 ----------
      //   slug 与本次计划文章同名 → docs/posts/<base>.html，绝不会串到其他阶段 / 其他作品的页面。
      //   Pages 失败与普通自动发布一致：不阻断 Markdown 文章发布，但绝不谎报网页已发布。
      if (typeof publishPages === 'function') {
        try {
          pages = await publishPages({
            finalVideoPath: finalVideoPath,
            slug: articleBase,
            title: title || body,
            body: body,
            date: ''
          });
        } catch (e) {
          pages = { ok: false, stage: 'exception', error: 'exception', detail: String((e && e.message) || e) };
        }
      } else {
        pages = {
          ok: false, error: 'pages-publisher-unavailable',
          detail: '计划执行器未注入普通自动发布的页面发布入口'
        };
      }

      // 正文 = 普通自动发布同一份正文构建实现：
      //   正文 + 在线阅读与播放入口（Pages 成功时）+ 视频区域（相对路径由共享实现计算）
      content = articleBody.buildGithubArticleBody(content, {
        articlePath: targetPath,
        videoPath: String(vr.videoPath || videoPath),
        coverPath: String(vr.coverPath || coverPath)
      }, (pages && pages.ok && pages.pageUrl) ? { pageUrl: pages.pageUrl } : null);
    }

    // ---------- 9. 写入 Markdown 文章（create-only：绝不更新已存在的文件） ----------
    let pr = null;
    try {
      pr = await publishFile({
        owner: owner, repo: repoName,
        path: targetPath,
        branch: PUBLISH_BRANCH,
        message: 'Publish ' + String(work.name || title || 'plan') + ' via Rokit',
        content: content,
        createOnly: true
      });
    } catch (e) {
      pr = { ok: false, error: 'network', uncertain: true, detail: String((e && e.message) || e) };
    }

    if (!pr || pr.ok !== true) {
      const code = String((pr && pr.error) || 'unknown');
      const detail = String((pr && pr.detail) || '');
      const uncertain = !!(pr && pr.uncertain) || /^network/i.test(code);
      // create-only 下 GitHub 拒绝写入（文件已存在 / 并发创建）→ 结果未知 → 人工确认
      const conflict = code === 'file-exists' || Number(pr && pr.status) === 409;
      const existing = (pr && (pr.existing || pr.file)) || {};
      if (conflict || uncertain) {
        try {
          store.addPub({
            work_id: workId, platform: 'GitHub', platform_id: 'github',
            status: 'pending', title: title, body: body,
            error: detail || code,
            url: String(existing.html_url || ''),
            pub_key: pubKey
          });
        } catch (_e) { /* 记录失败不影响任务状态回写 */ }
        return {
          ok: true, status: 'needs_review', simulated: false,
          error: code + '（' + String(detail || '结果不确定') + '）',
          platform_ref: targetPath,
          platform_url: String(existing.html_url || ''),
          note: conflict
            ? '目标路径 ' + targetPath + ' 在写入时已被占用，未覆盖；系统不会自动重发，请人工核验'
            : 'GitHub 写入结果不确定（可能已写入但本地未确认），请人工核验后再处理；系统不会自动重发'
        };
      }
      // 明确未写入成功（GitHub 明确拒绝 / 参数问题）→ 失败
      try {
        store.addPub({
          work_id: workId, platform: 'GitHub', platform_id: 'github',
          status: 'failed', title: title, body: body,
          error: detail || code, url: '', pub_key: pubKey
        });
      } catch (_e) { /* 记录失败不影响任务状态回写 */ }
      return {
        ok: false, simulated: false,
        error: code + '（' + String(detail || 'GitHub 写入文章失败') + '）',
        note: 'GitHub 明确拒绝本次写入，确定没有创建文章；修复后可重新排队'
      };
    }

    // ---------- 10. 成功：写真实发布记录 + 回写真实标识 ----------
    const fileContent = (pr && pr.content) || {};
    const platformUrl = String(fileContent.html_url || '');       // API 返回的真实文件链接
    const platformRef = String(fileContent.path || targetPath);    // 可读的文件路径
    if (!platformUrl) {
      // 没有可核实的链接：不能算成功
      try {
        store.addPub({
          work_id: workId, platform: 'GitHub', platform_id: 'github',
          status: 'pending', title: title, body: body,
          error: 'GitHub 未返回可核实文件链接', url: '', pub_key: pubKey
        });
      } catch (_e) {}
      return {
        ok: true, status: 'needs_review', simulated: false,
        error: 'bad-response',
        detail: 'GitHub 未返回可核实文件链接，请人工核验',
        platform_ref: platformRef, platform_url: ''
      };
    }

    try {
      store.addPub({
        work_id: workId, platform: 'GitHub', platform_id: 'github',
        status: 'ok', title: title, body: body,
        tags: (copy && copy.tags && Array.isArray(copy.tags)) ? copy.tags.join(' ') : '',
        time: new Date().toISOString(),
        url: platformUrl, error: '', video_id: '', pub_key: pubKey
      });
    } catch (e) {
      // ★ 文件已写入，但本地记录写失败：
      //   绝不能当成"普通失败"让系统立刻重发（会重复写入 / 覆盖风险）。
      //   → 转 needs_review，并把真实的路径 / 链接保留下来供人工核验。
      return {
        ok: true, status: 'needs_review', simulated: false,
        error: 'pubs-write-failed（文章已写入 ' + platformRef + '，但本地发布记录写入失败，请人工核验：' + String((e && e.message) || e) + '）',
        platform_ref: platformRef, platform_url: platformUrl,
        note: '文章已写入但本地记录写入失败，系统不会自动重发，请人工核验后处理'
      };
    }

    // 发布记录已落库 → **立刻**把真实标识写进任务行：
    //   这样即使进程在随后的 finishPlanTask() 之前崩溃，
    //   恢复对账（reconcilePlanTasks）也能取回真实的文件路径 / 链接，而不是只剩一条链接。
    try {
      if (typeof store.markPlanTaskReleaseInfo === 'function') {
        store.markPlanTaskReleaseInfo(workId, String(task.id || ''), {
          platform_ref: platformRef, platform_url: platformUrl
        });
      }
    } catch (_e) { /* 写不进去不影响本次成功判定（恢复对账会兜底回填链接） */ }

    return {
      ok: true, status: 'done', simulated: false,
      platform_ref: platformRef,
      platform_url: platformUrl,
      video: video,
      // 视频来源：snapshot（计划快照）/ work-latest（作品最新映射回退）/ none（无成品视频）
      video_source: videoSource,
      // 网页（Pages）真实结果：失败时不谎报已发布（文章本身仍按普通发布行为照常发布）
      pages: pages ? {
        ok: !!pages.ok,
        pageUrl: pages.ok ? String(pages.pageUrl || '') : '',
        deployStatus: String(pages.deployStatus || ''),
        error: pages.ok ? '' : String(pages.error || pages.stage || 'unknown')
      } : null,
      note: 'GitHub 文章已写入 ' + POSTS_DIR + '/（' + platformRef + '）'
        + (video ? ('；视频 ' + video.videoPath + '（来源：' + (videoSource === 'work-latest' ? '作品最新成品视频' : '计划快照') + '）')
          : '；本阶段无成品视频，仅发布文章')
        + (pages ? ('；网页 ' + (pages.ok && pages.pageUrl
          ? pages.pageUrl
          : ('未发布（' + String(pages.error || pages.stage || 'unknown') + '）'))) : '')
    };
  }

  return exec;
}

/* ---------- 默认依赖（生产） ---------- */
function defaultGetToken() {
  const oauth = require('./oauth');
  return oauth.getTokenForInternal('github');
}
function defaultGetFile(token, opts) {
  const pe = require('./publisher-extensions');
  return pe.githubGetFile(token, opts);
}
// 默认的文章提交实现（未注入普通自动发布入口时的兜底）：与 github:put-file 相同的底层函数
function defaultPublishFile(opts, token) {
  const pe = require('./publisher-extensions');
  return pe.githubPutFile(token, opts);
}
function defaultListWorks(store) {
  if (store && typeof store.listWorks === 'function') return store.listWorks();
  return [];
}

module.exports = {
  createGithubPlanExecutor: createGithubPlanExecutor,
  buildPlanArticlePath: buildPlanArticlePath,
  POSTS_DIR: POSTS_DIR,
  PUBLISH_BRANCH: PUBLISH_BRANCH
};
