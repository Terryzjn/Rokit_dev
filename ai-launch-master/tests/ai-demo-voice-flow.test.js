'use strict';

// 录屏（手动录屏）→ 录音 → 下一步 导航流程锁定
//   关键约束：
//     1. 录屏确认页右下角"下一步"按钮文本 = "下一步：录制声音"（**不**再是"去打通平台"）
//     2. 点击后 state.step 跳到录音步骤（state.voiceSource = 'manualRec'）
//     3. 录音步骤渲染**真正的**录音 UI（不是占位）
//     4. 录音步骤必须有「返回手动录屏」/「跳过」/「下一步」三个按钮
//     5. 顶部导航栏**完全**没动
//   本文件用纯文本 grep 锁定这些源码约束。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('录屏 → 录音 导航锁定', () => {
  // 1) 录屏确认页右下角"下一步"按钮文本 = "下一步：录制声音"
  it('录屏完成页「下一步」按钮为「下一步：录制声音」', () => {
    // 该按钮的 onclick = manualRecordingNext()，body 必须包含 "下一步：录制声音"
    expect(/onclick="manualRecordingNext\(\)"/.test(INDEX)).toBe(true);
    expect(/下一步：录制声音/.test(INDEX)).toBe(true);
    // **不再**有"去打通平台"按钮在该 choice 区里（旧的 goToPlatformsStage）
    var blockMatch = INDEX.match(/onclick="manualRecordingNext\(\)"[\s\S]{0,800}<\/div>/);
    expect(blockMatch).toBeTruthy();
    if (blockMatch) {
      expect(blockMatch[0].indexOf('goToPlatformsStage()')).toBe(-1);
    }
    // 禁用时使用 disabled 属性 + 浅灰样式
    expect(/__manualNextEnabled\(/.test(INDEX)).toBe(true);
    expect(/<button[^>]*\bdisabled\b/.test(INDEX)).toBe(true);
  });

  // 2) 顶部导航栏**没动**——STAGES 数组不变
  it('顶部 STAGES 数组顺序与文字**未修改**', () => {
    expect(/var STAGES=\[\{name:'\u4ea4\u4ed8\u4f5c\u54c1'\},\{name:'AI \u8bca\u65ad'\},\{name:'\u5f55\u5c4f\u521b\u4f5c\u89c6\u9891'\},\{name:'\u6253\u901a\u5e73\u53f0'\},\{name:'\u53d1\u5e03\u6e05\u5355'\},\{name:'\u9996\u79c0\u8ba1\u5212'\}\]/.test(INDEX)).toBe(true);
  });

  // 3) manualRecordingNext 跳转到录音步骤（state.step = 8），设置 voiceSource = 'manualRec'，
  //    记录返回步骤 voiceReturnStep = 5（录屏确认页）。
  //    voiceNextStep = 13（语音引擎选择）。
  it('manualRecordingNext 跳到 step 8 录音并设 voiceSource=manualRec（next=13 引擎选择）', () => {
    var fnMatch = INDEX.match(/window\.manualRecordingNext\s*=\s*function[^{]*\{([\s\S]*?)\};/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[1];
    expect(/state\.step\s*=\s*8/.test(body)).toBe(true);
    expect(/state\.voiceSource\s*=\s*'manualRec'/.test(body)).toBe(true);
    expect(/state\.voiceReturnStep\s*=\s*5/.test(body)).toBe(true);
    expect(/state\.voiceNextStep\s*=\s*13/.test(body)).toBe(true);
    // **不再**直接调 goToPlatformsStage()（除非先经录音）
    expect(/goToPlatformsStage\(\)/.test(body)).toBe(false);
  });

  // 4) 录音步骤（renderVoice）有录屏专用分支：当 voiceSource==='manualRec' 时
  //    渲染**真正的**录音 UI（renderVoiceStudio）；本地视频路径也走同一份组件，
  //    底部 3 个按钮由 renderVoiceStudio 统一输出（共享 vstudioFooter）。
  it('renderVoice 在 voiceSource==="localVideo"/manualRec 时调 renderVoiceStudio 渲染**真实**录音 UI', () => {
    var fnMatch = INDEX.match(/function renderVoice\(ctrl\)\{([\s\S]*?)(?=\n  function |\n  var __vRec)/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[1];
    // 单一分支条件 voiceSource === 'localVideo' || voiceSource === 'manualRec'
    expect(/state\.voiceSource\s*===\s*'localVideo'\s*\|\|\s*state\.voiceSource\s*===\s*'manualRec'/.test(body)).toBe(true);
    expect(/renderVoiceStudio\(\)/.test(body)).toBe(true);
    // 「返回视频选择」/「跳过声音克隆」/「下一步：选择语音生成方式」都在 renderVoiceStudio 内的 vstudioFooter
    expect(/返回视频选择/.test(INDEX)).toBe(true);
    expect(/跳过声音克隆/.test(INDEX)).toBe(true);
    expect(/下一步：选择语音生成方式/.test(INDEX)).toBe(true);
  });

  // step=13 已挂载为「选择语音生成方式」页面
  it('renderStep 包含 step=13 的 voice engine 页面（语音引擎选择）', () => {
    expect(/else if\(s===13\)\{renderVoiceEngineStep\(ctrl\)\;/.test(INDEX)).toBe(true);
    expect(/function renderVoiceEngineStep\(ctrl\)/.test(INDEX)).toBe(true);
    expect(/window\.voiceEnginePickKind\s*=/.test(INDEX)).toBe(true);
    expect(/window\.voiceEngineDetect\s*=/.test(INDEX)).toBe(true);
    expect(/window\.voiceEngineRunTest\s*=/.test(INDEX)).toBe(true);
    // 默认测试文本
    expect(/Hello, this is a test of Rokit/.test(INDEX)).toBe(true);
  });

  // 三个 handler：returnFromVoiceStep / skipVoiceInRecording / proceedFromVoice
  it('returnFromVoiceStep 回到 voiceReturnStep（不伪造声音档案）', () => {
    var fnMatch = INDEX.match(/window\.returnFromVoiceStep\s*=\s*function[^{]*\{([\s\S]*?)\};/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[1];
    expect(/state\.step\s*=\s*ret/.test(body)).toBe(true);
    expect(/state\.voiceSource\s*=\s*''/.test(body)).toBe(true);
    // 清理手动录屏资源（不再是 AI 演示资源）
    expect(/__manualDispose/.test(body)).toBe(true);
  });

  it('skipVoiceInRecording 清空 voiceProfile / voiceCurrentVersionId（**不**伪造声音档案）', () => {
    var fnMatch = INDEX.match(/window\.skipVoiceInRecording\s*=\s*function[^{]*\{([\s\S]*?)\};/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[1];
    // 关键：清空 voiceProfile + voiceCurrentVersionId（**不**set fake blob）
    expect(/state\.voiceProfile\s*=\s*null/.test(body)).toBe(true);
    expect(/state\.voiceCurrentVersionId\s*=\s*null/.test(body)).toBe(true);
    // **不**走 renderVoice / **不**调 fillContent
    expect(/renderVoice\(\)/.test(body)).toBe(false);
  });

  it('proceedFromVoice 未选档案时拒绝（不假装成功）', () => {
    var fnMatch = INDEX.match(/window\.proceedFromVoice\s*=\s*function[^{]*\{([\s\S]*?)\};/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[1];
    // **没有**选 voiceProfile / voiceCurrentVersionId 时**必须**返回 + toast
    expect(/!hasProfile && !hasSkipped/.test(body)).toBe(true);
    expect(/hasProfile\s*=\s*!!\(state\.voiceProfile && state\.voiceCurrentVersionId\)/.test(body)).toBe(true);
    expect(/toast\(/.test(body)).toBe(true);
  });
});
