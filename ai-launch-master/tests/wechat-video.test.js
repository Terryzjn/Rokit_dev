// Rokit · 微信公众号视频上传 / 群发视频消息 单元测试（v1.x）
//
// 覆盖：
//   - uploadVideoMaterial: multipart/form-data 上传到 /material/add_material?type=video
//   - publishVideoMessage: 群发视频消息 (msgtype=mpvideo) 走 /message/mass/sendall
//   - 错误码 → 状态映射（权限类 → permission_denied）
//   - 凭证保护：access_token / AppSecret 不出现在 note 中

'use strict';

const wechat = require('../electron/wechat');

function makeMockFetcher(scenarios) {
  const calls = [];
  const queue = scenarios.slice();
  function next(url, options) {
    calls.push({ url, options });
    if (queue.length === 0) throw new Error('mock fetcher: 队列已空，但收到新请求 ' + url);
    const sc = queue.shift();
    if (typeof sc.match === 'function' && !sc.match(url)) {
      queue.unshift(sc);
      throw new Error('mock fetcher: 无匹配场景 ' + url);
    }
    return Promise.resolve({
      ok: sc.ok !== false,
      status: sc.status || 200,
      json: async () => sc.json || {},
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      text: () => Promise.resolve('')
    });
  }
  return { fetcher: next, calls };
}

describe('wechat.uploadVideoMaterial', () => {
  beforeEach(() => wechat._resetTokenCache());

  it('缺 AppID/AppSecret 应立即报错（不发请求）', async () => {
    const r = await wechat.uploadVideoMaterial({}, { buffer: Buffer.from('x'), filename: 'v.mp4' }, function () {});
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/AppID/);
  });

  it('缺 buffer 应报错', async () => {
    const r = await wechat.uploadVideoMaterial(
      { appId: 'wx', appSecret: 'sec' },
      { filename: 'v.mp4' },
      function () {}
    );
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/二进制/);
  });

  it('happy path：multipart 上传应包含 media + title/introduction + 返回 mediaId+url+vid', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk-vid', expires_in: 7200 } },
      { json: { media_id: 'mv-1', url: 'https://example.com/v.mp4', vid: 'v-test-id-123' } }
    ]);
    const r = await wechat.uploadVideoMaterial(
      { appId: 'wx', appSecret: 'sec' },
      {
        buffer: Buffer.from('fake-mp4-bytes'),
        filename: 'demo.mp4',
        mime: 'video/mp4',
        title: '演示视频',
        introduction: '简介一段'
      },
      m.fetcher
    );
    expect(r.ok).toBe(true);
    expect(r.mediaId).toBe('mv-1');
    expect(r.url).toBe('https://example.com/v.mp4');
    expect(r.vid).toBe('v-test-id-123');
    expect(m.calls.length).toBe(2);
    expect(m.calls[0].url).toMatch(/\/token\?/);
    expect(m.calls[1].url).toMatch(/material\/add_material\?access_token=tk-vid&type=video/);
    expect(m.calls[1].options.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    const bodyBuf = m.calls[1].options.body;
    expect(Buffer.isBuffer(bodyBuf)).toBe(true);
    // 应包含 title / introduction / media 文件名
    const bodyStr = bodyBuf.toString('utf8');
    expect(bodyStr).toMatch(/name="title"\r?\n\r?\n演示视频/);
    expect(bodyStr).toMatch(/name="introduction"\r?\n\r?\n简介一段/);
    expect(bodyStr).toMatch(/name="media"; filename="demo\.mp4"/);
  });

  it('无 title/introduction 时仅上传 media 文件', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { media_id: 'mv-2' } }
    ]);
    const r = await wechat.uploadVideoMaterial(
      { appId: 'wx', appSecret: 'sec' },
      { buffer: Buffer.from('x'), filename: 'v.mp4', mime: 'video/mp4' },
      m.fetcher
    );
    expect(r.ok).toBe(true);
    expect(r.mediaId).toBe('mv-2');
    expect(r.vid).toBe(''); // 微信返回没有 vid 字段时为空
  });

  it('HTTP 500 应返回 ok:false + httpStatus', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { ok: false, status: 500, json: { errcode: -1, errmsg: 'system busy' } }
    ]);
    const r = await wechat.uploadVideoMaterial(
      { appId: 'wx', appSecret: 'sec' },
      { buffer: Buffer.from('x'), filename: 'v.mp4' },
      m.fetcher
    );
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(500);
  });

  it('errcode 45001/45002 应返回 ok:false + errcode', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { errcode: 45001, errmsg: 'media size out of limit' } }
    ]);
    const r = await wechat.uploadVideoMaterial(
      { appId: 'wx', appSecret: 'sec' },
      { buffer: Buffer.from('x'), filename: 'v.mp4' },
      m.fetcher
    );
    expect(r.ok).toBe(false);
    expect(r.errcode).toBe(45001);
  });

  it('note 不应暴露 access_token 真实值', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'TK-VIDEO-LEAK', expires_in: 7200 } },
      { json: { errcode: 45009, errmsg: 'reach quota' } }
    ]);
    const r = await wechat.uploadVideoMaterial(
      { appId: 'wx', appSecret: 'sec' },
      { buffer: Buffer.from('x'), filename: 'v.mp4' },
      m.fetcher
    );
    expect(r.note).not.toContain('TK-VIDEO-LEAK');
  });
});

