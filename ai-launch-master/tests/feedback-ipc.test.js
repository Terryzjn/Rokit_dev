'use strict';

// feedback-ipc 行为测试：fake ipcMain + mock 依赖。
// 不启动 Electron，不访问真实数据库，不调用真实外部 LLM。

const { registerFeedbackIpc } = require('../electron/feedback-ipc');

const CHANNELS = [
  'feedback:collect',
  'feedback:analyze',
  'feedback:list',
  'feedback:list-clusters',
  'feedback:summarize'
];

function createHarness(overrides) {
  overrides = overrides || {};
  const handlers = new Map();
  const ipcMain = {
    handle: vi.fn(function (channel, fn) {
      handlers.set(channel, fn);
    })
  };
  const storeRef = { current: null };
  const getStore = vi.fn(function () { return storeRef.current; });
  const collector = overrides.collector || {
    collectForWork: vi.fn()
  };
  const analyzer = overrides.analyzer || {
    analyzeForWork: vi.fn(),
    summarizeForIpc: vi.fn()
  };
  const chatComplete = overrides.chatComplete || vi.fn();

  registerFeedbackIpc(ipcMain, {
    getStore: getStore,
    collector: collector,
    analyzer: analyzer,
    chatComplete: chatComplete
  });

  return {
    handlers: handlers,
    ipcMain: ipcMain,
    storeRef: storeRef,
    getStore: getStore,
    collector: collector,
    analyzer: analyzer,
    chatComplete: chatComplete
  };
}

function handlerOf(handlers, channel) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error('missing handler: ' + channel);
  return fn;
}

describe('feedback-ipc · 注册契约', () => {
  it('只注册五个 feedback 通道，且没有重复', () => {
    const { handlers, ipcMain } = createHarness();

    expect(ipcMain.handle).toHaveBeenCalledTimes(5);
    expect(handlers.size).toBe(5);
    expect(Array.from(handlers.keys()).sort()).toEqual(CHANNELS.slice().sort());
  });
});

describe('feedback-ipc · lazy store', () => {
  it('注册时不读取 store，调用时读取最新值', () => {
    const { handlers, storeRef, getStore } = createHarness();
    const list = handlerOf(handlers, 'feedback:list');

    expect(getStore).not.toHaveBeenCalled();
    expect(list({}, { workId: 'w1' })).toEqual([]);
    expect(getStore).toHaveBeenCalledTimes(1);

    const store = {
      listFeedback: vi.fn(function () { return [{ id: 'f1' }]; })
    };
    storeRef.current = store;

    expect(list({}, { workId: 'w1' })).toEqual([{ id: 'f1' }]);
    expect(store.listFeedback).toHaveBeenCalledWith('w1');
  });

  it('collect 在 collector 完成之后读取当前 store', async () => {
    let resolveCollect;
    const collector = {
      collectForWork: vi.fn(function () {
        return new Promise(function (resolve) { resolveCollect = resolve; });
      })
    };
    const { handlers, storeRef } = createHarness({ collector: collector });
    const collect = handlerOf(handlers, 'feedback:collect');

    const pending = collect({}, { work: { id: 'w1' } });
    expect(storeRef.current).toBe(null);

    const store = {
      upsertFeedback: vi.fn(function () { return 2; })
    };
    storeRef.current = store;
    resolveCollect({ items: [{ id: 'f1' }], notes: { github: 'ok' } });

    await expect(pending).resolves.toEqual({
      ok: true,
      inserted: 2,
      notes: { github: 'ok' }
    });
    expect(store.upsertFeedback).toHaveBeenCalledWith([{ id: 'f1' }]);
  });
});

