// Rokit · 平台发布适配器单元测试
// 验证所有 13 个平台注入脚本的语法合法性、launch URL 拼接、status 语义
// vitest 全局由 vitest.config.js globals:true 注入
const { adapters, inject } = require('../electron/publishers');

const ALL_PLATFORMS = [
  'github', 'ph', 'v2ex', 'juejin', 'x', 'facebook', 'youtube',
  'douyin', 'xhs', 'bili', 'jike', 'zhihu', 'wechat'
];

describe('publishers · 注册表完整性', () => {
  it('应当覆盖所有 13 个目标平台', () => {
    for (const id of ALL_PLATFORMS) {
      expect(adapters[id]).toBeDefined();
      expect(adapters[id].launch).toBeTypeOf('function');
      expect(adapters[id].fill).toBeTypeOf('function');
      expect(adapters[id].submit).toBeTypeOf('function');
    }
  });

  it('每个平台应声明 auto 标志', () => {
    for (const id of ALL_PLATFORMS) {
      expect(typeof adapters[id].auto).toBe('boolean');
    }
  });
});

describe('publishers · launch URL', () => {
  it('github：应能从 link 中提取 owner/repo 并跳到 releases/new', () => {
    const url = adapters.github.launch({ link: 'https://github.com/foo/bar' });
    expect(url).toBe('https://github.com/foo/bar/releases/new');
  });

  it('github：link 缺失时应返回 null（让 UI 提示用户补填）', () => {
    expect(adapters.github.launch({})).toBeNull();
    expect(adapters.github.launch({ link: 'not-a-url' })).toBeNull();
  });

  it('github：owner/repo 包含特殊字符时也应正确拼接', () => {
    const url = adapters.github.launch({ link: 'https://github.com/user-with-dots/repo.name' });
    expect(url).toBe('https://github.com/user-with-dots/repo.name/releases/new');
  });

  it('github：自动去掉 .git 后缀', () => {
    const url = adapters.github.launch({ link: 'https://github.com/foo/bar.git' });
    expect(url).toBe('https://github.com/foo/bar/releases/new');
  });

  it('静态 URL 平台：launch 应返回正确的发布页', () => {
    expect(adapters.ph.launch()).toMatch(/^https:\/\/www\.producthunt\.com\/posts\/new$/);
    expect(adapters.v2ex.launch()).toMatch(/^https:\/\/www\.v2ex\.com\/new$/);
    expect(adapters.juejin.launch()).toMatch(/^https:\/\/juejin\.cn\/editor\/drafts\/new$/);
    expect(adapters.x.launch()).toMatch(/^https:\/\/x\.com\/compose\/post$/);
  });

  it('github：link 含 query / fragment 也应能抽出 owner/repo', () => {
    expect(adapters.github.launch({ link: 'https://github.com/foo/bar?tab=readme' }))
      .toBe('https://github.com/foo/bar/releases/new');
    expect(adapters.github.launch({ link: 'https://github.com/foo/bar#readme' }))
      .toBe('https://github.com/foo/bar/releases/new');
  });

  it('github：link 为 http 协议也应能抽取（适配老仓库页面）', () => {
    expect(adapters.github.launch({ link: 'http://github.com/foo/bar' }))
      .toBe('https://github.com/foo/bar/releases/new');
  });

  it('github：带 www 子域也兼容', () => {
    expect(adapters.github.launch({ link: 'https://www.github.com/foo/bar' }))
      .toBe('https://github.com/foo/bar/releases/new');
  });

  it('github：不是 github 域名时应返回 null', () => {
    expect(adapters.github.launch({ link: 'https://gitlab.com/foo/bar' })).toBeNull();
    expect(adapters.github.launch({ link: 'https://example.com/foo/bar' })).toBeNull();
  });

  it('其余静态平台也应返回稳定 URL（smoke test）', () => {
    expect(adapters.facebook.launch()).toBe('https://www.facebook.com/');
    expect(adapters.youtube.launch()).toBe('https://studio.youtube.com/');
    expect(adapters.douyin.launch()).toMatch(/^https:\/\/creator\.douyin\.com\//);
    expect(adapters.xhs.launch()).toMatch(/^https:\/\/creator\.xiaohongshu\.com\//);
    expect(adapters.bili.launch()).toMatch(/^https:\/\/member\.bilibili\.com\//);
    expect(adapters.jike.launch()).toMatch(/^https:\/\/web\.okjike\.com\//);
    expect(adapters.zhihu.launch()).toMatch(/^https:\/\/zhuanlan\.zhihu\.com\//);
    expect(adapters.wechat.launch()).toBe('https://mp.weixin.qq.com/cgi-bin/appmsg?action=edit&isNew=1&lang=zh_CN');
  });
});

describe('publishers · 注入脚本语法', () => {
  it.each(ALL_PLATFORMS)('%s fill / submit 必须是合法 JS（new Function 不报错）', (id) => {
    const fillCode = adapters[id].fill({ title: 't', body: 'b', link: 'https://x.com' });
    const submitCode = adapters[id].submit({ title: 't', body: 'b', link: 'https://x.com' });
    expect(() => new Function(fillCode)).not.toThrow();
    expect(() => new Function(submitCode)).not.toThrow();
  });

  it('inject 工具：应正确序列化 payload（含中文/引号/换行）', () => {
    const code = inject(
      'function(p){return {title:p.t,body:p.b};}',
      { t: '标题"含引号"', b: '正文\n多行\n带"引号"' }
    );
    // 关键：执行后能直接拿到反序列化数据（inject 返回的 code 是立即调用的 IIFE）
    const result = new Function('return (' + code + ')')();
    expect(result.title).toBe('标题"含引号"');
    expect(result.body).toBe('正文\n多行\n带"引号"');
  });
});

describe('publishers · 自动 vs 半自动（v0.1.1 修正）', () => {
  // 与 electron/publishers.js 保持一致：auto 反映「点一键后是否需要人工最终确认」
  // v0.1.1 修正：ph / juejin / facebook / youtube 实际在发布前需要人工选分类/受众/上传文件，改 auto:false
  it('auto:true 的真一键平台：github / v2ex / x', () => {
    expect(adapters.github.auto).toBe(true);
    expect(adapters.v2ex.auto).toBe(true);
    expect(adapters.x.auto).toBe(true);
  });

  it('auto:false 需手动点下一步/Submit 的平台：ph / juejin / facebook / youtube', () => {
    expect(adapters.ph.auto).toBe(false);
    expect(adapters.juejin.auto).toBe(false);
    expect(adapters.facebook.auto).toBe(false);
    expect(adapters.youtube.auto).toBe(false);
    // 这 4 个必须有 manualReason 给 UI 展示
    expect(typeof adapters.ph.manualReason).toBe('string');
    expect(typeof adapters.juejin.manualReason).toBe('string');
    expect(typeof adapters.facebook.manualReason).toBe('string');
    expect(typeof adapters.youtube.manualReason).toBe('string');
  });

  it('auto:false 的国内平台：douyin / xhs / bili / jike / zhihu / wechat', () => {
    expect(adapters.douyin.auto).toBe(false);
    expect(adapters.xhs.auto).toBe(false);
    expect(adapters.bili.auto).toBe(false);
    expect(adapters.jike.auto).toBe(false);
    expect(adapters.zhihu.auto).toBe(false);
    expect(adapters.wechat.auto).toBe(false);
  });
});

describe('publishers · YouTube（特殊）', () => {
  it('应返回 need_file 状态（视频需要本地文件）', () => {
    // fill 直接返回对象而不是注入脚本
    const code = adapters.youtube.fill({ title: 't', body: 'b' });
    expect(code).toMatch(/need_file/);
  });
});

describe('publishers · inject 工具 · 边界 payload', () => {
  it('payload 为 undefined / null 应序列化为空对象 {}', () => {
    const code1 = inject('function(p){return p;}', undefined);
    const code2 = inject('function(p){return p;}', null);
    // 立即调用后的返回值应为空对象
    expect(new Function('return (' + code1 + ')')()).toEqual({});
    expect(new Function('return (' + code2 + ')')()).toEqual({});
  });

  it('payload 为基本类型时应正确序列化', () => {
    const code = inject('function(p){return p;}', { s: 'hi', n: 42, b: true, x: null });
    expect(new Function('return (' + code + ')')()).toEqual({ s: 'hi', n: 42, b: true, x: null });
  });

  it('payload 含嵌套对象与数组应完整往返', () => {
    const payload = {
      title: 'outer',
      meta: { tags: ['a', 'b', 'c'], settings: { auto: true, n: 0 } },
      list: [1, 'two', null, false]
    };
    const code = inject('function(p){return p;}', payload);
    expect(new Function('return (' + code + ')')()).toEqual(payload);
  });

  it('payload 含 unicode 与 emoji 应完整往返', () => {
    const payload = { title: '你好 Rokit 🚀', body: '🎉 测试' };
    const code = inject('function(p){return p;}', payload);
    const out = new Function('return (' + code + ')')();
    expect(out.title).toBe('你好 Rokit 🚀');
    expect(out.body).toBe('🎉 测试');
  });

  it('payload 含控制字符与反斜杠应安全序列化（不破坏 JS 语法）', () => {
    const payload = { body: 'line1\nline2\ttab\\back', s: '"quoted""' };
    const code = inject('function(p){return p;}', payload);
    // 能在页面里 new Function 也能跑
    const out = new Function('return (' + code + ')')();
    expect(out.body).toBe('line1\nline2\ttab\\back');
    expect(out.s).toBe('"quoted""');
  });

  it('payload 含 HTML 标签 / </script> 应原样序列化（浏览器 XSS 防护由 CSP 负责）', () => {
    const payload = { body: '<script>alert(1)</script><img onerror=x>' };
    const code = inject('function(p){return p;}', payload);
    const out = new Function('return (' + code + ')')();
    expect(out.body).toBe('<script>alert(1)</script><img onerror=x>');
    // 额外验证：序列化产物应能被 new Function 执行，不报语法错
    expect(() => new Function(code)).not.toThrow();
  });

  it('payload 为空对象 / 空数组应正常', () => {
    expect(new Function('return (' + inject('function(p){return p;}', {}) + ')')()).toEqual({});
    expect(new Function('return (' + inject('function(p){return p;}', []) + ')')()).toEqual([]);
  });

  it('payload 含 NaN / Infinity 应被 JSON.stringify 转为 null（标准行为，文档化）', () => {
    const code = inject('function(p){return p;}', { a: NaN, b: Infinity });
    const out = new Function('return (' + code + ')')();
    expect(out.a).toBeNull();
    expect(out.b).toBeNull();
  });

  it('函数体不含 payload 引用也应能合法执行', () => {
    const code = inject('function(){return 42;}', { ignored: true });
    expect(new Function('return (' + code + ')')()).toBe(42);
  });
});
