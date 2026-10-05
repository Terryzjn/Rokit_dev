// Rokit · 反馈采集层（v1.5 MVP）
// 数据源：GitHub Issues（公开仓库免 Token）+ V2EX 主题评论（公开 RSS）
//
// 设计约束：
//   - 不引入重型依赖（cheerio / octokit），用浏览器原生 fetch + 正则解析（最小可行）
//   - 增量去重依赖 store.upsertFeedback 的 UNIQUE(source, external_id)
//   - 失败降级：单源失败不影响其它源；超时 / 解析异常 → 返回 0

'use strict';

const HC_TIMEOUT_MS = 8000;

function fetchWithTimeout(url, opt, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms || HC_TIMEOUT_MS);
  return fetch(url, Object.assign({ signal: ctrl.signal }, opt || {}))
    .finally(function () { clearTimeout(t); });
}

// 从 work 推导 GitHub owner/repo（如 url 是 GitHub 链接）
function ghRepoFromWork(work) {
  if (!work || !work.url) return null;
  const m = /^https?:\/\/(www\.)?github\.com\/([^/?#]+\/[^/?#]+)/i.exec(String(work.url));
  if (!m) return null;
  return m[2].replace(/\.git$/i, '');
}

// 从 work 推导 V2EX 主题帖 id（url 形如 https://www.v2ex.com/t/123456）
function v2exTopicId(work) {
  if (!work || !work.url) return null;
  const m = /v2ex\.com\/t\/(\d+)/i.exec(String(work.url));
  return m ? m[1] : null;
}

// HTML 实体反转义（最小集：&amp; &lt; &gt; &quot; &#39; &nbsp; &#NNN;）
function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function (_, n) { try { return String.fromCharCode(+n); } catch (_e) { return ''; } });
}

// 简易 HTML 标签剥离 + 实体反转义（用于把 issue body 之类转成纯文本摘要）
function stripHtml(html) {
  if (!html) return '';
  // 先解实体再剥标签；这样 <a>&amp;</a> → <a>&</a> → &，避免双重解码
  let s = decodeHtml(String(html));
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

}

// 极简 RSS 解析（够用即可：只取 <item><title>...</title><description>...</description></item>）
function parseRss(xml) {
  if (!xml || typeof xml !== 'string') return [];
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    const t = /<title>([\s\S]*?)<\/title>/i.exec(body);
    const d = /<description>([\s\S]*?)<\/description>/i.exec(body);
    const l = /<link>([\s\S]*?)<\/link>/i.exec(body);
    const a = /<author>([\s\S]*?)<\/author>/i.exec(body);
    items.push({
      title: t ? decodeHtml(t[1]).trim() : '',
      description: d ? stripHtml(d[1]) : '',
      link: l ? l[1].trim() : '',
      author: a ? decodeHtml(a[1]).trim() : ''
    });
  }
  return items;
}

// 抓取 GitHub Issues（公开仓库免 Token；私有仓库可后续传 PAT）
async function collectGithubIssues(work, opts) {
  opts = opts || {};
  const repo = ghRepoFromWork(work);
  if (!repo) return { items: [], note: 'work.url 不是 GitHub 仓库链接' };
  const url = 'https://api.github.com/repos/' + encodeURIComponent(repo) + '/issues?state=open&per_page=30&sort=updated';
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Rokit-Feedback/1.5'
      }
    }, opts.timeout || HC_TIMEOUT_MS);
  } catch (e) {
    return { items: [], note: 'github-network:' + String((e && e.message) || e) };
  }
  if (!res.ok) {
    return { items: [], note: 'github-http-' + res.status };
  }
  let arr;
  try { arr = await res.json(); } catch (_e) {
    return { items: [], note: 'github-json-parse' };
  }
  if (!Array.isArray(arr)) return { items: [], note: 'github-not-array' };
  const items = arr
    .filter(function (it) { return it && !it.pull_request; }) // 排除 PR
    .map(function (it) {
      return {
        source: 'github',
        external_id: String(it.id),
        author: it.user && it.user.login ? it.user.login : '',
        url: it.html_url || '',
        title: it.title || '',
        content: stripHtml((it.body || '') + (it.title ? ('\n\n# ' + it.title) : '')).slice(0, 4000),
        fetched_at: new Date().toISOString()
      };
    });
  return { items: items };
}

// 抓取 V2EX 主题帖评论（RSS 公开，无需鉴权）
async function collectV2exThread(work, opts) {
  opts = opts || {};
  const tid = v2exTopicId(work);
  if (!tid) return { items: [], note: 'work.url 不是 v2ex 主题链接' };
  const url = 'https://www.v2ex.com/feed/topic/' + tid + '.xml';
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Rokit-Feedback/1.5' }
    }, opts.timeout || HC_TIMEOUT_MS);
  } catch (e) {
    return { items: [], note: 'v2ex-network:' + String((e && e.message) || e) };
  }
  if (!res.ok) return { items: [], note: 'v2ex-http-' + res.status };
  let xml;
  try { xml = await res.text(); } catch (_e) {
    return { items: [], note: 'v2ex-text-parse' };
  }
  const parsed = parseRss(xml);
  const items = parsed.map(function (p) {
    return {
      source: 'v2ex',
      external_id: String(p.link || (p.title + '|' + p.author)),
      author: p.author || '',
      url: p.link || '',
      title: p.title || '',
      content: (p.description || '').slice(0, 4000),
      fetched_at: new Date().toISOString()
    };
  });
  return { items: items };
}

// 一站式：为指定 work 拉取所有支持的源，汇总去重后返回
//   work: { id, url, ... }
// 返回 { items:[], notes:{ github?, v2ex? } }
async function collectForWork(work, opts) {
  opts = opts || {};
  const tasks = [];
  const includeGithub = opts.includeGithub !== false;
  const includeV2ex = opts.includeV2ex !== false;
  if (includeGithub) tasks.push(collectGithubIssues(work, opts).then(function (r) { return ['github', r]; }));
  if (includeV2ex) tasks.push(collectV2exThread(work, opts).then(function (r) { return ['v2ex', r]; }));
  const arr = await Promise.all(tasks);
  const items = [];
  const notes = {};
  for (const pair of arr) {
    const src = pair[0];
    const r = pair[1] || { items: [], note: 'empty' };
    if (r.note) notes[src] = r.note;
    for (const it of (r.items || [])) {
      items.push(Object.assign({ work_id: work && work.id || '' }, it));
    }
  }
  return { items: items, notes: notes };
}

module.exports = {
  ghRepoFromWork,
  v2exTopicId,
  decodeHtml,
  stripHtml,
  parseRss,
  collectGithubIssues,
  collectV2exThread,
  collectForWork
};