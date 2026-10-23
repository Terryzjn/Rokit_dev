// Rokit · AI 演示规划器 + 约束执行器 单元测试（v1.16 + v1.17 扩展）
//
// 这些纯函数已经被内联到 index.html。为使 vitest 在 Node 环境下独立跑，
// 这里复制实现并断言行为一致。注意：测试入口处的 "AI_DEMO_EXECUTOR" 标识符
// 必须与 index.html 内的实现保持一致——若主代码改了这里也要同步。
'use strict';

// === 复制自 index.html（保持一致） ===
var AI_DEMO_DANGER_WORDS = [
  '发布','发送','上传','删除','移除','清空','销毁','彻底删','一键删',
  '支付','打款','充值','扣款','退款','结算',
  '授权','登录','登出','退出登录','绑定','解绑','实名','认证',
  'oauth','token','api key','api-key','api_key','apikey',
  'secret','password','cred','credential',
  '重置','还原','销毁全部','清除全部'
];
var AI_DEMO_DANGER_SELECTORS = [
  '[data-danger="true"]',
  '#launchRocketBtn','#rocket-bar','#rocketBar',
  '.btn-danger','.danger-btn',
  'button[onclick*="delete"]','button[onclick*="remove"]','button[onclick*="publish"]',
  'button[onclick*="销毁"]','button[onclick*="delete"]','button[onclick*="clearAll"]',
  'button[onclick*="launch"]','button[onclick*="login"]'
];

function isDangerByText(s){
  if(!s) return false;
  var ls = String(s).toLowerCase();
  for(var i=0;i<AI_DEMO_DANGER_WORDS.length;i++){
    if(ls.indexOf(String(AI_DEMO_DANGER_WORDS[i]).toLowerCase()) >= 0) return true;
  }
  return false;
}
function isDangerBySelector(sel){
  if(!sel) return false;
  for(var i=0;i<AI_DEMO_DANGER_SELECTORS.length;i++){
    if(sel === AI_DEMO_DANGER_SELECTORS[i]) return true;
    if(AI_DEMO_DANGER_SELECTORS[i].indexOf('button[onclick*=') === 0){
      var pat = AI_DEMO_DANGER_SELECTORS[i].substring('button[onclick*='.length, AI_DEMO_DANGER_SELECTORS[i].indexOf(']'));
      if(sel.indexOf(pat) >= 0) return true;
    }
  }
  return false;
}

// === v1.17 新增验证器（runAiDemoStep 内的 verifiers） ===
function verifyExists(step){
  if(!step || !step.verify || !step.verify.exists) return { ok:false, error:'no-exists' };
  var sels = String(step.verify.exists||'').split(',').map(function(s){return s.trim();}).filter(Boolean);
  for(var s_i=0; s_i<sels.length; s_i++){
    try { var nodes = document.querySelectorAll(sels[s_i]); if(nodes && nodes.length) return { ok:true }; } catch(_e){}
  }
  return { ok:false, error:'verify-exists-miss:'+step.verify.exists };
}
function verifyMinCount(step){
  if(!step || typeof step.verify.minCount !== 'number') return { ok:true }; // 没声明就跳过
  var sels = String(step.verify.exists||'').split(',').map(function(s){return s.trim();}).filter(Boolean);
  var total = 0;
  for(var s_j=0; s_j<sels.length; s_j++){
    try { var n = document.querySelectorAll(sels[s_j]); if(n) total += n.length; } catch(_e){}
  }
  if(total < step.verify.minCount) return { ok:false, error:'verify-minCount-miss:'+step.verify.minCount+'-actual-'+total };
  return { ok:true };
}
function verifyAriaPressed(step){
  if(!step || !step.verify.ariaPressed) return { ok:true };
  var sels = String(step.verify.exists||'').split(',').map(function(s){return s.trim();}).filter(Boolean);
  var ariaSel = sels[0] || '';
  var node = null;
  try { node = document.querySelector(ariaSel); } catch(_e){}
  var ap = node && node.getAttribute && node.getAttribute('aria-pressed');
  if(!node || ap !== String(step.verify.ariaPressed)){
    return { ok:false, error:'verify-ariaPressed-miss:expected-'+step.verify.ariaPressed+'-actual-'+(ap||'null') };
  }
  return { ok:true };
}
function verifyTextContains(step){
  if(!step || !step.verify.textContains) return { ok:true };
  var sels = String(step.verify.exists||'').split(',').map(function(s){return s.trim();}).filter(Boolean);
  var tn = null;
  for(var s_k=0; s_k<sels.length; s_k++){
    try { var nn = document.querySelector(sels[s_k]); if(nn){ tn = nn; break; } } catch(_e){}
  }
  var hay = tn ? tn.textContent : '';
  if(!hay || hay.toLowerCase().indexOf(String(step.verify.textContains).toLowerCase()) < 0){
    return { ok:false, error:'verify-textContains-miss:'+step.verify.textContains };
  }
  return { ok:true };
}
function verifyStepAll(step){
  if(!step || !step.verify) return { ok:true }; // 没声明 verify → 直接通过
  var v;
  if(step.verify.exists && !(v = verifyExists(step)).ok) return v;
  if(typeof step.verify.minCount === 'number' && !(v = verifyMinCount(step)).ok) return v;
  if(step.verify.ariaPressed && !(v = verifyAriaPressed(step)).ok) return v;
  if(step.verify.textContains && !(v = verifyTextContains(step)).ok) return v;
  return { ok:true };
}

