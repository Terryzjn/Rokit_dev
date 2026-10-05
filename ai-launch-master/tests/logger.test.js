// Rokit · 日志模块单元测试
// 覆盖：init/rotate/write/4 个日志级别/全局异常兜底
// vitest 全局由 vitest.config.js globals:true 注入
const fs = require('fs');
const os = require('os');
const path = require('path');

// 清空 logger 模块在 require 缓存中的条目。
// vitest 的 vi.resetModules() 在 CommonJS 下不能完整重置模块作用域变量，
// 这里直接操作 require.cache 才能让 logger.js 顶层的 `initialized`/`logFile` 真正回到初始状态。
function freshLogger() {
  const id = require.resolve('../electron/logger');
  delete require.cache[id];
  return require('../electron/logger');
}

describe('logger.init', () => {
  let tmpDir;
  let logger;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-logger-'));
    logger = freshLogger();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('应当在 userData/logs/rokit.log 落盘初始化', () => {
    logger.init(tmpDir);
    const logFile = path.join(tmpDir, 'logs', 'rokit.log');
    expect(fs.existsSync(path.dirname(logFile))).toBe(true);
    // 调用后写入一次日志，文件应当能被创建
    logger.info('hello');
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toMatch(/\[INFO\] hello/);
  });

  it('重复 init 应只生效首次（幂等）', () => {
    logger.init(tmpDir);
    logger.init('/non/existent/path/should/not/override');
    // 仍使用首次的 tmpDir
    logger.info('still here');
    expect(fs.readFileSync(path.join(tmpDir, 'logs', 'rokit.log'), 'utf8')).toMatch(/still here/);
  });

  it('init 抛错时不应向上抛（降级到 console-only）', () => {
    // 通过传一个无法创建目录的路径触发：传个文件而不是目录
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const badPath = path.join(blocker, 'logs'); // 父级是文件，无法创建子目录
    expect(() => logger.init(badPath)).not.toThrow();
    // 此后调用不应抛
    expect(() => logger.info('after-fail')).not.toThrow();
  });
});

