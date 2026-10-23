// Rokit · 微信公众号 v1.6：草稿创建成功即结束（不再调 freepublish/submit / freepublish/get）
//
// v1.4/v1.5 历史：该文件原本校验 v1.4「pObj is not defined」修复与成功路径 best-effort。
//   v1.6 调整后，整个 publish(poll) 链被移除，主流程路径变成「createDraft → finish(DRAFT_SAVED) → 结束」。
//   本文件保留 v1.4 的两条核心不变量（无 pObj 调用、成功路径整体被 try/catch 保护，
//   且 finish(DRAFT_SAVED) 先于 UI/markPub 调用），并把锚点换成 v1.6 的 success 分支。
//
//   同时新增 v1.6 校验：草稿成功 ≠ PUBLISHED、不再调 wechatPublish/wechatPublishStatus/IPC、
//   草稿超时走 UNKNOWN、STEP 枚举含 DRAFT_SAVED。
'use strict';

const fs = require('fs');
const path = require('path');

const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// 预编码字符串，避免在 Vitest 转换时与 unicode-escape 正则交互
const T = {
  draftSaved: '草稿已保存',
  pubBackendToDraftBox: '公众号后台', // 检查下方是否有「草稿箱」
  draftBox: '草稿箱',
  alreadyGroupSent: '已成功群发',
  alreadyPublishedToWx: '已成功发布到微信',
  draftTimeout: '草稿创建请求超时',
  resultUnknown: '结果未知',
};

// 提取 _runWechatPublishFlow 函数体
function extractFlowBody(){
  var startIdx = htmlSrc.indexOf('window._runWechatPublishFlow = function(payload){');
  if(startIdx < 0) return '';
  var endIdx = htmlSrc.indexOf('window.launch=function()', startIdx);
  if(endIdx < 0) return '';
  return htmlSrc.slice(startIdx, endIdx);
}

// 提取 createDraft().then(function(dr){ ... }) 链式回调体（花括号配对，含字符串/注释）
function extractDraftThenBody(){
  var fnStart = htmlSrc.indexOf('window._runWechatPublishFlow = function(payload){');
  var fnEnd = htmlSrc.indexOf('window.launch=function()', fnStart);
  var all = htmlSrc.slice(fnStart, fnEnd);
  var start = all.indexOf('return createDraft().then(function(dr){');
  if(start < 0) return '';
  var braceStart = start + 'return createDraft().then(function(dr){'.length;
  var depth = 1;
  var i = braceStart;
  var inStr = null;
  while(i < all.length){
    var ch = all[i];
    if(inStr){
      if(ch === '\\'){ i += 2; continue; }
      if(ch === inStr) inStr = null;
      i++;
      continue;
    }
    if(ch === '"' || ch === "'" || ch === '`'){ inStr = ch; i++; continue; }
    if(ch === '/' && i + 1 < all.length && all[i + 1] === '/'){
      var nl = all.indexOf('\n', i);
      i = nl < 0 ? all.length : nl + 1;
      continue;
    }
    if(ch === '/' && i + 1 < all.length && all[i + 1] === '*'){
      var end2 = all.indexOf('*/', i + 2);
      i = end2 < 0 ? all.length : end2 + 2;
      continue;
    }
    if(ch === '{') depth++;
    else if(ch === '}'){
      depth--;
      if(depth === 0){ return all.slice(start, i + 1); }
    }
    i++;
  }
  return '';
}

// 提取草稿成功分支（task.mediaId = dr.mediaId || task.mediaId; 起的 fast-path 体）
function extractDraftSuccessBranch(){
  var draft = extractDraftThenBody();
  var m = draft.indexOf('task.mediaId = dr.mediaId || task.mediaId;');
  if(m < 0) return '';
  return draft.slice(m);
}

describe('微信公众号 v1.6：草稿即结束 — 不变量', () => {
  it('v1.6：_runWechatPublishFlow 不应再调用 pObj(...)（v1.4 历史 bug 修复保留）', () => {
    var fn = extractFlowBody();
    expect(fn.length).toBeGreaterThan(1000);
    expect(fn).not.toMatch(/pObj\s*\(\s*['"]wechat['"]\s*\)/);
    expect(fn).not.toMatch(/pObj\(['"]wechat['"]\)\.name/);
    // 不应在 _runWechatPublishFlow 体内残留任何 pObj 标识符引用（包括注释里）
    expect(fn).not.toMatch(/\bpObj\b/);
  });

  it('v1.6：成功路径必须用 try/catch 包裹 setUiState / toast / markPub / rocket（≥4 处）', () => {
    var sb = extractDraftSuccessBranch();
    expect(sb.length).toBeGreaterThan(50);
    var tryCount = (sb.match(/try\s*\{/g) || []).length;
    expect(tryCount).toBeGreaterThanOrEqual(4);
  });

  it('v1.6：成功路径顺序必须是 finish → setUiState → markPub（finish 关闭任务最先调用）', () => {
    var sb = extractDraftSuccessBranch();
    var idxFinish = sb.indexOf('finish(STEP.DRAFT_SAVED');
    var idxUi = sb.indexOf('setUiState(STEP.DRAFT_SAVED');
    var idxMark = sb.indexOf('markPub(');
    expect(idxFinish).toBeGreaterThan(-1);
    expect(idxUi).toBeGreaterThan(idxFinish);
    expect(idxMark).toBeGreaterThan(idxUi);
  });

  it('v1.6：UI 文案必须明确说「草稿已保存」而不是「已成功群发」', () => {
    var fn = extractFlowBody();
    // 整函数体内应有"草稿已保存"
    expect(fn).toContain(T.draftSaved);
    // 指向"公众号后台 ... 草稿箱"
    var i1 = fn.indexOf(T.pubBackendToDraftBox);
    var i2 = fn.indexOf(T.draftBox, i1);
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    // 主流程（草稿成功分支）不应再出现 v1.4 文案「已成功群发」/「已成功发布到微信」
    var sb = extractDraftSuccessBranch();
    expect(sb).not.toContain(T.alreadyGroupSent);
    expect(sb).not.toContain(T.alreadyPublishedToWx);
  });

  it('v1.6：草稿成功回调本身不应再调 wechatPublish / wechatPublishStatus（提交链路已去除）', () => {
    var draft = extractDraftThenBody();
    expect(draft).not.toMatch(/window\.api\.wechatPublish\s*\(/);
    expect(draft).not.toMatch(/window\.api\.wechatPublishStatus\s*\(/);
    expect(draft).not.toMatch(/submitPublish\s*\(/);
    expect(draft).not.toMatch(/pollStatus\s*\(/);
  });

  it('v1.6：STEP 枚举必须含 DRAFT_SAVED，避免静默落到 PUBLISHED 状态', () => {
    var fn = extractFlowBody();
    expect(fn).toMatch(/DRAFT_SAVED:\s*['"]draft_saved['"]/);
  });

  it('v1.6：草稿超时必须标记为 UNKNOWN（结果未知不假装成功也不盲目重发）', () => {
    var draft = extractDraftThenBody();
    expect(draft).toMatch(/dr\.status\s*===\s*['"]timeout['"]/);
    expect(draft).toMatch(/finish\(STEP\.UNKNOWN/);
    expect(draft).toContain(T.draftTimeout);
    expect(draft).toContain(T.resultUnknown);
    // 超时分支不应再次调 createDraft
    var start = draft.indexOf("dr.status === 'timeout'");
    var endPos = draft.indexOf('return;', start);
    var branch = draft.slice(start, endPos);
    expect(branch).not.toMatch(/createDraft\s*\(/);
  });
});
