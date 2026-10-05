// Rokit · OAuth 回调 loopback HTTP 服务
// 启动一个 127.0.0.1:随机端口的 HTTP 服务，监听 /oauth-callback（可被 callbackPath 选项覆盖）
// 命中后：解析 query 参数 → 返回一个简单成功 / 失败 HTML → 关服务 → 触发回调 promise
'use strict';

const http = require('http');

const CALLBACK_PATH = '/oauth-callback'; // 默认 path（保留向后兼容）
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟：超过视作用户取消

function createLoopback({ timeoutMs = DEFAULT_TIMEOUT_MS, callbackPath = CALLBACK_PATH } = {}) {
  let resolveCb = null;
  let rejectCb = null;
  const cbPromise = new Promise((res, rej) => { resolveCb = res; rejectCb = rej; });

  const server = http.createServer((req, res) => {
    try {
      const host = req.headers.host || '';
      const url = new URL(req.url, 'http://' + host);
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const params = url.searchParams;
      const payload = {
        code: params.get('code') || '',
        state: params.get('state') || '',
        error: params.get('error') || '',
        errorDescription: params.get('error_description') || ''
      };
      const ok = !!payload.code && !payload.error;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok
        ? '<!doctype html><meta charset="utf-8"><title>授权完成</title>' +
          '<div style="font-family:system-ui;padding:40px;text-align:center">' +
          '<h1 style="color:#2E8B33">✓ 授权完成</h1>' +
          '<p>可以回到 Rokit 应用继续操作。</p></div>'
        : '<!doctype html><meta charset="utf-8"><title>授权失败</title>' +
          '<div style="font-family:system-ui;padding:40px;text-align:center">' +
          '<h1 style="color:#C0392B">✗ 授权失败</h1>' +
          '<p>' + (payload.errorDescription || payload.error || '未知错误') + '</p>' +
          '<p>可以关掉此页，回到 Rokit 重试。</p></div>');
      resolveCb(payload);
    } catch (e) {
      rejectCb(e);
    } finally {
      // 关闭服务器（异步）
      setImmediate(() => server.close(() => {}));
    }
  });

  server.on('error', rejectCb);

  const portPromise = new Promise((res, rej) => {
    server.once('listening', () => {
      const a = server.address();
      if (!a) return rej(new Error('loopback_no_address'));
      res(a.port);
    });
    server.once('error', rej);
    server.listen(0, '127.0.0.1');
  });

  const timeoutPromise = new Promise((res) => {
    setTimeout(() => res({ code: '', state: '', error: 'timeout', errorDescription: '用户未在 ' + Math.round(timeoutMs / 1000) + ' 秒内完成授权' }), timeoutMs);
  });

  const awaitCallback = async () => {
    // race：回调到达 或 超时
    return Promise.race([cbPromise, timeoutPromise]).finally(() => {
      try { server.close(() => {}); } catch (_e) {}
    });
  };

  return { port: portPromise, awaitCallback };
}

module.exports = { createLoopback, CALLBACK_PATH };
