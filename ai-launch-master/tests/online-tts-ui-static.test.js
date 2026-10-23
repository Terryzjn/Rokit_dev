// 线上 AI 配音引擎 · 静态契约测试（v1.21）
//
// 只做源码级断言，不启动 Electron、不发网络请求。
// 覆盖任务书第八节里「用静态检查可验证」的几条：
//   1. 两个引擎被注册与分发机制识别
//   2. testGenerate 调用约定
//   3. 无自动请求（启动 / 开页面 / 保存配置都不打线上 API）
//   4. 字幕为空时的配音拦截仍在
//   5. 密钥不经渲染层；源码无硬编码 Key
//   6. IPC 已注册且 preload 已暴露
//   7. 线上引擎失败不得改写 XTTS 配置

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
const VENG = fs.readFileSync(path.join(ROOT, 'electron', 'voice-engine.js'), 'utf8');
const SECRETS = fs.readFileSync(path.join(ROOT, 'electron', 'secrets.js'), 'utf8');

describe('引擎注册与分发', () => {
  it('ENGINES 注册表含 openai-tts / elevenlabs-tts 且 implemented: true', () => {
    expect(VENG).toMatch(/Object\.assign\(_onlineEngine\(\s*'openai-tts'/);
    expect(VENG).toMatch(/Object\.assign\(_onlineEngine\(\s*'elevenlabs-tts'/);
    const block = VENG.slice(VENG.indexOf("'openai-tts'"), VENG.indexOf('// ===== HTTP 工具'));
    expect(block).toMatch(/implemented:\s*true/);
  });
  it('probe() 对两个线上引擎走 onlineProbe 分支', () => {
    expect(VENG).toMatch(/if \(engineId === 'openai-tts' \|\| engineId === 'elevenlabs-tts'\) \{\s*return await onlineProbe/);
  });
  it('testGenerate() 对两个线上引擎走真实适配器分支', () => {
    expect(VENG).toMatch(/engineId === 'openai-tts' \|\| engineId === 'elevenlabs-tts'/);
    expect(VENG).toMatch(/await openaiTtsGenerate\(cfg, text/);
    expect(VENG).toMatch(/await elevenlabsTtsGenerate\(cfg, text/);
  });
  it('testGenerate 返回现有业务链路需要的字段（mime / audio / durationSec / error / actionableHint）', () => {
    // 成功路径
    expect(VENG).toMatch(/ok:\s*true,\s*mime:\s*'audio\/wav',\s*audio:/);
    expect(VENG).toMatch(/r\.durationSec = \(r\.mime === 'audio\/wav'\)/);
    // 失败路径必须带可识别错误 + 可操作提示
    expect(VENG).toMatch(/actionableHint/);
  });
  it('main.js 的 test-generate IPC 把 Buffer 转 base64 并带 25MB 上限', () => {
    expect(MAIN).toMatch(/voice-engine:test-generate/);
    expect(MAIN).toMatch(/r\.audio\.toString\('base64'\)/);
    expect(MAIN).toMatch(/audio-too-large/);
  });
});

describe('无自动请求（启动 / 打开页面 / 保存配置都不打线上 API）', () => {
  it('cfgVoiceRefresh 只读本地 IPC，不调用 probe / test-generate', () => {
    const start = INDEX.indexOf('function cfgVoiceRefresh(){');
    expect(start).toBeGreaterThan(-1);
    const body = INDEX.slice(start, start + 900);
    expect(body).toMatch(/onlineTtsConfig/);
    expect(body).not.toMatch(/voiceEngineProbe|voiceEngineTestGenerate/);
    // 密钥状态读取放在 _cfgVoiceLoadOne 里，同样只读布尔值
    const l = INDEX.indexOf('function _cfgVoiceLoadOne(id){');
    expect(l).toBeGreaterThan(-1);
    const loadBody = INDEX.slice(l, l + 800);
    expect(loadBody).toMatch(/secretsOnlineTtsKey/);
    expect(loadBody).not.toMatch(/voiceEngineProbe|voiceEngineTestGenerate/);
  });
  it('voiceEnginePickEngine 选中线上引擎时只读本地状态，不发线上请求', () => {
    const start = INDEX.indexOf('window.voiceEnginePickEngine = function (engineId){');
    expect(start).toBeGreaterThan(-1);
    const body = INDEX.slice(start, start + 3000);
    expect(body).toMatch(/secretsOnlineTtsKey/);
    expect(body).toMatch(/onlineTtsConfig/);
    expect(body).not.toMatch(/voiceEngineProbe|voiceEngineTestGenerate/);
  });
  it('renderVoiceEngineStep 只在 onclick 属性里引用请求函数，渲染本身不发起请求', () => {
    const start = INDEX.indexOf('function renderVoiceEngineStep(ctrl)');
    expect(start).toBeGreaterThan(-1);
    const end = INDEX.indexOf('// 引擎选择卡片 click', start);
    const body = INDEX.slice(start, end - start);
    // 结尾：只拉引擎列表
    const tail = body.slice(body.lastIndexOf('ctrl.innerHTML = html;'));
    expect(tail).not.toMatch(/voiceEngineProbe|voiceEngineTestGenerate|voiceEngineOnlineProbe/);
    // 面板里出现的调用必须全部包在 onclick="..." 属性字符串内
    const bare = body.replace(/onclick="[^"]*"/g, '');
    expect(bare).not.toMatch(/voiceEngineProbe\(|voiceEngineTestGenerate\(|voiceEngineOnlineProbe\(/);
  });
  it('线上请求只出现在四个明确的用户点击处理器里', () => {
    const callers = [];
    const probeRe = /window\.(cfgVoiceTestConnect|voiceEngineOnlineProbe)\s*=\s*(async\s+)?function/g;
    const genRe = /window\.(cfgVoiceTestGenerate|voiceEngineRunTest)\s*=\s*(async\s+)?function/g;
    let m;
    while ((m = probeRe.exec(INDEX))) callers.push(m[1]);
    while ((m = genRe.exec(INDEX))) callers.push(m[1]);
    expect(callers.sort()).toEqual(['cfgVoiceTestConnect', 'cfgVoiceTestGenerate', 'voiceEngineOnlineProbe', 'voiceEngineRunTest']);
    // 渲染层不得直接出网
    expect(INDEX).not.toMatch(/fetch\(['"]https:\/\/api\.(openai|elevenlabs)/i);
    expect(INDEX).not.toMatch(/XMLHttpRequest[\s\S]{0,200}elevenlabs/i);
  });
  it('preload 只暴露 IPC 转发，没有任何出网逻辑', () => {
    expect(PRELOAD).not.toMatch(/require\('https?'\)|require\("https?"\)|fetch\(/);
    expect(PRELOAD).toMatch(/contextBridge/);
  });
});

describe('密钥安全', () => {
  it('两个 keytar 槽位在 secrets.js 中定义且接口已导出', () => {
    expect(SECRETS).toMatch(/'openai-tts-api-key'/);
    expect(SECRETS).toMatch(/'elevenlabs-tts-api-key'/);
    ['getOpenaiTtsKey','setOpenaiTtsKey','clearOpenaiTtsKey',
     'getElevenlabsTtsKey','setElevenlabsTtsKey','clearElevenlabsTtsKey'
    ].forEach(fn => expect(SECRETS).toMatch(new RegExp('\\b' + fn + '\\b')));
  });
  it('IPC 层：查询只回布尔值，写入 / 清除按 provider 白名单', () => {
    expect(MAIN).toMatch(/secrets:online-tts-key/);
    expect(MAIN).toMatch(/hasKey:\s*!!value/);
    expect(MAIN).toMatch(/secrets:set-online-tts-key/);
    expect(MAIN).toMatch(/secrets:clear-online-tts-key/);
    expect(MAIN).toMatch(/unknown-provider/);
  });
  it('渲染层没有读取明文密钥的通道（secretsStatus 之外无新出口）', () => {
    // preload 不提供任何 get 明文的 online-tts 方法
    expect(PRELOAD).not.toMatch(/onlineTtsKeyValue|getOnlineTtsKeyValue/);
    expect(PRELOAD).toMatch(/secretsOnlineTtsKey:\s*\(provider\)\s*=>\s*ipcRenderer\.invoke\('secrets:online-tts-key'/);
  });
  it('全部源码中不存在硬编码的真实形态 API Key', () => {
    ['electron/voice-engine.js', 'electron/main.js', 'electron/preload.js', 'electron/secrets.js', 'index.html']
      .forEach(rel => {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        // sk- 后接 ≥20 位随机串（OpenAI 真实 Key 形态）
        expect({ file: rel, hits: src.match(/\bsk-[A-Za-z0-9_-]{20,}\b/g) || [] })
          .toEqual({ file: rel, hits: [] });
        // ElevenLabs 真实 Key 形态：32 位以上十六进制/字母数字串
        expect({ file: rel, hits: src.match(/\b[0-9a-f]{32,}\b/g) || [] })
          .toEqual({ file: rel, hits: [] });
      });
  });
  it('日志输出不含 Authorization / xi-api-key 头内容', () => {
    ['electron/voice-engine.js', 'electron/main.js'].forEach(rel => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const logLines = src.split('\n').filter(l => /logger\.(info|warn|error|debug)|console\.(log|warn|error)/.test(l));
      logLines.forEach(l => {
        expect({ line: l, leaked: /Authorization|xi-api-key|api-?key['"]?\s*[:=]\s*['"]?[A-Za-z0-9]/i.test(l) }).toEqual({ line: l, leaked: false });
      });
    });
  });
  it('清除密钥后 voice-engine 读到空串（_readOnlineKey 兜底返回 ""）', () => {
    expect(VENG).toMatch(/async function _readOnlineKey\(engineId\)/);
    expect(VENG).toMatch(/return '';/);
  });
});

describe('配置界面（设置页「线上配音」区）', () => {
  it('有独立分区与导航项', () => {
    expect(INDEX).toMatch(/id="cfg-sec-voice"/);
    expect(INDEX).toMatch(/cfgNavJump\('cfg-sec-voice'\)/);
    expect(INDEX).toMatch(/id="cfgVoiceEngines"/);
  });
  it('两个引擎都在配置项里声明', () => {
    expect(INDEX).toMatch(/id:\s*'openai-tts'/);
    expect(INDEX).toMatch(/id:\s*'elevenlabs-tts'/);
    expect(INDEX).toMatch(/OpenAI API Key/);
    expect(INDEX).toMatch(/ElevenLabs API Key/);
  });
  it('API Key 输入框默认遮蔽 + 显示/隐藏控制', () => {
    expect(INDEX).toMatch(/id="cfgVtKey_' \+ id \+ '" type="password"/);
    expect(INDEX).toMatch(/cfgVoiceToggleKeyVisible/);
    expect(INDEX).toMatch(/inp\.type = show \? 'text' : 'password'/);
  });
  it('模型 / 音色配置项齐全（OpenAI: model+voice；ElevenLabs: voiceId+modelId+outputFormat）', () => {
    expect(INDEX).toMatch(/\{ k: 'model', label: '模型'/);
    expect(INDEX).toMatch(/\{ k: 'voice', label: '音色（voice）'/);
    expect(INDEX).toMatch(/\{ k: 'voiceId', label: 'Voice ID'/);
    expect(INDEX).toMatch(/\{ k: 'modelId', label: '模型 ID/);
    expect(INDEX).toMatch(/\{ k: 'outputFormat', label: '输出格式/);
  });
  it('保存 / 修改 / 清除密钥能力齐备', () => {
    expect(INDEX).toMatch(/window\.cfgVoiceSaveKey\s*=/);
    expect(INDEX).toMatch(/window\.cfgVoiceClearKey\s*=/);
    expect(INDEX).toMatch(/更换 Key/);
    expect(INDEX).toMatch(/清除 Key/);
    expect(INDEX).toMatch(/保存 Key/);
  });
  it('测试连接 / 测试语音生成 是两个独立按钮 + 两套独立状态', () => {
    expect(INDEX).toMatch(/cfgVoiceTestConnect/);
    expect(INDEX).toMatch(/cfgVoiceTestGenerate/);
    expect(INDEX).toMatch(/认证通过（未验证合成）/);
    expect(INDEX).toMatch(/已生成测试语音/);
    expect(INDEX).toMatch(/连接失败/);
    expect(INDEX).toMatch(/生成失败/);
    // 四态：未测试 / 测试中 / 成功 / 失败
    expect(INDEX).toMatch(/未测试连接/);
    expect(INDEX).toMatch(/连接测试中/);
    expect(INDEX).toMatch(/未测试生成/);
    expect(INDEX).toMatch(/生成中/);
  });
  it('测试文本为短句，不使用长段落', () => {
    const m = INDEX.match(/testText:\s*'([^']*)'/g) || [];
    expect(m.length).toBeGreaterThanOrEqual(2);
    m.forEach(line => {
      const text = line.replace(/testText:\s*'/, '').replace(/'$/, '');
      expect(text.length).toBeLessThanOrEqual(30);
    });
  });
  it('生成成功后提供试听（audio 元素 + 正确 mime）', () => {
    expect(INDEX).toMatch(/id="cfgVtAudio_' \+ id/);
    expect(INDEX).toMatch(/controls src="data:' \+ esc\(s\.mime\) \+ ';base64,/);
  });
  it('keytar 不可用时如实告知「仅本次运行有效」，不谎称已安全保存', () => {
    expect(INDEX).toMatch(/r\.persisted \? '✓ Key 已保存到系统凭据管理器'/);
    expect(INDEX).toMatch(/仅本次运行有效/);
  });
});

describe('接入现有配音链路', () => {
  it('字幕轨道为空时的拦截仍然有效且先于任何生成', () => {
    const idx = INDEX.indexOf('function hasSubtitleText(s){');
    expect(idx).toBeGreaterThan(-1);
    const guard = INDEX.slice(idx, idx + 1400);
    expect(guard).toMatch(/validSegCount === 0/);
    expect(guard).toMatch(/请先在字幕轨道中添加至少一条非空字幕/);
    expect(guard).toMatch(/return;/);
    // 拦截必须在 _capPersist / 启动生成之前
    expect(guard.indexOf('validSegCount === 0')).toBeLessThan(guard.indexOf('_capPersist()'));
  });
  it('正式配音数据源仍是字幕轨道上的 seg.text，不读 sd.rows', () => {
    const idx = INDEX.indexOf('function genOne(seg, cb){');
    const body = INDEX.slice(idx, idx + 2600);
    expect(body).toMatch(/var segText = \(typeof seg\.text === 'string'\) \? seg\.text\.trim\(\) : ''/);
    expect(body).toMatch(/empty-text/);
  });
  it('genOne 通过同一个 voiceEngineTestGenerate 分发到所选引擎（未另建链路）', () => {
    const idx = INDEX.indexOf('function genOne(seg, cb){');
    const body = INDEX.slice(idx, idx + 2600);
    expect(body).toMatch(/window\.api\.voiceEngineTestGenerate\(\{/);
    expect(body).toMatch(/engineId: engineId/);
  });
  it('单条生成 + 串行 + 音频合并约定未变', () => {
    expect(INDEX).toMatch(/seg\.audioB64 = r\.audioBase64;/);
    expect(INDEX).toMatch(/seg\.audioMime = r\.mime \|\| 'audio\/wav';/);
    expect(INDEX).toMatch(/seg\.generated = true;/);
  });
  it('线上引擎免参考音频；缺 Key / 缺 Voice ID 时就地失败不打服务端', () => {
    const idx = INDEX.indexOf('function genOne(seg, cb){');
    const body = INDEX.slice(idx, idx + 2600);
    expect(body).toMatch(/var _needRef = !isOnline;/);
    expect(body).toMatch(/no-api-key/);
    expect(body).toMatch(/no-voice-id/);
  });
  it('新失败类型有可读标签', () => {
    expect(INDEX).toMatch(/'no-api-key':\s*'在线服务未配置 API Key'/);
    expect(INDEX).toMatch(/'no-voice-id':\s*'ElevenLabs 未配置 Voice ID'/);
  });
});

describe('不影响 XTTS-v2', () => {
  it('XTTS-v2 的本地分支仍判 reachable + baseUrl，未被线上分支污染', () => {
    const idx = INDEX.indexOf('function genOne(seg, cb){');
    const body = INDEX.slice(idx, idx + 2600);
    expect(body).toMatch(/cfg\.baseUrl = \(ve\.local && ve\.local\.baseUrl\) \|\| ''/);
    expect(body).toMatch(/no-baseUrl/);
  });
  it('线上引擎失败路径不写 local.baseUrl / 不改引擎选择', () => {
    const idx = INDEX.indexOf('function genOne(seg, cb){');
    const body = INDEX.slice(idx, idx + 2600);
    expect(body).not.toMatch(/ve\.engineId\s*=\s*['"]xtts-v2['"]|local\.baseUrl\s*=\s*['"]http:\/\/127\.0\.0\.1:5002/);
  });
  it('voiceEnginePickKind 跨类切换只重置对应侧，不动另一侧配置', () => {
    const idx = INDEX.indexOf('window.voiceEnginePickKind = function (kind){');
    const body = INDEX.slice(idx, idx + 1400);
    expect(body).toMatch(/if \(kind !== 'LOCAL_MODEL'\) \{\s*state\.voiceEngine\.local = \{ baseUrl: '' \};/);
    expect(body).toMatch(/if \(kind !== 'ONLINE_SERVICE'\) \{/);
  });
  it('XTTS 参考音频读取逻辑保持不变', () => {
    expect(INDEX).toMatch(/function resolveRefAudio\(\)/);
    expect(INDEX).toMatch(/no-reference-audio:请先保存一段声音档案录音/);
  });
});

describe('自定义 Base URL 能力保留', () => {
  it('两个适配器都从 config.baseUrl 取址，并去除尾斜杠', () => {
    expect(VENG).toMatch(/cfg\.baseUrl \|\| 'https:\/\/api\.openai\.com'\)\.replace/);
    expect(VENG).toMatch(/cfg\.baseUrl \|\| 'https:\/\/api\.elevenlabs\.io'\)\.replace/);
  });
  it('settings_kv 配置读写 IPC 已注册，且密钥走独立通道', () => {
    expect(MAIN).toMatch(/online-tts:config/);
    expect(MAIN).toMatch(/online-tts:save-config/);
    expect(MAIN).toMatch(/online-tts:clear-config/);
    expect(MAIN).toMatch(/invalid-baseUrl/);
  });
  it('preload 暴露 6 个新方法', () => {
    ['secretsOnlineTtsKey','secretsSetOnlineTtsKey','secretsClearOnlineTtsKey',
     'onlineTtsConfig','onlineTtsSaveConfig','onlineTtsClearConfig'
    ].forEach(m => expect(PRELOAD).toMatch(new RegExp('\\b' + m + ':')));
  });
});
