// Rokit · 发布记录真实性 + 发布/渠道/作品详情导航
//
// 覆盖本次修复的三个核心不变量（能用生产代码跑的就跑生产代码，不用字符串猜）：
//   P0  发布记录必须来自「实际执行的发布任务」：
//       - 实际发布到 YouTube（即使只勾选了 GitHub）→ 记录平台必须是 youtube
//       - 发布失败 → status=failed、保留错误信息、不计入发布次数
//       - 同一幂等键重复回调 → 只更新同一条记录，不重复计数
//       - 人工「标记已发布」若已有历史成功记录 → 新增一条手动标记记录，原记录不被改写
//       - 人工「标记已发布」若只有 pending 记录 → 升级那一条，不新增
//   P1  「最近发布记录 → 查看」打开**单次发布详情**，信息取自同一条记录
//   P2  「各渠道发布次数」点击 → 该渠道的真实发布记录列表（不是渠道授权弹窗）
//   P3  「我的作品 → 作品详情」→ 展示该作品关联的全部平台发布记录
//
// 跑的生产代码：
//   - index.html 里的 markPub / attachPubWork / pubRecordUrl / pubStatusBadge
//     （按花括号配平从 index.html 切出来，在沙箱里注入 state / pf / findWork 等依赖后执行）
//   - renderer-utils/dashboard-view.js 里的 window.__pubView（浏览器脚本，按 <script> 方式加载）
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const DASH_SRC = fs.readFileSync(path.join(ROOT, 'renderer-utils', 'dashboard-view.js'), 'utf8').replace(/\r\n/g, '\n');

/* ---------- 通用：从源码里按花括号配平切出一个函数 ---------- */
function extractBlock(src, header) {
  const start = src.indexOf(header);
  if (start < 0) throw new Error('源码中找不到：' + header);
  const open = src.indexOf('{', start + header.length - 1);
  if (open < 0) throw new Error('缺少花括号：' + header);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('花括号不配平：' + header);
}

/* ==================================================================
   P0：markPub 的生产行为
   ================================================================== */

// 把「幂等键 + 写入口 + 补挂作品」这一整段生产代码切出来
function extractPubWriterSrc() {
  const start = HTML.indexOf('function newPubKey(pid){');
  const end = HTML.indexOf('// 首发完成后追加一条里程碑');
  if (start < 0 || end < 0 || end <= start) throw new Error('无法定位发布记录写入口');
  return HTML.slice(start, end);
}

function makePubEnv(overrides) {
  const o = overrides || {};
  const state = o.state || {
    copies: {},
    pubLog: [],
    pubByPlatform: {},
    kpis: {},
    milestones: [],
    works: [],
    curWork: null,
    sel: {}
  };
  const writes = [];
  const host = {
    api: {
      addPub(row) {
        writes.push(row);
        return Promise.resolve(row);
      }
    }
  };
  const PLATFORMS = [
    { id: 'github', name: 'GitHub', color: '#24292F' },
    { id: 'youtube', name: 'YouTube', color: '#FF0000' },
    { id: 'x', name: 'X (Twitter)', color: '#000000' },
    { id: 'wechat', name: '微信公众号', color: '#07C160' }
  ];
  const pf = (id) => PLATFORMS.find((p) => p.id === id) || { id: id, name: id, color: '#5A6B72' };
  const findWork = (id) => (state.works || []).find((w) => w.id === id) || null;
  const nowHM = () => '10:30';
  let renderFlowCalls = 0;
  const factory = new Function(
    'state',
    'pf',
    'findWork',
    'nowHM',
    'window',
    'renderFlow',
    'pushMilestoneIfFirst',
    extractPubWriterSrc() +
      '\nreturn { markPub: window.markPub, attachPubWork: window.attachPubWork, pubKeyFor: pubKeyFor };'
  );
  const api = factory(state, pf, findWork, nowHM, host, () => { renderFlowCalls++; }, () => {});
  return { state, writes, host, api, pf, findWork, renderFlowCalls: () => renderFlowCalls };
}

