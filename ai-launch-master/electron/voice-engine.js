// Voice engine adapters (v1.20.6)
//
//   统一定义：所有引擎适配器实现以下能力
//     listEngines():               返回引擎列表 + 兼容性元数据
//     probe(config):                根据 config 检测可达性 + 能力（**不**做实际生成）
//     testGenerate(config, text, refAudio): 用极小代价生成测试音频（**不**自动保存到正式档案）
//
// 适配器分为 2 大类：
//   - LOCAL_MODEL：本地 HTTP 服务（XTTS-v2 / F5-TTS / GPT-SoVITS / OpenVoice / CosyVoice 等）
//     用户自行启动；Rokit 仅负责按 URL 调用 / 检测。
//   - ONLINE_SERVICE：在线 API（占位；本次不实现实际调用的服务）。
//
// XTTS-v2 适配器是**第一个**真实实现。其余本地引擎给出可扩展 stub，明确标记「未连接」。
// 在线服务本次**不**内置任何已实际测试通过的 API（避免在没有真实凭据与文档的情况下伪造）。

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');
const ffmpegResolver = require('./ffmpeg-resolver');

// ===== 基础类型 =============================================================

// 引擎分类
const KIND_LOCAL = 'LOCAL_MODEL';
const KIND_ONLINE = 'ONLINE_SERVICE';

// 配置 schema
// local config:  { engineId, baseUrl }            // e.g. {engineId:'xtts-v2', baseUrl:'http://127.0.0.1:8020'}
// online config: { providerId, model }            // providerId 来自 secrets/secrets.js 的 KEY 适配

// 单一引擎定义
// engine = {
//   id, label, kind, description,
//   capabilities: { referenceAudio, languages, outputFormat }  // 声明（**不是**已验证）
// }

// ===== Engine catalog ========================================================

function _localEngine(id, label, description) {
  return {
    id: id,
    label: label,
    kind: KIND_LOCAL,
    description: description,
    capabilities: {
      referenceAudio: 'unknown',
      languages: 'unknown',
      outputFormat: 'unknown'
    },
    implemented: false
  };
}
function _onlineEngine(id, label, description) {
  return {
    id: id,
    label: label,
    kind: KIND_ONLINE,
    description: description,
    capabilities: {
      referenceAudio: 'unknown',
      languages: 'unknown',
      outputFormat: 'unknown'
    },
    implemented: false
  };
}

// v1.20.10 引擎目录：保留五款本地模型的真实默认地址、检测路径与能力声明
//
// 每条引擎的 defaults / healthPaths / framework 字段是 Rokit 探测时唯一依据。
// 严禁把任意 HTTP 服务的 200 / 405 都当作"XTTS-v2 已就绪"。
const ENGINES = [
  // ===== 本地引擎（5 款，保留原配置与真实默认端口） =====
  Object.assign(_localEngine(
    'xtts-v2',
    'XTTS-v2（Coqui）',
    'Coqui XTTS-v2 多语言 TTS，支持声音克隆。Coqui 官方 tts-server 默认端口 5002（路径 /api/tts, /v1/audio/speech）；其他兼容服务（coqui-studio / alltalk-one / XTTS-api-server）默认端口不同，请按实际服务配置。许可条款含非商业限制，请在部署前自行核实。'
  ), {
    implemented: true,
    framework: 'coqui-tts-server',
    defaults: { baseUrl: 'http://127.0.0.1:5002' },
    // Coqui 官方 tts-server 真实路径（来自 TTS/server/server.py）
    healthPaths: ['/', '/locales', '/api/tts', '/v1/audio/speech'],
    synthesizePath: '/api/tts',
    synthesizeMethod: 'POST',
    synthesizeBody: 'form',
    // 本引擎**真实实现**：form-encoded text / language_id / speaker_wav（文件路径）
    capabilities: {
      referenceAudio: 'yes',
      languages: 'multi',
      outputFormat: 'wav'
    }
  }),
  Object.assign(_localEngine(
    'f5-tts',
    'F5-TTS',
    'F5-TTS 风格本地推理。**默认端口 7860**（Gradio 默认）。常见部署为 Gradio WebUI；HTTP API 路径与 payload 与 Coqui tts-server 不兼容。如已部署支持 0.5 秒声音克隆的兼容 API，可在此接入。'
  ), {
    implemented: false,
    framework: 'gradio-default',
    defaults: { baseUrl: 'http://127.0.0.1:7860' },
    // Gradio 默认探测：根路径返回 200 HTML
    healthPaths: ['/', '/info'],
    synthesizePath: '/api/tts',
    synthesizeMethod: 'POST',
    synthesizeBody: 'json',
    capabilities: {
      referenceAudio: 'unverified',
      languages: 'unverified',
      outputFormat: 'unverified'
    }
  }),
  Object.assign(_localEngine(
    'gpt-sovits',
    'GPT-SoVITS',
    'GPT-SoVITS 本地推理。**默认端口 9880**（项目自带的 FastAPI/Gradio 服务）。提供参考音频音色克隆。'
  ), {
    implemented: false,
    framework: 'fastapi-custom',
    defaults: { baseUrl: 'http://127.0.0.1:9880' },
    healthPaths: ['/', '/health'],
    synthesizePath: '/infer',
    synthesizeMethod: 'POST',
    synthesizeBody: 'json',
    capabilities: {
      referenceAudio: 'unverified',
      languages: 'unverified',
      outputFormat: 'unverified'
    }
  }),
  Object.assign(_localEngine(
    'openvoice',
    'OpenVoice（myshell-ai）',
    'OpenVoice v2 本地推理。**默认端口 8000**。FastAPI 服务，支持声音克隆。'
  ), {
    implemented: false,
    framework: 'fastapi-custom',
    defaults: { baseUrl: 'http://127.0.0.1:8000' },
    healthPaths: ['/', '/docs', '/openapi.json', '/health'],
    synthesizePath: '/tts',
    synthesizeMethod: 'POST',
    synthesizeBody: 'json',
    capabilities: {
      referenceAudio: 'unverified',
      languages: 'unverified',
      outputFormat: 'unverified'
    }
  }),
  Object.assign(_localEngine(
    'cosyvoice',
    'CosyVoice（阿里达摩院）',
    'CosyVoice 本地推理。**默认端口 5000**。提供参考音频音色克隆。'
  ), {
    implemented: false,
    framework: 'gradio-default',
    defaults: { baseUrl: 'http://127.0.0.1:5000' },
    healthPaths: ['/', '/info'],
    synthesizePath: '/tts',
    synthesizeMethod: 'POST',
    synthesizeBody: 'json',
    capabilities: {
      referenceAudio: 'unverified',
      languages: 'unverified',
      outputFormat: 'unverified'
    }
  }),

  // ===== 在线服务（v1.21：OpenAI TTS / ElevenLabs TTS 已实现真实调用） =====
  //   凭据来源：secrets.js 的 keytar 槽位（openai-tts-api-key / elevenlabs-tts-api-key）。
  //   渲染层永远拿不到明文密钥，只传 providerId；密钥由本模块在主进程内读取。
  Object.assign(_onlineEngine(
    'openai-tts',
    'OpenAI TTS',
    '调用 OpenAI 官方 /v1/audio/speech 端点合成语音（默认模型 gpt-4o-mini-tts，支持 13 个内置音色）。需在 Rokit 设置里配置 OpenAI TTS API Key。'
  ), {
    implemented: true,
    framework: 'openai-audio-api',
    defaults: { baseUrl: 'https://api.openai.com' },
    healthPaths: ['/v1/models'],
    capabilities: {
      referenceAudio: 'no',
      languages: 'multi',
      outputFormat: 'wav'
    }
  }),
  Object.assign(_onlineEngine(
    'elevenlabs-tts',
    'ElevenLabs TTS',
    '调用 ElevenLabs 官方 /v1/text-to-speech/{voice_id} 端点合成语音。需在 Rokit 设置里配置 ElevenLabs API Key 与 Voice ID（可在 elevenlabs.io/app/voice-library 浏览）。'
  ), {
    implemented: true,
    framework: 'elevenlabs-api',
    defaults: { baseUrl: 'https://api.elevenlabs.io' },
    healthPaths: ['/v1/voices'],
    capabilities: {
      referenceAudio: 'no',
      languages: 'multi',
      outputFormat: 'mp3'
    }
  })
];

// ===== HTTP 工具 =============================================================

// 简化的 HTTP/HTTPS POST/GET，支持：
//   - JSON body（application/json）
//   - raw body（Buffer）
//   - 超时
//   - 重定向拦截（不自动跟随，让用户先看到真实地址）
// 不引入新依赖。

