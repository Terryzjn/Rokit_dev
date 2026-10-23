'use strict';

// v1.20.10 紧急回归修复：「我的作品」多作品持久化
//   锁定以下关键不变量：
//     1) state.works 存储在 IndexedDB / SQLite (electron/store.js) 中，按 id 唯一索引；
//     2) addWork 使用 w1/w2/... 自增 id，**永远不覆盖**已有真实作品；
//     3) seedWorks 加载 DB 中所有真实作品，concat 到 samples 后面；
//     4) 不使用单一对象 / 单条变量覆盖整个作品集合；
//     5) 不使用 localStorage 存作品（避免与 IndexedDB/SQLite 冲突）；
//     6) 不重置 / 不清空作品列表；
//     7) sample works 用 sample_w* 前缀，真实作品用 w* 前缀，互不混淆。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const STORE = fs.readFileSync(path.join(ROOT, 'electron/store.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');

// === 抽取 function foo() { ... } 函数体 ===
function extractFunction(name) {
  var re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  var m = INDEX.match(re);
  if (!m) return null;
  var start = m.index + m[0].length;
  var depth = 1, i = start;
  while (i < INDEX.length && depth > 0) {
    var ch = INDEX.charAt(i);
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return INDEX.slice(start, i - 1);
}

describe('v1.20.10 · 我的作品多作品持久化', () => {

  it('A. store.js saveWork 按 id 区分 INSERT / UPDATE（不覆盖其他作品）', () => {
    // 必须先 SELECT 后决定 INSERT / UPDATE
    expect(/SELECT\s+\*\s+FROM\s+works\s+WHERE\s+id\s*=\s*\?/.test(STORE)).toBe(true);
    // 必须存在 UPDATE 路径（不是只 INSERT）
    expect(/UPDATE\s+works\s+SET/.test(STORE)).toBe(true);
    // 必须存在 INSERT 路径
    expect(/INSERT\s+INTO\s+works/.test(STORE)).toBe(true);
    // saveWork 接收 id 入参
    expect(/saveWork\s*\(\s*w\s*\)/.test(STORE)).toBe(true);
    expect(/const\s+id\s*=\s*w\.id/.test(STORE)).toBe(true);
    // 找不到 id 早退（防止误存空记录）
    expect(/if\s*\(\s*!\s*w\s*\|\|\s*!\s*w\.id\s*\)/.test(STORE)).toBe(true);
  });

  it('B. store.js listWorks 返回全部真实作品（不分页、不去重）', () => {
    expect(/listWorks\s*\(\s*\)/.test(STORE)).toBe(true);
    // SQL: SELECT * FROM works（不带 WHERE，仅按 created_at ASC 排序）
    expect(/SELECT\s+\*\s+FROM\s+works/.test(STORE)).toBe(true);
    expect(/ORDER BY created_at ASC/.test(STORE)).toBe(true);
    // JSON 兜底：直接返回 this.data.works（整列表）
    expect(/return\s+this\.data\.works\s*;/.test(STORE)).toBe(true);
    // 不允许出现 .slice(0, 1) / [0] 这种只取一条的逻辑
    expect(/\.slice\(\s*0\s*,\s*1\s*\)/.test(STORE)).toBe(false);
    expect(/data\.works\s*\[\s*0\s*\]/.test(STORE)).toBe(false);
  });

  it('C. addWork 不再创建作品记录（时机已移到发布成功确认点）', () => {
    var fnMatch = INDEX.match(/window\.addWork\s*=\s*function[^{]*\{([\s\S]*?)\n  \};/);
    expect(fnMatch).toBeTruthy();
    var body = fnMatch[1];
    var code = body.replace(/\/\/[^\n]*/g, '');   // 排除注释
    // 点击「登记新作品」不得新增记录
    expect(/state\.works\.push/.test(code)).toBe(false);
    // 不得分配 id（id 改由 launch 在发布成功时分配）
    expect(/id\s*=\s*'w'\s*\+\s*n/.test(code)).toBe(false);
    // 不得写库
    expect(/saveWork/.test(code)).toBe(false);
    // curWork 置空，表示"尚未归属任何真实作品"
    expect(/state\.curWork\s*=\s*null/.test(code)).toBe(true);
  });

  it('C2. 唯一 id 由 launch（发布成功）在创建记录时分配，跳过示例前缀', () => {
    var body = INDEX.match(/window\.launch\s*=\s*function[^{]*\{([\s\S]*?)\n  \};/);
    expect(body).toBeTruthy();
    var launchBody = body[1];
    // 收集已有真实作品 id
    expect(/state\.works\.filter\([\s\S]*?!\s*x\.isSample[\s\S]*?\)\.map/.test(launchBody)).toBe(true);
    // 跳过示例前缀，避免与示例作品撞 id
    expect(/SAMPLE_WORK_IDS\.indexOf/.test(launchBody)).toBe(true);
    // 生成 w+n
    expect(/id\s*:\s*'w'\s*\+\s*n/.test(launchBody)).toBe(true);
    // push 新作品（不替换）
    expect(/state\.works\.push\(w\)/.test(launchBody)).toBe(true);
    // 仅在有真实成功平台时才创建
    expect(/if\(!doneIds\.length\)return;/.test(launchBody)).toBe(true);
  });

  it('D. seedWorks 加载 DB 后追加到 samples，不删除已有 state.works', () => {
    var body = extractFunction('seedWorks');
    expect(body).toBeTruthy();
    // 函数顶部没有 "state.works = []" 清空
    expect(/state\.works\s*=\s*\[\s*\]/.test(body)).toBe(false);
    expect(/state\.works\s*=\s*null/.test(body)).toBe(false);
  });

  it('E. seedWorks 主路径：state.works = samples + real', () => {
    var body = extractFunction('seedWorks');
    expect(body).toBeTruthy();
    // 保留 samples，把 real concat 到末尾
    expect(/state\.works\s*=\s*state\.works\.filter\([\s\S]*?return\s+w\.isSample[\s\S]*?\)\.concat\(\s*real\s*\)/.test(body)).toBe(true);
    // real 来自 normalizeWork
    expect(/var\s+real\s*=\s*cleaned\.map\(normalizeWork\)/.test(body)).toBe(true);
    // 真实作品数量驱动 curWork
    expect(/if\s*\(\s*real\.length\s*\)\s*state\.curWork\s*=\s*real\[0\]\.id/.test(body)).toBe(true);
  });

  it('F. seedWorks 清理 sample_* 脏数据，但**不**删真实作品', () => {
    var body = extractFunction('seedWorks');
    expect(body).toBeTruthy();
    // dirtyIds 仅在 id 命中 SAMPLE_WORK_IDS 时删除
    expect(/SAMPLE_WORK_IDS\.indexOf\(\s*w\.id\s*\)/.test(body)).toBe(true);
    // 删除用 window.api.deleteWork（按 id 单条删）
    expect(/window\.api\.deleteWork\(\s*id\s*\)/.test(body)).toBe(true);
    // 不允许 truncate / drop / 全表清空
    expect(/TRUNCATE/i.test(body)).toBe(false);
    expect(/DELETE\s+FROM\s+works\s*;/.test(body)).toBe(false);
  });

  it('G. 渲染时按真实作品 vs 示例分组，真实作品**不**与示例作品混淆', () => {
    var body = extractFunction('renderWorks');
    expect(body).toBeTruthy();
    expect(/var\s+real\s*=\s*state\.works\.filter\([\s\S]*?!\s*w\.isSample[\s\S]*?\)/.test(body)).toBe(true);
    expect(/var\s+samples\s*=\s*state\.works\.filter\([\s\S]*?w\.isSample[\s\S]*?\)/.test(body)).toBe(true);
    expect(/var\s+ordered\s*=\s*samples\.concat\(\s*real\s*\)/.test(body)).toBe(true);
    // 真实作品渲染时不能用 isSample 卡片 class
    expect(/wsample/.test(body)).toBe(true);  // class="wsample" 用在 isSample 上
  });

  it('H. SAMPLE_WORK_IDS 与真实作品 id 前缀不冲突', () => {
    expect(/SAMPLE_WORK_IDS\s*=\s*\[\s*['"]sample_w/.test(INDEX)).toBe(true);
    // addWork 真实作品从 w1 起步，跳过 SAMPLE_WORK_IDS
    expect(/while\s*\(\s*exists\.indexOf\(\s*'w'\s*\+\s*n\s*\)\s*>=\s*0\s*\|\|\s*SAMPLE_WORK_IDS\.indexOf\(\s*'w'\s*\+\s*n\s*\)\s*>=\s*0\s*\)\s*n\+\+/.test(INDEX)).toBe(true);
  });

  it('I. 没有 localStorage 存作品', () => {
    // localStorage 只用于 theme / settings / cmdk-mru / channel-order / font-scale，**不**存 works
    var localStorageWrites = INDEX.match(/localStorage\.setItem\([\s\S]*?\)/g) || [];
    localStorageWrites.forEach(function(w){
      expect(/works|作品|state\.works/.test(w)).toBe(false);
    });
  });

  it('J. preload.js 暴露 listWorks / saveWork / deleteWork 三个 IPC（主进程数据库读写）', () => {
    expect(/listWorks\s*:\s*\(\s*\)/.test(PRELOAD)).toBe(true);
    expect(/saveWork\s*:\s*\(\s*w\s*\)/.test(PRELOAD)).toBe(true);
    expect(/deleteWork\s*:\s*\(\s*id\s*\)/.test(PRELOAD)).toBe(true);
    // IPC 通道名以 works: 开头
    expect(/['"]works:list['"]/.test(PRELOAD)).toBe(true);
    expect(/['"]works:save['"]/.test(PRELOAD)).toBe(true);
    expect(/['"]works:delete['"]/.test(PRELOAD)).toBe(true);
  });
});
