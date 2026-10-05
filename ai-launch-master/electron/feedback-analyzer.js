// Rokit · 反馈分析层（v1.5 MVP）
// 输入：store.listFeedback(workId) 拿到的原始反馈列表（已通过 feedback-collector 增量采集）
// 输出：写入 store.saveFeedbackClusters(...) 并回填 feedback 表的 sentiment/category/cluster_id
//
// 设计目标：
//   - 默认本地可跑：纯规则（关键词 + 简单余弦聚类 + 词典情感），不依赖 LLM
//   - 可选升级：若传入 llm.chatComplete，则对聚类结果生成中文摘要
//   - 失败降级：LLM 异常时只输出规则聚类，不抛错
//
// 关注点分离：调用方负责 IO（store.upsertFeedback + collectForWork），本模块只做分析。

'use strict';

// ---------- 词典 ----------
// 极简中文情感词典（积极 / 消极），覆盖用户反馈高频词
const POSITIVE_LEX = [
  '好', '棒', '赞', '喜欢', '推荐', '感谢', '好用', '强大', '稳定', '流畅',
  '不错', '完美', '解决', '终于', '爱', '清晰', '友好', '快', '高效', '贴心',
  'awesome', 'great', 'good', 'love', 'thanks', 'perfect', 'nice', 'fast'
];
const NEGATIVE_LEX = [
  '差', '烂', '卡', '崩', '慢', '报错', '失败', '崩溃', '错误', '无法',
  '不行', '拒绝', '卡顿', 'bug', '故障', '闪退', '丢失', '异常', '白屏', '黑屏',
  '麻烦', '坑', '问题', '糟糕', '难受', '失望',
  'bad', 'broken', 'slow', 'crash', 'fail', 'error', 'issue', 'bug', 'wrong', 'hate'
];

// 类别词典（基于关键词命中数判定）
const CATEGORY_LEX = {
  bug: ['bug', '报错', '失败', '崩溃', '闪退', '异常', 'crash', 'error', 'fail', '无法', '错误', '故障'],
  feature: ['建议', '希望', '能不能', '想要', '应该', 'feature', 'suggest', 'request', 'wish', '希望可以'],
  question: ['怎么', '如何', '为什么', '?', '？', 'how', 'why', 'what', '请问'],
  doc: ['文档', '说明', '教程', 'doc', 'docs', 'tutorial', 'guide', 'readme']
};

// 停用词（中文常用虚词 + 标点）
const STOPWORDS = new Set([
  '的', '了', '和', '是', '就', '都', '而', '及', '与', '或', '一个', '没有',
  '我们', '你们', '他们', '它们', '这个', '那个', '这样', '那样', '可以', '可能',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of',
  'and', 'or', 'but', 'i', 'you', 'we', 'they', 'it', 'this', 'that', 'in', 'on'
]);

// ---------- 工具 ----------
function tokenize(text) {
  if (!text) return [];
  const s = String(text);
  // 中文按单字切分（粗粒度，但足够 MVP），英文按单词切分
  const tokens = [];
  const re = /[\u4e00-\u9fa5]|[a-zA-Z][a-zA-Z0-9_-]+|\d+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const t = m[0];
    if (STOPWORDS.has(t.toLowerCase())) continue;
    if (t.length < 2 && !/[\u4e00-\u9fa5]/.test(t)) continue; // 英文单字母丢弃
    tokens.push(t.toLowerCase());
  }
  return tokens;
}

function scoreLex(text, lex) {
  if (!text) return 0;
  const s = String(text).toLowerCase();
  let n = 0;
  for (const w of lex) {
    if (!w) continue;
    const lw = w.toLowerCase();
    let idx = 0;
    while ((idx = s.indexOf(lw, idx)) >= 0) {
      n++;
      idx += lw.length;
    }
  }
  return n;
}

function classify(text) {
  if (!text) return 'discussion';
  let best = 'discussion';
  let bestN = 0;
  for (const cat of Object.keys(CATEGORY_LEX)) {
    const n = scoreLex(text, CATEGORY_LEX[cat]);
    if (n > bestN) { bestN = n; best = cat; }
  }
  return best;
}

