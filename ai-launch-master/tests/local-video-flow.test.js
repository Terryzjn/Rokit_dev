'use strict';

// v1.20.10：本地视频 → **完全复用** AI 录屏录音界面（renderVoiceStudio）。
//   用户硬性要求：
//     1. 第一步"选择本地视频 / AI 自动演示项目"界面**完全不变**。
//     2. 本地视频路径进入录音界面时，**与 AI 录屏路径进入的是同一个 renderVoiceStudio 组件**。
//        （不复制代码、不另造一套界面、不嵌入到 step 5 形成上下两套重复界面）
//     3. 唯一差异：底部"跳过声音克隆"按钮按流程来源切换 enabled：
//         AI 录屏来源：按钮始终 disabled。
//         本地视频来源：按钮始终 enabled，点击 → state.step=10（首秀计划）。
//     4. AI 录屏路径原有行为完全不变（button text、proceedFromVoiceInAiDemo 等）。
//     5. 跳过录音只影响本次流程，不删除 / 不覆盖已有声音档案 / 录音版本 / 视频文件。
//     6. 流程来源通过 state.voiceSource 显式区分（'aiDemo' / 'localVideo'），不依赖文件名 / 音频存在性。
//   本文件用纯文本 grep 锁定这些源码约束（全部为静态分析，不启动 Electron）。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function extractWindowFn(name) {
  var re = new RegExp('window\\.' + name + '\\s*=\\s*(?:async\\s+)?function\\s*\\(\\)\\s*\\{');
  var m = RAW.match(re);
  if (!m) return null;
  var start = m.index + m[0].length;
  var depth = 1, i = start;
  while (i < RAW.length && depth > 0) {
    var ch = RAW.charAt(i);
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return RAW.slice(start, i - 1);
}

