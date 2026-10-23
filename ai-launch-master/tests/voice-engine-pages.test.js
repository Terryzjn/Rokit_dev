// 录音页 + 语音引擎页 UI 文本锁定测试 (v1.20.6)
//
// 锁定：
//   1. 录音页面 footer 三个按钮：返回 / 跳过录音 / 下一步：选择语音生成方式
//   2. AI 演示 voiceNextStep = 13
//   3. step=13 渲染的「选择语音生成方式」页：
//      - 「本地语音模型」/「在线语音服务」两张卡片
//      - 默认测试文本
//      - 跳过测试 / 跳过引擎选择 行为
//      - 状态徽章颜色（CSS 变量）
//   4. step=14 占位页（字幕编辑）
//   5. IPC 调用名（preload）

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');

describe('v1.20.6 · 语音引擎 UI 锁定', () => {
  it('录音页面 footer：返回 / 跳过声音克隆 / 下一步：选择语音生成方式（v1.20.10 统一在 renderVoiceStudio）', () => {
    // v1.20.10：旧版有 inline <div id="vStudioFooterAiDemo"> 在 renderVoice 里独立渲染 footer，
    // 现在统一合并到 renderVoiceStudio 内的 <div class="vstudio-footer" id="vstudioFooter">，
    // 本地视频与 AI 录屏共用同一个 footer，按 voiceSource 切换 onclick / disabled。
    // 旧 inline footer 已废弃（assert 否定）
    expect(/vStudioFooterAiDemo/.test(INDEX)).toBe(false);
    // 新 footer 在 renderVoiceStudio
    expect(/id="vstudioFooter"/.test(INDEX)).toBe(true);
    // 返回按钮：始终是 returnFromVoiceStep
    expect(/onclick="returnFromVoiceStep\(\)"/.test(INDEX)).toBe(true);
    // 跳过声音克隆 / 下一步主按钮的 onclick 由 _skipOnClick / _isAiDemo 在 JS 里动态拼接；
    // 函数本身仍存在，并在 footer 拼接处被引用。
    expect(/window\.skipVoiceInAiDemo\b/.test(INDEX)).toBe(true);
    expect(/window\.proceedFromVoiceInAiDemo\b/.test(INDEX)).toBe(true);
    expect(/window\.skipVoiceInLocalVideo\b/.test(INDEX)).toBe(true);
    expect(/_skipOnClick[\s\S]{0,200}skipVoiceInAiDemo\(\)/.test(INDEX)).toBe(true);
    expect(/_skipOnClick[\s\S]{0,200}skipVoiceInLocalVideo\(\)/.test(INDEX)).toBe(true);
    expect(/proceedFromVoiceInAiDemo\(\)/.test(INDEX)).toBe(true); // 在拼接的 _nextBtn 内
    expect(/下一步：选择语音生成方式/.test(INDEX)).toBe(true);
    // 旧的「去打通平台」不应再出现在 footer 按钮文案
    var m = INDEX.match(/var _nextBtn[\s\S]{0,400}<\/button>/);
    expect(m).toBeTruthy();
    if (m) expect(m[0].indexOf('去打通平台')).toBe(-1);
  });

  it('AI 演示进入录音：voiceNextStep=13', () => {
    var m = INDEX.match(/window\.aiDemoNext=function\(\)\{([\s\S]*?)\};/);
    expect(m).toBeTruthy();
    expect(/state\.voiceNextStep\s*=\s*13/.test(m[1])).toBe(true);
  });

  it('step=13 渲染「选择语音生成方式」页', () => {
    expect(/else if\(s===13\)\{renderVoiceEngineStep\(ctrl\)\;/.test(INDEX)).toBe(true);
    expect(/function renderVoiceEngineStep\(ctrl\)/.test(INDEX)).toBe(true);
  });

  it('引擎选择页：本地 vs 在线 两张卡片', () => {
    expect(/LOCAL_MODEL/.test(INDEX)).toBe(true);
    expect(/ONLINE_SERVICE/.test(INDEX)).toBe(true);
    expect(/本地 AI 语音模型/.test(INDEX)).toBe(true);
    expect(/在线 AI 语音服务/.test(INDEX)).toBe(true);
    expect(/voiceEnginePickKind/.test(INDEX)).toBe(true);
  });

  it('默认测试文本与生成测试按钮', () => {
    expect(/Hello, this is a test of Rokit/.test(INDEX)).toBe(true);
    expect(/生成测试语音/.test(INDEX)).toBe(true);
    expect(/voiceEngineRunTest/.test(INDEX)).toBe(true);
  });

  it('检测连接按钮 + 地址输入', () => {
    expect(/检测连接/.test(INDEX)).toBe(true);
    expect(/veBaseUrl/.test(INDEX)).toBe(true);
    expect(/恢复默认地址/.test(INDEX)).toBe(true);
  });

  it('跳过测试 / 跳过引擎选择 / 下一步：编辑视频字幕', () => {
    expect(/跳过测试/.test(INDEX)).toBe(true);
    expect(/跳过引擎选择/.test(INDEX)).toBe(true);
    expect(/下一步：编辑视频字幕/.test(INDEX)).toBe(true);
  });

  it('step=14 字幕页占位', () => {
    expect(/else if\(s===14\)\{renderCaptionsStep\(ctrl\)\;/.test(INDEX)).toBe(true);
    expect(/function renderCaptionsStep\(ctrl\)/.test(INDEX)).toBe(true);
    expect(/字幕编辑界面尚未实现/.test(INDEX)).toBe(true);
  });

  it('UI 使用现有 CSS 变量（青绿色 / 中性色）', () => {
    // 引擎页用 var(--primary) 等
    expect(/var\(--primary\)/.test(INDEX)).toBe(true);
    expect(/var\(--muted\)/.test(INDEX)).toBe(true);
    expect(/var\(--line\)/.test(INDEX)).toBe(true);
  });

  it('状态徽章：正确区分「已测试通过 / 未验证 / 未通过 / 已连接」', () => {
    expect(/已测试通过/.test(INDEX)).toBe(true);
    expect(/跳过测试/.test(INDEX)).toBe(true);
    expect(/未通过/.test(INDEX)).toBe(true);
    expect(/已连接/.test(INDEX)).toBe(true);
  });

  it('preload.js 暴露 4 个 voice-engine:* IPC（不暴露 key）', () => {
    expect(/voiceEngineList:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('voice-engine:list'/.test(PRELOAD)).toBe(true);
    expect(/voiceEngineDefaults:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('voice-engine:defaults'/.test(PRELOAD)).toBe(true);
    expect(/voiceEngineProbe:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('voice-engine:probe'/.test(PRELOAD)).toBe(true);
    expect(/voiceEngineTestGenerate:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('voice-engine:test-generate'/.test(PRELOAD)).toBe(true);
  });

  it('主进程 IPC 不向日志泄露 baseUrl 或 配置 payload', () => {
    var main = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    // 抽取 voice-engine:* 四个 handler 块
    var blockProbe = main.match(/voice-engine:probe[\s\S]{0,800}/);
    var blockGenerate = main.match(/voice-engine:test-generate[\s\S]{0,1500}/);
    expect(blockProbe).toBeTruthy();
    expect(blockGenerate).toBeTruthy();
    if (blockProbe) {
      // 不应 logger.* 包含 baseUrl / config / payload
      expect(/logger\.[a-z]+\([^)]*baseUrl/.test(blockProbe[0])).toBe(false);
      expect(/logger\.[a-z]+\([^)]*config\.baseUrl/.test(blockProbe[0])).toBe(false);
    }
    if (blockGenerate) {
      expect(/logger\.[a-z]+\([^)]*baseUrl/.test(blockGenerate[0])).toBe(false);
      expect(/logger\.[a-z]+\([^)]*config\.baseUrl/.test(blockGenerate[0])).toBe(false);
    }
  });
});
