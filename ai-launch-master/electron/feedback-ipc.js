// Rokit · 反馈 IPC 注册
// 从 main.js 抽出的 feedback:* 五个通道；store / collector / analyzer / LLM
// 均由调用方注入，不直接依赖 Electron 或数据库，便于行为测试。
'use strict';

function registerFeedbackIpc(ipcMain, deps) {
  deps = deps || {};
  const getStore = deps.getStore;
  const collector = deps.collector;
  const analyzer = deps.analyzer;
  const chatComplete = deps.chatComplete;

  ipcMain.handle('feedback:collect', async (_e, payload) => {
    if (!payload || !payload.work) return { ok: false, error: 'no-work' };
    try {
      const r = await collector.collectForWork(payload.work, payload.opts || {});
      const store = getStore();
      if (r.items && r.items.length && store && typeof store.upsertFeedback === 'function') {
        const n = store.upsertFeedback(r.items);
        return { ok: true, inserted: n, notes: r.notes || {} };
      }
      return { ok: true, inserted: 0, notes: r.notes || {} };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('feedback:analyze', async (_e, payload) => {
    if (!payload || !payload.workId) return { ok: false, error: 'no-work-id' };
    try {
      const store = getStore();
      const r = await analyzer.analyzeForWork(store, payload.workId, {
        llm: function (req) { return chatComplete(getStore().getSettings(), req); },
        maxItems: payload.maxItems || 100,
        clusterThreshold: payload.clusterThreshold
      });
      return { ok: true, clusters: r.clusters.length, updated: r.updated };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('feedback:list', (_e, payload) => {
    const store = getStore();
    if (!store || typeof store.listFeedback !== 'function') return [];
    return store.listFeedback(payload && payload.workId);
  });

  ipcMain.handle('feedback:list-clusters', (_e, payload) => {
    const store = getStore();
    if (!store || typeof store.listFeedbackClusters !== 'function') return [];
    return store.listFeedbackClusters(payload && payload.workId);
  });

  ipcMain.handle('feedback:summarize', (_e, payload) => {
    return analyzer.summarizeForIpc(getStore(), payload && payload.workId);
  });
}

module.exports = { registerFeedbackIpc };
