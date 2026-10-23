// Rokit · 微信公众号 freepublish / 上传图片 / 状态查询单元测试（v1.1）
//
// 覆盖：uploadImageMaterial（multipart/form-data）、publishDraft（freepublish/submit）、
// getPublishStatus（freepublish/get）、错误码 → 状态映射。
//
// vitest globals 由 vitest.config.js 提供

'use strict';

const wechat = require('../electron/wechat');

function makeMockFetcher(scenarios) {
  const calls = [];
  const queue = scenarios.slice();
  function next(url, options) {
    calls.push({ url: url, options: options });
    if (queue.length === 0) throw new Error('mock fetcher: 队列已空，但收到新请求 ' + url);
    const sc = queue.shift();
    if (typeof sc.match === 'function' && !sc.match(url)) {
      queue.unshift(sc);
      throw new Error('mock fetcher: 无匹配场景 ' + url);
    }
    return Promise.resolve({
      ok: sc.ok !== false,
      status: sc.status || 200,
      json: async function () { return sc.json || {}; },
      arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(0)); },
      text: function () { return Promise.resolve(''); }
    });
  }
  return { fetcher: next, calls: calls };
}

describe('wechat.uploadImageMaterial', () => {
  beforeEach(() => wechat._resetTokenCache());

  it('缺 AppID/AppSecret 应直接报错（不发请求）', async () => {
    const r = await wechat.uploadImageMaterial({}, { buffer: Buffer.from('x'), filename: 'a.jpg' }, function () {});
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/AppID/);
  });

  it('缺 buffer 应报错', async () => {
    const r = await wechat.uploadImageMaterial(
      { appId: 'wx', appSecret: 'sec' },
      { filename: 'a.jpg' },
      function () {}
    );
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/二进制/);
  });

  it('happy path：先拿 token，再 /material/add_material，返回 mediaId/url', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk-img', expires_in: 7200 } },
      { json: { media_id: 'm-img-1', url: 'https://mmbiz.qpic.cn/xxx' } }
    ]);
    const r = await wechat.uploadImageMaterial(
      { appId: 'wx', appSecret: 'sec' },
      { buffer: Buffer.from('fake-jpeg-bytes'), filename: 'cover.jpg', mime: 'image/jpeg' },
      m.fetcher
    );
    expect(r.ok).toBe(true);
    expect(r.mediaId).toBe('m-img-1');
    expect(r.url).toBe('https://mmbiz.qpic.cn/xxx');
    expect(m.calls.length).toBe(2);
    expect(m.calls[0].url).toMatch(/token\?/);
    expect(m.calls[1].url).toMatch(/material\/add_material\?access_token=tk-img&type=image/);
    expect(m.calls[1].options.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    // body 是 multipart Buffer，包含 filename + jpeg bytes
    const bodyBuf = m.calls[1].options.body;
    expect(Buffer.isBuffer(bodyBuf)).toBe(true);
    expect(bodyBuf.toString('utf8')).toMatch(/Content-Disposition: form-data; name="media"; filename="cover\.jpg"/);
  });

  it('HTTP 500 应返回 ok:false + httpStatus，不抛', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { ok: false, status: 500, json: { errcode: -1, errmsg: 'system busy' } }
    ]);
    const r = await wechat.uploadImageMaterial(
      { appId: 'wx', appSecret: 'sec' },
      { buffer: Buffer.from('x'), filename: 'a.jpg' },
      m.fetcher
    );
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(500);
  });

  it('errcode 40007（无效 media_id）应返回 ok:false + 错误码', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { errcode: 40007, errmsg: 'invalid media_id' } }
    ]);
    const r = await wechat.uploadImageMaterial(
      { appId: 'wx', appSecret: 'sec' },
      { buffer: Buffer.from('x'), filename: 'a.jpg' },
      m.fetcher
    );
    expect(r.ok).toBe(false);
    expect(r.errcode).toBe(40007);
    expect(r.note).toMatch(/40007/);
  });

  it('note 中不应出现 access_token 真实值', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'TK-SECRET-IMG-001', expires_in: 7200 } },
      { json: { errcode: 45009, errmsg: 'reach quota' } }
    ]);
    const r = await wechat.uploadImageMaterial(
      { appId: 'wx', appSecret: 'sec' },
      { buffer: Buffer.from('x'), filename: 'a.jpg' },
      m.fetcher
    );
    expect(r.note).not.toContain('TK-SECRET-IMG-001');
  });
});

