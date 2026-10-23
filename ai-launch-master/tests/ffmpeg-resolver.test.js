// ffmpeg-resolver 单元测试（v1.20.1）
// 覆盖：PE/ELF 头校验（好/坏样本）、fallback 链顺序、失败诊断链、video.js 接线
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const resolverPath = path.join(projectRoot, 'electron', 'ffmpeg-resolver.js');

// 每个用例重新 require 以获得干净缓存（resolver 内部有单例 _cached）
function freshResolver() {
  delete require.cache[require.resolve(resolverPath)];
  return require(resolverPath);
}

// 构造最小 PE 头（只填充 resolver 校验用到的字段）
function buildPE(opts) {
  opts = opts || {};
  const subsystem = opts.subsystem !== undefined ? opts.subsystem : 3;
  const machine = opts.machine !== undefined ? opts.machine : 0x8664;
  const optMagic = opts.optMagic !== undefined ? opts.optMagic : 0x20b;
  const peOff = opts.peOff !== undefined ? opts.peOff : 0x80;
  const buf = Buffer.alloc(8192, 0);
  buf[0] = 0x4d; buf[1] = 0x5a; // MZ
  buf.writeUInt32LE(peOff, 0x3c);
  buf.write('PE\0\0', peOff, 'binary');
  buf.writeUInt16LE(machine, peOff + 4);
  buf.writeUInt16LE(optMagic, peOff + 24);
  buf.writeUInt16LE(subsystem, peOff + 92); // Subsystem 正确偏移
  return buf;
}

function tmpFile(name, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-resolver-'));
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, buf);
  tmpDirs.push(dir);
  return fp;
}

const tmpDirs = [];
afterAll(function () {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {} }
});

describe('ffmpeg-resolver · validateFfmpegBinary 通用校验', () => {
  it('空路径 → empty-path', () => {
    const r = freshResolver();
    expect(r.validateFfmpegBinary('')).toEqual({ ok: false, reason: 'empty-path' });
  });

  it('不存在的路径 → stat-failed', () => {
    const r = freshResolver();
    const v = r.validateFfmpegBinary(path.join(os.tmpdir(), 'no-such-file-' + Date.now() + '.exe'));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/^stat-failed:/);
  });

  it('纯文本小文件 → too-small', () => {
    const r = freshResolver();
    const fp = tmpFile('tiny.txt', Buffer.from('not an executable'));
    const v = r.validateFfmpegBinary(fp);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/^too-small:/);
  });
});

describe.skipIf(process.platform !== 'win32')('ffmpeg-resolver · validateWinPE（Windows PE 头校验）', () => {
  it('合法 PE（subsystem=3 Console）→ ok', () => {
    const r = freshResolver();
    const fp = tmpFile('good-console.exe', buildPE({ subsystem: 3 }));
    const v = r.validateFfmpegBinary(fp);
    expect(v.ok).toBe(true);
    expect(v.subsystem).toBe(3);
    expect(v.machine).toBe(0x8664);
  });

  it('合法 PE（subsystem=2 GUI）→ ok', () => {
    const r = freshResolver();
    const fp = tmpFile('good-gui.exe', buildPE({ subsystem: 2 }));
    expect(r.validateFfmpegBinary(fp).ok).toBe(true);
  });

  it('subsystem=0（EFTYPE 根因特征）→ bad-subsystem:0', () => {
    const r = freshResolver();
    const fp = tmpFile('bad-subsystem.exe', buildPE({ subsystem: 0 }));
    const v = r.validateFfmpegBinary(fp);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('bad-subsystem:0');
  });

  it('缺少 MZ 魔数 → no-mz-magic', () => {
    const r = freshResolver();
    const buf = buildPE({});
    buf[0] = 0x00; buf[1] = 0x00;
    const fp = tmpFile('no-mz.exe', buf);
    expect(r.validateFfmpegBinary(fp).reason).toBe('no-mz-magic');
  });

  it('错误 machine 类型 → bad-machine', () => {
    const r = freshResolver();
    const fp = tmpFile('bad-machine.exe', buildPE({ machine: 0x1234 }));
    expect(r.validateFfmpegBinary(fp).reason).toBe('bad-machine:0x1234');
  });

  it('错误 Optional Header magic → bad-opt-magic', () => {
    const r = freshResolver();
    const fp = tmpFile('bad-opt.exe', buildPE({ optMagic: 0x9999 }));
    expect(r.validateFfmpegBinary(fp).reason).toBe('bad-opt-magic:0x9999');
  });

  it('真实已知良好二进制（node.exe）→ ok（校验偏移正确性）', () => {
    const r = freshResolver();
    const v = r.validateFfmpegBinary(process.execPath);
    expect(v.ok).toBe(true);
  });
});

