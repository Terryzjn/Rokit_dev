// Rokit · 本地存储层（SQLite 优先，JSON 文件兜底）
// 设计目标：本地优先、无云端。作品 / 发布记录 / 设置全部存在本地。
// 驱动优先级：better-sqlite3（若已安装）→ Node 内置 node:sqlite（Electron 36+）→ JSON 文件

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// ---------- 发布记录变更通知（存储层 → 主进程 → renderer） ----------
// 存储层是唯一能确认「数据真的落库」的地方，所以变更事件在这里发出：
//   - 只在**持久化成功之后**通知（SQLite 语句执行成功 / JSON 文件写盘成功）；
//     写入失败（抛异常）绝不通知，renderer 也就不会读到没落库的数据。
//   - 通知**不携带记录内容**，只是一个「pubs 变了」的信号；
//     renderer 收到后自己重新 listPubs()，避免传输大对象与统计口径漂移。
//   - 通知失败（没有监听者 / 监听者抛错）绝不影响写入结果。
//   - _planPubUpsert() 属于「事务内部」的一步，**不允许**在它内部通知：
//     它由调用方在事务/原子写入整体提交成功后再通知（避免回滚后仍发出通知）。
const pubsChangeBus = new EventEmitter();
pubsChangeBus.setMaxListeners(50);
function notifyPubsChanged() {
  try { pubsChangeBus.emit('pubs:changed'); } catch (_e) { /* 通知失败不影响写入结果 */ }
}
function onPubsChanged(fn) {
  if (typeof fn !== 'function') return function () {};
  pubsChangeBus.on('pubs:changed', fn);
  return function () { pubsChangeBus.off('pubs:changed', fn); };
}

// 判断一个 pub_key 是否是**新格式手动标记键**：manual|<platform_id>|<scope>|<op_id>
//   · op_id 段必须以 'mk_' 开头（生成规则见 index.html 的 newManualOpId）；
//   · scope 段允许含 '|'（项目名可能带竖线），因此 op_id 从**最右边**取；
//   · 旧三段式历史键（manual|pid|scope）、自动发布键（pid|wid|ts）、
//     首秀计划键（plan|...）**都不是**手动标记键 → 绝不会被"撤销手动标记"误删。
function isManualOpPubKey(key) {
  const s = String(key || '');
  if (s.indexOf('manual|') !== 0) return false;
  const segs = s.split('|');
  if (segs.length < 4) return false;      // 旧三段式键 → 不认
  if (!segs[1]) return false;             // platform_id 不能为空
  if (segs[segs.length - 1].indexOf('mk_') !== 0) return false;   // op_id 段
  return true;
}

// 判断一次 INSERT 是否因为**唯一约束**失败（SQLite: UNIQUE constraint failed）。
//   用途：并发重复提交同一 pub_key 时，唯一索引会暴露冲突；
//   此时应按"同一次操作已成功"处理，而不是当成发布失败上报。
function isUniqueViolationError(e) {
  const msg = String((e && e.message) || e || '');
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(msg);
}

// 当前 schema 版本号。修改表结构时需追加新迁移，勿直接修改旧迁移。
//   v1：初始表结构
//   v2：新增 channels 表
//   v3：PRD 第七节「作品库 + 主推队列」与第十节「反馈闭环」
//   v4：作品新增 visitors 字段（GitHub Traffic API uniques 持久化）
//       说明：复用既有 `dl` 列保存"下载量"（语义对齐 GitHub Releases assets
//       下载总数），不引入第二个"下载"字段；新增独立 `visitors` 列保存
//       traffic/views uniques，避免与 `play`（抖音/B站等视频播放数）混淆。
//   v5：作品新增 yt_url / yt_views / yt_updated_at（YouTube Data API 播放量持久化）
//   v6：发布记录（pubs）补齐"真实发布"所需字段
//       platform_id TEXT：平台 id（youtube / github / ...）。旧行的 platform 存的是平台名称，
//                        新增 platform_id 后平台身份不再依赖名称反查。
//       status     TEXT：ok=真实发布成功 / failed=发布失败（保留错误信息）/ manual=用户手动标记。
//                        旧行没有该字段（NULL）→ 前端显示"状态未知"，绝不默认冒充"已发布"。
//       url        TEXT：平台原始页面链接（YouTube watch URL 等）；没有就不写，绝不臆造。
//       error      TEXT：失败原因（仅 status=failed 时有值）。
//       video_id   TEXT：YouTube videoId（便于直接打开对应视频）。
//       pub_key    TEXT：发布幂等键（platform_id|work_id|时间戳）。同一发布被多个回调 / 刷新
//                        重复登记时用它去重，避免重复计数。
//   v7：「首秀计划」两层数据结构（计划配置 + 平台执行任务）
//       plan_stages：计划配置层（一个阶段一行）
//         id          TEXT PK ：稳定阶段 ID（跨会话不变，任务通过它关联）
//         work_id     TEXT    ：关联作品 ID（作品删除时按现有策略清理）
//         seq         INTEGER ：阶段序号（保存时按数组顺序重新编号，删除中间阶段后不重号）
//         title/desc  TEXT    ：阶段标题 / 说明
//         offset_days INTEGER ：相对作品创建日期的偏移天数（非负整数）
//         time_of_day TEXT    ：执行时刻，格式 HH:mm（本地时区解释）
//         platforms   TEXT    ：JSON 数组，选择的平台 id（如 ["github","wechat"]）
//         copy        TEXT    ：JSON 对象，保存时快照的发布文案（只读预览用，不覆盖用户编辑）
//       plan_tasks：平台执行任务层（一个阶段 × 一个平台一行）
//         id          TEXT PK ：稳定任务 ID（由 stage_id + platform_id 派生，天然幂等）
//         stage_id/work_id/platform_id：与阶段、作品、平台的关联
//         stage_seq/stage_title：阶段序号与标题快照（阶段删除后历史仍可读）
//         scheduled_at TEXT   ：计划执行时间（本地时区解析后的绝对时刻，ISO）
//         status      TEXT    ：pending 待执行 / running 执行中 / done 已完成 / failed 执行失败
//                              / draft_pending 草稿待发布 / cancelled 已取消 / needs_review 待核实
//         started_at/finished_at：实际开始 / 结束时间
//         platform_ref/platform_url：真实平台 ID / 链接（没有就不写）
//       error/note  TEXT    ：错误信息 / 待核实说明
//       pub_key     TEXT    ：幂等标识（与 pubs 的幂等键同一套）
//   v8：计划任务增加「模拟标识」列
//       simulated  INTEGER ：0 = 该任务的执行结果来自真实平台；1 = 由**模拟执行器**产生，
//                             绝不代表真实发布成功。
//                             说明：模拟任务同样占用正式任务行（任务 ID 由 阶段+平台 派生），
//                             因此真实执行器接手前必须显式转换（见 requeueSimulatedPlanTask），
//                             绝不能仅凭 status='done' 认定为真实发布成功。
//   v9：计划任务增加「等待真实执行」标记与历史归档
//       real_only     INTEGER：1 = 该任务处于「等待真实执行」状态：
//                              模拟调度器**不得**领取 / 执行它；只有真实执行器可以接手，
//                              且仍必须先通过 checkPlanPublishGuard（skip/review/unclear 一律不发布）。
//       history_note  TEXT   ：原模拟结果的归档说明（重排时写入，后续执行**不会**覆盖它）。
//   v10：发布记录幂等键增加**部分唯一索引**（只约束非空 pub_key）
//       idx_pubs_pub_key：UNIQUE(pub_key) WHERE pub_key IS NOT NULL AND pub_key <> ''
//         · 目的：同一次操作的重复提交在数据库层也有唯一性保证；并发重复提交
//           由唯一索引暴露冲突，应用层据此按「同一次操作已成功」处理。
//         · 为什么排除空键：历史行有大量 pub_key = '' 的旧记录（v6 之前写入），
//           全列唯一索引会因这些历史重复值建不出来并阻断启动；
//           排除空键既约束了所有真实幂等键，又完全不触碰历史行。
//         · 本迁移只新增索引：不改数据、不删行、不合并重复键、不迁移历史记录。
const CURRENT_VERSION = 10;

// 任务取消原因标记：平台被移出该阶段（区别于「用户主动取消」）
//   - 用它区分"被配置变更连带取消"与"用户明确取消"：
//     前者在用户把平台选回该阶段时可以恢复为待执行，后者永远保持已取消。
const PLAN_REMOVED_NOTE = '平台已从该阶段移除';

// 草稿归属（作品正式落库前的临时归属 ID）的命名规则。
//   渲染层生成方式：'draft_' + Date.now().toString(36) + '_' + 随机 base36 串
//   （见 index.html 的 addWork() / 改名分支），因此：
//     - 必须以 'draft_' 开头；
//     - 后续是小写字母数字，允许用 '_' 分成多段（单段也接受，兼容既有数据）；
//     - 不能为空、不能含大写或特殊字符。
const PLAN_DRAFT_OWNER_RE = /^draft_[0-9a-z]+(_[0-9a-z]+)*$/;

// 支持**真实发布**的平台（首秀计划到期后由真实执行器接手，而不是走模拟执行器）。
//   - 判定依据是「该平台是否已接入真实发布通道」，与阶段里选了哪些平台无关；
//   - github：首秀计划的真实发布通道（到期真实执行）；
//   - youtube：首秀计划的真实发布通道（复用既有 YouTube 自动发布通道，
//     隐私状态固定 public，不重新实现上传逻辑）；
//   - wechat：首秀计划的真实发布通道（复用既有公众号草稿创建入口，
//     **只创建草稿**，不正式发表、不群发）。
//   - 其它后续尚未接入真实执行器的平台不在此列表：
//     维持 real_only=0，到期仍走模拟执行器，**不因平台暂时没有真实执行器就被误判**。
const PLAN_REAL_PLATFORMS = ['github', 'youtube', 'wechat'];

let Database = null;
let driver = null;
try {
  Database = require('better-sqlite3');
  driver = 'better-sqlite3';
} catch (_e) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    Database = DatabaseSync;
    driver = 'node-sqlite';
  } catch (_e2) {
    Database = null;
    driver = null;
  }
}