describe('P0 · 发布记录来自实际发布任务', () => {
  it('只勾选 GitHub、实际发布到 YouTube → 记录归属 youtube，且不产生 github 记录', () => {
    const env = makePubEnv();
    env.state.sel = { github: true };          // 用户只在「打通平台」勾选了 GitHub
    env.state.copies = { github: { title: 'GH 文案', body: 'b', tags: [] } };
    env.state.works = [{ id: 'w1', name: '作品一' }];
    env.state.curWork = 'w1';

    env.api.markPub('youtube', {
      status: 'ok',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      videoId: 'abcdefghijk',
      title: '作品一'
    });

    expect(env.state.pubLog.length).toBe(1);
    const row = env.state.pubLog[0];
    expect(row.platform_id).toBe('youtube');
    expect(row.id).toBe('youtube');
    expect(row.platform).toBe('YouTube');
    expect(row.status).toBe('ok');
    expect(row.video_id).toBe('abcdefghijk');
    expect(row.work_id).toBe('w1');
    // 没有任何 github 记录（平台身份不来自勾选状态）
    expect(env.state.pubLog.filter((r) => r.platform_id === 'github').length).toBe(0);
    // 写库时也带真实 platform_id
    expect(env.writes.length).toBe(1);
    expect(env.writes[0].platform_id).toBe('youtube');
    expect(env.writes[0].status).toBe('ok');
    expect(env.writes[0].video_id).toBe('abcdefghijk');
    // 发布次数记在 youtube 上
    expect(env.state.pubByPlatform.youtube).toBe(1);
    expect(env.state.pubByPlatform.github).toBeUndefined();
  });

  it('发布失败 → status=failed + 保留错误信息，且不计入发布次数', () => {
    const env = makePubEnv();
    env.state.works = [{ id: 'w1', name: '作品一' }];
    env.state.curWork = 'w1';

    env.api.markPub('youtube', { status: 'failed', error: '需要重新授权' });

    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.pubLog[0].status).toBe('failed');
    expect(env.state.pubLog[0].error).toBe('需要重新授权');
    expect(env.state.pubByPlatform.youtube).toBeUndefined();
    expect(env.writes[0].status).toBe('failed');
    expect(env.writes[0].error).toBe('需要重新授权');
  });

  it('同一幂等键重复回调 → 只更新同一条记录，不重复计数', () => {
    const env = makePubEnv();
    env.state.works = [{ id: 'w1', name: '作品一' }];
    env.state.curWork = 'w1';
    const key = 'yt|fixed-key';

    env.api.markPub('youtube', { status: 'failed', error: '网络错误', pubKey: key });
    env.api.markPub('youtube', { status: 'ok', url: 'https://www.youtube.com/watch?v=abcdefghijk', pubKey: key });

    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.pubLog[0].status).toBe('ok');
    expect(env.state.pubLog[0].error).toBe('');   // 成功结果覆盖失败原因
    expect(env.state.pubByPlatform.youtube).toBe(1); // 只计一次
  });

  it('人工「标记已发布」已有历史成功记录时 → 新增一条手动标记记录，原成功记录不被改写', () => {
    const env = makePubEnv();
    env.state.works = [{ id: 'w1', name: '作品一' }];
    env.state.curWork = 'w1';

    env.api.markPub('youtube', { status: 'ok', url: 'https://www.youtube.com/watch?v=abcdefghijk' });
    const autoRow = env.state.pubLog[0];
    const autoKey = autoRow.pub_key;

    env.api.markPub('youtube', { status: 'manual', source: 'manual-mark' });

    // 历史成功记录保持原样（不被就地改写）
    expect(env.state.pubLog.length).toBe(2);
    expect(autoRow.status).toBe('ok');
    expect(autoRow.pub_key).toBe(autoKey);
    expect(autoRow.url).toBe('https://www.youtube.com/watch?v=abcdefghijk');
    // 本次手动标记自己成为一条新的四段式手动键记录
    const manualRow = env.state.pubLog[env.state.pubLog.length - 1];
    expect(manualRow.status).toBe('manual');
    expect(manualRow.pub_key).toMatch(/^manual\|youtube\|w1\|mk_[0-9a-fA-F-]+$/);
    // 历史 ok 已计过一次 → 合计仍为 2（不是 1）
    expect(env.state.pubByPlatform.youtube).toBe(2);
  });

  it('GitHub 存在历史成功记录时，人工标记新增记录且原记录内容不变', () => {
    const env = makePubEnv();
    env.state.works = [{ id: 'w1', name: '作品一' }];
    env.state.curWork = 'w1';

    // 复现线上数据：GitHub / w1 有一条自动发布留下的成功记录（自动键）
    env.api.markPub('github', { status: 'ok', url: 'https://github.com/o/r/releases/tag/v0.1.0' });
    const autoRow = env.state.pubLog[0];
    const autoKey = autoRow.pub_key;
    const autoTitle = autoRow.title;

    env.api.markPub('github', { status: 'manual', source: 'manual-mark' });

    expect(env.state.pubLog.length).toBe(2);
    // 原成功记录：键 / 标题 / 状态 / 链接全部不变
    expect(autoRow.pub_key).toBe(autoKey);
    expect(autoRow.title).toBe(autoTitle);
    expect(autoRow.status).toBe('ok');
    expect(autoRow.url).toBe('https://github.com/o/r/releases/tag/v0.1.0');
    // 新增的是一条独立的四段式手动键记录
    const manualRow = env.state.pubLog[env.state.pubLog.length - 1];
    expect(manualRow.status).toBe('manual');
    expect(manualRow.pub_key).toMatch(/^manual\|github\|w1\|mk_[0-9a-fA-F-]+$/);
    expect(manualRow.pub_key).not.toBe(autoKey);
    // 写库也带了新键（Store 侧是新行，不会覆盖旧行）
    const manualWrites = env.writes.filter((w) => w.pub_key === manualRow.pub_key);
    expect(manualWrites.length).toBe(1);
  });

  it('草稿待发布（pending）不计入发布次数，人工标记后升级为同一条记录', () => {
    const env = makePubEnv();
    env.state.works = [{ id: 'w1', name: '作品一' }];
    env.state.curWork = 'w1';

    env.api.markPub('wechat', { status: 'pending' });
    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.pubByPlatform.wechat).toBeUndefined();

    env.api.markPub('wechat', { status: 'manual', source: 'manual-mark' });
    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.pubLog[0].status).toBe('manual');
    expect(env.state.pubByPlatform.wechat).toBe(1);
  });

  it('作品还没落定时先登记幂等键，attachPubWork 可回填 work_id（不新增记录）', () => {
    const env = makePubEnv();
    env.state.curWork = null;                  // 首次发射：作品此刻还不存在
    env.api.markPub('youtube', { status: 'ok', url: 'https://www.youtube.com/watch?v=abcdefghijk' });
    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.pubLog[0].work_id).toBe('');
    expect(env.state._pendingPubKeys.length).toBe(1);

    env.api.attachPubWork(env.state._pendingPubKeys[0], 'w9');
    expect(env.state.pubLog.length).toBe(1);
    expect(env.state.pubLog[0].work_id).toBe('w9');
    expect(env.state.pubByPlatform.youtube).toBe(1); // 回填不重复计数
  });

  it('markPub 不再因平台未勾选（state.copies 缺失）而早退', () => {
    const src = extractBlock(HTML, 'window.markPub=function(id){');
    expect(src).not.toMatch(/if\s*\(\s*!\s*c\s*\)\s*return/);
    expect(src).toMatch(/platform_id\s*:\s*id/);
    expect(src).toMatch(/opts\.status/);
  });
});

