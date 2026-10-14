// Rokit · 微信公众号草稿接口单元测试
//
// 覆盖：access_token 缓存 / 错误码映射 / 字段校验 / 安全（不输出凭证）/
//       连通性测试 / 草稿查询
//
// vitest 全局由 vitest.config.js globals:true 注入
const wechat = require('../electron/wechat');

// 构造一个 mock fetcher：根据 url + method 返回预置 JSON 与 HTTP 状态
// 同时记录每次调用的 url 与 body，便于断言「缓存是否生效」
function makeMockFetcher(scenarios) {
  const calls = [];
  const queue = scenarios.slice();
  function next(url, options) {
    calls.push({ url, options });
    if (queue.length === 0) {
      throw new Error('mock fetcher: 队列已空，但收到新请求 ' + url);
    }
    const sc = queue.shift();
    if (typeof sc.match === 'function' && !sc.match(url)) {
      // 不匹配则重新塞回去，避免误消费
      queue.unshift(sc);
      throw new Error('mock fetcher: 无匹配场景 ' + url);
    }
    return Promise.resolve({
      ok: sc.ok !== false,
      status: sc.status || 200,
      json: function () { return Promise.resolve(sc.json || {}); }
    });
  }
  return {
    fetcher: next,
    calls: calls,
    pending: queue
  };
}

describe('wechat.escapeHtml', () => {
  it('应转义 & < > " \' 与不破坏其他字符', () => {
    expect(wechat.escapeHtml('<a href="x">&y\'</a>'))
      .toBe('&lt;a href=&quot;x&quot;&gt;&amp;y&#39;&lt;/a&gt;');
  });
  it('null/undefined 应转为空串而非 "null"', () => {
    expect(wechat.escapeHtml(null)).toBe('');
    expect(wechat.escapeHtml(undefined)).toBe('');
    expect(wechat.escapeHtml(0)).toBe('0');
  });
});

describe('wechat.bodyToHtml', () => {
  it('应按行包 <p>，空行写 <br>', () => {
    expect(wechat.bodyToHtml('hello\n\nworld')).toBe('<p>hello</p><p><br></p><p>world</p>');
  });
  it('应转义 HTML 特殊字符', () => {
    expect(wechat.bodyToHtml('<script>')).toBe('<p>&lt;script&gt;</p>');
  });
  it('空字符串应输出单个 <br> 占位段（不至于渲染空 body）', () => {
    expect(wechat.bodyToHtml('')).toBe('<p><br></p>');
  });
});

describe('wechat.validateArticle', () => {
  it('空标题应拒绝', () => {
    expect(wechat.validateArticle({ title: '   ', body: 'x' }).ok).toBe(false);
  });
  it('空正文应拒绝', () => {
    expect(wechat.validateArticle({ title: 't', body: '' }).ok).toBe(false);
  });
  it('超 64 字符标题应拒绝并给出当前长度', () => {
    const longTitle = 'a'.repeat(65);
    const r = wechat.validateArticle({ title: longTitle, body: 'x' });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/64/);
    expect(r.note).toMatch(/65/);
  });
  it('正常字段应通过', () => {
    expect(wechat.validateArticle({ title: 't', body: 'b' }).ok).toBe(true);
  });
});

describe('wechat.createDraft · 凭据守卫', () => {
  it('凭据不完整应返回 config_required', async () => {
    const r = await wechat.createDraft({}, { title: 't', body: 'b' }, function () {});
    expect(r.status).toBe('config_required');
  });
  it('凭据缺 thumbMediaId 应返回 config_required', async () => {
    const r = await wechat.createDraft(
      { appId: 'a', appSecret: 'b' },
      { title: 't', body: 'b' },
      function () {}
    );
    expect(r.status).toBe('config_required');
  });
  it('空标题应返回 api_error', async () => {
    const r = await wechat.createDraft(
      { appId: 'a', appSecret: 'b', thumbMediaId: 'c' },
      { title: '', body: 'b' },
      function () {}
    );
    expect(r.status).toBe('api_error');
  });
  it('fetcher 不是函数应返回 api_error', async () => {
    const r = await wechat.createDraft(
      { appId: 'a', appSecret: 'b', thumbMediaId: 'c' },
      { title: 't', body: 'b' },
      null
    );
    expect(r.status).toBe('api_error');
  });
});

