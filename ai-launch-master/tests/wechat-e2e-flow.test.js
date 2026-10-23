// Rokit · 微信公众号 v1.6：端到端完整流程（draft → submit → poll → result）
//
// 8 个验收场景（按用户第八节）：
//   1. 草稿成功 → 自动提交 → 查询成功（happy path）
//   2. 草稿成功 → submit 返回 48001（接口未授权，保留草稿）
//   3. 草稿失败 → 不执行 submit
//   4. submit 成功 → poll 多次 pending → 持续查询，不提前 success
//   5. submit 成功 → poll 持续失败 → 不抛、不重试 submit
//   6. submit 成功 → poll 连续接口错误 → 保留 publish_id
//   7. submit 仅调 1 次（防重复）
//   8. submit + poll 走完整端点链 + access_token 仅 1 次
//   9. submit 接收的 mediaId = draft 返回的 mediaId（不重新创建）
//   11. note 不暴露 access_token 真实值

'use strict';

const wechat = require('../electron/wechat');

function makeMockFetcher(scenarios) {
  const calls = [];
  const queue = scenarios.slice();
  function next(url, options) {
    calls.push({ url, options });
    if (queue.length === 0) throw new Error('mock fetcher queue empty, got ' + url);
    const sc = queue.shift();
    if (typeof sc.match === 'function' && !sc.match(url)) {
      queue.unshift(sc);
      throw new Error('mock fetcher no match ' + url);
    }
    return Promise.resolve({
      ok: sc.ok !== false,
      status: sc.status || 200,
      json: async function () { return sc.json || {}; }
    });
  }
  return { fetcher: next, calls, pending: queue };
}

