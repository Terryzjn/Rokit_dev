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

  // ---- Product Hunt（多步表单，每步需手动 Next/Submit） ----
  ph: {
    auto: false,
    manualReason: '多步表单，每一步都需手动 Next，最后一步手动 Submit',
    note: 'Product Hunt 是多步向导，Rokit 只填第一步的 name / tagline / description / url，后续每一步都需用户手动点击 Next。',
    launch: function () { return 'https://www.producthunt.com/posts/new'; },
    fill: function (p) {
      return inject('(async function(p){\n' + WAIT + '\n' + SETV + '\n' +
        "try{await waitFor('input,textarea',6000);}catch(e){return {status:'need_login'};}\n" +
        "var name=document.querySelector('input[name=\"name\"], input[placeholder*=\"Product\"], input[placeholder*=\"产品\"]');if(name)setv(name,p.title);\n" +
        "var tg=document.querySelector('textarea[name=\"tagline\"], input[name=\"tagline\"]');if(tg)setv(tg,(p.intro||p.body||'').slice(0,60));\n" +
        "var d=document.querySelector('textarea[name=\"description\"], textarea[placeholder*=\"Description\"], textarea[placeholder*=\"描述\"]');if(d)setv(d,p.body);\n" +
        "var lk=document.querySelector('input[name=\"url\"], input[placeholder*=\"URL\"], input[placeholder*=\"链接\"]');if(lk)setv(lk,p.link);\n" +
        "return {status:'filled',note:'Product Hunt 为多步表单，请逐页点击 Next 并最终确认提交'};})", p);
    },
    submit: function (p) {
      return inject('(async function(p){\n' +
        "var btns=[].slice.call(document.querySelectorAll('button')).filter(function(b){return /^(submit|next|publish)/i.test((b.textContent||'').trim());});\n" +
        "if(!btns.length)return {status:'confirm'};\n" +
        "btns[0].click();return {status:'ok'};})", p);
    }
  },

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
    launch: function () { return 'https://web.okjike.com/new-post'; },
    fill: function (p) {
      return inject('(async function(p){\n' + WAIT + '\n' + SETV + '\n' +
        "try{await waitFor('textarea,input,[contenteditable=\"true\"]',6000);}catch(e){return {status:'need_login'};}\n" +
        "var ta=document.querySelector('textarea,[contenteditable=\"true\"]');if(ta){if(ta.tagName==='TEXTAREA'){if(!ta.value)setv(ta,p.body);}else if(!ta.textContent.trim()){ta.focus();document.execCommand('insertText',false,p.body);}}\n" +
        "return {status:'filled',note:'即刻发布请确认后点击发送'};})", p);
    },
    submit: function (p) { return inject('({status:\'confirm\',note:\'即刻发布请在窗口手动确认发送\'})', p); }
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
  }
};

module.exports = { adapters: adapters, inject: inject };
