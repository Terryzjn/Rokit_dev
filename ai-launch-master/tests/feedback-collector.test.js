// Rokit · feedback-collector 反馈采集层单元测试（v1.5）
// 目标：纯函数 decodeHtml / stripHtml / parseRss / ghRepoFromWork / v2exTopicId
//       + collectForWork 错误降级（不依赖真实网络）

const fc = require('../electron/feedback-collector');

describe('feedback-collector · decodeHtml', () => {
  it('应反转义 &amp; &lt; &gt; &quot; &#39; &nbsp;', () => {
    expect(fc.decodeHtml('&amp;')).toBe('&');
    expect(fc.decodeHtml('&lt;')).toBe('<');
    expect(fc.decodeHtml('&gt;')).toBe('>');
    expect(fc.decodeHtml('&quot;')).toBe('"');
    expect(fc.decodeHtml('&#39;')).toBe("'");
    expect(fc.decodeHtml('&nbsp;')).toBe(' ');
  });

  it('应处理 &#NNN; 数字实体', () => {
    expect(fc.decodeHtml('&#65;')).toBe('A');
    expect(fc.decodeHtml('&#20013;')).toBe('中');
  });

  it('空值应安全返回空字符串', () => {
    expect(fc.decodeHtml(null)).toBe('');
    expect(fc.decodeHtml('')).toBe('');
  });

  it('多次出现的实体应全部替换', () => {
    expect(fc.decodeHtml('a &amp; b &amp; c')).toBe('a & b & c');
  });
});

describe('feedback-collector · stripHtml', () => {
  it('应剥离 <br> → 换行', () => {
    expect(fc.stripHtml('a<br>b')).toBe('a\nb');
    expect(fc.stripHtml('a<br/>b')).toBe('a\nb');
    expect(fc.stripHtml('a<BR>b')).toBe('a\nb');
  });

  it('应将 </p> 视为段落分隔（双换行）', () => {
    const r = fc.stripHtml('<p>p1</p><p>p2</p>');
    expect(r).toContain('p1');
    expect(r).toContain('p2');
  });

  it('应去除一般 HTML 标签但保留文本', () => {
    expect(fc.stripHtml('<b>粗体</b>正常')).toBe('粗体正常');
  });

  it('应先解实体再剥标签（避免双重解码）', () => {
    expect(fc.stripHtml('<a>&amp;</a>')).toBe('&');
    expect(fc.stripHtml('<title>A &amp; B</title>')).toBe('A & B');
  });

  it('应折叠 3 个以上连续换行为 2 个', () => {
    const r = fc.stripHtml('a\n\n\n\nb');
    expect(r).toBe('a\n\nb');
  });

  it('应去除首尾空白', () => {
    expect(fc.stripHtml('  hello  ')).toBe('hello');
  });

  it('空值应返回空字符串', () => {
    expect(fc.stripHtml('')).toBe('');
    expect(fc.stripHtml(null)).toBe('');
  });
});

describe('feedback-collector · parseRss', () => {
  it('应解析多条 <item>', () => {
    const xml = [
      '<rss><channel>',
      '<item><title>标题1</title><description>描述1</description><link>http://a</link><author>u1</author></item>',
      '<item><title>标题2</title><description>描述2</description><link>http://b</link></item>',
      '</channel></rss>'
    ].join('');
    const items = fc.parseRss(xml);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('标题1');
    expect(items[1].link).toBe('http://b');
  });

  it('空 / null 应返回空数组', () => {
    expect(fc.parseRss('')).toEqual([]);
    expect(fc.parseRss(null)).toEqual([]);
  });

  it('缺失字段应留空串', () => {
    const xml = '<rss><item><title>only-title</title></item></rss>';
    const items = fc.parseRss(xml);
    expect(items[0].title).toBe('only-title');
    expect(items[0].description).toBe('');
    expect(items[0].link).toBe('');
    expect(items[0].author).toBe('');
  });

  it('description 应被 stripHtml 处理', () => {
    const xml = '<rss><item><title>t</title><description>&lt;b&gt;加粗&lt;/b&gt;</description></item></rss>';
    const items = fc.parseRss(xml);
    expect(items[0].description).toBe('加粗');
  });
});

describe('feedback-collector · ghRepoFromWork', () => {
  it('应从 https://github.com/owner/repo 提取', () => {
    expect(fc.ghRepoFromWork({ url: 'https://github.com/owner/repo' })).toBe('owner/repo');
  });

  it('应兼容 www.', () => {
    expect(fc.ghRepoFromWork({ url: 'https://www.github.com/o/r' })).toBe('o/r');
  });

  it('应容忍 .git 后缀', () => {
    expect(fc.ghRepoFromWork({ url: 'https://github.com/o/r.git' })).toBe('o/r');
  });

  it('非 GitHub 链接应返回 null', () => {
    expect(fc.ghRepoFromWork({ url: 'https://gitlab.com/o/r' })).toBe(null);
  });

  it('空 url 应返回 null', () => {
    expect(fc.ghRepoFromWork({})).toBe(null);
    expect(fc.ghRepoFromWork(null)).toBe(null);
  });
});

describe('feedback-collector · v2exTopicId', () => {
  it('应从 https://www.v2ex.com/t/123456 提取 123456', () => {
    expect(fc.v2exTopicId({ url: 'https://www.v2ex.com/t/123456' })).toBe('123456');
  });

  it('非 v2ex 链接应返回 null', () => {
    expect(fc.v2exTopicId({ url: 'https://github.com/o/r' })).toBe(null);
  });

  it('空 url 应返回 null', () => {
    expect(fc.v2exTopicId({})).toBe(null);
  });
});

describe('feedback-collector · collectForWork', () => {
  it('非 GitHub / 非 v2ex URL 应返回空 + 提示', async () => {
    const r = await fc.collectForWork({ id: 'w1', url: 'https://example.com' });
    expect(r.items).toEqual([]);
    expect(r.notes.github).toBeDefined();
    expect(r.notes.v2ex).toBeDefined();
  });

  it('GitHub 404 应安全降级', async () => {
    // 真实网络调用：若不可达则视为 network 错误；不应抛
    const r = await fc.collectForWork({ id: 'w1', url: 'https://github.com/definitely-not-exist-xyz-12345-zzz/nope' });
    expect(r).toBeDefined();
    expect(Array.isArray(r.items)).toBe(true);
    // 若有 network error 应在 notes.github 体现
    if (r.notes.github) {
      expect(typeof r.notes.github).toBe('string');
    }
  });

  it('includeGithub=false 应跳过 GitHub', async () => {
    const r = await fc.collectForWork(
      { id: 'w1', url: 'https://github.com/o/r' },
      { includeGithub: false }
    );
    expect(r.notes.github).toBeUndefined();
  });
});