describe('logger.write · 输出格式', () => {
  let tmpDir;
  let logFile;
  let logger;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-logger-'));
    logger = freshLogger();
    logger.init(tmpDir);
    logFile = path.join(tmpDir, 'logs', 'rokit.log');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('debug / info 走 stdout，warn / error 走 stderr', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      const logCalls = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      const errCalls = errSpy.mock.calls.map((c) => String(c[0])).join('\n');

      expect(logCalls).toMatch(/\[DEBUG\] d/);
      expect(logCalls).toMatch(/\[INFO\] i/);
      expect(errCalls).toMatch(/\[WARN\] w/);
      expect(errCalls).toMatch(/\[ERROR\] e/);
      // 不应串台
      expect(logCalls).not.toMatch(/WARN|ERROR/);
      expect(errCalls).not.toMatch(/INFO|DEBUG/);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('每行应包含时间戳（YYYY-MM-DD HH:MM:SS）', () => {
    logger.info('format-check');
    const line = fs.readFileSync(logFile, 'utf8').trim().split('\n').pop();
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
  });

  it('extra 为对象时应序列化为 JSON', () => {
    logger.info('with-extra', { foo: 'bar', n: 1 });
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toMatch(/"foo":"bar"/);
    expect(content).toMatch(/"n":1/);
  });

  it('extra 为字符串时应直接拼接', () => {
    logger.info('with-extra', 'plain-text-payload');
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toMatch(/plain-text-payload/);
    // 不应被 JSON.stringify 包裹
    expect(content).not.toMatch(/"plain-text-payload"/);
  });

  it('extra 为 falsy（0/false/null）时应不输出 extra 段', () => {
    logger.info('a', null);
    logger.info('b', 0);
    logger.info('c', false);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toMatch(/\[INFO\] a$/m);
    expect(content).toMatch(/\[INFO\] b$/m);
    expect(content).toMatch(/\[INFO\] c$/m);
  });
});

describe('logger · 未初始化时降级', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('未 init 时调用 debug/info/warn/error 不应抛', () => {
    const logger = freshLogger();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => logger.debug('d')).not.toThrow();
      expect(() => logger.info('i')).not.toThrow();
      expect(() => logger.warn('w')).not.toThrow();
      expect(() => logger.error('e')).not.toThrow();
      // 即使没有 init，console 也应被调用一次（保证开发期能看到）
      expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('logger.rotate · 单文件 1MB 阈值', () => {
  let tmpDir;
  let logFile;
  let logger;
  const MAX_SIZE = 1024 * 1024;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-logger-'));
    logger = freshLogger();
    logger.init(tmpDir);
    logFile = path.join(tmpDir, 'logs', 'rokit.log');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('文件 < 1MB 时不应触发 rotate', () => {
    fs.writeFileSync(logFile, 'x'.repeat(100), 'utf8');
    logger.info('after-small');
    // 仍只有 rokit.log，不应有 .1
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.existsSync(logFile + '.1')).toBe(false);
  });

  it('文件 > 1MB 时写入应触发 rotate，产生 .1 备份', () => {
    // 直接把日志文件撑到 1MB 以上
    fs.writeFileSync(logFile, 'x'.repeat(MAX_SIZE + 1), 'utf8');
    logger.info('trigger-rotate');
    expect(fs.existsSync(logFile + '.1')).toBe(true);
    // 新写的内容应落到 rokit.log 中
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toMatch(/trigger-rotate/);
  });

  it('rotate 应保留最多 3 个备份（.1 .2 .3），.3 被淘汰', () => {
    // Windows 上 fs.renameSync 不能覆盖已存在目标（NTFS 限制）。
    // 这里直接重写 fs.renameSync 模拟 POSIX 语义（先 unlink dst 再 rename），
    // 仅验证 logger.rotate 本身的链式滚动逻辑。
    const original = fs.renameSync;
    let calls = 0;
    fs.renameSync = function (src, dst) {
      calls++;
      if (fs.existsSync(dst)) {
        try { fs.unlinkSync(dst); } catch (_) {}
      }
      return original.call(fs, src, dst);
    };
    try {
      fs.writeFileSync(logFile + '.3', 'old-3', 'utf8');
      fs.writeFileSync(logFile + '.2', 'old-2', 'utf8');
      fs.writeFileSync(logFile + '.1', 'old-1', 'utf8');
      fs.writeFileSync(logFile, 'x'.repeat(MAX_SIZE + 1), 'utf8');
      logger.info('rotate-now');
      // rotate 至少触发 3 次 rename（.2→.3、.1→.2、logFile→.1）
      expect(calls).toBeGreaterThanOrEqual(3);
      // 最旧的 old-3 被淘汰：.3 现在装的是之前的 .2 内容
      expect(fs.readFileSync(logFile + '.3', 'utf8')).toBe('old-2');
      // 链式滚动：原 .1 现在在 .2
      expect(fs.readFileSync(logFile + '.2', 'utf8')).toBe('old-1');
      // 原 logFile 撑过 1MB 的内容现在在 .1
      expect(fs.readFileSync(logFile + '.1', 'utf8').startsWith('x')).toBe(true);
    } finally {
      fs.renameSync = original;
    }
  });

  it('日志文件不存在时 rotate 应安全跳过', () => {
    // init 只创建 logs 目录，不会预创建 logFile；确保 logFile 不存在
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
    expect(() => logger.info('safe')).not.toThrow();
    // 写入时自动重建
    expect(fs.existsSync(logFile)).toBe(true);
  });
});

describe('logger.installGlobalHandlers · 全局异常兜底', () => {
  let tmpDir;
  let logger;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-logger-'));
    logger = freshLogger();
    logger.init(tmpDir);
  });

  afterEach(() => {
    // 移除测试期间注册的 listener，避免污染其他测试
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('应当安装 uncaughtException / unhandledRejection 监听', () => {
    // 注册前监听器数量（保留其它测试残留的影响）
    const before = {
      ue: process.listenerCount('uncaughtException'),
      ur: process.listenerCount('unhandledRejection')
    };
    logger.installGlobalHandlers({ stage: 'test' });
    expect(process.listenerCount('uncaughtException')).toBe(before.ue + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(before.ur + 1);
  });

  it('uncaughtException 触发时应写 error 级别日志（含 message/stack/extra）', () => {
    logger.installGlobalHandlers({ stage: 'unit-test' });
    // 触发一次 uncaughtException
    const listener = process.listeners('uncaughtException').pop();
    expect(listener).toBeTypeOf('function');
    const err = new Error('boom-test');
    listener(err);

    const logFile = path.join(tmpDir, 'logs', 'rokit.log');
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toMatch(/\[ERROR\] uncaughtException/);
    expect(content).toMatch(/boom-test/);
    expect(content).toMatch(/"stage":"unit-test"/);
  });

  it('unhandledRejection 触发时应写 error 级别日志（含 message 与 extra）', () => {
    logger.installGlobalHandlers({ stage: 'rej-test' });
    const listener = process.listeners('unhandledRejection').pop();
    const reason = new Error('reject-reason');
    listener(reason);

    const logFile = path.join(tmpDir, 'logs', 'rokit.log');
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toMatch(/\[ERROR\] unhandledRejection/);
    expect(content).toMatch(/reject-reason/);
    expect(content).toMatch(/"stage":"rej-test"/);
  });

  it('unhandledRejection 的 reason 为非 Error 对象时应安全字符串化', () => {
    logger.installGlobalHandlers({ stage: 'string-reason' });
    const listener = process.listeners('unhandledRejection').pop();
    listener('just-a-string');
    const content = fs.readFileSync(path.join(tmpDir, 'logs', 'rokit.log'), 'utf8');
    expect(content).toMatch(/just-a-string/);
  });
});