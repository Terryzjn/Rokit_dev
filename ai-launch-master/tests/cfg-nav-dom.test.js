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
  it('至少有 4 个导航项（AI 模型 + GitHub + YouTube + 公众号 + 自动发布 + 主题）', () => {
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