function extractFunction(name) {
  var re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  var m = RAW.match(re);
  if (!m) return null;
  var start = m.index + m[0].length;
  var depth = 1, i = start;
  while (i < RAW.length && depth > 0) {
    var ch = RAW.charAt(i);
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return RAW.slice(start, i - 1);
}

function stripLineComments(s) {
  return s.replace(/^(\s*)\/\/.*$/gm, '');
}

describe('v1.20.10 · 本地视频 → 完全复用 AI 录屏录音界面（renderVoiceStudio）', () => {

  // —— A. 第一步界面（选择本地视频 / AI 自动演示项目）保持不变 ——
  it('A. 第一步"选择本地视频 / AI 自动演示项目"按钮和文案保持不变', () => {
    expect(RAW).toMatch(/onclick="pickLocalVideo\(\)"/);
    expect(RAW).toMatch(/onclick="openAiDemoWorkspace\(\)"/);
    expect(RAW).toMatch(/本地视频/);
    expect(RAW).toMatch(/AI 自动演示项目/);
    expect(RAW).toMatch(/选择本地视频，或启动 AI 自动演示项目/);
  });

  // —— B. openLocalVoiceStep：进入 voice step，复用 renderVoice ——
  it('B. openLocalVoiceStep 设置 voiceSource="localVideo"，step=8，voiceReturnStep=5', () => {
    var body = extractWindowFn('openLocalVoiceStep');
    expect(body).toBeTruthy();
    expect(body).toMatch(/state\.voiceSource\s*=\s*'localVideo'/);
    expect(body).toMatch(/state\.voiceReturnStep\s*=\s*5/);
    expect(body).toMatch(/state\.voiceSkip\s*=\s*false/);
    expect(body).toMatch(/state\.step\s*=\s*8/);
    expect(body).toMatch(/renderFlow\(\)/);
    expect(body).toMatch(/请先选择一个本地视频/);
  });

  // —— C. skipVoiceInLocalVideo：跳过直达 step 10（首秀计划），无校验 ——
  it('C. skipVoiceInLocalVideo 直接 state.step=10，且不要求声音档案 / voiceProfile', () => {
    var body = extractWindowFn('skipVoiceInLocalVideo');
    expect(body).toBeTruthy();
    expect(body).toMatch(/state\.step\s*=\s*10/);
    expect(body).toMatch(/renderFlow\(\)/);
    var stripped = stripLineComments(body);
    expect(stripped).not.toMatch(/state\.voiceProfile\s*=/);
    expect(stripped).not.toMatch(/state\.voiceCurrentVersionId\s*=/);
    expect(body).toMatch(/state\.voiceSkip\s*=\s*true/);
    expect(body).toMatch(/state\.voiceSource\s*=\s*''/);
    expect(body).toMatch(/请先选择一个本地视频/);
    expect(body).toMatch(/stopRecording/);
  });

  // —— D. renderVoice 不再单独为 localVideo 复制分支 —— 共用 aiDemo 分支；不再加顶部 banner 卡片 ——
  it('D. renderVoice 把 aiDemo / localVideo 合并到同一份分支，调用同一个 renderVoiceStudio（无顶部 banner）', () => {
    var body = extractFunction('renderVoice');
    expect(body).toBeTruthy();
    // 单分支条件：voiceSource === 'aiDemo' || voiceSource === 'localVideo'
    expect(body).toMatch(/state\.voiceSource\s*===\s*'aiDemo'\s*\|\|\s*state\.voiceSource\s*===\s*'localVideo'/);
    // 必须调 renderVoiceStudio 一次
    expect(body).toMatch(/renderVoiceStudio\(\)/);
    // 不允许出现"跳过录音，进入首秀计划"这种新增第二个跳过按钮的文字
    expect(body).not.toMatch(/跳过录音，进入首秀计划/);
    // 不允许出现 skipLocalVoiceToPlan（旧版单独跳过函数）
    expect(body).not.toMatch(/skipLocalVoiceToPlan\(/);
    // v1.20.10：renderVoice 不再渲染任何顶部 banner 卡片（rec-stage 横幅）—— 用户反馈图一这个横幅要去掉
    var stripped = stripLineComments(body);
    expect(stripped).not.toMatch(/class="rec-stage"[^>]*border-color:var\(--primary\)/);
    expect(stripped).not.toMatch(/v1\.20\.7 · AI 演示流程/);
    expect(stripped).not.toMatch(/v1\.20\.10 · 本地视频流程/);
  });

  // —— E. 本地视频 stage 已选择分支**仅作为返回入口**，不再有录音入口；选完直接进图二 ——
  it('E. 本地视频 stage 不再渲染配音卡片 / 声音档案 inline 列表 / 录音入口（仅保留重新选择 / 删除）', () => {
    var body = extractFunction('renderLocalVideoStage');
    expect(body).toBeTruthy();
    var stripped = stripLineComments(body);
    // 已选择分支里不再调 openLocalVoiceStep（首选路径走 pickLocalVideo 直跳图二）
    expect(stripped).not.toMatch(/openLocalVoiceStep\(\)/);
    // 禁止出现旧的 openVoiceStudioModal 调用
    expect(stripped).not.toMatch(/openVoiceStudioModal\(\)/);
    // 不再调用 renderVoiceProfilesListInline（不再在 step 5 内联渲染档案）
    expect(stripped).not.toMatch(/renderVoiceProfilesListInline\(\)/);
    // 不再出现 id="vInlineList" / id="voiceQuickSummary" 节点
    expect(stripped).not.toMatch(/id="vInlineList"/);
    expect(stripped).not.toMatch(/id="voiceQuickSummary"/);
    // 不再出现旧的 "▶ 下一步：录制配音" 卡片标题
    expect(stripped).not.toMatch(/下一步：录制配音/);
    expect(stripped).not.toMatch(/录制你的声音[\s\S]{0,40}v1\.20\.3/);
  });

  // —— E2. 选完本地视频**直接进入图二**（pickLocalVideo 成功 → openLocalVoiceStep），不出现新页面 ——
  it('E2. pickLocalVideo 成功分支直接 openLocalVoiceStep()，不出现新的中间页', () => {
    var body = extractWindowFn('pickLocalVideo');
    expect(body).toBeTruthy();
    // 成功分支：state.videoAsset=r.asset 之后必须调 openLocalVoiceStep()
    var successBlock = body.match(/if\s*\(\s*r\s*&&\s*r\.ok\s*&&\s*r\.asset\s*\)\s*\{([\s\S]*?)\}\s*else/);
    expect(successBlock).toBeTruthy();
    expect(successBlock[1]).toMatch(/openLocalVoiceStep\(\)/);
    // 不再调 renderLocalVideoStage 作为首选展示
    var stripped = stripLineComments(successBlock[1]);
    expect(stripped).not.toMatch(/renderLocalVideoStage\(/);
  });

  // —— F. renderVoiceStudio 底部"跳过声音克隆"按钮按 voiceSource 切换 onclick / disabled ——
  it('F. 录音界面底部"跳过声音克隆"按钮按 voiceSource 区分 onclick 与 disabled', () => {
    // 1) "跳过声音克隆"按钮（HTML label）**仅**出现在 vstudioFooter 中一次
    var btnMatches = RAW.match(/>跳过声音克隆<\/button>/g) || [];
    expect(btnMatches.length).toBe(1); // 唯一的按钮
    // 2) 切出包含 _isAiDemo / _skipOnClick / vstudioFooter 的连续片段
    var sectionStart = RAW.indexOf('var _isAiDemo');
    var sectionEnd   = RAW.indexOf('id="vstudioFooter"');
    expect(sectionStart).toBeGreaterThan(0);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    var fb = RAW.slice(sectionStart, sectionEnd + 800);
    // 3) disabled 属性来自 voiceSource 判断（AI 演示 → disabled；本地视频 → 不带 disabled）
    expect(fb).toMatch(/_isAiDemo[\s\S]{0,400}disabled/);
    expect(fb).toMatch(/_skipOnClick[\s\S]{0,200}skipVoiceInAiDemo\(\)/);
    expect(fb).toMatch(/_skipOnClick[\s\S]{0,200}skipVoiceInLocalVideo\(\)/);
    // 4) 不允许出现"跳过录音，进入首秀计划"这种新增第二个跳过按钮
    expect(fb).not.toMatch(/跳过录音，进入首秀计划/);
    // 5) 允许在 vstudioFooter 外出现 toast / confirm / pushAI 文案（不影响功能）
  });

  // —— F2. 录音界面右下"下一步：选择语音生成方式 →"按钮（按钮 B）：两个来源下都进 step 13 = 选择语音生成方式页面 ——
  it('F2. 按钮 B（"下一步：选择语音生成方式"）在两个来源下都进 step 13（不允许本地视频下直接跳首秀计划）', () => {
    var sectionStart = RAW.indexOf('var _isAiDemo');
    var sectionEnd   = RAW.indexOf('id="vstudioFooter"');
    expect(sectionStart).toBeGreaterThan(0);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    var fb = RAW.slice(sectionStart, sectionEnd + 1200);
    // 1) 两个来源下按钮 B 都挂 proceedFromVoiceInAiDemo()（不允许挂 skipVoiceInLocalVideo）
    var nextBtnMatches = fb.match(/id="vstudioNextBtn"\s+onclick="proceedFromVoiceInAiDemo\(\)"/g) || [];
    expect(nextBtnMatches.length).toBeGreaterThanOrEqual(2);
    // 2) 按钮 B 在 _nextBtn 三元两侧都挂 proceedFromVoiceInAiDemo（不允许 _isLocalVideo 分支挂 skipVoiceInLocalVideo）
    expect(fb).toMatch(/\?[^]*proceedFromVoiceInAiDemo\(\)[^]*proceedFromVoiceInAiDemo\(\)/);
    // 3) 按钮 A「跳过声音克隆」在本地视频路径下挂 skipVoiceInLocalVideo（不带 disabled）
    //   源码 onclick 是动态拼接（onclick="' + _skipOnClick + '"'），按 _skipOnClick 变量赋值锁定
    expect(fb).toMatch(/_skipOnClick[\s\S]{0,200}skipVoiceInLocalVideo\(\)/);
    // 4) **不允许** 按钮 B 走 skipVoiceInLocalVideo（这是 v1.20.10 紧急回归修复的关键）
    expect(fb).not.toMatch(/id="vstudioNextBtn"\s+onclick="skipVoiceInLocalVideo\(\)"/);
  });

  // —— G. AI 录屏流程原有行为完全不变 ——
  it('G. AI 录屏路径 voiceSource="aiDemo" 走原通道，跳到 step 8 + 下一站 = 13（语音引擎选择）', () => {
    var body = extractWindowFn('aiDemoNext');
    expect(body).toBeTruthy();
    expect(body).toMatch(/state\.step\s*=\s*8/);
    expect(body).toMatch(/state\.voiceSource\s*=\s*'aiDemo'/);
    expect(body).toMatch(/state\.voiceReturnStep\s*=\s*5/);
    expect(body).toMatch(/state\.voiceNextStep\s*=\s*13/);
  });

  // —— M. v1.20.10 紧急回归修复：跳过按钮导航防御 ——
  it('M. skipVoiceInLocalVideo 强校验：voiceSource !== localVideo 时直接拒绝', () => {
    var body = extractWindowFn('skipVoiceInLocalVideo');
    expect(body).toBeTruthy();
    var stripped = stripLineComments(body);
    // 必须有 source 校验分支
    expect(stripped).toMatch(/state\.voiceSource\s*[!=]==?\s*['"]localVideo['"]/);
    // 必须有 videoAsset 校验分支（正向 / 反向都允许）
    expect(stripped).toMatch(/state\.videoAsset[\s\S]{0,30}state\.videoAsset\.id/);
    // 必须直接置 state.step = 10（首秀计划），不走 voiceNextStep
    expect(stripped).toMatch(/state\.step\s*=\s*10/);
    expect(stripped).not.toMatch(/proceedFromVoiceInAiDemo/);
    expect(stripped).not.toMatch(/skipVoiceInAiDemo/);
  });

  // —— N. v1.20.10 紧急回归修复：openAiDemoWorkspace 切回 AI 录屏时清空 voiceSource 等残留 ——
  it('N. openAiDemoWorkspace 进入 AI 录屏时清空 voiceSource / voiceSkip / voiceReturnStep / voiceNextStep', () => {
    var body = extractWindowFn('openAiDemoWorkspace');
    expect(body).toBeTruthy();
    expect(body).toMatch(/state\.voiceSource\s*=\s*['"]['"]/);
    expect(body).toMatch(/state\.voiceSkip\s*=\s*false/);
    expect(body).toMatch(/state\.voiceReturnStep\s*=\s*null/);
    expect(body).toMatch(/state\.voiceNextStep\s*=\s*null/);
    // 不允许删 state.voiceProfiles（已有声音档案）
    expect(body).not.toMatch(/state\.voiceProfiles\s*=\s*(null|\[\])/);
    // 不允许删 state.videoAsset
    expect(body).not.toMatch(/state\.videoAsset\s*=\s*null/);
  });

  // —— O. v1.20.10 紧急回归修复：findWork 找不到时返回 null，不再回退到示例作品 ——
  it('O. findWork 找不到时返回 null，不再回退到 state.works[0]', () => {
    var fnMatch = RAW.match(/function findWork\([\s\S]*?\n  \}/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[0];
    // 必须有 null 兜底
    expect(body).toMatch(/return\s+null\s*;/);
    // 不允许出现 "return state.works[0]" 这种危险回退
    expect(body).not.toMatch(/return\s+state\.works\[0\]/);
  });

  // —— H. 流程来源通过 state.voiceSource 显式区分（不是文件名 / 音频存在） ——
  it('H. 流程来源判定统一走 state.voiceSource，不依赖文件名 / 音频存在', () => {
    var demos = (RAW.match(/voiceSource\s*===\s*'(?:aiDemo|localVideo)'/g) || []);
    expect(demos.length).toBeGreaterThanOrEqual(3);
    expect(RAW).toMatch(/voiceSource.*localVideo/);
    expect(RAW).not.toMatch(/if\s*\(\s*state\.videoUrl\s*\)/);
  });

  // —— I. skipVoiceInLocalVideo 内部不调任何声音档案校验 ——
  it('I. skipVoiceInLocalVideo 内部不调用任何声音档案校验', () => {
    var body = extractWindowFn('skipVoiceInLocalVideo');
    expect(body).toBeTruthy();
    var stripped = stripLineComments(body);
    expect(stripped).not.toMatch(/voiceValidate|validateVoice|requireVoice|proceedFromVoice|hasProfile|hasSkipped/);
  });

  // —— J. 不再允许旧的"第二个跳过按钮"或旧函数 skipLocalVoiceToPlan ——
  it('J. 不存在旧的 skipLocalVoiceToPlan / "跳过录音，进入首秀计划" 按钮', () => {
    expect(RAW).not.toMatch(/window\.skipLocalVoiceToPlan\b/);
    expect(RAW).not.toMatch(/onclick="skipLocalVoiceToPlan\(\)"/);
    expect(RAW).not.toMatch(/跳过录音，进入首秀计划/);
  });

  // —— K. render modal 不再被 localVideo 单独复制 ——
  it('K. 录音界面整体不出现 renderPlanStage 渲染逻辑（不污染 step 10 页面）', () => {
    var rvBody = extractFunction('renderVoice');
    expect(rvBody).toBeTruthy();
    var rvsBody = extractFunction('renderVoiceStudio');
    expect(rvsBody).toBeTruthy();
    expect(rvBody).not.toMatch(/renderPlanStage/);
    expect(rvsBody).not.toMatch(/renderPlanStage/);
  });

  // —— L. openVoiceStudioModal 单一定义 + 关闭路径安全（保留前次硬化） ——
  it('L. openVoiceStudioModal 仅单一定义，关闭按钮 hook 不会失效', () => {
    var defs = (RAW.match(/window\.openVoiceStudioModal\s*=\s*function/g) || []);
    expect(defs.length).toBe(1);
    var body = extractWindowFn('openVoiceStudioModal');
    expect(body).toBeTruthy();
    expect(body).toMatch(/getElementById\('vStudioModal'\)/);
    expect(body).toMatch(/parentNode\.removeChild/);
    expect(body).toMatch(/closed\s*=\s*true/);
    expect(body).toMatch(/setTimeout\(/);
    expect(body).toMatch(/vStudioCloseBtn/);
    expect(body).toMatch(/keydown/);
    expect(body).toMatch(/Escape/);
  });
});
