'use strict';

// works-crud-ipc 行为测试：fake ipcMain + mock store。
// 不启动 Electron，不访问真实数据库。
// 断言的是「注册后真实调用 handler 的行为」，而非源码字符串。

const { registerWorksCrudIpc } = require('../electron/works-crud-ipc');

const CHANNELS = ['works:list', 'works:save', 'works:delete'];

function createHarness() {
  const handlers = new Map();
  const registered = [];
  const ipcMain = {
    handle: vi.fn(function (channel, fn) {
      registered.push(channel);
      handlers.set(channel, fn);
    })
  };
  const storeRef = { current: null };
  const getStore = vi.fn(function () { return storeRef.current; });

  registerWorksCrudIpc(ipcMain, { getStore: getStore });

  return {
    handlers: handlers,
    registered: registered,
    ipcMain: ipcMain,
    storeRef: storeRef,
    getStore: getStore
  };
}

function handlerOf(handlers, channel) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error('missing handler: ' + channel);
  return fn;
}

function fakeStore(overrides) {
  overrides = overrides || {};
  return {
    listWorks: overrides.listWorks || vi.fn(function () { return []; }),
    saveWork: overrides.saveWork || vi.fn(function (w) { return w; }),
    deleteWork: overrides.deleteWork || vi.fn(function (id) { return id; })
  };
}

describe('works-crud-ipc · 注册契约', () => {
  it('只注册三个 works 通道，且每个只注册一次', () => {
    const { handlers, registered, ipcMain } = createHarness();

    expect(ipcMain.handle).toHaveBeenCalledTimes(3);
    expect(handlers.size).toBe(3);
    expect(registered).toEqual(CHANNELS);
    expect(registered.filter(function (c) { return c === 'works:list'; })).toHaveLength(1);
    expect(registered.filter(function (c) { return c === 'works:save'; })).toHaveLength(1);
    expect(registered.filter(function (c) { return c === 'works:delete'; })).toHaveLength(1);
  });

  it('注册顺序为 list → save → delete', () => {
    const { registered } = createHarness();

    expect(registered[0]).toBe('works:list');
    expect(registered[1]).toBe('works:save');
    expect(registered[2]).toBe('works:delete');
  });

  it('不注册 settings:* 与 works:refresh-github-stats 等其它频道', () => {
    const { registered } = createHarness();

    expect(registered).not.toContain('settings:get');
    expect(registered).not.toContain('settings:save');
    expect(registered).not.toContain('works:refresh-github-stats');
    registered.forEach(function (c) {
      expect(CHANNELS).toContain(c);
    });
  });
});

describe('works-crud-ipc · lazy store', () => {
  it('注册时不读取 store，调用时读取当前值', () => {
    const { handlers, storeRef, getStore } = createHarness();
    const list = handlerOf(handlers, 'works:list');

    expect(getStore).not.toHaveBeenCalled();

    const store = fakeStore({ listWorks: vi.fn(function () { return [{ id: 'w1' }]; }) });
    storeRef.current = store;

    expect(list({})).toEqual([{ id: 'w1' }]);
    expect(getStore).toHaveBeenCalledTimes(1);
  });

  it('每次 handler 调用都重新读取 store，而不是使用注册时的实例', () => {
    const { handlers, storeRef } = createHarness();
    const list = handlerOf(handlers, 'works:list');

    const storeA = fakeStore({ listWorks: vi.fn(function () { return ['A']; }) });
    storeRef.current = storeA;
    expect(list({})).toEqual(['A']);

    const storeB = fakeStore({ listWorks: vi.fn(function () { return ['B']; }) });
    storeRef.current = storeB;
    expect(list({})).toEqual(['B']);

    expect(storeA.listWorks).toHaveBeenCalledTimes(1);
    expect(storeB.listWorks).toHaveBeenCalledTimes(1);
  });

  it('每次 handler 调用只调用一次 getStore', () => {
    const { handlers, storeRef, getStore } = createHarness();
    const list = handlerOf(handlers, 'works:list');
    const save = handlerOf(handlers, 'works:save');
    const del = handlerOf(handlers, 'works:delete');
    storeRef.current = fakeStore();

    list({});
    expect(getStore).toHaveBeenCalledTimes(1);

    save({}, { id: 'w1' });
    expect(getStore).toHaveBeenCalledTimes(2);

    del({}, 'w1');
    expect(getStore).toHaveBeenCalledTimes(3);
  });
});

