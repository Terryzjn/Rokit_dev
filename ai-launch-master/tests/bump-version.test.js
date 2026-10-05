// Rokit · 板号自增脚本 单元测试
// 覆盖：纯函数 bump / parseVersion 行为、CLI 写入 package.json 的副作用
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bump, parseVersion, PATCH_LIMIT, DEFAULT_START } = require('../scripts/bump-version');

describe('bump-version · parseVersion', () => {
  it('应解析合法版本号', () => {
    expect(parseVersion('0.1.0')).toEqual([0, 1, 0]);
    expect(parseVersion('1.20.300')).toEqual([1, 20, 300]);
    expect(parseVersion(' 0.2.5 ')).toEqual([0, 2, 5]);
  });

  it('非法版本号应返回 null', () => {
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('1.2.3.4')).toBeNull();
    expect(parseVersion('v1.2.3')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });
});

describe('bump-version · bump 纯函数', () => {
  it('从起始版号 0.1.0 起，每次 +1', () => {
    expect(bump('0.1.0')).toBe('0.1.1');
    expect(bump('0.1.1')).toBe('0.1.2');
    expect(bump('0.1.98')).toBe('0.1.99');
  });

  it('PATCH 为两位数上限 99 → 下一步直接进位到 MINOR（不会出现 0.1.100）', () => {
    expect(bump('0.1.99')).toBe('0.2.0');
  });

  it('进位后再递增', () => {
    expect(bump('0.2.0')).toBe('0.2.1');
    expect(bump('0.2.98')).toBe('0.2.99');
    expect(bump('0.2.99')).toBe('0.3.0');
  });

  it('大版本号也能正确进位', () => {
    expect(bump('1.99.99')).toBe('2.0.0');
    expect(bump('1.99.98')).toBe('1.99.99');
    expect(bump('0.99.99')).toBe('1.0.0');
  });

  it('起始版号常量应为 0.1.0', () => {
    expect(DEFAULT_START).toBe('0.1.0');
  });

  it('进位阈值应为 100（两位数上限 + 1）', () => {
    expect(PATCH_LIMIT).toBe(100);
  });

  it('非法版本号应抛错', () => {
    expect(() => bump('abc')).toThrow();
    expect(() => bump('1.2')).toThrow();
    expect(() => bump('v0.1.0')).toThrow();
  });

  it('PATCH 已超过两位数（如 0.1.100）应正常进位，不抛错', () => {
    expect(bump('0.1.100')).toBe('0.2.0');
    expect(bump('1.99.100')).toBe('2.0.0');
  });

  it('未传 / 空串时从默认起始版号 0.1.0 开始', () => {
    expect(bump('')).toBe('0.1.1');
    expect(bump(null)).toBe('0.1.1');
    expect(bump(undefined)).toBe('0.1.1');
  });
});

describe('bump-version · CLI 副作用（写 package.json）', () => {
  let tmpDir;
  let fakePkgPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-bump-'));
    fakePkgPath = path.join(tmpDir, 'package.json');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  // 通过子进程跑真实脚本，环境变量 ROKIT_PKG_PATH 指向临时文件
  function runCli(args) {
    const { spawnSync } = require('child_process');
    return spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'bump-version.js'), ...args], {
      env: Object.assign({}, process.env, { ROKIT_PKG_PATH: fakePkgPath }),
      encoding: 'utf8'
    });
  }

  function writePkg(version) {
    fs.writeFileSync(fakePkgPath, JSON.stringify({ name: 'rokit', version }) + '\n', 'utf8');
  }

  it('执行 bump-version 应将 package.json 的 version 自增并写回', () => {
    writePkg('0.1.0');
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/0\.1\.0 -> 0\.1\.1/);
    const after = JSON.parse(fs.readFileSync(fakePkgPath, 'utf8'));
    expect(after.version).toBe('0.1.1');
  });

  it('--check 应只打印而不写文件', () => {
    writePkg('0.1.5');
    const r = runCli(['--check']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/0\.1\.5 -> 0\.1\.6/);
    const after = JSON.parse(fs.readFileSync(fakePkgPath, 'utf8'));
    expect(after.version).toBe('0.1.5');
  });

  it('从 0.1.99 触发进位时应直接得到 0.2.0（不会出现 0.1.100）', () => {
    writePkg('0.1.99');
    runCli([]);
    const after = JSON.parse(fs.readFileSync(fakePkgPath, 'utf8'));
    expect(after.version).toBe('0.2.0');
  });

  it('进位后下一轮 bump 应进入新的 MINOR 并从 0 开始', () => {
    writePkg('0.2.0');
    runCli([]);
    const after = JSON.parse(fs.readFileSync(fakePkgPath, 'utf8'));
    expect(after.version).toBe('0.2.1');
  });

  it('连续多次执行应严格按规则递增', () => {
    writePkg('0.1.97');
    runCli([]); // -> 0.1.98
    runCli([]); // -> 0.1.99
    runCli([]); // -> 0.2.0
    runCli([]); // -> 0.2.1
    const after = JSON.parse(fs.readFileSync(fakePkgPath, 'utf8'));
    expect(after.version).toBe('0.2.1');
  });
});