function _buildRequest(urlStr, options) {
  options = options || {};
  let u;
  try { u = new URL(urlStr); }
  catch (e) { return { ok: false, error: 'invalid-url:' + (e && e.message || String(e)) }; }
  const isHttps = u.protocol === 'https:';
  const lib = isHttps ? https : http;
  const opts = {
    method: options.method || 'GET',
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: u.pathname + (u.search || ''),
    headers: Object.assign({ 'User-Agent': 'Rokit/0.1.5' }, options.headers || {}),
    timeout: options.timeoutMs || 8000
  };
  return new Promise(function (resolve) {
    let settled = false;
    function done(r) {
      if (settled) return; settled = true;
      try { req.destroy(); } catch (_e) {}
      resolve(r);
    }
    const req = lib.request(opts, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const buf = Buffer.concat(chunks);
        done({
          ok: true,
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: buf,
          text: buf.toString('utf8')
        });
      });
      res.on('error', function (e) { done({ ok: false, error: 'response-error:' + (e && e.message || e) }); });
    });
    req.on('error', function (e) {
      done({
        ok: false,
        error: 'request-error:' + (e && e.code ? e.code + ':' : '') + (e && e.message || String(e))
      });
    });
    req.on('timeout', function () {
      done({ ok: false, error: 'timeout:' + (options.timeoutMs || 8000) + 'ms' });
    });
    if (options.body) {
      if (options.jsonBody !== undefined) {
        try {
          const s = JSON.stringify(options.jsonBody);
          if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
          opts.headers['Content-Length'] = Buffer.byteLength(s);
          req.write(s);
        } catch (e) {
          return done({ ok: false, error: 'json-stringify:' + (e && e.message || e) });
        }
      } else if (Buffer.isBuffer(options.body)) {
        opts.headers['Content-Length'] = options.body.length;
        req.write(options.body);
      } else if (typeof options.body === 'string') {
        opts.headers['Content-Length'] = Buffer.byteLength(options.body);
        req.write(options.body);
      }
    }
    req.end();
  });
}

// 判断 HTTP 状态：2xx 视为 OK
function _okStatus(s) {
  return typeof s === 'number' && s >= 200 && s < 300;
}

// ===== XTTS-v2 适配器 =======================================================
//
// v1.20.9 重写：与 Coqui 官方 `tts-server`（`TTS.server.server`）真实契约对齐
//
// 真实端点（来自 TTS/server/server.py）：
//   GET  /                          → 渲染 index.html（200）
//   GET  /api/tts                   → 仅允许 POST（405 Method Not Allowed 表示端点存在）
//   POST /api/tts                   → 实际合成（form 或 query，参数：text / speaker_id / language_id / style_wav / speaker_wav）
//   POST /v1/audio/speech           → OpenAI 兼容（JSON：{ "input", "voice", "model", "response_format", "speed" }）
//   GET  /locales                   → MaryTTS 兼容（200 文本）
//   GET  /voices                    → MaryTTS 兼容（200 文本）
//   GET  /process                   → MaryTTS 兼容
//
// 重要事实：
//   1. 默认端口是 5002（不是 8020 / 7860 / 9880 等其他项目端口）
//   2. `speaker_wav` 是**服务端可访问的文件路径**（绝对路径或相对于 tts-server CWD 的路径）
//      → 不能通过 HTTP body 传 base64；必须先在磁盘上落盘，再用绝对路径
//   3. 服务不读 `speaker_wav` 字段里的 base64 数据
//
// 因此我们的工作流是：
//   1. 启动测试时：把 renderer 给的 base64 写到 OS 临时目录（rokit-tts-speaker-<rand>.wav）
//   2. POST /api/tts 时把 speaker_wav 设为该**绝对路径**
//   3. 测试结束（含错误）后清理临时文件
//
// 移除的"幽灵"端点：/synthesize /tts /health /docs —— 这些都不是 Coqui 官方路径，
//   探测时遇到会导致"假阴性"或错误的 reachable 判定。

const XTTS_PATHS = ['/api/tts'];
// 健康路径（按特异性排序：先试 XTTS 专属，再试通用 Flask）
//   /locales         GET 200 plain text —— **XTTS 专属**（TTS/server/server.py 第 216 行）
//   /api/tts         GET 405 或 400 —— **XTTS 专属**
//   /v1/audio/speech GET 405 —— **XTTS 专属**
//   /                GET 200 HTML —— 通用 Flask 存活（**只**在以上 3 个专属路径都失败时才用，且需至少一个专属 405/400 印证）
//
// 重要：不能把任意 Gradio/FastAPI 服务（它们对 / 返回 200 HTML）误认为 XTTS-v2。
const XTTS_HEALTH_PATHS = ['/locales', '/api/tts', '/v1/audio/speech', '/'];
const XTTS_GENERIC_ROOT = '/';

async function xttsProbe(config) {
  const cfg = config || {};
  const baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    return {
      ok: false,
      error: 'no-baseUrl',
      actionableHint: '请填写本地服务地址（含端口），例如 http://127.0.0.1:5002',
      capabilities: {}
    };
  }
  const caps = {
    reachable: false,
    synthesizeEndpointFound: null,
    authRequired: false,
    referenceAudio: 'unverified',
    languages: 'unverified',
    outputFormat: 'unverified',
    notes: []
  };

  // 1) 探测可达性：依次尝试 XTTS 专属路径 + 最后兜底通用 /
  // 策略：任意 XTTS 专属路径（/locales, /api/tts, /v1/audio/speech）有响应 → 立即接受；
  //       否则，若 3 个专属路径都返回 404（说明此服务没有 XTTS 接口），即便 / 是 200 也不能接受 —— 那是 Gradio/FastAPI 等其他服务。
  let firstReachable = null;
  let lastErrDetail = '';
  let xttsSpecificProbe = null; // 记住 XTTS 专属路径的最后响应
  for (const p of XTTS_HEALTH_PATHS) {
    const r = _buildRequest(baseUrl + p, { method: 'GET', timeoutMs: 5000 });
    // 并发请求以减少总时长（XTTS_HEALTH_PATHS 通常 < 4 项）
    const allResults = await Promise.all(XTTS_HEALTH_PATHS.map(pp => _buildRequest(baseUrl + pp, { method: 'GET', timeoutMs: 5000 })));
    for (let i = 0; i < XTTS_HEALTH_PATHS.length; i++) {
      const path = XTTS_HEALTH_PATHS[i];
      const rr = allResults[i];
      if (!rr.ok) {
        // 网络错误（ECONNREFUSED / timeout / ENOTFOUND）—— 立刻判失败（端口没服务）
        if (/ECONNREFUSED|request-error.*ECONNREFUSED/.test(rr.error || '')) {
          return {
            ok: false,
            error: 'no-endpoint-responding',
            errorDetail: rr.error,
            actionableHint: '本地语音服务尚未启动。当前端口没有进程监听 —— Coqui tts-server 默认端口是 5002。如果你启动的是其他模型（f5-tts 7860 / gpt-sovits 9880 / openvoice 8000 / cosyvoice 5000），请切换到对应模型。',
            capabilities: caps
          };
        }
        lastErrDetail = path + ':' + (rr.error || 'request-failed');
        continue;
      }
      const st = rr.status;
      if (st >= 200 && st < 400) {
        // 200-399。区分 XTTS 专属 vs 通用 /
        if (path === XTTS_GENERIC_ROOT) {
          // 仅 / 200 不算 XTTS：需先看前面是否已有专属 405/400 或 200 plain-text
          // 继续循环到结束再判断
          continue;
        }
        // XTTS 专属路径返回 200：locales 返回 plain text，'/' 或 'index' 也可能 200
        // 严格判断：locales 应该是文本，其他路径不应该 200（API 是 POST-only）
        // 但有些 fork 实现可能 /api/tts 的 GET 返回 200；放宽容忍
        caps.reachable = true;
        caps.synthesizeEndpointFound = path;
        firstReachable = path;
        break;
      }
      if (st === 405 || st === 400) {
        // 405 = Method Not Allowed；400 = Bad Request —— 都说明 XTTS 端点存在
        caps.reachable = true;
        caps.synthesizeEndpointFound = path;
        firstReachable = path;
        break;
      }
      if (st === 401) {
        caps.reachable = true;
        caps.authRequired = true;
        firstReachable = path;
        break;
      }
      if (st === 404) {
        // 该路径不存在（不是 XTTS 路径），继续
        lastErrDetail = path + ':404';
        continue;
      }
    }
    break;
  }

  // 兜底逻辑：如果走完所有路径仍 reachable=false，但 / 返回 200（说明端口确实有服务但不是 XTTS-v2）
  // 必须返回 unknown-service
  if (!caps.reachable) {
    // 重新探测一次 / 来判断是否属于「有 HTTP 但不是 XTTS」
    try {
      const r = await _buildRequest(baseUrl + XTTS_GENERIC_ROOT, { method: 'GET', timeoutMs: 5000 });
      if (r.ok && r.status >= 200 && r.status < 400) {
        return {
          ok: false,
          error: 'unknown-service',
          errorDetail: '端口 ' + (cfg.baseUrl || '') + ' 有 HTTP 服务在监听，但对 XTTS-v2 专属路径（/locales, /api/tts, /v1/audio/speech）全部返回 404。',
          actionableHint: '当前端口有 HTTP 服务，但不是 Coqui XTTS-v2 服务。请检查：① 你启动的是哪个模型（f5-tts / gpt-sovits / openvoice / cosyvoice 默认端口都不是 5002）；② 切换 Rokit 中的模型卡片到对应引擎；③ 或把 Coqui tts-server 启动到 5002 端口。',
          capabilities: caps
        };
      }
    } catch (_e) {}
    // 真正的 ECONNREFUSED / timeout 等
    let hint = '';
    if (/ECONNREFUSED|request-error.*ECONNREFUSED/.test(lastErrDetail)) {
      hint = '本地语音服务尚未启动，或端口与实际服务不一致。Coqui tts-server 默认端口是 5002。';
    } else if (/timeout/.test(lastErrDetail)) {
      hint = '连接超时。请检查地址是否能 ping 通、服务是否允许 127.0.0.1 访问、防火墙是否放行该端口。';
    } else if (/ENOTFOUND|EAI_AGAIN/.test(lastErrDetail)) {
      hint = '无法解析主机名。请检查 baseUrl 的 hostname 部分（例如 127.0.0.1）。';
    } else {
      hint = '所有 XTTS 专属端点都返回 404。' + (lastErrDetail ? '（' + lastErrDetail + '）' : '');
    }
    return {
      ok: false,
      error: 'no-endpoint-responding',
      errorDetail: lastErrDetail,
      actionableHint: hint,
      capabilities: caps
    };
  }

  caps.referenceAudio = 'yes';
  return {
    ok: true,
    capabilities: caps,
    reachEndpoint: firstReachable
  };
}

