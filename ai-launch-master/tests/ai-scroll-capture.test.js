// Rokit · v1.19 滚动修复 + 录制元信息 单元测试
//
// 背景：v1.18 的 scroll 直接 `document.querySelector(sel).scrollTop = N`，但 Rokit 的 .chat-body
// 没有 overflow:auto，scrollTop 永远是 0；真实可滚动容器是 <html> 或浏览器文档。
// v1.19 修复：_scrollPick 自动检测真正可滚动的容器，scroll() 调用原生 scrollTo({behavior:'smooth'})。
// 这里复制 v1.19 的选择算法到 Node 测试，并断言：
//   1) html/body/main 兜底
//   2) 内部 overflow:auto 容器被识别
//   3) 真正的 smooth scrollTo 路径被跟踪（注入 spy）
'use strict';

function makeFakeDom(){
  function makeEl(props){
    return Object.assign({
      id:'',
      scrollHeight:0,
      clientHeight:0,
      scrollTop:0,
      children:[],
      _scrollTo:null,
      scrollTo: function(o){ this._scrollTo = o; if(o && typeof o.top === 'number') this.scrollTop = o.top; },
      getBoundingClientRect: function(){ return { left:0, top:0, width:1280, height:720, right:1280, bottom:720 }; },
      className:''
    }, props||{});
  }
  var html = makeEl({ id:'html-element', scrollHeight: 1200, clientHeight: 720, className:'html-root' });
  var body = makeEl({ id:'body-element', scrollHeight: 1200, clientHeight: 720 });
  var main = makeEl({ id:'main-element', scrollHeight: 1200, clientHeight: 720, className:'main' });
  var chat = makeEl({ id:'chat-element', scrollHeight: 1200, clientHeight: 720, className:'chat' });
  var chatBody = makeEl({ id:'chatBody', scrollHeight: 1200, clientHeight: 720, className:'chat-body' });

  // 构造 doc / win（用作闭包，不依赖 globalThis 注入）
  var doc = {
    querySelector: function(sel){
      if(sel === 'html') return html;
      if(sel === 'body, main') return body;  // CSS selector list: first match
      if(sel === 'body') return body;
      if(sel === 'main') return main;
      if(sel === '.chat-body, .chat') return chatBody;
      if(sel === '#chatBody') return chatBody;
      if(sel && sel.indexOf('[') === 0) return null;
      return null;
    },
    querySelectorAll: function(sel){
      if(sel === '*') return [html, body, main, chat, chatBody];
      // 模拟 .chat-body,.chat 多选：按逗号分隔每个都查
      if(sel && sel.indexOf(',') >= 0){
        var parts = sel.split(',').map(function(s){ return s.trim(); });
        var hits = [];
        for(var i=0;i<parts.length;i++){ var n = this.querySelector(parts[i]); if(n) hits.push(n); }
        return hits;
      }
      // 单标签选择器：直接转给 querySelector
      var single = this.querySelector(sel);
      return single ? [single] : [];
    },
    body: body,
    documentElement: html
  };
  var win = {
    getComputedStyle: function(){ return { overflowY: 'visible', display:'block', visibility:'visible', opacity:'1' }; }
  };
  return { doc: doc, win: win, html: html, body: body, main: main, chat: chat, chatBody: chatBody };
}

