// Rokit · 平台自动发布适配器（Electron 主进程）
// 每个平台一组脚本，注入到「发布浏览器」的第三方页面执行：
//   launch(payload)  -> 返回发布页 URL（登录态下可直接填表）
//   fill(payload)    -> 注入脚本自动填表，返回 {status,...}
//   submit(payload)  -> 注入脚本点击发布按钮（仅全自动平台使用）
// status 语义：
//   ok          已发布成功
//   filled      内容已填好（半自动：等待用户确认最后一步）
//   confirm     内容已填好，但页面还有一步需人工（如选分类/节点）
//   need_login  未登录（页面找不到表单）
//   need_file   需要本地文件（如视频上传）
//   manual      无法自动化，退回「复制文案 + 打开平台」手动模式

'use strict';

// 把函数体字符串拼成可在页面执行的 IIFE，payload 序列化注入
function inject(fnBody, payload) {
  return '(' + fnBody + ')(' + JSON.stringify(payload || {}) + ')';
}

// 通用：等待某个元素出现（元素选择器 + 超时）
var WAIT = "function waitFor(sel,ms){ms=ms||8000;var t0=Date.now();return new Promise(function(res,rej){function chk(){var el=document.querySelector(sel);if(el)return res(el);if(Date.now()-t0>ms)return rej(new Error('wait:'+sel));setTimeout(chk,150);}chk();});}";

// 通用：填 input/textarea 并触发事件
var SETV = "function setv(el,v){el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}";

// 通用：向 contenteditable / textbox 注入文本（模拟粘贴）
var PASTE = "function paste(el,t){el.focus();document.execCommand('insertText',false,t);}";

