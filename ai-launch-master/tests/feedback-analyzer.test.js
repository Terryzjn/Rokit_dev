// Rokit · feedback-analyzer 反馈分析层单元测试（v1.5）
// 目标：纯函数 tokenize / classify / sentimentOf / clusterItems / priorityOf / jaccard
//       + analyzeForWork 主流程（mock store）

const fa = require('../electron/feedback-analyzer');

describe('feedback-analyzer · tokenize', () => {
  it('空输入应返回空数组', () => {
    expect(fa.tokenize('')).toEqual([]);
    expect(fa.tokenize(null)).toEqual([]);
  });

  it('中文按字切分（保留单字），英文按词切分', () => {
    const toks = fa.tokenize('这是一个 great tool');
    expect(toks).toContain('great');
    expect(toks).toContain('tool');
  });

  it('停用词应被剔除', () => {
    const toks = fa.tokenize('the app is good');
    expect(toks).not.toContain('the');
    expect(toks).not.toContain('is');
    expect(toks).toContain('good');
  });

  it('英文单字母应被丢弃', () => {
    const toks = fa.tokenize('a b c test');
    expect(toks).not.toContain('a');
    expect(toks).toContain('test');
  });

  it('数字应被保留', () => {
    const toks = fa.tokenize('v2.0 升级了');
    expect(toks.some(t => /\d/.test(t))).toBe(true);
  });
});

describe('feedback-analyzer · classify', () => {
  it('空文本应默认为 discussion', () => {
    expect(fa.classify('')).toBe('discussion');
  });

  it('关键词 bug / 报错应分类为 bug', () => {
    expect(fa.classify('程序崩溃闪退报错')).toBe('bug');
    expect(fa.classify('app crash error')).toBe('bug');
  });

  it('关键词 建议 / feature 应分类为 feature', () => {
    expect(fa.classify('希望可以添加 dark mode，建议改进')).toBe('feature');
  });

  it('疑问句应分类为 question', () => {
    expect(fa.classify('怎么用？为什么不行？')).toBe('question');
  });

  it('doc 关键词应分类为 doc', () => {
    expect(fa.classify('文档教程不完整')).toBe('doc');
  });
});

describe('feedback-analyzer · sentimentOf', () => {
  it('空文本应为 neutral', () => {
    expect(fa.sentimentOf('')).toBe('neutral');
  });

  it('积极词应判为 positive', () => {
    expect(fa.sentimentOf('超棒，很好用，感谢分享')).toBe('positive');
  });

  it('消极词应判为 negative', () => {
    expect(fa.sentimentOf('经常崩溃报错，无法使用')).toBe('negative');
  });

  it('中性的描述应判为 neutral', () => {
    expect(fa.sentimentOf('我今天下载了这个程序')).toBe('neutral');
  });
});