describe('wechat.publishVideoMessage', () => {
  beforeEach(() => wechat._resetTokenCache());

  it('缺 AppID/AppSecret 应返回 config_required', async () => {
    const r = await wechat.publishVideoMessage({}, { mediaId: 'mv' }, function () {});
    expect(r.status).toBe('config_required');
    expect(r.ok).toBe(false);
  });

  it('缺 mediaId 应返回 bad_request', async () => {
    const r = await wechat.publishVideoMessage({ appId: 'wx', appSecret: 'sec' }, {}, function () {});
    expect(r.status).toBe('bad_request');
    expect(r.ok).toBe(false);
  });

  it('happy path：mass/sendall 应返回 msgId + msgDataId', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { msg_id: 'm-id-1', msg_data_id: 'md-id-1' } }
    ]);
    const r = await wechat.publishVideoMessage(
      { appId: 'wx', appSecret: 'sec' },
      { mediaId: 'mv-1', title: '演示', description: '简介' },
      m.fetcher
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe('publishing');
    expect(r.msgId).toBe('m-id-1');
    expect(r.msgDataId).toBe('md-id-1');
    expect(m.calls[1].url).toMatch(/message\/mass\/sendall\?access_token=tk/);
    const body = JSON.parse(m.calls[1].options.body);
    expect(body.msgtype).toBe('mpvideo');
    expect(body.mpvideo.media_id).toBe('mv-1');
    expect(body.mpvideo.title).toBe('演示');
    expect(body.mpvideo.description).toBe('简介');
    expect(body.filter).toEqual({ is_to_all: true });
  });

  it('可传入 filter：自定义粉丝标签', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'tk', expires_in: 7200 } },
      { json: { msg_id: 'm-id-2' } }
    ]);
    const r = await wechat.publishVideoMessage(
      { appId: 'wx', appSecret: 'sec' },
      { mediaId: 'mv-2', filter: { is_to_all: false, tag_id: 101 } },
      m.fetcher
    );
    expect(r.ok).toBe(true);
    const body = JSON.parse(m.calls[1].options.body);
    expect(body.filter).toEqual({ is_to_all: false, tag_id: 101 });
  });

  it('权限类错码应返回 permission_denied', async () => {
    for (const code of [40279, 40248, 43004, 50005]) {
      wechat._resetTokenCache();
      const m = makeMockFetcher([
        { json: { access_token: 'tk', expires_in: 7200 } },
        { json: { errcode: code, errmsg: 'permission' } }
      ]);
      const r = await wechat.publishVideoMessage(
        { appId: 'wx', appSecret: 'sec' },
        { mediaId: 'mv' },
        m.fetcher
      );
      expect(r.status).toBe('permission_denied');
      expect(r.ok).toBe(false);
    }
  });

  it('note 不应包含 access_token 真实值', async () => {
    const m = makeMockFetcher([
      { json: { access_token: 'TK-PUB-VID-LEAK', expires_in: 7200 } },
      { json: { errcode: 45011, errmsg: 'freq limit' } }
    ]);
    const r = await wechat.publishVideoMessage(
      { appId: 'wx', appSecret: 'sec' },
      { mediaId: 'mv' },
      m.fetcher
    );
    expect(r.note).not.toContain('TK-PUB-VID-LEAK');
  });
});

describe('wechat 视频模块导出', () => {
  it('wechat 模块应导出 uploadVideoMaterial / publishVideoMessage', () => {
    expect(typeof wechat.uploadVideoMaterial).toBe('function');
    expect(typeof wechat.publishVideoMessage).toBe('function');
  });
});