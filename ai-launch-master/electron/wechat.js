// Rokit · 微信公众号草稿接口（v1.1）
//
// 职责：
//   - 安全保存 AppID / AppSecret / thumb_media_id（由 main.js 走 secrets.js）
//   - 通过主进程代理 fetcher 调用官方 API（access_token 不暴露给渲染进程）
//   - access_token 按 appId 缓存（near TTL - 5min），遇到 40001/42001 时主动失效重取
//   - 错误码 → 中文 note 映射（不输出原始 access_token 到 note / 日志）
//   - 提供 createDraft / testConnection / getDraft / uploadImageMaterial / publishDraft / getPublishStatus
//
// 设计边界：
//   - 文章正文里的图片由 uploadImageMaterial 走 /material/add_material（type=image）拿到微信能解析的 url
//   - 封面图片同样走 uploadImageMaterial（type=image），但 thumb_media_id 由 main/UI 持久化到 keytar
//   - 正式发布走 freepublish/submit（需公众号已开通"群发"接口权限），返回 publish_id 后用 freepublish/get 轮询
//   - 不修改 publishers.js / PLATFORMS / UI 已有注册项
//   - 视频内容：本版本不实现插入图文里的视频（需上传视频素材 + 视频 message 接口，账号需开通权限）；
//     如用户启用，会给出明确"需在公众号后台开通对应权限"的提示，而不是伪造成功
//   - 不输出 AppSecret / access_token / Cookie 到 console / logger / error 对象
'use strict';

let logger = null;
try { logger = require("./logger"); } catch (_e) { logger = null; }
function _logErrcode(stage, endpoint, errcode, errmsg, rid) { // eslint-disable-line no-unused-vars
  try {
    if (logger && typeof logger.warn === "function") logger.warn("[wechat] " + stage + " errcode", { endpoint: endpoint, errcode: errcode, errmsg: errmsg, rid: rid });
    console.log("[wechat][" + stage + "][" + endpoint + "] errcode=" + errcode + " rid=" + rid + " errmsg=" + errmsg);
  } catch (_e) {}
}


const API_ROOT = 'https://api.weixin.qq.com/cgi-bin';

// 模块级 access_token 缓存：appId -> { token, expiresAt }
// expiresAt 比真实过期提前 5 分钟（让接近边界的请求也能复用）
const tokenCache = new Map();
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// 已知 errcode -> 中文释义。errcode 不属于敏感信息，可以出现在 note 里。
// 注意：构造 note 时只取 errcode 与这条映射字符串，绝不把 data 里的 access_token / session 等字段拼进去。
const ERRCODE_NOTES = {
  40001: 'AppSecret 错误或 access_token 无效，请检查 AppID / AppSecret 是否匹配',
  40014: 'access_token 无效，请稍后重试或重新生成',
  42001: 'access_token 已过期，系统已自动刷新，请重试',
  43004: '该公众号未开通此接口权限，请在公众号后台检查权限集',
  45009: '接口调用次数超过每日限额，请明天再试或申应限额',
  45011: 'API 调用过于频繁，请稍候再试',
  45008: '该公众号下发消息频率超限，请减少群发频率',
  48001: 'API 未授权。公众号未授权该接口的权限，请到公众号后台「开发 → 接口权限」检查或申请',
  48002: '公众号未开通群发消息接口权限，请在公众号后台「开发 → 接口权限」检查或申请',
  48004: '接口已被管理员禁用，请到公众号后台「开发 → 接口权限」查看原因',
  50005: '用户未授权该 API，请检查公众号权限集',
  61004: '接口调用次数超限',
  61023: '需要 HTTPS 请求（本地直连应为 https）',
  88000: '该 access_token 未在白名单 IP 段调用，请到公众号后台「开发 → 基本配置 → IP 白名单」配置本机外网 IP',
  '-1': '微信系统繁忙，请稍后重试',
  // 浅知识库未列举的未知 errcode 默认归为「权限或账号问题」，提醒查公众号后台权限
  0:    '公众号未返回明确错码，请到公众号后台查看',
};

// 内部状态码字段的中文标题（用于 note 拼接）
const FIELD_LABELS = {
  appId: '公众号 AppID',
  appSecret: '公众号 AppSecret',
  thumbMediaId: '封面素材 ID（thumb_media_id）'
};