function XTSS_HEALTH_LAST_IDX() { return XTTS_HEALTH_PATHS.length - 1; }

// 实际生成测试音频。
//   config:    { baseUrl }
//   text:      待合成短文本
//   refB64:    可选参考音频（base64 字符串）。如未提供，则**拒绝合成**
//            — XTTS-v2 在没有 speaker_wav 时会进入默认音色，这与「不伪造」原则冲突。
//            调用方需要先选好声音档案，确保 refB64 非空。
//
// 工作流：
//   1. 把 base64 写到 OS 临时目录（rokit-tts-speaker-<rand>.<ext>），得到 server-readable 路径
//      - 如果是 WAV/RIFF → 写为 .wav（Coqui 直接可读）
//      - 如果是 WebM/Opus（浏览器 MediaRecorder 默认）→ 走 ffmpeg 转换为 16k/mono WAV
//      - 如果 ffmpeg 不可用 → 写为 .webm（兜底，部分 XTTS fork 支持 WebM speaker_wav）
//   2. POST Coqui /api/tts —— 同时尝试两种参数形态：
//      a. Coqui 默认：form-encoded body + 同名 query（`text` / `speaker_id` / `language_id` / `style_wav` / `speaker_wav`）
//         speaker_wav 是 tts-server 进程可访问的**文件路径**
//      b. 兜底：headers（text / speaker-id / language-id / speaker-wav）
//   3. 清理临时文件
// 返回 { ok, mime, audio: Buffer, durationSec?, error? }
const os = require('os');
const fs = require('fs');
const path = require('path');

// v1.20.10 紧急回归修复：从 base64 数据头嗅探音频格式，避免硬编码 .wav 扩展名导致
// Coqui XTTS-v2 /alltalk-one 等 tts-server 拒绝读取（WebM bytes + .wav 后缀 = 解析失败）。
// 嗅探优先级：RIFF/WAVE > OggS > EBML/WebM > ISO/MP4。返回 '.wav' | '.webm' | '.ogg' | '.mp4' | '.bin'
function _sniffAudioExt(buf) {
  if (!buf || buf.length < 12) return '.bin';
  // 1) RIFF/WAVE
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return '.wav';
  // 2) OggS (Ogg/Opus/Vorbis)
  if (buf.toString('ascii', 0, 4) === 'OggS') return '.ogg';
  // 3) EBML header (Matroska/WebM/MKV)
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return '.webm';
  // 4) ISO base media (MP4/M4A) — 'ftyp' at offset 4
  if (buf.toString('ascii', 4, 8) === 'ftyp') return '.mp4';
  // 5) 兜底：保留 .wav 以兼容旧路径（未知格式）
  return '.bin';
}

// v1.20.10 紧急回归修复：转码完成后必须验证输出是合法 WAV（RIFF/WAVE 头 + 至少 44 字节），
// 避免 ffmpeg 异常退出时产生"假 WAV"被 XTTS 拒读（Format not recognised）。
function _validateWavBuffer(buf) {
  if (!buf || buf.length < 44) return { ok: false, reason: 'wav-too-short:' + (buf ? buf.length : 0) };
  // 必须是 RIFF/WAVE 头
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, reason: 'wav-missing-RIFF-WAVE-header' };
  }
  // fmt chunk 在 byte 12..36，必须能解析出 sampleRate / channels
  var sampleRate = buf.readUInt32LE(24);
  var channels = buf.readUInt16LE(22);
  if (sampleRate <= 0 || sampleRate > 192000) return { ok: false, reason: 'wav-bad-sample-rate:' + sampleRate };
  if (channels < 1 || channels > 8) return { ok: false, reason: 'wav-bad-channels:' + channels };
  // data chunk 必须存在且非空
  var dataOffset = buf.indexOf('data');
  if (dataOffset < 0 || dataOffset + 8 > buf.length) return { ok: false, reason: 'wav-no-data-chunk' };
  var dataSize = buf.readUInt32LE(dataOffset + 4);
  if (dataSize <= 0) return { ok: false, reason: 'wav-empty-data-chunk' };
  return { ok: true, sampleRate: sampleRate, channels: channels, dataBytes: dataSize };
}

// 把任意输入音频转成 16k/mono/PCM WAV（Coqui XTTS-v2 推荐格式）。
// 输入可以是 base64 或 Buffer；输出 Buffer（失败时返回 {ok:false}，**不**写盘）。
// 关键：转码完成后**必须**校验输出是合法 WAV（避免 ffmpeg 异常时产生"假 WAV"）。
//
// 输出 WAV 写在 userData/.tmp 下（Electron 主进程独占，杀软/系统 Temp 拦截可绕开）。
// 优雅降级到 os.tmpdir()/rokit 子目录。运行时探测；单元测试环境下不出现 Electron。
function _resolveTtsTmpRoot() {
  // 优先 userData/.tmp
  try {
    const electron = require('electron');
    const app = electron && (electron.app || (electron.default && electron.default.app));
    if (app && typeof app.getPath === 'function') {
      const ud = app.getPath('userData');
      if (ud) {
        const dir = path.join(ud, '.tmp');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) {}
        try {
          // 探测性写入：保证 root 在权限上可写
          const probe = path.join(dir, '.write-probe');
          fs.writeFileSync(probe, '1');
          fs.unlinkSync(probe);
        } catch (_e) {}
        return dir;
      }
    }
  } catch (_e) { /* 非 Electron 环境 / require 失败 → fallback */ }
  // fallback：os.tmpdir()/rokit（仍独立于其他程序）
  const fallback = path.join(os.tmpdir(), 'rokit');
  try { fs.mkdirSync(fallback, { recursive: true }); } catch (_e) {}
  return fallback;
}