describe('wechat.createDraft · 正常路径', () => {
  beforeEach(() => wechat._resetTokenCache());

  it('happy path：先获取 token，再创建草稿，返回 mediaId', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk-1', expires_in: 7200 } },
      { json: { media_id: 'md-1' } }
    ]);
    const r = await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'thumb-1' },
      { title: '你好', body: '第一段\n第二段', author: '小王', digest: '摘要' },
      m.fetcher
    );
    expect(r.status).toBe('draft_created');
    expect(r.mediaId).toBe('md-1');
    // 两次调用：一次 /token，一次 /draft/add
    expect(m.calls.length).toBe(2);
    // token 端点检查必要参数
    expect(m.calls[0].url).toMatch(/^https:\/\/api\.weixin\.qq\.com\/cgi-bin\/token\?/);
    expect(m.calls[0].url).toMatch(/appid=wx/);
    expect(m.calls[0].url).toMatch(/secret=sec/);
    expect(m.calls[0].url).toMatch(/grant_type=client_credential/);
    // 草稿端点确认 access_token 拼接
    expect(m.calls[1].url).toMatch(/draft\/add\?access_token=tk-1/);
    // body 验证：title / author / digest / thumb_media_id 都正确写入
    const sentBody = JSON.parse(m.calls[1].options.body);
    expect(sentBody.articles[0].title).toBe('你好');
    expect(sentBody.articles[0].author).toBe('小王');
    expect(sentBody.articles[0].digest).toBe('摘要');
    expect(sentBody.articles[0].thumb_media_id).toBe('thumb-1');
    expect(sentBody.articles[0].content).toBe('<p>第一段</p><p>第二段</p>');
    expect(sentBody.articles[0].need_open_comment).toBe(0);
  });

  it('第二次调用应复用 access_token 缓存（不再请求 /token）', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk-cached', expires_in: 7200 } },
      { json: { media_id: 'md-A' } },
      { json: { media_id: 'md-B' } }
    ]);
    const creds = { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' };
    const r1 = await wechat.createDraft(creds, { title: 'A', body: 'a' }, m.fetcher);
    const r2 = await wechat.createDraft(creds, { title: 'B', body: 'b' }, m.fetcher);
    expect(r1.status).toBe('draft_created');
    expect(r2.status).toBe('draft_created');
    // 三次调用但只有第一次需要 /token（实际应只有 3 次：1×/token + 2×/draft/add）
    // 关键断言：/token 只被请求了一次
    const tokenCalls = m.calls.filter(function (c) { return /\/token\?/.test(c.url); });
    expect(tokenCalls.length).toBe(1);
  });

  it('errcode 40001 应报错且使缓存失效，下次重新拉 token', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk-1', expires_in: 7200 } },
      { json: { errcode: 40001, errmsg: 'invalid credential' } },
      { json: { access_token: 'tk-2', expires_in: 7200 } },
      { json: { media_id: 'md-2' } }
    ]);
    const creds = { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' };
    const r1 = await wechat.createDraft(creds, { title: 'A', body: 'a' }, m.fetcher);
    expect(r1.status).toBe('api_error');
    expect(r1.note).toMatch(/40001/);
    // 第二次应重新拉 token 并成功
    const r2 = await wechat.createDraft(creds, { title: 'B', body: 'b' }, m.fetcher);
    expect(r2.status).toBe('draft_created');
    expect(r2.mediaId).toBe('md-2');
    // token 被请求了两次
    const tokenCalls = m.calls.filter(function (c) { return /\/token\?/.test(c.url); });
    expect(tokenCalls.length).toBe(2);
  });

  it('errcode 88000 应映射到 IP 白名单提示（不输出 access_token）', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { errcode: 88000, errmsg: 'no privilege' } }
    ]);
    const r = await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      { title: 'A', body: 'a' },
      m.fetcher
    );
    expect(r.status).toBe('api_error');
    expect(r.note).toMatch(/88000/);
    expect(r.note).toMatch(/IP 白名单|白名单/);
    // 安全检查：note 里不应该出现 access_token 字符串
    expect(r.note).not.toContain('tk');
  });

  it('note 中不应出现任何 access_token 字串', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'TK-SECRET-12345', expires_in: 7200 } },
      { json: { errcode: -1, errmsg: 'busy' } }
    ]);
    const r = await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      { title: 'A', body: 'a' },
      m.fetcher
    );
    expect(r.status).toBe('api_error');
    expect(r.note).not.toContain('TK-SECRET-12345');
    expect(r.note).not.toContain('access_token');
  });

  it('应支持用 body 作为 digest 回退（兼容 v1.0 旧 payload）', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'm1' } }
    ]);
    await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      { title: 'A', body: '这是正文' },
      m.fetcher
    );
    const body = JSON.parse(m.calls[1].options.body);
    expect(body.articles[0].digest).toBe('这是正文');
  });

  it('应支持用 intro 作为 digest 回退', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'm1' } }
    ]);
    await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      { title: 'A', body: 'b', intro: '介绍一段' },
      m.fetcher
    );
    const body = JSON.parse(m.calls[1].options.body);
    expect(body.articles[0].digest).toBe('介绍一段');
  });

  it('应自动截断超长 digest 到 120 字符', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'm1' } }
    ]);
    const longDigest = '中'.repeat(200);
    await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      { title: 'A', body: 'b', digest: longDigest },
      m.fetcher
    );
    const body = JSON.parse(m.calls[1].options.body);
    expect(body.articles[0].digest.length).toBe(120);
  });

  it('link 应仅在是 http(s) 时进入 content_source_url', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'm1' } }
    ]);
    await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      { title: 'A', body: 'b', link: 'not-a-url' },
      m.fetcher
    );
    const body = JSON.parse(m.calls[1].options.body);
    expect(body.articles[0].content_source_url).toBe('');
  });
});

