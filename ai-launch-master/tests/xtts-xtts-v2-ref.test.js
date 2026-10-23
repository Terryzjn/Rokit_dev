'use strict';

// v1.20.10 紧急回归修复：XTTS-v2 「生成测试语音」必须真正把参考音频传给本地服务
//   修复要点：
//     1. base64 头部嗅探：RIFF/WAVE → .wav；EBML → .webm；OggS → .ogg；ISO/MP4 → .mp4
//     2. 若不是 WAV 且 ffmpeg 可用 → 转码为 16k/mono/PCM WAV（XTTS-v2 推荐）
//     3. 若 ffmpeg 不可用 → 用原始字节 + 正确扩展名（部分 XTTS fork 支持）
//     4. renderer 必须把档案的 mime 一并传给 main（payload.refMime）
//     5. 不再硬编码 .wav 扩展名

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENG = fs.readFileSync(path.join(ROOT, 'electron/voice-engine.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('v1.20.10 · XTTS-v2 生成测试语音：参考音频传递修复', () => {

  it('A. _sniffAudioExt 嗅探 RIFF/WAVE 头 → .wav', () => {
    // 直接调用函数：用 Buffer 构造一个 RIFF/WAVE 头验证
    var wavHeader = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0,0,0,0]), Buffer.from('WAVE'), Buffer.from('fmt ')]);
    // 不直接 require（这文件不是 module exports），改为源码静态检查：
    expect(VENG).toMatch(/function _sniffAudioExt\(/);
    expect(VENG).toMatch(/toString\('ascii',\s*0,\s*4\)\s*===\s*'RIFF'/);
    expect(VENG).toMatch(/toString\('ascii',\s*8,\s*12\)\s*===\s*'WAVE'/);
    expect(VENG).toMatch(/return '\.wav'/);
  });

  it('B. _sniffAudioExt 嗅探 EBML 头 → .webm', () => {
    expect(VENG).toMatch(/0x1A[\s\S]{0,30}0x45[\s\S]{0,30}0xDF[\s\S]{0,30}0xA3/);
    expect(VENG).toMatch(/return '\.webm'/);
  });

  it('C. _writeRefWavToTemp 不再硬编码 .wav 扩展名，按嗅探格式写盘', () => {
    // 直接对全文检查：_writeRefWavToTemp 必须调 _sniffAudioExt
    expect(VENG).toMatch(/function _writeRefWavToTemp\([\s\S]*?_sniffAudioExt\(\s*buf\s*\)/);
    // v1.20.10：sniffedExt === '.wav' 且 _validateWavBuffer 通过 → 写盘为 .wav
    expect(VENG).toMatch(/function _writeRefWavToTemp\([\s\S]*?_writeBufferToTemp\(\s*buf,\s*'\.wav'\s*\)/);
    // 非 WAV 情况 → 返回 ref-needs-async-convert 错误（让主流程异步转码）
    expect(VENG).toMatch(/ref-needs-async-convert/);
    // 同时 _writeBufferToTemp 函数必须接受 ext 参数
    expect(VENG).toMatch(/function _writeBufferToTemp\(\s*buf,\s*ext\s*\)/);
  });

  it('D. _convertToWav16kMono 用 ffmpeg 把任意输入转 16k/mono/PCM WAV', () => {
    expect(VENG).toMatch(/function _convertToWav16kMono\(/);
    expect(VENG).toMatch(/ffmpegResolver\.resolveFfmpegPath/);
    expect(VENG).toMatch(/'-ac',\s*'1'/);
    expect(VENG).toMatch(/'-ar',\s*'16000'/);
    expect(VENG).toMatch(/'-acodec',\s*'pcm_s16le'/);
    expect(VENG).toMatch(/'-f',\s*'wav'/);
  });

  it('E. xttsTestGenerate 主路径：非 WAV 时调 _convertToWav16kMono 转码', () => {
    var fnMatch = VENG.match(/async function xttsTestGenerate[\s\S]*?const _refPath\s*=\s*_refRes\.path/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[0];
    // v1.20.10 新逻辑：用 _isAlreadyWav 分流；非 WAV 走 _convertToWav16kMono 转码
    expect(body).toMatch(/_isAlreadyWav/);
    expect(body).toMatch(/await\s+_convertToWav16kMono/);
    // 成功时 _refExt 改为 .wav
    expect(body).toMatch(/_refExt\s*=\s*'\.wav'/);
    // 写入时用 _refExt（不是 .wav 硬编码）
    expect(body).toMatch(/_writeBufferToTemp\(\s*_refBuf,\s*_refExt\s*\)/);
    // 写盘前最后一次 _validateWavBuffer 校验
    expect(body).toMatch(/_finalWav\s*=\s*_validateWavBuffer\(\s*_refBuf\s*\)/);
    expect(body).toMatch(/_validateWavBuffer\(\s*_refBuf\s*\)/);
  });

  it('F. payload.refMime 优先于嗅探（renderer 显式告知 mime）', () => {
    var fnMatch = VENG.match(/async function xttsTestGenerate[\s\S]*?const _refPath\s*=\s*_refRes\.path/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[0];
    // 必须读 payload.refMime
    expect(body).toMatch(/payload\.refMime/);
    // v1.20.10 新逻辑：mime 仅作"是否已是 wav"的判断（_isAlreadyWav），不再做扩展名覆盖
    // 严格按字节是否合法 WAV 决定路径，避免 mime 与字节不一致时被绕过
    expect(body).toMatch(/_refMime\.indexOf\('wav'\)\s*>=\s*0/);
    expect(body).toMatch(/_isAlreadyWav/);
  });

  it('G. 成功响应里回传 refMime / refExt 给 UI', () => {
    var fnMatch = VENG.match(/async function xttsTestGenerate[\s\S]*?_speakerWavOk\s*=\s*false;/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[0];
    expect(body).toMatch(/refMime:\s*_refMime\s*\|\|\s*''/);
    expect(body).toMatch(/refExt:\s*_refExt/);
  });

  it('H. main.js IPC handler 把 refMime / refExt 回传给 renderer', () => {
    expect(MAIN).toMatch(/refMime:\s*r\.refMime\s*\|\|\s*''/);
    expect(MAIN).toMatch(/refExt:\s*r\.refExt\s*\|\|\s*''/);
  });

  it('I. renderer voiceEngineRunTest 把档案 mime 一并传给 main', () => {
    // window.api.voiceReadAudioBuffer(...) 后 _runWithRef(r.b64, r.mime) 应同时传 mime
    var fnMatch = INDEX.match(/window\.voiceEngineRunTest\s*=\s*function[\s\S]*?window\.voiceEngineRerunTest\s*=/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[0];
    expect(body).toMatch(/_runWithRef\(r\.b64,\s*r\.mime\)/);
    // payload 包含 refMime
    expect(body).toMatch(/refMime:\s*mime\s*\|\|\s*''/);
  });

  it('J. xttsTestGenerate 在 refB64 为空时立即拒绝（不假装合成成功）', () => {
    expect(VENG).toMatch(/if\s*\(\s*!\s*refB64\s*\|\|\s*!String\(refB64\)\.trim\(\)\s*\)/);
    expect(VENG).toMatch(/XTTS-v2 需要参考音频/);
  });

  it('K. cleanup：测试结束（含错误）都会清临时文件', () => {
    // 用非贪婪到第一个 _cleanupRefWav( 后面是 finally 块的特征
    expect(VENG).toMatch(/finally\s*\{[\s\S]*?_cleanupRefWav\(_refPath\)/);
    expect(VENG).toMatch(/finally\s*\{[\s\S]*?_cleanupRefWav\(_refPath\)\s*;\s*\/\/\s*无论成功失败都清/);
  });

  it('L. _validateWavBuffer 严格验证 RIFF/WAVE 头 + 有效 fmt + 非空 data', () => {
    expect(VENG).toMatch(/function _validateWavBuffer\(\s*buf\s*\)/);
    expect(VENG).toMatch(/toString\('ascii',\s*0,\s*4\)\s*!==\s*'RIFF'/);
    expect(VENG).toMatch(/toString\('ascii',\s*8,\s*12\)\s*!==\s*'WAVE'/);
    expect(VENG).toMatch(/buf\.length\s*<\s*44/);
    expect(VENG).toMatch(/buf\.readUInt32LE\(24\)/);
    expect(VENG).toMatch(/buf\.readUInt16LE\(22\)/);
    expect(VENG).toMatch(/buf\.indexOf\('data'\)/);
    expect(VENG).toMatch(/dataSize\s*=\s*buf\.readUInt32LE\(dataOffset\s*\+\s*4\)/);
  });

  it('M. xttsTestGenerate 写盘前必须 _finalWav 校验（防 ffmpeg 异常假 WAV）', () => {
    var fnMatch = VENG.match(/async function xttsTestGenerate[\s\S]*?const _refPath\s*=\s*_refRes\.path/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[0];
    expect(body).toMatch(/_finalWav\s*=\s*_validateWavBuffer\(\s*_refBuf\s*\)/);
    // 若 _finalWav.ok === false → 必须 return 错误，**不**写盘 / 调 XTTS
    expect(body).toMatch(/if\s*\(!_finalWav\.ok\s*\)/);
    expect(body).toMatch(/转码后输出不是合法 WAV/);
  });

  it('N. 非 WAV + ffmpeg 不可用 → 拒绝（不写盘、不调 XTTS）', () => {
    var fnMatch = VENG.match(/async function xttsTestGenerate[\s\S]*?const _refPath\s*=\s*_refRes\.path/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[0];
    // 找到 _isAlreadyWav === false 后的 else 分支
    expect(body).toMatch(/_convertToWav16kMono\(_rawBuf\)/);
    // conv 失败 → 返回错误，包含 actionableHint 提示安装 ffmpeg
    expect(body).toMatch(/当前 Rokit 无法转换 WebM\/Opus 录音为 WAV/);
    expect(body).toMatch(/无法将参考音频/);
    // 不调 XTTS（不 _buildRequest）
    expect(body).toMatch(/return\s*\{[\s\S]*?ok:\s*false/);
  });

  // v1.20.10 紧急回归修复新增测试
  it('O. _writeBufferToTemp 拒绝 .bin 扩展名（防止用扩展名伪装格式）', () => {
    var fnMatch = VENG.match(/function _writeBufferToTemp\([\s\S]*?\n  \}\s*\n/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[0];
    // 必须显式拒绝 .bin
    expect(body).toMatch(/if\s*\(\s*ext\s*===\s*'\.bin'\s*\)/);
    expect(body).toMatch(/ref-format-unrecognized/);
    // 不再把"无效扩展名"兜底为 .bin
    expect(body).not.toMatch(/test\(ext\)\s*\?\s*ext\s*:\s*'\.bin'/);
    // 不再让 regex 把 .bin 当合法
    expect(body).not.toMatch(/test\(ext\)\s*\?\s*ext\s*:\s*'\.bin'\s*\)\s*;\s*\}/);
  });

  it('P. xttsTestGenerate 正确接收第 4 参数 payload（_payload.refMime 生效）', () => {
    // 签名必须包含第 4 个参数 payload
    expect(VENG).toMatch(/async function xttsTestGenerate\(\s*config\s*,\s*text\s*,\s*refB64\s*,\s*payload\s*\)/);
    // 内部用 _payload 兜底引用
    expect(VENG).toMatch(/const _payload\s*=\s*payload\s*\|\|\s*\{\}/);
    // 不再使用未声明的 `payload.refMime`（直接读 `_payload.refMime`）
    expect(VENG).toMatch(/typeof _payload\.refMime/);
    // testGenerate 路由层必须把整个 payload 传下去
    expect(VENG).toMatch(/await xttsTestGenerate\([\s\S]*?payload\s*\|\|\s*\{\}\s*\)/);
  });

  it('Q. XTTS 500 / Format not recognised → 返回专门的 actionableHint', () => {
    // 错误返回路径里能识别 "Format not recognised"
    expect(VENG).toMatch(/Format not recognised/i);
    // 包含具体的 actionableHint（不再笼统）
    expect(VENG).toMatch(/XTTS-v2 拒读了参考音频/);
  });

  it('R. _lastDetail 限制 body 截取长度（防止敏感数据泄漏）', () => {
    expect(VENG).toMatch(/_r\.text\.substring\(\s*0\s*,\s*200\s*\)/);
  });
});