/* ==================================================================
   P1 / P2 / P3 的数据源：window.__pubView（dashboard-view.js）
   ================================================================== */

function loadDashView(state) {
  const host = {};
  new Function('window', DASH_SRC)(host);
  const PLATFORMS = [
    { id: 'github', name: 'GitHub', color: '#24292F' },
    { id: 'youtube', name: 'YouTube', color: '#FF0000' },
    { id: 'x', name: 'X (Twitter)', color: '#000000' },
    { id: 'wechat', name: '微信公众号', color: '#07C160' }
  ];
  host.RokitDashboardView.create({
    state: state,
    esc: (s) => String(s == null ? '' : s),
    platforms: PLATFORMS,
    go: () => {},
    toast: () => {},
    findWork: (id) => (state.works || []).find((w) => w.id === id) || null,
    formatRelTime: () => ''
  });
  return host.__pubView;
}

function makeDashState() {
  return {
    dashRange: 'all',
    channels: [],
    works: [{ id: 'w1', name: '作品一' }],
    pubLog: [
      // 本次会话：YouTube 发布成功
      {
        session: true,
        platform: 'YouTube',
        platform_id: 'youtube',
        id: 'youtube',
        status: 'ok',
        title: '作品一',
        time: '10:30',
        created_at: '2026-10-20T02:30:00.000Z',
        work_id: 'w1',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        video_id: 'abcdefghijk',
        pub_key: 'yt|w1|1'
      },
      // 本次会话：GitHub 发布失败
      {
        session: true,
        platform: 'GitHub',
        platform_id: 'github',
        id: 'github',
        status: 'failed',
        title: '作品一',
        time: '10:31',
        created_at: '2026-10-20T02:31:00.000Z',
        work_id: 'w1',
        error: 'no-token',
        pub_key: 'gh|w1|1'
      },
      // 历史行：只有平台名（platform_id 为空）→ 平台可由名称反查
      {
        recId: 7,
        platform: 'X (Twitter)',
        platform_id: '',
        status: 'ok',
        title: '旧作品',
        time: '09:00',
        created_at: '2026-10-19T01:00:00.000Z',
        work_id: ''
      },
      // 历史行：平台名未知 → 必须标「平台无法确认」，不得猜成别的平台
      {
        recId: 8,
        platform: '某个未知平台',
        platform_id: '',
        status: 'ok',
        title: '旧记录',
        time: '08:00',
        created_at: '2026-10-18T00:00:00.000Z',
        work_id: ''
      }
    ]
  };
}

