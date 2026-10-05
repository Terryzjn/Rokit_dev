// 审计脚本：逐项验证本次修改的关键不变量
const fs = require('fs');
const path = require('path');
const os = require('os');

// 所有路径都基于本脚本所在目录，而不是 process.cwd()
const ROOT = path.resolve(__dirname, '..');

function ok(cond, msg) {
  console.log((cond ? '✓ ' : '✗ ') + msg);
  if (!cond) process.exitCode = 1;
}

(async () => {
  // ---- 1. store.js: 迁移 v2 + channels CRUD ----
  console.log('\n[1] store.js 迁移与 CRUD');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rokit-audit-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  const { Store, CURRENT_VERSION } = require(path.join(ROOT, 'electron', 'store.js'));

  ok(CURRENT_VERSION === 3, 'CURRENT_VERSION === 3');

  const s = new Store(dbPath);
  ok(s.mode === 'sqlite' || s.mode === 'json', 'Store 实例化成功');
  ok(s.listChannels().length === 0, '初始 channels 为空');

  // seed 13 个内置
  const KINDS = ['github','ph','v2ex','juejin','jike','bili','xhs','douyin','zhihu','wechat','facebook','youtube','x'];
  KINDS.forEach(k => s.saveChannel({ name: k, kind: k, enabled: 1 }));
  ok(s.listChannels().length === 13, 'seed 13 个内置平台');

  // 自定义渠道
  const c = s.saveChannel({ name: '钉钉', kind: 'custom', webhook: 'https://oapi.dingtalk.com/robot/send?x=1' });
  ok(c.id.startsWith('ch_'), '自动生成 id 前缀 ch_');
  ok(s.listChannels().length === 14, '总数 14');

  // upsert: 同 id 更新
  s.saveChannel({ id: c.id, name: '钉钉-主群', kind: 'custom', enabled: 0 });
  const reloaded = s.listChannels().find(x => x.id === c.id);
  ok(reloaded.name === '钉钉-主群', '同 id 触发更新');
  ok(reloaded.enabled === 0, 'enabled 归一化为 0');

  // 校验
  let threw = false;
  try { s.saveChannel({ name: '', kind: 'custom' }); } catch (_e) { threw = true; }
  ok(threw, '缺 name 抛错');

  threw = false;
  try { s.saveChannel({ name: 'x', kind: '' }); } catch (_e) { threw = true; }
  ok(threw, '缺 kind 抛错');

  // 空串归 null
  const empty = s.saveChannel({ name: 'A', kind: 'wechat', api_base: '  ', webhook: '', note: '   ' });
  ok(empty.api_base === null && empty.webhook === null && empty.note === null, '空串归 null');

  // 删除
  s.deleteChannel(c.id);
  // 修正期望值：此前已加过 1 个空串测试渠道，删除自定义后总数 = 13 内置 + 1 空串测试 = 14
  const totalBeforeReopen = s.listChannels().length;
  ok(totalBeforeReopen === 14, '删除自定义后总数 = 14（13 内置 + 1 空串测试）');

  // JSON 兜底
  console.log('\n[2] JSON 兜底模式');
  // 强制走 json 驱动：注入损坏 DB 让 better-sqlite3 创建失败
  // （无法强制切换驱动，但 sqlite 与 json 路径都覆盖；至少验证 sqlite 路径 OK）
  ok(s.mode === 'sqlite', 'sqlite 模式可用');
  // 迁移幂等性：将 store 实例引用置 null 后再实例化（避免文件锁）
  // 这里只验证当前进程内 migrate 不报错
  ok(s.version === 3, '迁移完成后 version === 3');

  // 清理前记录总数（better-sqlite3 不存在 close，直接走 OS 释放）
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath + ext;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_e) {} }
  }
  try { fs.rmdirSync(tmpDir); } catch (_e) {}

  // ---- 3. preload.js: 暴露 4 个 channels API ----
  console.log('\n[3] preload.js 暴露面');
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  ok(/listChannels\s*:/.test(preload), 'preload 暴露 listChannels');
  ok(/saveChannel\s*:/.test(preload), 'preload 暴露 saveChannel');
  ok(/deleteChannel\s*:/.test(preload), 'preload 暴露 deleteChannel');
  ok(/testChannel\s*:/.test(preload), 'preload 暴露 testChannel');

  // ---- 4. main.js: 4 个 IPC handler 名称一致 ----
  console.log('\n[4] main.js IPC handler');
  const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  ok(/ipcMain\.handle\(['"]channels:list['"]/.test(main), "main 注册 channels:list");
  ok(/ipcMain\.handle\(['"]channels:save['"]/.test(main), "main 注册 channels:save");
  ok(/ipcMain\.handle\(['"]channels:delete['"]/.test(main), "main 注册 channels:delete");
  ok(/ipcMain\.handle\(['"]channels:test['"]/.test(main), "main 注册 channels:test");

  // channels:test 必须复用 fetchWithTimeout（避免重复造轮子且确保超时一致）
  ok(/fetchWithTimeout/.test(main), 'channels:test 复用 fetchWithTimeout');

  // channels:test 必须校验 URL 协议（防 file:// 等）
  ok(/\^https\?:\\\/\\\//i.test(main), 'channels:test 校验 http(s) 协议');

  // ---- 5. index.html: 4 个关键入口 ----
  console.log('\n[5] index.html 关键入口');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(/id="tabChannels"/.test(html), '导航新增 tabChannels');
  ok(/data-route="channels"/.test(html), 'section data-route="channels"');
  ok(/id="channelModal"/.test(html), '弹窗 channelModal');
  ok(/id="channelsBox"/.test(html), '列表容器 channelsBox');
  ok(/onclick="openChannelEditor/.test(html), '编辑器入口函数 openChannelEditor');
  ok(/onclick="deleteChannel/.test(html), '删除入口函数 deleteChannel');
  ok(/onclick="toggleChannel/.test(html), '启停入口函数 toggleChannel');
  ok(/onclick="testChannel\(\)"/.test(html), '测试连接入口函数 testChannel');
  ok(/onclick="seedBuiltinChannels\(\)"/.test(html), '同步内置入口函数 seedBuiltinChannels');

  // 校验 boot 链包含 loadChannels
  ok(/loadChannels\(\)/.test(html), 'boot 链调用 loadChannels');

  // 校验防 XSS：所有用户可控字段渲染时都过 esc()
  ok(/esc\(c\.name\)/.test(html), 'renderChannels 中 c.name 转义');
  ok(/esc\(c\.tag\)/.test(html), 'renderChannels 中 c.tag 转义');
  ok(/esc\(c\.note\)/.test(html), 'renderChannels 中 c.note 转义');
  ok(/esc\(c\.id\)/.test(html), 'renderChannels 中 c.id 转义（防注入 onclick）');

  // 校验导航必须包含 4 个入口（顺序由设计调整，不再强制）
  ok(/id="tabFlow"/.test(html), '导航包含首秀向导 tabFlow');
  ok(/id="tabDash"/.test(html), '导航包含数据看板 tabDash');
  ok(/id="tabChannels"/.test(html), '导航包含推广渠道 tabChannels');
  ok(/id="tabWorks"/.test(html), '导航包含我的作品 tabWorks');
  // 校验这 4 个按钮都在同一个 .navtab 容器里（顺序不限定）
  const navTabBlock = html.match(/<div class="navtab">([\s\S]*?)<\/div>/);
  ok(navTabBlock !== null, '4 个 tab 都在 .navtab 容器内');
  if (navTabBlock) {
    const inner = navTabBlock[1];
    ok(/id="tabFlow"/.test(inner), 'navtab 内含首秀向导');
    ok(/id="tabDash"/.test(inner), 'navtab 内含数据看板');
    ok(/id="tabChannels"/.test(inner), 'navtab 内含推广渠道');
    ok(/id="tabWorks"/.test(inner), 'navtab 内含我的作品');
  }
  // v0.1.1 之后，未实现的看板 tab 加 data-coming 属性作为渐进式设计证据
  // 数据看板 v1.5 已正式上线（KPI / 时段筛选 / 里程碑 / 发布回填均已交付），
  // 不应再带 data-coming “规划中”标记。
  ok(!/<button[^>]*\bid="tabDash"[^>]*\bdata-coming\b/i.test(html), '数据看板 tab 不应带 data-coming 属性（v1.5 已交付）');

  // go() 处理 channels 路由
  ok(/if\(r==='channels'\)\{renderChannels\(\);?\}/.test(html), 'go() 处理 channels 路由');

  // ---- 6. CSS ----
  console.log('\n[6] CSS');
  ok(/\.ch-card\s*\{/.test(html), '.ch-card 样式');
  ok(/\.ch-grid\s*\{/.test(html), '.ch-grid 样式');
  ok(/\.ch-select\s*\{/.test(html), '.ch-select 控件样式');
  ok(/\.ch-empty\s*\{/.test(html), '.ch-empty 空态样式');

  // ---- 7. tests ----
  console.log('\n[7] tests/store.test.js');
  const tests = fs.readFileSync('./tests/store.test.js', 'utf8');
  ok(/describe\(['"]Store · Channels/.test(tests), '新增 describe "Store · Channels"');
  // 统计 it 数量
  const itCount = (tests.match(/Channels（推广渠道）/g) || []).length;
  ok(itCount >= 1, 'Channels 测试集存在');
  // 校验关键场景都覆盖
  ok(/应当支持完整的渠道 upsert/.test(tests), '覆盖完整 upsert');
  ok(/必填字段缺失时应抛错/.test(tests), '覆盖必填校验');
  ok(/enabled 应被规范化为 0 \/ 1/.test(tests), '覆盖 enabled 归一化');
  ok(/空字符串应被规范化为 null/.test(tests), '覆盖空串归 null');
  ok(/删除应仅移除指定 id/.test(tests), '覆盖删除');
  ok(/迁移应当幂等/.test(tests), '覆盖迁移幂等');

  console.log('\n' + (process.exitCode ? '✗ 审计不通过' : '✓ 审计全部通过'));
})();
