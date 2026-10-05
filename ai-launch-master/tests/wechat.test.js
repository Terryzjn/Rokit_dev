const { createDraft, bodyToHtml } = require('../electron/wechat');

function jsonResponse(data, options) {
  return Object.assign({ ok: true, status: 200, json: async function () { return data; } }, options || {});
}

describe('wechat · 草稿 API', () => {
  it('先取 access_token，再创建带封面素材的图文草稿', async () => {
    const requests = [];
    const fetcher = async function (url, options) {
      requests.push({ url: url, options: options });
      return requests.length === 1
        ? jsonResponse({ access_token: 'token-value' })
        : jsonResponse({ media_id: 'draft-id' });
    };

    const result = await createDraft(
      { appId: 'app-id', appSecret: 'app-secret', thumbMediaId: 'cover-id' },
      { title: '标题', intro: '摘要', body: '第一行\n第二行', link: 'https://example.com/work' },
      fetcher
    );

    expect(result).toEqual({ status: 'draft_created', mediaId: 'draft-id' });
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain('/token?');
    expect(requests[1].url).toContain('/draft/add?access_token=token-value');
    const body = JSON.parse(requests[1].options.body);
    expect(body.articles[0]).toMatchObject({
      title: '标题',
      digest: '摘要',
      content: '<p>第一行</p><p>第二行</p>',
      content_source_url: 'https://example.com/work',
      thumb_media_id: 'cover-id'
    });
  });

  it('缺少 AppID、AppSecret 或封面素材时不发请求', async () => {
    const fetcher = vi.fn();
    const result = await createDraft({ appId: 'app-id' }, { title: '标题', body: '正文' }, fetcher);
    expect(result.status).toBe('config_required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('微信接口返回错误码时报告错误且不创建成功状态', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ errcode: 40125, errmsg: 'invalid appsecret' }));
    const result = await createDraft(
      { appId: 'app-id', appSecret: 'bad-secret', thumbMediaId: 'cover-id' },
      { title: '标题', body: '正文' },
      fetcher
    );
    expect(result.status).toBe('api_error');
    expect(result.note).toContain('40125');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('微信未返回 media_id 时不能报告草稿创建成功', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-value' }))
      .mockResolvedValueOnce(jsonResponse({}));
    const result = await createDraft(
      { appId: 'app-id', appSecret: 'app-secret', thumbMediaId: 'cover-id' },
      { title: '标题', body: '正文' },
      fetcher
    );
    expect(result.status).toBe('api_error');
    expect(result.note).toContain('media_id');
  });

  it('文章内容按纯文本转义为安全 HTML', () => {
    expect(bodyToHtml('<script>x</script>\nA & B')).toBe(
      '<p>&lt;script&gt;x&lt;/script&gt;</p><p>A &amp; B</p>'
    );
  });
});