function _convertToWav16kMono(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input).replace(/^data:audio\/[a-z0-9]+;base64,/, ''), 'base64');
  const r = ffmpegResolver.resolveFfmpegPath();
  if (!r.ok) return { ok: false, reason: 'no-ffmpeg:' + (r.reason || 'unknown'), buf: buf };
  const exe = r.path;
  const inExt = _sniffAudioExt(buf);
  // 把输入写到临时文件以便 ffmpeg 读（**不**覆盖任何用户文件 —— 用户原档在 voice-profiles 目录下）
  // 输入仍用 OS tmpdir（只读不冲突），输出改写到 _resolveTtsTmpRoot()（更可靠的写权限）。
  const tmpIn = path.join(os.tmpdir(), 'rokit-tts-in-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + inExt);
  let tmpRoot;
  try { tmpRoot = _resolveTtsTmpRoot(); }
  catch (_e) { tmpRoot = os.tmpdir(); }
  const tmpOut = path.join(tmpRoot, 'rokit-tts-out-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '.wav');
  try {
    fs.writeFileSync(tmpIn, buf);
  } catch (e) {
    return { ok: false, reason: 'tmpdir-write-failed:' + (e && e.message || e), buf: buf };
  }
  // 用 16k / mono / PCM s16le：XTTS-v2 官方推荐的参考音频格式
  const args = [
    '-y',
    '-i', tmpIn,
    '-ac', '1',
    '-ar', '16000',
    '-acodec', 'pcm_s16le',
    '-f', 'wav',
    tmpOut
  ];
  return new Promise(function (resolve) {
    let stderr = '';
    let proc;
    try {
      proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      try { fs.unlinkSync(tmpIn); } catch (_e) {}
      return resolve({ ok: false, reason: 'ffmpeg-spawn-failed:' + (e && e.message || e), buf: buf });
    }
    const timeoutMs = 30000;
    const t = setTimeout(function () {
      try { proc.kill('SIGKILL'); } catch (_e) {}
      try { fs.unlinkSync(tmpIn); } catch (_e) {}
      try { fs.unlinkSync(tmpOut); } catch (_e) {}
      resolve({ ok: false, reason: 'ffmpeg-timeout:' + timeoutMs + 'ms', buf: buf });
    }, timeoutMs);
    proc.stderr.on('data', function (b) { stderr += b.toString(); });
    proc.on('error', function (e) {
      clearTimeout(t);
      try { fs.unlinkSync(tmpIn); } catch (_e) {}
      try { fs.unlinkSync(tmpOut); } catch (_e) {}
      resolve({ ok: false, reason: 'ffmpeg-error:' + (e && e.message || e), buf: buf });
    });
    proc.on('close', function (code) {
      clearTimeout(t);
      try { fs.unlinkSync(tmpIn); } catch (_e) {}
      if (code !== 0) {
        try { fs.unlinkSync(tmpOut); } catch (_e) {}
        // 区分"输出文件无法访问"（Permission denied / EACCES / EPERM），
        //   让上层能给出可操作的提示。**不**归因到具体进程，仅提示重试 + 检查应用临时目录权限或安全软件。
        if (/Permission denied|EACCES|EPERM/i.test(stderr)) {
          return resolve({
            ok: false,
            reason: 'ffmpeg-output-not-writable:' + code + ':' + stderr.slice(-400),
            buf: buf,
            actionableHint: 'FFmpeg 转换时无法写入应用的临时输出目录。请先重试一次；若问题持续，请检查应用临时目录（' + tmpRoot + '）的写入权限或确认是否有安全软件拦截。'
          });
        }
        return resolve({ ok: false, reason: 'ffmpeg-exit-' + code + ':' + stderr.slice(-400), buf: buf });
      }
      try {
        const wavBuf = fs.readFileSync(tmpOut);
        try { fs.unlinkSync(tmpOut); } catch (_e) {}
        // v1.20.10：转码后必须验证输出是合法 WAV，避免 ffmpeg 异常时产生"假 WAV"
        const v = _validateWavBuffer(wavBuf);
        if (!v.ok) {
          return resolve({ ok: false, reason: 'ffmpeg-output-not-valid-wav:' + v.reason, buf: wavBuf });
        }
        resolve({ ok: true, buf: wavBuf, ext: '.wav', sampleRate: v.sampleRate, channels: v.channels, dataBytes: v.dataBytes });
      } catch (e) {
        resolve({ ok: false, reason: 'tmpdir-read-failed:' + (e && e.message || e), buf: buf });
      }
    });
  });
}

function _writeRefWavToTemp(b64) {
  // 同步接口（向后兼容）：解码 → 嗅探 → 是 WAV 直接写；否则 fallback
  const cleanB64 = String(b64).replace(/^data:audio\/[a-z0-9]+;base64,/, '');
  const buf = Buffer.from(cleanB64, 'base64');
  if (!buf || buf.length < 100) {
    return { ok: false, error: 'ref-audio-too-small:' + (buf ? buf.length : 0) };
  }
  const sniffedExt = _sniffAudioExt(buf);
  if (sniffedExt === '.wav') {
    const v = _validateWavBuffer(buf);
    if (v.ok) return _writeBufferToTemp(buf, '.wav');
  }
  // 非 WAV 或 WAV 校验失败 —— 留给异步主流程 _convertToWav16kMono 处理
  return { ok: false, error: 'ref-needs-async-convert', sniffedExt: sniffedExt };
}

function _writeBufferToTemp(buf, ext) {
  // v1.20.10 紧急回归修复：拒绝 .bin 当作有效参考音频。
  //   .bin 只能来自 _sniffAudioExt 兜底（说明 sniff 失败，bytes 真的不可识别）；
  //   把 .bin 写到 tmpdir / 喂给 XTTS 必然被拒（librosa 不识 → Format not recognised）。
  //   此处硬性 fail，强制调用方走「先转码为真 WAV」路径。
  if (ext === '.bin') {
    return {
      ok: false,
      error: 'ref-format-unrecognized',
      actionableHint: '参考音频字节无法被嗅探为已知格式（RIFF/WAVE、OggS、EBML/WebM、ftyp）。请重新录制或检查声音档案是否损坏。'
    };
  }
  // 仅接受 1-5 字符的扩展名；不再兜底为 .bin（防止扩展名被当作有效格式）。
  const safeExt = (ext && /^\.[a-z0-9]{2,5}$/.test(ext)) ? ext : null;
  if (!safeExt) {
    return { ok: false, error: 'ref-invalid-ext:' + String(ext), actionableHint: '临时文件扩展名非法。' };
  }
  const filename = 'rokit-tts-speaker-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + safeExt;
  const fullPath = path.join(os.tmpdir(), filename);
  try {
    fs.writeFileSync(fullPath, buf);
    return { ok: true, path: fullPath, size: buf.length, ext: safeExt, originalFormat: safeExt, needsConvert: safeExt !== '.wav' };
  } catch (e) {
    return { ok: false, error: 'tmpdir-write-failed:' + (e && e.message || e) };
  }
}

function _cleanupRefWav(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_e) {}
}

// XTTS-v2 language_id 自动判定。
//   故障根因：原实现把 language_id 硬编码成 'en'，中文文本也被强制按英文音素合成，
//   产出的是「不明所以的声音」而非正确中文朗读。
//   实测（本机 tts-server 5002）：同一句「你好世界，这是一个测试。」
//     language_id=en     → 2.82s / 124492 B
//     language_id=zh-cn  → 3.89s / 171596 B
//   语言不匹配时不仅时长偏短，发音也完全错误。
//   这里按"CJK 表意文字占比"判定：>=15% 视为中文，其余按英文。
//   调用方仍可通过 payload.languageId / config.languageId 显式覆盖。
function _detectXttsLanguage(text) {
  const s = String(text || '');
  if (!s.trim()) return 'en';
  let cjk = 0, letters = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)
        || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3040 && c <= 0x30ff)) {
      cjk++;
      if (c >= 0x10000) i++; // 代理对，跳过低位
    } else if (/[A-Za-z]/.test(s[i])) {
      letters++;
    }
  }
  const total = cjk + letters;
  if (total > 0 && cjk / total >= 0.15) return 'zh-cn';
  return 'en';
}

