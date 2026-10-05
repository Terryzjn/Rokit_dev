// Rokit · LLM 接入层单元测试
// 覆盖：URL 拼接、错误信息映射、超时控制、缺 api_key 处理
// vitest 全局由 vitest.config.js globals:true 注入

describe('llm.chatComplete · URL 拼接', () => {
  beforeEach(() => {
    // 重置模块缓存以避免 global.fetch 被 mock 状态污染
    vi.resetModules();
  });

  it('应自动去掉 base_url 末尾的斜杠再拼接', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hi' } }] })
    });
    globalThis.fetch = fetchMock;

    const { chatComplete } = require('../electron/llm');
    await chatComplete(
      { base_url: 'https://api.deepseek.com/v1///', api_key: 'k', model: 'deepseek-chat' },
      { messages: [{ role: 'user', content: 'hi' }] }
    );
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('base_url 为空时应回退到 deepseek 默认', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    });
    globalThis.fetch = fetchMock;

    const { chatComplete } = require('../electron/llm');
    await chatComplete(
      { base_url: '', api_key: 'k', model: 'deepseek-chat' },
      { messages: [{ role: 'user', content: 'hi' }] }
    );
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('缺 api_key 时应主动抛错（v1.5：避免发送空 Bearer 后被 401 迷惑）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    });
    globalThis.fetch = fetchMock;

    const { chatComplete } = require('../electron/llm');
    await expect(chatComplete(
      { base_url: 'https://api.deepseek.com/v1', api_key: '', model: 'm' },
      { messages: [{ role: 'user', content: 'hi' }] }
    )).rejects.toThrow(/未配置 API Key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('llm.chatComplete · 请求体', () => {
  it('应正确组装 messages / model / temperature / max_tokens / stream', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    });
    globalThis.fetch = fetchMock;

    const { chatComplete } = require('../electron/llm');
    await chatComplete(
      { base_url: 'https://api.deepseek.com/v1', api_key: 'k', model: 'gpt-4o-mini' },
      {
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
        max_tokens: 500
      }
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(500);
    expect(body.stream).toBe(false);
  });

  it('temperature / max_tokens 缺省时使用兜底值', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] })
    });
    globalThis.fetch = fetchMock;

    const { chatComplete } = require('../electron/llm');
    await chatComplete(
      { base_url: 'https://api.deepseek.com/v1', api_key: 'k', model: 'm' },
      { messages: [] }
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0.8);
    expect(body.max_tokens).toBe(1200);
  });
});

describe('llm.chatComplete · 错误处理', () => {
  it('HTTP 4xx/5xx 应抛出包含状态码的错误', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized'
    });
    globalThis.fetch = fetchMock;

    const { chatComplete } = require('../electron/llm');
    await expect(
      chatComplete({ base_url: 'https://x.com/v1', api_key: 'k', model: 'm' }, { messages: [] })
    ).rejects.toThrow(/401/);
  });

  it('网络异常时应抛出包含 URL 的可读错误', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    globalThis.fetch = fetchMock;

    const { chatComplete } = require('../electron/llm');
    await expect(
      chatComplete({ base_url: 'https://x.com/v1', api_key: 'k', model: 'm' }, { messages: [] })
    ).rejects.toThrow(/ECONNREFUSED|x\.com/);
  });

  it('HTTP 错误的 body 应被截断到 300 字符以内', async () => {
    const longBody = 'x'.repeat(1000);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => longBody
    });
    globalThis.fetch = fetchMock;

    const { chatComplete } = require('../electron/llm');
    try {
      await chatComplete({ base_url: 'https://x.com/v1', api_key: 'k', model: 'm' }, { messages: [] });
    } catch (e) {
      expect(e.message.length).toBeLessThan(400); // 状态码 + 300 字 body + 前缀
      expect(e.message).not.toContain('x'.repeat(500));
    }
  });

  it('响应结构异常（无 choices）应返回空字符串而非崩溃', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'malformed' })
    });
    globalThis.fetch = fetchMock;

    const { chatComplete } = require('../electron/llm');
    const r = await chatComplete({ base_url: 'https://x.com/v1', api_key: 'k', model: 'm' }, { messages: [] });
    expect(r).toBe('');
  });
});

describe('llm.chatComplete · 超时控制（P1 修复后）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('请求超过配置的超时阈值时应抛出超时错误', async () => {
    // 模拟 fetch 永远不返回
    const fetchMock = vi.fn().mockImplementation(
      (_url, opts) =>
        new Promise((_resolve, reject) => {
          // 监听 signal abort
          if (opts && opts.signal) {
            opts.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        })
    );
    globalThis.fetch = fetchMock;

    const { chatComplete } = require('../electron/llm');
    await expect(
      chatComplete(
        { base_url: 'https://slow.x.com/v1', api_key: 'k', model: 'm', timeout: 100 },
        { messages: [] }
      )
    ).rejects.toThrow(/超时|aborted|timeout/i);
  });

  it('请求在超时内完成不应被中断', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'fast' } }] })
    });
    globalThis.fetch = fetchMock;

    const { chatComplete } = require('../electron/llm');
    const r = await chatComplete(
      { base_url: 'https://x.com/v1', api_key: 'k', model: 'm', timeout: 5000 },
      { messages: [] }
    );
    expect(r).toBe('fast');
  });
});