describe('wechat 端到端：8+ 个验收场景（mock 完整 API）', () => {
  beforeEach(() => wechat._resetTokenCache());

  // 场景 1：happy path — 草稿 → submit → poll(success)
  it('场景1：草稿成功 → 自动 submit → poll 一次性 success', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk-1', expires_in: 7200 } },
      { json: { media_id: 'md-happy', errcode: 0 } },
      { json: { errcode: 0, publish_id: 'pub-happy' } },
      { json: { errcode: 0, publish_id: 'pub-happy', publish_status: 0, article_id: 'art-1', publish_time: 1700000000 } }
    ]);
    const draft = await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th-1' },
      { title: '你好', body: '正文', digest: '摘要', author: '小王' },
      m.fetcher
    );
    expect(draft.status).toBe('draft_created');
    expect(draft.mediaId).toBe('md-happy');

    const submit = await wechat.publishDraft(
      { appId: 'wx', appSecret: 'sec' },
      draft.mediaId,
      m.fetcher
    );
    expect(submit.status).toBe('publishing');
    expect(submit.publishId).toBe('pub-happy');

    const poll = await wechat.getPublishStatus(
      { appId: 'wx', appSecret: 'sec' },
      submit.publishId,
      m.fetcher
    );
    expect(poll.ok).toBe(true);
    expect(poll.status).toBe('success');
    expect(poll.articleId).toBe('art-1');

    // 调用路径：token → draft/add → freepublish/submit → freepublish/get
    expect(m.calls[0].url).toMatch(/token\?/);
    expect(m.calls[1].url).toMatch(/draft\/add\?access_token=tk-1/);
    expect(m.calls[2].url).toMatch(/freepublish\/submit\?access_token=tk-1/);
    expect(m.calls[3].url).toMatch(/freepublish\/get\?access_token=tk-1/);
  });

  // 场景 2：submit 返回 48001 — 应保留草稿、返回 permission_denied、不调 get
  it('场景2：submit 返回 48001 → 保留草稿 + permission_denied + 不调 get', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'md-keep', errcode: 0 } },
      { json: { errcode: 48001, errmsg: 'api unauthorized rid: fake-rid' } }
    ]);
    const draft = await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      { title: 'T', body: 'B' },
      m.fetcher
    );
    expect(draft.status).toBe('draft_created');
    const submit = await wechat.publishDraft(
      { appId: 'wx', appSecret: 'sec' },
      draft.mediaId,
      m.fetcher
    );
    expect(submit.status).toBe('permission_denied');
    expect(submit.errcode).toBe(48001);
    // 仅 3 次调用：token + draft + submit（没有 get）
    expect(m.calls.length).toBe(3);
  });

  // 场景 3：草稿因 thumbMediaId 缺失 → config_required → 不调 submit
  it('场景3a：草稿因凭据缺失 → config_required → 不调 submit', async () => {
    const m = makeMockFetcher([]);
    const draft = await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec' },  // 缺 thumbMediaId
      { title: 'T', body: 'B' },
      m.fetcher
    );
    expect(draft.status).toBe('config_required');
    // 没有调用 fetcher
    expect(m.calls.length).toBe(0);
  });

  // 场景 3b：草稿 API 返回 40007 → api_error → 上层不应 submit
  it('场景3b：草稿接口返回 40007 → api_error → 不应 submit', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { errcode: 40007, errmsg: 'invalid media_id' } }
    ]);
    const draft = await wechat.createDraft(
      { appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' },
      { title: 'T', body: 'B' },
      m.fetcher
    );
    expect(draft.status).toBe('api_error');
    expect(draft.note).toMatch(/40007/);
    // 没有 submit 调用
    var submitCount = 0;
    m.calls.forEach(function(c) { if (/freepublish\/submit/.test(c.url)) submitCount++; });
    expect(submitCount).toBe(0);
  });

  // 场景 4：submit 成功 → poll 多次 pending → 只在最终 success 时返回 success
  it('场景4：poll 4 次 pending 后才 success → 中途永不能误读为 success', async () => {
    // token + draft + submit + 4 个 pending get + 1 个 success get
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'md-4', errcode: 0 } },
      { json: { errcode: 0, publish_id: 'pub-4' } },
      { json: { errcode: 0, publish_status: 1 } },
      { json: { errcode: 0, publish_status: 1 } },
      { json: { errcode: 0, publish_status: 1 } },
      { json: { errcode: 0, publish_status: 1 } },
      { json: { errcode: 0, publish_status: 0, article_id: 'art-4', publish_time: 1700000001 } }
    ]);
    const draft = await wechat.createDraft({ appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' }, { title: 'T', body: 'B' }, m.fetcher);
    const submit = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, draft.mediaId, m.fetcher);
    expect(submit.status).toBe('publishing');
    // 上层调用 4 次 getPublishStatus，每次都是 pending
    for (let i = 0; i < 4; i++) {
      const r = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, submit.publishId, m.fetcher);
      expect(r.status).toBe('pending');
      expect(r.ok).toBe(true);
    }
    // 第 5 次 getPublishStatus 返回 success
    const last = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, submit.publishId, m.fetcher);
    expect(last.status).toBe('success');
    expect(last.articleId).toBe('art-4');
  });

  // 场景 5：submit 成功 → poll 持续网络错误 → 不重试 submit、不毛报成功
  it('场景5：poll 持续网络失败 → getPublishStatus 返回 ok:false 不抛，不重试 submit', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'md-5', errcode: 0 } },
      { json: { errcode: 0, publish_id: 'pub-5' } },
      { ok: false, status: 500, json: { errcode: -1, errmsg: 'system busy' } },
      { ok: false, status: 502, json: { errcode: -1, errmsg: 'bad gateway' } }
    ]);
    const draft = await wechat.createDraft({ appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' }, { title: 'T', body: 'B' }, m.fetcher);
    const submit = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, draft.mediaId, m.fetcher);
    expect(submit.status).toBe('publishing');
    // 多次 poll 不抛
    const r1 = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, submit.publishId, m.fetcher);
    expect(r1.ok).toBe(false);
    const r2 = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, submit.publishId, m.fetcher);
    expect(r2.ok).toBe(false);
    // 没有再次 submit
    var submitCount = 0;
    m.calls.forEach(function(c) { if (/freepublish\/submit/.test(c.url)) submitCount++; });
    expect(submitCount).toBe(1);
    // 校验 2 次 get 调用
    var getCount = 0;
    m.calls.forEach(function(c) { if (/freepublish\/get/.test(c.url)) getCount++; });
    expect(getCount).toBe(2);
  });

  // 场景 6：submit 成功 → poll 连续接口错误 → 保留 publish_id，调用方可手动查询
  it('场景6：submit 成功 → poll 连续接口错误 → 保留 publish_id，上层可标 UNKNOWN', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'md-6', errcode: 0 } },
      { json: { errcode: 0, publish_id: 'pub-6' } },
      { json: { errcode: 40001, errmsg: 'invalid credential' } },
      { json: { errcode: 40001, errmsg: 'invalid credential' } }
    ]);
    const draft = await wechat.createDraft({ appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' }, { title: 'T', body: 'B' }, m.fetcher);
    const submit = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, draft.mediaId, m.fetcher);
    expect(submit.publishId).toBe('pub-6');
    const r1 = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, submit.publishId, m.fetcher);
    expect(r1.ok).toBe(false);
    expect(r1.errcode).toBe(40001);
    // 没有再次 submit
    var submitCount = 0;
    m.calls.forEach(function(c) { if (/freepublish\/submit/.test(c.url)) submitCount++; });
    expect(submitCount).toBe(1);
  });

  // 场景 7：submit 仅调 1 次（防重复）
  it('场景7：同一流程多次轮询，submit 仅调 1 次（防重复发布）', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'md-7', errcode: 0 } },
      { json: { errcode: 0, publish_id: 'pub-7' } },
      // 顶层重复调用 get，但只要返回 success 后上层不再调；这里只补一个 success get 用于调用调 getPublishStatus
      { json: { errcode: 0, publish_status: 0, article_id: 'art-7', publish_time: 1700000002 } }
    ]);
    const draft = await wechat.createDraft({ appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' }, { title: 'T', body: 'B' }, m.fetcher);
    const submit = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, draft.mediaId, m.fetcher);
    // 上层调用 getPublishStatus 仅 1 次（上层在 success 后停止）
    await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, submit.publishId, m.fetcher);
    var submitCount = 0;
    m.calls.forEach(function(c) { if (/freepublish\/submit/.test(c.url)) submitCount++; });
    expect(submitCount).toBe(1);
  });

  // 场景 8：完整链路 — access_token 复用 1 次
  it('场景8：完整链路 — token 只拉 1 次（4 个 endpoint 共享同一 access_token）', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk-shared', expires_in: 7200 } },
      { json: { media_id: 'md-8', errcode: 0 } },
      { json: { errcode: 0, publish_id: 'pub-8' } },
      { json: { errcode: 0, publish_status: 0, article_id: 'art-8', publish_time: 1700000003 } }
    ]);
    const draft = await wechat.createDraft({ appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' }, { title: 'T', body: 'B' }, m.fetcher);
    const submit = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, draft.mediaId, m.fetcher);
    await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, submit.publishId, m.fetcher);
    var tokenCount = 0;
    m.calls.forEach(function(c) { if (/token\?/.test(c.url)) tokenCount++; });
    expect(tokenCount).toBe(1);
    expect(m.calls.length).toBe(4);
    // 验证 access_token 参数一致
    m.calls.forEach(function(c) {
      if (/access_token=/.test(c.url)) {
        expect(c.url).toMatch(/access_token=tk-shared/);
      }
    });
  });

  // 场景 9：submit 必须接收 draft 返回的 media_id
  it('场景9：submit 的 media_id 必须等于 draft 返回的 media_id（不复用旧文章）', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'md-9-EXPECTED', errcode: 0 } },
      { json: { errcode: 0, publish_id: 'pub-9' } }
    ]);
    const draft = await wechat.createDraft({ appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' }, { title: 'T', body: 'B' }, m.fetcher);
    expect(draft.mediaId).toBe('md-9-EXPECTED');
    await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, draft.mediaId, m.fetcher);
    var submitCall = m.calls[2];
    var body = JSON.parse(submitCall.options.body);
    expect(body.media_id).toBe('md-9-EXPECTED');
  });

  // 场景 10：note 不暴露 access_token / appSecret
  it('场景10：note 绝不包含 access_token 真实值', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk-XXXX', expires_in: 7200 } },
      { json: { media_id: 'md', errcode: 0 } },
      { json: { errcode: 0, publish_id: 'pub' } },
      { json: { errcode: 48001, errmsg: 'api unauthorized rid: r-test' } }
    ]);
    const draft = await wechat.createDraft({ appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' }, { title: 'T', body: 'B' }, m.fetcher);
    await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, draft.mediaId, m.fetcher);
    const poll = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, 'pub', m.fetcher);
    // note 绝不包含 access_token 真实值
    expect(poll.note).not.toContain('tk-XXXX');
    expect(poll.note).not.toContain('access_token=');
    // note 仅含 ERRCODE_NOTES 中文说明（rid 不写入 UI，只写调试日志）
    expect(poll.note).toMatch(/48001/);
    expect(poll.note).toMatch(/\u672a\u6388\u6743/);
  });

  // 场景 11：草稿接口返回 45008（频率超限）→ 同样归 permission_denied
  it('场景11：submit 返回 45008 → permission_denied', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'md-11', errcode: 0 } },
      { json: { errcode: 45008, errmsg: 'freq limit' } }
    ]);
    const draft = await wechat.createDraft({ appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' }, { title: 'T', body: 'B' }, m.fetcher);
    const submit = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, draft.mediaId, m.fetcher);
    expect(submit.status).toBe('permission_denied');
    expect(submit.errcode).toBe(45008);
  });

  // 场景 12：getPublishStatus 返回 40001 → 上层可重试 token，不重试 submit
  it('场景12：poll 返回 40001 → 上层可重试 token；submit 仍只调 1 次', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk-12', expires_in: 7200 } },
      { json: { media_id: 'md-12', errcode: 0 } },
      { json: { errcode: 0, publish_id: 'pub-12' } },
      { json: { errcode: 40001, errmsg: 'invalid credential' } }
    ]);
    const draft = await wechat.createDraft({ appId: 'wx', appSecret: 'sec', thumbMediaId: 'th' }, { title: 'T', body: 'B' }, m.fetcher);
    const submit = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, draft.mediaId, m.fetcher);
    const poll = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, submit.publishId, m.fetcher);
    expect(poll.ok).toBe(false);
    expect(poll.errcode).toBe(40001);
    var submitCount = 0;
    m.calls.forEach(function(c) { if (/freepublish\/submit/.test(c.url)) submitCount++; });
    expect(submitCount).toBe(1);
  });
});