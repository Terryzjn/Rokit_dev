// Rokit · 设置页左侧导航 → 右侧分区 id 匹配性校验
//
// 这是「问题 A · 导航不滚动」的程序化验收：
//   cfgNavJump(id) 通过 document.getElementById(id) 查找目标分区，
//   所以每个 cfg-section 必须有对应 id，否则永远查不到 → 滚动是空操作。
//
// 此测试解析索引.html文件，校验所有 nav 按钮 data-section 的取值都能找到对应 id。

'use strict';

const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 简化版解析：找 cfg-nav-item 的 onclick="cfgNavJump('xxx')" 和 cfg-section id="xxx"
const navIds = [];
const navRe = /onclick="cfgNavJump\('([^']+)'\)"/g;
let m;
while ((m = navRe.exec(html))) navIds.push(m[1]);

const sectionIds = [];
const secRe = /<div class="cfg-section" id="([^"]+)" data-section="([^"]+)"/g;
while ((m = secRe.exec(html))) sectionIds.push({ id: m[1], data: m[2] });

const uniqNav = Array.from(new Set(navIds));

describe('设置页 · 导航 id ↔ 分区 id 匹配', () => {
  it('至少有 4 个导航项（AI 模型 + 线上配音 + GitHub + YouTube + 公众号 + 主题）', () => {
    expect(uniqNav.length).toBeGreaterThanOrEqual(6);
  });

  it('每个 cfgNavJump 调用的 id 都能在 cfg-section 找到对应 id', () => {
    const known = new Set(sectionIds.map((s) => s.id));
    uniqNav.forEach((id) => {
      expect(known.has(id)).toBe(true);
    });
  });

  it('每个 cfg-section 的 id 与 data-section 应当一致（强一致防止后续误删）', () => {
    sectionIds.forEach((s) => {
      expect(s.id).toBe(s.data);
    });
  });

  it('cfgNavJump id 列表与 cfg-section id 集合完全相等', () => {
    const navSet = new Set(uniqNav);
    const secSet = new Set(sectionIds.map((s) => s.id));
    const onlyInNav = uniqNav.filter((x) => !secSet.has(x));
    const onlyInSec = sectionIds.map((s) => s.id).filter((x) => !navSet.has(x));
    expect(onlyInNav).toEqual([]);
    expect(onlyInSec).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 设置页冗余「自动发布」UI 已移除（仅影响展示，不影响任何发布能力）
// ---------------------------------------------------------------------------
describe('设置页 · 冗余自动发布 UI 已移除', () => {
  it('不再包含自动发布分区、开关、平台多选与内存字段', () => {
    expect(html).not.toContain('cfg-sec-auto');
    expect(html).not.toContain('cfgAutoPub');
    expect(html).not.toContain('cfgPlatList');
    expect(html).not.toContain('settings.autoPub');
    expect(html).not.toContain('autoPubStatus(');
    expect(html).not.toContain('DIR_NEED');
  });

  it('其他设置分区仍然保留', () => {
    ['cfg-sec-model', 'cfg-sec-voice', 'cfg-sec-github', 'cfg-sec-youtube', 'cfg-sec-wechat', 'cfg-sec-theme']
      .forEach((id) => { expect(html).toContain('id="' + id + '"'); });
  });

  it('首秀计划自动发布 / 示例 / 跳过入口保留', () => {
    expect(html).toContain("scheduledAt:d0.toISOString(),platforms:['github']");
    expect(html).toContain('planExampleChips');
    expect(html).toContain('window.applyPlanExample');
    expect(html).toContain('window.skipPlanAndGo');
    expect(html).toContain("togglePlanPlatform(");
  });

  it('首秀计划不再包含 GitHub Release 与独立的自动发布勾选', () => {
    expect(html).not.toContain('GitHub Release 发布');
    expect(html).not.toContain('自动创建 GitHub Release');
    expect(html).not.toContain('autoPublish');
  });

  it('发布队列与「开始发射」链路保留', () => {
    expect(html).toContain('window.autoPub=function(id)');
    expect(html).toContain('function pubModeOf(id)');
    expect(html).toContain('window.rocketGo=async function');
  });
});

// ---------------------------------------------------------------------------
// 平台卡片徽标：按 PLATFORMS[].auto 的真实能力渲染
// ---------------------------------------------------------------------------
describe('平台卡片 · 徽标依据真实平台能力', () => {
  function extractBlock(src, header) {
    const start = src.indexOf(header);
    if (start < 0) throw new Error('源码中找不到：' + header);
    const open = src.indexOf('{', start + header.length - 1);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('花括号不配平：' + header);
  }

  const pcardSrc = extractBlock(html, 'function pcard(p){');
  const pcard = new Function('state', 'esc', pcardSrc + '\nreturn pcard;')({ sel: {} }, (s) => String(s == null ? '' : s));

  it('auto=true 的平台显示「⚡ 自动」', () => {
    const htmlOut = pcard({ id: 'github', name: 'GitHub', auto: true, color: '#24292F', lv: 'L2 跳转' });
    expect(htmlOut).toContain('pbadge auto');
    expect(htmlOut).toContain('⚡ 自动');
    expect(htmlOut).not.toContain('未启用自动发布');
  });

  it('auto=false 的平台显示「手动」', () => {
    const htmlOut = pcard({ id: 'youtube', name: 'YouTube', auto: false, color: '#FF0000', lv: 'L2 跳转' });
    expect(htmlOut).toContain('pbadge manual');
    expect(htmlOut).toContain('手动');
  });
});