describe('P1/P2/P3 · 发布记录唯一数据源 window.__pubView', () => {
  it('成功口径：只有 ok / manual 计入；failed / pending 不计入', () => {
    const view = loadDashView(makeDashState());
    expect(view.isSuccess({ status: 'ok' })).toBe(true);
    expect(view.isSuccess({ status: 'manual' })).toBe(true);
    expect(view.isSuccess({ status: 'failed' })).toBe(false);
    expect(view.isSuccess({ status: 'pending' })).toBe(false);
    // YouTube(ok) + X(ok) + 未知平台历史行(ok) = 3；GitHub(failed) 不计入
    expect(view.successRecords().length).toBe(3);
    expect(view.successRecords().filter((r) => r.status === 'failed').length).toBe(0);
  });

  it('byChannel：按渠道筛选真实发布记录（失败不出现），平台 id 与平台名都能匹配', () => {
    const view = loadDashView(makeDashState());

    const yt = view.byChannel('youtube');
    expect(yt.length).toBe(1);
    expect(yt[0].platform_id).toBe('youtube');

    // 用平台名匹配也必须能命中（卡片 key 可能是名字）
    expect(view.byChannel('YouTube').length).toBe(1);

    // GitHub 只有失败记录 → 不进列表
    expect(view.byChannel('github').length).toBe(0);

    // 历史行（platform_id 为空、按名称反查）也能被匹配到
    expect(view.byChannel('x').length).toBe(1);
    expect(view.byChannel('X (Twitter)').length).toBe(1);
  });

  it('byWork：一个作品可关联多条发布记录（不同平台、不同状态）', () => {
    const view = loadDashView(makeDashState());
    const rows = view.byWork('w1');
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.platform_id).sort()).toEqual(['github', 'youtube']);
    expect(rows.filter((r) => r.status === 'failed').length).toBe(1);
  });

  it('byKey：按记录键取回同一条记录（详情与列表用同一个 key）', () => {
    const view = loadDashView(makeDashState());
    const yt = view.byChannel('youtube')[0];
    const key = view.key(yt);
    expect(key).toBe('yt|w1|1');
    const got = view.byKey(key);
    expect(got).toBeTruthy();
    expect(got.platform_id).toBe('youtube');
    expect(got.work_id).toBe('w1');
    expect(got.video_id).toBe('abcdefghijk');
  });

  it('历史记录缺字段时安全降级：平台无法确认、不崩、不编造', () => {
    const view = loadDashView(makeDashState());
    const unknown = view.records().find((r) => r.platform === '某个未知平台');
    expect(unknown).toBeTruthy();
    expect(unknown.platform_known).toBe(false);
    expect(unknown.platform_id).toBe('');
    expect(unknown.url).toBe('');
    expect(unknown.work_id).toBe('');
    // 缺 work_id / 缺 url 的记录不应让 byKey / byWork 崩
    expect(() => view.byKey('d:8')).not.toThrow();
    expect(view.byWork('').length).toBe(2); // 两条 work_id 为空的历史行
  });

  it('空记录时列表为空（不返回 undefined，交给上层渲染空状态）', () => {
    const state = { dashRange: 'all', channels: [], works: [], pubLog: [] };
    const view = loadDashView(state);
    expect(view.records().length).toBe(0);
    expect(view.successRecords().length).toBe(0);
    expect(view.byChannel('youtube').length).toBe(0);
    expect(view.byWork('w1').length).toBe(0);
    expect(view.byKey('nope')).toBe(null);
  });
});