function noteFromError(data, endpoint) {
  if (!data || typeof data !== 'object') return '微信接口无响应';
  const code = Number(data.errcode) || 0;
  const friendly = ERRCODE_NOTES[code] || ERRCODE_NOTES[String(code)];
  // 从 errmsg 中提取 rid（微信错误返回 rid:xxxx样式），不进入安全保护区
  let rid = '';
  if (data && typeof data.errmsg === 'string') {
    const ridMatch = data.errmsg.match(/rid\s*[:\uff1a]\s*([A-Za-z0-9-]+)/i);
    if (ridMatch) rid = ridMatch[1];
  }
  // 纯粉 errmsg（rid）不适合直接告诉用户，但必要起到提示中，多对接口调用时可根据同一 rid 关联询问微信
  const baseNote = friendly
    ? ('微信接口 ' + code + '：' + friendly)
    : ('微信接口 ' + code + '：' + (data.errmsg || '未知错误'));
  return baseNote;
}

// HTML 转义（公众号渲染的是 HTML，避免正文里 `<script>` 等被当代码执行）
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 正文按行转换为公众号接受的 HTML 段（每行包 <p>，空行写 <br>）
function bodyToHtml(value) {
  return String(value == null ? '' : value).split(/\r?\n/)
    .map(function (line) { return '<p>' + (line ? escapeHtml(line) : '<br>') + '</p>'; })
    .join('');
}

// fetcher 包装：保留项目 fetchWithTimeout 签名 (url, options, ms) => Promise<Response>
// 集中处理：解析 JSON、HTTP 状态、errcode → 中文 note；data 中如含有 access_token 也只透传给上层缓存，不写进 note
async function requestJson(fetcher, url, options, stage) {
  var endpoint = url;
  try { var u = new URL(url); endpoint = u.pathname.replace(/^\//, ''); } catch (_e) { /* ignore parse err */ }
  var response = await fetcher(url, options);
  var data = null;
  try { data = await response.json(); } catch (_e) { /* ignore */ }
  if (!response.ok) {
    _logErrcode(stage || 'http', endpoint, response.status, 'HTTP ' + response.status, '');
    var e = new Error('微信接口 ' + endpoint + ' HTTP ' + response.status);
    e.httpStatus = response.status;
    e.endpoint = endpoint;
    throw e;
  }
  if (data && Number(data.errcode)) {
    var code = Number(data.errcode);
    var msg = (data && data.errmsg) ? String(data.errmsg) : '';
    var rid = '';
    var m = msg.match(/rid\s*[:：]\s*([A-Za-z0-9-]+)/i);
    if (m) rid = m[1];
    _logErrcode(stage || 'api', endpoint, code, msg, rid);
    var e2 = new Error(noteFromError(data, endpoint));
    e2.wechatErrcode = code;
    e2.endpoint = endpoint;
    e2.rid = rid;
    throw e2;
  }
  return data || {};
}

// 获取 access_token（按 appId 缓存，TTL 留 5 分钟余量；命中失效 / 解析失败时返回新值）
async function getAccessToken(credentials, fetcher) {
  const cfg = credentials || {};
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error('缺少公众号 AppID / AppSecret');
  }
  const cached = tokenCache.get(cfg.appId);
  const now = Date.now();
  if (cached && cached.token && cached.expiresAt > now + TOKEN_REFRESH_MARGIN_MS) {
    return cached.token;
  }
  const url = API_ROOT + '/token?' + new URLSearchParams({
    grant_type: 'client_credential',
    appid: cfg.appId,
    secret: cfg.appSecret
  }).toString();
  const data = await requestJson(fetcher, url, { method: 'GET' });
  if (!data || !data.access_token) {
    throw new Error('微信未返回 access_token');
  }
  // expires_in 单位秒；最少 60s，避免脏数据
  const ttlMs = Math.max(60, Number(data.expires_in) || 7200) * 1000;
  tokenCache.set(cfg.appId, {
    token: data.access_token,
    expiresAt: now + ttlMs - TOKEN_REFRESH_MARGIN_MS
  });
  return data.access_token;
}

// 当上层接口返回 40001/42001 时调用，把 appId 对应的缓存清掉，下次重新拉
function invalidateAccessToken(appId) {
  if (appId && tokenCache.has(appId)) tokenCache.delete(appId);
}

// 字段长度校验（公众号接口硬限制），返回 { ok, note? }
function validateArticle(article) {
  const a = article || {};
  const title = String(a.title || '').trim();
  const body = String(a.body || '').trim();
  if (!title || !body) return { ok: false, note: '草稿标题和正文不能为空' };
  // 公众号：title 4~64 字（中英文皆按字符计）
  const titleLen = title.length;
  if (titleLen > 64) return { ok: false, note: '公众号标题不能超过 64 个字符（当前 ' + titleLen + '）' };
  // author 上限 16 字节（按字符算超 16 截断即可）
  // digest 上限 120 字（HTML 草稿里 digest 是摘要，纯文本语义）
  if (String(a.author || '').length > 16) {
    // 静默截断，不阻拦用户
  }
  return { ok: true };
}

// 公共请求入口：拿 access_token + 调用 + 处理 40001/42001 缓存失效
async function callWechat(credentials, fetcher, path, body) {
  const token = await getAccessToken(credentials, fetcher);
  var stage = 'unknown';
  if (path === '/draft/add') stage = 'draft_add';
  else if (path === '/draft/get') stage = 'draft_get';
  else if (path === '/freepublish/submit') stage = 'publish_submit';
  else if (path === '/freepublish/get') stage = 'publish_get';
  else if (path === '/material/add_material') stage = 'material_add';
  else if (path === '/material/get_material') stage = 'material_get';
  else if (path === '/message/mass/sendall') stage = 'mass_sendall';
  try {
    return await requestJson(
      fetcher,
      API_ROOT + path + '?access_token=' + encodeURIComponent(token),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
      },
      stage
    );
  } catch (e) {
    if (e && (e.wechatErrcode === 40001 || e.wechatErrcode === 42001)) {
      invalidateAccessToken(credentials && credentials.appId);
    }
    throw e;
  }
}