describe('feedback-analyzer · jaccard', () => {
  it('完全一致应返回 1', () => {
    expect(fa.jaccard({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(1);
  });

  it('完全无关应返回 0', () => {
    expect(fa.jaccard({ a: 1 }, { b: 1 })).toBe(0);
  });

  it('部分重叠应返回比例', () => {
    const s = fa.jaccard({ a: 1, b: 1 }, { a: 1, c: 1 });
    expect(s).toBeCloseTo(1 / 3, 2);
  });
});

describe('feedback-analyzer · clusterItems', () => {
  it('空数组应返回空聚类', () => {
    expect(fa.clusterItems([])).toEqual([]);
  });

  it('单条反馈应形成单聚类', () => {
    const items = [{ id: 'f1', tf: { bug: 1 } }];
    const cs = fa.clusterItems(items);
    expect(cs).toHaveLength(1);
    expect(cs[0].items).toHaveLength(1);
  });

  it('相似 TF 的反馈应合并到同聚类', () => {
    const items = [
      { id: 'f1', tf: { bug: 2, crash: 1 } },
      { id: 'f2', tf: { bug: 1, crash: 1 } },
      { id: 'f3', tf: { love: 2, good: 1 } }
    ];
    const cs = fa.clusterItems(items, 0.18);
    expect(cs).toHaveLength(2); // f1+f2 一类，f3 单独
    const bugCluster = cs.find(c => c.items.some(it => it.id === 'f1'));
    expect(bugCluster.items.some(it => it.id === 'f2')).toBe(true);
  });

  it('聚类应自动提取 top 5 关键词', () => {
    const items = [
      { id: 'f1', tf: { bug: 5, crash: 3, fail: 2, error: 1 } }
    ];
    const cs = fa.clusterItems(items);
    expect(cs[0].keywords).toContain('bug');
    expect(cs[0].keywords[0]).toBe('bug'); // 频次最高
  });
});

describe('feedback-analyzer · priorityOf', () => {
  it('空数组应返回 P2', () => {
    expect(fa.priorityOf([])).toBe('P2');
  });

  it('3 条以上且 60% 负向 → P0', () => {
    const items = [
      { sentiment: 'negative' }, { sentiment: 'negative' },
      { sentiment: 'negative' }, { sentiment: 'positive' },
      { sentiment: 'positive' }
    ];
    expect(fa.priorityOf(items)).toBe('P0');
  });

  it('2 条以上且 40% 负向 → P1', () => {
    const items = [
      { sentiment: 'negative' }, { sentiment: 'negative' },
      { sentiment: 'positive' }, { sentiment: 'positive' }, { sentiment: 'positive' }
    ];
    expect(fa.priorityOf(items)).toBe('P1');
  });

  it('少量反馈 → P2', () => {
    const items = [{ sentiment: 'negative' }];
    expect(fa.priorityOf(items)).toBe('P2');
  });
});

describe('feedback-analyzer · analyzeForWork', () => {
  it('空 feedback 应返回 {clusters:[], updated:0}', async () => {
    const fakeStore = { listFeedback: () => [] };
    const r = await fa.analyzeForWork(fakeStore, 'w1');
    expect(r.clusters).toEqual([]);
    expect(r.updated).toBe(0);
  });

  it('应自动聚类 + 回填 cluster_id', async () => {
    const items = [
      { id: 'f1', work_id: 'w1', source: 'github', external_id: '1', title: 'A', content: 'bug crash crash', author: 'u1', url: '', fetched_at: 't' },
      { id: 'f2', work_id: 'w1', source: 'github', external_id: '2', title: 'B', content: 'bug error fail', author: 'u2', url: '', fetched_at: 't' },
      { id: 'f3', work_id: 'w1', source: 'github', external_id: '3', title: 'C', content: 'love it good', author: 'u3', url: '', fetched_at: 't' }
    ];
    let savedClusters = null;
    let upserted = [];
    const fakeStore = {
      listFeedback: () => items,
      saveFeedbackClusters: (cs) => { savedClusters = cs; },
      upsertFeedback: (arr) => { upserted = upserted.concat(arr); return arr.length; }
    };
    const r = await fa.analyzeForWork(fakeStore, 'w1');
    expect(r.clusters.length).toBeGreaterThan(0);
    expect(savedClusters.length).toBeGreaterThan(0);
    // 每条 feedback 都应带 cluster_id
    expect(upserted.every(it => typeof it.cluster_id === 'string' && it.cluster_id.length > 0)).toBe(true);
  });

  it('LLM 异常不应阻断聚类主流程', async () => {
    const items = [
      { id: 'f1', work_id: 'w1', source: 'github', external_id: '1', title: 'A', content: 'bug crash', author: 'u1', url: '', fetched_at: 't' }
    ];
    const fakeStore = {
      listFeedback: () => items,
      saveFeedbackClusters: () => {},
      upsertFeedback: () => 1
    };
    const r = await fa.analyzeForWork(fakeStore, 'w1', {
      llm: async function () { throw new Error('llm-down'); }
    });
    expect(r.clusters.length).toBeGreaterThan(0);
  });

  it('LLM 正常时应回填 cluster.summary', async () => {
    const items = [
      { id: 'f1', work_id: 'w1', source: 'github', external_id: '1', title: 'A', content: 'bug crash', author: 'u1', url: '', fetched_at: 't' },
      { id: 'f2', work_id: 'w1', source: 'github', external_id: '2', title: 'B', content: 'bug fail', author: 'u2', url: '', fetched_at: 't' }
    ];
    let savedClusters = null;
    const fakeStore = {
      listFeedback: () => items,
      saveFeedbackClusters: (cs) => { savedClusters = cs; },
      upsertFeedback: () => 2
    };
    await fa.analyzeForWork(fakeStore, 'w1', {
      llm: async function () { return '用户反馈核心是稳定性问题'; }
    });
    expect(savedClusters[0].summary).toContain('稳定性');
  });
});