/* ==================================================================
   P1：单次发布详情的展示逻辑（纯函数取自 index.html）
   ================================================================== */

function loadPubHelpers() {
  const src = [
    extractBlock(HTML, 'function pubRecordUrl(r){'),
    extractBlock(HTML, 'function pubStatusBadge(r){'),
    extractBlock(HTML, 'function pubRecordPlatformName(r){')
  ].join('\n');
  return new Function(src + '\nreturn { pubRecordUrl: pubRecordUrl, pubStatusBadge: pubStatusBadge, pubRecordPlatformName: pubRecordPlatformName };')();
}

describe('P1 · 单次发布详情', () => {
  it('YouTube 优先用真实 videoId 拼出视频链接', () => {
    const h = loadPubHelpers();
    expect(h.pubRecordUrl({ platform_id: 'youtube', video_id: 'abcdefghijk' })).toBe('https://www.youtube.com/watch?v=abcdefghijk');
  });

  it('没有真实链接时返回空串 —— 不用平台首页 / 默认 URL 冒充', () => {
    const h = loadPubHelpers();
    expect(h.pubRecordUrl({ platform_id: 'youtube' })).toBe('');
    expect(h.pubRecordUrl({ platform_id: 'github' })).toBe('');
    expect(h.pubRecordUrl({ platform_id: 'github', url: 'javascript:alert(1)' })).toBe('');
    expect(h.pubRecordUrl({ platform_id: 'github', url: 'not-a-url' })).toBe('');
  });

  it('已保存的有效平台链接原样使用', () => {
    const h = loadPubHelpers();
    expect(h.pubRecordUrl({ platform_id: 'github', url: 'https://github.com/o/r/blob/main/a.md' })).toBe('https://github.com/o/r/blob/main/a.md');
  });

  it('状态徽标区分：已发布 / 手动标记 / 草稿待发布 / 发布失败', () => {
    const h = loadPubHelpers();
    expect(h.pubStatusBadge({ status: 'ok' })).toContain('已发布');
    expect(h.pubStatusBadge({ status: 'manual' })).toContain('手动标记');
    expect(h.pubStatusBadge({ status: 'pending' })).toContain('草稿待发布');
    expect(h.pubStatusBadge({ status: 'failed' })).toContain('发布失败');
  });

  it('平台无法确认时明确标注，不猜测', () => {
    const h = loadPubHelpers();
    expect(h.pubRecordPlatformName({ platform: '某个未知平台', platform_known: false })).toContain('平台无法确认');
    expect(h.pubRecordPlatformName({ platform: 'YouTube', platform_known: true })).toBe('YouTube');
  });

  it('发布详情是**应用内部视图**（不是小弹窗），有返回入口与独立渲染函数', () => {
    // v1.22：详情从「普通小弹窗」升级为内部路由视图（data-route="pubdetail"）
    expect(HTML).toContain('data-route="pubdetail"');
    expect(HTML).toContain('id="pubDetailPageBody"');
    expect(HTML).toContain('id="pubDetailPageSub"');
    expect(HTML).toContain('window.openPubDetail=function(key){');
    expect(HTML).toContain('window.pubDetailBack=function(){');
    expect(HTML).toContain('function renderPubDetailPage(){');
    // 旧的弹窗壳已经移除（不再把完整详情塞进小弹窗）
    expect(HTML).not.toContain('id="pubDetailModal"');
    expect(HTML).not.toContain('id="pubListModal"');
    // 详情页展示：作品信息 / 发布结果 / 发布详细信息
    const detail = extractBlock(HTML, 'function renderPubDetailPage(){');
    ['作品信息', '发布结果', '发布详细信息', '实际发布平台', '发布状态', '发布时间', '记录 ID', '未记录平台原始链接'].forEach((label) => {
      expect(detail).toContain(label);
    });
    // 外部链接走项目既有安全打开方式 openExt（不是裸 window.open），且必须用户点击才打开
    expect(detail).toContain('openExt(');
    // 没有真实链接时明确提示，不编造
    expect(detail).toContain('未记录平台原始链接');
  });
});