async function createDraft(credentials, payload, fetcher) {
  const config = credentials || {};
  const article = payload || {};
  if (!config.appId || !config.appSecret || !config.thumbMediaId) {
    return { status: 'config_required', note: '请在设置中配置公众号 AppID、AppSecret 和封面素材 ID' };
  }
  const v = validateArticle(article);
  if (!v.ok) return { status: 'api_error', note: v.note };
  if (typeof fetcher !== 'function') {
    return { status: 'api_error', note: '公众号接口请求不可用' };
  }

  try {
    const sourceUrl = /^https?:\/\//i.test(String(article.link || '').trim())
      ? String(article.link).trim()
      : '';
    const author = String(article.author || '').slice(0, 16);
    const digestSource = String(
      article.digest || article.intro || article.summary || article.body || ''
    ).trim();
    const digest = digestSource.slice(0, 120);

    const draft = await callWechat(
      config,
      fetcher,
      '/draft/add',
      {
        articles: [{
          title: String(article.title).trim(),
          author: author,
          digest: digest,
          content: bodyToHtml(article.body),
          content_source_url: sourceUrl,
          thumb_media_id: config.thumbMediaId,
          need_open_comment: 0,
          only_fans_can_comment: 0
        }]
      }
    );
    if (!draft || !draft.media_id) throw new Error('微信接口未返回草稿 media_id');
    return { status: 'draft_created', mediaId: draft.media_id || '' };
  } catch (error) {
    return { status: 'api_error', note: String((error && error.message) || error) };
  }
}

