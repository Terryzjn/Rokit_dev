'use strict';

const API_ROOT = 'https://api.weixin.qq.com/cgi-bin';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bodyToHtml(value) {
  return String(value || '').split(/\r?\n/)
    .map(function (line) { return '<p>' + (line ? escapeHtml(line) : '<br>') + '</p>'; })
    .join('');
}

async function requestJson(fetcher, url, options) {
  const response = await fetcher(url, options);
  let data;
  try { data = await response.json(); }
  catch (_e) { throw new Error('微信接口返回了无法识别的数据'); }
  if (!response.ok) throw new Error('微信接口 HTTP ' + response.status);
  if (data && Number(data.errcode)) {
    throw new Error('微信接口错误 ' + data.errcode + '：' + (data.errmsg || '未知错误'));
  }
  return data || {};
}

async function createDraft(credentials, payload, fetcher) {
  const config = credentials || {};
  const article = payload || {};
  if (!config.appId || !config.appSecret || !config.thumbMediaId) {
    return { status: 'config_required', note: '请在设置中配置公众号 AppID、AppSecret 和封面素材 ID' };
  }
  if (!String(article.title || '').trim() || !String(article.body || '').trim()) {
    return { status: 'api_error', note: '草稿标题和正文不能为空' };
  }
  if (String(article.title).trim().length > 64) {
    return { status: 'api_error', note: '公众号标题不能超过 64 个字符' };
  }
  if (typeof fetcher !== 'function') {
    return { status: 'api_error', note: '公众号接口请求不可用' };
  }

  try {
    const tokenUrl = API_ROOT + '/token?' + new URLSearchParams({
      grant_type: 'client_credential',
      appid: config.appId,
      secret: config.appSecret
    }).toString();
    const token = await requestJson(fetcher, tokenUrl, { method: 'GET' });
    if (!token.access_token) throw new Error('微信未返回 access_token');

    const sourceUrl = /^https?:\/\//i.test(String(article.link || '').trim())
      ? String(article.link).trim()
      : '';
    const draft = await requestJson(
      fetcher,
      API_ROOT + '/draft/add?access_token=' + encodeURIComponent(token.access_token),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          articles: [{
            title: String(article.title).trim(),
            author: '',
            digest: String(article.intro || article.body).trim().slice(0, 120),
            content: bodyToHtml(article.body),
            content_source_url: sourceUrl,
            thumb_media_id: config.thumbMediaId,
            need_open_comment: 0,
            only_fans_can_comment: 0
          }]
        })
      }
    );
    if (!draft.media_id) throw new Error('微信接口未返回草稿 media_id');
    return { status: 'draft_created', mediaId: draft.media_id || '' };
  } catch (error) {
    return { status: 'api_error', note: String((error && error.message) || error) };
  }
}

module.exports = { createDraft, bodyToHtml };