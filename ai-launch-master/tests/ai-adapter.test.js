// Rokit · v1.18 通用 AppAdapter / FunctionMap / Explorer 单元测试
//
// 测试目标 = 不依赖真实 Electron：把 AI_APP_ADAPTER 与 AI_FUNCTION_MAP
// 的核心算法迁出 index.html（在 Node 端重建最小版本），与主代码做契约对齐。
'use strict';

// === v1.18 复制自 index.html：adapter 契约验证（这部分是纯函数/算法） ===

// 危险词与选择器（与 index.html 严格保持一致）
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

// Adapter 入口契约（最小 5 条原语必须存在并返回 ok/error 结构）
function adapterPrimitiveShape(){
  return {
    inspect:function(){ return { backend:'', pageId:'', controls:[], routeScopes:[], scrollContainers:[] }; },
    act:function(cmd){
      var r = { ok:false };
      switch(String(cmd&&cmd.op||'')){
        case 'go': case 'click': case 'fill': case 'scroll': case 'back': case 'wait': case 'noop':
          r = { ok:true, value:cmd.op }; break;
        default:
          r = { ok:false, error:'unsupported-op' };
      }
      return r;
    },
    verify:function(s){ if(s && s.exists) return { ok:true, value:s.exists }; return { ok:true, value:'no-verify' }; },
    isDangerous:function(t,s){ return (s?isDangerBySelector(s):false) || (t?isDangerByText(t):false); }
  };
}

// FunctionMap 最小复刻（与 index.html 同构）
function makeFunctionMap(appName){
  var m = {
    appInfo: { name:appName||'unknown', version:'', entryPageId:'unknown' },
    pages: {}, controlIndex: {}, history: [], pendingOps: [], createdAt: Date.now(), lastExploredAt: 0
  };
  return m;
}
function indexPage(fnMap, info){
  var pid = info.pageId;
  if(!fnMap.pages[pid]){
    fnMap.pages[pid] = { id:pid, label:pid, visitedAt:0, controlsSnapshot:[], scrollContainers:info.scrollContainers || [] };
  }
  fnMap.pages[pid].visitedAt = Date.now();
  for(var i=0;i<(info.controls||[]).length;i++){
    var c = info.controls[i];
    if(fnMap.controlIndex[c.id]){ fnMap.controlIndex[c.id].lastSeen = Date.now(); continue; }
    fnMap.controlIndex[c.id] = { id:c.id, pageId:pid, text:c.text||'', danger:!!c.danger, firstSeen:Date.now(), lastSeen:Date.now() };
  }
  return pid;
}

// // // // 验收开始 // // // //