// 仅调一次 /token，不消耗任何写入配额。成功时报告 expires_in 与 thumb_media_id 是否齐备
async function testConnection(credentials, fetcher) {
  const cfg = credentials || {};

  // ========== 阶段 A：本地配置校验（不发起任何网络请求）==========
  const present = {
    appId: !!(cfg.appId && String(cfg.appId).trim()),
    appSecret: !!(cfg.appSecret && String(cfg.appSecret).trim()),
    thumbMediaId: !!(cfg.thumbMediaId && String(cfg.thumbMediaId).trim())
  };
  const missingKeys = Object.keys(present).filter(function (k) { return !present[k]; });
  if (missingKeys.length > 0) {
    return {
      ok: false,
      stage: 'local',
      missing: missingKeys.slice(),
      hasThumb: present.thumbMediaId,
      note: '本地配置不完整，缺少：' + missingKeys.map(function (k) { return FIELD_LABELS[k]; }).join('、')
    };
  }

  if (typeof fetcher !== 'function') {
    return { ok: false, stage: 'local', missing: [], hasThumb: true, note: '公众号接口请求不可用（fetcher 缺失）' };
  }

  // ========== 阶段 B：/token API 调用，验证 AppID / AppSecret ==========
  let tokenData;
  let tokenFetchError;
  try {
    const url = API_ROOT + '/token?' + new URLSearchParams({
      grant_type: 'client_credential',
      appid: cfg.appId,
      secret: cfg.appSecret
    }).toString();
    tokenData = await requestJson(fetcher, url, { method: 'GET' });
  } catch (e) {
    tokenFetchError = e;
  }

  if (tokenFetchError) {
    return {
      ok: false,
      stage: 'api-token',
      missing: [],
      hasThumb: true,
      errcode: tokenFetchError && tokenFetchError.wechatErrcode,
      httpStatus: tokenFetchError && tokenFetchError.httpStatus,
      note: '凭证校验失败：' + String((tokenFetchError && tokenFetchError.message) || tokenFetchError)
    };
  }
  if (!tokenData || !tokenData.access_token) {
    return {
      ok: false,
      stage: 'api-token',
      missing: [],
      hasThumb: true,
      note: '凭证校验失败：微信未返回 access_token'
    };
  }
  // 写入缓存（让 createDraft 复用）
  const now = Date.now();
  const ttlMs = Math.max(60, Number(tokenData.expires_in) || 7200) * 1000;
  tokenCache.set(cfg.appId, {
    token: tokenData.access_token,
    expiresAt: now + ttlMs - TOKEN_REFRESH_MARGIN_MS
  });

  // ========== 阶段 C（可选）：验证 thumb_media_id 是否真实存在 ==========
  // 不强制消耗配额；失败不阻断主结果，单独报告给 UI
  let thumbResult = null;
  if (present.thumbMediaId) {
    try {
      const mat = await callWechat(cfg, fetcher, '/material/get_material', { media_id: cfg.thumbMediaId });
      thumbResult = {
        ok: !!(mat && (mat.media_id || mat.url || mat.news_item)),
        title: (mat && mat.title) || '',
        note: (mat && mat.media_id) ? '' : '素材记录空（ID 可能已过期或被删除）'
      };
    } catch (e) {
      thumbResult = {
        ok: false,
        errcode: e && e.wechatErrcode,
        note: String((e && e.message) || e)
      };
    }
  }

  // 组装最终结果
  const allOk = !thumbResult || thumbResult.ok;
  const summaryParts = ['✓ /token 凭证有效 ' + Math.round((Number(tokenData.expires_in) || 7200) / 60) + ' 分钟'];
  if (thumbResult && !thumbResult.ok) {
    summaryParts.push('⚠ 封面素材 ID 验证失败：' + thumbResult.note);
  }
  return {
    ok: allOk,
    stage: thumbResult && !thumbResult.ok ? 'api-thumb' : 'api-token',
    missing: [],
    hasThumb: true,
    expiresIn: Number(tokenData.expires_in) || 7200,
    thumb: thumbResult,
    note: summaryParts.join('；')
  };
}

// 草稿详情（仅查询，不修改）
async function getDraft(credentials, mediaId, fetcher) {
  const cfg = credentials || {};
  if (!cfg.appId || !cfg.appSecret) {
    return { ok: false, note: '请先在设置中配置 AppID 与 AppSecret' };
  }
  if (!mediaId || typeof mediaId !== 'string') {
    return { ok: false, note: '缺少草稿 media_id' };
  }
  if (typeof fetcher !== 'function') {
    return { ok: false, note: '公众号接口请求不可用' };
  }
  try {
    const data = await callWechat(cfg, fetcher, '/draft/get', { media_id: mediaId });
    return { ok: true, draft: data };
  } catch (e) {
    return { ok: false, note: String((e && e.message) || e) };
  }
}