describe('works-crud-ipc · works:list', () => {
  it('原样返回 store.listWorks() 的返回值（保持对象身份）', () => {
    const { handlers, storeRef } = createHarness();
    const payload = [{ id: 'w1', name: 'A' }];
    const store = fakeStore({ listWorks: vi.fn(function () { return payload; }) });
    storeRef.current = store;

    const result = handlerOf(handlers, 'works:list')({});

    expect(result).toBe(payload);
    expect(store.listWorks).toHaveBeenCalledTimes(1);
    expect(store.listWorks).toHaveBeenCalledWith();
  });
});

describe('works-crud-ipc · works:save', () => {
  it('把传入对象原样交给 saveWork，并返回原始结果', () => {
    const { handlers, storeRef } = createHarness();
    const work = { id: 'w1', name: '标题', tags: ['a'] };
    const saved = { ok: true, id: 'w1' };
    const store = fakeStore({ saveWork: vi.fn(function (_w) { return saved; }) });
    storeRef.current = store;

    const result = handlerOf(handlers, 'works:save')({}, work);

    expect(store.saveWork).toHaveBeenCalledTimes(1);
    expect(store.saveWork.mock.calls[0][0]).toBe(work);
    expect(result).toBe(saved);
  });

  it('不校验也不改写参数：null / undefined 原样透传', () => {
    const { handlers, storeRef } = createHarness();
    const store = fakeStore();
    storeRef.current = store;
    const save = handlerOf(handlers, 'works:save');

    save({}, null);
    expect(store.saveWork.mock.calls[0][0]).toBe(null);

    save({}, undefined);
    expect(store.saveWork.mock.calls[1][0]).toBe(undefined);

    expect(store.saveWork).toHaveBeenCalledTimes(2);
  });
});

describe('works-crud-ipc · works:delete', () => {
  it('把传入 ID 原样交给 deleteWork，并返回原始结果', () => {
    const { handlers, storeRef } = createHarness();
    const deleted = { deleted: 1 };
    const store = fakeStore({ deleteWork: vi.fn(function (_id) { return deleted; }) });
    storeRef.current = store;

    const result = handlerOf(handlers, 'works:delete')({}, 'w1');

    expect(store.deleteWork).toHaveBeenCalledTimes(1);
    expect(store.deleteWork.mock.calls[0][0]).toBe('w1');
    expect(result).toBe(deleted);
  });

  it('不校验也不改写参数：null / undefined 原样透传', () => {
    const { handlers, storeRef } = createHarness();
    const store = fakeStore();
    storeRef.current = store;
    const del = handlerOf(handlers, 'works:delete');

    del({}, null);
    expect(store.deleteWork.mock.calls[0][0]).toBe(null);

    del({}, undefined);
    expect(store.deleteWork.mock.calls[1][0]).toBe(undefined);

    expect(store.deleteWork).toHaveBeenCalledTimes(2);
  });
});

describe('works-crud-ipc · 同步语义与异常传播', () => {
  it('handler 同步返回，不产生 Promise 包装', () => {
    const { handlers, storeRef } = createHarness();
    storeRef.current = fakeStore();
    const list = handlerOf(handlers, 'works:list');

    const result = list({});

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.then).toBe('undefined');
  });

  it('store 方法抛出的同步异常原样向上传递', () => {
    const { handlers, storeRef } = createHarness();
    const store = fakeStore({
      listWorks: vi.fn(function () { throw new Error('list-down'); })
    });
    storeRef.current = store;

    expect(function () {
      handlerOf(handlers, 'works:list')({});
    }).toThrow('list-down');
  });

  it('saveWork / deleteWork 抛错时同样向上传播', () => {
    const { handlers, storeRef } = createHarness();
    storeRef.current = fakeStore({
      saveWork: vi.fn(function () { throw new Error('save-down'); }),
      deleteWork: vi.fn(function () { throw new Error('delete-down'); })
    });

    expect(function () {
      handlerOf(handlers, 'works:save')({}, { id: 'w1' });
    }).toThrow('save-down');

    expect(function () {
      handlerOf(handlers, 'works:delete')({}, 'w1');
    }).toThrow('delete-down');
  });

  it('store 为 null 时同步抛出 TypeError（与直接访问 store.* 行为一致）', () => {
    const { handlers, storeRef } = createHarness();
    storeRef.current = null;
    const list = handlerOf(handlers, 'works:list');

    expect(function () { list({}); }).toThrow(TypeError);
    expect(function () { handlerOf(handlers, 'works:save')({}, {}); }).toThrow(TypeError);
    expect(function () { handlerOf(handlers, 'works:delete')({}, 'w1'); }).toThrow(TypeError);
  });
});