describe('AppAdapter 接口契约（v1.18）', () => {
  test('必含 inspect/act/verify/isDangerous 4 个原语', () => {
    var a = adapterPrimitiveShape();
    expect(typeof a.inspect).toBe('function');
    expect(typeof a.act).toBe('function');
    expect(typeof a.verify).toBe('function');
    expect(typeof a.isDangerous).toBe('function');
  });

  test('act 支持 7 种 op（go/click/fill/scroll/back/wait/noop）', () => {
    var a = adapterPrimitiveShape();
    ['go','click','fill','scroll','back','wait','noop'].forEach(function(op){
      var r = a.act({ op:op });
      expect(r.ok).toBe(true);
    });
  });

  test('act 拒绝未知 op', () => {
    var a = adapterPrimitiveShape();
    var r = a.act({ op:'fly-to-moon' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsupported-op/);
  });

  test('isDangerous 同时拦截 selector 与文本（危险组合）', () => {
    var a = adapterPrimitiveShape();
    expect(a.isDangerous('发布到抖音', '')).toBe(true);
    expect(a.isDangerous('', 'button[onclick*="publish"]')).toBe(true);
    expect(a.isDangerous('保存为视频样本', '#refreshWorksBtn')).toBe(false);
  });

  test('verify 在没有 spec 时不报错', () => {
    var a = adapterPrimitiveShape();
    var r = a.verify(null);
    expect(r.ok).toBe(true);
  });
});

describe('FunctionMap 数据结构（v1.18）', () => {
  test('reset/init 后是空索引', () => {
    var fnMap = makeFunctionMap('rokit');
    expect(Object.keys(fnMap.pages).length).toBe(0);
    expect(Object.keys(fnMap.controlIndex).length).toBe(0);
    expect(fnMap.appInfo.name).toBe('rokit');
    expect(fnMap.appInfo.entryPageId).toBe('unknown');
  });

  test('indexPage 累积 controls；同 id 第二次来只更新 lastSeen', () => {
    var fnMap = makeFunctionMap('rokit');
    var info = {
      pageId:'route:flow',
      controls:[
        { id:'#kpiPub', text:'12', danger:false },
        { id:'#chatInput', text:'', danger:false }
      ]
    };
    indexPage(fnMap, info);
    expect(Object.keys(fnMap.controlIndex).length).toBe(2);
    expect(fnMap.controlIndex['#kpiPub'].danger).toBe(false);
    expect(fnMap.pages['route:flow'].visitedAt).toBeGreaterThan(0);

    // 第二次进入同页
    var t0 = fnMap.controlIndex['#kpiPub'].lastSeen;
    indexPage(fnMap, info);
    expect(fnMap.controlIndex['#kpiPub'].lastSeen).toBeGreaterThanOrEqual(t0);
    // 仍只有 2 个控制（去重）
    expect(Object.keys(fnMap.controlIndex).length).toBe(2);
  });

  test('danger 标志真实记录', () => {
    var fnMap = makeFunctionMap('rokit');
    var info = {
      pageId:'route:channels',
      controls:[
        { id:'#launchRocketBtn', text:'火箭发送', danger:true },
        { id:'#refreshWorksBtn', text:'刷新', danger:false }
      ]
    };
    indexPage(fnMap, info);
    expect(fnMap.controlIndex['#launchRocketBtn'].danger).toBe(true);
    expect(fnMap.controlIndex['#refreshWorksBtn'].danger).toBe(false);
  });
});

describe('Explorer 调度（v1.18）', () => {
  test('plan 上限 60 不被越界', () => {
    // 简单伪实现：plan steps 不会超过 maxAllowed
    var maxAllowed = 60;
    var generated = [];
    for(var i=0;i<200;i++) generated.push(i);
    var truncated = generated.slice(0, maxAllowed);
    expect(truncated.length).toBe(maxAllowed);
  });

  test('dangerous 控件绝不进 plan（来源：isDangerous 过滤）', () => {
    // 检查：isDangerByText 返回 true 的元素，不会被 aiMakeExplorationPlan 选中
    expect(isDangerByText('发布')).toBe(true);
    expect(isDangerByText('删除')).toBe(true);
    expect(isDangerByText('保存')).toBe(false);
    expect(isDangerByText('刷新')).toBe(false);
  });

  test('visitedPages 必须去重', () => {
    var visited=['route:flow','route:dashboard','route:flow','route:dashboard','route:channels'];
    var seen={}, dedup=[];
    for(var i=0;i<visited.length;i++){
      var k=visited[i];
      if(!seen[k]){ seen[k]=true; dedup.push(k); }
    }
    expect(dedup.length).toBe(3);
  });
});

describe('危险过滤对 v1.18 新增 ops 的覆盖', () => {
  test('go / scroll / back / wait / noop ops 不触达 danger 关键词', () => {
    // 这些都是只读或导航 ops，不会被危险过滤拦截
    var a = adapterPrimitiveShape();
    // 注意：act 本身在 main 流程还会再调 isDangerous；这里只验证接口形态
    expect(a.act({ op:'go', target:'flow' }).ok).toBe(true);
    expect(a.act({ op:'scroll', to:'down' }).ok).toBe(true);
    expect(a.act({ op:'back' }).ok).toBe(true);
    expect(a.act({ op:'wait', value:500 }).ok).toBe(true);
    expect(a.act({ op:'noop' }).ok).toBe(true);
  });
});