// 上传永久图片素材（/cgi-bin/material/add_material?type=image）
// payload: { buffer: Buffer, filename: string, mime: string }
// 返回: { ok: true, mediaId, url }   或   { ok: false, note, errcode? }
// 设计：buffer 必须由 main.js 从 fs.readFile 读取传入；不接触渲染进程，避免 base64 卡明文进 IPC。
async function uploadImageMaterial(credentials, payload, fetcher) {
  const cfg = credentials || {};
  const data = payload || {};
  if (!cfg.appId || !cfg.appSecret) {
    return { ok: false, note: '请先在设置中配置公众号 AppID 与 AppSecret' };
  }
  if (!Buffer.isBuffer(data.buffer)) {
    return { ok: false, note: '缺少图片二进制数据' };
  }
  if (!data.filename || typeof data.filename !== 'string') {
    return { ok: false, note: '缺少文件名' };
  }
  if (typeof fetcher !== 'function') {
    return { ok: false, note: '公众号接口请求不可用' };
  }
  try {
    const token = await getAccessToken(cfg, fetcher);
    // multipart/form-data：手写 boundary 避免拉额外依赖
    const boundary = '----rokit' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const crlf = '\r\n';
    const pre = Buffer.from(
        '--' + boundary + crlf +
        'Content-Disposition: form-data; name="media"; filename="' + encodeURIComponent(data.filename) + '"' + crlf +
        'Content-Type: ' + (data.mime || 'image/jpeg') + crlf + crlf,
        'utf8'
    );
    const post = Buffer.from(crlf + '--' + boundary + '--' + crlf, 'utf8');
    const body = Buffer.concat([pre, data.buffer, post]);
    const resp = await fetcher(API_ROOT + '/material/add_material?access_token=' + encodeURIComponent(token) + '&type=image', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: body
    });
    let json = null;
    try { json = await resp.json(); } catch (_e) { /* ignore */ }
    if (!resp.ok) {
      return { ok: false, note: '上传图片 HTTP ' + resp.status, httpStatus: resp.status };
    }
    if (json && json.errcode && Number(json.errcode)) {
      const e = new Error(noteFromError(json));
      e.wechatErrcode = Number(json.errcode);
      return { ok: false, note: e.message, errcode: e.wechatErrcode };
    }
    if (!json || !json.media_id) {
      return { ok: false, note: '上传图片失败：' + (json && json.errmsg ? json.errmsg : '微信未返回 media_id') };
    }
    return { ok: true, mediaId: json.media_id, url: json.url || '' };
  } catch (e) {
    if (e && (e.wechatErrcode === 40001 || e.wechatErrcode === 42001)) {
      invalidateAccessToken(cfg.appId);
    }
    var c = e && e.wechatErrcode;
    if (c === 48001 || c === 48002 || c === 43004 || c === 50005) {
      return { ok: false, status: 'permission_denied', note: String((e && e.message) || e), errcode: c };
    }
    return { ok: false, note: String((e && e.message) || e), errcode: c };
  }
}