describe('wechat.testConnection', () => {
  beforeEach(() => wechat._resetTokenCache());

  it('缺凭据应返回 ok:false 与 note', async () => {
    const r = await wechat.testConnection({}, function () {});
    expect(r.ok).toBe(false);
    expect(r.note).toBeTruthy();
  });

  it('fetcher 不是函数应返回 ok:false', async () => {
    const r = await wechat.testConnection({ appId: 'a', appSecret: 'b' }, null);
    expect(r.ok).toBe(false);
  });

  it('成功路径应返回 ok:true、expiresIn、hasThumb、thumb.ok=true', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      // 阶段 C：thumb 验证成功返回
      { json: { media_id: 'th', title: 'cover', url: 'http://example/c.jpg', news_item: [{ title: 'cover' }] } }
    ]);
    const r = await wechat.testConnection(
      { appId: 'a', appSecret: 'b', thumbMediaId: 'th' },
      m.fetcher
    );
    expect(r.ok).toBe(true);
    expect(r.expiresIn).toBe(7200);
    expect(r.hasThumb).toBe(true);
    expect(r.thumb && r.thumb.ok).toBe(true);
  });

  it('失败路径应把 errcode 映射到 note', async () => {
    const m = makeMockFetcher([
      { json: { errcode: 40001, errmsg: 'invalid credential' } }
    ]);
    // 阶段 A 通过（字段齐）才进到 /token；此测试需要补全 thumbMediaId
    const r = await wechat.testConnection(
      { appId: 'a', appSecret: 'b', thumbMediaId: 'th' },
      m.fetcher
    );
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('api-token');
    expect(r.note).toMatch(/40001/);
    expect(r.note).toMatch(/AppSecret|凭据|access_token/);
    // 此场景 mock 没拿到 access_token；断言只关心 note 里不输出凭证实际值
    expect(r.note).not.toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it('testConnection 应同时刷新缓存（后续 createDraft 直接复用）', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'shared-tk', expires_in: 7200 } },
      // 阶段 C：thumb 验证也补充 mock 让 createDraft 不再触发额外 token
      { json: { media_id: 'th', title: 'x', news_item: [{ title: 'x' }] } },
      { json: { media_id: 'md' } }
    ]);
    const creds = { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' };
    const r1 = await wechat.testConnection(creds, m.fetcher);
    const r2 = await wechat.createDraft(creds, { title: 'A', body: 'a' }, m.fetcher);
    expect(r1.ok).toBe(true);
    expect(r2.status).toBe('draft_created');
    // 只触发了一次 /token（创建草稿的是 /draft/add，没走 /token）
    const tokenCalls = m.calls.filter(function (c) { return /\/token\?/.test(c.url); });
    expect(tokenCalls.length).toBe(1);
  });

  // ===== Phase 2：阶段 A 严格本地校验、不发网络 =====
  it('【阶段 A】缺一个字段：应返回 stage=local + 准确 missing 列表，不发网络', async () => {
    let calls = 0;
    const fetcher = function () { calls++; return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } }); };
    const creds = { appId: 'a', appSecret: 'b' }; // 缺 thumbMediaId
    const r = await wechat.testConnection(creds, fetcher);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('local');
    expect(r.missing).toEqual(['thumbMediaId']);
    expect(r.note).toMatch(/封面素材 ID/);
    // 关键断言：没发起任何网络请求
    expect(calls).toBe(0);
  });

  it('【阶段 A】缺两个字段：应同时报告两个 missing', async () => {
    const fetcher = function () { throw new Error('不应被调用'); };
    const creds = { appId: 'a' }; // 缺 appSecret + thumbMediaId
    const r = await wechat.testConnection(creds, fetcher);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('local');
    expect(r.missing.sort()).toEqual(['appSecret', 'thumbMediaId']);
  });

  it('【阶段 A】字段全是空白字符串时也应识别为缺字段', async () => {
    const fetcher = function () { throw new Error('不应被调用'); };
    const creds = { appId: '', appSecret: '   ', thumbMediaId: '\n\t' };
    const r = await wechat.testConnection(creds, fetcher);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('local');
    expect(r.missing.length).toBe(3);
  });

  it('【阶段 A】字段值仅是 falsy 值（如 0）应被过滤', async () => {
    const creds = { appId: 0, appSecret: false, thumbMediaId: null };
    const r = await wechat.testConnection(creds, function () { throw new Error('不应被调用'); });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('local');
  });

  // ===== Phase 2：阶段 B /token 失败时，note 必须含 errcode 而非笼统 =====
  it('【阶段 B】/token 返回 40001 时应给凭证错误 note', async () => {
    const m = makeMockFetcher([
      { json: { errcode: 40001, errmsg: 'invalid credential' } }
    ]);
    const r = await wechat.testConnection(
      { appId: 'wx', appSecret: 'bad', thumbMediaId: 'th' },
      m.fetcher
    );
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('api-token');
    expect(r.errcode).toBe(40001);
    expect(r.note).toMatch(/40001/);
    expect(r.note).not.toContain('bad');  // 不输出 AppSecret 实际值
  });

  it('【阶段 B】/token 返回 88000（IP 白名单）应给明确提示', async () => {
    const m = makeMockFetcher([
      { json: { errcode: 88000, errmsg: 'no privilege' } }
    ]);
    const r = await wechat.testConnection(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      m.fetcher
    );
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('api-token');
    expect(r.errcode).toBe(88000);
    expect(r.note).toMatch(/IP 白名单/);
  });

  it('【阶段 B】HTTP 503 网络故障应映射到中文（非英文 errcode）', async () => {
    const m = makeMockFetcher([
      { ok: false, status: 503, json: {} }
    ]);
    const r = await wechat.testConnection(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      m.fetcher
    );
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('api-token');
    expect(r.httpStatus).toBe(503);
    expect(r.note).toMatch(/503/);
  });

  // ===== Phase 2：阶段 C thumb 独立验证 =====
  it('【阶段 C】thumb 验证成功：ok=true, 返回 thumb.media_id/title', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'th', title: 'cover-1', news_item: [{ title: 'x' }] } }
    ]);
    const r = await wechat.testConnection(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      m.fetcher
    );
    expect(r.ok).toBe(true);
    expect(r.thumb.ok).toBe(true);
    expect(r.thumb.title).toBe('cover-1');
  });

  it('【阶段 C】thumb 验证返回 40007（invalid media_id）应单独报告', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { errcode: 40007, errmsg: 'invalid media_id' } }
    ]);
    const r = await wechat.testConnection(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th-bad' },
      m.fetcher
    );
    // 整体结果因为 thumb 失败而 ok=false，但 token 已成功
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('api-thumb');
    expect(r.thumb.ok).toBe(false);
    expect(r.thumb.errcode).toBe(40007);
    expect(r.note).toMatch(/封面素材/);
  });

  it('【阶段 C】未传 thumbMediaId 时不应触发 /material/get_material', async () => {
    // 当三个字段都齐，但 thumbMediaId 是空字符串 → stage A 把它识别为缺字段
    // 所以这里 stage 是 local，不是 api-thumb；本测试要确认的是「不要调 /material」
    const fetcher = function () { throw new Error('不应被调用：stage A 应拦下'); };
    const r = await wechat.testConnection(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: '' },
      fetcher
    );
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('local');
    expect(r.missing).toEqual(['thumbMediaId']);
  });

  it('【阶段 C】三字段齐但 thumbMediaId 是 undefined 时同被识别', async () => {
    const fetcher = function () { throw new Error('不应被调用'); };
    const creds = { appId: 'wx', appSecret: 'sec', thumbMediaId: undefined };
    const r = await wechat.testConnection(creds, fetcher);
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('local');
    expect(r.missing).toEqual(['thumbMediaId']);
  });
});