var adapters = {

  // ---- GitHub Release（全自动：仅需登录，填表后自动点击 Publish Release） ----
  github: {
    auto: true,
    note: '进入 GitHub Release 发布页后自动填 tag / title / body，识别到 Publish Release 按钮后自动点击提交。需在发布浏览器中已登录 GitHub。',
    launch: function (p) {
      var m = /github\.com\/([^/?#]+\/[^/?#]+)/i.exec(p.link || '');
      if (!m) return null;
      // repo 名可能含 "."、"-" 等合法字符，但不应被 URL 编码。
      // 这里只做最小防御：去掉结尾的 .git，不再二次 encodeURIComponent（GitHub path 本身支持）。
      var repo = m[1].replace(/\.git$/i, '');
      return 'https://github.com/' + repo + '/releases/new';
    },
    fill: function (p) {
      return inject('(async function(p){\n' + WAIT + '\n' + SETV + '\n' +
        "try{await waitFor('input[name=\"tag_name\"]');}catch(e){return {status:'need_login'};}\n" +
        "var tag=document.querySelector('input[name=\"tag_name\"]');if(tag&&!tag.value)setv(tag,'v0.1.0');\n" +
        "var t=document.querySelector('input[name=\"release_name\"]');if(t&&!t.value)setv(t,p.title);\n" +
        "var b=document.querySelector('textarea[name=\"release_notes\"]');if(b&&!b.value)setv(b,p.body);\n" +
        "return {status:'filled'};})", p);
    },
    submit: function (p) {
      return inject('(async function(p){\n' +
        "var btns=[].slice.call(document.querySelectorAll('button')).filter(function(b){return /publish release/i.test(b.textContent||'');});\n" +
        "if(!btns.length)return {status:'confirm'};\n" +
        "btns[0].click();return {status:'ok'};})", p);
    }
  },

  // ---- Product Hunt（v3：系统默认浏览器辅助发布） ----
  //
  // 不再创建 BrowserWindow、不再 loadURL / reload / executeJavaScript / DOM 轮询。
  // 调起系统默认浏览器打开 https://www.producthunt.com/ ，
  // 由 Electron 侧「Product Hunt 发布助手」面板提供一键复制按钮。
  // 最终 Submit 永远由用户在自己浏览器里手动点击。
  producthunt: (function(){
    return {
      auto: false,
      mode: 'system-browser-helper',
      manualReason: 'Product Hunt 改用系统默认浏览器辅助发布：Rokit 会打开你本机的 Edge / Chrome，由你在浏览器里完成安全验证和登录，Rokit 在应用内提供字段一键复制面板。最终 Submit 由你手动点击。',
      note: 'Rokit 自动在系统浏览器中打开 Product Hunt；Product name / Tagline / Description / Website 通过「Product Hunt 发布助手」面板一键复制到浏览器表单；图片与视频视频已通过文件路径提示手动拖入。',
      launch: function () {
        // 返回 PH 首页，让用户在熟悉页面里完成验证和登录。
        // pubExec 的 producthunt 分支会识别这个返回值为 null / 空，
        // 直接走 system-browser 路径，不再创建 BrowserWindow。
        return 'system-browser:https://www.producthunt.com/';
      },
      fill: function (p) {
        // 不再向浏览器注入 fill 脚本。always false → 老链路也走 no-op。
        // 但 fill 返回字符串要求是合法 JS（被 executeJavaScript 解释）。
        // 我们 return 一个空 IIFE 让 BrowserWindow 流不会抛错；它
        // 几乎不会被调用，因为 producthunt 的 launch() 已经把 BrowserWindow 跳过了。
        return inject('(async function(p){ return { status:"system-browser-helper", platformId:"producthunt", ok:true, manualReason:"Product Hunt 已在系统浏览器中打开，请在 Electron「Product Hunt 发布助手」面板一键复制字段。" }; })', p);
      },
      submit: function (p) {
        // 永不自动点击 Submit / Publish / Launch。
        return inject('({status:"confirm",note:"Product Hunt Rokit 不自动点 Submit/Publish/Schedule；请在浏览器手动完成发布。",manualReason:"user-must-click-send-manually",platformId:"producthunt"})', p);
      }
    };
  })(),

  // ---- V2EX 发帖（全自动，主题节点尽量自动，选不到则等确认） ----
  v2ex: {
    auto: true,
    launch: function () { return 'https://www.v2ex.com/new'; },
    fill: function (p) {
      return inject('(async function(p){\n' + WAIT + '\n' + SETV + '\n' +
        "try{await waitFor('#topic_title',6000);}catch(e){return {status:'need_login'};}\n" +
        "var t=document.querySelector('#topic_title');if(t)setv(t,p.title);\n" +
        "var b=document.querySelector('#topic_content');if(b&&!b.value)setv(b,p.body);\n" +
        "var sel=document.querySelector('select#topic_node');var found=false;\n" +
        "if(sel){for(var i=0;i<sel.options.length;i++){if(/分享|share/i.test(sel.options[i].textContent||'')){sel.selectedIndex=i;sel.dispatchEvent(new Event('change',{bubbles:true}));found=true;break;}}}\n" +
        "return {status:(sel&&!found)?'confirm':'filled',note:(sel&&!found)?'请手动选择主题节点':'已自动选择「分享」节点'};})", p);
    },
    submit: function (p) {
      return inject('(async function(p){\n' +
        "var btns=[].slice.call(document.querySelectorAll('button[type=\"submit\"],input[type=\"submit\"]')).filter(function(b){return /submit|create|发布/i.test(b.textContent||b.value||'');});\n" +
        "if(!btns.length)return {status:'confirm'};\n" +
        "btns[0].click();return {status:'ok'};})", p);
    }
  },

  // ---- 掘金发文章（自动填 title / body，发布需选分类/标签） ----
  juejin: {
    auto: false,
    manualReason: '发布前需选分类、标签、封面',
    note: 'Rokit 填好标题与正文，发布按钮点击前会弹分类 / 标签 / 封面设置，需用户手动选完后点发布。',
    launch: function () { return 'https://juejin.cn/editor/drafts/new'; },
    fill: function (p) {
      return inject('(async function(p){\n' + WAIT + '\n' + SETV + '\n' +
        "try{await waitFor('[contenteditable=\"true\"],textarea',6000);}catch(e){return {status:'need_login'};}\n" +
        "var title=document.querySelector('[data-testid=\"tiptap\"],[class*=\"title\"],[placeholder*=\"标题\"],[placeholder*=\"Title\"]');\n" +
        "if(title){title.focus();document.execCommand('insertText',false,p.title);}\n" +
        "var body=document.querySelector('[contenteditable=\"true\"]');if(body&&!body.textContent.trim()){body.focus();document.execCommand('insertText',false,p.body);}\n" +
        "return {status:'filled',note:'掘金发布需选择分类/标签，填好后请确认'};})", p);
    },
    submit: function (p) {
      return inject('(async function(p){\n' +
        "var btns=[].slice.call(document.querySelectorAll('button')).filter(function(b){return /发布文章|发布/i.test(b.textContent||'');});\n" +
        "if(!btns.length)return {status:'confirm'};\n" +
        "btns[0].click();return {status:'ok',note:'如弹出分类/标签设置，请选择后确认发布'};})", p);
    }
  },

  // ---- X / Twitter 发推（全自动） ----
  x: {
    auto: true,
    launch: function () { return 'https://x.com/compose/post'; },
    fill: function (p) {
      return inject('(async function(p){\n' + WAIT + '\n' + PASTE + '\n' +
        "try{await waitFor('[data-testid=\"tweetTextarea_0\"],[role=\"textbox\"]',6000);}catch(e){return {status:'need_login'};}\n" +
        "var tb=document.querySelector('[data-testid=\"tweetTextarea_0\"]')||document.querySelector('[role=\"textbox\"]');if(!tb)return {status:'need_login'};\n" +
        "var text=(p.title?p.title+'\\n\\n':'')+(p.body||'');paste(tb,text);return {status:'filled'};})", p);
    },
    submit: function (p) {
      return inject('(async function(p){\n' +
        "var btns=[].slice.call(document.querySelectorAll('[data-testid=\"tweetButton\"]')).filter(function(b){return !b.disabled;});\n" +
        "if(!btns.length)return {status:'confirm'};btns[0].click();return {status:'ok'};})", p);
    }
  },

  // ---- Facebook 发帖（自动填正文，发布前需选受众 / 隐私） ----
  facebook: {
    auto: false,
    manualReason: '发布前需选受众、隐私设置',
    note: 'Rokit 填好正文，发布前 Facebook 会弹受众 / 隐私 / 心情选择，需用户手动选完点发布。',
    launch: function () { return 'https://www.facebook.com/'; },
    fill: function (p) {
      return inject('(async function(p){\n' + WAIT + '\n' + PASTE + '\n' +
        "var starters=[].slice.call(document.querySelectorAll('span')).filter(function(s){return /写点什么|what's on your mind|有什么新鲜事/i.test(s.textContent||'');});\n" +
        "if(starters.length)starters[0].click();\n" +
        "try{await waitFor('[role=\"textbox\"][contenteditable=\"true\"]',6000);}catch(e){return {status:'need_login'};}\n" +
        "var tb=document.querySelector('[role=\"textbox\"][contenteditable=\"true\"]');if(!tb)return {status:'need_login'};\n" +
        "var text=(p.title?p.title+'\\n':'')+(p.body||'');paste(tb,text);return {status:'filled'};})", p);
    },
    submit: function (p) {
      return inject('(async function(p){\n' +
        "var btns=[].slice.call(document.querySelectorAll('[role=\"button\"]')).filter(function(b){return /^(发布|Post)$/i.test((b.textContent||'').trim());});\n" +
        "if(!btns.length)return {status:'confirm'};btns[0].click();return {status:'ok'};})", p);
    }
  },

  // ---- YouTube（视频发布需要本地成片文件） ----
  youtube: {
    auto: false,
    manualReason: '需本地成片视频文件',
    note: 'YouTube 视频发布必须先上传本地视频文件，Rokit 自动跳到 YouTube Studio 但不会自动选择本地文件，请手动上传。',
    launch: function () { return 'https://studio.youtube.com/'; },
    fill: function (p) {
      return inject('(async function(p){\n' +
        "return {status:'need_file',note:'YouTube 视频发布需要本地成片文件，请手动上传视频；标题/简介可粘贴：'+(p.title||'')+' / '+(p.body||'').slice(0,80)};})", p);
    },
    submit: function (p) {
      return inject('({status:\'need_file\'})', p);
    }
  },

  // ---- 国内复杂平台（半自动：自动填正文，上传/最终发布需人工确认） ----
  douyin: {
    auto: false,
    launch: function () { return 'https://creator.douyin.com/creator-micro/content/upload'; },
    fill: function (p) {
      return inject('(async function(p){\n' + WAIT + '\n' + SETV + '\n' +
        "try{await waitFor('textarea,input',6000);}catch(e){return {status:'need_login'};}\n" +
        "var ta=document.querySelector('textarea');if(ta&&!ta.value)setv(ta,(p.title?p.title+'\\n':'')+(p.body||''));\n" +
        "return {status:'filled',note:'抖音发布需上传视频 + 选封面，请在发布窗口手动完成最后步骤'};})", p);
    },
    submit: function (p) { return inject('({status:\'confirm\',note:\'抖音发布请在窗口手动完成（视频上传与封面）\'})', p); }
  },
  xhs: {
    auto: false,
    launch: function () { return 'https://creator.xiaohongshu.com/publish/publish'; },
    fill: function (p) {
      return inject('(async function(p){\n' + WAIT + '\n' + SETV + '\n' +
        "try{await waitFor('textarea,input',6000);}catch(e){return {status:'need_login'};}\n" +
        "var ta=document.querySelector('textarea');if(ta&&!ta.value)setv(ta,(p.title?p.title+'\\n':'')+(p.body||''));\n" +
        "return {status:'filled',note:'小红书需上传图片 + 话题标签，请在窗口手动完成'};})", p);
    },
    submit: function (p) { return inject('({status:\'confirm\',note:\'小红书发布请在窗口手动完成（图片上传）\'})', p); }
  },
  bili: {
    auto: false,
    launch: function () { return 'https://member.bilibili.com/platform/upload/video/frame'; },
    fill: function (p) {
      return inject('(async function(p){\n' + WAIT + '\n' + SETV + '\n' +
        "try{await waitFor('input,textarea',6000);}catch(e){return {status:'need_login'};}\n" +
        "var t=document.querySelector('input[placeholder*=\"标题\"],input[name*=\"title\"]');if(t&&!t.value)setv(t,p.title);\n" +
        "var d=document.querySelector('textarea');if(d&&!d.value)setv(d,p.body);\n" +
        "return {status:'filled',note:'B站需上传视频 + 分区/封面，请在窗口手动完成'};})", p);
    },
    submit: function (p) { return inject('({status:\'confirm\',note:\'B站发布请在窗口手动完成（视频上传）\'})', p); }
  },
  jike: {
    auto: false,
    // v1.14 即刻：登录后落在 /following 首页，发布入口即首页顶栏"分享你的想法..."输入框。
    launch: function () { return 'https://web.okjike.com/following'; },
    manualReason: '即刻 v1.14 仅自动填正文 + 附加视频。请在浏览器手动选择圈子 / 点击「发送」按钮。',
    fill: function (p) {
      // ---- body ----
      var targetBody = String((p && p.body != null) ? p.body : '');
      // ---- video ----
      var videoPayload = null;
      if (p && typeof p.videoDataUrl === 'string' && /^data:/i.test(p.videoDataUrl)) {
        videoPayload = {
          dataUrl:  String(p.videoDataUrl),
          name:     String(p.videoName || 'video.mp4'),
          mime:     String(p.videoMime || 'video/mp4')
        };
      }
      // ---- throttle markers（**仅作环境日志**，不再 abort） ----
      var THROTTLE_MARKERS = ['操作过于频繁','操作频繁','请求过于频繁','rate limit','too many requests','稍后再试','限流','限速'];
      var payloadJson = JSON.stringify({
        targetBody: targetBody,
        video:      videoPayload,
        markers:    THROTTLE_MARKERS,
        pollIntervalMs: 800,
        maxAttempts:    15,
        verifyDelayMs:  800,
        mediaTimeoutMs: 15000
      });
      // -----------------------------------------------------------------
      // IIFE：v3 逻辑（不再 abort；真实输入事件；4 阶段日志；DataTransfer 上传）
      // -----------------------------------------------------------------
      var FN =
        'var p2 = p;\n' +
        'var log = function(m, x){ try{ console.log("[Jike] " + m + (x ? " " + JSON.stringify(x) : "")); }catch(_e){} };\n' +
        'var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };\n' +
        // 节流 = 纯日志，不 abort
        'var markers = p2.markers || ["操作过于频繁"];\n' +
        'var re = new RegExp("(" + markers.map(function(s){return String(s).replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&");}).join("|") + ")","i");\n' +
        'var detectThrottle = function(){\n' +
        '  try{\n' +
        '    var nodes=document.querySelectorAll("div,span,p,li,section,article,h1,h2,h3,h4,h5,h6");\n' +
        '    for(var i=0;i<nodes.length;i++){\n' +
        '      var n=nodes[i];if(!n)continue;\n' +
        '      if(n.children && n.children.length>0) continue;\n' +
        '      var rect=n.getBoundingClientRect();\n' +
        '      if(!rect||rect.width<=0||rect.height<=0) continue;\n' +
        '      var s=window.getComputedStyle(n);\n' +
        '      if(s.visibility==="hidden"||s.display==="none") continue;\n' +
        '      var t=String(n.textContent||"").trim();\n' +
        '      if(t && t.length<=200 && re.test(t)) return t;\n' +
        '    }\n' +
        '  }catch(_e){}\n' +
        '  return "";\n' +
        '};\n' +
        // 候选 composer 选择器（与上一版相同优先级）
        'var COMPOSER_SELS = [\n' +
        '  "[contenteditable=\\"true\\"][role=\\"textbox\\"][aria-multiline=\\"true\\"]",\n' +
        '  "[contenteditable=\\"true\\"][aria-multiline=\\"true\\"]",\n' +
        '  "[contenteditable=\\"true\\"][placeholder*=\\"想法\\"]",\n' +
        '  "[contenteditable=\\"true\\"][placeholder*=\\"分享\\"]",\n' +
        '  "[contenteditable=\\"true\\"][placeholder*=\\"说点什么\\"]",\n' +
        '  "[contenteditable=\\"true\\"][data-placeholder*=\\"想法\\"]",\n' +
        '  "[contenteditable=\\"true\\"][data-placeholder*=\\"分享\\"]",\n' +
        '  "[contenteditable=\\"true\\"][aria-label*=\\"想法\\"]",\n' +
        '  "[contenteditable=\\"true\\"][aria-label*=\\"分享\\"]",\n' +
        '  "textarea[placeholder*=\\"分享你的想法\\"]",\n' +
        '  "textarea[placeholder*=\\"想法\\"]",\n' +
        '  "textarea[placeholder*=\\"分享\\"]",\n' +
        '  "textarea[aria-multiline=\\"true\\"]",\n' +
        '  "[role=\\"textbox\\"]",\n' +
        '  "[contenteditable=\\"true\\"]",\n' +
        '  "textarea"\n' +
        '];\n' +
        'function isExcluded(el){\n' +
        '  try{\n' +
        '    var role=(el.getAttribute&&el.getAttribute("role"))||"";\n' +
        '    var type=(el.getAttribute&&el.getAttribute("type"))||"";\n' +
        '    var ph=String((el.getAttribute&&el.getAttribute("placeholder"))||"").trim();\n' +
        '    var al=String((el.getAttribute&&el.getAttribute("aria-label"))||"").trim();\n' +
        '    if(/search/i.test(role)) return "search-by-role";\n' +
        '    if(/search/i.test(type)) return "search-by-type";\n' +
        '    if(/搜索|search/i.test(ph)) return "search-by-placeholder";\n' +
        '    if(/评论|回复|留言/i.test(ph)) return "comment-by-placeholder";\n' +
        '    if(/评论|回复|留言/i.test(al)) return "comment-by-aria";\n' +
        '    if(/私信|发送消息|聊天/i.test(ph)) return "dm-by-placeholder";\n' +
        '    if(/私信|发送消息|聊天/i.test(al)) return "dm-by-aria";\n' +
        '    return null;\n' +
        '  }catch(_e){ return null; }\n' +
        '}\n' +
        'function looksLikeComposer(el){\n' +
        '  try{\n' +
        '    var tag=(el.tagName||"").toUpperCase();\n' +
        '    if(tag==="TEXTAREA") return true;\n' +
        '    if(tag!=="DIV"&&tag!=="SECTION"&&tag!=="SPAN") return false;\n' +
        '    var ce=el.getAttribute&&el.getAttribute("contenteditable");\n' +
        '    if(ce && String(ce).toLowerCase()!=="false") return true;\n' +
        '    var rect=el.getBoundingClientRect();\n' +
        '    if(rect && rect.height>=60) return true;\n' +
        '    return false;\n' +
        '  }catch(_e){ return false; }\n' +
        '}\n' +
        'function findComposer(){\n' +
        '  for(var i=0;i<COMPOSER_SELS.length;i++){\n' +
        '    var sels=document.querySelectorAll(COMPOSER_SELS[i]);\n' +
        '    for(var j=0;j<sels.length;j++){\n' +
        '      var el=sels[j]; if(!el) continue;\n' +
        '      var rect=el.getBoundingClientRect();\n' +
        '      if(!rect||rect.width<=0||rect.height<=0) continue;\n' +
        '      var style=window.getComputedStyle(el);\n' +
        '      if(style.visibility==="hidden"||style.display==="none") continue;\n' +
        '      if(isExcluded(el)) continue;\n' +
        '      if(!looksLikeComposer(el)) continue;\n' +
        '      return { el: el, selector: COMPOSER_SELS[i] };\n' +
        '    }\n' +
        '  }\n' +
        '  return null;\n' +
        '}\n' +
        'function readContent(el){\n' +
        '  if(!el) return "";\n' +
        '  var tag=(el.tagName||"").toUpperCase();\n' +
        '  if(tag==="TEXTAREA"||tag==="INPUT") return String(el.value||"");\n' +
        '  return String(el.textContent||el.innerText||"");\n' +
        '}\n' +
        // 真实输入事件：textarea 走原生 setter；contenteditable 走 Range+execCommand
        'function fillComposer(el, text){\n' +
        '  try{\n' +
        '    if(typeof el.focus==="function") el.focus();\n' +
        '    var tag=(el.tagName||"").toUpperCase();\n' +
        '    if(tag==="TEXTAREA"||tag==="INPUT"){\n' +
        '      var proto=tag==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;\n' +
        '      var setter=Object.getOwnPropertyDescriptor(proto,"value").set;\n' +
        '      if(setter) setter.call(el, String(text||""));\n' +
        '      else el.value=String(text||"");\n' +
        '      el.dispatchEvent(new InputEvent("input",  {bubbles:true, cancelable:true, data:String(text||""), inputType:"insertText"}));\n' +
        '      el.dispatchEvent(new Event("change", {bubbles:true}));\n' +
        '      return { ok:true, method:"native-setter" };\n' +
        '    }\n' +
        '    var sel=window.getSelection();\n' +
        '    if(sel && document.createRange){\n' +
        '      try{\n' +
        '        var range=document.createRange();\n' +
        '        range.selectNodeContents(el);\n' +
        '        sel.removeAllRanges();\n' +
        '        sel.addRange(range);\n' +
        '      }catch(_e){}\n' +
        '    }\n' +
        '    var ok=false;\n' +
        '    try { ok=document.execCommand("insertText", false, String(text||"")); } catch(_e){ ok=false; }\n' +
        '    var method=ok?"execCommand-insertText-range":"fallback-textContent";\n' +
        '    if(!ok){\n' +
        '      el.textContent=String(text||"");\n' +
        '      el.dispatchEvent(new InputEvent("input", {bubbles:true, cancelable:true, inputType:"insertText"}));\n' +
        '      el.dispatchEvent(new Event("change", {bubbles:true}));\n' +
        '    }\n' +
        '    return { ok:true, method:method };\n' +
        '  }catch(e){\n' +
        '    return { ok:false, method:"exception", error:String((e&&e.message)||e) };\n' +
        '  }\n' +
        '}\n' +
        // 探查所有 file input，按要求打印每个的 accept/multiple/visible
        'function probeFileInputs(){\n' +
        '  var inputs=document.querySelectorAll("input[type=\\"file\\"]");\n' +
        '  log("file input count: " + inputs.length);\n' +
        '  var picked=null;\n' +
        '  for(var i=0;i<inputs.length;i++){\n' +
        '    var inp=inputs[i]; if(!inp) continue;\n' +
        '    var accept=inp.getAttribute("accept")||"";\n' +
        '    var multiple=inp.hasAttribute("multiple");\n' +
        '    var style=window.getComputedStyle(inp);\n' +
        '    var visible=style.visibility!=="hidden" && style.display!=="none";\n' +
        '    var disabled=inp.disabled===true;\n' +
        '    var type=inp.getAttribute("type")||"";\n' +
        '    log("file input #" + i, { accept: accept, multiple: multiple, visible: visible, disabled: disabled, type: type });\n' +
        '    // 优先：accept 含 video；否则接受 image/video；最后任意 file\n' +
        '    if(!picked && !disabled){\n' +
        '      if(/video/i.test(accept)) picked=inp;\n' +
        '    }\n' +
        '  }\n' +
        '  if(!picked){\n' +
        '    for(var j=0;j<inputs.length;j++){\n' +
        '      var inp2=inputs[j]; if(!inp2||inp2.disabled) continue;\n' +
        '      var a2=inp2.getAttribute("accept")||"";\n' +
        '      if(/image.*video|video.*image/i.test(a2)) picked=inp2;\n' +
        '    }\n' +
        '  }\n' +
        '  if(!picked){\n' +
        '    for(var k=0;k<inputs.length;k++){\n' +
        '      var inp3=inputs[k]; if(!inp3||inp3.disabled) continue;\n' +
        '      picked=inp3; break;\n' +
        '    }\n' +
        '  }\n' +
        '  return picked;\n' +
        '}\n' +
        // 等待 file input 出现（maxAttempts × pollIntervalMs）
        'async function waitFileInput(timeoutMs){\n' +
        '  var start=Date.now();\n' +
        '  var poll=400;\n' +
        '  var attempts=0;\n' +
        '  while(Date.now()-start<timeoutMs){\n' +
        '    attempts++;\n' +
        '    var picked=probeFileInputs();\n' +
        '    if(picked){\n' +
        '      // 等到 file input 在 composer 出现后再上传（避免页面提前 detach）\n' +
        '      return { input: picked, attempts: attempts };\n' +
        '    }\n' +
        '    await sleep(poll);\n' +
        '  }\n' +
        '  return { input: null, attempts: attempts };\n' +
        '}\n' +
        // DataTransfer + File + change event（标准、真实文件上传事件）
        'async function uploadVideo(input, video){\n' +
        '  if(!input || !video || !video.dataUrl) return { ok:false, error:"no-input-or-video" };\n' +
        '  try{\n' +
        '    var res=await fetch(video.dataUrl, { credentials:"omit", mode:"cors" });\n' +
        '    if(!res.ok) return { ok:false, error:"fetch "+res.status };\n' +
        '    var blob=await res.blob();\n' +
        '    var mime=String(blob.type || video.mime || "video/mp4").toLowerCase();\n' +
        '    var fileName=String(video.name||"video.mp4").replace(/[^\\w.\\-\u4e00-\u9fa5]+/g,"_");\n' +
        '    if(mime.indexOf("video/")===0 && !/\\.\\w{2,4}$/.test(fileName)) fileName+=".mp4";\n' +
        '    if(mime.indexOf("image/")===0 && !/\\.\\w{2,4}$/.test(fileName)) fileName+=".jpg";\n' +
        '    var file=new File([blob], fileName, { type: mime, lastModified: Date.now() });\n' +
        '    var dt=new DataTransfer();\n' +
        '    dt.items.add(file);\n' +
        '    input.files=dt.files;\n' +
        '    input.dispatchEvent(new Event("input",  { bubbles:true, cancelable:true }));\n' +
        '    input.dispatchEvent(new Event("change", { bubbles:true, cancelable:true }));\n' +
        '    return { ok:true, fileName:file.name, fileSize:file.size, fileType:file.type, mime:mime };\n' +
        '  }catch(e){\n' +
        '    return { ok:false, error:String((e&&e.message)||e) };\n' +
        '  }\n' +
        '}\n' +
        // ---- main ----
        'var targetBody = String((p2.targetBody != null) ? p2.targetBody : "");\n' +
        'var video      = (p2.video && p2.video.dataUrl) ? p2.video : null;\n' +
        'var result = { ok:false, status:"filled", composer:null, fillMethod:null, contentBeforeLen:0, contentAfterLen:0, targetPreview:targetBody.slice(0,50), actualPreview:"", throttled:false, throttleSample:"", video:null, attempts:0, elapsedMs:0, note:"" };\n' +
        'try{\n' +
        // 节流：仅作环境日志
        '  var th=detectThrottle();\n' +
        '  if(th){ result.throttled=true; result.throttleSample=th; log("detected page throttle text (informational, continuing)", { sample: th }); }\n' +
        // 1) composer search start
        '  log("composer search start", { selectors: COMPOSER_SELS.length, maxAttempts: p2.maxAttempts, pollIntervalMs: p2.pollIntervalMs });\n' +
        '  var startTs=Date.now();\n' +
        '  var found=null;\n' +
        '  var attempts=0;\n' +
        '  for(attempts=1; attempts<=p2.maxAttempts; attempts++){\n' +
        '    result.attempts=attempts;\n' +
        '    found=findComposer();\n' +
        '    if(found){ log("composer found", { attempt: attempts, selector: found.selector, tag: found.el.tagName }); break; }\n' +
        '    await sleep(p2.pollIntervalMs);\n' +
        '  }\n' +
        '  result.elapsedMs=Date.now()-startTs;\n' +
        '  if(!found){ result.ok=false; result.status="need_login"; result.note="未找到发布框（可能需要登录或页面未加载完成）"; log("composer NOT FOUND", { attempts: result.attempts }); return result; }\n' +
        // 2) content length before
        '  var beforeLen=readContent(found.el).length;\n' +
        '  result.contentBeforeLen=beforeLen;\n' +
        '  result.composer={ tagName: found.el.tagName, selector: found.selector, contenteditable: (found.el.getAttribute&&found.el.getAttribute("contenteditable"))||"", placeholder: (found.el.getAttribute&&found.el.getAttribute("placeholder"))||"", ariaLabel: (found.el.getAttribute&&found.el.getAttribute("aria-label"))||"" };\n' +
        '  log("content length before = " + beforeLen + ", targetLen = " + targetBody.length);\n' +
        // 3) 真实输入事件填表
        '  var fr=fillComposer(found.el, targetBody);\n' +
        '  result.fillMethod=fr && fr.method;\n' +
        '  if(!fr || !fr.ok){ result.ok=false; result.note="fill-failed: "+(fr&&fr.error||"unknown"); log("content fill FAILED", fr); return result; }\n' +
        '  await sleep(p2.verifyDelayMs);\n' +
        '  var afterText=readContent(found.el);\n' +
        '  var afterLen=afterText.length;\n' +
        '  result.contentAfterLen=afterLen;\n' +
        '  result.actualPreview=afterText.slice(0,50);\n' +
        '  log("target content length: " + targetBody.length);\n' +
        '  log("actual content length: " + afterLen);\n' +
        // 4) 校验：实际写入必须包含 target 前 20 字
        '  var tgt=targetBody;\n' +
        '  if(afterLen===0){ result.ok=false; result.note="actual-content-empty"; log("content fill FAILED: empty", null); return result; }\n' +
        '  if(tgt.length>0 && afterText.indexOf(tgt.slice(0, Math.min(20, tgt.length)))===-1){ result.ok=false; result.note="preview-not-found"; log("content fill FAILED: preview not found", { actual: result.actualPreview }); return result; }\n' +
        '  log("content fill success", { method: result.fillMethod, before: beforeLen, after: afterLen });\n' +
        // 5) 视频上传（仅当 videoPayload 存在）
        '  if(video && video.dataUrl){\n' +
        '    log("video upload start", { name: p2.video.name, mime: p2.video.mime });\n' +
        '    var fw=await waitFileInput(p2.mediaTimeoutMs || 15000);\n' +
        '    if(!fw.input){ result.video={ ok:false, error:"no-file-input", attempts: fw.attempts }; log("video upload FAILED: no file input", { attempts: fw.attempts }); }\n' +
        '    else{\n' +
        '      var ur=await uploadVideo(fw.input, p2.video);\n' +
        '      result.video={ ok: !!ur.ok, fileName: ur.fileName||"", fileSize: ur.fileSize||0, fileType: ur.fileType||"", mime: ur.mime||"", error: ur.error||"" };\n' +
        '      if(ur.ok){ log("video upload dispatched", { fileName: ur.fileName, size: ur.fileSize, type: ur.fileType }); }\n' +
        '      else { log("video upload FAILED", { error: ur.error }); }\n' +
        '    }\n' +
        '  }\n' +
        // 6) 完成
        '  result.ok=true;\n' +
        '  result.status="filled";\n' +
        '  if(result.video && !result.video.ok){ result.note="文字已填好，但视频上传未成功，请在窗口手动添加附件"; }\n' +
        '  else { result.note="文字已自动填好"+(video?"，视频已附加":"")+"，请在窗口手动选择圈子并点击「发送」"; }\n' +
        '}catch(e){\n' +
        '  result.ok=false; result.status="manual"; result.note="exception: "+String((e&&e.message)||e);\n' +
        '  log("FILL EXCEPTION", { error: result.note });\n' +
        '}\n' +
        'return result;';
      return inject('(async function(p){\n' + FN + '\n})', JSON.parse(payloadJson));
    },
    submit: function (p) {
      // v1.14：永不自动点「发送」。让用户在窗口手动完成最后一步。
      return inject("function(){return {status:'confirm',note:'即刻 v1.14 不自动点发送。请在窗口手动选择圈子并点击「发送」'};}", p || {});
    }
  },
  zhihu: {
    auto: false,
    launch: function () { return 'https://zhuanlan.zhihu.com/write'; },
    fill: function (p) {
      return inject('(async function(p){\n' + WAIT + '\n' + SETV + '\n' +
        "try{await waitFor('textarea,input',6000);}catch(e){return {status:'need_login'};}\n" +
        "var t=document.querySelector('input[placeholder*=\"标题\"],input[class*=\"title\"]');if(t&&!t.value)setv(t,p.title);\n" +
        "var d=document.querySelector('textarea');if(d&&!d.value)setv(d,p.body);\n" +
        "return {status:'filled',note:'知乎发布请在窗口手动确认（可能需选话题）'};})", p);
    },
    submit: function (p) { return inject('({status:\'confirm\',note:\'知乎发布请在窗口手动确认\'})', p); }
  },
  wechat: {
    auto: false,
    launch: function () { return 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&isNew=1&lang=zh_CN'; },
    fill: function () { return "({status:'manual',note:'公众号草稿请通过官方 API 创建'})"; },
    submit: function (p) { return inject('({status:\'confirm\',note:\'公众号发布请在窗口手动完成\'})', p); }
  },
  // ---- 小红书（Xiaohongshu / RED）观察者模式 v1.0 ----
  // 本次唯一职责：把小红书首页加载完成后，进入纯观察模式。
  //   - 不自动点击、不自动填写、不自动跳转、不自动发布
  //   - 用户自己点「发布」按钮
  //   - 观察器记录 URL / 标题 / DOM / Dialog / 新窗口 / 状态变化 / SPA 变化
  // 页面端观察者实现在 ./browser/platforms/xiaohongshu/XhsObserverScript.js，
  // 这里只负责在 fill 阶段把观察器 IIFE 注入到 https://www.xiaohongshu.com/ 页面里。
  xiaohongshu: {
    auto: false,
    partition: 'persist:platform-xiaohongshu',
    observerOnly: true,
    manualReason: '小红书观察者模式：程序永不自动点击 / 自动填写 / 自动发布；用户在页面里手动操作，Rokit 仅记录所有有意义的页面 / DOM / 窗口变化。',
    // v3.0：launch 直接到 creator.xiaohongshu.com/publish/publish 发布页，
    //   避免 fill IIFE 在首页等 20s 后 PUBLISH_URL_NOT_LOADED 失败。
    //   未登录时 creator 站会自己重定向到登录页（不破坏用户 XHS 登录流程）。
    launch: function () { return 'https://creator.xiaohongshu.com/publish/publish'; },
    fill: function (p) {
      // v3.0（小红书）：视频上传 → upload-started → 立即 fill title/content → 等上传完成 → 最终验证
      //   - 不修改视频注入数据流（fetchToBlob → File → DataTransfer → input.files → dispatchEvent）
      //   - 不点击最终「发布」按钮（submit() 永远是 manual no-op）
      //   - 视频上传启动后立即填标题 / 正文（不等上传完成）；上传完成后再校验一次
      //   - 标题 / 正文 DOM 每次重新 querySelector（不持有旧引用，避免小红书 re-render 失效）
      try {
        var mediaBuilder = require('./browser/platforms/xiaohongshu/XiaohongshuMediaUploadScript');

        var payload = p || {};
        var videoDataUrl = payload.videoDataUrl || null;
        var videoName    = payload.videoName || 'video.mp4';
        var videoMime    = payload.videoMime || 'video/mp4';
        var videoSkipped = !!payload.videoUploadSkipped;
        var videoPresent = !!(videoDataUrl && !videoSkipped);

        // 1) 复用已有的 MediaUploadScript IIFE（XHS 同源写法，与 jike / producthunt / x 共用）
        var mediaIIFE = mediaBuilder.buildXiaohongshuMediaUploadScript({
          media: {
            type: 'video',
            items: videoPresent ? [{ src: videoDataUrl, name: videoName, mime: videoMime }] : []
          },
          timeoutMs: 90000, // XHS 视频上传（30~80MB）需要较长时间
          platform: 'xiaohongshu'
        });

        // 2) 把 videoDataUrl / videoName / videoMime 透传给页面端；
        //    这里必须用 JSON.stringify —— payload 中可能含换行、引号、Unicode。
        var _videoDataUrlJs = JSON.stringify(videoDataUrl);
        var _videoNameJs    = JSON.stringify(String(videoName || 'video.mp4'));
        var _videoMimeJs    = JSON.stringify(String(videoMime || 'video/mp4'));
        var _videoPresentJs = JSON.stringify(videoPresent);
        var _videoSkippedJs = JSON.stringify(!!videoSkipped);

        // v3.0：title / content 也注入到 IIFE（payload 已有 title 与 body 字段，由前端 Rokit 传入）
        var _titleTextJs   = JSON.stringify(String((payload.title || '') + ''));
        var _contentTextJs = JSON.stringify(String((payload.body || payload.content || '') + ''));

        // 3) 串成单一 async IIFE 注入页面
        //    步骤：等发布页 URL → 等 SPA hydrate → 上传视频 → 等 DOM 完成 → 留在页面
        // v3.0：title / content 也注入到 IIFE（payload 已有 title 与 body 字段，由前端 Rokit 传入）
        var _titleTextJs   = JSON.stringify(String((payload.title || '') + ''));
        var _contentTextJs = JSON.stringify(String((payload.body || payload.content || '') + ''));

        var combined = '(async function(){\n' +
          'var r={found:false,ok:false,pickedCount:0,elapsedMs:0,attempts:0,error:"",fileInputs:[],fileName:"",domDone:null,videoUploadSkipped:'+_videoSkippedJs+',titleVerified:false,contentVerified:false,titleFinalVerified:false,contentFinalVerified:false};\n' +
          'var __titleText='+_titleTextJs+';\n' +
          'var __contentText='+_contentTextJs+';\n' +
          'try{\n' +
          // (a) 等发布页 URL（最多 20s）
          '  var t0=Date.now();\n' +
          '  while(Date.now()-t0<20000){\n' +
          '    if(/creator\\.xiaohongshu\\.com\\/publish\\/publish/.test(location.href))break;\n' +
          '    await new Promise(function(res){setTimeout(res,200);});\n' +
          '  }\n' +
          '  if(!/creator\\.xiaohongshu\\.com\\/publish\\/publish/.test(location.href)){\n' +
          '    r.error="PUBLISH_URL_NOT_LOADED";\n' +
          '    console.log("[XHS] 发布页未在预期时间加载完成");\n' +
          '    return r;\n' +
          '  }\n' +
          '  console.log("[XHS] 发布页已加载");\n' +
          // (b) 等 SPA hydrate（XHS 是 SPA，file input 需要 React 渲染出来）
          '  await new Promise(function(res){setTimeout(res,800);});\n' +
          // (c) 没有视频：跳过（保留用户手动选视频的路径）
          '  if(!'+_videoPresentJs+'){\n' +
          '    if('+_videoSkippedJs+'){\n' +
          '      console.log("[XHS] 视频文件过大，已跳过自动上传，请手动选择");\n' +
          '      r.error="file-too-large";\n' +
          '    }else{\n' +
          '      console.log("[XHS] 没有视频，跳过自动上传");\n' +
          '      r.error="no-video";\n' +
          '    }\n' +
          '    return r;\n' +
          '  }\n' +
          // (d) 注入 file input（标准 Electron/Chromium 方式：DataTransfer + File + change）
          //     mediaIIFE 在 dispatchEvent change 之后立即发 [XHS-UPLOAD] upload-started 并 return，
          //     不再等 DOM 上传完成（v3.0 改造）。这意味着 await 之后立即进入 (d+1) fill title/content。
          '  console.log("[XHS] 正在上传视频");\n' +
          '  console.log("[XHS-UPLOAD] setting file");\n' +
          '  var med=await (' + mediaIIFE + ');\n' +
          '  r.found=!!med.found;\n' +
          '  r.ok=!!med.ok;\n' +
          '  r.pickedCount=med.pickedCount||0;\n' +
          '  r.elapsedMs=med.elapsedMs||0;\n' +
          '  r.attempts=med.attempts||0;\n' +
          '  r.error=med.error||"";\n' +
          '  r.fileInputs=med.fileInputs||[];\n' +
          '  r.fileName=(med.fileNames && med.fileNames[0])||"";\n' +
          '  if(!r.ok){\n' +
          '    console.log("[XHS] 视频上传失败："+(r.error||"未知异常"));\n' +
          '    return r;\n' +
          '  }\n' +
          // (d+1) [XHS-UPLOAD] upload-started 已在 mediaIIFE 内发出，立即开始 fill title/content
          //       这里不再等 upload-completed —— 与新需求一致（不等上传完成即填文字）。
          '  console.log("[XHS-CONTENT] upload started, begin filling content");\n' +
          '  console.log("[XHS-CONTENT] title length=" + (__titleText||"").length);\n' +
          '  console.log("[XHS-CONTENT] content length=" + (__contentText||"").length);\n' +
          // (d+2) fill title —— 重新 querySelector（每次），不持有 DOM 引用
          '  // v3.1：DOM 探针 —— NOT FOUND 时 dump 所有"可见 input / textarea / contenteditable"的\n' +
          '  //   tagName + className + placeholder + aria-label + visible + rect。\n' +
          '  //   这样下一轮我能从日志里看到 XHS 发布页的真实 DOM 结构，精准定位选择器。\n' +
          '  function __probeFields(kind){\n' +
          '    try{\n' +
          '      var dump=[];\n' +
          '      // 探 1：input / textarea（仅 dump 可见且尺寸合理的，避开隐藏表单）\n' +
          '      var inp=document.querySelectorAll("input,textarea");\n' +
          '      for(var i=0;i<inp.length;i++){\n' +
          '        var el=inp[i];\n' +
          '        var r=el.getBoundingClientRect();\n' +
          '        var vis=(r.width>30 && r.height>10);\n' +
          '        if(!vis) continue;\n' +
          '        dump.push({\n' +
          '          tag:el.tagName,\n' +
          '          type:(el.getAttribute("type")||""),\n' +
          '          cls:((el.getAttribute("class")||"")).slice(0,80),\n' +
          '          ph:((el.getAttribute("placeholder")||"")).slice(0,80),\n' +
          '          aria:((el.getAttribute("aria-label")||"")).slice(0,80),\n' +
          '          name:(el.getAttribute("name")||""),\n' +
          '          id:(el.id||""),\n' +
          '          rect:((r.width|0)+"x"+(r.height|0)),\n' +
          '          ce:false\n' +
          '        });\n' +
          '      }\n' +
          '      // 探 2：contenteditable=true（小红书正文 100% 是这种）\n' +
          '      var ce=document.querySelectorAll(\'[contenteditable="true"]\');\n' +
          '      for(var j=0;j<ce.length;j++){\n' +
          '        var el2=ce[j];\n' +
          '        var r2=el2.getBoundingClientRect();\n' +
          '        var vis2=(r2.width>30 && r2.height>10);\n' +
          '        if(!vis2) continue;\n' +
          '        dump.push({\n' +
          '          tag:el2.tagName,\n' +
          '          cls:((el2.getAttribute("class")||"")).slice(0,80),\n' +
          '          aria:((el2.getAttribute("aria-label")||"")).slice(0,80),\n' +
          '          data_ph:((el2.getAttribute("data-placeholder")||"")).slice(0,80),\n' +
          '          id:(el2.id||""),\n' +
          '          rect:((r2.width|0)+"x"+(r2.height|0)),\n' +
          '          ce:true,\n' +
          '          innerLen:(((el2.innerText||el2.textContent)||"")+"").length\n' +
          '        });\n' +
          '      }\n' +
          '      console.log("[XHS-CONTENT] "+kind+" DOM probe (n="+dump.length+")", JSON.stringify(dump));\n' +
          '    }catch(_pe){ console.log("[XHS-CONTENT] "+kind+" DOM probe 异常："+String((_pe&&_pe.message)||_pe)); }\n' +
          '  }\n' +
          '  function __findTitleField(){\n' +
          '    // 按"placeholder / aria-label / 元素类型"多策略查找：input / textarea / contenteditable\n' +
          '    var sel1=document.querySelector(\'input[placeholder*="标题" i],input[placeholder*="title" i],input[aria-label*="标题" i],input[aria-label*="title" i]\');\n' +
          '    if(sel1) return {el:sel1,kind:"input"};\n' +
          '    var sel2=document.querySelector(\'textarea[placeholder*="标题" i],textarea[placeholder*="title" i],textarea[aria-label*="标题" i],textarea[aria-label*="title" i]\');\n' +
          '    if(sel2) return {el:sel2,kind:"textarea"};\n' +
          '    // 退路：第一个 placeholder 含"标题"的 input\n' +
          '    var inputs=document.querySelectorAll("input,textarea");\n' +
          '    for(var i=0;i<inputs.length;i++){\n' +
          '      var ph=(inputs[i].getAttribute("placeholder")||"")+" "+(inputs[i].getAttribute("aria-label")||"");\n' +
          '      if(/标题|title/i.test(ph)) return {el:inputs[i],kind:inputs[i].tagName.toLowerCase()};\n' +
          '    }\n' +
          '    return null;\n' +
          '  }\n' +
          '  function __setFieldValue(el,text){\n' +
          '    if(!el) return false;\n' +
          '    var tag=el.tagName.toLowerCase();\n' +
          '    var isCE=el.getAttribute && el.getAttribute("contenteditable")==="true" || el.isContentEditable;\n' +
          '    if(tag==="input" || tag==="textarea"){\n' +
          '      var proto=tag==="input"?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;\n' +
          '      var desc=Object.getOwnPropertyDescriptor(proto,"value");\n' +
          '      desc && desc.set && desc.set.call(el,text);\n' +
          '      el.dispatchEvent(new Event("input",{bubbles:true,cancelable:true}));\n' +
          '      el.dispatchEvent(new Event("change",{bubbles:true,cancelable:true}));\n' +
          '      return true;\n' +
          '    }\n' +
          '    if(isCE){\n' +
          '      el.focus();\n' +
          '      el.innerHTML="";\n' +
          '      document.execCommand && document.execCommand("insertText",false,text);\n' +
          '      if(!el.innerHTML || el.innerText.trim()===0){\n' +
          '        // execCommand 不可用时退回手动插入文本节点\n' +
          '        el.appendChild(document.createTextNode(text));\n' +
          '      }\n' +
          '      el.dispatchEvent(new Event("input",{bubbles:true,cancelable:true}));\n' +
          '      return true;\n' +
          '    }\n' +
          '    return false;\n' +
          '  }\n' +
          '  function __verifyField(el,expected){\n' +
          '    if(!el) return false;\n' +
          '    var got="";\n' +
          '    if(el.value!==undefined) got=el.value+"";\n' +
          '    else if(el.innerText!==undefined) got=el.innerText+"";\n' +
          '    return got.indexOf(expected)===0;\n' +
          '  }\n' +
          // v3.2：等字段渲染。XHS 发布页是上传完才显示标题+正文输入区，
          //       直接在 upload-started 时找会找不到 —— 需要 poll 等到 React 把输入区挂载出来。
          //       等待期间每 5s dump 一次 probe，让日志能看到 DOM 从空 → 有元素 的过程。
          '  async function __waitForFields(){\n' +
          '    var t1=Date.now();\n' +
          '    var lastDump=0;\n' +
          '    while(Date.now()-t1<30000){\n' +
          '      var t=__findTitleField();\n' +
          '      var c=__findContentField();\n' +
          '      if(t && c) return {ok:true,titleField:t,contentField:c,ms:Date.now()-t1};\n' +
          '      if(Date.now()-lastDump>5000){\n' +
          '        __probeFields("wait-poll");\n' +
          '        lastDump=Date.now();\n' +
          '      }\n' +
          '      await new Promise(function(res){setTimeout(res,300);});\n' +
          '    }\n' +
          '    return {ok:false,ms:30000};\n' +
          '  }\n' +
          // (d+3) fill title+content 主流程（v3.2：先 waitForFields 等字段渲染，再 fill）
          '  console.log("[XHS-CONTENT] waiting for fields to render (XHS 上传完才挂载输入区)");\n' +
          '  var __wf=await __waitForFields();\n' +
          '  console.log("[XHS-CONTENT] fields ready="+__wf.ok+" ms="+__wf.ms);\n' +
          '  if(!__wf.ok){\n' +
          '    console.log("[XHS-CONTENT] title+content fields NEVER rendered in 30s");\n' +
          '    __probeFields("timeout");\n' +
          '  }\n' +
          '  var __titleField=null;\n' +
          '  if(__wf.ok){\n' +
          '    try{\n' +
          '      __titleField=__wf.titleField;\n' +
          '      console.log("[XHS-CONTENT] title field found",{kind:__titleField.kind});\n' +
          '      var __titleOk=__setFieldValue(__titleField.el,__titleText);\n' +
          '      if(__titleOk){\n' +
          '        console.log("[XHS-CONTENT] title filled");\n' +
          '        await new Promise(function(res){setTimeout(res,200);});\n' +
          '        r.titleVerified=__verifyField(__titleField.el,__titleText);\n' +
          '        console.log("[XHS-CONTENT] title verified="+r.titleVerified);\n' +
          '      }else{\n' +
          '        console.log("[XHS-CONTENT] title filled=false (kind="+__titleField.kind+")");\n' +
          '      }\n' +
          '    }catch(_te){ console.log("[XHS-CONTENT] title fill 异常："+String((_te&&_te.message)||_te)); }\n' +
          '  }\n' +

          // (d+4) fill content —— 同样策略
          '  function __findContentField(){\n' +
          '    // 优先级：textarea（placeholder 含"正文"/"内容"/"描述"） > contenteditable > 大文本框\n' +
          '    var ta=document.querySelector(\'textarea[placeholder*="正文" i],textarea[placeholder*="内容" i],textarea[placeholder*="描述" i],textarea[placeholder*="content" i],textarea[aria-label*="正文" i],textarea[aria-label*="内容" i]\');\n' +
          '    if(ta) return {el:ta,kind:"textarea"};\n' +
          '    var ce=document.querySelector(\'[contenteditable="true"]\');\n' +
          '    if(ce) return {el:ce,kind:"contenteditable"};\n' +
          '    var tas=document.querySelectorAll("textarea");\n' +
          '    if(tas.length) return {el:tas[0],kind:"textarea"};\n' +
          '    var ces=document.querySelectorAll(\'[contenteditable="true"], [contenteditable=""]\');\n' +
          '    if(ces.length) return {el:ces[0],kind:"contenteditable"};\n' +
          '    return null;\n' +
          '  }\n' +
          '  var __contentField=null;\n' +
          '  if(__wf.ok){\n' +
          '    try{\n' +
          '      __contentField=__wf.contentField;\n' +
          '      console.log("[XHS-CONTENT] content field found",{kind:__contentField.kind});\n' +
          '      var __contentOk=__setFieldValue(__contentField.el,__contentText);\n' +
          '      if(__contentOk){\n' +
          '        console.log("[XHS-CONTENT] content filled");\n' +
          '        await new Promise(function(res){setTimeout(res,200);});\n' +
          '        r.contentVerified=__verifyField(__contentField.el,__contentText);\n' +
          '        console.log("[XHS-CONTENT] content verified="+r.contentVerified);\n' +
          '      }else{\n' +
          '        console.log("[XHS-CONTENT] content filled=false (kind="+__contentField.kind+")");\n' +
          '      }\n' +
          '    }catch(_ce){ console.log("[XHS-CONTENT] content fill 异常："+String((_ce&&_ce.message)||_ce)); }\n' +
          '  }\n' +

          // (e) 等真实上传完成（DOM 信号，不依赖 setTimeout）
          //     满足任一即视为完成：
          //       1) progress/uploading/loading 全部不可见  && 出现 <video src=非blob:>
          //       2) progress/uploading/loading 全部不可见  && 页面文本含「上传成功/上传完成/已上传」
          //       3) progress/uploading/loading 全部不可见  && role=progressbar aria-valuenow=100
          '  console.log("[XHS] 视频上传中");\n' +
          '  console.log("[XHS-UPLOAD] waiting upload-completed");\n' +
          '  var doneInfo=null;\n' +
          '  var t1=Date.now();\n' +
          '  while(Date.now()-t1<180000){\n' +
          '    var busy=document.querySelectorAll(\'[class*="progress" i],[class*="uploading" i],[class*="loading" i],[class*="percent" i]\');\n' +
          '    var busyVis=0;\n' +
          '    for(var b=0;b<busy.length;b++){\n' +
          '      var r2=busy[b].getBoundingClientRect();\n' +
          '      if(r2.width>0 && r2.height>0) busyVis++;\n' +
          '    }\n' +
          '    var videos=document.querySelectorAll("video");\n' +
          '    var hasVid=false;\n' +
          '    for(var v=0;v<videos.length;v++){\n' +
          '      var src=videos[v].currentSrc||videos[v].src||"";\n' +
          '      if(src && src.indexOf("blob:")!==0) { hasVid=true; break; }\n' +
          '    }\n' +
          '    var successText=/上传成功|上传完成|已上传/i.test(document.body && document.body.innerText || "");\n' +
          '    var aria100=document.querySelector(\'[role="progressbar"][aria-valuenow="100"]\')!==null;\n' +
          '    if(busyVis===0 && (hasVid || successText || aria100)){\n' +
          '      doneInfo={hasVid:hasVid,successText:successText,aria100:aria100};\n' +
          '      break;\n' +
          '    }\n' +
          '    await new Promise(function(res){setTimeout(res,600);});\n' +
          '  }\n' +
          '  if(!doneInfo){\n' +
          '    r.error="UPLOAD_NOT_CONFIRMED_IN_DOM_TIMEOUT";\n' +
          '    console.log("[XHS] 视频上传失败：DOM 未在 180s 内显示预览/完成信号");\n' +
          '    return r;\n' +
          '  }\n' +
          '  r.domDone=doneInfo;\n' +
          '  r.elapsedMs=(r.elapsedMs||0)+(Date.now()-t1);\n' +
          '  console.log("[XHS-UPLOAD] upload-completed");\n' +
          '  console.log("[XHS] 视频上传完成");\n' +
          // (f) 最终验证 title / content —— 上传过程中可能被 React re-render 清空
          //     重新 querySelector（不持有旧引用），如果验证失败最多补填一次（不重复填）
          '  try{\n' +
          '    var __t2=__findTitleField();\n' +
          '    if(__t2 && __t2.el){\n' +
          '      r.titleFinalVerified=__verifyField(__t2.el,__titleText);\n' +
          '      if(!r.titleFinalVerified){\n' +
          '        __setFieldValue(__t2.el,__titleText);\n' +
          '        await new Promise(function(res){setTimeout(res,200);});\n' +
          '        r.titleFinalVerified=__verifyField(__t2.el,__titleText);\n' +
          '      }\n' +
          '      console.log("[XHS-CONTENT] title final verified="+r.titleFinalVerified);\n' +
          '    }else{\n' +
          '      r.titleFinalVerified=false;\n' +
          '      console.log("[XHS-CONTENT] title final verified=false (field gone after re-render)");\n' +
          '    }\n' +
          '  }catch(_e3){ console.log("[XHS-CONTENT] title final verify 异常："+String((_e3&&_e3.message)||_e3)); }\n' +
          '  try{\n' +
          '    var __c2=__findContentField();\n' +
          '    if(__c2 && __c2.el){\n' +
          '      r.contentFinalVerified=__verifyField(__c2.el,__contentText);\n' +
          '      if(!r.contentFinalVerified){\n' +
          '        __setFieldValue(__c2.el,__contentText);\n' +
          '        await new Promise(function(res){setTimeout(res,200);});\n' +
          '        r.contentFinalVerified=__verifyField(__c2.el,__contentText);\n' +
          '      }\n' +
          '      console.log("[XHS-CONTENT] content final verified="+r.contentFinalVerified);\n' +
          '    }else{\n' +
          '      r.contentFinalVerified=false;\n' +
          '      console.log("[XHS-CONTENT] content final verified=false (field gone after re-render)");\n' +
          '    }\n' +
          '  }catch(_e4){ console.log("[XHS-CONTENT] content final verify 异常："+String((_e4&&_e4.message)||_e4)); }\n' +
          '  console.log("[XHS] ready for manual publish");\n' +
          '  return r;\n' +
          '}catch(outerE){\n' +
          '  r.error=String((outerE&&outerE.message)||outerE);\n' +
          '  try{ console.log("[XHS] 视频上传异常："+r.error); }catch(_e){}\n' +
          '  return r;\n' +
          '}\n' +
          '})()';
        return combined;
      } catch (e) {
        return inject("function(){return {status:'fill-error',error:'fill-script-build-failed: '+String((e&&e.message)||e)};}", p || {});
      }
    },
    submit: function (p) {
      // v1.7：小红书永不自动点发布按钮 —— 用户在页面手动确认
      return inject("function(){return {status:'manual',note:'小红书：v1.7 仅准备发布内容（标题/正文/视频），不自动点击「发布」按钮。请在打开的窗口中检查并手动点击。'};}", p || {});
    }
  }
};

module.exports = { adapters: adapters, inject: inject };