function sentimentOf(text) {
  const pos = scoreLex(text, POSITIVE_LEX);
  const neg = scoreLex(text, NEGATIVE_LEX);
  if (pos === 0 && neg === 0) return 'neutral';
  // 阈值：neg 明显大于 pos 视为 negative；反之 positive；相等取 negative（保守）
  if (neg > pos) return 'negative';
  if (pos > neg && pos - neg >= 1) return 'positive';
  return 'neutral';
}

// 简单 TF：统计每条反馈的 token 频次
function tfOf(tokens) {
  const tf = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

// 用 Jaccard 距离做单链接聚类（最朴素的实现）
function jaccard(a, b) {
  let inter = 0; let uni = 0;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k] || 0;
    const bv = b[k] || 0;
    if (av > 0 && bv > 0) inter++;
    if (av > 0 || bv > 0) uni++;
  }
  return uni === 0 ? 0 : (inter / uni);
}

function clusterItems(items, threshold) {
  threshold = typeof threshold === 'number' ? threshold : 0.18; // Jaccard 距离阈值
  const clusters = []; // [{ items:[], tf:{}, keywords:[] }]
  for (const it of items) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < clusters.length; i++) {
      const sc = jaccard(it.tf, clusters[i].tf);
      if (sc > bestScore) { bestScore = sc; bestIdx = i; }
    }
    if (bestScore >= threshold && bestIdx >= 0) {
      clusters[bestIdx].items.push(it);
      for (const k of Object.keys(it.tf)) {
        clusters[bestIdx].tf[k] = (clusters[bestIdx].tf[k] || 0) + it.tf[k];
      }
    } else {
      clusters.push({ items: [it], tf: Object.assign({}, it.tf) });
    }
  }
  // 提取 top 关键词
  for (const c of clusters) {
    const entries = Object.entries(c.tf).sort(function (a, b) { return b[1] - a[1]; });
    c.keywords = entries.slice(0, 5).map(function (e) { return e[0]; });
  }
  return clusters;
}

// 优先级判定：negative + bug 类反馈自动升级
function priorityOf(items) {
  let neg = 0;
  for (const it of items) {
    if (it.sentiment === 'negative') neg++;
  }
  const ratio = items.length ? (neg / items.length) : 0;
  if (items.length >= 3 && ratio >= 0.6) return 'P0';
  if (items.length >= 2 && ratio >= 0.4) return 'P1';
  return 'P2';
}