describe('feedback-ipc · feedback:collect', () => {
  it('缺少 payload / work 时返回 no-work，且不调用 collector', async () => {
    const { handlers, collector } = createHarness();
    const collect = handlerOf(handlers, 'feedback:collect');

    await expect(collect({}, undefined)).resolves.toEqual({ ok: false, error: 'no-work' });
    await expect(collect({}, null)).resolves.toEqual({ ok: false, error: 'no-work' });
    await expect(collect({}, {})).resolves.toEqual({ ok: false, error: 'no-work' });
    await expect(collect({}, { work: '' })).resolves.toEqual({ ok: false, error: 'no-work' });
    await expect(collect({}, { work: null })).resolves.toEqual({ ok: false, error: 'no-work' });

    expect(collector.collectForWork).not.toHaveBeenCalled();
  });

  it('成功写入时返回完整的 inserted / notes 结构', async () => {
    const { handlers, storeRef, collector } = createHarness();
    const work = { id: 'w1', url: 'https://github.com/o/r' };
    const opts = { includeV2ex: false };
    const items = [{ id: 'f1' }, { id: 'f2' }];
    const store = {
      upsertFeedback: vi.fn(function () { return 2; })
    };
    storeRef.current = store;
    collector.collectForWork.mockResolvedValue({ items: items, notes: { github: 'ok' } });

    const result = await handlerOf(handlers, 'feedback:collect')({}, { work: work, opts: opts });

    expect(result).toEqual({
      ok: true,
      inserted: 2,
      notes: { github: 'ok' }
    });
    expect(collector.collectForWork).toHaveBeenCalledWith(work, opts);
    expect(store.upsertFeedback).toHaveBeenCalledTimes(1);
    expect(store.upsertFeedback).toHaveBeenCalledWith(items);
  });

  it('未传 opts 时使用空对象', async () => {
    const { handlers, storeRef, collector } = createHarness();
    const work = { id: 'w1' };
    storeRef.current = { upsertFeedback: vi.fn(function () { return 1; }) };
    collector.collectForWork.mockResolvedValue({ items: [{ id: 'f1' }], notes: {} });

    await handlerOf(handlers, 'feedback:collect')({}, { work: work });

    expect(collector.collectForWork).toHaveBeenCalledWith(work, {});
  });

  it('空 items、缺失 items、store 为空或缺少 upsertFeedback 时返回 inserted:0', async () => {
    const { handlers, storeRef, collector } = createHarness();
    const collect = handlerOf(handlers, 'feedback:collect');

    collector.collectForWork.mockResolvedValueOnce({
      items: [],
      notes: { github: 'none' }
    });
    await expect(collect({}, { work: { id: 'w1' } })).resolves.toEqual({
      ok: true,
      inserted: 0,
      notes: { github: 'none' }
    });

    collector.collectForWork.mockResolvedValueOnce({ notes: { v2ex: 'none' } });
    await expect(collect({}, { work: { id: 'w1' } })).resolves.toEqual({
      ok: true,
      inserted: 0,
      notes: { v2ex: 'none' }
    });

    collector.collectForWork.mockResolvedValueOnce({
      items: [{ id: 'f1' }],
      notes: {}
    });
    storeRef.current = {};
    await expect(collect({}, { work: { id: 'w1' } })).resolves.toEqual({
      ok: true,
      inserted: 0,
      notes: {}
    });

    collector.collectForWork.mockResolvedValueOnce({
      items: [{ id: 'f2' }],
      notes: { github: 'late' }
    });
    storeRef.current = null;
    await expect(collect({}, { work: { id: 'w1' } })).resolves.toEqual({
      ok: true,
      inserted: 0,
      notes: { github: 'late' }
    });
  });

  it('collector 抛错时映射为 ok:false', async () => {
    const { handlers, collector } = createHarness();
    collector.collectForWork.mockRejectedValue(new Error('collector-down'));

    await expect(
      handlerOf(handlers, 'feedback:collect')({}, { work: { id: 'w1' } })
    ).resolves.toEqual({ ok: false, error: 'collector-down' });
  });

  it('upsertFeedback 抛错时同样映射为 ok:false', async () => {
    const { handlers, storeRef, collector } = createHarness();
    collector.collectForWork.mockResolvedValue({
      items: [{ id: 'f1' }],
      notes: {}
    });
    storeRef.current = {
      upsertFeedback: vi.fn(function () { throw new Error('write-down'); })
    };

    await expect(
      handlerOf(handlers, 'feedback:collect')({}, { work: { id: 'w1' } })
    ).resolves.toEqual({ ok: false, error: 'write-down' });
  });
});