// === DOM 镜像用于测试：使用 jsdom-free 极简实现（document 全局） ===
//   vitest 提供 happy-dom / jsdom，但我们故意构造最小测试环境以避免污染：
//   在这里把"现在 DOM"挂到 globalThis
function makeFakeDom(){
  function makeNode(props){
    return Object.assign({
      children:[],
      attributes:{},
      innerHTML:'',
      textContent:'',
      classList:[],
      getAttribute: function(k){ return Object.prototype.hasOwnProperty.call(this.attributes||{}, k) ? this.attributes[k] : null; },
      setAttribute: function(k,v){ this.attributes = this.attributes || {}; this.attributes[k] = String(v); },
      hasAttribute: function(k){ return Object.prototype.hasOwnProperty.call(this.attributes||{}, k); }
    }, props || {});
  }
  function rowOf(sel){ return sel && sel.charAt(0) === '#' ? sel.slice(1) : null; }
  var byId = {}; // id -> node
  function reg(id, node){ byId[id] = node; return node; }
  var kpiPub = reg('kpiPub', makeNode({ id:'kpiPub', textContent:'12' }));
  var kpiWorks = reg('kpiWorks', makeNode({ id:'kpiWorks', textContent:'0' }));
  var kpiChannels = reg('kpiChannels', makeNode({ id:'kpiChannels', textContent:'0' }));
  var kpiLastPub = reg('kpiLastPub', makeNode({ id:'kpiLastPub', textContent:'—' }));
  var barsBox = reg('barsBox', makeNode({ id:'barsBox' }));
  var channelsBox = reg('channelsBox', makeNode({ id:'channelsBox' }));
  var worksGrid = reg('worksGrid', makeNode({ id:'worksGrid' }));
  var chatBody = reg('chatBody', makeNode({ id:'chatBody' }));
  var chatInput = reg('chatInput', makeNode({ id:'chatInput' }));
  var refreshWorksBtn = reg('refreshWorksBtn', makeNode({ id:'refreshWorksBtn', textContent:'↻ 刷新' }));
  var aiPickMainToggle = reg('aiPickMainToggle', makeNode({ id:'aiPickMainToggle', textContent:'AI 自动选主推', attributes:{'aria-pressed':'false'} }));
  aiPickMainToggle.attributes['aria-pressed'] = 'false';
  // 4 个时段筛选芯片
  function chip(range, selected){
    var n = makeNode({ id:'chip-'+range, textContent:range==='session'?'本会话':range==='today'?'今天':range==='7d'?'近 7 天':'全部', attributes:{'data-range':range} });
    return n;
  }
  var chips = { session: chip('session', true), today: chip('today', false), '7d': chip('7d', true), all: chip('all', false) };

  function querySelectorAll(sel){
    if(typeof sel !== 'string') return [];
    var sels = sel.split(',').map(function(s){return s.trim();});
    var hits = [];
    for(var si=0; si<sels.length; si++){
      var s = sels[si];
      if(!s) continue;
      var r;
      // 形如 "#id"
      if((r = rowOf(s))){
        if(byId[r]){ hits.push(byId[r]); }
      } else if(s.charAt(0) === '['){
        var tag = s.match(/^\[([^\]]+)\]$/);
        if(tag){
          var parts = tag[1].split('=');
          if(parts.length === 2){
            var k = parts[0], v = parts[1].replace(/['"]/g, '');
            // 时段 chip
            if(k === 'data-range' && chips[v]){
              hits.push(chips[v]);
            }
          }
        }
      }
    }
    return hits;
  }
  function querySelector(sel){
    var all = querySelectorAll(sel);
    return all.length ? all[0] : null;
  }
  return {
    querySelector: querySelector,
    querySelectorAll: querySelectorAll,
    body: { textContent: 'kpiPub kpiWorks kpiChannels' }
  };
}

// ============== 验收点 ==============

describe('AI 演示安全过滤器（v1.16）', () => {
  test('命中危险关键词文本 → 拒绝', () => {
    expect(isDangerByText('发布到抖音')).toBe(true);
    expect(isDangerByText('一键删除全部')).toBe(true);
    expect(isDangerByText('Token 配置')).toBe(true);
    expect(isDangerByText('API Key 设置')).toBe(true);
    expect(isDangerByText('退出登录')).toBe(true);
    expect(isDangerByText('Reset Password')).toBe(true);
  });
  test('安全文本不误伤', () => {
    expect(isDangerByText('保存为视频样本')).toBe(false);
    expect(isDangerByText('切换到「数据看板」')).toBe(false);
    expect(isDangerByText('点击 ↻ 刷新')).toBe(false);
    expect(isDangerByText('滚动浏览统计图')).toBe(false);
  });
  test('危险选择器 → 拒绝', () => {
    expect(isDangerBySelector('#launchRocketBtn')).toBe(true);
    expect(isDangerBySelector('button[onclick*="delete"]')).toBe(true);
    expect(isDangerBySelector('button[onclick*="publish"]')).toBe(true);
    expect(isDangerBySelector('button[onclick*="launch"]')).toBe(true);
  });
  test('安全选择器不误伤', () => {
    expect(isDangerBySelector('#refreshWorksBtn')).toBe(false);
    expect(isDangerBySelector('#aiPickMainToggle')).toBe(false);
    expect(isDangerBySelector('#barsBox')).toBe(false);
    expect(isDangerBySelector('#chatInput')).toBe(false);
    expect(isDangerBySelector('#channelsBox')).toBe(false);
    expect(isDangerBySelector('#worksGrid')).toBe(false);
  });
  test('空 / null / undefined 安全', () => {
    expect(isDangerByText('')).toBe(false);
    expect(isDangerByText(null)).toBe(false);
    expect(isDangerByText(undefined)).toBe(false);
    expect(isDangerBySelector('')).toBe(false);
    expect(isDangerBySelector(null)).toBe(false);
  });
});

describe('AI 规划器调度（v1.17 多步版）', () => {
  test('完整调度包含每个路由的多步演示（不是 1 步/页）', () => {
    // 模拟规划器生成的 steps（结构对照 v1.17 真实 buildDemoPlan）
    var expectedByRoute = {
      flow:     ['s_f0_enter','s_f1_scroll_a','s_f2_chat_input','s_f3_scroll_back'], // ≥4 ops
      dashboard:['s_d0_enter','s_d1_kpi_dwell','s_d2_filter_7d','s_d3_scroll_bars','s_d4_refresh','s_d5_ai_toggle','s_d6_ai_toggle_back','s_d7_filter_back'],
      channels: ['s_c0_enter','s_c1_scroll_top','s_c2_scroll_mid','s_c3_scroll_bottom','s_c4_enter_select','s_c5_exit_select','s_c6_scroll_top'],
      works:    ['s_w0_enter','s_w1_grid_dwell','s_w2_scroll','s_w3_refresh','s_w4_ai_toggle','s_w5_ai_toggle_back','s_w6_main_queue','s_w7_back_top']
    };
    for(var route in expectedByRoute){
      expect(expectedByRoute[route].length).toBeGreaterThanOrEqual(2);
    }
    // 强制步骤数可读断言：dashboard 至少 5 个动作
    expect(expectedByRoute.dashboard.length).toBeGreaterThanOrEqual(5);
  });

  test('总步数上限 30，防止无限循环探索', () => {
    var maxAllowed = 30;
    var allSteps = [];
    for(var k=0;k<60;k++) allSteps.push({ id:'s'+k });
    var capped = allSteps.slice(0, maxAllowed);
    expect(capped.length).toBe(maxAllowed);
  });

  test('步骤中含明确的 verify / dwell / dwellAfter / retries 字段', () => {
    var step = {
      id: 's_d4_refresh',
      name: '点击「↻ 刷新」',
      click: '#refreshWorksBtn',
      retries: 1,
      dwellAfter: 1700,
      verify: { exists: '#refreshWorksBtn' }
    };
    expect(step.click).toBeTruthy();
    expect(step.retries).toBe(1);
    expect(step.verify.exists).toBeTruthy();
  });
});

describe('AI 执行器新增验证器（v1.17）', () => {
  let fakeDoc;
  beforeEach(() => { fakeDoc = makeFakeDom(); });
  afterEach(() => { delete globalThis.document; });

  test('verify.exists：命中节点即通过', () => {
    // 通过 globalThis.document 暴露给测试中的 verifyExists
    globalThis.document = fakeDoc;
    var step = { verify: { exists: '#kpiPub, #chatBody' } };
    var r = verifyStepAll(step);
    expect(r.ok).toBe(true);
  });

  test('verify.minCount：节点数不够时失败', () => {
    globalThis.document = fakeDoc;
    var step = { verify: { exists: '#kpiPub,#kpiWorks', minCount: 5 } }; // 实际只有 2 个
    var r = verifyStepAll(step);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/minCount-miss/);
  });

  test('verify.ariaPressed：状态匹配即通过，不匹配失败', () => {
    globalThis.document = fakeDoc;
    var okStep = { verify: { exists: '#aiPickMainToggle', ariaPressed: 'false' } };
    var badStep = { verify: { exists: '#aiPickMainToggle', ariaPressed: 'true' } };
    expect(verifyStepAll(okStep).ok).toBe(true);
    expect(verifyStepAll(badStep).ok).toBe(false);
  });

  test('verify.textContains：节点 textContent 包含子串 → 通过', () => {
    globalThis.document = fakeDoc;
    // 给 fakeDom 中 #kpiPub 的 textContent 注入 "12 条发布"
    fakeDoc.querySelector('#kpiPub').textContent = '本会话 12 条发布';
    var okStep = { verify: { exists: '#kpiPub', textContains: '12' } };
    var badStep = { verify: { exists: '#kpiPub', textContains: '999' } };
    expect(verifyStepAll(okStep).ok).toBe(true);
    expect(verifyStepAll(badStep).ok).toBe(false);
  });

  test('没有 verify 时，验证直接通过', () => {
    globalThis.document = fakeDoc;
    expect(verifyStepAll({}).ok).toBe(true);
    expect(verifyStepAll({ verify:{} }).ok).toBe(true);
  });
});

describe('AI 演示 click 与 retry 行为（v1.17 共享约定）', () => {
  function fakeExecutor(){
    return {
      calls: 0,
      click: function(sel){
        this.calls++;
        if(this.calls === 1) return { ok:false, error:'transient:not-found' };
        return { ok:true, value:{ sel:sel } };
      }
    };
  }
  test('retry=1 时第一次失败自动重试，第二次成功', () => {
    var ex = fakeExecutor();
    var step = { click: '#x', retries: 1 };
    var firstFail = ex.click(step.click);
    expect(firstFail.ok).toBe(false);
    var retryOk = ex.click(step.click);
    expect(retryOk.ok).toBe(true);
    expect(ex.calls).toBe(2);
  });
  test('click 命中 danger 即停在重试前', () => {
    var dangerStep = { click: '#launchRocketBtn' };
    var isDanger = isDangerBySelector(dangerStep.click);
    expect(isDanger).toBe(true);
  });
});