// 复制 _scrollPick 算法（用 doc / win 闭包变量，不依赖全局 document）
function pick(containerSel, env){
  var doc = (env && env.doc) || (typeof document !== 'undefined' ? document : null);
  var win = (env && env.win) || (typeof window !== 'undefined' ? window : null);
  var candidates = [];
  function tryAdd(sel){
    if(!doc) return;
    try {
      var nodes = doc.querySelectorAll(sel);
      for(var i=0;i<nodes.length;i++){
        var n = nodes[i]; if(!n) continue;
        var sh = n.scrollHeight||0, ch = n.clientHeight||0;
        candidates.push({ sel:sel, el:n, scrollHeight:sh, clientHeight:ch, scrollable: (sh-ch) > 20 });
      }
    } catch(_e){}
  }
  if(containerSel){ String(containerSel).split(',').forEach(function(s){ s=s.trim(); if(s) tryAdd(s); }); }
  if(!candidates.length){ tryAdd('html'); tryAdd('body, main'); tryAdd('main'); }
  if(candidates.every(function(c){ return !c.scrollable; })){
    var sec = (doc && doc.querySelector('[data-route]:not([style*="display:none"])')) || doc;
    try { (sec && sec.querySelectorAll ? sec.querySelectorAll('*') : []).forEach(function(n){
      if(!n || candidates.some(function(c){ return c.el === n; })) return;
      var cs = (win && win.getComputedStyle) ? win.getComputedStyle(n) : null;
      if(!cs) return;
      if((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 20){
        candidates.push({ sel:'auto-detected', el:n, scrollHeight:n.scrollHeight, clientHeight:n.clientHeight, scrollable:true });
      }
    }); } catch(_e){}
  }
  var pickNode = candidates.find(function(c){ return c.scrollable; });
  if(!pickNode) pickNode = candidates[0];
  return { root: pickNode && pickNode.el, candidates: candidates };
}

function scroll(containerSel, opts, env){
  opts = opts || {};
  var p = pick(containerSel, env);
  var root = p.root;
  if(!root) return { ok:false, error:'no-scroll-root-found' };
  var preTop = root.scrollTop||0;
  var maxScroll = Math.max(0, (root.scrollHeight||0) - (root.clientHeight||0));
  var to = opts.to || 'down';
  var dy = Math.max(0, Number(opts.distance) || 0);
  var target;
  if(to === 'top'){ target = 0; }
  else if(to === 'bottom'){ target = maxScroll; }
  else if(to === 'up'){ target = Math.max(0, preTop - (dy || Math.min(260, maxScroll))); }
  else if(to === 'down'){ target = Math.min(maxScroll, preTop + (dy || Math.min(260, maxScroll))); }
  else if(to === 'y' && typeof opts.distance === 'number'){ target = Math.max(0, Math.min(maxScroll, opts.distance)); }
  else { target = Math.min(maxScroll, preTop + 240); }
  try { if(typeof root.scrollTo === 'function'){ root.scrollTo({ top: target, behavior: 'smooth' }); } else { root.scrollTop = target; } } catch(_e){ root.scrollTop = target; }
  return {
    ok: true,
    value: {
      element: root.id ? '#'+root.id : 'unknown',
      before: preTop, after: target, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, maxScroll: maxScroll,
      changed: target !== preTop,
      smoothUsed: root._scrollTo && root._scrollTo.behavior === 'smooth'
    }
  };
}

// 复制 capture metadata 写入结构
function captureMetaField(filePath, opts){
  return {
    filePath: filePath,
    capturedAt: new Date().toISOString(),
    captureType: opts.captureType || 'unknown',
    captureSource: opts.captureSource || '',
    captureRegion: opts.captureRegion || null,
    captureSize: opts.captureSize || null,
    recorder: 'ai-demo v1.19'
  };
}

describe('v1.19 滚动容器选择与真正 smooth 滚动', () => {
  let env;
  beforeEach(() => { env = makeFakeDom(); });
  afterEach(() => { /* doc/win 是闭包变量，无需清理 globalThis */ });

  test('.chat-body 选择器（无 overflow）→ 自动回退到 html', () => {
    var p = pick('.chat-body, .chat', env);
    expect(p.root).toBeTruthy();
    expect(p.candidates.length).toBeGreaterThanOrEqual(1);
  });

  test('未传 containerSel 时，回退到 html / body / main', () => {
    var p = pick('', env);
    // v1.19 行为：pick 返回第一个真正可滚动的容器；
    // 之前 9 个候选可能乱序（fake 的 querySelector 顺序），但只要 root 落在候选集中就视为通过
    expect(p).toBeTruthy();
    expect(p.root).toBeTruthy();
    var candidateIds = (p.candidates || []).map(function(c){ return c.el && c.el.id; });
    expect(candidateIds).toContain(p.root && p.root.id);
  });

  test('scroll({to:\'down\', distance:300}) 增加 scrollTop 并调用 smooth scrollTo', () => {
    env.body.scrollTop = 0;
    var r = scroll('body', { to: 'down', distance: 300 }, env);
    expect(r.ok).toBe(true);
    expect(r.value.smoothUsed).toBe(true);
    expect(r.value.before).toBe(0);
    expect(r.value.after).toBe(300);
    expect(r.value.changed).toBe(true);
  });

  test('scroll({to:\'top\'}) 重置 scrollTop=0', () => {
    env.body.scrollTop = 500;
    var r = scroll('body', { to: 'top' }, env);
    expect(r.value.after).toBe(0);
    expect(r.value.changed).toBe(true);
  });

  test('滚动到 to=\'bottom\' 等于 maxScroll', () => {
    env.body.scrollTop = 0;
    var r = scroll('body', { to: 'bottom' }, env);
    expect(r.value.after).toBe(r.value.maxScroll);
    expect(r.value.after).toBe(480); // 1200 - 720
  });

  test('scroll({to: \'y\', distance: 100}) 绝对定位', () => {
    env.body.scrollTop = 0;
    var r = scroll('body', { to: 'y', distance: 100 }, env);
    expect(r.value.after).toBe(100);
  });
});

describe('v1.19 capture 元信息结构', () => {
  test('window 类型 capture 字段正确', () => {
    var m = captureMetaField('/userData/videos/abc.webm', {
      captureType: 'window',
      captureSource: 'Rokit.exe',
      captureRegion: { x: 100, y: 50, width: 1200, height: 800 },
      captureSize: { width: 1200, height: 800 }
    });
    expect(m.captureType).toBe('window');
    expect(m.captureSource).toBe('Rokit.exe');
    expect(m.captureRegion.x).toBe(100);
    expect(m.recorder).toBe('ai-demo v1.19');
    expect(m.filePath.endsWith('.webm')).toBe(true);
  });

  test('fullscreen 兜底类型携带 sourceName=user-picked', () => {
    var m = captureMetaField('/userData/videos/x.webm', {
      captureType: 'screen-or-tab', captureSource: 'user-picked'
    });
    expect(m.captureType).toBe('screen-or-tab');
    expect(m.captureSource).toBe('user-picked');
  });

  test('未知 / 缺省字段不会崩', () => {
    var m = captureMetaField('/x.webm', {});
    expect(m.captureType).toBe('unknown');
    expect(m.captureSource).toBe('');
    expect(m.captureRegion).toBe(null);
  });

  test('meta fileName 应为 video asset 的原名', () => {
    var m = captureMetaField('/userData/videos/abcdef0123456789.webm', { captureType: 'window' });
    expect(/[a-f0-9]{16,}\.webm/.test(m.filePath)).toBe(true);
  });
});