describe('ffmpeg-resolver · resolveFfmpegPath fallback 链', () => {
  const ENV_KEYS = ['ROKIT_FFMPEG_BIN', 'FFMPEG_BIN'];
  let savedEnv = {};
  beforeEach(function () {
    savedEnv = {};
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  });
  afterAll(function () {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('ROKIT_FFMPEG_BIN 指向合法 PE → ok，source=ROKIT_FFMPEG_BIN', () => {
    const r = freshResolver();
    if (process.platform !== 'win32') return; // PE fixture 仅 Windows 有效
    const fp = tmpFile('env-good.exe', buildPE({ subsystem: 3 }));
    process.env.ROKIT_FFMPEG_BIN = fp;
    const res = r.resolveFfmpegPath();
    expect(res.ok).toBe(true);
    expect(res.source).toBe('ROKIT_FFMPEG_BIN');
    expect(res.path).toBe(fp);
  });

  it('ROKIT_FFMPEG_BIN 指向损坏 PE → 该候选被拒绝并记录原因，fallback 继续', () => {
    const r = freshResolver();
    if (process.platform !== 'win32') return;
    const fp = tmpFile('env-bad.exe', buildPE({ subsystem: 0 }));
    process.env.ROKIT_FFMPEG_BIN = fp;
    const res = r.resolveFfmpegPath();
    // 不论整条链最终成功与否：env 候选必须被尝试并留下 bad-subsystem 原因
    const t = (res.tried || []).find(function (x) { return x.source === 'ROKIT_FFMPEG_BIN'; });
    expect(t).toBeTruthy();
    expect(t.reason).toBe('bad-subsystem:0');
    // 若链最终成功，绝不能来自损坏的 env 候选
    if (res.ok) expect(res.source).not.toBe('ROKIT_FFMPEG_BIN');
  });

  it('bundled ffmpeg-static 损坏/缺失时 → 失败但 tried 链可诊断', () => {
    const r = freshResolver();
    const res = r.resolveFfmpegPath();
    // 本机当前 bundled 二进制损坏（0 字节）且系统无 ffmpeg → 应失败且带诊断
    if (res.ok) return; // 若用户已恢复有效 ffmpeg，则跳过该断言
    expect(res.reason).toBe('no-runnable-ffmpeg-found');
    expect(Array.isArray(res.tried)).toBe(true);
    expect(res.tried.length).toBeGreaterThan(0);
  });

  it('失败结果不缓存 → 环境恢复后立即可用', () => {
    const r = freshResolver();
    if (process.platform !== 'win32') return;
    const bad = tmpFile('cache-bad.exe', buildPE({ subsystem: 0 }));
    const good = tmpFile('cache-good.exe', buildPE({ subsystem: 2 }));
    process.env.ROKIT_FFMPEG_BIN = bad;
    const first = r.resolveFfmpegPath();
    if (first.ok) return; // bundled/系统已有可用 ffmpeg 时整链不会失败，此用例无从触发
    // 不清缓存，直接换成好路径（失败未被缓存时应立即生效）
    process.env.ROKIT_FFMPEG_BIN = good;
    const res = r.resolveFfmpegPath();
    expect(res.ok).toBe(true);
    expect(res.path).toBe(good);
  });
});

describe('video.js 接线', () => {
  it('transcodeWebmToMp4 输入不存在 → input-not-found（先于 ffmpeg 检查）', async () => {
    const video = require(path.join(projectRoot, 'electron', 'video.js'));
    await expect(video.transcodeWebmToMp4('/nonexistent-' + Date.now() + '.webm'))
      .rejects.toThrow(/input-not-found/);
  });

  it('transcodeWebmToMp4 第二参为字符串时不抛参数类型错误（向后兼容）', async () => {
    const video = require(path.join(projectRoot, 'electron', 'video.js'));
    // 输入不存在：应在参数处理前 reject input-not-found，而不是 ffmpeg-args-not-string
    await expect(video.transcodeWebmToMp4('/nonexistent.webm', 'C:\\tmp\\out.mp4'))
      .rejects.toThrow(/input-not-found/);
  });

  it('ffmpegPath 返回空字符串或合法字符串路径（冒烟）', () => {
    const video = require(path.join(projectRoot, 'electron', 'video.js'));
    const p = video.ffmpegPath();
    expect(p === '' || (typeof p === 'string' && p.length > 0)).toBe(true);
  });

  it('ffmpegDiagnostic 失败时返回 tried 链，成功时返回 path/source', () => {
    const video = require(path.join(projectRoot, 'electron', 'video.js'));
    const d = video.ffmpegDiagnostic();
    if (d.ok) {
      expect(typeof d.path).toBe('string');
      expect(typeof d.source).toBe('string');
    } else {
      expect(typeof d.error).toBe('string');
      expect(Array.isArray(d.tried)).toBe(true);
    }
  });

  it('ffmpeg 不可用时 transcodeWebmToMp4 拒绝并给出可诊断错误（非裸 EFTYPE）', async () => {
    const video = require(path.join(projectRoot, 'electron', 'video.js'));
    if (video.ffmpegAvailable()) return; // 已有可用 ffmpeg 时跳过
    const fp = tmpFile('fake.webm', Buffer.alloc(4096, 1));
    const err = await video.transcodeWebmToMp4(fp).catch(function (e) { return e; });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^ffmpeg-unavailable:.*tried=/);
  });
});