// ---------- 迁移列表（按版本号顺序）----------
// 每个迁移函数接收 db 实例（提供 run / get / all / exec 驱动无关接口）
const migrations = [
  {
    version: 1,
    up: function (db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          base_url TEXT, api_key TEXT, model TEXT, updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS works (
          id TEXT PRIMARY KEY, name TEXT, type TEXT, intro TEXT, url TEXT,
          status TEXT, queue TEXT, star INTEGER DEFAULT 0, dl INTEGER DEFAULT 0,
          play TEXT DEFAULT '0', next TEXT, created_at TEXT, updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS pubs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT, platform TEXT,
          title TEXT, body TEXT, tags TEXT, time TEXT, created_at TEXT
        );
      `);
    }
  },
  {
    // v2：新增推广渠道表。kind 为内置平台 id（github/ph/v2ex/...）或 'custom'。
    // enabled=0 时渠道在「首秀发射」中不出现；api_base / api_key / webhook 仅对 custom 生效。
    version: 2,
    up: function (db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          enabled INTEGER DEFAULT 1,
          api_base TEXT,
          api_key TEXT,
          webhook TEXT,
          tag TEXT,
          note TEXT,
          created_at TEXT,
          updated_at TEXT
        );
      `);
    }
  },
  {
    // v3：支撑 PRD 第七节「作品库 + 主推队列」与第十节「反馈闭环」。
    //   works:     状态机 status(queue_state 已扩展为 queue_state) + priority + launched_at
    //   milestones: 里程碑报喜去重表
    //   feedback:  GitHub Issues / V2EX 评论增量采集原始数据
    //   feedback_clusters: AI 聚类输出
    //   metrics_daily: 每日聚合指标
    //   settings_kv: 适配器健康度等独立 KV（不污染 settings 单行表）
    // 同时将 settings.api_key 标记为「废弃」（明文迁移提示用），详见 secrets.js。
    version: 3,
    up: function (db) {
      // works 表使用 ALTER TABLE ADD COLUMN（SQLite 不支持 IF NOT EXISTS ADD COLUMN），
      // 重复执行迁移时通过 try/catch 容忍「duplicate column name」。
      const alterWorks = [
        "ALTER TABLE works ADD COLUMN queue_state TEXT DEFAULT 'queued'",
        "ALTER TABLE works ADD COLUMN priority INTEGER DEFAULT 0",
        "ALTER TABLE works ADD COLUMN launched_at TEXT",
        "ALTER TABLE works ADD COLUMN last_active_at TEXT"
      ];
      for (const sql of alterWorks) {
        try { db.exec(sql); } catch (_e) { /* 列已存在 */ }
      }
      // 存量作品补全默认状态（status 列已存在但旧值是 'draft'/'launching'/'archived' 等自由文本）
      try {
        db.exec("UPDATE works SET queue_state = COALESCE(queue_state,'queued')");
        db.exec("UPDATE works SET status = CASE WHEN status IN ('launching','operating','stable','pending','archived') THEN status ELSE 'launching' END");
      } catch (_e) {}

      db.exec(`
        CREATE TABLE IF NOT EXISTS milestones (
          id TEXT PRIMARY KEY,
          work_id TEXT,
          type TEXT,
          value INTEGER,
          reached_at TEXT,
          notified INTEGER DEFAULT 0
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback (
          id TEXT PRIMARY KEY,
          work_id TEXT,
          source TEXT,
          external_id TEXT,
          author TEXT,
          url TEXT,
          content TEXT,
          sentiment TEXT,
          category TEXT,
          priority TEXT,
          cluster_id TEXT,
          fetched_at TEXT,
          UNIQUE(source, external_id)
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback_clusters (
          id TEXT PRIMARY KEY,
          work_id TEXT,
          title TEXT,
          count INTEGER DEFAULT 0,
          priority TEXT,
          sample_ids TEXT,
          summary TEXT,
          created_at TEXT
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS metrics_daily (
          work_id TEXT,
          date TEXT,
          platform TEXT,
          views INTEGER DEFAULT 0,
          stars INTEGER DEFAULT 0,
          comments INTEGER DEFAULT 0,
          PRIMARY KEY (work_id, date, platform)
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings_kv (
          k TEXT PRIMARY KEY,
          v TEXT,
          updated_at TEXT
        );
      `);
    }
  },
  {
    // v4：作品统计扩展
    //   新增 visitors INTEGER：保存 GitHub Traffic API 拉到的 uniques。
    //   复用 dl 列保存"下载数"（语义 = GitHub Releases assets.download_count 之和）。
    //   迁移幂等：ALTER TABLE ADD COLUMN 重复执行会抛 duplicate column name，用 try/catch 吞掉。
    version: 4,
    up: function (db) {
      try { db.exec("ALTER TABLE works ADD COLUMN visitors INTEGER DEFAULT 0"); } catch (_e) { /* 列已存在 */ }
    }
  },
  {
    // v5：YouTube 播放量统计（「我的作品」卡片第三栏「播放」）
    //   yt_url         TEXT    ：作品关联的 YouTube 视频链接（独立于 GitHub 作品链接 url）
    //   yt_views       INTEGER ：最近一次成功拉到的 viewCount；NULL = 从未成功获取（前端显示 --）
    //   yt_updated_at  TEXT    ：最近一次成功获取时间（ISO），用于缓存新鲜度判断
    //   与 star / dl / visitors 完全独立，互不混用。
    version: 5,
    up: function (db) {
      try { db.exec("ALTER TABLE works ADD COLUMN yt_url TEXT DEFAULT ''"); } catch (_e) { /* 列已存在 */ }
      try { db.exec("ALTER TABLE works ADD COLUMN yt_views INTEGER DEFAULT NULL"); } catch (_e) { /* 列已存在 */ }
      try { db.exec("ALTER TABLE works ADD COLUMN yt_updated_at TEXT DEFAULT NULL"); } catch (_e) { /* 列已存在 */ }
    }
  },
  {
    // v6：发布记录（pubs）补齐"真实发布"所需字段。
    //   迁移幂等：ALTER TABLE ADD COLUMN 重复执行会抛 duplicate column name，用 try/catch 吞掉。
    //   旧行的默认语义：platform_id=''（无法从名称反推时前端显示"平台无法确认"，不猜测）。
    //   status **不加默认值**（旧行落 NULL = 历史记录没有状态字段）：
    //   缺失状态必须显示"状态未知"，绝不能在存储层被洗成"已发布"。
    //   新写入的行由 addPub 显式写 status（ok / manual / pending / failed）。
    version: 6,
    up: function (db) {
      try { db.exec("ALTER TABLE pubs ADD COLUMN platform_id TEXT DEFAULT ''"); } catch (_e) { /* 列已存在 */ }
      try { db.exec("ALTER TABLE pubs ADD COLUMN status TEXT"); } catch (_e) { /* 列已存在 */ }
      try { db.exec("ALTER TABLE pubs ADD COLUMN url TEXT DEFAULT ''"); } catch (_e) { /* 列已存在 */ }
      try { db.exec("ALTER TABLE pubs ADD COLUMN error TEXT DEFAULT ''"); } catch (_e) { /* 列已存在 */ }
      try { db.exec("ALTER TABLE pubs ADD COLUMN video_id TEXT DEFAULT ''"); } catch (_e) { /* 列已存在 */ }
      try { db.exec("ALTER TABLE pubs ADD COLUMN pub_key TEXT DEFAULT ''"); } catch (_e) { /* 列已存在 */ }
    }
  },
  {
    // v7：「首秀计划」两层数据结构。
    //   plan_stages —— 计划配置层（一个阶段一行，id 为稳定阶段 ID）
    //   plan_tasks  —— 平台执行任务层（一个阶段 × 一个平台一行）
    //   两层通过 stage_id 关联，**不使用 DAY 文本做主键**。
    //   迁移幂等：CREATE TABLE IF NOT EXISTS，重复执行不会报错。
    version: 7,
    up: function (db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plan_stages (
          id TEXT PRIMARY KEY,
          work_id TEXT,
          seq INTEGER DEFAULT 0,
          title TEXT DEFAULT '',
          desc TEXT DEFAULT '',
          offset_days INTEGER DEFAULT 0,
          time_of_day TEXT DEFAULT '20:00',
          scheduled_at TEXT,
          auto_publish INTEGER DEFAULT 0,
          platforms TEXT DEFAULT '[]',
          copy TEXT DEFAULT '',
          created_at TEXT,
          updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS plan_tasks (
          id TEXT PRIMARY KEY,
          stage_id TEXT,
          work_id TEXT,
          platform_id TEXT,
          stage_seq INTEGER DEFAULT 0,
          stage_title TEXT DEFAULT '',
          scheduled_at TEXT,
          status TEXT DEFAULT 'pending',
          started_at TEXT,
          finished_at TEXT,
          platform_ref TEXT DEFAULT '',
          platform_url TEXT DEFAULT '',
          error TEXT DEFAULT '',
          note TEXT DEFAULT '',
          pub_key TEXT DEFAULT '',
          created_at TEXT,
          updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_plan_stages_work ON plan_stages(work_id);
          CREATE INDEX IF NOT EXISTS idx_plan_tasks_stage ON plan_tasks(stage_id);
          CREATE INDEX IF NOT EXISTS idx_plan_tasks_work ON plan_tasks(work_id);
        `);
      }
    },
    {
      version: 8,
      up: function (db) {
        // v8：计划任务增加「模拟标识」列（1 = 由模拟执行器产生，不代表真实发布成功）
        //   只新增列，不改动任何既有行的数据；历史任务默认 0（未知来源），
        //   但也**不会**因为 status='done' 就被当成真实发布成功（判定见 _planPubState）。
        try { db.exec('ALTER TABLE plan_tasks ADD COLUMN simulated INTEGER DEFAULT 0'); } catch (_e) { /* 已存在 */ }
      }
    },
    {
      version: 9,
      up: function (db) {
        // v9：计划任务增加「等待真实执行」标记 + 原模拟结果归档
        //   real_only    ：1 = 等待真实执行（模拟调度器不得领取 / 执行）
        //   history_note ：原模拟结果归档（后续执行不会覆盖它）
        //   只新增列，不改动任何既有行的数据；既有任务默认 real_only=0（行为不变）。
        try { db.exec('ALTER TABLE plan_tasks ADD COLUMN real_only INTEGER DEFAULT 0'); } catch (_e) { /* 已存在 */ }
        try { db.exec("ALTER TABLE plan_tasks ADD COLUMN history_note TEXT DEFAULT ''"); } catch (_e) { /* 已存在 */ }
      }
    },
    {
      version: 10,
      up: function (db) {
        // v10：pubs.pub_key 增加**部分唯一索引**（只约束非空键）
        //   目的：让「同一次操作重复提交」在数据库层也有唯一性保证，
        //        并发重复提交时由唯一索引暴露冲突（而不是静默写出两条重复记录）。
        //
        //   实际 DDL：
        //     CREATE UNIQUE INDEX IF NOT EXISTS idx_pubs_pub_key ON pubs(pub_key)
        //       WHERE pub_key IS NOT NULL AND pub_key <> ''
        //
        //   ★ 为什么是**部分**索引（WHERE pub_key <> ''）：
        //     历史行里存在大量 pub_key = '' 的旧记录（v6 之前写入的），
        //     它们彼此重复。**全列**唯一索引会因为这些历史重复值而直接建不出来
        //     （UNIQUE constraint failed: pubs.pub_key），从而阻断启动；
        //     而把空键排除在索引之外，既能约束所有真实幂等键，
        //     又**完全不触碰、不清理、不改写**任何历史行。
        //
        //   ★ 本迁移只**新增索引**：不改数据、不删行、不合并重复键、
        //     不迁移历史记录。
        //
        //   ★ 索引的**实际创建**由 Store.ensurePubsPubKeyIndex() 负责，
        //     在**每次** Store 初始化时都尝试一次（幂等 + 可重试）：
        //       "CREATE UNIQUE INDEX IF NOT EXISTS idx_pubs_pub_key ON pubs(pub_key)"
        //       " WHERE pub_key IS NOT NULL AND pub_key <> ''"
        //     之所以不放进本迁移的 up() 里执行，是因为：建索引失败时（例如个别
        //     机器上存在非空重复键）本迁移仍会把 user_version 推进到 10，
        //     之后 currentVersion >= CURRENT_VERSION 会直接跳过迁移 →
        //     索引永远补建不上（用户后来把重复数据修好了也不会自愈）。
        //     现在它每次启动都重试 → 失败不阻断启动，数据修好后下次启动自愈。
      }
    }
  ];

class Store {
  constructor(file) {
    this.file = file;
    // better-sqlite3 要求父目录已存在；兜底创建，避免全新环境首次启动失败
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (_e) {}
    this.initError = '';
    if (driver) {
      this.mode = 'sqlite';
      this.driver = driver;
      // 初始化失败**绝不**静默换库、也绝不退回 JSON：
      //   原生绑定 ABI 不匹配 / 文件损坏都属于"必须让用户知道"的硬错误。
      //   这里只记录错误并置 mode='error'，由调用方（main.js）决定如何提示与停止。
      try {
        this.db = new Database(file);
        try { this.db.exec('PRAGMA journal_mode = WAL;'); } catch (_e) {}
        this.migrate();
      } catch (e) {
        this.mode = 'error';
        this.db = null;
        this.initError = String((e && e.message) || e);
      }
    } else {
      this.mode = 'json';
      this.jsonFile = path.join(path.dirname(file), 'ai-launch-master-data.json');
      this.data = this.loadJson();
      this.version = CURRENT_VERSION; // JSON 兜底模式下视为最新
    }
  }

  // 存储信息（供启动日志 / 计划中心展示；只读）
  //   - file/dir  ：当前实际使用的数据库文件与数据目录
  //   - mode      ：sqlite / json / error
  //   - driver    ：better-sqlite3 / node-sqlite；无法确定时为 'unknown'（不猜）
  storeInfo() {
    const dir = this.file ? path.dirname(this.file) : '';
    return {
      file: this.file || '',
      dir: dir,
      mode: this.mode || 'unknown',
      driver: this.driver || 'unknown',
      json_file: this.mode === 'json' ? (this.jsonFile || '') : '',
      version: this.version === undefined ? 0 : this.version,
      init_error: this.initError || ''
    };
  }

  // ---------- 驱动无关的执行封装 ----------
  run(sql, args) {
    args = args || [];
    if (this.driver === 'better-sqlite3') return this.db.prepare(sql).run(...args);
    const st = this.db.prepare(sql);
    try { return st.run(...args); } finally { try { st.finalize(); } catch (_e) {} }
  }
  get(sql, args) {
    args = args || [];
    if (this.driver === 'better-sqlite3') return this.db.prepare(sql).get(...args);
    const st = this.db.prepare(sql);
    try { return st.get(...args); } finally { try { st.finalize(); } catch (_e) {} }
  }
  all(sql, args) {
    args = args || [];
    if (this.driver === 'better-sqlite3') return this.db.prepare(sql).all(...args);
    const st = this.db.prepare(sql);
    try { return st.all(...args); } finally { try { st.finalize(); } catch (_e) {} }
  }
  exec(sql) {
    // 两个驱动都提供 .exec()，无需分支
    return this.db.exec(sql);
  }

  // ---------- SQLite 迁移 ----------
  migrate() {
    // 读取当前 schema 版本（PRAGMA user_version）
    let currentVersion = 0;
    try {
      const row = this.get('PRAGMA user_version');
      currentVersion = row && typeof row.user_version === 'number' ? row.user_version : 0;
    } catch (_e) {
      currentVersion = 0;
    }
    this.version = currentVersion;

    // 防御性 schema 补全：先于"已是最新版本则跳过"判断。
    //   必须在版本检查前运行：旧库可能 user_version=5 但物理列缺失
    //   （历史上 PRAGMA user_version 被先设到目标版本，但实际 ALTER 没生效），
    //   如果不补列就 return，会让用户继续撞到 "no such column: yt_url"。
    //   列已经齐全时是 no-op（Set.has 检查），不影响性能。
    this.ensureWorksColumns();
    this.ensurePlanTaskColumns();
    this.ensurePlanStageColumns();

    // 已是最新版本则跳过迁移
    //   ★ 不能直接 return —— 索引补建（ensurePubsPubKeyIndex）必须**每次**初始化都执行，
    //     否则建索引失败过的库永远补建不上（用户后来把重复数据修好了也不会自愈）。
    if (currentVersion >= CURRENT_VERSION) return this.ensurePubsPubKeyIndex();

    // 按顺序应用所有 pending 迁移
    for (const m of migrations) {
      if (m.version <= currentVersion) continue;
      if (m.version > CURRENT_VERSION) {
        console.error('[store] migration version ' + m.version + ' exceeds CURRENT_VERSION ' + CURRENT_VERSION + ', skipping');
        continue;
      }
      try {
        // better-sqlite3 显式事务；node:sqlite DatabaseSync.exec 本身在事务中
        if (this.driver === 'better-sqlite3') {
          this.db.exec('BEGIN');
        }
        m.up(this);
        if (this.driver === 'better-sqlite3') {
          this.db.exec('COMMIT');
        }
        // 设置 user_version（标准 SQLite 迁移习惯）
        this.run('PRAGMA user_version = ' + m.version);
        this.version = m.version;
      } catch (e) {
        try {
          if (this.driver === 'better-sqlite3') {
            this.db.exec('ROLLBACK');
          }
        } catch (_e2) {}
        throw new Error('migration v' + m.version + ' failed: ' + (e && e.message ? e.message : String(e)));
      }
    }

    // pubs.pub_key 部分唯一索引：**每次**初始化都尝试建（幂等 + 可重试）
    //   · 放在迁移**之后**：全新库在迁移里才刚建好 pubs 表，这里正好能建；
    //   · 放在迁移**之外**（而不是只写在 v10 里）：建索引失败时（例如个别机器上
    //     存在非空重复键）迁移仍会把 user_version 推进到 10，之后
    //     currentVersion >= CURRENT_VERSION 会直接跳过迁移 → 索引永远补建不上
    //     （用户后来把重复数据修好了也不会自愈）。
    //     现在它每次启动都重试一次 → 失败不阻断启动，数据修好后下次启动自愈。
    this.ensurePubsPubKeyIndex();
  }

  // 防御性：为 pubs.pub_key 建**部分唯一索引**（只约束非空键）
  //   · 幂等：IF NOT EXISTS → 每次初始化都调用也不会重复创建；
  //   · 可重试：失败只记录日志、**绝不阻断启动**，下次启动会再试一次；
  //   · 只建索引：不改数据、不删行、不合并重复键、不迁移任何历史记录；
  //   · 条件固定为 pub_key IS NOT NULL AND pub_key <> ''（排除历史空键重复值）。
  ensurePubsPubKeyIndex() {
    if (this.mode !== 'sqlite') return;
    let cols = null;
    try { cols = this.all('PRAGMA table_info(pubs)'); } catch (_e) { return; }
    if (!cols || !cols.length) return;   // 表还没建（全新库）→ 交给迁移
    try {
      this.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_pubs_pub_key ON pubs(pub_key)"
        + " WHERE pub_key IS NOT NULL AND pub_key <> ''"
      );
    } catch (e) {
      console.error('[store] 创建 pubs.pub_key 唯一索引失败（历史数据保持原样，下次启动会重试）：'
        + String((e && e.message) || e));
    }
  }

  // 防御性补列：plan_tasks.simulated（v8）
  //   - 表不存在时跳过（全新库由迁移负责建表）
  //   - 列已存在时跳过；不改动任何既有行的数据
  ensurePlanTaskColumns() {
    if (this.mode !== 'sqlite') return;
    let cols = null;
    try {
      cols = this.all('PRAGMA table_info(plan_tasks)');
    } catch (_e) { return; }
    if (!cols || !cols.length) return;   // 表还没建（全新库）→ 交给迁移
    const have = new Set((cols || []).map(function (c) { return c.name; }));
    if (!have.has('simulated')) {
      try { this.exec('ALTER TABLE plan_tasks ADD COLUMN simulated INTEGER DEFAULT 0'); } catch (_e) {}
    }
    if (!have.has('real_only')) {
      try { this.exec('ALTER TABLE plan_tasks ADD COLUMN real_only INTEGER DEFAULT 0'); } catch (_e) {}
    }
    if (!have.has('history_note')) {
      try { this.exec("ALTER TABLE plan_tasks ADD COLUMN history_note TEXT DEFAULT ''"); } catch (_e) {}
    }
  }

  // 防御性补列：plan_stages.scheduled_at / auto_publish（绝对执行时间 + GitHub 自动发布标记）
  //   - 只新增列，不改动既有行；历史阶段 scheduled_at 为 NULL → 继续按旧 offset/time 兼容读取
  //   - 不提升 CURRENT_VERSION，避免对生产库做版本迁移
  ensurePlanStageColumns() {
    if (this.mode !== 'sqlite') return;
    let cols = null;
    try {
      cols = this.all('PRAGMA table_info(plan_stages)');
    } catch (_e) { return; }
    if (!cols || !cols.length) return;   // 表还没建（全新库）→ 交给迁移
    const have = new Set((cols || []).map(function (c) { return c.name; }));
    if (!have.has('scheduled_at')) {
      try { this.exec('ALTER TABLE plan_stages ADD COLUMN scheduled_at TEXT'); } catch (_e) {}
    }
    if (!have.has('auto_publish')) {
      try { this.exec('ALTER TABLE plan_stages ADD COLUMN auto_publish INTEGER DEFAULT 0'); } catch (_e) {}
    }
  }

  // ---------- 防御性 schema 校验 ----------
  //   - 仅扫描 works 表的已知列；不影响已有数据
  //   - 每条 ALTER 都用 try/catch 包裹，对"列已存在"等错误静默
  //   - 非 sqlite 驱动直接跳过（JSON 模式无 schema 概念）
  //   - 失败不影响主流程，错误吞掉但不影响 saveWork/listWorks 调用
  ensureWorksColumns() {
    if (this.mode !== 'sqlite') return;
    let cols = null;
    try {
      cols = this.all('PRAGMA table_info(works)');
    } catch (_e) { return; }
    const have = new Set((cols || []).map(function (c) { return c.name; }));
    const want = [
      ['queue_state', "ALTER TABLE works ADD COLUMN queue_state TEXT DEFAULT 'queued'"],
      ['priority', 'ALTER TABLE works ADD COLUMN priority INTEGER DEFAULT 0'],
      ['launched_at', 'ALTER TABLE works ADD COLUMN launched_at TEXT'],
      ['last_active_at', 'ALTER TABLE works ADD COLUMN last_active_at TEXT'],
      ['visitors', 'ALTER TABLE works ADD COLUMN visitors INTEGER DEFAULT 0'],
      ['yt_url', "ALTER TABLE works ADD COLUMN yt_url TEXT DEFAULT ''"],
      ['yt_views', 'ALTER TABLE works ADD COLUMN yt_views INTEGER DEFAULT NULL'],
      ['yt_updated_at', 'ALTER TABLE works ADD COLUMN yt_updated_at TEXT DEFAULT NULL']
    ];
    for (const w of want) {
      if (have.has(w[0])) continue;
      try { this.exec(w[1]); } catch (_e) { /* 已存在或失败：忽略 */ }
    }
  }

  // ---------- JSON 兜底 ----------
  loadJson() {
    const empty = {
      settings: null, works: [], pubs: [], channels: [],
      milestones: [], feedback: [], feedback_clusters: [], metrics_daily: [], settings_kv: {},
      // v7：首秀计划（计划配置 + 平台执行任务）
      plan_stages: [], plan_tasks: []
    };
    try {
      if (fs.existsSync(this.jsonFile)) {
        return Object.assign(empty, JSON.parse(fs.readFileSync(this.jsonFile, 'utf8')));
      }
    } catch (_e) {}
    return empty;
  }
  saveJson() {
    try { fs.writeFileSync(this.jsonFile, JSON.stringify(this.data, null, 2)); } catch (_e) {}
  }

  // ---------- 设置（BYOK） ----------
  // 注：自 v1.5 起，api_key 不再写入 SQLite。改为由 secrets.js 写入 Windows 凭据管理器（DPAPI）。
  // 这里仍保留对 base_url / model 的存储；迁移过程中若发现 settings.api_key 仍存在，
  // 由 main.js 触发一次性明文迁移（详见 secrets.migratePlaintextApiKey）。
  getSettings() {
    const def = { base_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat', updated_at: '' };
    if (this.mode === 'sqlite') {
      const row = this.get('SELECT base_url, api_key, model, updated_at FROM settings WHERE id = 1');
      return row
        ? { base_url: row.base_url, api_key: row.api_key || '', model: row.model, updated_at: row.updated_at }
        : def;
    }
    const s = this.data.settings || def;
    return { base_url: s.base_url, api_key: s.api_key || '', model: s.model, updated_at: s.updated_at };
  }
  saveSettings(s) {
    const now = new Date().toISOString();
    const row = {
      base_url: (s && s.base_url) || 'https://api.deepseek.com/v1',
      api_key: (s && s.api_key) || '',
      model: (s && s.model) || 'deepseek-chat',
      updated_at: now
    };
    if (this.mode === 'sqlite') {
      // v1.5 起仅写入 base_url / model，api_key 一律由 secrets.js 负责
      // 仍保留 api_key 列的写入，仅当调用方显式传入时（例如一次性迁移或回退路径）
      this.run(`
        INSERT INTO settings (id, base_url, api_key, model, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          base_url = excluded.base_url, api_key = excluded.api_key,
          model = excluded.model, updated_at = excluded.updated_at
      `, [1, row.base_url, row.api_key, row.model, row.updated_at]);
    } else {
      this.data.settings = row;
      this.saveJson();
    }
    return this.getSettings();
  }
  // 显式清空 settings.api_key（迁移完成后调用）。返回受影响行数。
  clearPlaintextApiKey() {
    if (this.mode === 'sqlite') {
      const r = this.run("UPDATE settings SET api_key = '' WHERE id = 1");
      return r && typeof r.changes === 'number' ? r.changes : 1;
    }
    if (this.data.settings) this.data.settings.api_key = '';
    this.saveJson();
    return 1;
  }

  // ---------- 作品 ----------
  listWorks() {
    if (this.mode === 'sqlite') {
      return this.all('SELECT * FROM works ORDER BY created_at ASC');
    }
    return this.data.works;
  }

  // ---------- 唯一主推 ----------
  // 「主推」是作品列表里的一个**互斥标记**：同一时刻最多只有一个作品是主推。
  // 它复用已有的 works.queue 字段（取值 '主推' / '挂机' / '排队'），不另建字段，
  // 也不影响作品内容、发布记录、平台发布、作品 ID 等其它业务逻辑。
  //
  // 唯一性在**状态写入层**保证（不是靠界面隐藏按钮 / 禁用选项）：
  //   - setMainWork(id)：目标 -> '主推'，其它主推 -> '挂机'，两者是同一次写操作（原子）。
  //   - saveWork(w) 写入 queue='主推' 时，也会顺带降级其它主推（防止旁路写入破坏唯一性）。
  //   - clearMainWork()：取消主推，此后没有主推作品。
  //
  // 降级目标固定为 '挂机'（与 v1.5 既有 setAsMain 的降级语义一致：主推被撤下后转低强度维持）。
  // 注意：主推是**独立于 status 的标记**：设置主推不改 status（那会影响 pickMain 的排序规则，
  // 属于另一条业务线），主推只用于展示标签与排序。
  //
  // SQLite 下"降级旧的 + 提升新的"用一条 UPDATE 语句完成（单语句即原子），
  // 不会出现"两个主推"或"主推丢失"的中间态。
  demoteOtherMains(keepId) {
    // 返回被降级的作品 id 列表
    const keep = keepId == null ? '' : keepId;
    if (this.mode === 'sqlite') {
      const rows = this.all("SELECT id FROM works WHERE queue = '主推' AND id <> ?", [keep]);
      if (!rows.length) return [];
      this.run("UPDATE works SET queue = '挂机' WHERE queue = '主推' AND id <> ?", [keep]);
      return rows.map((r) => r.id);
    }
    const out = [];
    for (const w of this.data.works || []) {
      if (w && w.queue === '主推' && w.id !== keep) { w.queue = '挂机'; out.push(w.id); }
    }
    return out;
  }
  // 设置唯一主推：目标作品 -> '主推'，其它主推 -> '挂机'。
  setMainWork(id) {
    if (!id) return { ok: false, error: 'missing id' };
    if (this.mode === 'sqlite') {
      const row = this.get('SELECT id, queue FROM works WHERE id = ?', [id]);
      if (!row) return { ok: false, error: 'work not found: ' + id };
      let demoted = [];
      this._tx(() => {
        // 降级前的旧主推（同一事务内读取，与随后的 UPDATE 看到的是同一份数据）
        demoted = this.all("SELECT id FROM works WHERE queue = '主推' AND id <> ?", [id]).map((r) => r.id);
        // 单语句原子更新：目标置 '主推'，其它 '主推' 降级为 '挂机'
        this.run(
          "UPDATE works SET queue = CASE WHEN id = ? THEN '主推' ELSE '挂机' END WHERE id = ? OR queue = '主推'",
          [id, id]
        );
      });
      return { ok: true, main: id, queue: '主推', demoted: demoted };
    }
    // JSON 兜底：先降级其它主推再设目标，最后一次性落盘
    const list = this.data.works || [];
    const target = list.find((w) => w && w.id === id);
    if (!target) return { ok: false, error: 'work not found: ' + id };
    const demoted = [];
    for (const w of list) {
      if (w && w.id !== id && w.queue === '主推') { w.queue = '挂机'; demoted.push(w.id); }
    }
    target.queue = '主推';
    this.saveJson();
    return { ok: true, main: id, queue: '主推', demoted: demoted };
  }
  // 取消主推：把主推降级为 '挂机'，此后没有主推作品。
  clearMainWork(id) {
    if (this.mode === 'sqlite') {
      const params = [];
      let where = "WHERE queue = '主推'";
      if (id) { where = "WHERE id = ? AND queue = '主推'"; params.push(id); }
      const rows = this.all('SELECT id FROM works ' + where, params);
      if (!rows.length) return { ok: true, cleared: [], queue: null };
      this.run("UPDATE works SET queue = '挂机' " + where, params);
      return { ok: true, cleared: rows.map((r) => r.id), queue: null };
    }
    const cleared = [];
    for (const w of this.data.works || []) {
      if (!w || w.queue !== '主推') continue;
      if (id && w.id !== id) continue;
      w.queue = '挂机';
      cleared.push(w.id);
    }
    if (cleared.length) this.saveJson();
    return { ok: true, cleared: cleared, queue: null };
  }
  // 事务包装：把"降级旧主推 + 提升新主推"放进同一次提交，
  // 避免中途出现两个主推或主推状态意外丢失。
  _tx(fn) {
    if (this.mode !== 'sqlite') return fn();
    let began = false;
    try { this.db.exec('BEGIN'); began = true; } catch (_e) { began = false; }
    try {
      const r = fn();
      if (began) { try { this.db.exec('COMMIT'); } catch (_e) {} }
      return r;
    } catch (e) {
      if (began) { try { this.db.exec('ROLLBACK'); } catch (_e2) {} }
      throw e;
    }
  }

  // ---------- 严格事务（双表原子写专用） ----------
  //
  // 与 _tx() 的差别（_tx 是"尽力而为"，本方法是"失败即失败"）：
  //   - BEGIN 失败 → **抛错**，绝不降级成"无事务执行"；
  //     （降级执行会让第二次写入裸露在事务之外 → 两张表可能只写了一半）
  //   - fn 抛错 → ROLLBACK，并把**原始错误**原样抛给调用方；
  //   - COMMIT 失败 → ROLLBACK + 抛错，**绝不返回成功**；
  //   - ROLLBACK 也失败 → 抛出的错误里同时保留「原始错误」与「回滚失败原因」，
  //     并标记 rollback_failed=true（绝不把回滚失败伪装成干净回滚）。
  //
  // 只用于本次「待核实」人工处理的两张表原子写；不改动 _tx() 的既有语义，
  // 避免影响它的其它调用者。
  _txStrict(fn) {
    if (this.mode !== 'sqlite') return fn();
    let began = false;
    try {
      this.exec('BEGIN');
      began = true;
    } catch (e) {
      // BEGIN 失败：绝不在无事务的情况下继续执行（否则第二步写入无法回滚）
      const err = new Error('无法开启数据库事务：' + String((e && e.message) || e));
      err.code = 'TX_BEGIN_FAILED';
      throw err;
    }
    let result;
    try {
      result = fn();
    } catch (e) {
      let rbErr = null;
      try { this.exec('ROLLBACK'); } catch (e2) { rbErr = e2; }
      if (rbErr) {
        // 回滚失败：保留原始错误 + 追加回滚失败原因（不伪装成干净回滚）
        const msg = '操作失败且回滚失败：' + String((e && e.message) || e)
          + '；回滚错误：' + String((rbErr && rbErr.message) || rbErr);
        const err = new Error(msg);
        err.code = 'TX_ROLLBACK_FAILED';
        err.rollback_failed = true;
        err.original_error = String((e && e.message) || e);
        throw err;
      }
      throw e;
    }
    // COMMIT 失败 → 绝不返回成功（数据可能未落盘 / 未提交）
    try {
      this.exec('COMMIT');
    } catch (e) {
      let rbErr = null;
      try { this.exec('ROLLBACK'); } catch (e2) { rbErr = e2; }
      const msg = '数据库事务提交失败：' + String((e && e.message) || e)
        + (rbErr ? '；回滚错误：' + String((rbErr && rbErr.message) || rbErr) : '');
      const err = new Error(msg);
      err.code = 'TX_COMMIT_FAILED';
      err.commit_failed = true;
      if (rbErr) err.rollback_failed = true;
      throw err;
    }
    return result;
  }

  // ---------- 双表原子写（plan_tasks + pubs） ----------
  //
  // 供「待核实」人工处理使用：计划任务行与发布记录行必须**同时**成功或同时失败，
  // 绝不留下「一张表改了、另一张表没改」的半成功状态。
  //
  //   SQLite：真实事务（BEGIN / COMMIT / ROLLBACK），见 _txStrict。
  //   JSON  ：没有数据库事务 → 改之前先备份两张表的内存数据，
  //           两张表都改完后**一次性**持久化；
  //           任一步失败（写入抛错 / 落盘失败）→ 内存整体还原 → 重新持久化原状。
  //
  // ★ JSON 分支的边界：writeFileSync 失败时文件可能已被截断（写了一半），
  //   这种情况下"重新持久化原状"也可能再次失败 —— 此时磁盘状态无法保证，
  //   但**内存状态一定已还原**，且本方法会明确抛错，绝不返回成功。
  _planAtomicWrite(fn) {
    if (this.mode === 'sqlite') return this._txStrict(fn);
    // JSON 兜底：备份两张表（null 表示原本不存在该数组）
    const hadTasks = Array.isArray(this.data.plan_tasks);
    const hadPubs = Array.isArray(this.data.pubs);
    const snapTasks = hadTasks ? JSON.stringify(this.data.plan_tasks) : null;
    const snapPubs = hadPubs ? JSON.stringify(this.data.pubs) : null;
    let result = null;
    let failure = null;
    try {
      result = fn();
    } catch (e) {
      failure = e;
    }
    if (!failure) {
      try {
        // 两张表一起落盘（只写一次文件）
        fs.writeFileSync(this.jsonFile, JSON.stringify(this.data, null, 2));
        return result;
      } catch (e) {
        failure = new Error('保存到本地文件失败：' + String((e && e.message) || e));
        failure.code = 'PUBLISH_PERSIST_FAILED';
      }
    }
    // 失败 → 两张表的内存状态整体还原 → 重新持久化原状
    if (snapTasks === null) delete this.data.plan_tasks;
    else this.data.plan_tasks = JSON.parse(snapTasks);
    if (snapPubs === null) delete this.data.pubs;
    else this.data.pubs = JSON.parse(snapPubs);
    try { fs.writeFileSync(this.jsonFile, JSON.stringify(this.data, null, 2)); } catch (_e) {}
    throw failure;
  }
  // 自愈：保证库里至多一个主推作品。
  //   旧版本（主推只在界面内存里互斥）可能已经留下多条 queue='主推' 的脏数据，
  //   这里保留 created_at 最早的一条为主推，其余降级为 '挂机'。
  //   正常情况下没有脏数据时是 no-op（不写库）。
  ensureSingleMain() {
    const mains = this.mode === 'sqlite'
      ? this.all("SELECT id FROM works WHERE queue = '主推' ORDER BY created_at ASC, id ASC")
      : (this.data.works || [])
          .filter((w) => w && w.queue === '主推')
          .map((w) => ({ id: w.id }))
          .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (mains.length <= 1) return { ok: true, main: mains.length ? mains[0].id : null, repaired: [] };
    const keep = mains[0].id;
    const repair = mains.slice(1).map((m) => m.id);
    this._tx(() => {
      for (const rid of repair) {
        this.run("UPDATE works SET queue = '挂机' WHERE id = ? AND queue = '主推'", [rid]);
      }
    });
    if (this.mode !== 'sqlite') {
      for (const w of this.data.works || []) {
        if (w && repair.indexOf(w.id) >= 0) w.queue = '挂机';
      }
      this.saveJson();
    }
    return { ok: true, main: keep, repaired: repair };
  }
  // v1.10 PATCH 语义：只更新传入的字段，未传入的字段不重置
  //   之前 saveWork({ id, star }) 会把 name/type/url 重置为空字符串（因为未传入走默认 ''）
  //   改为：检查传入对象是否含某字段，只 UPDATE 提供的字段。
  //   注意：`undefined`（属性不存在）→ 不更新；`null` 或空字符串 → 显式更新为该值
  //   （调用方应避免传 undefined；当前所有调用方都是显式传值）
  saveWork(w) {
    if (!w || !w.id) return w;
    const id = w.id;
    // 唯一主推兜底：任何把 queue 写成 '主推' 的写入（launch 新建作品、IPC 直调等）
    // 都必须顺带降级其它主推，否则会出现两个主推。降级与本次写入同事务提交。
    const wantsMain = ('queue' in w) && String(w.queue) === '主推';

    if (this.mode === 'sqlite') {
      // 先看这条记录是否存在（决定走 INSERT 还是 UPDATE-only）
      const existing = this.get('SELECT * FROM works WHERE id = ?', [id]);
      const isUpdate = !!existing;
      const now = new Date().toISOString();

      if (isUpdate) {
        // UPDATE-only：只更新传入对象里**显式出现**的字段
        const fields = [];
        const args = [];
        function addCol(col, val) {
          fields.push(col + ' = ?');
          args.push(val);
        }
        if ('name' in w) addCol('name', String(w.name || ''));
        if ('type' in w) addCol('type', String(w.type || ''));
        if ('intro' in w) addCol('intro', String(w.intro || ''));
        if ('url' in w) addCol('url', String(w.url || ''));
        if ('status' in w) addCol('status', String(w.status || 'draft'));
        if ('queue' in w) addCol('queue', String(w.queue || '0'));
        if ('queue_state' in w) addCol('queue_state', String(w.queue_state || 'queued'));
        if ('priority' in w) addCol('priority', Number(w.priority) || 0);
        if ('launched_at' in w) addCol('launched_at', w.launched_at || null);
        if ('last_active_at' in w) addCol('last_active_at', w.last_active_at || null);
        if ('star' in w) addCol('star', Number(w.star) || 0);
        if ('dl' in w) addCol('dl', Number(w.dl) || 0);
        if ('visitors' in w) addCol('visitors', Number(w.visitors) || 0);
        if ('play' in w) addCol('play', String(w.play || '0'));
        // v5：YouTube 播放量。yt_views 允许显式传 null（表示"无有效缓存"，卡片显示 --）
        if ('yt_url' in w) addCol('yt_url', String(w.yt_url || ''));
        if ('yt_views' in w) addCol('yt_views', (w.yt_views === null || w.yt_views === undefined) ? null : (Number(w.yt_views) || 0));
        if ('yt_updated_at' in w) addCol('yt_updated_at', w.yt_updated_at || null);
        if ('next' in w) addCol('next', String(w.next || ''));
        // updated_at 永远刷新
        fields.push('updated_at = ?'); args.push(now);
        args.push(id);
        const doUpdate = () => {
          if (fields.length > 1) {
            this.run('UPDATE works SET ' + fields.join(', ') + ' WHERE id = ?', args);
          }
        };
        if (wantsMain) {
          // 降级其它主推 + 提升本条：同一次提交，不出现"两个主推"的中间态
          this._tx(() => { this.demoteOtherMains(id); doUpdate(); });
        } else {
          doUpdate();
        }
        // 返回最新的完整记录（前端希望 saveWork 返回 row）
        return this.get('SELECT * FROM works WHERE id = ?', [id]);
      } else {
        // INSERT：新记录用默认值兜底（与旧行为一致）
        const row = {
          id: id, name: String(w.name || ''), type: String(w.type || ''), intro: String(w.intro || ''),
          url: String(w.url || ''), status: String(w.status || 'draft'), queue: String(w.queue || '0'),
          queue_state: String(w.queue_state || 'queued'),
          priority: Number(w.priority) || 0,
          launched_at: w.launched_at || null,
          last_active_at: w.last_active_at || null,
          star: Number(w.star) || 0, dl: Number(w.dl) || 0,
          visitors: Number(w.visitors) || 0,
          play: String(w.play || '0'), next: String(w.next || ''),
          yt_url: String(w.yt_url || ''),
          yt_views: (w.yt_views === null || w.yt_views === undefined) ? null : (Number(w.yt_views) || 0),
          yt_updated_at: w.yt_updated_at || null,
          created_at: w.created_at || now,
          updated_at: now
        };
        const doInsert = () => {
          this.run(`
            INSERT INTO works (id, name, type, intro, url, status, queue, queue_state, priority, launched_at, last_active_at, star, dl, visitors, play, next, yt_url, yt_views, yt_updated_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [row.id, row.name, row.type, row.intro, row.url, row.status, row.queue, row.queue_state, row.priority, row.launched_at, row.last_active_at, row.star, row.dl, row.visitors, row.play, row.next, row.yt_url, row.yt_views, row.yt_updated_at, row.created_at, row.updated_at]);
        };
        if (wantsMain) {
          this._tx(() => { this.demoteOtherMains(id); doInsert(); });
        } else {
          doInsert();
        }
        return row;
      }
    } else {
      // JSON 兜底模式：合并保留旧字段（PATCH 语义）
      const i = this.data.works.findIndex(x => x.id === id);
      if (i >= 0) {
        const old = this.data.works[i];
        // 仅合并**传入对象里显式出现**的字段；保留旧字段不变
        const merged = Object.assign({}, old);
        for (const k of Object.keys(w)) {
          if (k === 'id') continue;
          merged[k] = w[k];
        }
        // updated_at 永远刷新
        merged.updated_at = new Date().toISOString();
        // launched_at 为空时保留旧值
        if ('launched_at' in w && !w.launched_at) merged.launched_at = old.launched_at || null;
        this.data.works[i] = merged;
      } else {
        // 新记录用默认值兜底
        this.data.works.push({
          id: id,
          name: String(w.name || ''),
          type: String(w.type || ''),
          intro: String(w.intro || ''),
          url: String(w.url || ''),
          status: String(w.status || 'draft'),
          queue: String(w.queue || '0'),
          queue_state: String(w.queue_state || 'queued'),
          priority: Number(w.priority) || 0,
          launched_at: w.launched_at || null,
          last_active_at: w.last_active_at || null,
          star: Number(w.star) || 0,
          dl: Number(w.dl) || 0,
          visitors: Number(w.visitors) || 0,
          play: String(w.play || '0'),
          next: String(w.next || ''),
          yt_url: String(w.yt_url || ''),
          yt_views: (w.yt_views === null || w.yt_views === undefined) ? null : (Number(w.yt_views) || 0),
          yt_updated_at: w.yt_updated_at || null,
          created_at: w.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }
      // 唯一主推兜底（JSON 模式）：降级其它主推，与本次写入一次性落盘
      if (wantsMain) this.demoteOtherMains(id);
      this.saveJson();
      return this.data.works.find(x => x.id === id);
    }
  }
  deleteWork(id) {
    // 级联删除是否真的动到了发布记录（动了才需要通知 renderer）
    let pubsChanged = false;
    if (this.mode === 'sqlite') {
      this.run('DELETE FROM works WHERE id = ?', [id]);
      const pubRes = this.run('DELETE FROM pubs WHERE work_id = ?', [id]);
      if (pubRes && typeof pubRes.changes === 'number' && pubRes.changes > 0) pubsChanged = true;
      // 首秀计划：该作品的计划配置与任务记录一并清理（与既有发布记录同一策略）。
      //   注意：计划层与发布记录层互不影响，删除计划不会伪造任何发布历史。
      this.run('DELETE FROM plan_stages WHERE work_id = ?', [id]);
      this.run('DELETE FROM plan_tasks WHERE work_id = ?', [id]);
    } else {
      this.data.works = this.data.works.filter(w => w.id !== id);
      const pubsBefore = (this.data.pubs || []).length;
      this.data.pubs = this.data.pubs.filter(p => p.work_id !== id);
      if ((this.data.pubs || []).length !== pubsBefore) pubsChanged = true;
      this.data.plan_stages = (this.data.plan_stages || []).filter(s => s.work_id !== id);
      this.data.plan_tasks = (this.data.plan_tasks || []).filter(t => t.work_id !== id);
      this.saveJson();
    }
    // 级联删除已落库 → 通知
    if (pubsChanged) notifyPubsChanged();
    return true;
  }

  // ---------- 发布记录 ----------
  // 记录必须来自"实际执行的发布任务"：platform_id 是真实发布目标，
  // status 区分 ok / failed / manual，url 只在真实拿到时写入（不臆造平台地址）。
  // pub_key 用于幂等：同一次发布被多个回调或刷新重复登记时只保留一条，避免重复计数。
  listPubs() {
    if (this.mode === 'sqlite') {
      return this.all('SELECT * FROM pubs ORDER BY created_at DESC');
    }
    return this.data.pubs;
  }
  addPub(r) {
    r = r || {};
    const key = String(r.pub_key || '');
    // 幂等 + 更新：同一 pub_key 已存在时**更新既有记录**（而不是再插一行）。
    // 场景：同一次发布先失败后成功（失败原因被成功结果覆盖）、或多个回调重复登记。
    if (key) {
      let exist = null;
      try {
        exist = this.mode === 'sqlite'
          ? this.get('SELECT * FROM pubs WHERE pub_key = ? LIMIT 1', [key])
          : (this.data.pubs || []).filter(function (p) { return p && p.pub_key === key; })[0] || null;
      } catch (_e) { exist = null; }
      if (exist) {
        const upd = {
          work_id: r.work_id || exist.work_id || '',
          platform: r.platform || exist.platform || '',
          title: typeof r.title === 'string' ? r.title : (exist.title || ''),
          body: typeof r.body === 'string' ? r.body : (exist.body || ''),
          tags: typeof r.tags === 'string' ? r.tags : (exist.tags || ''),
          time: r.time || exist.time || '',
          platform_id: r.platform_id || exist.platform_id || '',
          // 缺失状态**不能**兜底成 'ok'：没有状态就落 'unknown'，由前端显示"状态未知"。
          status: r.status || exist.status || 'unknown',
          url: r.url || exist.url || '',
          error: r.error || exist.error || '',
          video_id: r.video_id || exist.video_id || ''
        };
        if (this.mode === 'sqlite') {
          this.run(
            'UPDATE pubs SET work_id=?, platform=?, title=?, body=?, tags=?, time=?, platform_id=?, status=?, url=?, error=?, video_id=? WHERE pub_key=?',
            [upd.work_id, upd.platform, upd.title, upd.body, upd.tags, upd.time,
              upd.platform_id, upd.status, upd.url, upd.error, upd.video_id, key]
          );
          // 写入已落库 → 通知（失败不会走到这里）
          notifyPubsChanged();
          return this.get('SELECT * FROM pubs WHERE pub_key = ? LIMIT 1', [key]);
        }
        Object.keys(upd).forEach(function (k) { exist[k] = upd[k]; });
        this.saveJson();
        notifyPubsChanged();
        return exist;
      }
    }
    const row = {
      work_id: r.work_id || '', platform: r.platform || '',
      title: r.title || '', body: r.body || '',
      tags: r.tags || '', time: r.time || '',
      platform_id: r.platform_id || '',
      // 同上：没写状态就记 unknown，不冒充成功。
      status: r.status || 'unknown',
      url: r.url || '',
      error: r.error || '',
      video_id: r.video_id || '',
      pub_key: key,
      created_at: new Date().toISOString()
    };
    if (this.mode === 'sqlite') {
      try {
        this.run(
          'INSERT INTO pubs (work_id, platform, title, body, tags, time, platform_id, status, url, error, video_id, pub_key, created_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [row.work_id, row.platform, row.title, row.body, row.tags, row.time,
            row.platform_id, row.status, row.url, row.error, row.video_id, row.pub_key, row.created_at]
        );
      } catch (e) {
        // 并发重复提交：唯一索引（idx_pubs_pub_key）报冲突，说明**同一个 pub_key**
        //   的记录已经由另一次写入落库了 —— 那就是"同一次操作已经成功"。
        //   这里重新读取同键记录并按成功返回，**绝不**把正常的幂等冲突
        //   误报成发布失败（否则用户会看到失败提示，而记录其实已经写好了）。
        if (!isUniqueViolationError(e)) throw e;
        const same = this.get('SELECT * FROM pubs WHERE pub_key = ? LIMIT 1', [key]);
        if (!same) throw e;               // 不是同键冲突 → 原始错误照抛
        return same;                      // 同一次操作已成功 → 幂等返回
      }
      // 写入已落库 → 通知（失败不会走到这里）
      notifyPubsChanged();
    } else {
      // JSON 兜底没有自增主键：自己生成一个稳定行 id，供"按记录精确删除"使用
      if (!row.id) row.id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      this.data.pubs.push(row);
      this.saveJson();
      notifyPubsChanged();
    }
    return row;
  }

  // 删除发布记录（**只删本机 pubs 表里的记录行**）
  //
  // 删除范围（明确）：
  //   - 删除的是 Rokit 本地保存的"发布记录"；
  //   - **不**删除作品（works）、**不**删除本地视频文件、**不**撤销平台授权；
  //   - **不**调用任何外部平台删除 API，不动平台上的原始内容。
  //
  // 定位方式：只用**稳定唯一标识**精确匹配 —— pubs.id（自增主键）或 pub_key（发布幂等键）。
  //   绝不使用 work_id / platform / title / 时间做条件删除，
  //   否则会连带删掉同一作品在其他平台的记录（越界误删）。
  //
  // 返回 { deleted: 实际删除条数, ids: 命中的行 id 列表, keys: 命中的 pub_key 列表 }
  deletePubs(targets) {
    const list = Array.isArray(targets) ? targets : (targets ? [targets] : []);
    const ids = [];
    const keys = [];
    list.forEach(function (t) {
      if (t === null || t === undefined) return;
      let rid = '';
      let pk = '';
      if (typeof t === 'object') {
        rid = (t.id === null || t.id === undefined) ? '' : String(t.id);
        pk = t.pub_key ? String(t.pub_key) : '';
      } else {
        rid = String(t);
      }
      rid = rid.trim();
      if (rid) ids.push(rid);
      if (pk) keys.push(pk);
    });
    let deleted = 0;
    const hitIds = [];
    const hitKeys = [];
    if (this.mode === 'sqlite') {
      const self = this;
      ids.forEach(function (id) {
        const rows = self.all('SELECT id FROM pubs WHERE id = ?', [id]);
        if (!rows || !rows.length) return;
        self.run('DELETE FROM pubs WHERE id = ?', [id]);
        rows.forEach(function (r) { hitIds.push(r.id); });
        deleted += rows.length;
      });
      keys.forEach(function (k) {
        const rows = self.all('SELECT id, pub_key FROM pubs WHERE pub_key = ?', [k]);
        if (!rows || !rows.length) return;
        self.run('DELETE FROM pubs WHERE pub_key = ?', [k]);
        rows.forEach(function (r) { hitIds.push(r.id); hitKeys.push(r.pub_key); });
        deleted += rows.length;
      });
    } else {
      const before = (this.data.pubs || []).length;
      this.data.pubs = (this.data.pubs || []).filter(function (p) {
        const pid = (p && p.id !== undefined && p.id !== null) ? String(p.id) : '';
        const pk = (p && p.pub_key) ? String(p.pub_key) : '';
        if (pid && ids.indexOf(pid) >= 0) return false;
        if (pk && keys.indexOf(pk) >= 0) return false;
        return true;
      });
      deleted = before - this.data.pubs.length;
      this.saveJson();
    }
    // 删除已落库 → 通知（只有真的删掉行才通知，空删不打扰 renderer）
    if (deleted > 0) notifyPubsChanged();
    return { deleted: deleted, ids: hitIds, keys: hitKeys };
  }

  // 删除**单条**手动发布记录（撤销「标记已发布」用）
  //
  // 语义（与 deletePubs 的区别，务必保持）：
  //   - 只按**完整 pub_key 精确匹配**删除，**只删这一条**；
  //   - 绝不使用 work_id / platform_id / (platform_id, work_id) 之类的条件，
  //     否则会连带删掉同一作品或同一平台的其他发布记录（越界误删）；
  //   - 只接受**新格式**手动标记键 manual|<platform_id>|<scope>|<op_id>：
  //       · 自动发布键（<platform_id>|<work_id>|<ts>）→ 拒绝；
  //       · 首秀计划键（plan|...）→ 拒绝；
  //       · 旧三段式历史键（manual|<pid>|<scope>）→ 拒绝（不猜测它对应哪次发布）。
  //     这样"撤销手动标记"绝不可能碰到自动发布或首秀计划的记录。
  //
  // 返回 { deleted: 实际删除条数（0 或 1）, key: 传入的 pub_key, id: 被删行 id }
  //   · deleted = 0 表示"记录本来就不存在"（重复撤销安全返回，不影响其他记录）；
  //   · 只有真的删掉行才通知 pubs:changed。
  deleteManualPub(pubKey) {
    const key = String(pubKey === null || pubKey === undefined ? '' : pubKey).trim();
    // 非新格式手动标记键 → 拒绝删除（自动发布 / 首秀计划 / 旧历史键一律不碰）
    if (!key || !isManualOpPubKey(key)) {
      return { deleted: 0, key: key, id: null, rejected: true };
    }
    let deleted = 0;
    let hitId = null;
    if (this.mode === 'sqlite') {
      // ORDER BY id DESC：明确按 id 从大到小取，
      //   这样"删最新一条"是**显式契约**，不依赖 SQLite 的隐式返回顺序。
      const rows = this.all('SELECT id FROM pubs WHERE pub_key = ? ORDER BY id DESC', [key]);
      if (!rows || !rows.length) return { deleted: 0, key: key, id: null };
      if (rows.length === 1) {
        // 正常路径（pub_key 非空且被部分唯一索引约束 → 必然只有一行）：
        //   用**完整 pub_key 精确删除**，绝不用 work_id / platform_id 之类的条件。
        const res = this.run('DELETE FROM pubs WHERE pub_key = ?', [key]);
        hitId = rows[0].id;
        deleted = (res && typeof res.changes === 'number') ? res.changes : 1;
      } else {
        // 极罕见：唯一索引建不出来（个别机器上存在非空重复键）时，同键会有多行。
        //   此时只删**最新的一条**（id 最大 = 当前那次标记），其余历史行保持原样。
        //   与 JSON 分支语义一致（JSON 侧倒序找首个命中 = 最后写入的那条）。
        const target = rows[0];
        this.run('DELETE FROM pubs WHERE id = ? AND pub_key = ?', [target.id, key]);
        hitId = target.id;
        deleted = 1;
      }
    } else {
      const list = this.data.pubs || [];
      let idx = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        if (p && String(p.pub_key || '') === key) { idx = i; break; }
      }
      if (idx < 0) return { deleted: 0, key: key, id: null };
      const removed = list.splice(idx, 1)[0];
      hitId = (removed && removed.id !== undefined && removed.id !== null) ? removed.id : null;
      deleted = 1;
      this.saveJson();
    }
    // 删除已落库 → 通知（空删不打扰 renderer）
    if (deleted > 0) notifyPubsChanged();
    return { deleted: deleted, key: key, id: hitId };
  }

  // ---------- 首秀计划（计划配置 + 平台执行任务） ----------
  //
  // 两层数据模型（v7）：
  //   plan_stages —— 计划配置层：作品 ID / 稳定阶段 ID / 阶段序号 / 标题 / 说明 /
  //                  日期偏移量 / 执行时刻 / 平台数组 / 文案快照 / 创建与更新时间。
  //   plan_tasks  —— 平台执行任务层：稳定任务 ID / 阶段 ID / 作品 ID / 平台 /
  //                  计划执行时间 / 状态 / 实际开始结束时间 / 真实平台 ID 与链接 /
  //                  错误信息 / 幂等键。
  //
  // 关键约定：
  //   - 阶段 ID 与任务 ID 都是稳定标识，**不依赖 DAY 文本**，也不依赖数组长度。
  //   - 任务 ID 由「阶段 ID + 平台」派生（pt_<stage_id>_<platform_id>），
  //     因此重复保存同一份计划不会产生重复任务（天然幂等）。
  //   - 所有读写都必须带 owner（作品 ID 或草稿 ID）；跨作品的阶段不允许被读取或覆盖。
  //   - 删除阶段 ≠ 取消任务：删除阶段只取消该阶段**尚未执行**的任务，
  //     已完成 / 已失败的历史任务原样保留（绝不伪造为未发布）。
  //   - 既有发布记录（pubs）完全不受计划层影响。

  // 计划执行时间：本地时区解释规则
  //   base = 作品创建时间（UTC ISO）→ 换算到本地日历日 → 加 offset_days 天 →
  //   设定本地时刻 time_of_day（HH:mm）→ 转回 UTC ISO 存储。
  //   这样「创建日 +2 天 10:00」在用户所在时区就是本地上午 10:00。
  _planScheduledAt(workCreatedAt, offsetDays, timeOfDay) {
    const base = workCreatedAt ? new Date(workCreatedAt) : null;
    const d = (base && !isNaN(base.getTime())) ? base : new Date();
    const off = Math.max(0, Math.floor(Number(offsetDays) || 0));
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(timeOfDay || '').trim());
    const hh = m ? parseInt(m[1], 10) : 20;
    const mm = m ? parseInt(m[2], 10) : 0;
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + off, hh, mm, 0, 0);
    return t.toISOString();
  }
  _planParseJson(raw, fallback) {
    if (raw === null || raw === undefined || raw === '') return fallback;
    if (typeof raw === 'object') return raw;
    try {
      const v = JSON.parse(raw);
      return (v === null || v === undefined) ? fallback : v;
    } catch (_e) { return fallback; }
  }
  _planStageOut(r) {
    if (!r) return null;
    const platforms = this._planParseJson(r.platforms, []);
    return {
      id: String(r.id),
      work_id: String(r.work_id || ''),
      seq: Number(r.seq) || 0,
      title: String(r.title || ''),
      desc: String(r.desc || ''),
      offset_days: Math.max(0, Number(r.offset_days) || 0),
      time_of_day: String(r.time_of_day || '20:00'),
      scheduled_at: String(r.scheduled_at || ''),
      auto_publish: Number(r.auto_publish) ? 1 : 0,
      platforms: Array.isArray(platforms) ? platforms.map(String) : [],
      copy: this._planParseJson(r.copy, {}),
      created_at: r.created_at || '',
      updated_at: r.updated_at || ''
    };
  }
  _planTaskOut(r) {
    if (!r) return null;
    return {
      id: String(r.id),
      stage_id: String(r.stage_id || ''),
      work_id: String(r.work_id || ''),
      platform_id: String(r.platform_id || ''),
      stage_seq: Number(r.stage_seq) || 0,
      stage_title: String(r.stage_title || ''),
      scheduled_at: r.scheduled_at || '',
      status: String(r.status || 'pending'),
      started_at: r.started_at || '',
      finished_at: r.finished_at || '',
      platform_ref: String(r.platform_ref || ''),
      platform_url: String(r.platform_url || ''),
      error: String(r.error || ''),
      note: String(r.note || ''),
      pub_key: String(r.pub_key || ''),
      // 模拟标识：1 = 该任务的执行结果由模拟执行器产生，**不代表真实平台发布成功**
      simulated: Number(r.simulated) ? 1 : 0,
      // 等待真实执行：1 = 模拟调度器不得领取 / 执行，只有真实执行器可以接手
      real_only: Number(r.real_only) ? 1 : 0,
      // 原模拟结果归档（重排时写入，后续执行不会覆盖）
      history_note: String(r.history_note || ''),
      created_at: r.created_at || '',
      updated_at: r.updated_at || ''
    };
  }
  // 计划任务的幂等键：同一「作品 + 阶段 + 平台」永远同一个键
  _planTaskId(stageId, platformId) {
    return 'pt_' + String(stageId) + '_' + String(platformId);
  }
  // 查某个阶段 ID 当前归属哪个作品（跨作品保护用）
  _planStageOwnerOf(stageId) {
    const id = String(stageId || '');
    if (!id) return '';
    if (this.mode === 'sqlite') {
      const r = this.get('SELECT work_id FROM plan_stages WHERE id = ?', [id]);
      return r ? String(r.work_id || '') : '';
    }
    const s = (this.data.plan_stages || []).filter(x => x && x.id === id)[0];
    return s ? String(s.work_id || '') : '';
  }

  // 读取某作品的计划配置（按阶段序号升序）
  listPlanStages(workId) {
    const owner = String(workId || '');
    if (!owner) return [];
    if (this.mode === 'sqlite') {
      return this.all('SELECT * FROM plan_stages WHERE work_id = ? ORDER BY seq ASC, created_at ASC', [owner])
        .map(r => this._planStageOut(r));
    }
    return (this.data.plan_stages || [])
      .filter(s => String(s.work_id || '') === owner)
      .slice()
      .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
      .map(s => this._planStageOut(s));
  }

  // 全部作品的计划配置（「发布计划」全局视图用；workId 为空 = 不限作品）
  listAllPlanStages() {
    if (this.mode === 'sqlite') {
      return this.all('SELECT * FROM plan_stages ORDER BY work_id ASC, seq ASC, created_at ASC')
        .map(r => this._planStageOut(r));
    }
    return (this.data.plan_stages || [])
      .slice()
      .sort((a, b) => (String(a.work_id || '').localeCompare(String(b.work_id || '')))
        || ((Number(a.seq) || 0) - (Number(b.seq) || 0)))
      .map(s => this._planStageOut(s));
  }

  // 计划归属（owner）合法性校验。
  //   计划只能挂在两种归属上：
  //     1) 真实作品 ID：必须真的存在于 works 表（SQLite / JSON 两种存储路径判定一致）；
  //     2) 草稿归属 ID：必须符合 draft_ 命名规则（作品正式落库前的临时归属）。
  //   其它一律拒绝：既挡住"指向不存在作品的普通 ID"，也挡住"格式非法的草稿 ID"。
  //   ★ 拒绝发生在任何写入之前，非法归属不会留下半份计划数据。
  _planOwnerValid(owner) {
    const id = String(owner || '');
    if (!id) return false;
    if (id.indexOf('draft_') === 0) return PLAN_DRAFT_OWNER_RE.test(id);
    return !!this._planWorkRow(id);
  }

  // 保存某作品的整份计划配置（阶段增 / 改 / 删一次到位）
  //   stages: [{id, title, desc, scheduledAt, autoPublish, platforms:[], copy:{}, offsetDays?, timeOfDay?}]
  //   - scheduledAt 为绝对执行时间（UTC ISO）；历史调用方可继续只传 offsetDays/timeOfDay（兼容计算）
  //   - autoPublish 仅为兼容历史数据保留：新保存时不再要求前端提供，
  //     是否真实执行由该平台是否已接入真实发布通道决定（见 PLAN_REAL_PLATFORMS）
  //   - 阶段序号按传入顺序重新编号（删除中间阶段后新增不会重号）
  //   - 未出现在入参里的旧阶段 = 删除：其未执行任务被取消，已完成历史保留
  //   - 每个平台的执行任务独立成行；重复保存不会重复建任务
  savePlanStages(workId, stages) {
    const owner = String(workId || '');
    if (!owner) return { ok: false, error: 'missing work id' };
    // ★ 归属校验（写入之前）：真实作品必须存在；草稿归属必须符合 draft_ 规则。
    if (!this._planOwnerValid(owner)) {
      return {
        ok: false,
        error: 'invalid plan owner: ' + owner
      };
    }
    const list = Array.isArray(stages) ? stages : [];
    const now = new Date().toISOString();

    // 规范化入参
    const norm = [];
    list.forEach((raw, idx) => {
      if (!raw) return;
      const id = String(raw.id || ('ps_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)));
      const plats = [];
      (Array.isArray(raw.platforms) ? raw.platforms : []).forEach(p => {
        const pid = String(p || '').trim();
        if (pid && plats.indexOf(pid) < 0) plats.push(pid);
      });
      const tm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(raw.timeOfDay || raw.time_of_day || '').trim());
      const rawScheduled = String(raw.scheduledAt !== undefined ? raw.scheduledAt : (raw.scheduled_at || '')).trim();
      const autoProvided = raw.autoPublish !== undefined || raw.auto_publish !== undefined;
      norm.push({
        id: id,
        seq: idx,
        title: String(raw.title || ''),
        desc: String(raw.desc || ''),
        offsetDays: Math.max(0, Math.floor(Number(raw.offsetDays !== undefined ? raw.offsetDays : raw.offset_days) || 0)),
        timeOfDay: tm ? tm[1].padStart(2, '0') + ':' + tm[2] : '20:00',
        scheduledAt: rawScheduled,
        autoPublish: autoProvided ? (Number(raw.autoPublish !== undefined ? raw.autoPublish : raw.auto_publish) ? 1 : 0) : null,
        platforms: plats,
        copy: this._planParseJson(raw.copy, {}) || {}
      });
    });

    const existing = this.listPlanStages(owner);
    const existingMap = {};
    existing.forEach(s => { existingMap[s.id] = s; });
    const keep = {};
    norm.forEach(s => { keep[s.id] = true; });

    // 绝对时间优先；未提供则沿用历史值；两者都没有才回退 offset/time（兼容旧调用方）
    norm.forEach(s => {
      const old = existingMap[s.id];
      const effectiveScheduled = s.scheduledAt || (old && old.scheduled_at ? old.scheduled_at : '');
      const effectiveAuto = s.autoPublish === null ? (old && old.auto_publish ? 1 : 0) : s.autoPublish;
      s._scheduled = effectiveScheduled;
      s._auto = effectiveAuto;
    });
    for (const s of norm) {
      if (s._scheduled) {
        const at = new Date(s._scheduled);
        if (isNaN(at.getTime())) {
          return { ok: false, error: 'invalid scheduled time: ' + s.id };
        }
        if (at.getTime() <= Date.now()) {
          return { ok: false, error: 'scheduled time must be in the future: ' + s.id };
        }
      }
    }

    // 跨作品保护：传入的阶段 ID 如果已属于**别的**作品，直接拒绝，
    // 绝不允许用一个作品的保存动作把另一个作品的阶段改写 / 夺走。
    for (const s of norm) {
      const owner2 = this._planStageOwnerOf(s.id);
      if (owner2 && owner2 !== owner) {
        return { ok: false, error: 'stage belongs to another work: ' + s.id };
      }
    }

    // 作品创建时间（用于计算计划执行时间）；owner 不是真实作品时用当前时间兜底
    let workCreatedAt = '';
    if (this.mode === 'sqlite') {
      const w = this.get('SELECT created_at FROM works WHERE id = ?', [owner]);
      workCreatedAt = (w && w.created_at) ? w.created_at : '';
    } else {
      const w = (this.data.works || []).filter(x => x && x.id === owner)[0];
      workCreatedAt = (w && w.created_at) ? w.created_at : '';
    }

    const self = this;
    this._tx(() => {
      // 1) 写入 / 更新阶段
      norm.forEach(s => {
        const platJson = JSON.stringify(s.platforms);
        const copyJson = JSON.stringify(s.copy || {});
        if (self.mode === 'sqlite') {
          const old = self.get('SELECT id FROM plan_stages WHERE id = ?', [s.id]);
          if (old) {
            self.run(
              'UPDATE plan_stages SET work_id=?, seq=?, title=?, desc=?, offset_days=?, time_of_day=?, scheduled_at=?, auto_publish=?, platforms=?, copy=?, updated_at=? WHERE id=?',
              [owner, s.seq, s.title, s.desc, s.offsetDays, s.timeOfDay, s._scheduled || '', s._auto ? 1 : 0, platJson, copyJson, now, s.id]
            );
          } else {
            self.run(
              'INSERT INTO plan_stages (id, work_id, seq, title, desc, offset_days, time_of_day, scheduled_at, auto_publish, platforms, copy, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
              [s.id, owner, s.seq, s.title, s.desc, s.offsetDays, s.timeOfDay, s._scheduled || '', s._auto ? 1 : 0, platJson, copyJson, now, now]
            );
          }
        } else {
          if (!Array.isArray(self.data.plan_stages)) self.data.plan_stages = [];
          const i = self.data.plan_stages.findIndex(x => x && x.id === s.id);
          const row = {
            id: s.id, work_id: owner, seq: s.seq, title: s.title, desc: s.desc,
            offset_days: s.offsetDays, time_of_day: s.timeOfDay,
            scheduled_at: s._scheduled || '', auto_publish: s._auto ? 1 : 0,
            platforms: s.platforms, copy: s.copy || {},
            created_at: (i >= 0 && self.data.plan_stages[i].created_at) ? self.data.plan_stages[i].created_at : now,
            updated_at: now
          };
          if (i >= 0) self.data.plan_stages[i] = row; else self.data.plan_stages.push(row);
        }
      });

      // 2) 不再出现的阶段 = 删除（取消其未执行任务，保留已完成历史）
      existing.forEach(s => {
        if (!keep[s.id]) self._planRemoveStage(owner, s.id, now);
      });
    });

    // 3) 同步平台执行任务（每个阶段 × 每个平台一行）
    norm.forEach(s => {
      // 新绝对时间优先；历史阶段仍按 offset/time 兼容计算
      const scheduled = s._scheduled || this._planScheduledAt(workCreatedAt, s.offsetDays, s.timeOfDay);
      // 真实执行资格：由**平台是否已接入真实发布通道**决定（PLAN_REAL_PLATFORMS），
      //   与阶段里选了哪些平台无关。
      //   auto_publish 字段仅为兼容旧数据保留，不再参与资格判断；
      //   未接入真实执行器的平台（如微信公众号）维持既有行为（real_only=0，仍走模拟执行）。
      const existingTasks = this.listPlanTasks(owner).filter(t => t.stage_id === s.id);
      const map = {};
      existingTasks.forEach(t => { map[t.platform_id] = t; });
      s.platforms.forEach(pid => {
        const tid = this._planTaskId(s.id, pid);
        const cur = map[pid];
        const taskRealOnly = (PLAN_REAL_PLATFORMS.indexOf(pid) >= 0) ? 1 : 0;
        if (cur) {
          // 已执行过的任务保留原始结果，不被编辑计划重置
          //   只有「尚未执行」的任务（pending / needs_review）允许被编辑计划改时间。
          //   running 属于执行中，cancelled / done / failed / draft_pending 属于历史结论，
          //   都不允许被编辑计划改写。
          if (cur.status === 'pending' || cur.status === 'needs_review') {
            // 仅对「计划原生、尚未启动、无历史备注」的 pending 任务重算真实执行资格；
            //   重新排队（real_only=1）或真实执行失败待复核（needs_review）的任务保持原资格，
            //   避免编辑计划把用户已排队的真实任务降级回模拟。
            const planManaged = cur.status === 'pending' && !cur.started_at && !cur.history_note && !cur.simulated;
            const roPatch = planManaged ? taskRealOnly : undefined;
            const write = {
              id: tid, stage_id: s.id, work_id: owner, platform_id: pid,
              stage_seq: s.seq, stage_title: s.title, scheduled_at: scheduled,
              status: cur.status, started_at: cur.started_at, finished_at: cur.finished_at,
              platform_ref: cur.platform_ref, platform_url: cur.platform_url,
              error: cur.error, note: cur.note, pub_key: cur.pub_key,
              simulated: cur.simulated || 0,
              created_at: cur.created_at, updated_at: now
            };
            if (roPatch !== undefined) write.real_only = roPatch;
            this._planWriteTask(write);
          } else if (cur.status === 'cancelled' && cur.note === PLAN_REMOVED_NOTE) {
            // 该任务当初只是因为「平台被移出该阶段」而被取消；
            //   用户现在又把同一个平台选回这个阶段 → 恢复为待执行（这是编辑计划配置，不是复活历史结论）。
            //   用户主动取消的任务（note 不同）永远保持「已取消」，不会被自动复活。
            this._planWriteTask({
              id: tid, stage_id: s.id, work_id: owner, platform_id: pid,
              stage_seq: s.seq, stage_title: s.title, scheduled_at: scheduled,
              status: 'pending', started_at: '', finished_at: '',
              platform_ref: '', platform_url: '', error: '', note: '',
              pub_key: cur.pub_key || ('plan|' + owner + '|' + s.id + '|' + pid),
              simulated: 0, real_only: taskRealOnly,
              created_at: cur.created_at, updated_at: now
            });
          }
        } else {
          this._planWriteTask({
            id: tid, stage_id: s.id, work_id: owner, platform_id: pid,
            stage_seq: s.seq, stage_title: s.title, scheduled_at: scheduled,
            status: 'pending', started_at: '', finished_at: '',
            platform_ref: '', platform_url: '', error: '', note: '',
            pub_key: 'plan|' + owner + '|' + s.id + '|' + pid,
            simulated: 0, real_only: taskRealOnly,
            created_at: now, updated_at: now
          });
        }
      });
      // 平台被移出该阶段 → 未执行任务取消（保留记录），已执行历史保留
      //   running（执行中）不动：本阶段不提供中断执行的能力。
      Object.keys(map).forEach(pid => {
        if (s.platforms.indexOf(pid) >= 0) return;
        const t = map[pid];
        if (t.status === 'pending' || t.status === 'needs_review') {
          this._planWriteTask(Object.assign({}, t, {
            status: 'cancelled',
            finished_at: t.finished_at || now,
            note: t.note || PLAN_REMOVED_NOTE,
            updated_at: now
          }));
        }
      });
    });

    if (this.mode !== 'sqlite') this.saveJson();
    return { ok: true, stages: this.listPlanStages(owner), tasks: this.listPlanTasks(owner) };
  }

  // 内部：写入 / 更新一条任务行
  _planWriteTask(t) {
    // 只保留任务表的真实字段（pub_state 等派生字段不落库）
    const F = ['id', 'stage_id', 'work_id', 'platform_id', 'stage_seq', 'stage_title',
      'scheduled_at', 'status', 'started_at', 'finished_at', 'platform_ref', 'platform_url',
      'error', 'note', 'pub_key', 'simulated', 'real_only', 'history_note', 'created_at', 'updated_at'];
    const row = {};
    F.forEach(k => { if (t[k] !== undefined) row[k] = t[k]; });
    if (this.mode === 'sqlite') {
      const old = this.get('SELECT id FROM plan_tasks WHERE id = ?', [row.id]);
      // simulated / real_only / history_note 未提供时保持原值（COALESCE），不把既有标识抹掉
      const sim = row.simulated === undefined ? null : (Number(row.simulated) ? 1 : 0);
      const ro = row.real_only === undefined ? null : (Number(row.real_only) ? 1 : 0);
      const hn = row.history_note === undefined ? null : String(row.history_note || '');
      if (old) {
        this.run(
          'UPDATE plan_tasks SET stage_id=?, work_id=?, platform_id=?, stage_seq=?, stage_title=?, scheduled_at=?, status=?, started_at=?, finished_at=?, platform_ref=?, platform_url=?, error=?, note=?, pub_key=?, simulated=COALESCE(?, simulated), real_only=COALESCE(?, real_only), history_note=COALESCE(?, history_note), updated_at=? WHERE id=?',
          [row.stage_id, row.work_id, row.platform_id, row.stage_seq, row.stage_title, row.scheduled_at, row.status,
            row.started_at, row.finished_at, row.platform_ref, row.platform_url, row.error, row.note, row.pub_key, sim, ro, hn,
            row.updated_at, row.id]
        );
      } else {
        this.run(
          'INSERT INTO plan_tasks (id, stage_id, work_id, platform_id, stage_seq, stage_title, scheduled_at, status, started_at, finished_at, platform_ref, platform_url, error, note, pub_key, simulated, real_only, history_note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [row.id, row.stage_id, row.work_id, row.platform_id, row.stage_seq, row.stage_title, row.scheduled_at, row.status,
            row.started_at, row.finished_at, row.platform_ref, row.platform_url, row.error, row.note, row.pub_key,
            row.simulated === undefined ? 0 : (Number(row.simulated) ? 1 : 0),
            row.real_only === undefined ? 0 : (Number(row.real_only) ? 1 : 0),
            row.history_note === undefined ? '' : String(row.history_note || ''),
            row.created_at, row.updated_at]
        );
      }
    } else {
      if (!Array.isArray(this.data.plan_tasks)) this.data.plan_tasks = [];
      const i = this.data.plan_tasks.findIndex(x => x && x.id === row.id);
      if (i >= 0) this.data.plan_tasks[i] = Object.assign({}, this.data.plan_tasks[i], row);
      else this.data.plan_tasks.push(Object.assign({}, row));
    }
  }

  // 内部：删除阶段（取消其未执行任务，保留已执行历史）
  //   - 只取消「尚未执行」的任务（pending / needs_review）。
  //   - running（执行中）不动：本阶段不提供中断执行的能力，也不能重复触发。
  //   - done / failed / draft_pending（已执行结论）原样保留，绝不伪造为未发布。
  _planRemoveStage(owner, stageId, now) {
    const tasks = this.listPlanTasks(owner).filter(t => t.stage_id === stageId);
    tasks.forEach(t => {
      if (t.status === 'pending' || t.status === 'needs_review') {
        this._planWriteTask(Object.assign({}, t, {
          status: 'cancelled',
          finished_at: t.finished_at || (now || new Date().toISOString()),
          note: t.note || '所属阶段已删除',
          updated_at: now || new Date().toISOString()
        }));
      }
    });
    if (this.mode === 'sqlite') {
      this.run('DELETE FROM plan_stages WHERE id = ? AND work_id = ?', [stageId, owner]);
    } else {
      this.data.plan_stages = (this.data.plan_stages || []).filter(s => !(s && s.id === stageId && String(s.work_id) === String(owner)));
    }
  }

  // 删除单个阶段（对外接口；校验归属，禁止跨作品删除）
  deletePlanStage(workId, stageId) {
    const owner = String(workId || '');
    const sid = String(stageId || '');
    if (!owner || !sid) return { ok: false, error: 'missing work id or stage id' };
    const stage = this.listPlanStages(owner).filter(s => s.id === sid)[0];
    if (!stage) return { ok: false, error: 'stage not found for work' };
    const now = new Date().toISOString();
    this._planRemoveStage(owner, sid, now);
    if (this.mode !== 'sqlite') this.saveJson();
    return { ok: true, stage_id: sid, tasks: this.listPlanTasks(owner) };
  }

  // 删除整份计划（该作品的全部阶段配置 + 尚未执行的任务）
  //   安全边界（删除计划时必须同时成立，缺一不可）：
  //   - 只处理调用方**明确指定**的作品：不动其它作品、不删除作品本身、不删除发布记录（pubs）；
  //   - 正在执行（running）的任务 → **拒绝删除**：中断执行会让「平台是否已收到」变成未知，
  //     删掉之后重新创建计划就可能造成重复发送；
  //   - 结果未知（needs_review）的**真实**任务 → **拒绝删除**：它记录着「可能已经发出去了」，
  //     必须先人工核实并处理（系统不会自动重发，也不能靠删计划抹掉这个状态）；
  //   - 尚未执行（pending）的任务 → 置为 cancelled：不再是 pending，调度器不会再选中它；
  //   - 已执行历史（done / failed / draft_pending / cancelled）→ 原样保留，绝不伪造成「未发布」。
  //   返回值带上删除 / 取消 / 保留的条数，便于界面明确告诉用户发生了什么。
  deletePlan(workId) {
    const owner = String(workId || '');
    if (!owner) return { ok: false, error: 'missing work id' };
    const stages = this.listPlanStages(owner);
    if (!stages.length) return { ok: false, error: '该作品没有已保存的计划' };
    const tasks = this.listPlanTasks(owner);
    const running = tasks.filter(t => t.status === 'running');
    if (running.length) {
      return {
        ok: false,
        blocked: 'running',
        error: '这个计划还有正在执行的任务，请等本次执行结束后再删除',
        blocked_tasks: running.map(t => t.id)
      };
    }
    const unknownReal = tasks.filter(t => t.status === 'needs_review' && !t.simulated);
    if (unknownReal.length) {
      return {
        ok: false,
        blocked: 'needs_review',
        error: '这个计划有结果未知、待人工核实的真实任务，请先到平台核实内容是否已经收到并处理后再删除（系统不会自动重发）',
        blocked_tasks: unknownReal.map(t => t.id)
      };
    }
    const now = new Date().toISOString();
    let cancelled = 0;
    let kept = 0;
    this._tx(() => {
      stages.forEach(s => {
        tasks.filter(t => t.stage_id === s.id).forEach(t => {
          // 只有「尚未执行」的任务会被取消；已执行结论（done / failed / draft_pending）原样保留
          if (t.status === 'pending' || (t.status === 'needs_review' && t.simulated)) {
            // 备注里可能已经有其它原因（例如转正时未能重算执行时间的说明），
            //   这里追加而不是覆盖，保证「已删除」这个结论始终可见。
            const oldNote = String(t.note || '');
            this._planWriteTask(Object.assign({}, t, {
              status: 'cancelled',
              finished_at: t.finished_at || now,
              note: oldNote ? (oldNote + '；计划已删除') : '计划已删除',
              updated_at: now
            }));
            cancelled++;
          } else {
            kept++;
          }
        });
        // 删除阶段配置行（任务历史保留）
        if (this.mode === 'sqlite') {
          this.run('DELETE FROM plan_stages WHERE id = ? AND work_id = ?', [s.id, owner]);
        } else {
          this.data.plan_stages = (this.data.plan_stages || [])
            .filter(x => !(x && String(x.id) === String(s.id) && String(x.work_id || '') === owner));
        }
      });
    });
    if (this.mode !== 'sqlite') this.saveJson();
    return {
      ok: true,
      work_id: owner,
      deleted_stages: stages.length,
      cancelled_tasks: cancelled,
      kept_tasks: kept,
      tasks: this.listPlanTasks(owner)
    };
  }

  // 列出任务（workId 为空 = 全部作品；用于「发布计划」全局视图）
  //   每条任务附带 pub_state：
  //     none    —— 该作品该平台没有已确认的发布记录
  //     done    —— 这条任务对应的幂等键已有成功发布记录
  //     review  —— 同作品同平台有手动发布成功记录，但无法确定对应的是哪条任务（待核实）
  listPlanTasks(workId) {
    const owner = workId === undefined || workId === null ? '' : String(workId);
    let rows = [];
    if (this.mode === 'sqlite') {
      rows = owner
        ? this.all('SELECT * FROM plan_tasks WHERE work_id = ? ORDER BY scheduled_at ASC, created_at ASC', [owner])
        : this.all('SELECT * FROM plan_tasks ORDER BY work_id ASC, scheduled_at ASC, created_at ASC');
    } else {
      const all = (this.data.plan_tasks || []).slice();
      rows = (owner ? all.filter(t => String(t.work_id || '') === owner) : all)
        .sort((a, b) => String(a.scheduled_at || '').localeCompare(String(b.scheduled_at || '')));
    }
    const tasks = rows.map(r => this._planTaskOut(r));
    return tasks.map(t => Object.assign(t, this._planPubState(t)));
  }

  // 手动发布记录与计划任务的关联判定
  //   - 同一幂等键命中 → done（这条任务确实已经发布成功）
  //   - 同作品同平台有确认成功的记录但幂等键不同 → review（待核实，不自动跳过也不重复发送）
  //   - 其它平台的成功记录**不影响**本条任务（不得因一个平台成功就标记其它平台完成）
  //   - **模拟任务（simulated=1）一律返回 none**：模拟结果永远不能被认定为真实发布成功，
  //     即使将来 pubs 里出现了同幂等键的真实记录，也不能把那条模拟历史说成"已发布"。
  _planPubState(task) {
    if (task && task.simulated) return { pub_state: 'none', pub_url: '', pub_time: '' };
    let pubs = [];
    if (this.mode === 'sqlite') {
      pubs = this.all("SELECT * FROM pubs WHERE work_id = ? AND platform_id = ? AND status IN ('ok','manual')", [task.work_id, task.platform_id]);
    } else {
      pubs = (this.data.pubs || []).filter(p => p && String(p.work_id || '') === String(task.work_id)
        && String(p.platform_id || '') === String(task.platform_id)
        && (p.status === 'ok' || p.status === 'manual'));
    }
    if (!pubs.length) return { pub_state: 'none' };
    const exact = pubs.filter(p => String(p.pub_key || '') === String(task.pub_key || '') && task.pub_key)[0];
    if (exact) return { pub_state: 'done', pub_url: exact.url || '', pub_time: exact.time || '' };
    return { pub_state: 'review' };
  }

  // 更新任务状态 / 结果（供后续调度器使用；本阶段不自动执行）
  //   边界：
  //   - 必须校验 workId 归属：别的作品的任务不能被改。
  //   - 已完成 / 已失败 / 草稿待发布：保留原始结果，不允许改写
  //     （否则等于用"编辑计划"抹掉真实执行历史）。
  //   - 执行中：本阶段不允许直接改写。
  //   - 未执行（pending / needs_review）：允许改执行时间等计划配置。
  updatePlanTask(workId, taskId, patch) {
    const owner = String(workId || '');
    const id = String(taskId || '');
    if (!owner || !id) return { ok: false, error: 'missing work id or task id' };
    const cur = this.listPlanTasks(owner).filter(t => t.id === id)[0];
    if (!cur) return { ok: false, error: 'task not found for work' };
    const p = patch || {};
    const locked = (cur.status === 'done' || cur.status === 'failed' || cur.status === 'draft_pending');
    if (locked) {
      // 只允许补一条备注，结果字段一律不动
      const allowed = {};
      if (typeof p.note === 'string') allowed.note = p.note;
      if (!Object.keys(allowed).length) return { ok: false, error: '已执行的任务结果不可改写' };
      const nextLocked = Object.assign({}, cur, allowed, { updated_at: new Date().toISOString() });
      this._planWriteTask(nextLocked);
      if (this.mode !== 'sqlite') this.saveJson();
      return { ok: true, task: this.listPlanTasks(owner).filter(t => t.id === id)[0] };
    }
    if (cur.status === 'running') return { ok: false, error: '执行中的任务不可直接改写' };
    if (cur.status === 'cancelled') return { ok: false, error: '已取消的任务不可恢复为待执行' };
    // 关联校验：work_id / stage_id 必须与任务本身一致，禁止跨作品、跨阶段改写
    if (p.work_id !== undefined && String(p.work_id) !== String(cur.work_id)) {
      return { ok: false, error: 'task does not belong to this work' };
    }
    if (p.stage_id !== undefined && String(p.stage_id) !== String(cur.stage_id)) {
      return { ok: false, error: 'task does not belong to this stage' };
    }
    if (p.platform_id !== undefined && String(p.platform_id) !== String(cur.platform_id)) {
      return { ok: false, error: 'task does not match this platform' };
    }
    const next = Object.assign({}, cur);
    ['scheduled_at', 'note'].forEach(k => {
      if (p[k] !== undefined) next[k] = p[k];
    });
    next.updated_at = new Date().toISOString();
    this._planWriteTask(next);
    if (this.mode !== 'sqlite') this.saveJson();
    return { ok: true, task: this.listPlanTasks(owner).filter(t => t.id === id)[0] };
  }

  // 取消一个未执行的任务：保留「已取消」状态与历史，不物理删除
  //   边界：
  //   - 已完成 / 已失败：保留原始结果，不允许取消（否则等于抹掉真实执行历史）
  //   - 执行中：本阶段不提供取消能力（实际取消执行留待调度器阶段实现），
  //     更不能删除或重复触发。
  cancelPlanTask(workId, taskId) {
    const owner = String(workId || '');
    const id = String(taskId || '');
    if (!owner || !id) return { ok: false, error: 'missing work id or task id' };
    const cur = this.listPlanTasks(owner).filter(t => t.id === id)[0];
    if (!cur) return { ok: false, error: 'task not found for work' };
    if (cur.status === 'done' || cur.status === 'failed') {
      return { ok: false, error: '已执行的任务不能取消' };
    }
    if (cur.status === 'running') {
      return { ok: false, error: '执行中的任务不能取消' };
    }
    const now = new Date().toISOString();
    this._planWriteTask(Object.assign({}, cur, {
      status: 'cancelled', finished_at: cur.finished_at || now,
      note: cur.note || '用户取消', updated_at: now
    }));
    if (this.mode !== 'sqlite') this.saveJson();
    return { ok: true, task: this.listPlanTasks(owner).filter(t => t.id === id)[0] };
  }

  // ---------- 调度器支持（第二阶段：模拟调度器） ----------
  //   设计约束：
  //   - 调度器只通过这几个方法读写任务，页面逻辑（index.html）碰不到执行状态；
  //   - 领取用「条件更新」实现（status='pending' 才允许被领取），
  //     因此同一个任务不可能被两个扫描周期同时领取（天然幂等）；
  //   - 落库用 run_token（= 领取时写入的 started_at）做乐观校验，
  //     防止旧结果覆盖新状态（例如重启后重新排队、再次执行）。

  // 到期待执行任务：status='pending' 且 scheduled_at <= now（跨全部作品）
  //   opts.forRealExecutor：
  //     - 缺省 / false → **排除** real_only=1 的任务（模拟调度器不得领取"等待真实执行"的任务）
  //     - true           → 包含 real_only=1 的任务（只有真实执行器可以接手）
  //   该开关**不依据 note / platform_ref 等展示字段**判断调度资格，只看专用标记列。
  //
  //   ★ 逾期保护（跨平台）：
  //     启动时被打上「逾期暂停」标记的任务，直到用户在逾期提醒里明确选择
  //     （立即执行 / 延后 / 放弃）之前，都不得被自动执行。
  //     分两层保护，缺一不可：
  //       - real_only=1（真实路径）：由调度器自己的 hold 检查跳过
  //         （plan-scheduler.js 里 useReal && isPlanTaskHeld），
  //         这里**仍然放行**给它，保证调度器能记录「逾期计划等待用户处理」的跳过原因；
  //       - real_only=0（模拟路径）：调度器的 hold 检查只覆盖真实路径，
  //         若这里也放行，它会被**模拟执行器**消费掉（status 变成 done / draft_pending），
  //         于是永远进不了逾期提醒 —— 所以在名单里直接排除。
  //     标记由 plan:overdue-run / -delay / -abandon 清除（clearPlanTaskHold），
  //     任务被重新排期后标记自然失效（标记值 = 打标时的 scheduled_at）。
  listDuePlanTasks(nowIso, opts) {
    const now = String(nowIso || new Date().toISOString());
    const forReal = !!(opts && opts.forRealExecutor);
    const canCheckHold = typeof this.isPlanTaskHeld === 'function';
    return this.listPlanTasks('')
      .filter(t => t.status === 'pending'
        && String(t.scheduled_at || '')
        && String(t.scheduled_at) <= now
        && (forReal || !t.real_only)
        // 逾期暂停（模拟路径）：等待用户处理，不被模拟执行器消费
        && (t.real_only || !(canCheckHold && this.isPlanTaskHeld(t.id, t.scheduled_at))))
      .sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
  }

  // 领取一个待执行任务：pending → running
  //   只有当前状态仍是 pending 的任务能被领取（条件更新 = 重复领取保护）。
  //   返回 run_token（本次领取写入的 started_at），落库时用它做乐观校验。
  claimPlanTask(taskId, nowIso) {
    const id = String(taskId || '');
    if (!id) return { ok: false, error: 'missing task id' };
    const now = String(nowIso || new Date().toISOString());
    if (this.mode === 'sqlite') {
      const res = this.run(
        "UPDATE plan_tasks SET status='running', started_at=?, updated_at=? WHERE id=? AND status='pending'",
        [now, now, id]
      );
      const changes = res && typeof res.changes === 'number' ? res.changes : 0;
      if (!changes) return { ok: false, error: 'task is not claimable', id: id };
    } else {
      const list = Array.isArray(this.data.plan_tasks) ? this.data.plan_tasks : [];
      const t = list.filter(x => x && String(x.id) === id)[0];
      if (!t || String(t.status || 'pending') !== 'pending') {
        return { ok: false, error: 'task is not claimable', id: id };
      }
      t.status = 'running';
      t.started_at = now;
      t.updated_at = now;
      this.saveJson();
    }
    const task = this.listPlanTasks('').filter(t => t.id === id)[0];
    if (!task || task.status !== 'running') return { ok: false, error: 'task is not claimable', id: id };
    return { ok: true, task: task, run_token: now };
  }

  // 落库执行结果：running → done / failed / draft_pending
  //   - 必须仍是 running 且 run_token 一致，否则视为过期结果，丢弃（不覆盖新状态）
  //   - 不写任何真实平台 ID / URL（真实接入留到第三阶段的平台适配器）
  finishPlanTask(taskId, runToken, result) {
    const id = String(taskId || '');
    const token = String(runToken || '');
    if (!id) return { ok: false, error: 'missing task id' };
    const cur = this.listPlanTasks('').filter(t => t.id === id)[0];
    if (!cur) return { ok: false, error: 'task not found', id: id };
    if (cur.status !== 'running') return { ok: false, error: 'task is not running: ' + cur.status, id: id };
    if (token && String(cur.started_at || '') !== token) {
      return { ok: false, error: 'stale run token', id: id };
    }
    const res = result || {};
    const failed = res.ok === false;
    const now = new Date().toISOString();
    const next = Object.assign({}, cur, {
      status: failed ? 'failed' : String(res.status || 'done'),
      finished_at: now,
      error: failed ? String(res.error || '执行失败') : String(res.error || ''),
      platform_ref: failed ? String(cur.platform_ref || '') : String(res.platform_ref || ''),
      platform_url: failed ? String(cur.platform_url || '') : String(res.platform_url || ''),
      note: res.note !== undefined ? String(res.note || '') : String(cur.note || ''),
      // 模拟标识：执行器必须明确声明这次结果是不是模拟产生的。
      //   未声明时**沿用原值**（不擅自把历史任务改成真实或模拟）。
      simulated: res.simulated === undefined ? (cur.simulated || 0) : (res.simulated ? 1 : 0),
      // 「等待真实执行」标记：
      //   - 真实执行完成 → 清除（任务已经真的做完了，不再等待）；
      //   - 模拟执行 → 保留（万一被模拟执行器碰到，也不能丢掉"等待真实执行"的语义）。
      real_only: res.simulated ? (cur.real_only || 0) : 0,
      updated_at: now
    });
    this._planWriteTask(next);
    if (this.mode !== 'sqlite') this.saveJson();
    return { ok: true, task: this.listPlanTasks('').filter(t => t.id === id)[0] };
  }

  // 重启恢复：上次退出时遗留的 running 任务
  //   两条路径必须分开处理（真实执行与模拟执行的结论完全不同）：
  //   1) 模拟执行遗留（real_only=0）：模拟执行器没有任何外部副作用（不写真实平台、不发网络请求），
  //      因此重新执行是安全的；而"假定成功"会伪造出从未发生的发布结果。
  //      → running → pending，并留下明确的恢复说明，绝不直接标记为 done（保留调度器正常恢复能力）。
  //   2) 真实执行遗留（real_only=1）：上次是在**真实发布**途中进程退出，
  //      结果未知（平台可能已经收到内容）→ 绝不能自动重新发送 → 转 needs_review 等人工核实。
  //      若已有"确认成功"的发布记录（同 pub_key 严格匹配），说明确实已经发布成功，
  //      保持 pending 让紧随其后的对账（reconcilePlanTasks）把它推进为 done。
  recoverStuckPlanTasks(nowIso) {
    const now = String(nowIso || new Date().toISOString());
    const stuck = this.listPlanTasks('').filter(t => t.status === 'running');
    let n = 0;
    let review = 0;
    stuck.forEach(t => {
      const realRun = !!t.real_only;
      const confirmed = (realRun && typeof this._planFindConfirmedPub === 'function')
        ? this._planFindConfirmedPub(t)
        : null;
      if (realRun && !confirmed) {
        this._planWriteTask(Object.assign({}, t, {
          status: 'needs_review',
          started_at: '',
          real_only: 0,
          note: '重启恢复：上次真实发布未保存结果，无法确认平台是否已收到内容，请先人工核实（系统不会自动重发）',
          updated_at: now
        }));
        n++;
        review++;
        return;
      }
      this._planWriteTask(Object.assign({}, t, {
        status: 'pending',
        started_at: '',
        note: '重启恢复：上次执行未保存结果，已重新排队',
        updated_at: now
      }));
      n++;
    });
    if (this.mode !== 'sqlite') this.saveJson();
    return { ok: true, recovered: n, needs_review: review };
  }

  // 把「平台返回的真实标识」写进任务行（发布记录写入之后、任务结算之前）。
  //   作用：GitHub Release 已创建、成功发布记录也已落库，但进程在 finishPlanTask() 之前崩溃时，
  //        任务行里仍然留有真实的 Release ID / URL，恢复对账（reconcilePlanTasks）才能取回。
  //   保护：只允许 running / pending 的任务被写入；
  //        绝不覆盖已取消 / 已完成 / 待核实的任务（条件更新 + 状态白名单）。
  markPlanTaskReleaseInfo(workId, taskId, info) {
    const owner = String(workId || '');
    const id = String(taskId || '');
    if (!owner || !id) return { ok: false, error: 'missing work id or task id' };
    info = info || {};
    const cur = this.listPlanTasks(owner).filter(t => t.id === id)[0];
    if (!cur) return { ok: false, error: 'task not found for work' };
    if (cur.status !== 'running' && cur.status !== 'pending') {
      return { ok: false, error: 'task status not writable: ' + cur.status };
    }
    const now = new Date().toISOString();
    const platformRef = info.platform_ref !== undefined ? String(info.platform_ref || '') : String(cur.platform_ref || '');
    const platformUrl = info.platform_url !== undefined ? String(info.platform_url || '') : String(cur.platform_url || '');
    if (this.mode === 'sqlite') {
      const res = this.run(
        'UPDATE plan_tasks SET platform_ref=?, platform_url=?, updated_at=? WHERE id=? AND work_id=? AND status IN (?,?)',
        [platformRef, platformUrl, now, id, owner, 'running', 'pending']
      );
      const changes = res && typeof res.changes === 'number' ? res.changes : 0;
      if (!changes) return { ok: false, error: 'task status changed' };
    } else {
      const list = Array.isArray(this.data.plan_tasks) ? this.data.plan_tasks : [];
      const t = list.filter(x => x && String(x.id) === id && String(x.work_id || '') === owner)[0];
      if (!t || (t.status !== 'running' && t.status !== 'pending')) {
        return { ok: false, error: 'task status changed' };
      }
      t.platform_ref = platformRef;
      t.platform_url = platformUrl;
      t.updated_at = now;
      this.saveJson();
    }
    return { ok: true, platform_ref: platformRef, platform_url: platformUrl };
  }

  // 找与该任务**严格对应**的"已确认成功"发布记录。
  //   必须同时满足：同一 pub_key + 同一 work_id + 同一 platform_id + 状态为 'ok'/'manual'。
  //   pending / failed 记录**不算**成功（不能据此推断发布成功）。
  _planFindConfirmedPub(task) {
    const key = String((task && task.pub_key) || '');
    const owner = String((task && task.work_id) || '');
    const pid = String((task && task.platform_id) || '');
    if (!key || !owner || !pid) return null;
    let pubs = [];
    if (this.mode === 'sqlite') {
      pubs = this.all('SELECT * FROM pubs WHERE pub_key = ?', [key]);
    } else {
      pubs = (this.data.pubs || []).filter(function (p) {
        return p && String(p.pub_key || '') === key;
      });
    }
    const hit = pubs.filter(function (p) {
      return p
        && String(p.work_id || '') === owner
        && String(p.platform_id || '') === pid
        && (p.status === 'ok' || p.status === 'manual');
    })[0];
    return hit || null;
  }

  // 发布记录 ↔ 计划任务 对账（**只在恢复阶段调用**）
  //   场景：真实发布已成功、成功发布记录（pubs, status='ok'）也已落库，
  //         但进程在 finishPlanTask() 之前崩溃 → 任务停留在 pending，
  //         之后每轮都被幂等闸门 skip，永远不会自己变成 done。
  //   这里把这类任务安全地推进到 done，并回填真实的 platform_url / platform_ref。
  //
  //   判定条件（全部满足才推进，避免误判）：
  //     1) 任务本身是 pending（不碰 needs_review / failed / cancelled / done / running）
  //     2) 任务不是模拟任务（simulated=0）
  //     3) pubs 存在**同 pub_key + 同 work_id + 同 platform_id** 的记录
  //     4) 该记录状态是 'ok' 或 'manual'（pending / failed 记录不算成功）
  //   平台返回的 ID / URL **只从任务行自身已有的值与发布记录的 url 取**，绝不臆造：
  //   发布记录没有 url 时不回填 URL（保留人工核验路径）。
  reconcilePlanTasks(nowIso) {
    const now = String(nowIso || new Date().toISOString());
    let n = 0;
    this.listPlanTasks('').forEach(t => {
      if (!t || t.status !== 'pending') return;      // 只处理 pending
      if (t.simulated) return;                        // 模拟任务不升级为真实成功
      if (!t.pub_key) return;
      const rec = this._planFindConfirmedPub(t);
      if (!rec) return;
      if (this._planMarkDoneByPub(t, rec, now)) n++;
    });
    return { ok: true, reconciled: n };
  }

  // 对账的落库：条件更新（状态必须仍是 pending），避免覆盖已取消 / 已被重新领取的任务
  _planMarkDoneByPub(task, rec, now) {
    const id = String((task && task.id) || '');
    if (!id) return false;
    const url = String((rec && rec.url) || '');
    const platformRef = String((task && task.platform_ref) || '');   // 只用任务行里已有的真实 ID
    const note = '已根据发布记录确认发布成功（恢复对账）'
      + (url ? '：' + url : '（发布记录未含链接）')
      + (platformRef ? '' : '；本地未记录平台返回 ID');
    if (this.mode === 'sqlite') {
      const res = this.run(
        "UPDATE plan_tasks SET status='done', finished_at=?, platform_ref=?, platform_url=?, note=?, real_only=0, updated_at=? WHERE id=? AND status='pending'",
        [now, platformRef, url, note, now, id]
      );
      const changes = res && typeof res.changes === 'number' ? res.changes : 0;
      return changes > 0;
    }
    const list = Array.isArray(this.data.plan_tasks) ? this.data.plan_tasks : [];
    const t = list.filter(x => x && String(x.id) === id)[0];
    if (!t || t.status !== 'pending') return false;
    t.status = 'done';
    t.finished_at = now;
    t.platform_ref = platformRef;
    t.platform_url = url;
    t.note = note;
    t.real_only = 0;
    t.updated_at = now;
    this.saveJson();
    return true;
  }

  // 把一条「模拟完成」的任务重新排队 → 进入**等待真实执行**状态。
  //   严格边界：
  //   - **只允许操作 simulated=1 的任务**：真实任务（simulated=0）永远不会被这里重置，
  //     因此不会把未来的真实成功任务误降级成待执行；
  //   - 校验 work_id 归属；stage_id / platform_id 传入时必须与任务本身一致
  //     （禁止跨作品、跨阶段、跨平台改写）；
  //   - 状态只允许 done / failed / draft_pending（pending 本来就在队列里；cancelled 保持已取消）；
  //   - 重排后：status='pending' + **real_only=1**（模拟调度器不会领取它），
  //     simulated=0（它已不是模拟结果，等待真实执行器接手）；
  //   - 原模拟结果归档到 **history_note**（不会被后续执行结果覆盖），
  //     mock 的 platform_ref / platform_url 一并清掉（避免被当成真实平台标识）。
  requeueSimulatedPlanTask(workId, taskId, opts) {
    const owner = String(workId || '');
    const id = String(taskId || '');
    if (!owner || !id) return { ok: false, error: 'missing work id or task id' };
    opts = opts || {};
    const cur = this.listPlanTasks(owner).filter(t => t.id === id)[0];
    if (!cur) return { ok: false, error: 'task not found for work' };
    if (!cur.simulated) return { ok: false, error: '只有模拟任务可以重新排队（真实任务不受影响）' };
    if (cur.status !== 'done' && cur.status !== 'failed' && cur.status !== 'draft_pending') {
      return { ok: false, error: '当前状态不需要重新排队：' + cur.status };
    }
    // 阶段 / 平台归属校验（传入时必须与任务本身一致）
    if (opts.stage_id !== undefined && opts.stage_id !== null && String(opts.stage_id) !== String(cur.stage_id)) {
      return { ok: false, error: 'task does not belong to this stage' };
    }
    if (opts.platform_id !== undefined && opts.platform_id !== null && String(opts.platform_id) !== String(cur.platform_id)) {
      return { ok: false, error: 'task does not match this platform' };
    }
    const now = new Date().toISOString();
    const archive = [
      'status=' + (cur.status || ''),
      cur.platform_ref ? ('ref=' + cur.platform_ref) : '',
      cur.finished_at ? ('at=' + cur.finished_at) : '',
      cur.note ? ('note=' + cur.note) : ''
    ].filter(Boolean).join(' / ');
    this._planWriteTask(Object.assign({}, cur, {
      status: 'pending',
      started_at: '',
      finished_at: '',
      platform_ref: '',
      platform_url: '',
      error: '',
      note: '由模拟任务重新排队，等待真实执行',
      history_note: ('原模拟结果：' + archive),
      simulated: 0,
      real_only: 1,
      updated_at: now
    }));
    if (this.mode !== 'sqlite') this.saveJson();
    return { ok: true, task: this.listPlanTasks(owner).filter(t => t.id === id)[0] };
  }

  // 内部：按 pub_key 更新/插入一条发布记录（人工处理「待核实」任务时使用）。
  //   与 addPub 的差别只有一处：**允许显式清空 error**。
  //   （addPub 用 `r.error || exist.error`，空串是 falsy → 无法把旧错误清掉；
  //     确认已发布后残留旧错误会与 status='ok' 自相矛盾。）
  //   其余语义与 addPub 一致：同一 pub_key 已存在 → **更新既有行**（绝不新增第二条）；
  //   不存在 → 插入新行。未提供的字段一律保留既有值（不覆盖标题 / 正文等）。
  //
  //   ★ 落库时机：这里**不负责持久化**。
  //     SQLite 分支的 UPDATE / INSERT 本身即时生效，但必须由调用方包在事务里；
  //     JSON 分支只改内存（this.data），**不调用 saveJson** —— 持久化统一由
  //     调用方在两张表都写完之后**一次性**执行（见 _planAtomicWrite），
  //     避免出现「pubs 已落盘、任务还没写」的中间态。
  //   ★ 变更通知：这里**绝对不通知**。本方法是「事务内部的一步」，
  //     通知必须由调用方在 _planAtomicWrite 整体提交成功之后发出
  //     （见 confirmNeedsReviewPublished / requeueNeedsReviewRetry），
  //     否则事务回滚后仍会误报「发布记录已变更」。
  _planPubUpsert(p) {
    p = p || {};
    const key = String(p.pub_key || '');
    if (!key) return { ok: false, error: 'missing pub key' };
    let exist = null;
    try {
      exist = this.mode === 'sqlite'
        ? this.get('SELECT * FROM pubs WHERE pub_key = ? LIMIT 1', [key])
        : (this.data.pubs || []).filter(function (r) { return r && String(r.pub_key) === key; })[0] || null;
    } catch (_e) { exist = null; }

    if (exist) {
      // 只覆盖本次明确给出的字段；title / body / tags 等一律保留既有值
      const set = (field, value) => {
        if (value === undefined) return;
        exist[field] = value;
      };
      set('status', p.status);
      set('url', p.url);
      set('video_id', p.video_id);
      set('time', p.time);
      set('error', p.error);
      set('work_id', p.work_id);
      set('platform', p.platform);
      set('platform_id', p.platform_id);
      if (this.mode === 'sqlite') {
        this.run(
          'UPDATE pubs SET work_id=?, platform=?, platform_id=?, status=?, url=?, error=?, video_id=?, time=? WHERE pub_key=?',
          [exist.work_id || '', exist.platform || '', exist.platform_id || '',
            exist.status || 'unknown', exist.url || '', exist.error || '',
            exist.video_id || '', exist.time || '', key]
        );
      }
      // JSON 分支：只改内存（exist 已是 this.data.pubs 里的同一对象），不落盘
      return { ok: true, created: false, row: exist };
    }

    const row = {
      work_id: p.work_id || '', platform: p.platform || '',
      title: p.title || '', body: p.body || '', tags: p.tags || '',
      time: p.time || '', platform_id: p.platform_id || '',
      status: p.status || 'unknown',
      url: p.url || '', error: p.error || '', video_id: p.video_id || '',
      pub_key: key,
      created_at: new Date().toISOString()
    };
    if (this.mode === 'sqlite') {
      try {
        this.run(
          'INSERT INTO pubs (work_id, platform, title, body, tags, time, platform_id, status, url, error, video_id, pub_key, created_at)'
          + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [row.work_id, row.platform, row.title, row.body, row.tags, row.time,
            row.platform_id, row.status, row.url, row.error, row.video_id, row.pub_key, row.created_at]
        );
      } catch (e) {
        // 并发重复提交同一 pub_key → 唯一索引报冲突。
        //   首秀计划的幂等语义是"同一 pub_key → 同一条记录"，
        //   因此这里重新读取同键记录并按已存在处理（**绝不**让计划执行失败）。
        if (!isUniqueViolationError(e)) throw e;
        const same = this.get('SELECT * FROM pubs WHERE pub_key = ? LIMIT 1', [key]);
        if (!same) throw e;
        return { ok: true, created: false, row: same };
      }
    } else {
      if (!Array.isArray(this.data.pubs)) this.data.pubs = [];
      this.data.pubs.push(row);
      // JSON 分支：只改内存，不落盘（由调用方一次性持久化）
    }
    return { ok: true, created: true, row: row };
  }

  // ---------- 「待核实」任务的人工处理（YouTube 首秀计划） ----------
  //
  // 背景：真实发布途中进程退出 / 网络中断 / 未拿到 videoId 时，任务会停在
  //   status='needs_review'（结果未知，系统不自动重发）。
  //   这两条方法让用户人工核实后**显式**决定后续走向，绝不自动判断视频是否存在。
  //
  // 共同安全边界：
  //   - 只处理 status='needs_review'；其它状态一律拒绝（防重复处理 / 防越权改写）；
  //   - 只处理 platform_id='youtube'（本批范围仅限 YouTube 首秀计划）；
  //   - 归属校验：work_id / stage_id / platform_id 必须与任务本身一致；
  //   - 落库用**条件更新**（WHERE status='needs_review'）→ 并发重复点击只有一次生效；
  //   - 任何一步失败都**保留原 needs_review 状态**并返回原因（绝不半途改成别的状态）。

  // A. 人工确认「已发布」：任务 needs_review → done，并补全发布记录。
  //   info: { platform_ref: 视频 ID, platform_url: 视频链接 }
  //   发布记录处理：按同一 pub_key **复用既有记录**（upsert），绝不新建第二条。
  confirmNeedsReviewPublished(workId, taskId, info) {
    const owner = String(workId || '');
    const id = String(taskId || '');
    if (!owner || !id) return { ok: false, error: 'missing work id or task id' };
    info = info || {};
    const cur = this.listPlanTasks(owner).filter(t => t.id === id)[0];
    if (!cur) return { ok: false, error: 'task not found for work' };
    if (String(cur.status) !== 'needs_review') {
      return { ok: false, error: '只有「待核实」的任务才能人工确认发布结果（当前状态：' + cur.status + '）' };
    }
    if (String(cur.platform_id) !== 'youtube') {
      return { ok: false, error: '该人工处理入口仅适用于 YouTube 计划任务' };
    }
    if (info.stage_id !== undefined && info.stage_id !== null && String(info.stage_id) !== String(cur.stage_id)) {
      return { ok: false, error: 'task does not belong to this stage' };
    }
    const platformRef = String(info.platform_ref || '').trim();
    const platformUrl = String(info.platform_url || '').trim();
    if (!platformRef) return { ok: false, error: '缺少 YouTube 视频 ID' };
    if (!platformUrl) return { ok: false, error: '缺少 YouTube 视频链接' };

    const now = new Date().toISOString();
    // ★ 两张表（pubs / plan_tasks）在**同一个可回滚单元**里写入：
    //   任一步失败 → 两张表一起回到操作前状态，
    //   绝不留下「pubs=ok 但 plan_tasks=needs_review」这种半成功记录。
    let pubCreated = false;
    try {
      this._planAtomicWrite(() => {
        // 1) 写发布记录（upsert 同一 pub_key → 复用既有 pending 行，不新增）
        //    失败必须抛异常 → 触发回滚（不能只返回错误，否则任务行会被单独改写）
        let rec = null;
        try {
          rec = this._planPubUpsert({
            work_id: owner,
            platform: 'YouTube',
            platform_id: 'youtube',
            status: 'ok',
            time: now,
            url: platformUrl,
            error: '',            // 显式清空旧错误（确认已发布后不应残留失败原因）
            video_id: platformRef,
            pub_key: String(cur.pub_key || '')
          });
        } catch (ex) {
          // 存储层抛错 → 统一成既有错误码（pubs-write-failed）后再抛 → 触发回滚
          const e = new Error(String((ex && ex.message) || ex));
          e.code = 'pubs-write-failed';
          throw e;
        }
        if (!rec || rec.ok !== true) {
          const e = new Error(String((rec && rec.error) || '发布记录未真正落库'));
          // 保留既有错误码（pubs-write-failed），兼容既有调用方与测试
          e.code = 'pubs-write-failed';
          throw e;
        }
        pubCreated = !!(rec && rec.created);

        // 2) 条件更新任务行：只有仍是 needs_review 才会被改写（防重复处理）
        //    changes=0 → 抛异常 → 连带回滚第 1 步的发布记录写入
        if (this.mode === 'sqlite') {
          const res = this.run(
            "UPDATE plan_tasks SET status='done', finished_at=?, platform_ref=?, platform_url=?, error='', note=?, real_only=0, updated_at=? WHERE id=? AND work_id=? AND status='needs_review'",
            [now, platformRef, platformUrl,
              '用户人工核实：YouTube 视频已发布（' + platformUrl + '）',
              now, id, owner]
          );
          const changes = res && typeof res.changes === 'number' ? res.changes : 0;
          if (!changes) {
            const e = new Error('任务状态已被其它操作改变，未做修改');
            // 保留既有错误码（task status changed），兼容既有调用方与测试
            e.code = 'task status changed';
            throw e;
          }
        } else {
          const list = Array.isArray(this.data.plan_tasks) ? this.data.plan_tasks : [];
          const t = list.filter(x => x && String(x.id) === id && String(x.work_id || '') === owner)[0];
          if (!t || t.status !== 'needs_review') {
            const e = new Error('任务状态已被其它操作改变，未做修改');
            e.code = 'task status changed';
            throw e;
          }
          t.status = 'done';
          t.finished_at = now;
          t.platform_ref = platformRef;
          t.platform_url = platformUrl;
          t.error = '';
          t.note = '用户人工核实：YouTube 视频已发布（' + platformUrl + '）';
          t.real_only = 0;
          t.updated_at = now;
        }
      });
    } catch (e) {
      // 事务已回滚 / JSON 内存已还原 → 两张表都保持操作前状态
      return {
        ok: false,
        error: String((e && e.code) || 'PUBLISH_CONFIRM_FAILED'),
        detail: String((e && e.message) || e),
        task: this.listPlanTasks(owner).filter(t => t.id === id)[0] || cur
      };
    }
    // ★ 事务/原子写入已整体提交成功（失败路径在上面就 return 了）→ 此时才通知。
    //   _planPubUpsert() 本身不通知：它在事务内部，单独通知会在回滚后误报。
    notifyPubsChanged();
    return {
      ok: true,
      task: this.listPlanTasks(owner).filter(t => t.id === id)[0],
      platform_ref: platformRef,
      platform_url: platformUrl,
      pub_created: pubCreated
    };
  }

  // B. 人工确认「未发布，允许重试」：任务 needs_review → pending（等待真实执行）。
  //   - 只重置**本次不确定上传**的临时执行状态（started_at / finished_at /
  //     platform_ref / platform_url / error），原状态归档进 history_note；
  //   - scheduled_at 保持不变（仍由计划时间决定何时执行）；
  //   - real_only=1：回到「等待真实执行」，由调度器按既有安全检查接手；
  //   - **不调用任何上传函数**，不绕过调度器（由 scheduler.scanOnce 正常领取）。
  //   - 发布记录：把本任务那条「结果不确定」的 pending 记录改为 failed
  //     （= 用户确认确实没发出去），否则 checkPlanPublishGuard 无法证明
  //     「没有成功发布」，任务将无法重新执行。
  requeueNeedsReviewRetry(workId, taskId, opts) {
    const owner = String(workId || '');
    const id = String(taskId || '');
    if (!owner || !id) return { ok: false, error: 'missing work id or task id' };
    opts = opts || {};
    const cur = this.listPlanTasks(owner).filter(t => t.id === id)[0];
    if (!cur) return { ok: false, error: 'task not found for work' };
    if (String(cur.status) !== 'needs_review') {
      return { ok: false, error: '只有「待核实」的任务才能重新排队（当前状态：' + cur.status + '）' };
    }
    if (String(cur.platform_id) !== 'youtube') {
      return { ok: false, error: '该人工处理入口仅适用于 YouTube 计划任务' };
    }
    if (opts.stage_id !== undefined && opts.stage_id !== null && String(opts.stage_id) !== String(cur.stage_id)) {
      return { ok: false, error: 'task does not belong to this stage' };
    }
    if (opts.platform_id !== undefined && opts.platform_id !== null && String(opts.platform_id) !== String(cur.platform_id)) {
      return { ok: false, error: 'task does not match this platform' };
    }
    const now = new Date().toISOString();
    const archive = [
      'status=' + (cur.status || ''),
      cur.platform_ref ? ('ref=' + cur.platform_ref) : '',
      cur.finished_at ? ('at=' + cur.finished_at) : '',
      cur.error ? ('error=' + cur.error) : '',
      cur.note ? ('note=' + cur.note) : ''
    ].filter(Boolean).join(' / ');

    // ★ 两张表（plan_tasks / pubs）在**同一个可回滚单元**里写入。
    //   任一步失败 → 两张表一起回到操作前状态。
    //   尤其重要：绝不能留下「任务已 pending 但发布记录仍是 pending」的组合 ——
    //   那种组合下幂等闸门既没有 ok 也没有 failed 记录，会返回 'allow' 放行重传，
    //   有产生重复公开视频的实际风险。
    let pubUpdated = false;
    try {
      this._planAtomicWrite(() => {
        // 1) 条件更新任务行：只有仍是 needs_review 才会被改写（防连续点击造成重复处理）
        //    changes=0 → 抛异常 → 整体回滚
        if (this.mode === 'sqlite') {
          const res = this.run(
            "UPDATE plan_tasks SET status='pending', started_at='', finished_at='', platform_ref='', platform_url='', error='', note=?, history_note=?, real_only=1, updated_at=? WHERE id=? AND work_id=? AND status='needs_review'",
            ['用户确认未发布，重新排队等待真实执行',
              '原待核实结果：' + archive,
              now, id, owner]
          );
          const changes = res && typeof res.changes === 'number' ? res.changes : 0;
          if (!changes) {
            const e = new Error('任务状态已被其它操作改变，未做修改');
            // 保留既有错误码（task status changed），兼容既有调用方与测试
            e.code = 'task status changed';
            throw e;
          }
        } else {
          const list = Array.isArray(this.data.plan_tasks) ? this.data.plan_tasks : [];
          const t = list.filter(x => x && String(x.id) === id && String(x.work_id || '') === owner)[0];
          if (!t || t.status !== 'needs_review') {
            const e = new Error('任务状态已被其它操作改变，未做修改');
            e.code = 'task status changed';
            throw e;
          }
          t.status = 'pending';
          t.started_at = '';
          t.finished_at = '';
          t.platform_ref = '';
          t.platform_url = '';
          t.error = '';
          t.note = '用户确认未发布，重新排队等待真实执行';
          t.history_note = '原待核实结果：' + archive;
          t.real_only = 1;
          t.updated_at = now;
        }

        // 2) 发布记录：把本任务那条「结果不确定」的记录改为 failed
        //   （用户已确认确实没有发出去；不改的话幂等闸门无法放行重新执行）。
        //   仍按同一 pub_key upsert → 复用既有行，不新增第二条。
        //   ★ 失败必须抛异常 → 连同第 1 步的任务状态一起回滚。
        //     （旧实现只把错误吞掉并返回 ok:true，会留下危险的 pending/pending 组合）
        if (cur.pub_key) {
          let rec = null;
          try {
            rec = this._planPubUpsert({
              work_id: owner,
              platform: 'YouTube',
              platform_id: 'youtube',
              status: 'failed',
              url: '',
              error: '用户核实：本次上传未在 YouTube 发布',
              video_id: '',
              pub_key: String(cur.pub_key || '')
            });
          } catch (ex) {
            // 存储层抛错 → 统一成既有错误码后再抛 → 连同任务状态一起回滚
            const e = new Error(String((ex && ex.message) || ex));
            e.code = 'pubs-write-failed';
            throw e;
          }
          if (!rec || rec.ok !== true) {
            const e = new Error(String((rec && rec.error) || '发布记录未真正落库'));
            // 保留既有错误码（pubs-write-failed），兼容既有调用方与测试
            e.code = 'pubs-write-failed';
            throw e;
          }
          pubUpdated = true;
        }
      });
    } catch (e) {
      // 事务已回滚 / JSON 内存已还原 → 任务仍是 needs_review，发布记录仍是原来的 pending
      return {
        ok: false,
        error: String((e && e.code) || 'RETRY_REQUEUE_FAILED'),
        detail: String((e && e.message) || e),
        task: this.listPlanTasks(owner).filter(t => t.id === id)[0] || cur
      };
    }

    // ★ 事务/原子写入已整体提交成功（失败路径在上面就 return 了）→ 此时才通知。
    //   只有真的改写了发布记录（pub_updated）才通知；任务重排但没动发布记录时不打扰 renderer。
    if (pubUpdated) notifyPubsChanged();
    return {
      ok: true,
      task: this.listPlanTasks(owner).filter(t => t.id === id)[0],
      pub_updated: pubUpdated,
      scheduled_at: String(cur.scheduled_at || '')
    };
  }

  // 发布前的幂等安全检查（只读；供未来的真实平台执行器使用，本次不接任何真实接口）
  //   decision：
  //     'allow'   —— 明确没有成功发布记录 → 允许执行
  //     'skip'    —— 精确匹配到确认成功的发布记录 → **不得再次发布**
  //     'review'  —— 只能模糊匹配（同作品同平台有成功记录但幂等键不同）→ 必须人工确认
  //     'unclear' —— 结果不确定（模拟任务 / 执行中残留 / 已完成但无可核实记录 / 已确认失败并终止）→ 不得盲目重试
  //   判定只依据 pubs 表里的**发布记录**；
  //   绝不依据 platform_ref 非空或 status='done' 就认定真实发布成功。
  //   人工「标记已发布」(manual) 记录的特殊规则（用户允许先手动标记、后建计划）：
  //     - 幂等键与当前任务精确匹配 → skip（确定同一条内容已发布）
  //     - 带平台 URL / 平台发布 ID → review（可能是同一内容的重复发布风险）
  //     - 无 URL、无平台发布 ID，且无法精确关联当前任务 → 不单独阻断
  //       （它只是人工确认，不代表计划任务已执行）
  checkPlanPublishGuard(workId, taskId) {
    const owner = String(workId || '');
    const id = String(taskId || '');
    if (!owner || !id) return { decision: 'unclear', reason: '缺少作品 ID 或任务 ID' };
    const cur = this.listPlanTasks(owner).filter(t => t.id === id)[0];
    if (!cur) return { decision: 'unclear', reason: '任务不存在或不属于该作品' };
    if (cur.simulated) return { decision: 'unclear', reason: '模拟任务：不得进入真实发布路径，需先显式重新排队' };
    if (cur.status === 'running') return { decision: 'unclear', reason: '任务处于执行中，结果不确定' };
    // 已确认失败 = **终止状态**：不自动重试、不自动重新入队、不再自动发送。
    //   修复登录 / 授权 / 平台配置后由用户手动发送，或重新创建计划。
    if (cur.status === 'failed') {
      return {
        decision: 'unclear',
        reason: '该任务已确认发送失败并终止：系统不会自动重试或重新入队；请修复登录 / 授权 / 平台配置后手动发送，或重新创建计划',
        matched: { failed_task: true, error: String(cur.error || '') }
      };
    }

    let pubs = [];
    if (this.mode === 'sqlite') {
      pubs = this.all('SELECT * FROM pubs WHERE work_id = ? AND platform_id = ?', [owner, cur.platform_id]);
    } else {
      pubs = (this.data.pubs || []).filter(function (p) {
        return p && String(p.work_id || '') === owner
          && String(p.platform_id || '') === String(cur.platform_id || '');
      });
    }
    // 成功类记录分两种，语义不同：
    //   - 'ok'     ：平台 / 发布回调确认成功 → 视为真实成功，保留防重复保护
    //   - 'manual' ：用户手动「标记已发布」 → 只是一条人工确认，
    //                **不代表首秀计划中的自动发布任务已经执行成功**（用户可以先标记、后建计划）
    // 判定顺序：
    //   1) 幂等键与当前任务精确匹配（ok / manual 都算）→ skip（确定发布过）
    //   2) 存在可归因的成功证据（ok 记录；或带 url / 平台发布 ID 的 manual 记录）→ review
    //   3) 剩余 manual（无 url、无平台发布 ID，且无法精确关联当前任务）→ 不单独阻断
    const okRows = pubs.filter(function (p) { return p && p.status === 'ok'; });
    const manualRows = pubs.filter(function (p) { return p && p.status === 'manual'; });
    const exact = cur.pub_key
      ? okRows.concat(manualRows).filter(function (p) { return String(p.pub_key || '') === String(cur.pub_key); })[0]
      : null;
    if (exact) {
      return {
        decision: 'skip',
        reason: '已存在确认成功的发布记录（幂等键精确命中），不得再次发布',
        matched: { id: exact.id || '', url: exact.url || '', time: exact.time || '' }
      };
    }
    const attributable = okRows.concat(manualRows.filter(function (p) {
      // 人工记录只有带平台链接 / 平台发布 ID 时，才构成"可能已发布同一内容"的证据
      return !!String(p.url || '').trim() || !!String(p.video_id || '').trim();
    }));
    if (attributable.length) {
      return {
        decision: 'review',
        reason: '该作品该平台存在成功发布记录，但无法确定对应的是哪条任务，需人工确认后再决定',
        matched: { count: attributable.length }
      };
    }
    const failedRows = pubs.filter(function (p) { return p && p.status === 'failed'; });
    if (failedRows.length) {
      // 之前明确失败过 → 可确认"没有成功发布" → 允许重新执行
      return { decision: 'allow', reason: '此前发布明确失败，可重新执行', matched: { failed_count: failedRows.length } };
    }
    if (cur.status === 'done') {
      // 标记完成但找不到任何可核实的发布记录 → 结果不确定，不允许直接重发
      return { decision: 'unclear', reason: '任务标记为已完成，但没有可核实的发布记录，需人工确认' };
    }
    return { decision: 'allow', reason: '没有该作品该平台的发布记录' };
  }

  // 作品 ID 变更（新建作品落定 / 草稿转正）：把计划与任务改挂到新作品
  //
  // ★ 草稿转正时必须重算执行时间：
  //   草稿归属（works 表里没有这一行）下保存计划时，savePlanStages 查不到作品 created_at，
  //   _planScheduledAt 只能用「保存时刻」当基准，于是 scheduled_at 落在错误的基准上
  //   （与真实作品的创建日无关）。转正为真实作品后按真实作品的 created_at 重新计算：
  //     scheduled_at = 真实作品创建日（本地日历日）+ offset_days 天 + 本地时刻 time_of_day
  //   换算规则与保存计划时完全一致（同一个 _planScheduledAt），**不是**从转正时刻重新计时；
  //   原有的天数偏移与指定时刻保持不变。
  //
  //   安全边界：
  //     - 只重算 status='pending'（尚未执行）的任务；
  //       已完成 / 已失败 / 草稿待发布 / 已取消 / 执行中 / 待人工核实的任务：
  //       时间与状态一律不动（不改写历史结论、不复活待核实任务）。
  //     - 还原不出原始时间设置时（阶段配置缺失 / 天数偏移非法 / 指定时刻非法 /
  //       真实作品没有有效 created_at）：**保留原值并记录原因**，绝不猜测、绝不覆盖。
  //     - 只写 scheduled_at / note 两个字段：状态、幂等键、真实发布标识、模拟标识一律不碰，
  //       幂等闸门、失败终止、人工核实规则原样保留（转正本身不触发任何发布）。
  reassignPlanOwner(fromOwner, toOwner) {
    const from = String(fromOwner || '');
    const to = String(toOwner || '');
    if (!from || !to || from === to) return { ok: false, error: 'invalid owner' };
    const now = new Date().toISOString();

    // 转正前的现场快照：任务清单 + 阶段原始配置 + 两侧的作品信息
    //   （阶段原始配置必须在改归属之前取：改完之后阶段就挂在新作品名下了）
    const fromTasks = this.listPlanTasks(from);
    const stageRows = this._planRawStages(from);
    const fromWork = this._planWorkRow(from);
    const toWork = this._planWorkRow(to);

    // 只有「草稿归属（works 表里查不到这一行）」才重算时间：
    //   草稿归属下保存计划时用的是「保存时刻」当基准，转正后必须换成真实作品的 created_at。
    //   真实作品之间改挂（例如作品 ID 变更）不在本次范围内，执行时间保持不变，不擅自改动。
    //   目标归属不是真实作品时没有可靠基准 → 逐条保留原值并记录原因（不猜测、不覆盖）。
    const recalc = !fromWork;
    const plan = recalc
      ? this._planReschedulePlan(fromTasks, stageRows, toWork)
      : { updates: [], kept: [] };

    this._tx(() => {
      if (this.mode === 'sqlite') {
        this.run('UPDATE plan_stages SET work_id=?, updated_at=? WHERE work_id=?', [to, now, from]);
        this.run('UPDATE plan_tasks SET work_id=?, updated_at=? WHERE work_id=?', [to, now, from]);
      } else {
        (this.data.plan_stages || []).forEach(s => { if (s && String(s.work_id) === from) { s.work_id = to; s.updated_at = now; } });
        (this.data.plan_tasks || []).forEach(t => { if (t && String(t.work_id) === from) { t.work_id = to; t.updated_at = now; } });
      }
      // 时间重算与归属变更同事务提交（避免出现「归属改了但时间没改」的中间态）
      plan.updates.forEach(u => this._planWriteSchedule(u.id, u.scheduled_at, u.note, to));
    });
    if (this.mode !== 'sqlite') this.saveJson();
    return {
      ok: true,
      stages: this.listPlanStages(to),
      tasks: this.listPlanTasks(to),
      rescheduled: plan.updates.filter(u => u.applied).map(u => u.id),
      reschedule_kept: plan.kept
    };
  }

  // 读取作品的原始行（不存在时返回 null）
  //   用来判断某个归属是不是真实作品，以及取真实作品的 created_at。
  _planWorkRow(workId) {
    const id = String(workId || '');
    if (!id) return null;
    if (this.mode === 'sqlite') {
      const w = this.get('SELECT id, created_at FROM works WHERE id = ?', [id]);
      return w || null;
    }
    const w = (this.data.works || []).filter(x => x && String(x.id) === id)[0];
    return w || null;
  }

  // 读取某归属下的阶段原始行（保留 offset_days / time_of_day 原值，不做归一化）
  //   归一化后的值（缺省 20:00、offset 归 0）会掩盖「原始设置无效」的情况，
  //   重算前必须看到原值才能判断能否可靠还原。
  _planRawStages(owner) {
    const id = String(owner || '');
    if (!id) return [];
    if (this.mode === 'sqlite') {
      return this.all('SELECT id, work_id, offset_days, time_of_day, scheduled_at FROM plan_stages WHERE work_id = ?', [id]);
    }
    return (this.data.plan_stages || []).filter(s => s && String(s.work_id) === id);
  }

  // 计算「转正后应该是什么执行时间」
  //   只处理尚未执行（pending）的任务；其余状态原样返回（时间与状态都不动）。
  //   返回 updates（含 applied 标记与最终备注），由调用方落库。
  _planReschedulePlan(tasks, stageRows, toWork) {
    const out = { updates: [], kept: [] };
    const createdAt = (toWork && toWork.created_at) ? String(toWork.created_at) : '';
    const baseDate = createdAt ? new Date(createdAt) : null;
    const baseOk = !!baseDate && !isNaN(baseDate.getTime());
    const stageById = {};
    stageRows.forEach(r => { stageById[String(r.id)] = r; });

    // 无法可靠还原时：保留原值 + 在任务备注里写明原因（不猜测、不覆盖）
    const keep = (t, reason) => {
      out.kept.push({ id: t.id, reason: reason });
      const mark = '归属转正后未重算执行时间：' + reason;
      const old = String((t && t.note) || '');
      out.updates.push({ id: t.id, applied: false, scheduled_at: '', note: old ? (old + '；' + mark) : mark });
    };

    (tasks || []).forEach(t => {
      if (!t) return;
      // 只重算尚未执行的任务：已执行结论 / 执行中 / 待人工核实一律不动
      if (String(t.status || '') !== 'pending') return;

      if (!toWork) {
        keep(t, '目标归属不是真实作品，无法还原执行时间基准');
        return;
      }
      const st = stageById[String(t.stage_id || '')];
      if (!st) {
        keep(t, '找不到对应的阶段配置，无法还原原始的天数偏移与指定时刻');
        return;
      }
      // 绝对执行时间（新计划）：转正只改归属，不改用户选择的日期时间
      const abs = String((st && st.scheduled_at) || '').trim();
      if (abs) {
        const absDate = new Date(abs);
        if (!isNaN(absDate.getTime())) {
          out.updates.push({ id: t.id, applied: true, scheduled_at: abs, note: '' });
          return;
        }
      }
      const offRaw = st.offset_days;
      const off = Number(offRaw);
      if (offRaw === null || offRaw === undefined || offRaw === '' || !isFinite(off) || off < 0) {
        keep(t, '阶段的天数偏移设置无效，无法可靠还原原始设置');
        return;
      }
      const todRaw = (st.time_of_day === null || st.time_of_day === undefined) ? '' : String(st.time_of_day).trim();
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(todRaw);
      if (!m) {
        keep(t, '阶段的指定时刻设置无效，无法可靠还原原始设置');
        return;
      }
      if (!baseOk) {
        keep(t, '真实作品没有有效的创建时间，无法还原执行时间基准');
        return;
      }
      // 与 savePlanStages 使用同一条换算规则（本地日历日 + 天数偏移 + 本地时刻）
      const scheduledAt = this._planScheduledAt(createdAt, Math.floor(off), m[1].padStart(2, '0') + ':' + m[2]);
      out.updates.push({ id: t.id, applied: true, scheduled_at: scheduledAt, note: '' });
    });
    return out;
  }

  // 只写「执行时间」与「备注」两个字段
  //   状态、幂等键、真实发布标识、模拟标识一律不碰（保证不会改写历史结论）。
  _planWriteSchedule(taskId, scheduledAt, note, owner) {
    const id = String(taskId || '');
    if (!id) return false;
    const now = new Date().toISOString();
    if (this.mode === 'sqlite') {
      const sets = [];
      const args = [];
      if (scheduledAt) { sets.push('scheduled_at=?'); args.push(scheduledAt); }
      if (note) { sets.push('note=?'); args.push(note); }
      if (!sets.length) return false;
      sets.push('updated_at=?'); args.push(now);
      args.push(id);
      let sql = 'UPDATE plan_tasks SET ' + sets.join(', ') + ' WHERE id=?';
      if (owner) { sql += ' AND work_id=?'; args.push(String(owner)); }
      const res = this.run(sql, args);
      return !!(res && typeof res.changes === 'number' ? res.changes > 0 : true);
    }
    const list = Array.isArray(this.data.plan_tasks) ? this.data.plan_tasks : [];
    const t = list.filter(x => x && String(x.id) === id)[0];
    if (!t) return false;
    if (owner && String(t.work_id || '') !== String(owner)) return false;
    if (scheduledAt) t.scheduled_at = scheduledAt;
    if (note) t.note = String(note);
    t.updated_at = now;
    return true;
  }

  // 清理没有对应作品的计划配置（作品被删除后的孤儿数据）
  //   只删「配置」层；已执行任务历史保留（含已取消 / 已完成），避免伪造历史
  purgeOrphanPlans() {
    const ids = (this.mode === 'sqlite'
      ? this.all('SELECT id FROM works').map(r => String(r.id))
      : (this.data.works || []).map(w => String(w && w.id)));
    const now = new Date().toISOString();
    const stages = this.mode === 'sqlite'
      ? this.all('SELECT * FROM plan_stages')
      : (this.data.plan_stages || []);
    let removed = 0;
    stages.forEach(s => {
      const owner = String(s.work_id || '');
      if (owner && ids.indexOf(owner) >= 0) return;
      // 草稿 owner（draft_ 前缀）不是真实作品 → 一并清掉
      this._planRemoveStage(owner, String(s.id), now);
      removed++;
    });
    if (this.mode !== 'sqlite') this.saveJson();
    return { ok: true, removed: removed };
  }

  // ---------- 推广渠道 ----------
  // 列出所有渠道（按 created_at 升序，让用户后加的显示在下面，UI 可自行重排）
  listChannels() {
    if (this.mode === 'sqlite') {
      return this.all('SELECT * FROM channels ORDER BY created_at ASC');
    }
    return Array.isArray(this.data.channels) ? this.data.channels : [];
  }
  // upsert：缺 id 自动生成；enabled 强制 0/1；空字符串统一存 null 便于搜索
  saveChannel(c) {
    if (!c || !c.name || !c.kind) throw new Error('渠道名称与类型必填');
    const norm = function (v) {
      if (v === undefined || v === null) return null;
      const s = String(v).trim();
      return s ? s : null;
    };
    const now = new Date().toISOString();
    const row = {
      id: c.id || ('ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      name: String(c.name).trim(),
      kind: String(c.kind).trim(),
      enabled: c.enabled === false || c.enabled === 0 || c.enabled === '0' ? 0 : 1,
      api_base: norm(c.api_base),
      api_key: norm(c.api_key),
      webhook: norm(c.webhook),
      tag: norm(c.tag),
      note: norm(c.note),
      created_at: c.created_at || now,
      updated_at: now
    };
    if (this.mode === 'sqlite') {
      this.run(`
        INSERT INTO channels (id, name, kind, enabled, api_base, api_key, webhook, tag, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, kind=excluded.kind, enabled=excluded.enabled,
          api_base=excluded.api_base, api_key=excluded.api_key, webhook=excluded.webhook,
          tag=excluded.tag, note=excluded.note, updated_at=excluded.updated_at
      `, [row.id, row.name, row.kind, row.enabled, row.api_base, row.api_key, row.webhook, row.tag, row.note, row.created_at, row.updated_at]);
    } else {
      // JSON 兜底：找到同 id 则替换，否则追加
      if (!Array.isArray(this.data.channels)) this.data.channels = [];
      const i = this.data.channels.findIndex(function (x) { return x.id === row.id; });
      if (i >= 0) this.data.channels[i] = row; else this.data.channels.push(row);
      this.saveJson();
    }
    return row;
  }
  deleteChannel(id) {
    if (!id) return false;
    if (this.mode === 'sqlite') {
      this.run('DELETE FROM channels WHERE id = ?', [id]);
    } else {
      this.data.channels = (this.data.channels || []).filter(function (c) { return c.id !== id; });
      this.saveJson();
    }
    return true;
  }

  // ---------- 里程碑 ----------
  // type: first_star / first_download / first_review / first_100 ...
  addMilestone(m) {
    const row = {
      id: m.id || ('ms_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      work_id: m.work_id || '',
      type: m.type || '',
      value: Number(m.value) || 0,
      reached_at: m.reached_at || new Date().toISOString(),
      notified: m.notified ? 1 : 0
    };
    if (this.mode === 'sqlite') {
      this.run('INSERT OR IGNORE INTO milestones (id, work_id, type, value, reached_at, notified) VALUES (?, ?, ?, ?, ?, ?)',
        [row.id, row.work_id, row.type, row.value, row.reached_at, row.notified]);
    } else {
      if (!Array.isArray(this.data.milestones)) this.data.milestones = [];
      if (!this.data.milestones.find(function (x) { return x.id === row.id; })) this.data.milestones.push(row);
      this.saveJson();
    }
    return row;
  }
  listMilestones(workId) {
    if (this.mode === 'sqlite') {
      if (workId) return this.all('SELECT * FROM milestones WHERE work_id = ? ORDER BY reached_at DESC', [workId]);
      return this.all('SELECT * FROM milestones ORDER BY reached_at DESC');
    }
    return (this.data.milestones || []).filter(function (m) { return !workId || m.work_id === workId; });
  }
  markMilestoneNotified(id) {
    if (this.mode === 'sqlite') {
      this.run('UPDATE milestones SET notified = 1 WHERE id = ?', [id]);
    } else {
      const i = (this.data.milestones || []).findIndex(function (m) { return m.id === id; });
      if (i >= 0) { this.data.milestones[i].notified = 1; this.saveJson(); }
    }
  }

  // ---------- 反馈原始数据 ----------
  // upsertFeedback：增量写入；同 (source, external_id) 会被忽略
  upsertFeedback(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    let n = 0;
    if (this.mode === 'sqlite') {
      const stmt = this.db.prepare('INSERT OR IGNORE INTO feedback (id, work_id, source, external_id, author, url, content, sentiment, category, priority, cluster_id, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const f of items) {
        const row = {
          id: f.id || ('fb_' + (f.source || '') + '_' + (f.external_id || '') + '_' + Math.random().toString(36).slice(2, 6)),
          work_id: f.work_id || '',
          source: f.source || '',
          external_id: String(f.external_id || ''),
          author: f.author || '',
          url: f.url || '',
          content: (f.content || '').slice(0, 4000),
          sentiment: f.sentiment || '',
          category: f.category || '',
          priority: f.priority || '',
          cluster_id: f.cluster_id || '',
          fetched_at: f.fetched_at || new Date().toISOString()
        };
        try {
          let res = null;
          if (this.driver === 'better-sqlite3') res = stmt.run(row.id, row.work_id, row.source, row.external_id, row.author, row.url, row.content, row.sentiment, row.category, row.priority, row.cluster_id, row.fetched_at);
          else { res = stmt.run([row.id, row.work_id, row.source, row.external_id, row.author, row.url, row.content, row.sentiment, row.category, row.priority, row.cluster_id, row.fetched_at]); }
          // INSERT OR IGNORE 静默跳过重复时 changes 为 0；仅在真正插入时 n++
          if (res && typeof res.changes === 'number') {
            if (res.changes > 0) n++;
          } else {
            n++;
          }
        } catch (_e) { try { stmt.finalize(); } catch (_e2) {} }
      }
      try { stmt.finalize(); } catch (_e) {}
    } else {
      if (!Array.isArray(this.data.feedback)) this.data.feedback = [];
      for (const f of items) {
        const dup = this.data.feedback.find(function (x) { return x.source === (f.source || '') && x.external_id === String(f.external_id || ''); });
        if (dup) continue;
        this.data.feedback.push({
          id: f.id || ('fb_' + (f.source || '') + '_' + (f.external_id || '') + '_' + Math.random().toString(36).slice(2, 6)),
          work_id: f.work_id || '',
          source: f.source || '',
          external_id: String(f.external_id || ''),
          author: f.author || '',
          url: f.url || '',
          content: (f.content || '').slice(0, 4000),
          sentiment: f.sentiment || '',
          category: f.category || '',
          priority: f.priority || '',
          cluster_id: f.cluster_id || '',
          fetched_at: f.fetched_at || new Date().toISOString()
        });
        n++;
      }
      this.saveJson();
    }
    return n;
  }
  listFeedback(workId) {
    if (this.mode === 'sqlite') {
      if (workId) return this.all('SELECT * FROM feedback WHERE work_id = ? ORDER BY fetched_at DESC', [workId]);
      return this.all('SELECT * FROM feedback ORDER BY fetched_at DESC');
    }
    return (this.data.feedback || []).filter(function (f) { return !workId || f.work_id === workId; });
  }

  // ---------- 反馈聚类（AI 写入） ----------
  saveFeedbackClusters(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    if (this.mode === 'sqlite') {
      this.run('DELETE FROM feedback_clusters WHERE work_id = ?', [items[0].work_id || '']);
      for (const c of items) {
        this.run(`INSERT INTO feedback_clusters (id, work_id, title, count, priority, sample_ids, summary, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [c.id, c.work_id, c.title, Number(c.count) || 0, c.priority || 'P2',
           JSON.stringify(c.sample_ids || []), c.summary || '',
           c.created_at || new Date().toISOString()]);
      }
    } else {
      if (!Array.isArray(this.data.feedback_clusters)) this.data.feedback_clusters = [];
      const wid = items[0].work_id || '';
      this.data.feedback_clusters = this.data.feedback_clusters.filter(function (c) { return c.work_id !== wid; });
      for (const c of items) this.data.feedback_clusters.push(c);
      this.saveJson();
    }
    return items.length;
  }
  listFeedbackClusters(workId) {
    if (this.mode === 'sqlite') {
      if (workId) return this.all('SELECT * FROM feedback_clusters WHERE work_id = ? ORDER BY CASE priority WHEN \'P0\' THEN 0 WHEN \'P1\' THEN 1 ELSE 2 END, count DESC', [workId]);
      return this.all('SELECT * FROM feedback_clusters ORDER BY CASE priority WHEN \'P0\' THEN 0 WHEN \'P1\' THEN 1 ELSE 2 END, count DESC');
    }
    return (this.data.feedback_clusters || []).filter(function (c) { return !workId || c.work_id === workId; });
  }

  // ---------- 每日指标 ----------
  bumpMetric(workId, date, platform, fields) {
    if (!workId || !date || !platform) return null;
    const keys = ['views', 'stars', 'comments'];
    if (this.mode === 'sqlite') {
      const existing = this.get('SELECT * FROM metrics_daily WHERE work_id = ? AND date = ? AND platform = ?', [workId, date, platform]);
      if (existing) {
        const updates = keys.map(function (k) {
          return k + ' = ' + (Number(existing[k]) || 0) + (fields && Number(fields[k]) > 0 ? ' + ' + Number(fields[k]) : ' + 0');
        }).join(', ');
        this.run('UPDATE metrics_daily SET ' + updates + ' WHERE work_id = ? AND date = ? AND platform = ?', [workId, date, platform]);
      } else {
        const row = { views: 0, stars: 0, comments: 0 };
        if (fields) keys.forEach(function (k) { row[k] = Number(fields[k]) || 0; });
        this.run('INSERT INTO metrics_daily (work_id, date, platform, views, stars, comments) VALUES (?, ?, ?, ?, ?, ?)',
          [workId, date, platform, row.views, row.stars, row.comments]);
      }
    } else {
      if (!Array.isArray(this.data.metrics_daily)) this.data.metrics_daily = [];
      const idx = this.data.metrics_daily.findIndex(function (m) { return m.work_id === workId && m.date === date && m.platform === platform; });
      if (idx >= 0) {
        keys.forEach(function (k) {
          this.data.metrics_daily[idx][k] = (Number(this.data.metrics_daily[idx][k]) || 0) + (fields ? Number(fields[k]) || 0 : 0);
        }.bind(this));
      } else {
        const row = { work_id: workId, date: date, platform: platform, views: 0, stars: 0, comments: 0 };
        if (fields) keys.forEach(function (k) { row[k] = Number(fields[k]) || 0; });
        this.data.metrics_daily.push(row);
      }
      this.saveJson();
    }
  }
  listMetrics(workId, days) {
    days = Number(days) || 30;
    if (this.mode === 'sqlite') {
      if (workId) return this.all('SELECT * FROM metrics_daily WHERE work_id = ? ORDER BY date DESC LIMIT ?', [workId, days * 20]);
      return this.all('SELECT * FROM metrics_daily ORDER BY date DESC LIMIT ?', [days * 20]);
    }
    return (this.data.metrics_daily || []).slice(-days * 20);
  }

  // ---------- 适配器健康度 ----------
  // 用 settings 表的 base_url 字段不冲突；这里新增独立表 settings_kv（key-value）
  ensureSettingsKvTable() {
    if (this.mode === 'sqlite') {
      try {
        this.run(`CREATE TABLE IF NOT EXISTS settings_kv (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT)`);
      } catch (_e) {}
    }
  }
  upsertSettingKv(key, value) {
    if (this.mode === 'sqlite') {
      this.ensureSettingsKvTable();
      this.run('INSERT INTO settings_kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
        [key, value == null ? null : String(value), new Date().toISOString()]);
    } else {
      if (!this.data.settings_kv) this.data.settings_kv = {};
      this.data.settings_kv[key] = value;
      this.saveJson();
    }
  }
  getSettingKv(key) {
    if (this.mode === 'sqlite') {
      this.ensureSettingsKvTable();
      const row = this.get('SELECT v FROM settings_kv WHERE k = ?', [key]);
      return row ? row.v : null;
    }
    return this.data.settings_kv ? this.data.settings_kv[key] : null;
  }
  // 删除一个 KV（逾期计划「暂停自动执行」标记解除时使用）
  deleteSettingKv(key) {
    const k = String(key || '');
    if (!k) return { ok: false, error: 'missing key' };
    if (this.mode === 'sqlite') {
      this.ensureSettingsKvTable();
      this.run('DELETE FROM settings_kv WHERE k = ?', [k]);
    } else if (this.data.settings_kv) {
      delete this.data.settings_kv[k];
      this.saveJson();
    }
    return { ok: true, key: k };
  }

  // settings_kv 前缀查询（只读）。用于「作品最新成品视频」映射（finalVideo:<workId>）。
  _listSettingKv(prefix) {
    const p = String(prefix || '');
    if (!p) return [];
    if (this.mode === 'sqlite') {
      this.ensureSettingsKvTable();
      return this.all('SELECT k, v FROM settings_kv WHERE k LIKE ?', [p + '%']) || [];
    }
    const kv = (this.data && this.data.settings_kv) ? this.data.settings_kv : {};
    return Object.keys(kv)
      .filter(function (k) { return k.indexOf(p) === 0; })
      .map(function (k) { return { k: k, v: kv[k] }; });
  }

  // ---------- 视频生命周期：清理资格判断（只读，不删除任何文件）----------
  //   用户约定：
  //     1) 每个作品只维护一个最新成品视频（finalVideo:<workId>）；
  //     2) 多个计划可以引用同一个视频，不为每个计划复制文件；
  //     3) 计划完成 / 取消都不立即删除视频；
  //     4) 旧视频只有「不再是作品最新视频」且「没有任何未完成计划引用」时才允许进入清理流程；
  //     5) 无法可靠确认引用关系 → 一律不合格（宁可保留文件）。
  //   opts.managed：文件是否位于 Rokit 管理的成品目录（由主进程按白名单判定）。
  //     未提供时：只有当某个作品的映射仍指向该路径才算 managed；
  //     明确为 false（用户上传的原始视频 / 其它非 Rokit 文件）→ 永不清理。
  //   返回 { ok, eligible, managed, latestWorkIds, references, reason }
  assessFinalVideoCleanup(videoPath, opts) {
    const raw = String(videoPath == null ? '' : videoPath).trim();
    const norm = function (p) {
      try {
        const r = path.resolve(String(p || ''));
        return process.platform === 'win32' ? r.toLowerCase() : r;
      } catch (_e) { return ''; }
    };
    const target = norm(raw);
    if (!target) {
      return { ok: false, eligible: false, managed: false, latestWorkIds: [], references: [], reason: '缺少视频路径' };
    }

    // 1) 是否仍是某个作品的「最新成品视频」
    const latestWorkIds = [];
    let managed = false;
    try {
      this._listSettingKv('finalVideo:').forEach(function (row) {
        const k = String((row && row.k) || '');
        const v = String((row && row.v) || '');
        if (!k || !v) return;
        if (norm(v) === target) {
          managed = true;
          latestWorkIds.push(k.slice('finalVideo:'.length));
        }
      });
    } catch (_e) {
      return { ok: false, eligible: false, managed: false, latestWorkIds: [], references: [], reason: '读取作品视频映射失败' };
    }
    if (opts && opts.managed === false) {
      return {
        ok: true, eligible: false, managed: false, latestWorkIds: latestWorkIds,
        references: [], reason: '不是 Rokit 管理的成品视频，保留'
      };
    }

    if (latestWorkIds.length) {
      return {
        ok: true, eligible: false, managed: true, latestWorkIds: latestWorkIds,
        references: [], reason: '仍是作品最新成品视频'
      };
    }

    if (!managed && !(opts && opts.managed === true)) {
      // 没有任何映射指向它：无法证明是 Rokit 管理的文件 → 不猜测，保留
      return {
        ok: true, eligible: false, managed: false, latestWorkIds: [],
        references: [], reason: '无法确认是 Rokit 管理的成品视频，保留'
      };
    }

    // 2) 计划引用：阶段 copy.github.videoPath 精确指向该文件，且该阶段仍在发布 GitHub
    const references = [];
    let unconfirmed = false;
    try {
      const taskByKey = {};
      (this.listPlanTasks('') || []).forEach(function (t) {
        if (!t) return;
        taskByKey[String(t.work_id || '') + '|' + String(t.stage_id || '') + '|' + String(t.platform_id || '')] = t;
      });
      (this.listAllPlanStages() || []).forEach(function (s) {
        if (!s) return;
        const platforms = Array.isArray(s.platforms) ? s.platforms : [];
        if (platforms.indexOf('github') < 0) return;   // 平台已被移出该阶段 → 不再引用
        const c = (s.copy && typeof s.copy === 'object') ? s.copy.github : null;
        const vp = c ? String(c.videoPath || '') : '';
        if (!vp || norm(vp) !== target) return;
        const task = taskByKey[String(s.work_id || '') + '|' + String(s.id || '') + '|github'];
        if (!task) {
          // 有待执行计划却没有对应任务行 → 引用关系不可确认，保留文件
          unconfirmed = true;
          references.push({ workId: String(s.work_id || ''), stageId: String(s.id || ''), taskId: '', status: 'unknown' });
          return;
        }
        references.push({
          workId: String(s.work_id || ''), stageId: String(s.id || ''),
          taskId: String(task.id || ''), status: String(task.status || '')
        });
      });
    } catch (_e) {
      return {
        ok: false, eligible: false, managed: true, latestWorkIds: [],
        references: [], reason: '读取计划引用失败，保留文件'
      };
    }

    if (unconfirmed) {
      return {
        ok: false, eligible: false, managed: true, latestWorkIds: [],
        references: references, reason: '计划引用关系无法确认，保留文件'
      };
    }
    // 未完成引用：pending / running / needs_review / failed（failed 也算未完成，宁可保留）
    // 已完成（done）与已取消（cancelled）不再阻塞清理。
    const unfinished = references.filter(function (r) {
      return r.status !== 'done' && r.status !== 'cancelled';
    });
    if (unfinished.length) {
      return {
        ok: true, eligible: false, managed: true, latestWorkIds: [],
        references: references, reason: '仍被未完成计划引用'
      };
    }
    return {
      ok: true, eligible: true, managed: true, latestWorkIds: [],
      references: references, reason: '不再是作品最新视频且无未完成计划引用'
    };
  }

  // ---------- 逾期计划：用户处理前的「暂停自动执行」标记（settings_kv） ----------
  //   只对「本次启动前已到期、仍在等待真实执行（real_only=1）」的 GitHub 计划任务打标：
  //   调度器扫描时跳过这些任务，直到用户在逾期提醒中明确选择「立即执行 / 延后一天 / 放弃」。
  //   - 标记值保存当时的 scheduled_at：任务被重新排期后标记自然失效，不会误伤新计划；
  //   - 标记不改变任务状态（仍是 pending）：软件关闭不等于取消计划；
  //   - 不删除任何视频文件。
  _planHoldKey(taskId) { return 'overdueHold:' + String(taskId || ''); }

  holdPlanTask(taskId, scheduledAt) {
    const id = String(taskId || '');
    if (!id) return { ok: false, error: 'missing task id' };
    this.upsertSettingKv(this._planHoldKey(id), String(scheduledAt || ''));
    return { ok: true, taskId: id, scheduledAt: String(scheduledAt || '') };
  }

  clearPlanTaskHold(taskId) {
    const id = String(taskId || '');
    if (!id) return { ok: false, error: 'missing task id' };
    this.deleteSettingKv(this._planHoldKey(id));
    return { ok: true, taskId: id };
  }

  // 任务是否处于「逾期暂停」：只有标记值与当前计划执行时间一致才算成立。
  isPlanTaskHeld(taskId, scheduledAt) {
    const id = String(taskId || '');
    if (!id) return false;
    const v = this.getSettingKv(this._planHoldKey(id));
    if (v === null || v === undefined || String(v) === '') return false;
    return String(v) === String(scheduledAt || '');
  }

  // 启动时把关闭期间到期的计划任务标记为「暂停自动执行」，交由逾期提醒让用户选择。
  //   条件：**所有平台** + pending + scheduled_at <= 启动时刻。
  //   - 不再限定平台：逾期检测是首秀计划的通用管理机制，必须覆盖所有接入的平台
  //     （GitHub / YouTube / 微信公众号 / 后续平台）；
  //     某个平台暂时没有真实发布执行器，不构成把它排除在逾期检测之外的理由。
  //   - 不再以 real_only 作为条件：real_only 只决定「到期后由真实还是模拟执行器接手」，
  //     与「是否属于逾期计划」无关；用它过滤会让 real_only=0 的任务在启动扫描时
  //     被模拟执行器消费掉（status 变成 done / draft_pending），
  //     结果永远进不了逾期提醒。
  //   - 仍然只处理 pending：done / cancelled / failed / draft_pending / running /
  //     needs_review 都不是「逾期待处理」，绝不误判。
  holdMissedPlanTasks(bootIso) {
    const boot = String(bootIso || new Date().toISOString());
    const held = [];
    (this.listPlanTasks('') || []).forEach(t => {
      if (!t) return;
      if (String(t.status) !== 'pending') return;
      const at = String(t.scheduled_at || '');
      if (!at || at > boot) return;
      this.holdPlanTask(t.id, at);
      held.push({
        taskId: t.id, workId: String(t.work_id || ''),
        stageId: String(t.stage_id || ''),
        platformId: String(t.platform_id || ''),
        scheduledAt: at
      });
    });
    return { ok: true, boot: boot, held: held };
  }

  // 解除某个阶段对成品视频的引用（放弃逾期计划时使用）。
  //   只删除**指定平台**的 videoPath 快照（opts.platformId，缺省仍按 github 兼容旧调用），
  //   标题 / 正文 / 标签等其它计划内容一律保留；
  //   **不删除任何视频文件**（是否清理由 assessFinalVideoCleanup 判断）。
  //   ★ 跨平台安全：放弃 YouTube 计划时绝不去动 copy.github.videoPath，
  //     放弃微信公众号计划时也不会去读 / 解绑其它平台的快照。
  detachPlanVideoReference(workId, stageId, opts) {
    const owner = String(workId || '');
    const id = String(stageId || '');
    if (!owner || !id) return { ok: false, error: 'missing work id or stage id' };
    const pid = String((opts && opts.platformId) || 'github');
    const cur = this.listPlanStages(owner).filter(s => String(s.id) === id)[0];
    if (!cur) return { ok: false, error: 'stage not found for work' };
    const copy = (cur.copy && typeof cur.copy === 'object') ? cur.copy : {};
    const plat = (copy[pid] && typeof copy[pid] === 'object') ? copy[pid] : null;
    if (!plat || !String(plat.videoPath || '')) {
      return { ok: true, changed: false, stage: cur };
    }
    delete plat.videoPath;
    const nextCopy = Object.assign({}, copy);
    nextCopy[pid] = plat;
    const now = new Date().toISOString();
    if (this.mode === 'sqlite') {
      const res = this.run('UPDATE plan_stages SET copy=?, updated_at=? WHERE id=? AND work_id=?',
        [JSON.stringify(nextCopy), now, id, owner]);
      const changes = res && typeof res.changes === 'number' ? res.changes : 0;
      if (!changes) return { ok: false, error: 'stage not found for work' };
    } else {
      const list = Array.isArray(this.data.plan_stages) ? this.data.plan_stages : [];
      const row = list.filter(x => x && String(x.id) === id && String(x.work_id || '') === owner)[0];
      if (!row) return { ok: false, error: 'stage not found for work' };
      row.copy = nextCopy;
      row.updated_at = now;
      this.saveJson();
    }
    const after = this.listPlanStages(owner).filter(s => String(s.id) === id)[0] || null;
    return { ok: true, changed: true, stage: after };
  }

  // 只更新某个阶段的计划执行时间（逾期延后一天用）。
  //   不新增 / 不删除任务、不改变平台与文案；任务层时间由调用方另行更新。
  updatePlanStageScheduledAt(workId, stageId, iso) {
    const owner = String(workId || '');
    const id = String(stageId || '');
    const at = String(iso || '');
    if (!owner || !id) return { ok: false, error: 'missing work id or stage id' };
    const d = new Date(at);
    if (!at || isNaN(d.getTime())) return { ok: false, error: 'invalid scheduled time' };
    const now = new Date().toISOString();
    let ok = false;
    if (this.mode === 'sqlite') {
      const res = this.run('UPDATE plan_stages SET scheduled_at=?, updated_at=? WHERE id=? AND work_id=?',
        [d.toISOString(), now, id, owner]);
      ok = !!(res && typeof res.changes === 'number' && res.changes > 0);
    } else {
      const list = Array.isArray(this.data.plan_stages) ? this.data.plan_stages : [];
      const row = list.filter(x => x && String(x.id) === id && String(x.work_id || '') === owner)[0];
      if (row) {
        row.scheduled_at = d.toISOString();
        row.updated_at = now;
        this.saveJson();
        ok = true;
      }
    }
    if (!ok) return { ok: false, error: 'stage not found for work' };
    return { ok: true, stage: this.listPlanStages(owner).filter(s => String(s.id) === id)[0] || null };
  }
}

module.exports = { Store, CURRENT_VERSION, migrations, notifyPubsChanged, onPubsChanged };