describe('wechat.publishDraft', () => {
  beforeEach(() => wechat._resetTokenCache());

  it('缺 mediaId 应返回 bad_request', async () => {
    const r = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, '', function () {});
    expect(r.status).toBe('bad_request');
    expect(r.ok).toBe(false);
  });

  it('缺 AppID/AppSecret 应返回 config_required', async () => {
    const r = await wechat.publishDraft({}, 'md-1', function () {});
    expect(r.status).toBe('config_required');
    expect(r.ok).toBe(false);
  });

  it('happy path：freepublish/submit 返回 publishId（视为 publishing 中）', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { publish_id: 'pub-1', msg_id: 'msg-1' } }
    ]);
    const r = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, 'md-1', m.fetcher);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('publishing');
    expect(r.publishId).toBe('pub-1');
    expect(r.msgId).toBe('msg-1');
    expect(m.calls[1].url).toMatch(/freepublish\/submit\?access_token=tk/);
    expect(JSON.parse(m.calls[1].options.body).media_id).toBe('md-1');
  });

  it('无 publish_id 应返回 api_error', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { errcode: -1, errmsg: 'busy' } }
    ]);
    const r = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, 'md-1', m.fetcher);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('api_error');
  });

  it('权限类错码（40279/40248/43004/50005）应返回 permission_denied', async () => {
    for (const code of [40279, 40248, 43004, 50005]) {
      wechat._resetTokenCache();
      const m = makeMockFetcher([
        { json: { access_token: 'tk-' + code, expires_in: 7200 } },
        { json: { errcode: code, errmsg: 'permission' } }
      ]);
      const r = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, 'md-1', m.fetcher);
      expect(r.status).toBe('permission_denied');
      expect(r.ok).toBe(false);
      expect(r.errcode).toBe(code);
    }
  });

  it('note 不应暴露 access_token', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'TK-PUB-LEAK', expires_in: 7200 } },
      { json: { errcode: 88000, errmsg: 'no privilege' } }
    ]);
    const r = await wechat.publishDraft({ appId: 'wx', appSecret: 'sec' }, 'md-1', m.fetcher);
    expect(r.note).not.toContain('TK-PUB-LEAK');
  });
});

describe('wechat.getPublishStatus', () => {
  beforeEach(() => wechat._resetTokenCache());

  it('缺 publishId 应报错', async () => {
    const r = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, '', function () {});
    expect(r.ok).toBe(false);
  });

  it('publish_status=0 应映射到 success', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { publish_id: 'pub-1', publish_status: 0, article_id: 'art-1', publish_time: 1700000000 } }
    ]);
    const r = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, 'pub-1', m.fetcher);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('success');
    expect(r.statusCode).toBe(0);
    expect(r.articleId).toBe('art-1');
    expect(r.publishTime).toMatch(/2023/); // 2023-11-14 → contains 2023
  });

  it('publish_status=1 应映射到 pending', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { publish_id: 'pub-1', publish_status: 1 } }
    ]);
    const r = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, 'pub-1', m.fetcher);
    expect(r.status).toBe('pending');
  });

  it('publish_status=2 应映射到 failed + 含 failReason', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { publish_id: 'pub-1', publish_status: 2, fail_list: [{ idx: 0, article_url: '', errcode: 53405 }] } }
    ]);
    const r = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, 'pub-1', m.fetcher);
    expect(r.status).toBe('failed');
    expect(r.failReason).toBeTruthy();
  });

  it('未识别的 publish_status 应映射到 unknown', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { publish_id: 'pub-1', publish_status: 99 } }
    ]);
    const r = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, 'pub-1', m.fetcher);
    expect(r.status).toBe('unknown');
  });

  it('errcode 应原样返回，不抛', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { errcode: 40001, errmsg: 'invalid' } }
    ]);
    const r = await wechat.getPublishStatus({ appId: 'wx', appSecret: 'sec' }, 'pub-1', m.fetcher);
    expect(r.ok).toBe(false);
    expect(r.errcode).toBe(40001);
  });
});