async function xttsTestGenerate(config, text, refB64, payload) {
  const cfg = config || {};
  const baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: 'no-baseUrl' };
  // v1.20.10 紧急回归修复：补齐参数，让 refMime 真正能从 renderer 传入。
  //   旧调用方 (config, text, refB64) 也能继续工作 —— payload 是可选参数。
  //   显式用 const _payload = payload || {} 兜底，避免对 _payload.refMime 报 undefined。
  const _payload = payload || {};
  // 语言：优先调用方显式指定，其次自动判定（不再硬编码 'en'）
  const _languageId = String(
    (_payload && _payload.languageId) || cfg.languageId || _detectXttsLanguage(text) || 'en'
  ).toLowerCase();

  // XTTS-v2 必须有参考音频（无参考时服务端会用任意/默认音色 = 伪造）
  if (!refB64 || !String(refB64).trim()) {
    return {
      ok: false,
      error: 'XTTS-v2 需要参考音频（speaker_wav）才能合成，且不能使用默认音色。请先在「声音档案」保存一段录音，再选为当前配音。',
      capabilities: { referenceAudio: 'required' }
    };
  }

  // 1) 落盘 base64 → 绝对路径（嗅探真实格式，**不**硬编码 .wav 扩展名）
  const _cleanB64 = String(refB64).replace(/^data:audio\/[a-z0-9]+;base64,/, '');
  const _rawBuf = Buffer.from(_cleanB64, 'base64');
  // v1.20.10 兜底：解码后数据太短（< 100B）→ 直接拒绝（防止空 / 截断数据传进 XTTS 触发 500）
  if (!_rawBuf || _rawBuf.length < 100) {
    return {
      ok: false,
      error: 'ref-audio-too-small:' + (_rawBuf ? _rawBuf.length : 0),
      actionableHint: '所选声音档案版本数据过短或为空，请重新保存一段更长的录音（建议 3 秒以上）。'
    };
  }
  const _sniffedExt = _sniffAudioExt(_rawBuf);

  // 优先信任 renderer 传来的 refMime（如 "audio/webm;codecs=opus"）；嗅探结果仅作兜底
  var _refMime = '';
  try {
    if (typeof _payload.refMime === 'string') _refMime = String(_payload.refMime).toLowerCase();
  } catch (_e) {}
  // v1.20.10 严格流程：写盘之前**必须**确认得到的是真实 WAV。
  //   - 若 bytes 已经是合法 WAV（且 mime 没说不是 wav）→ 直接写盘为 .wav
  //   - 否则 → 调 ffmpeg 转码为 16k/mono/PCM WAV；失败 → **不**继续调用 XTTS，返回明确错误
  let _refBuf = _rawBuf;
  let _refExt = _sniffedExt;
  let _refSampleRate = 0;
  let _refChannels = 0;

  // 1) 先看原始 bytes 是不是合法 WAV（**必须** RIFF/WAVE + 44B + 有效 fmt + 非空 data）
  const _isAlreadyWav = (_sniffedExt === '.wav' && _validateWavBuffer(_rawBuf).ok)
                       || _refMime.indexOf('wav') >= 0;
  if (_isAlreadyWav) {
    // 已是 WAV：但仍用 _validateWavBuffer 二次校验（mime 可能撒谎）
    const v = _validateWavBuffer(_rawBuf);
    if (v.ok) {
      _refExt = '.wav';
      _refSampleRate = v.sampleRate;
      _refChannels = v.channels;
    } else {
      // mime 说 wav 但 bytes 不是 → 走转码路径
      const conv = await _convertToWav16kMono(_rawBuf);
      if (!conv || !conv.ok) {
        return {
          ok: false,
          error: '参考音频字节与 mime 不一致，且无法转码：' + (conv && conv.reason || 'unknown'),
          actionableHint: (conv && conv.actionableHint) || '请重新录制一段 3 秒以上的声音档案，或检查 ffmpeg 是否可用。'
        };
      }
      _refBuf = conv.buf;
      _refExt = '.wav';
      _refSampleRate = conv.sampleRate || 16000;
      _refChannels = conv.channels || 1;
    }
  } else {
    // 2) 非 WAV —— 必须转码为 WAV；ffmpeg 不可用 / 转码失败 → 明确报错，**不**继续调 XTTS
    const conv = await _convertToWav16kMono(_rawBuf);
    if (!conv || !conv.ok) {
      const reason = (conv && conv.reason) || 'unknown';
      // 1) _convertToWav16kMono 内已经给出过 actionableHint（例如输出目录权限）→ 优先用
      if (conv && conv.actionableHint) {
        return {
          ok: false,
          error: '无法将参考音频（' + (_refMime || _sniffedExt || '未知') + '）转换为 XTTS-v2 接受的 WAV：' + reason,
          actionableHint: conv.actionableHint
        };
      }
      const hint = /no-ffmpeg/.test(reason)
        ? '当前 Rokit 无法转换 WebM/Opus 录音为 WAV。请安装 ffmpeg（或确认 bundled ffmpeg-static 二进制可执行）。'
        : '请重新录制一段 3 秒以上的声音档案，或检查 ffmpeg 是否可用。';
      return {
        ok: false,
        error: '无法将参考音频（' + (_refMime || _sniffedExt || '未知') + '）转换为 XTTS-v2 接受的 WAV：' + reason,
        actionableHint: hint
      };
    }
    _refBuf = conv.buf;
    _refExt = '.wav';
    _refSampleRate = conv.sampleRate || 16000;
    _refChannels = conv.channels || 1;
  }

  // 3) **写盘之前**最后一次确认：bytes 是合法 WAV（防止转码异常）
  const _finalWav = _validateWavBuffer(_refBuf);
  if (!_finalWav.ok) {
    return {
      ok: false,
      error: '转码后输出不是合法 WAV：' + _finalWav.reason,
      actionableHint: '请重新录制或更换声音档案。'
    };
  }

  const _refRes = _writeBufferToTemp(_refBuf, _refExt);
  if (!_refRes.ok) {
    return {
      ok: false,
      error: '无法在临时目录写入参考音频：' + _refRes.error,
      actionableHint: '请检查 OS 临时目录（' + os.tmpdir() + '）是否可写'
    };
  }
  const _refPath = _refRes.path;
  let _speakerWavOk = true;
  let _lastDetail = '';
  try {
    // 2) 尝试 Coqui 默认契约：form-encoded + 同名参数（text / speaker_id / language_id / style_wav / speaker_wav）
    const _formBody = new URLSearchParams({
      text: String(text || ''),
      language_id: _languageId,
      speaker_wav: _refPath
    }).toString();
    let _r = await _buildRequest(baseUrl + '/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'audio/wav,audio/*' },
      body: _formBody,
      timeoutMs: 60000
    });
    if (_r.ok && _okStatus(_r.status) && _r.body && _r.body.length > 100) {
      const _mime = (_r.headers && _r.headers['content-type']) || 'audio/wav';
      return {
        ok: true,
        mime: String(_mime).split(';')[0],
        audio: _r.body,
        status: _r.status,
        speakerPath: _refPath,
        languageId: _languageId,
        refMime: _refMime || '',
        refExt: _refExt,
        refSampleRate: _refSampleRate,
        refChannels: _refChannels
      };
    }
    _lastDetail = 'form: ' + (_r && _r.error ? _r.error : 'http-' + (_r && _r.status)) +
      (_r && _r.text ? ' body=' + _r.text.substring(0, 200) : '');

    // 3) 兜底：headers 形态（部分 fork 用 query string 头部传参）
    _r = await _buildRequest(baseUrl + '/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'text': String(text || ''),
        'language-id': _languageId,
        'speaker-wav': _refPath,
        Accept: 'audio/wav,audio/*'
      },
      body: _formBody,
      timeoutMs: 60000
    });
    if (_r.ok && _okStatus(_r.status) && _r.body && _r.body.length > 100) {
      const _mime = (_r.headers && _r.headers['content-type']) || 'audio/wav';
      return {
        ok: true,
        mime: String(_mime).split(';')[0],
        audio: _r.body,
        status: _r.status,
        speakerPath: _refPath
      };
    }
    _lastDetail += ' | headers: ' + (_r && _r.error ? _r.error : 'http-' + (_r && _r.status)) +
      (_r && _r.text ? ' body=' + _r.text.substring(0, 200) : '');

    // v1.20.10 紧急回归修复：根据 errorDetail 内容给出可操作的具体提示（不再笼统）。
    var _xttsHint;
    if (/Format not recognised/i.test(_lastDetail)) {
      _xttsHint = 'XTTS-v2 拒读了参考音频（Format not recognised）。常见原因：① 原始录音是 WebM/Opus 而 ffmpeg 转码后输出仍是坏的 / 转码失败；② 临时 WAV 文件被截断。检查：本机器 ffmpeg 是否能处理 opus webm（运行 ffmpeg -hide_banner -formats | findstr opus），以及 soundfile 库是否支持 Opus。';
    } else if (/Model .* not loaded|loading|not.*available|model not.*found/i.test(_lastDetail)) {
      _xttsHint = 'XTTS-v2 模型尚未加载完成（首次启动需要几分钟）。请稍后重试。';
    } else {
      _xttsHint = '请检查：① 端口（默认 5002）是否正确；② 是否已传参考音频；③ tts-server 是否已加载模型（首次加载需要几分钟）。';
    }
    return {
      ok: false,
      error: 'xtts-no-endpoint-accepted-test-request',
      errorDetail: _lastDetail,
      actionableHint: _xttsHint
    };
  } catch (e) {
    _speakerWavOk = false;
    return {
      ok: false,
      error: 'xtts-exception:' + (e && e.message || e),
      actionableHint: '调用本地服务时抛出异常。请检查 tts-server 是否在运行。'
    };
  } finally {
    if (_speakerWavOk) _cleanupRefWav(_refPath);
    else _cleanupRefWav(_refPath); // 无论成功失败都清，避免临时目录堆积
  }
}

// 简易音频时长探测：扫描 WAV RIFF 头；其他格式返回 0（不伪造）
function wavDurationSec(buf) {
  if (!buf || buf.length < 44) return 0;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return 0;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  // fmt chunk 通常在 byte 12..36
  const sampleRate = buf.readUInt32LE(24);
  const bytesPerSample = buf.readUInt16LE(34) / 8;
  const channels = buf.readUInt16LE(22);
  const dataOffset = buf.indexOf('data');
  if (dataOffset < 0) return 0;
  const dataSize = buf.readUInt32LE(dataOffset + 4);
  if (sampleRate > 0 && bytesPerSample > 0 && channels > 0) {
    return dataSize / (sampleRate * bytesPerSample * channels);
  }
  return 0;
}

// MP3 帧时长探测（纯解析，不落盘、不调 ffmpeg）。
//   必要性：ElevenLabs 默认返回 MP3，而 MP3 无文件头时长的容器，
//   wavDurationSec 拿不到值。若返回 0，字幕编辑器会把该段判为「未生成配音」。
//   做法：跳过 ID3v2 标签 → 逐帧累加 (samplesPerFrame / sampleRate)。
//   只在能解析出可信结果时返回 > 0，否则返回 0（绝不伪造时长）。
const _MP3_BITRATES_V1_L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const _MP3_BITRATES_V2_L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
const _MP3_RATES = {
  3: [44100, 48000, 32000],  // MPEG1
  2: [22050, 24000, 16000],  // MPEG2
  0: [11025, 12000, 8000]    // MPEG2.5
};
function mp3DurationSec(buf) {
  if (!buf || buf.length < 128) return 0;
  let off = 0;
  // 跳过 ID3v2（大小是 4 个 syncsafe 字节）
  if (buf.toString('latin1', 0, 3) === 'ID3') {
    if (buf.length < 10) return 0;
    const sz = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + sz;
    if (off >= buf.length) return 0;
  }
  let frames = 0;
  let totalSec = 0;
  let guard = 0;
  while (off + 4 <= buf.length && guard++ < 200000) {
    if (buf[off] !== 0xff || (buf[off + 1] & 0xe0) !== 0xe0) {
      off++; // 丢一个字节重扫，容忍帧间垃圾 / 填充
      continue;
    }
    const verBits = (buf[off + 1] >> 3) & 0x03;  // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (buf[off + 1] >> 1) & 0x03; // 1 = Layer III
    const rates = _MP3_RATES[verBits];
    if (!rates || layerBits !== 1) { off++; continue; }
    const rateIdx = (buf[off + 2] >> 2) & 0x03;
    if (rateIdx === 3) { off++; continue; }
    const bitrateIdx = (buf[off + 2] >> 4) & 0x0f;
    if (bitrateIdx === 0 || bitrateIdx === 15) { off++; continue; }
    const padBit = (buf[off + 2] >> 1) & 0x01;
    const sr = rates[rateIdx];
    const br = (verBits === 3 ? _MP3_BITRATES_V1_L3 : _MP3_BITRATES_V2_L3)[bitrateIdx] * 1000;
    if (!sr || !br) { off++; continue; }
    const spf = verBits === 3 ? 1152 : 576; // MPEG1 每帧 1152 采样，MPEG2/2.5 为 576
    const frameLen = Math.floor((spf / 8) * br / sr) + padBit;
    if (frameLen < 4) { off++; continue; }
    totalSec += spf / sr;
    frames++;
    off += frameLen;
  }
  // 至少解出 2 帧才认为结果可信（1 帧可能是误命中）
  return frames >= 2 ? totalSec : 0;
}

// ===== IPC ===================================================================

function listEngines() {
  return ENGINES.map(function (e) {
    return {
      id: e.id,
      label: e.label,
      kind: e.kind,
      description: e.description,
      implemented: !!e.implemented,
      capabilities: Object.assign({}, e.capabilities),
      defaults: e.defaults || null
    };
  });
}

// v1.20.10 通用 HTTP 服务可达性探测：使用每款引擎自己的 healthPaths 探测真实端点。
// 返回 4 个独立状态：
//   - reachable:    端口是否有进程响应（任何 HTTP 状态都算）
//   - api-shape:    'matches-engine' / 'unknown-service' / 'no-response'
//   - engineMatch:  boolean —— 探测到的服务像不像本引擎
//   - modelLoaded:  boolean —— 仅对 xtts-v2 通过 /locales 检查；其余 false（不能远程探测）
// 我们**不**把 reachable 当作"接口可用"，也不把"任意 200"当作"已连接"。
async function genericLocalProbe(engineId, config) {
  const cfg = config || {};
  const baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) {
    return {
      ok: false,
      error: 'no-baseUrl',
      actionableHint: '请填写本地服务地址（含端口），例如 http://127.0.0.1:5002',
      capabilities: {}
    };
  }
  const eng = ENGINES.filter(function (x) { return x.id === engineId; })[0];
  const healthPaths = (eng && eng.healthPaths) || ['/'];
  const caps = {
    reachable: false,
    apiShape: 'no-response',
    engineMatch: false,
    modelLoaded: false,
    synthesizeEndpointFound: null,
    authRequired: false,
    referenceAudio: eng && eng.capabilities ? eng.capabilities.referenceAudio : 'unverified',
    languages: eng && eng.capabilities ? eng.capabilities.languages : 'unverified',
    outputFormat: eng && eng.capabilities ? eng.capabilities.outputFormat : 'unverified',
    notes: [],
    framework: (eng && eng.framework) || 'unknown'
  };
  let firstReachable = null;
  let lastErrDetail = '';
  let matchedEndpoint = null;
  let engineSpecificMatch = false; // 是否命中 engine-specific 路径（非通用 /）
  let genericRootReached = false;  // 是否 通用 / 返回 200/3xx
  let genericRootStatus = null;
  // v1.20.10：引擎-specific 路径（≠'/'）必须至少一个命中；纯 / 200 不能冒充。
  const GENERIC_ROOTS = new Set(['/', '/index', '/index.html']);
  for (const p of healthPaths) {
    const r = await _buildRequest(baseUrl + p, { method: 'GET', timeoutMs: 5000 });
    if (!r.ok) {
      if (/ECONNREFUSED|request-error.*ECONNREFUSED/.test(r.error || '')) {
        return {
          ok: false,
          error: 'no-endpoint-responding',
          errorDetail: r.error,
          actionableHint: '当前端口没有服务在监听。请确认：① 你启动的是' + (eng && eng.label || engineId) + '对应的服务；② 端口与默认一致（' +
            (eng && eng.defaults && eng.defaults.baseUrl || '?') + '）；③ 服务已成功启动（部分模型首次加载需要数分钟）。',
          capabilities: caps
        };
      }
      lastErrDetail = p + ':' + (r.error || 'request-failed');
      continue;
    }
    const st = r.status;
    if (GENERIC_ROOTS.has(p)) {
      if (st >= 200 && st < 400) {
        // 通用 / 返回 2xx/3xx：说明端口有 HTTP 服务在跑
        caps.reachable = true;
        firstReachable = p;
        genericRootReached = true;
      }
      genericRootStatus = st;
      continue;
    }
    if (st >= 200 && st < 400) {
      caps.reachable = true; firstReachable = p; matchedEndpoint = p;
      engineSpecificMatch = true; caps.apiShape = 'matches-engine'; break;
    }
    if (st === 405 || st === 400) {
      caps.reachable = true; firstReachable = p; matchedEndpoint = p;
      engineSpecificMatch = true; caps.apiShape = 'matches-engine'; break;
    }
    if (st === 401) {
      caps.reachable = true; firstReachable = p; firstReachable = p; matchedEndpoint = p;
      caps.authRequired = true; engineSpecificMatch = true; caps.apiShape = 'matches-engine'; break;
    }
    lastErrDetail = p + ':404';
  }
  // 处理 engine-specific 全 404 + 仅 / 通的情况：
  //   仅当所有 healthPaths 都是 / 或 engine-specific 命中过，否则不接收 / 200
  const engineSpecificPaths = healthPaths.filter(p => !GENERIC_ROOTS.has(p));
  if (!engineSpecificMatch) {
    if (genericRootReached && engineSpecificPaths.length === 0) {
      // healthPaths 仅是通用 / （如 f5-tts 用 / 而非 /info）—— 这是合法配置
      caps.reachable = true;
      caps.apiShape = 'matches-engine';
      firstReachable = '/';
      matchedEndpoint = '/';
      engineSpecificMatch = true;
    }
    // 否则：通用 / 不能冒充；engineMatch 留为 false
  }
  caps.engineMatch = engineSpecificMatch;
  caps.synthesizeEndpointFound = matchedEndpoint;
  if (!caps.engineMatch && caps.reachable) {
    return {
      ok: false,
      error: 'unknown-service',
      errorDetail: '服务可访问但 engine-specific 路径都返回 404（' + lastErrDetail + '）。通用 / 返回 ' + genericRootStatus,
      actionableHint: '当前端口有 HTTP 服务在监听，但不是 ' + (eng && eng.label ? eng.label : engineId) + '。请确认你启动的是 ' + (eng && eng.label || engineId) + ' 的服务（端口 / 路径）。',
      capabilities: caps
    };
  }
  if (!caps.reachable) {
    let hint = '';
    if (/ECONNREFUSED|request-error.*ECONNREFUSED/.test(lastErrDetail)) {
      hint = '当前端口没有服务在监听。请确认：① 你启动的是' + (eng && eng.label || engineId) + '对应的服务；② 端口与默认一致（' +
        (eng && eng.defaults && eng.defaults.baseUrl || '?') + '）；③ 服务已成功启动（部分模型首次加载需要数分钟）。';
    } else if (/timeout/.test(lastErrDetail)) {
      hint = '连接超时。检查地址是否能访问、防火墙是否放行该端口。';
    } else if (/ENOTFOUND|EAI_AGAIN/.test(lastErrDetail)) {
      hint = '无法解析主机名。请检查 baseUrl 的 hostname 部分（例如 127.0.0.1）。';
    } else if (lastErrDetail) {
      hint = '所有候选路径都返回错误：' + lastErrDetail;
    } else {
      hint = '请确认服务在运行，且 baseUrl 正确。';
    }
    return {
      ok: false,
      error: 'no-endpoint-responding',
      errorDetail: lastErrDetail,
      actionableHint: hint,
      capabilities: caps
    };
  }
  return {
    ok: true,
    capabilities: caps,
    reachEndpoint: firstReachable
  };
}

// ===== v1.21：线上语音引擎适配器（OpenAI TTS / ElevenLabs TTS） =====
//
// 设计约束：
//   - 密钥**只**在主进程内从 secrets.js（keytar）读取；本模块任何日志 / 返回值都不含密钥。
//   - 网络层复用本文件既有的 _buildRequest（零新增依赖，不引入 openai / @elevenlabs/sdk）。
//   - 「测试连接」只做**轻量认证请求**（列模型 / 列音色，不产生音频、不计费）；
//     「测试语音生成」才真正 POST 合成。两者在 UI 上分开显示，不混为一谈。

// 读取线上引擎密钥；返回 '' 表示未配置（**不**把 key 写进任何日志字段）
async function _readOnlineKey(engineId) {
  let secrets = null;
  try { secrets = require('./secrets'); } catch (_e) { return ''; }
  try {
    if (engineId === 'openai-tts') return (await secrets.getOpenaiTtsKey()) || '';
    if (engineId === 'elevenlabs-tts') return (await secrets.getElevenlabsTtsKey()) || '';
  } catch (_e) {}
  return '';
}

// 把上游 HTTP 错误翻译成可操作的中文提示。
//   注意：网络不可达（ENOTFOUND/ECONNREFUSED）与「密钥无效」是**不同**故障，
//   必须分开表述，否则用户会误以为密钥有问题而去反复重填。
function _onlineErrorHint(engineId, status, errText, bodyText) {
  const et = String(errText || '');
  const bt = String(bodyText || '');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(et)) {
    return '无法解析服务域名（DNS 失败）。请检查网络连接 / 代理设置，或在配置里改用可访问的 Base URL。';
  }
  if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(et)) {
    return '无法连接到服务器（连接被拒绝或中断）。请检查网络 / 代理 / Base URL 是否正确。';
  }
  if (/ETIMEDOUT|timeout|aborted/i.test(et)) {
    return '请求超时。请检查网络状况后重试。';
  }
  if (status === 401) return 'API Key 无效或已撤销。请到服务端确认 Key 状态后重新配置。';
  if (status === 403) return 'API Key 权限不足，或当前订阅不包含语音合成能力。请检查服务端权限与套餐。';
  if (status === 429) return '请求被限流或额度不足（HTTP 429）。请降低频率或检查账户额度 / 账单。';
  if (status === 422) {
    if (/voice_id|voice/i.test(bt)) return 'Voice ID 无效或不属于当前账户。请到 Voice Library 复制正确的 Voice ID。';
    if (/model/i.test(bt)) return '模型 ID 不受支持或无权限。请改用账户可用的模型 ID。';
    return '请求参数不被服务端接受（HTTP 422）：' + bt.substring(0, 200);
  }
  if (status === 404) return '接口路径不存在（HTTP 404）。请确认 Base URL 是否指向官方地址且未多余拼接路径。';
  if (status >= 500) return '服务端错误（HTTP ' + status + '）。这是服务商侧的问题，请稍后重试。';
  if (status > 0) return '接口返回 HTTP ' + status + (bt ? '：' + bt.substring(0, 200) : '');
  return '网络请求失败：' + (et || bt || '未知错误');
}

// 统一的音频合法性校验：过短 / 非音频 → 明确失败（不伪装成成功）
function _validateAudioBuffer(buf, engineLabel) {
  if (!buf || !buf.length) {
    return { ok: false, error: 'empty-audio', actionableHint: engineLabel + ' 返回了空音频数据，请稍后重试。' };
  }
  if (buf.length < 128) {
    return {
      ok: false,
      error: 'audio-too-small:' + buf.length,
      actionableHint: engineLabel + ' 返回的音频过小（' + buf.length + ' 字节），不是有效音频。请重试或缩短测试文本。'
    };
  }
  return { ok: true };
}

// OpenAI TTS：POST {baseUrl}/v1/audio/speech
//   官方契约（https://developers.openai.com/api/docs/guides/text-to-speech）：
//     header Authorization: Bearer <key>、Content-Type: application/json
//     body  { model, input, voice, instructions?, response_format? }
//   默认模型 gpt-4o-mini-tts（官方当前推荐的最新模型）；默认音色 alloy（13 个内置音色之一）。
async function openaiTtsGenerate(config, text, payload) {
  const cfg = config || {};
  const baseUrl = String(cfg.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  const key = await _readOnlineKey('openai-tts');
  if (!key) {
    return {
      ok: false,
      error: 'missing-api-key',
      actionableHint: '请先在 Rokit 设置的「YouTube / 线上语音」区配置 OpenAI TTS API Key。'
    };
  }
  const input = String(text || '').trim();
  if (!input) {
    return { ok: false, error: 'empty-text', actionableHint: '请输入要合成的文本内容。' };
  }
  // 官方文档：voice 由模型支持集决定；gpt-4o-mini-tts 支持 alloy/ash/ballad/coral/echo/
  // fable/marin/cedar/nova/onyx/sage/shimmer/verse。这里不硬校验，交给服务端判定。
  const model = String(cfg.model || 'gpt-4o-mini-tts').trim();
  const voice = String(cfg.voice || 'alloy').trim();
  const instructions = String(cfg.instructions || '').trim();
  // 强制 wav：与 XTTS-v2 的输出约定一致，且 wavDurationSec 可直接解析真实时长
  const responseFormat = 'wav';
  const bodyObj = { model: model, input: input, voice: voice, response_format: responseFormat };
  if (instructions) bodyObj.instructions = instructions;

  const r = await _buildRequest(baseUrl + '/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Accept': 'audio/wav,audio/*'
    },
    body: JSON.stringify(bodyObj),
    timeoutMs: 60000
  });
  if (!r.ok) {
    return { ok: false, error: 'network-error', errorDetail: String(r.error || ''), actionableHint: _onlineErrorHint('openai-tts', 0, r.error, '') };
  }
  if (r.status !== 200) {
    return {
      ok: false,
      error: 'openai-tts-http-' + r.status,
      errorDetail: String(r.text || '').substring(0, 300),
      actionableHint: _onlineErrorHint('openai-tts', r.status, '', r.text)
    };
  }
  const v = _validateAudioBuffer(r.body, 'OpenAI TTS');
  if (!v.ok) return v;
  // 必须是真 WAV（RIFF/WAVE 头），否则 wavDurationSec 拿不到时长
  const wv = _validateWavBuffer(r.body);
  if (!wv.ok) {
    return {
      ok: false,
      error: 'unexpected-audio-format',
      actionableHint: 'OpenAI TTS 未返回预期的 WAV 音频（content-type 与实际数据不符），无法解析时长。请重试。'
    };
  }
  return {
    ok: true,
    mime: 'audio/wav',
    audio: r.body,
    status: r.status,
    model: model,
    voice: voice,
    languageId: ''
  };
}

// ElevenLabs TTS：POST {baseUrl}/v1/text-to-speech/{voice_id}?output_format=...
//   官方契约（https://elevenlabs.io/docs/api-reference/text-to-speech/convert）：
//     header xi-api-key: <key>、Content-Type: application/json
//     query  output_format（默认 mp3_44100_128）
//     body   { text, model_id? }
//   默认模型 eleven_multilingual_v2（官方端点默认值，兼容性最广）。
async function elevenlabsTtsGenerate(config, text, payload) {
  const cfg = config || {};
  const baseUrl = String(cfg.baseUrl || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const key = await _readOnlineKey('elevenlabs-tts');
  if (!key) {
    return {
      ok: false,
      error: 'missing-api-key',
      actionableHint: '请先在 Rokit 设置的「线上语音」区配置 ElevenLabs API Key。'
    };
  }
  const input = String(text || '').trim();
  if (!input) {
    return { ok: false, error: 'empty-text', actionableHint: '请输入要合成的文本内容。' };
  }
  // Voice ID 必填（用户自己的音色，不能用示例值当默认）
  const voiceId = String(cfg.voiceId || '').trim();
  if (!voiceId) {
    return {
      ok: false,
      error: 'missing-voice-id',
      actionableHint: '请填写 Voice ID。可到 elevenlabs.io/app/voice-library 复制任一音色的 ID。'
    };
  }
  const modelId = String(cfg.modelId || 'eleven_multilingual_v2').trim();
  // mp3_44100_128 是官方默认；FFmpeg 合成链路可直接识别 mp3
  const outputFormat = String(cfg.outputFormat || 'mp3_44100_128').trim();
  const bodyObj = { text: input, model_id: modelId };

  const url = baseUrl + '/v1/text-to-speech/' + encodeURIComponent(voiceId)
    + '?output_format=' + encodeURIComponent(outputFormat);
  const r = await _buildRequest(url, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg,audio/*'
    },
    body: JSON.stringify(bodyObj),
    timeoutMs: 60000
  });
  if (!r.ok) {
    return { ok: false, error: 'network-error', errorDetail: String(r.error || ''), actionableHint: _onlineErrorHint('elevenlabs-tts', 0, r.error, '') };
  }
  if (r.status !== 200) {
    return {
      ok: false,
      error: 'elevenlabs-http-' + r.status,
      errorDetail: String(r.text || '').substring(0, 300),
      actionableHint: _onlineErrorHint('elevenlabs-tts', r.status, '', r.text)
    };
  }
  const v = _validateAudioBuffer(r.body, 'ElevenLabs TTS');
  if (!v.ok) return v;
  // mp3 无文件头，靠 ID3 / MPEG sync 字节判断；两者都没有则视为无效音频
  const isMp3 = _looksLikeMp3(r.body);
  if (!isMp3) {
    return {
      ok: false,
      error: 'unexpected-audio-format',
      actionableHint: 'ElevenLabs TTS 返回的数据不像 MP3 音频，无法确认格式。请检查 output_format 配置，或重试。'
    };
  }
  return {
    ok: true,
    mime: 'audio/mpeg',
    audio: r.body,
    status: r.status,
    model: modelId,
    voice: voiceId,
    languageId: ''
  };
}

// MP3 粗判：ID3 标签 或 MPEG 帧同步字（0xFF Ex/Fx）
function _looksLikeMp3(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return true;
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  return false;
}

// 线上引擎「测试连接」：只做轻量认证请求（**不**生成音频、不计费）。
//   OpenAI   → GET /v1/models
//   ElevenLabs → GET /v1/voices
//   两者都用最轻的 GET，验证「Key 有效 + 账户可达」，不等价于合成一定成功。
async function onlineProbe(engineId, config) {
  const cfg = config || {};
  const eng = ENGINES.filter(function (x) { return x.id === engineId; })[0];
  const label = (eng && eng.label) || engineId;
  const key = await _readOnlineKey(engineId);
  if (!key) {
    return {
      ok: false,
      error: 'missing-api-key',
      actionableHint: '请先在 Rokit 设置中配置 ' + label + ' 的 API Key。',
      capabilities: eng && eng.capabilities ? Object.assign({}, eng.capabilities) : {}
    };
  }
  const baseUrl = String(cfg.baseUrl || (eng && eng.defaults && eng.defaults.baseUrl) || '').replace(/\/+$/, '');
  if (!baseUrl) {
    return { ok: false, error: 'no-baseUrl', actionableHint: '请填写服务地址（Base URL）。', capabilities: {} };
  }
  const path = engineId === 'openai-tts' ? '/v1/models' : '/v1/voices';
  const headers = engineId === 'openai-tts'
    ? { 'Authorization': 'Bearer ' + key }
    : { 'xi-api-key': key };
  const r = await _buildRequest(baseUrl + path, { method: 'GET', headers: headers, timeoutMs: 15000 });
  if (!r.ok) {
    return {
      ok: false,
      error: 'network-error',
      errorDetail: String(r.error || ''),
      actionableHint: _onlineErrorHint(engineId, 0, r.error, ''),
      capabilities: eng && eng.capabilities ? Object.assign({}, eng.capabilities) : {}
    };
  }
  if (r.status === 200) {
    return {
      ok: true,
      // 明确区分：只验证了认证可达，没验证合成
      authOnly: true,
      probeNote: '认证通过（' + path + ' 返回 200）。这**不代表**语音合成一定可用，请再点「生成测试语音」实际合成一次。',
      capabilities: eng && eng.capabilities ? Object.assign({}, eng.capabilities) : {}
    };
  }
  return {
    ok: false,
    error: 'online-http-' + r.status,
    errorDetail: String(r.text || '').substring(0, 300),
    actionableHint: _onlineErrorHint(engineId, r.status, '', r.text),
    capabilities: eng && eng.capabilities ? Object.assign({}, eng.capabilities) : {}
  };
}

async function probe(engineId, config) {
  // v1.20.10：通用本地引擎探测（每款引擎用自己配置的 healthPaths）
  // v1.21：线上引擎走 onlineProbe（真实认证请求，不再是占位）
  const eng = ENGINES.filter(function (x) { return x.id === engineId; })[0];
  if (!eng) {
    return { ok: false, error: 'unknown-engine:' + engineId };
  }
  if (eng.kind === KIND_LOCAL) {
    // xtts-v2 走真实实现（含 /locales 模型加载探测），其余走通用探测
    if (engineId === 'xtts-v2') return await xttsProbe(config || {});
    return await genericLocalProbe(engineId, config || {});
  }
  if (eng.kind === KIND_ONLINE) {
    // v1.21：真实认证探测（轻量 GET，不生成音频、不产生合成费用）
    if (engineId === 'openai-tts' || engineId === 'elevenlabs-tts') {
      return await onlineProbe(engineId, config || {});
    }
    return {
      ok: false,
      error: 'online-service-pending-key',
      actionableHint: '请先在 Rokit 设置中配置 ' + eng.label + ' 的凭据（API Key）。',
      capabilities: { referenceAudio: eng.capabilities && eng.capabilities.referenceAudio || 'unknown' }
    };
  }
  return { ok: false, error: 'engine-not-implemented:' + engineId };
}

async function testGenerate(engineId, config, payload) {
  // payload: { text, refBase64, refMime }
  // v1.20.10：xtts-v2 是第一个真实实现。
  // v1.21：OpenAI TTS / ElevenLabs TTS 也已实现（走 testGenerate 统一约定）。
  if (engineId === 'xtts-v2') {
    // v1.20.10 紧急回归修复：把整个 payload 传下去，让 _payload.refMime 真正生效
    const r = await xttsTestGenerate(config || {}, (payload || {}).text || '', (payload || {}).refBase64 || '', payload || {});
    if (r.ok) {
      const dur = wavDurationSec(r.audio);
      r.durationSec = dur;
    }
    return r;
  }
  // v1.21：线上引擎。真实 HTTP 调用，失败时返回可识别错误，不伪装成功。
  if (engineId === 'openai-tts' || engineId === 'elevenlabs-tts') {
    const text = (payload || {}).text || '';
    const cfg = config || {};
    const r = engineId === 'openai-tts'
      ? await openaiTtsGenerate(cfg, text, payload || {})
      : await elevenlabsTtsGenerate(cfg, text, payload || {});
    if (r && r.ok) {
      // WAV 直接解析 RIFF 头；MP3 逐帧累加。两者都取不到就留 0（不伪造时长）。
      r.durationSec = (r.mime === 'audio/wav')
        ? wavDurationSec(r.audio)
        : mp3DurationSec(r.audio);
    }
    return r;
  }
  return { ok: false, error: 'engine-not-implemented:' + engineId };
}

function getEngineDefaults(engineId) {
  const e = ENGINES.filter(function (x) { return x.id === engineId; })[0];
  if (!e) return null;
  return e.defaults || null;
}

// 返回引擎完整目录（含 healthPaths / framework / synthesizePath 等）
// 渲染层用这个一次性拿全所有引擎，避免再走 IPC 拆装。
function listEnginesFull() {
  return ENGINES.map(function (e) { return Object.assign({}, e); });
}

module.exports = {
  KIND_LOCAL: KIND_LOCAL,
  KIND_ONLINE: KIND_ONLINE,
  listEngines: listEngines,
  listEnginesFull: listEnginesFull,
  probe: probe,
  testGenerate: testGenerate,
  getEngineDefaults: getEngineDefaults,
  // 仅测试 / 调试导出
  _xtts: {
    probe: xttsProbe,
    testGenerate: xttsTestGenerate
  },
  _genericLocalProbe: genericLocalProbe,
  _online: {
    probe: onlineProbe,
    openaiTtsGenerate: openaiTtsGenerate,
    elevenlabsTtsGenerate: elevenlabsTtsGenerate,
    looksLikeMp3: _looksLikeMp3
  },
  wavDurationSec: wavDurationSec,
  mp3DurationSec: mp3DurationSec
};