// 上传永久视频素材（/cgi-bin/material/add_material?type=video）
// payload: { buffer: Buffer, filename: string, mime: string, title?, introduction? }
// 返回: { ok: true, mediaId, url, vid }   或   { ok: false, note, errcode? }
// 设计：微信公众号官方 API 在视频素材返回中通常带 vid（用于腾讯视频插入）
//   本接口用于「图文中的腾讯视频」或「群发视频消息」的前置素材上传。
//   视频大小限制（官方）：永久视频素材 ≤ 20MB
async function uploadVideoMaterial(credentials, payload, fetcher) {
  const cfg = credentials || {};
  const data = payload || {};
  if (!cfg.appId || !cfg.appSecret) {
    return { ok: false, note: '请先在设置中配置公众号 AppID 与 AppSecret' };
  }
  if (!Buffer.isBuffer(data.buffer)) {
    return { ok: false, note: '缺少视频二进制数据' };
  }
  if (!data.filename || typeof data.filename !== 'string') {
    return { ok: false, note: '缺少文件名' };
  }
  if (typeof fetcher !== 'function') {
    return { ok: false, note: '公众号接口请求不可用' };
  }
  try {
    const token = await getAccessToken(cfg, fetcher);
    const boundary = '----rokit' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const crlf = '\r\n';
    // multipart/form-data：media (二进制) + title / introduction / description
    const segments = [];
    function addPart(name, value) {
      segments.push(Buffer.from(
          '--' + boundary + crlf +
          'Content-Disposition: form-data; name="' + name + '"' + crlf + crlf +
          value + crlf,
          'utf8'
      ));
    }
    if (data.title) addPart('title', String(data.title));
    if (data.introduction) addPart('introduction', String(data.introduction));
    segments.push(Buffer.from(
        '--' + boundary + crlf +
        'Content-Disposition: form-data; name="media"; filename="' + encodeURIComponent(data.filename) + '"' + crlf +
        'Content-Type: ' + (data.mime || 'video/mp4') + crlf + crlf,
        'utf8'
    ));
    const pre = Buffer.concat(segments);
    const post = Buffer.concat([Buffer.from(crlf, 'utf8'), data.buffer, Buffer.from(crlf + '--' + boundary + '--' + crlf, 'utf8')]);
    const body = Buffer.concat([pre, post]);
    const resp = await fetcher(API_ROOT + '/material/add_material?access_token=' + encodeURIComponent(token) + '&type=video', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: body
    });
    let json = null;
    try { json = await resp.json(); } catch (_e) { /* ignore */ }
    if (!resp.ok) {
      return { ok: false, note: '上传视频 HTTP ' + resp.status, httpStatus: resp.status };
    }
    if (json && json.errcode && Number(json.errcode)) {
      const e = new Error(noteFromError(json));
      e.wechatErrcode = Number(json.errcode);
      return { ok: false, note: e.message, errcode: e.wechatErrcode };
    }
    if (!json || !json.media_id) {
      return { ok: false, note: '上传视频失败：' + (json && json.errmsg ? json.errmsg : '微信未返回 media_id') };
    }
    return {
      ok: true,
      mediaId: json.media_id,
      url: json.url || '',
      vid: json.vid || ''
    };
  } catch (e) {
    if (e && (e.wechatErrcode === 40001 || e.wechatErrcode === 42001)) {
      invalidateAccessToken(cfg.appId);
    }
    var c = e && e.wechatErrcode;
    if (c === 48001 || c === 48002 || c === 43004 || c === 50005) {
      return { ok: false, status: 'permission_denied', note: String((e && e.message) || e), errcode: c };
    }
    return { ok: false, note: String((e && e.message) || e), errcode: c };
  }
}

// 群发视频消息（mass/sendall, msgtype=mpvideo）
// payload: { mediaId: '永久视频素材 media_id', title?, description? }
// 返回: { ok: true, msgId, msgDataId }   或   { ok: false, note, errcode?, status: 'permission_denied'|'api_error' }
// 说明：mpvideo 是「按标签群发」接口，需公众号已开通群发权限；
//   本实现只暴露 API 调用，不替用户做审核或选择粉丝标签；
//   实际生产应配合 freepublish/get 或 message/mass/get 轮询状态。
async function publishVideoMessage(credentials, payload, fetcher) {
  const cfg = credentials || {};
  const data = payload || {};
  if (!cfg.appId || !cfg.appSecret) {
    return { status: 'config_required', ok: false, note: '请先在设置中配置 AppID 与 AppSecret' };
  }
  if (!data.mediaId) {
    return { status: 'bad_request', ok: false, note: '缺少视频素材 media_id' };
  }
  if (typeof fetcher !== 'function') {
    return { status: 'api_error', ok: false, note: '公众号接口请求不可用' };
  }
  try {
    // 注意：mass/sendall 是「向全部粉丝/特定标签」群发。本实现默认 toall=1（全员），
    //   真实生产前必须先确认公众号已开通该权限且合规群发。
    //   如果要按标签群发，调用方应传入 data.filter = { is_to_all: false, tag_id: ... }
    const reqBody = {
      filter: (data.filter && typeof data.filter === 'object') ? data.filter : { is_to_all: true },
      mpvideo: {
        media_id: data.mediaId
      },
      msgtype: 'mpvideo'
    };
    if (data.title) reqBody.mpvideo.title = String(data.title).slice(0, 64);
    if (data.description) reqBody.mpvideo.description = String(data.description).slice(0, 120);
    const resp = await callWechat(cfg, fetcher, '/message/mass/sendall', reqBody);
    if (!resp || !resp.msg_id) {
      return { status: 'api_error', ok: false, note: '微信未返回 msg_id' };
    }
    return { status: 'publishing', ok: true, msgId: resp.msg_id, msgDataId: resp.msg_data_id || '' };
  } catch (e) {
    const code = e && e.wechatErrcode;
    if (code === 40279 || code === 40248 || code === 43004 || code === 50005) {
      return { status: 'permission_denied', ok: false, note: String((e && e.message) || e), errcode: code };
    }
    return { status: 'api_error', ok: false, note: String((e && e.message) || e), errcode: code };
  }
}