// ---------- 核心 ----------
// 分析单个 work 的反馈：写入聚类结果，并回填每条 feedback 的 sentiment/category/cluster_id
//   store:  store 实例（具备 listFeedback/saveFeedbackClusters 方法）
//   workId: string
//   opts:
//     llm?:  function({messages}) => Promise<string>  // 可选 LLM 摘要
//     clusterThreshold?: number  // 默认 0.18
//     maxItems?: number  // 默认 100，防止 LLM 摘要过长
// 返回 { clusters: [], updated: number }
async function analyzeForWork(store, workId, opts) {
  opts = opts || {};
  const all = (store && typeof store.listFeedback === 'function') ? store.listFeedback(workId) : [];
  if (!Array.isArray(all) || !all.length) {
    return { clusters: [], updated: 0 };
  }
  const maxItems = typeof opts.maxItems === 'number' ? opts.maxItems : 100;
  const items = all.slice(0, maxItems);

  // 1) 单条反馈：情感 + 类别 + token
  for (const it of items) {
    it.sentiment = sentimentOf(it.content || '');
    it.category = classify(it.content || '');
    it.tokens = tokenize((it.title || '') + ' ' + (it.content || ''));
    it.tf = tfOf(it.tokens);
    delete it.tokens;
  }

  // 2) 聚类
  const clusters = clusterItems(items, opts.clusterThreshold);

  // 3) 优先级 + cluster_id 回填
  const out = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const cid = 'cl_' + (workId || '') + '_' + i + '_' + Date.now().toString(36);
    const sampleIds = c.items.slice(0, 3).map(function (it) { return it.id || ''; });
    const pri = priorityOf(c.items);
    for (const it of c.items) it.cluster_id = cid;
    out.push({
      id: cid,
      work_id: workId || '',
      title: c.keywords.length ? c.keywords.slice(0, 5).join(' / ') : '其他讨论',
      count: c.items.length,
      priority: pri,
      sample_ids: sampleIds,
      summary: '', // LLM 摘要后续回填
      created_at: new Date().toISOString(),
      _keywords: c.keywords,
      _category: majorityCategory(c.items)
    });
  }

  // 4) LLM 摘要（可选）
  if (typeof opts.llm === 'function' && out.length) {
    for (const c of out) {
      try {
        const text = buildSummaryPrompt(c);
        const resp = await opts.llm({ messages: [
          { role: 'system', content: '你是一名产品经理，擅长从用户反馈中提炼共性与痛点。中文输出，不超过 80 字。' },
          { role: 'user', content: text }
        ], temperature: 0.4, max_tokens: 200 });
        c.summary = String(resp || '').trim().slice(0, 200);
      } catch (_e) {
        // LLM 失败不抛
      }
    }
  }

  // 5) 回写聚类 + 回填 feedback
  if (store && typeof store.saveFeedbackClusters === 'function') {
    store.saveFeedbackClusters(out.map(function (c) {
      return {
        id: c.id, work_id: c.work_id, title: c.title, count: c.count,
        priority: c.priority, sample_ids: c.sample_ids, summary: c.summary,
        created_at: c.created_at
      };
    }));
  }

  let updated = 0;
  if (store && typeof store.upsertFeedback === 'function') {
    // 复用 upsertFeedback：覆盖 sentiment/category/cluster_id
    updated = store.upsertFeedback(items.map(function (it) {
      return {
        id: it.id, work_id: it.work_id, source: it.source, external_id: it.external_id,
        author: it.author, url: it.url, content: it.content,
        sentiment: it.sentiment, category: it.category, priority: it.priority,
        cluster_id: it.cluster_id, fetched_at: it.fetched_at
      };
    }));
  }

  return { clusters: out, updated: updated };
}

function majorityCategory(items) {
  const counts = Object.create(null);
  for (const it of items) counts[it.category || 'discussion'] = (counts[it.category || 'discussion'] || 0) + 1;
  let best = 'discussion'; let bestN = 0;
  for (const k of Object.keys(counts)) {
    if (counts[k] > bestN) { bestN = counts[k]; best = k; }
  }
  return best;
}

function buildSummaryPrompt(c) {
  const lines = ['主题：' + c.title, '类别：' + (c._category || ''), '条数：' + c.count, '关键词：' + (c._keywords || []).join(', '), ''];
  lines.push('样例反馈：');
  for (const sid of (c.sample_ids || []).slice(0, 3)) {
    const it = c.items && c.items.find(function (x) { return x.id === sid; });
    if (it) lines.push('- ' + (it.title || it.content || '').slice(0, 120));
  }
  lines.push('', '请用一句中文总结这个聚类的核心问题或诉求。');
  return lines.join('\n');
}

// 给 renderer / IPC 暴露轻量摘要：返回 { total, sentimentCounts, topClusters }
function summarizeForIpc(store, workId) {
  const fbs = (store && typeof store.listFeedback === 'function') ? store.listFeedback(workId) : [];
  const cls = (store && typeof store.listFeedbackClusters === 'function') ? store.listFeedbackClusters(workId) : [];
  const sent = { positive: 0, neutral: 0, negative: 0 };
  for (const f of fbs) {
    const k = f.sentiment || 'neutral';
    if (sent[k] != null) sent[k]++;
  }
  return {
    total: fbs.length,
    sentimentCounts: sent,
    topClusters: cls.slice(0, 5).map(function (c) {
      return { id: c.id, title: c.title, count: c.count, priority: c.priority, summary: c.summary };
    })
  };
}

module.exports = {
  // 词典 / 工具
  tokenize,
  scoreLex,
  classify,
  sentimentOf,
  clusterItems,
  priorityOf,
  jaccard,
  // 主入口
  analyzeForWork,
  summarizeForIpc,
  // 词典（供测试用）
  POSITIVE_LEX,
  NEGATIVE_LEX,
  CATEGORY_LEX
};