describe('wechat.getDraft', () => {
  beforeEach(() => wechat._resetTokenCache());

  it('缺 mediaId 应返回 ok:false', async () => {
    const r = await wechat.getDraft({ appId: 'a', appSecret: 'b' }, '', function () {});
    expect(r.ok).toBe(false);
  });

  it('happy path 应返回 ok:true 与 draft 详情', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { news_item: [{ title: 'x' }] } }
    ]);
    const r = await wechat.getDraft(
      { appId: 'a', appSecret: 'b' },
      'md-1',
      m.fetcher
    );
    expect(r.ok).toBe(true);
    expect(r.draft.news_item[0].title).toBe('x');
    expect(m.calls[1].url).toMatch(/draft\/get\?access_token=tk/);
    // body 包含 media_id
    expect(JSON.parse(m.calls[1].options.body).media_id).toBe('md-1');
  });

  it('参数校验失败应不发起网络请求', async () => {
    const calls = [];
    const fetcher = function (url) {
      calls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
    };
    const r = await wechat.getDraft({ appId: 'a', appSecret: 'b' }, null, fetcher);
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe('wechat · 安全', () => {
  beforeEach(() => wechat._resetTokenCache());

  it('缓存的 access_token 不应出现在任何返回字段的 note 中', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'TOP-SECRET-TOKEN', expires_in: 7200 } },
      { json: { errcode: -1, errmsg: 'busy' } }
    ]);
    const r = await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      { title: 't', body: 'b' },
      m.fetcher
    );
    expect(r.note).not.toContain('TOP-SECRET-TOKEN');
    expect(r.note).not.toContain('access_token');
  });

  it('缓存的 token 不应在 ERRCODE_NOTES 导出中泄露', () => {
    for (const k of Object.keys(wechat.ERRCODE_NOTES)) {
      const v = String(wechat.ERRCODE_NOTES[k]);
      expect(v).not.toMatch(/access_token\s*[:=]/i);
      expect(v).not.toMatch(/^sk-/);
    }
  });
});