// 提交草稿到正式发布（freepublish/submit）。需要公众号已开通群发权限。
// mediaId: /draft/add 返回的草稿 media_id
// 返回: { ok: true, publishId }   或   { ok: false, note, errcode?, status: 'permission_denied'|'api_error' }
async function publishDraft(credentials, mediaId, fetcher) {
  const cfg = credentials || {};
  if (!cfg.appId || !cfg.appSecret) {
    return { status: 'config_required', ok: false, note: '请先在设置中配置 AppID 与 AppSecret' };
  }
  if (!mediaId || typeof mediaId !== 'string') {
    return { status: 'bad_request', ok: false, note: '缺少草稿 media_id' };
  }
  if (typeof fetcher !== 'function') {
    return { status: 'api_error', ok: false, note: '公众号接口请求不可用' };
  }
  try {
    const data = await callWechat(cfg, fetcher, '/freepublish/submit', { media_id: mediaId });
    if (!data || !data.publish_id) {
      return { status: 'api_error', ok: false, note: '微信未返回 publish_id' };
    }
    return { status: 'publishing', ok: true, publishId: data.publish_id, msgId: data.msg_id || '' };
  } catch (e) {
    // 赋权类错码：40279/40248 (群发权限) + 43004/50005 (公众号权限集) + 48001/48002/48004 (api unauthorized) + 45008/45009/45011 (频率额度)
    // 不重试，请用户检查公众号后台「开发 → 接口权限」
    const code = e && e.wechatErrcode;
    if (code === 40279 || code === 40248 || code === 43004 || code === 50005 || code === 48001 || code === 48002 || code === 48004 || code === 45008 || code === 45009 || code === 45011) {
      return { status: 'permission_denied', ok: false, note: String((e && e.message) || e), errcode: code };
    }
    return { status: 'api_error', ok: false, note: String((e && e.message) || e), errcode: code };
  }
}

// 查询群发结果（freepublish/get）
// 返回统一结果：{ ok, status: 'pending'|'success'|'failed', publishId, articleId?, publishTime?, failReason? }
async function getPublishStatus(credentials, publishId, fetcher) {
  const cfg = credentials || {};
  if (!cfg.appId || !cfg.appSecret) {
    return { ok: false, note: '请先在设置中配置 AppID 与 AppSecret' };
  }
  if (!publishId || typeof publishId !== 'string') {
    return { ok: false, note: '缺少 publish_id' };
  }
  if (typeof fetcher !== 'function') {
    return { ok: false, note: '公众号接口请求不可用' };
  }
  try {
    const data = await callWechat(cfg, fetcher, '/freepublish/get', { publish_id: publishId });
    // 微信返回 publish_status: 0=成功 1=发布中 2=失败
    const statusCode = data && typeof data.publish_status !== 'undefined' ? Number(data.publish_status) : -1;
    const result = {
      ok: true,
      publishId: publishId,
      status: statusCode === 0 ? 'success' : (statusCode === 1 ? 'pending' : (statusCode === 2 ? 'failed' : 'unknown')),
      statusCode: statusCode,
      articleId: (data && data.article_id) || '',
      publishTime: (data && data.publish_time) ? new Date(Number(data.publish_time) * 1000).toISOString() : ''
    };
    if (statusCode === 2 && data && data.fail_list) {
      result.failReason = String(data.fail_list);
    }
    return result;
  } catch (e) {
    var c = e && e.wechatErrcode;
    if (c === 40279 || c === 40248 || c === 43004 || c === 50005 || c === 48001 || c === 48002 || c === 48004 || c === 45008 || c === 45009 || c === 45011) {
      return { ok: false, status: 'permission_denied', note: String((e && e.message) || e), errcode: c };
    }
    return { ok: false, note: String((e && e.message) || e), errcode: c };
  }
}

module.exports = {
  createDraft,
  testConnection,
  getDraft,
  uploadImageMaterial,
  uploadVideoMaterial,
  publishDraft,
  publishVideoMessage,
  getPublishStatus,
  bodyToHtml,
  escapeHtml,
  validateArticle,
  ERRCODE_NOTES,
  // 测试辅助：清缓存（不导出给渲染进程）
  _resetTokenCache: function () { tokenCache.clear(); }
};
