'use strict';

// v1.20.3 声音档案：核心存储 + IPC 行为测试
//   - 不依赖 Electron，仅用文件系统 + mock app.getPath
//   - 锁定行为：
//     * listProfiles / createProfile / saveVersion / getVersionPath / readAudioBuffer / deleteVersion / deleteProfile
//     * 每个录音版本独立子目录，**绝不覆盖**已有版本
//     * 删除单个版本不会误删其他版本 / 误删档案根
//     * path-escape 检查（profileId/versionId 强制 regex）
//     * 不存在的录音字节 → 抛错 + 不留空目录
//     * 真实文件存在 + 大小写不敏感

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 直接 require 待测试模块——voice-profiles.js 用 module.exports
const vp = require('../electron/voice-profiles');

function tmpUserData() {
  const dir = path.join(os.tmpdir(), 'rokit-voice-test-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function mockApp(userDataDir) {
  return { getPath: function (k) { if (k === 'userData') return userDataDir; return os.tmpdir(); } };
}

// 1-byte 假音频（最小有效 base64）
const TINY_B64 = 'iIA=';

describe('v1.20.3 · voice-profiles（声音档案）', () => {
  let userData, profileDir;
  beforeEach(() => {
    userData = tmpUserData();
    profileDir = path.join(userData, 'voice-profiles');
    vp.init(mockApp(userData));
  });
  afterEach(() => {
    try { fs.rmdirSync(userData, { recursive: true }); } catch (_e) { /* ignore */ }
  });

  it('init 创建 voice-profiles 根目录', () => {
    expect(fs.existsSync(profileDir)).toBe(true);
  });

  it('_safeId 拒绝空白与非法字符（大小写都接受，仅限制 hex/长度）', () => {
    expect(() => vp._safeId('', 'p')).toThrow();
    expect(() => vp._safeId('../etc/pass', 'p')).toThrow();
    expect(() => vp._safeId('not-id%@!', 'p')).toThrow();
    // 大小写都接受但统一返回小写
    expect(vp._safeId('AbC12345', 'p')).toBe('abc12345');
    // 太短
    expect(() => vp._safeId('abc123', 'p')).toThrow();
    // 正常
    expect(vp._safeId('abc12345', 'p')).toBe('abc12345');
    expect(vp._safeId('1234567812345678', 'p')).toBe('1234567812345678');
  });

  it('_safeName 把路径分隔符和不可见字符替换成下划线', () => {
    expect(vp._safeName('a/b\\c:d')).toBe('a_b_c_d');
    expect(vp._safeName('hi\x00null')).toBe('hi_null');
    expect(vp._safeName('')).toBe('');
    expect(vp._safeName('普通-中文 OK')).toBe('普通-中文 OK');
  });

  it('createProfile + listProfiles 增加档案', () => {
    expect(vp.listProfiles()).toEqual([]);
    var p1 = vp.createProfile({ name: '中文录音' });
    expect(p1.id).toMatch(/^[a-f0-9]{16}$/);
    expect(p1.name).toBe('中文录音');
    expect(p1.createdAt).toBeTruthy();
    expect(vp.listProfiles().length).toBe(1);
    expect(vp.listProfiles()[0].name).toBe('中文录音');
  });

  it('createProfile 重名/同 id 不抛错 —— 幂等覆盖 name', () => {
    var p = vp.createProfile({ name: 'Alpha' });
    var p2 = vp.createProfile({ id: p.id, name: 'Beta' });
    expect(p2.id).toBe(p.id);
    expect(p2.name).toBe('Beta');
    expect(vp.listProfiles().length).toBe(1); // 仍是 1 条
  });

  it('saveVersion 写文件 + 真实存在 + metadata 准确', async () => {
    var p = vp.createProfile({ name: '录音-A' });
    var r = vp.saveVersion({
      profileId: p.id,
      profileName: '录音-A',
      mime: 'audio/webm',
      ext: 'webm',
      durationSec: 1.234,
      source: 'recording',
      name: 'rec-1',
      b64: TINY_B64
    });
    expect(r.ok).toBe(true);
    expect(r.profile.id).toBe(p.id);
    expect(r.version.name).toBe('rec-1');
    expect(r.version.durationSec).toBe(1.234);
    expect(r.version.mime).toBe('audio/webm');
    expect(r.version.ext).toBe('webm');
    expect(r.version.fileName).toBe('recording.webm');
    expect(r.version.fileSize).toBeGreaterThan(0);
    // 文件真实存在
    expect(fs.existsSync(r.absPath)).toBe(true);
    var stat = fs.statSync(r.absPath);
    expect(stat.size).toBe(r.version.fileSize);
  });

  it('saveVersion 的录音**绝不覆盖**之前版本', () => {
    var p = vp.createProfile({ name: 'noo' });
    var v1 = vp.saveVersion({ profileId: p.id, profileName: 'noo', mime: 'audio/webm', ext: 'webm', durationSec: 1, source: 'recording', name: 'v1', b64: 'AAA=' });
    var v2 = vp.saveVersion({ profileId: p.id, profileName: 'noo', mime: 'audio/webm', ext: 'webm', durationSec: 2, source: 'recording', name: 'v2', b64: 'AAAA=' });
    expect(v1.version.id).not.toBe(v2.version.id);
    expect(fs.existsSync(v1.absPath)).toBe(true);
    expect(fs.existsSync(v2.absPath)).toBe(true);
    var list = vp.listProfiles();
    expect(list.length).toBe(1);
    expect(list[0].versions.length).toBe(2);
  });

  it('saveVersion 同 versionId 重复抛错（不覆盖）', () => {
    var p = vp.createProfile({ name: 'dup' });
    var v1 = vp.saveVersion({ profileId: p.id, profileName: 'dup', mime: 'audio/webm', ext: 'webm', durationSec: 1, source: 'recording', name: 'v1', b64: 'AAA=' });
    expect(() => vp.saveVersion({ profileId: p.id, profileName: 'dup', versionId: v1.version.id, mime: 'audio/webm', ext: 'webm', durationSec: 1, source: 'recording', name: 'v1', b64: 'AAA=' })).toThrow();
    // 第一版**仍然存在**
    expect(fs.existsSync(v1.absPath)).toBe(true);
  });

  it('saveVersion 空 b64 抛错并清空空目录（不留垃圾）', () => {
    var p = vp.createProfile({ name: 'empty' });
    expect(() => vp.saveVersion({ profileId: p.id, profileName: 'empty', mime: 'audio/webm', ext: 'webm', durationSec: 0, source: 'recording', name: 'x', b64: '' })).toThrow();
    // list 仍然只有档案本身，**没有版本**
    var list = vp.listProfiles();
    expect(list.length).toBe(1);
    expect(list[0].versions.length).toBe(0);
  });

  it('getVersionPath 返回文件路径 + metadata；不存在 → null', () => {
    var p = vp.createProfile({ name: 'p' });
    var v = vp.saveVersion({ profileId: p.id, profileName: 'p', mime: 'audio/webm', ext: 'webm', durationSec: 1, source: 'recording', name: 'x', b64: 'AAA=' });
    var got = vp.getVersionPath(p.id, v.version.id);
    expect(got).toBeTruthy();
    expect(got.meta.id).toBe(v.version.id);
    expect(got.filePath).toBe(v.absPath);
    // 非法 id**抛错**（_safeId 强校验）
    expect(() => vp.getVersionPath('notexist', 'notexist')).toThrow();
    // 合规 id 但**不存在**的版本 → null
    var bad = vp.getVersionPath('abcdef0123456789', '1234567812345678');
    expect(bad).toBe(null);
  });

  it('readAudioBuffer 返回有效 base64，包含真实字节', () => {
    var p = vp.createProfile({ name: 'buf' });
    var v = vp.saveVersion({ profileId: p.id, profileName: 'buf', mime: 'audio/webm', ext: 'webm', durationSec: 1, source: 'recording', name: 'x', b64: TINY_B64 });
    var r = vp.readAudioBuffer(p.id, v.version.id);
    expect(r).toBeTruthy();
    expect(r.buffer.length).toBeGreaterThan(0);
    var reencoded = r.buffer.toString('base64');
    expect(reencoded).toBe(TINY_B64);
  });

  it('deleteVersion 仅删除指定版本，**不删其他版本，也不删档案根**', () => {
    var p = vp.createProfile({ name: 'rm' });
    var v1 = vp.saveVersion({ profileId: p.id, profileName: 'rm', mime: 'audio/webm', ext: 'webm', durationSec: 1, source: 'recording', name: 'v1', b64: 'AAA=' });
    var v2 = vp.saveVersion({ profileId: p.id, profileName: 'rm', mime: 'audio/webm', ext: 'webm', durationSec: 2, source: 'recording', name: 'v2', b64: 'AAAA=' });
    var v3 = vp.saveVersion({ profileId: p.id, profileName: 'rm', mime: 'audio/webm', ext: 'webm', durationSec: 3, source: 'recording', name: 'v3', b64: 'AAAAA=' });
    var r = vp.deleteVersion(p.id, v2.version.id);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(v1.absPath)).toBe(true);
    expect(fs.existsSync(v2.absPath)).toBe(false);
    expect(fs.existsSync(v3.absPath)).toBe(true);
    // 档案根目录仍在
    expect(fs.existsSync(path.join(profileDir, p.id))).toBe(true);
    // listProfiles 显示剩 2 个版本
    var list = vp.listProfiles();
    expect(list[0].versions.length).toBe(2);
  });

  it('deleteProfile 删除整个档案（含所有版本）', () => {
    var p1 = vp.createProfile({ name: 'p1' });
    vp.saveVersion({ profileId: p1.id, profileName: 'p1', mime: 'audio/webm', ext: 'webm', durationSec: 1, source: 'recording', name: 'x', b64: 'AAA=' });
    var p2 = vp.createProfile({ name: 'p2' });
    vp.saveVersion({ profileId: p2.id, profileName: 'p2', mime: 'audio/webm', ext: 'webm', durationSec: 1, source: 'recording', name: 'x', b64: 'AAA=' });
    var r = vp.deleteProfile(p1.id);
    expect(r.ok).toBe(true);
    expect(vp.listProfiles().length).toBe(1);
    expect(vp.listProfiles()[0].id).toBe(p2.id);
  });

  it('saveVersion 拒绝非法 id（path-escape 防御）', () => {
    expect(() => vp.saveVersion({ profileId: '../etc/pass', profileName: 'x', mime: 'audio/webm', ext: 'webm', durationSec: 1, source: 'recording', name: 'x', b64: 'AAA=' })).toThrow();
    expect(() => vp.saveVersion({ profileId: 'abc', versionId: 'abc', profileName: 'x', mime: 'audio/webm', ext: 'webm', durationSec: 1, source: 'recording', name: 'x', b64: 'AAA=' })).toThrow();
  });

  it('deleteVersion / deleteProfile 拒绝非法 id（抛错 / 返回 {ok:false}）', () => {
    // 非法 id → _safeId 抛错
    expect(() => vp.deleteVersion('../etc', 'evil')).toThrow();
    expect(() => vp.deleteProfile('../etc')).toThrow();
    // 合规 id 但路径被转义后**不**匹配真实目录 → path-escape
    var r = vp.deleteVersion('abcdef0123456789', '1234567812345678');
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    // 不存在的合规 id
    var r2 = vp.deleteProfile('99999999aaaaaaaaaaaaaaaa');
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('not-found');
  });

  it('buildSafePaths 返回安全 profile/version 路径 + 默认 fileName', () => {
    var sp = vp.buildSafePaths('abcdef0123456789', '1234567812345678', 'WEBM');
    expect(sp.profileDir).toContain('voice-profiles');
    expect(sp.profileDir.endsWith('abcdef0123456789')).toBe(true);
    expect(sp.versionFileName).toBe('recording.webm');
  });

  it('（IPC 入口）attachIpc 上不存在 ipcMain 时安全 no-op', () => {
    expect(() => vp.attachIpc(null, {})).not.toThrow();
    expect(() => vp.attachIpc(undefined, {})).not.toThrow();
  });
});