/* ==================================================================
   P2：渠道发布次数 → 该渠道真实发布记录列表
   ================================================================== */

describe('P2 · 各渠道发布次数点击行为', () => {
  it('统计卡片调用 openDashPlatformPubs（记录列表），不再调用渠道授权弹窗', () => {
    expect(DASH_SRC).toMatch(/openDashPlatformPubs\(/);
    const cardIdx = DASH_SRC.indexOf("class=\"pstat\" onclick=\"openDashPlatformPubs(");
    expect(cardIdx).toBeGreaterThan(-1);
    // 卡片上不能出现 openDashChannel / openChannelEditor
    const card = DASH_SRC.slice(cardIdx, cardIdx + 400);
    expect(card).not.toContain('openDashChannel');
    expect(card).not.toContain('openChannelEditor');
  });

  it('openDashPlatformPubs 转发到发布记录列表（不是渠道详情）', () => {
    const fn = extractBlock(DASH_SRC, 'window.openDashPlatformPubs = function(platId){');
    expect(fn).toContain('root.openPubPlatformPubs');
    expect(fn).not.toContain('openChannelEditor');
  });

  it('index.html 侧的渠道入口 → 同一套发布记录列表视图，并按平台预置筛选', () => {
    const fn = extractBlock(HTML, 'window.openPubPlatformPubs=function(platId){');
    // 进入的是**列表页**（内部路由 pubs），不是弹窗，也不是渠道授权弹窗
    expect(fn).toContain('openPubListPage({platform:plat');
    expect(fn).not.toContain('openChannelEditor');
    expect(fn).not.toContain('pubListModal');
    expect(HTML).toContain('data-route="pubs"');
    expect(HTML).toContain('id="pubListTable"');
  });

  it('列表页每条记录都有「查看详情」入口（跳独立详情视图）', () => {
    const list = extractBlock(HTML, 'function renderPubListPage(){');
    expect(list).toContain('openPubDetail(');
    expect(list).toContain('查看详情');
  });
});

/* ==================================================================
   P3：我的作品 → 作品详情
   ================================================================== */

describe('P3 · 我的作品 → 作品详情', () => {
  it('作品卡片菜单里有「作品详情与发布记录」入口', () => {
    const works = extractBlock(HTML, 'function renderWorks(){');
    expect(works).toContain('openWorkDetail(');
  });

  it('作品详情展示基本信息 + 标题正文 + 该作品的多平台发布记录，并可进入单次发布详情', () => {
    expect(HTML).toContain('id="workDetailModal"');
    // 弹窗内容由 renderWorkDetailBody 渲染；
    //   openWorkDetail 只负责「渲染内容 + 打开弹窗 + 记住当前作品」
    //   （拆开是为了让发布记录变更通知能在弹窗已打开时只刷新内容）。
    const body = extractBlock(HTML, 'function renderWorkDetailBody(workId){');
    expect(body).toContain('api.byWork(workId)');
    ['作品标题', '类型', '状态', '简介', '发布标题', '正文', '视频'].forEach((label) => {
      expect(body).toContain(label);
    });
    expect(body).toContain('openPubDetail(');
    const fn = extractBlock(HTML, 'window.openWorkDetail=function(workId){');
    expect(fn).toContain('renderWorkDetailBody(workId)');
    expect(fn).toContain("openModal('workDetailModal')");
  });

  it('openWorkDetail 在作品不存在时安全降级（不崩溃）', () => {
    const body = extractBlock(HTML, 'function renderWorkDetailBody(workId){');
    expect(body).toContain('找不到这个作品');
    const fn = extractBlock(HTML, 'window.openWorkDetail=function(workId){');
    expect(fn).toContain('renderWorkDetailBody(workId)');
  });
});

/* ==================================================================
   回归约束：四个一级导航与既有发布流程不被破坏
   ================================================================== */

describe('回归 · 一级导航与既有流程', () => {
  it('四个一级导航保持不变', () => {
    expect(HTML).toContain('id="tabFlow"');
    expect(HTML).toContain('id="tabDash"');
    expect(HTML).toContain('id="tabChannels"');
    expect(HTML).toContain('id="tabWorks"');
    // 一级导航条里只有 4 个 tab，没有新增一级菜单
    const navStart = HTML.indexOf('<div class="navtab">');
    const nav = HTML.slice(navStart, HTML.indexOf('</div>', navStart));
    expect((nav.match(/<button/g) || []).length).toBe(4);
    ['首秀向导', '数据看板', '推广渠道', '我的作品'].forEach((label) => {
      expect(nav).toContain(label);
    });
  });

  it('launch() 不再重复登记发布记录（不再第二次 push pubLog）', () => {
    const launch = extractBlock(HTML, 'window.launch=function(){');
    expect(launch).not.toMatch(/state\.pubLog\.push/);
    expect(launch).toContain('dedupeLaunchDone(doneIds)');
  });

  it('平台授权 / 字幕 / AI 配音流程未被改动（关键入口仍在）', () => {
    expect(HTML).toContain('function captionStepBack(){');
    expect(HTML).toContain('id="capSaveBtn"');
    expect(HTML).toContain('window.openChannelEditor=function(');
    expect(HTML).toContain('youtubePublishPayload(){');
  });
});
