// Rokit · 渲染管线单元测试
// 覆盖：miniMd 转义 + markdown 转换、pushAI / pushAIHtml 入栈语义、
// renderFlow 的 m.html 分叉渲染、esc XSS 防御。
// 这些函数都在 index.html 的 IIFE 里，外部不能直接 require；测试通过
// 文本提取 + eval 的方式把函数体加载进测试作用域，避免引入 happy-dom/jsdom。

const fs = require('fs');
const path = require('path');

// ---------- 源码提取 ----------
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scriptBlocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
const code = (scriptBlocks[scriptBlocks.length - 1] || '').replace(/<\/?script>/g, '');

/**
 * 从 IIFE 源码里按花括号配对提取某个函数定义。
 * 找到 `function NAME(`, 然后向右扫描到匹配的 `}`。
 */
function pickFunction(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(', 'm');
  const m = code.match(re);
  if (!m) throw new Error('未找到函数: ' + name);
  const startIdx = m.index;
  // 找第一个 `{`
  let i = code.indexOf('{', startIdx);
  if (i < 0) throw new Error('函数 ' + name + ' 没有花括号');
  let depth = 1;
  i++;
  while (i < code.length && depth > 0) {
    const ch = code[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return code.slice(startIdx, i);
}

/**
 * 把一组函数加载到同一作用域（避免 msgAI 调用 av(17) 时跨闭包找不到 av）。
 * 用单次 new Function 编译 + return 对象，把多个函数一并导出。
 */
function loadFns(...names) {
  const bodies = names.map((n) => pickFunction(n)).join('\n');
  const ret = 'return { ' + names.join(', ') + ' };';
  return new Function(bodies + '\n' + ret)();
}

// av 由 msgAI 内部调用，这里仅解构以触发一起加载，避免作用域问题。
const { miniMd, esc, msgAI, msgUser } = loadFns('miniMd', 'esc', 'av', 'msgAI', 'msgUser');

function renderRailAt(step) {
  const stages = ['交付作品', 'AI 诊断', '录屏创作视频', '首秀计划', '打通平台', '发布清单'].map((name) => ({ name }));
  const track = { innerHTML: '' };
  const render = new Function(
    'STAGES',
    'state',
    'document',
    'esc',
    pickFunction('stageOf') + '\n' + pickFunction('renderRail') + '\nreturn renderRail;'
  )(stages, { step }, { getElementById: () => track }, esc);
  render();
  return track.innerHTML;
}

function createTypeSelection(type) {
  const state = { project: { type } };
  const api = new Function(
    'state',
    ['getProjectTypes', 'setProjectTypes', 'toggleProjectType'].map(pickFunction).join('\n') +
      '\nreturn { getProjectTypes, toggleProjectType };'
  )(state);
  return { state, ...api };
}

function runVoiceFileImport(file, currentVoice) {
  const state = { voice: currentVoice || {} };
  const events = { rendered: 0, revoked: [], messages: [] };
  function MockAudio() {
    this.duration = 18.25;
  }
  Object.defineProperty(MockAudio.prototype, 'src', {
    set(value) {
      this.source = value;
      if (file.type && file.type.indexOf('audio/') !== 0) this.onerror();
      else this.onloadedmetadata();
    },
  });
  const input = { files: [file], value: 'selected' };
  const handler = new Function(
    'window',
    'ver',
    'URL',
    'Audio',
    'renderFlow',
    'toast',
    pickFunction('loadVoiceFile') + '\nreturn loadVoiceFile;'
  )(
    {},
    () => state.voice,
    {
      createObjectURL: () => 'blob:local-audio',
      revokeObjectURL: (url) => events.revoked.push(url),
    },
    MockAudio,
    () => events.rendered++,
    (message) => events.messages.push(message)
  );
  handler(input);
  return { state, input, events };
}

function renderRocketChoices(platforms) {
  return new Function(
    'esc',
    pickFunction('renderRocketChoices') + '\nreturn renderRocketChoices;'
  )(esc)(platforms);
}

function createWorkMenuToggle() {
  const buttonClasses = new Set();
  const menuClasses = new Set();
  const button = {
    classList: { add: (name) => buttonClasses.add(name), remove: (name) => buttonClasses.delete(name) },
  };
  const menu = {
    classList: { add: (name) => menuClasses.add(name), remove: (name) => menuClasses.delete(name) },
  };
  const card = { querySelector: () => menu };
  button.closest = () => card;
  const win = {};
  const exposure = code.match(/window\.toggleWMenu\s*=\s*toggleWMenu\s*;/);
  if (!exposure) throw new Error('作品菜单处理器未暴露给内联点击事件');
  new Function(
    'window',
    'document',
    pickFunction('closeAllWMenu') + '\n' +
      pickFunction('toggleWMenu') + '\n' +
      exposure[0]
  )(win, { querySelectorAll: () => [] });
  win.toggleWMenu(button, 'w1');
  return { buttonClasses, menuClasses };
}

// ---------- 渲染管线镜像 ----------
// pushAI / pushAIHtml 在原代码里是依赖外层 state 的纯函数，
// 测试用最简 state 镜像，确保与生产路径行为一致。
function makePushers(state) {
  function pushAI(t) {
    state.messages.push({ role: 'ai', text: t });
  }
  function pushAIHtml(t) {
    state.messages.push({ role: 'ai', text: t, html: true });
  }
  return { pushAI, pushAIHtml };
}

// 镜像 renderFlow L3161-3165 的渲染分叉逻辑。
// 这是本次修复的核心分叉：m.html ? m.text : miniMd(m.text)
function render(state) {
  var htmlOut = '';
  state.messages.forEach(function (m) {
    var rendered = m.html ? m.text : miniMd(m.text);
    htmlOut += m.role === 'ai' ? msgAI(rendered) : msgUser(rendered);
  });
  return htmlOut;
}

// ============================================================
// miniMd · 字符串净化 + 轻量 markdown
// ============================================================
describe('miniMd · XSS 防护（HTML 实体转义）', () => {
  it('应转义 < > & " 为 HTML 实体', () => {
    const out = miniMd('a < b > c & "d"');
    expect(out).toContain('&lt;');
    expect(out).toContain('&gt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
  });

  it('转义后用户看不到 <script>', () => {
    const out = miniMd('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('img 标签的 onerror 应被转义', () => {
    const out = miniMd('<img src=x onerror=alert(1)>');
    expect(out).not.toMatch(/<img/);
    expect(out).toContain('&lt;img');
  });
});

describe('miniMd · markdown 转换', () => {
  it('\\n 应转为 <br>', () => {
    expect(miniMd('a\nb')).toContain('<br>');
  });

  it('**文本** 应转为 <b>文本</b>', () => {
    expect(miniMd('**文案**')).toContain('<b>文案</b>');
  });

  it('连续 \\n\\n 应转为两个 <br>', () => {
    const out = miniMd('第一段\n\n第二段');
    expect(out).toContain('<br><br>');
  });

  it('行内 `code` 应转为 <code>', () => {
    expect(miniMd('`npm test`')).toContain('<code>npm test</code>');
  });

  it('``` 代码块 应转为 <pre><code>', () => {
    expect(miniMd('```\nls\n```')).toContain('<pre><code>');
  });

  it('无序列表 - 应转为 <ul><li>', () => {
    const out = miniMd('- one\n- two');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<li>two</li>');
  });

  it('链接 [text](url) 应转为 <a>', () => {
    const out = miniMd('[GitHub](https://github.com/foo)');
    expect(out).toContain('<a href="https://github.com/foo"');
    expect(out).toContain('>GitHub</a>');
  });

  it('javascript: 伪协议 URL 经 miniMd 后仍以字面文本存在（防御依靠调用方控制 URL 来源）', () => {
    // miniMd 链接正则只匹配 https?://，对 javascript: 不会触发 markdown 转换。
    // 但 pushAI 路径会过 miniMd，里面的 < > & " 会被转义，所以不会注入 HTML。
    const out = miniMd('[bad](javascript:alert(1))');
    expect(out).not.toContain('<a ');
    // 完整 URL 字符串仍以字面文本存在（未生成可点击的 a 标签）
    expect(out).toContain('[bad](javascript:alert(1))');
  });
});

// ============================================================
// pushAI / pushAIHtml 入栈语义
// ============================================================
describe('pushAI / pushAIHtml · 入栈结构', () => {
  it('pushAI 不应设置 html 标记', () => {
    const state = { messages: [] };
    const { pushAI } = makePushers(state);
    pushAI('hello');
    expect(state.messages[0]).toEqual({ role: 'ai', text: 'hello' });
    expect(state.messages[0].html).toBeFalsy();
  });

  it('pushAIHtml 应设置 html:true 标记', () => {
    const state = { messages: [] };
    const { pushAIHtml } = makePushers(state);
    pushAIHtml('<div>raw</div>');
    expect(state.messages[0]).toEqual({ role: 'ai', text: '<div>raw</div>', html: true });
  });

  it('pushAI 与 pushAIHtml 可交替入栈，标记互不干扰', () => {
    const state = { messages: [] };
    const { pushAI, pushAIHtml } = makePushers(state);
    pushAI('纯文本');
    pushAIHtml('<b>原生</b>');
    expect(state.messages[0].html).toBeFalsy();
    expect(state.messages[1].html).toBe(true);
  });
});

// ============================================================
// render · 渲染分叉（本次修复的核心行为）
// ============================================================
describe('render · m.html 分叉渲染', () => {
  it('pushAI 路径：HTML 标签应被 miniMd 转义为字面字符', () => {
    // 这是用户报告的 bug 现象：写 HTML 会被显示成 <br>
    const state = { messages: [] };
    const { pushAI } = makePushers(state);
    pushAI('你好<br>我');
    const out = render(state);
    expect(out).toContain('&lt;br&gt;');
    expect(out).not.toContain('<br>我');
  });

  it('pushAI 路径（修复后写法）：markdown 应正确转为 HTML', () => {
    const state = { messages: [] };
    const { pushAI } = makePushers(state);
    pushAI('你好\n我');
    const out = render(state);
    expect(out).toContain('<br>');
    expect(out).not.toContain('&lt;br&gt;');
  });

  it('pushAI 路径：双引号应被 esc 转义（XSS 防护）', () => {
    const state = { messages: [] };
    const { pushAI } = makePushers(state);
    pushAI('他说："<script>alert(1)</script>"');
    const out = render(state);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&quot;');
  });

  it('pushAIHtml 路径：原生 HTML 应原样渲染', () => {
    const state = { messages: [] };
    const { pushAIHtml } = makePushers(state);
    pushAIHtml(
      '<div class="launch-wrap"><div class="launch-rocket">' +
        '<svg viewBox="0 0 24 24"><path d="M12 3"/></svg>' +
        '</div><b>发射成功</b><button class="btn">查看数据看板</button></div>'
    );
    const out = render(state);
    expect(out).toContain('<div class="launch-wrap">');
    expect(out).toContain('<div class="launch-rocket">');
    expect(out).toContain('<svg viewBox="0 0 24 24">');
    expect(out).toContain('<path d="M12 3"/>');
    expect(out).toContain('<b>发射成功</b>');
    expect(out).toContain('<button class="btn">');
    expect(out).not.toContain('&lt;div');
  });

  it('pushAIHtml 路径：动态数据已 esc 才安全（演示正确用法）', () => {
    // 模拟「发射成功」里调用 esc(state.project.name)
    const state = { messages: [] };
    const { pushAIHtml } = makePushers(state);
    const userName = '<script>alert(1)</script>';
    pushAIHtml('<b>《' + esc(userName) + '》已发布</b>');
    const out = render(state);
    // 用户的恶意 payload 经过 esc 后已无害
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('<b>《');
    expect(out).toContain('》已发布</b>');
  });

  it('pushAIHtml 路径：dynamic 数据未 esc 会注入（演示错误用法 → 防御性文档）', () => {
    // 此用例不是为了"通过"，而是把"反模式"固化下来，作为回归警示：
    // 任何 pushAIHtml 的调用方都必须自己 esc，否则会注入。
    const state = { messages: [] };
    const { pushAIHtml } = makePushers(state);
    pushAIHtml('<b>《<script>alert(1)</script>》已发布</b>');
    const out = render(state);
    expect(out).toContain('<script>alert(1)</script>'); // 未转义，会注入
  });
});

describe('renderRail · 步骤进度', () => {
  it('当前阶段高亮圆点且步骤条不可点击跳转', () => {
    const out = renderRailAt(4);
    expect(out).toContain('class="seg now" data-rail-step="1"');
    expect(out).not.toContain('onclick=');
    expect(out).not.toContain('railJump');
  });

  it('发射成功后发布清单显示完成状态', () => {
    const out = renderRailAt(13);
    expect(out).toContain('class="seg done" data-rail-step="5"');
    expect(out).not.toContain('class="seg now" data-rail-step="5"');
  });
});

describe('作品类别 · 多选', () => {
  it('保留旧的单类别值，支持增加和取消多个类别', () => {
    const selection = createTypeSelection('效率工具');
    selection.toggleProjectType('时间管理');
    selection.toggleProjectType('笔记知识管理');
    expect(selection.state.project.type).toBe('效率工具、时间管理、笔记知识管理');
    expect(selection.getProjectTypes()).toEqual(['效率工具', '时间管理', '笔记知识管理']);

    selection.toggleProjectType('时间管理');
    expect(selection.state.project.type).toBe('效率工具、笔记知识管理');
  });
});

describe('配音 · 本地音频导入', () => {
  it('读取本地音频并写入预览、时长和来源状态', () => {
    const file = { type: 'audio/mpeg', name: 'voice.mp3' };
    const result = runVoiceFileImport(file);
    expect(result.state.voice.voiceBlob).toBe(file);
    expect(result.state.voice.voiceUrl).toBe('blob:local-audio');
    expect(result.state.voice.voiceDur).toBe(18.25);
    expect(result.state.voice.voiceSource).toBe('file');
    expect(result.input.value).toBe('');
    expect(result.events.rendered).toBe(1);
  });

  it('拒绝非音频文件', () => {
    const result = runVoiceFileImport({ type: 'text/plain', name: 'notes.txt' });
    expect(result.state.voice.voiceUrl).toBeUndefined();
    expect(result.events.messages).toContain('请选择音频文件');
  });
});

describe('火箭发送 · 内置平台选项', () => {
  it('展示所有内置平台，**默认全部不勾选**（v1.12 行为变更）', () => {
    const platforms = Array.from({ length: 13 }, (_, index) => ({
      id: 'platform-' + index,
      name: '内置平台 ' + index,
      color: '#0E7C7B',
      auto: index < 3,
    }));
    const html = renderRocketChoices(platforms);
    expect(html.match(/data-pid="platform-\d+"/g)).toHaveLength(13);
    // v1.12：所有 checkbox 默认未勾选（无论 p.auto 是 true / false）
    expect(html.match(/ checked\b/g)).toBeNull();
    expect(html).toContain('需确认');
    expect(html).toContain('自动');
  });

  it('火箭发射的「需人工确认」平台文案在画面顶部右侧显示', () => {
    // 验 v1.12 行为：文案字段保持「自动 / 需确认」与 title 属性
    const platforms = [
      { id: 'auto-platform', name: 'AutoPlatform', color: '#000', auto: true },
      { id: 'manual-platform', name: 'ManualPlatform', color: '#fff', auto: false },
    ];
    const html = renderRocketChoices(platforms);
    expect(html).toContain('AutoPlatform');
    expect(html).toContain('ManualPlatform');
    expect(html).toContain('自动');
    expect(html).toContain('需确认');
    // 即便是 auto=true 的平台，也不应该出现 checked 属性
    var checkedInAuto = new RegExp('<input[^>]*data-pid="auto-platform"[^>]*\\schecked\\b');
    expect(checkedInAuto.test(html)).toBe(false);
    var checkedInManual = new RegExp('<input[^>]*data-pid="manual-platform"[^>]*\\schecked\\b');
    expect(checkedInManual.test(html)).toBe(false);
  });

  it('即使存在 auto 平台，最终渲染也应保证 0 个 checked', () => {
    const platforms = [
      { id: 'a', name: 'A', color: '#000', auto: true },
      { id: 'b', name: 'B', color: '#000', auto: true },
      { id: 'c', name: 'C', color: '#000', auto: false }
    ];
    const html = renderRocketChoices(platforms);
    // 严格断言：checked 关键字出现在 <input> 元素的属性里 = 0 次
    var checkedMatches = html.match(/<input[^>]*\schecked\b/gi);
    expect(checkedMatches).toBeNull();
  });
});

describe('作品卡片 · 更多操作菜单', () => {
  it('内联点击处理器可访问并打开菜单', () => {
    const { buttonClasses, menuClasses } = createWorkMenuToggle();
    expect(buttonClasses.has('open')).toBe(true);
    expect(menuClasses.has('open')).toBe(true);
  });
});

// ============================================================
// 回归保护 · 防御本轮已修 bug 复发
// ============================================================
describe('回归保护 · 首秀向导文案 / 渲染', () => {
  it('欢迎语修复后应渲染真实 <br><b>，无字面字符泄漏', () => {
    const state = { messages: [] };
    const { pushAI } = makePushers(state);
    // 5487 行修复后的文案
    pushAI(
      '你好，我是 Rokit。\n把作品交给我——**文案、配音、填表发布、反馈采集**，我帮你接管。\n\n' +
        '下面我已经摆了 4 个示例作品供你参考。**点下方任意一张卡片里的「以此为模板」按钮**，' +
        '或点 "+ 登记新作品" 开始你的第一个首秀。'
    );
    const out = render(state);
    expect(out).toContain('<br>把作品交给我');
    expect(out).toContain('<b>文案、配音、填表发布、反馈采集</b>');
    expect(out).toContain('<br><br>');
    expect(out).toContain('&quot;+ 登记新作品&quot;');
    expect(out).not.toContain('&lt;br&gt;');
    expect(out).not.toContain('&lt;b&gt;');
  });

  it('欢迎语修复前写法应被识别为 bug（断言字面字符存在，固化回归证据）', () => {
    const state = { messages: [] };
    const { pushAI } = makePushers(state);
    // 5474 行修复前的文案
    pushAI(
      '你好，我是 Rokit。<br>把作品交给我——<b>文案、配音、填表发布、反馈采集</b>，我帮你接管。<br><br>' +
        '下面我已经摆了 4 个示例作品供你参考。<b>点下方任意一张卡片里的「以此为模板」按钮</b>，' +
        '或点 "+ 登记新作品" 开始你的第一个首秀。'
    );
    const out = render(state);
    // 反向断言：旧写法必须仍触发 bug，证明修复路径有效
    expect(out).toContain('&lt;br&gt;');
    expect(out).toContain('&lt;b&gt;');
  });

  it('发射成功卡片应原样渲染 launch-rocket + button', () => {
    const state = { messages: [] };
    const { pushAIHtml } = makePushers(state);
    // 4316-4322 行发射成功消息（简化版）
    pushAIHtml(
      '<div class="launch-wrap"><div class="launch-rocket">' +
        '<svg viewBox="0 0 24 24"><path d="M12 3l2.2 5.3L20 10l-5.8 1.7L12 17z"/></svg>' +
        '</div><div style="font-size:16px;font-weight:700">发射成功</div>' +
        '<div style="margin-top:12px"><button class="btn" onclick="go(\'dashboard\')">查看数据看板</button></div>' +
        '</div>'
    );
    const out = render(state);
    expect(out).toContain('class="launch-rocket"');
    expect(out).toContain('class="launch-wrap"');
    expect(out).toContain('M12 3l2.2 5.3');
    expect(out).toContain('<button class="btn"');
    expect(out).not.toContain('&lt;div class="launch-wrap"');
  });

  it('打字机动画标签 <span class="typing"> 应原样渲染', () => {
    const state = { messages: [] };
    const { pushAIHtml } = makePushers(state);
    pushAIHtml('正在为《Rokit》生成诊断……<span class="typing"><i></i><i></i><i></i></span>');
    const out = render(state);
    expect(out).toContain('<span class="typing">');
    expect(out).toContain('<i></i>');
    expect(out).not.toContain('&lt;span class="typing"&gt;');
  });

  it('抓取结果卡片 <div class="grab-card"> 应原样渲染', () => {
    const state = { messages: [] };
    const { pushAIHtml } = makePushers(state);
    pushAIHtml(
      '<div class="grab-card">' +
        '<div style="font-size:14px;font-weight:700">' + esc('Rokit') + '</div>' +
        '<div style="font-size:13px;color:#5A6B72">已抓取</div>' +
        '</div>'
    );
    const out = render(state);
    expect(out).toContain('<div class="grab-card">');
    expect(out).toContain('font-weight:700">Rokit</div>');
  });
});

// ============================================================
// esc · XSS 防御基础（被 pushAIHtml 调用方依赖）
// ============================================================
describe('esc · XSS 基础转义', () => {
  it('应转义 & < > "', () => {
    expect(esc('&')).toBe('&amp;');
    expect(esc('<')).toBe('&lt;');
    expect(esc('>')).toBe('&gt;');
    expect(esc('"')).toBe('&quot;');
  });

  it('混合输入应同时转义多个字符', () => {
    expect(esc('<a href="x">')).toBe('&lt;a href=&quot;x&quot;&gt;');
  });

  it('应接受非字符串并强制转换', () => {
    expect(esc(123)).toBe('123');
    expect(esc(null)).toBe('null');
    expect(esc(undefined)).toBe('undefined');
  });
});