describe('feedback-ipc · feedback:analyze', () => {
  it('缺少 workId 时返回 no-work-id，且不调用 analyzer', async () => {
    const { handlers, analyzer } = createHarness();
    const analyze = handlerOf(handlers, 'feedback:analyze');

    await expect(analyze({}, undefined)).resolves.toEqual({ ok: false, error: 'no-work-id' });
    await expect(analyze({}, null)).resolves.toEqual({ ok: false, error: 'no-work-id' });
    await expect(analyze({}, {})).resolves.toEqual({ ok: false, error: 'no-work-id' });
    await expect(analyze({}, { workId: '' })).resolves.toEqual({ ok: false, error: 'no-work-id' });
    await expect(analyze({}, { workId: null })).resolves.toEqual({ ok: false, error: 'no-work-id' });

    expect(analyzer.analyzeForWork).not.toHaveBeenCalled();
  });

  it('默认 maxItems=100，并返回 clusters 数量与 updated', async () => {
    const { handlers, storeRef, analyzer, chatComplete } = createHarness();
    const settings = { api_key: 'k1' };
    const store = {
      getSettings: vi.fn(function () { return settings; })
    };
    storeRef.current = store;
    analyzer.analyzeForWork.mockResolvedValue({
      clusters: [{ id: 'c1' }, { id: 'c2' }],
      updated: 6
    });

    const result = await handlerOf(handlers, 'feedback:analyze')({}, { workId: 'w1' });

    expect(result).toEqual({ ok: true, clusters: 2, updated: 6 });
    expect(analyzer.analyzeForWork).toHaveBeenCalledTimes(1);
    const args = analyzer.analyzeForWork.mock.calls[0];
    expect(args[0]).toBe(store);
    expect(args[1]).toBe('w1');
    expect(args[2].maxItems).toBe(100);
    expect(args[2].clusterThreshold).toBeUndefined();
    expect(typeof args[2].llm).toBe('function');

    const req = { messages: [{ role: 'user', content: 'hello' }] };
    chatComplete.mockReturnValue('llm-summary');
    expect(args[2].llm(req)).toBe('llm-summary');
    expect(chatComplete).toHaveBeenCalledWith(settings, req);

    const settings2 = { api_key: 'k2' };
    store.getSettings.mockReturnValue(settings2);
    expect(args[2].llm(req)).toBe('llm-summary');
    expect(chatComplete).toHaveBeenLastCalledWith(settings2, req);
  });

  it('显式 maxItems / clusterThreshold 原样传递；maxItems=0 仍走默认 100', async () => {
    const { handlers, storeRef, analyzer } = createHarness();
    storeRef.current = {
      getSettings: vi.fn(function () { return {}; })
    };
    analyzer.analyzeForWork.mockResolvedValue({ clusters: [], updated: 0 });
    const analyze = handlerOf(handlers, 'feedback:analyze');

    await analyze({}, { workId: 'w1', maxItems: 5, clusterThreshold: 0.42 });
    expect(analyzer.analyzeForWork.mock.calls[0][2].maxItems).toBe(5);
    expect(analyzer.analyzeForWork.mock.calls[0][2].clusterThreshold).toBe(0.42);

    await analyze({}, { workId: 'w1', maxItems: 0, clusterThreshold: 0 });
    expect(analyzer.analyzeForWork.mock.calls[1][2].maxItems).toBe(100);
    expect(analyzer.analyzeForWork.mock.calls[1][2].clusterThreshold).toBe(0);
  });

  it('analyzer 抛错时映射为 ok:false', async () => {
    const { handlers, storeRef, analyzer } = createHarness();
    storeRef.current = { getSettings: vi.fn(function () { return {}; }) };
    analyzer.analyzeForWork.mockRejectedValue(new Error('analyze-down'));

    await expect(
      handlerOf(handlers, 'feedback:analyze')({}, { workId: 'w1' })
    ).resolves.toEqual({ ok: false, error: 'analyze-down' });
  });
});

describe('feedback-ipc · feedback:list / feedback:list-clusters', () => {
  it('list 在 store 为空、方法缺失时返回 []，正常时转发 workId', () => {
    const { handlers, storeRef } = createHarness();
    const list = handlerOf(handlers, 'feedback:list');

    expect(list({}, { workId: 'w1' })).toEqual([]);
    storeRef.current = {};
    expect(list({}, { workId: 'w1' })).toEqual([]);

    const store = {
      listFeedback: vi.fn(function () { return [{ id: 'f1' }]; })
    };
    storeRef.current = store;
    expect(list({}, { workId: 'w1' })).toEqual([{ id: 'f1' }]);
    expect(store.listFeedback).toHaveBeenCalledWith('w1');

    expect(list({}, null)).toEqual([{ id: 'f1' }]);
    expect(store.listFeedback).toHaveBeenLastCalledWith(null);
  });

  it('list-clusters 在 store 为空、方法缺失时返回 []，正常时转发 workId', () => {
    const { handlers, storeRef } = createHarness();
    const listClusters = handlerOf(handlers, 'feedback:list-clusters');

    expect(listClusters({}, { workId: 'w1' })).toEqual([]);
    storeRef.current = {};
    expect(listClusters({}, { workId: 'w1' })).toEqual([]);

    const store = {
      listFeedbackClusters: vi.fn(function () { return [{ id: 'c1' }]; })
    };
    storeRef.current = store;
    expect(listClusters({}, { workId: 'w1' })).toEqual([{ id: 'c1' }]);
    expect(store.listFeedbackClusters).toHaveBeenCalledWith('w1');

    expect(listClusters({}, null)).toEqual([{ id: 'c1' }]);
    expect(store.listFeedbackClusters).toHaveBeenLastCalledWith(null);
  });
});

describe('feedback-ipc · feedback:summarize', () => {
  it('原样传递 store / workId，并返回 analyzer 的结果', () => {
    const { handlers, storeRef, analyzer } = createHarness();
    const store = { marker: 'store-1' };
    storeRef.current = store;
    analyzer.summarizeForIpc.mockReturnValue({ total: 3, topClusters: [] });
    const summarize = handlerOf(handlers, 'feedback:summarize');

    expect(summarize({}, { workId: 'w1' })).toEqual({ total: 3, topClusters: [] });
    expect(analyzer.summarizeForIpc).toHaveBeenCalledWith(store, 'w1');

    summarize({}, null);
    expect(analyzer.summarizeForIpc).toHaveBeenLastCalledWith(store, null);
  });

  it('异常继续向调用方传播，不被吞掉', () => {
    const { handlers, storeRef, analyzer } = createHarness();
    storeRef.current = {};
    analyzer.summarizeForIpc.mockImplementation(function () {
      throw new Error('summarize-down');
    });

    expect(function () {
      handlerOf(handlers, 'feedback:summarize')({}, { workId: 'w1' });
    }).toThrow('summarize-down');
  });
});
