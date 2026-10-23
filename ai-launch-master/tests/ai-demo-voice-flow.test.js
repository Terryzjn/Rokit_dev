'use strict';

// v1.20.3：AI 演示 → 录音 → 下一步 导航流程锁定
//   关键约束（用户硬性要求）：
//     1. AI 演示页右下角"下一步"按钮文本 = "下一步：录制声音"（**不**再是"去打通平台"）
//     2. 点击后 state.step 跳到录音步骤（state.voiceSource = 'aiDemo'）
//     3. 录音步骤渲染**真正的**录音 UI（不是占位）
//     4. 录音步骤必须有「返回 AI 演示」/「跳过」/「下一步」三个按钮
//     5. 顶部导航栏**完全**没动
//   本文件用纯文本 grep 锁定这些源码约束。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('v1.20.3 · AI 演示 → 录音 导航锁定', () => {
  // 1) AI 演示页右下角"下一步"按钮文本 = "下一步：录制声音"
  //    v1.20.5：按钮已根据 aiDemoNextEnabled(d) 动态加 disabled 属性。
  it('AI 演示 saved-state 按钮已改为「下一步：录制声音」', () => {
    // 该按钮的 onclick = aiDemoNext()，body 必须包含 "下一步：录制声音"
    expect(/onclick="aiDemoNext\(\)"/.test(INDEX)).toBe(true);
    expect(/下一步：录制声音/.test(INDEX)).toBe(true);
    // **不再**有"去打通平台"按钮在该 choice 区里（旧的 goToPlatformsStage）
    var aiDemoBlockMatch = INDEX.match(/onclick="aiDemoNext\(\)"[\s\S]{0,800}<\/div>/);
    expect(aiDemoBlockMatch).toBeTruthy();
    if (aiDemoBlockMatch) {
      expect(aiDemoBlockMatch[0].indexOf('goToPlatformsStage()')).toBe(-1);
    }
    // v1.20.5：禁用时使用 disabled 属性 + 浅灰样式
    expect(/aiDemoNextEnabled\(/.test(INDEX)).toBe(true);
    expect(/<button[^>]*\bdisabled\b/.test(INDEX)).toBe(true);
  });

  // 2) 顶部导航栏**没动**——5 个 STAGES 数组不变
  it('顶部 STAGES 数组顺序与文字**未修改**', () => {
    expect(/var STAGES=\[\{name:'\u4ea4\u4ed8\u4f5c\u54c1'\},\{name:'AI \u8bca\u65ad'\},\{name:'\u5f55\u5c4f\u521b\u4f5c\u89c6\u9891'\},\{name:'\u9996\u79c0\u8ba1\u5212'\},\{name:'\u6253\u901a\u5e73\u53f0'\},\{name:'\u53d1\u5e03\u6e05\u5355'\}\]/.test(INDEX)).toBe(true);
  });

  // 3) aiDemoNext 跳转到录音步骤（state.step = 8），设置 voiceSource = 'aiDemo'，
  //    记录返回步骤 voiceReturnStep = 5（AI 演示页）。
  //    v1.20.6：voiceNextStep 从 11 改为 13（语音引擎选择）。
  it('aiDemoNext 跳到 step 8 录音并设 voiceSource=aiDemo（next=13 引擎选择）', () => {
    var fnMatch = INDEX.match(/window\.aiDemoNext=function\(\)\{([\s\S]*?)\};/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[1];
    expect(/state\.step\s*=\s*8/.test(body)).toBe(true);
    expect(/state\.voiceSource\s*=\s*'aiDemo'/.test(body)).toBe(true);
    expect(/state\.voiceReturnStep\s*=\s*5/.test(body)).toBe(true);
    expect(/state\.voiceNextStep\s*=\s*13/.test(body)).toBe(true);
    // **不再**直接调 goToPlatformsStage()（除非先经录音）
    expect(/goToPlatformsStage\(\)/.test(body)).toBe(false);
  });

  // 4) 录音步骤（renderVoice）有 AI 演示专用分支：当 voiceSource==='aiDemo' 时
  //    渲染**真正的**录音 UI（renderVoiceStudio）；v1.20.10 起本地视频路径也走同一份组件，
  //    底部 3 个按钮由 renderVoiceStudio 统一输出（共享 vstudioFooter）。
  it('renderVoice 在 voiceSource==="aiDemo"/localVideo 时调 renderVoiceStudio 渲染**真实**录音 UI', () => {
    var fnMatch = INDEX.match(/function renderVoice\(ctrl\)\{([\s\S]*?)(?=\n  function |\n  var __vRec)/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[1];
    // v1.20.10：单一分支条件 voiceSource === 'aiDemo' || voiceSource === 'localVideo'
    expect(/state\.voiceSource\s*===\s*'aiDemo'\s*\|\|\s*state\.voiceSource\s*===\s*'localVideo'/.test(body)).toBe(true);
    expect(/renderVoiceStudio\(\)/.test(body)).toBe(true);
    // 「返回 AI 自动演示」/「跳过录音」/「下一步：选择语音生成方式」现在都在 renderVoiceStudio 内的 vstudioFooter
    // —— 不再嵌在 renderVoice 函数体里。直接对 INDEX 全文断言即可。
    expect(/返回 AI 自动演示/.test(INDEX)).toBe(true);
    expect(/跳过声音克隆/.test(INDEX)).toBe(true);
    expect(/下一步：选择语音生成方式/.test(INDEX)).toBe(true);
  });

  // v1.20.6：step=13 已挂载为「选择语音生成方式」页面
  it('renderStep 包含 step=13 的 voice engine 页面（语音引擎选择）', () => {
    expect(/else if\(s===13\)\{renderVoiceEngineStep\(ctrl\)\;/.test(INDEX)).toBe(true);
    expect(/function renderVoiceEngineStep\(ctrl\)/.test(INDEX)).toBe(true);
    expect(/window\.voiceEnginePickKind\s*=/.test(INDEX)).toBe(true);
    expect(/window\.voiceEngineDetect\s*=/.test(INDEX)).toBe(true);
    expect(/window\.voiceEngineRunTest\s*=/.test(INDEX)).toBe(true);
    // 默认测试文本
    expect(/Hello, this is a test of Rokit/.test(INDEX)).toBe(true);
  });

  // 5) 三个 handler：returnFromVoiceStep / skipVoiceInAiDemo / proceedFromVoiceInAiDemo
  it('returnFromVoiceStep 回到 voiceReturnStep（不伪造声音档案）', () => {
    var fnMatch = INDEX.match(/window\.returnFromVoiceStep\s*=\s*function[^{]*\{([\s\S]*?)\};/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[1];
    expect(/state\.step\s*=\s*ret/.test(body)).toBe(true);
    expect(/state\.voiceSource\s*=\s*''/.test(body)).toBe(true);
  });

  it('skipVoiceInAiDemo 清空 voiceProfile / voiceCurrentVersionId（**不**伪造声音档案）', () => {
    var fnMatch = INDEX.match(/window\.skipVoiceInAiDemo\s*=\s*function[^{]*\{([\s\S]*?)\};/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[1];
    // 关键：清空 voiceProfile + voiceCurrentVersionId（**不**set fake blob）
    expect(/state\.voiceProfile\s*=\s*null/.test(body)).toBe(true);
    expect(/state\.voiceCurrentVersionId\s*=\s*null/.test(body)).toBe(true);
    // **不**走 renderVoice / **不**调 fillContent
    expect(/renderVoice\(\)/.test(body)).toBe(false);
  });

  it('proceedFromVoiceInAiDemo 未选档案时拒绝（不假装成功）', () => {
    var fnMatch = INDEX.match(/window\.proceedFromVoiceInAiDemo\s*=\s*function[^{]*\{([\s\S]*?)\};/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[1];
    // **没有**选 voiceProfile / voiceCurrentVersionId 时**必须**返回 + toast
    expect(/!state\.voiceProfile\s*\|\|\s*!state\.voiceCurrentVersionId/.test(body)).toBe(true);
    expect(/toast\(/.test(body)).toBe(true);
  });
});
