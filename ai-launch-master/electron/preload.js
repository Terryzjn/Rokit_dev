// Rokit · 预加载脚本：向渲染进程安全暴露能力（v1.5 增量）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 窗口控制（v1.5 自定义无边框顶栏）
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximizeChanged: (cb) => {
    const listener = function (_e, isMax) { try { cb(!!isMax); } catch (_e) {} };
    ipcRenderer.on('window:maximize-changed', listener);
    return function () { ipcRenderer.removeListener('window:maximize-changed', listener); };
  },
  // 设置（BYOK）
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  // v1.5 凭据（OS 凭据管理器）
  secretsSetApiKey: (v) => ipcRenderer.invoke('secrets:set-api-key', v),
  secretsClearApiKey: () => ipcRenderer.invoke('secrets:clear-api-key'),
  secretsStatus: () => ipcRenderer.invoke('secrets:status'),
  secretsSetGithubPat: (v) => ipcRenderer.invoke('secrets:set-github-pat', v),
  secretsClearGithubPat: () => ipcRenderer.invoke('secrets:clear-github-pat'),
  secretsMigratePlaintext: () => ipcRenderer.invoke('secrets:migrate-plaintext'),
  // 主推队列
  queueSchedule: () => ipcRenderer.invoke('queue:schedule'),
  // 反馈（采集 / 分析 / 列表）
  feedbackCollect: (payload) => ipcRenderer.invoke('feedback:collect', payload),
  feedbackAnalyze: (payload) => ipcRenderer.invoke('feedback:analyze', payload),
  feedbackList: (workId) => ipcRenderer.invoke('feedback:list', { workId: workId }),
  feedbackListClusters: (workId) => ipcRenderer.invoke('feedback:list-clusters', { workId: workId }),
  feedbackSummarize: (workId) => ipcRenderer.invoke('feedback:summarize', { workId: workId }),
  // 录制（renderer 负责 MediaRecorder，main 负责写盘）
  recorderListSources: () => ipcRenderer.invoke('recorder:list-sources'),
  recorderStart: (opts) => ipcRenderer.invoke('recorder:start', opts),
  recorderAppendChunk: (sessionId, chunk) => ipcRenderer.invoke('recorder:append-chunk', { sessionId: sessionId, chunk: chunk }),
  recorderStop: (sessionId) => ipcRenderer.invoke('recorder:stop', { sessionId: sessionId }),
  recorderDiscard: (sessionId) => ipcRenderer.invoke('recorder:discard', { sessionId: sessionId }),
  recorderListSessions: () => ipcRenderer.invoke('recorder:list-sessions'),
  recorderProbe: (path) => ipcRenderer.invoke('recorder:probe', { path: path }),
  // 视频后处理（ffmpeg-static）
  videoProcess: (input, opts) => ipcRenderer.invoke('video:process', { input: input, opts: opts }),
  videoMetadata: (input) => ipcRenderer.invoke('video:metadata', { input: input }),
  videoTranscode: (input, opts) => ipcRenderer.invoke('video:transcode', { input: input, opts: opts }),
  videoThumb: (input, opts) => ipcRenderer.invoke('video:thumb', { input: input, opts: opts }),
  videoAvailable: () => ipcRenderer.invoke('video:available'),
  // VideoSource（本地视频选择）—— Renderer 只拿 fileName/fileSize/duration；filePath 不暴露
  videoPickLocal: () => ipcRenderer.invoke('video:pick-local'),
  videoGetInternalAsset: (assetId) => ipcRenderer.invoke('video:get-internal-asset', assetId),
  videoClearInternalAsset: (assetId) => ipcRenderer.invoke('video:clear-internal-asset', assetId),
  // GitHub L1 直发
  githubPutFile: (opts) => ipcRenderer.invoke('github:put-file', opts),
  githubProbe: () => ipcRenderer.invoke('github:probe'),
  githubPickRepo: () => ipcRenderer.invoke('github:pick-repo'),
  // 渠道健康度批量探测
  channelsHealth: (channels) => ipcRenderer.invoke('channels:health', channels),
  // 作品
  listWorks: () => ipcRenderer.invoke('works:list'),
  saveWork: (w) => ipcRenderer.invoke('works:save', w),
  deleteWork: (id) => ipcRenderer.invoke('works:delete', id),
  // 发布记录
  listPubs: () => ipcRenderer.invoke('pubs:list'),
  addPub: (r) => ipcRenderer.invoke('pubs:add', r),
  // 推广渠道（增删改 + 连通性测试）
  listChannels: () => ipcRenderer.invoke('channels:list'),
  saveChannel: (c) => ipcRenderer.invoke('channels:save', c),
  deleteChannel: (id) => ipcRenderer.invoke('channels:delete', id),
  testChannel: (payload) => ipcRenderer.invoke('channels:test', payload),
  // 第三方平台 OAuth（Phase 1：GitHub）
  // 不暴露读 token 的 channel；Renderer 只能触发流程 / 查询连接状态 / 断开
  oauthStart: (providerId) => ipcRenderer.invoke('oauth:start', providerId),
  oauthStatus: (providerId) => ipcRenderer.invoke('oauth:status', providerId),
  oauthDisconnect: (providerId) => ipcRenderer.invoke('oauth:disconnect', providerId),
  oauthList: () => ipcRenderer.invoke('oauth:list'),
  // 用 refresh_token 换新 access_token；Renderer 拿不到 token 值
  // 仅返回 {ok, expiresAt, needsReconnect} 用于 UI 决定是否提示重新授权
  oauthRefresh: (providerId) => ipcRenderer.invoke('oauth:refresh', providerId),
  // BYOK：直接把 token 交给 Main（用于粘贴 PAT / API Key 等场景）
  // Main 端会调用 provider /user 验证有效性并保存到 OS 凭据管理器
  oauthSaveCredential: (providerId, payload) => ipcRenderer.invoke('oauth:save-credential', providerId, payload),
  // YouTube / Google OAuth Client 凭据由 Electron Main Process 从
  // electron/config/youtube-oauth.local.js 直接读取，**不通过 IPC 暴露**；
  // Renderer 永远拿不到 client_secret。
  // AI 能力
  generate: (req) => ipcRenderer.invoke('llm:generate', req),
  // 抓取作品信息（GitHub / 普通网址）
  fetchMeta: (url) => ipcRenderer.invoke('fetch:meta', url),
  // 自动发布浏览器（内置登录态自动填表/发布）
  pubLaunch: (platformId, payload) => ipcRenderer.invoke('pub:launch', { platformId, payload }),
  pubSubmit: (platformId, payload) => ipcRenderer.invoke('pub:submit', { platformId, payload }),
  pubOpen: (url) => ipcRenderer.invoke('pub:open', url),
  // YouTube 视频发布（v1.6）：走 YouTube Data API v3，不开浏览器
  // 进度通过 youtube:upload-progress 事件推回 renderer（见 onYoutubeUploadProgress）
  youtubePublish: (opts) => ipcRenderer.invoke('youtube:publish-video', opts || {}),
  onYoutubeUploadProgress: function (cb) {
    if (typeof cb !== 'function') return function () {};
    var listener = function (_e, info) { try { cb(info || {}); } catch (_e) {} };
    ipcRenderer.on('youtube:upload-progress', listener);
    return function () { ipcRenderer.removeListener('youtube:upload-progress', listener); };
  },
  wechatCredentialsStatus: () => ipcRenderer.invoke('wechat:credentials-status'),
  wechatCredentialsSave: (values) => ipcRenderer.invoke('wechat:credentials-save', values),
  wechatCredentialsClear: () => ipcRenderer.invoke('wechat:credentials-clear'),
  wechatDraftCreate: (payload) => ipcRenderer.invoke('wechat:draft-create', payload),
  // 抖音开放平台 OAuth + Token + API
  douyinSaveCredentials: (p) => ipcRenderer.invoke('douyin:save-credentials', p),
  douyinStartAuth: () => ipcRenderer.invoke('douyin:start-auth'),
  douyinGetAuthStatus: () => ipcRenderer.invoke('douyin:get-auth-status'),
  douyinClearAuth: () => ipcRenderer.invoke('douyin:clear-auth'),
  douyinRefreshToken: () => ipcRenderer.invoke('douyin:refresh-token'),
  douyinValidateCredentials: () => ipcRenderer.invoke('douyin:validate-credentials'),
  douyinToggleEnable: (p) => ipcRenderer.invoke('douyin:toggle-enable', p),
  douyinGetStatus: () => ipcRenderer.invoke('douyin:get-status'),
  douyinGetUserInfo: () => ipcRenderer.invoke('douyin:get-user-info'),
  // 打开外部链接（平台发布页）
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // v1.7：通用浏览器框架（内置 Session 持久化 + Publisher 适配器）
  // 每个 platformId 对应独立 Electron Session partition（persist:platform-{id}）。
  // 注意：这些方法**不**接受 Node API / BrowserWindow 句柄；只能传 platformId / URL / 简单 JSON。
  //   open(platformId)                 打开平台窗口（已存在则聚焦）
  //   close(platformId)                关闭平台窗口
  //   status()                         列出所有平台窗口状态
  //   navigate(platformId, url)        导航到 URL（必须 http/https）
  //   loginStatus(platformId)          查询平台登录状态（'logged_in'/'logged_out'/'unknown'）
  //   fill(platformId, fillData)       仅触发自动填充（不打开 publishUrl、不点发布）
  //   publish(platformId, fillData)    完整流程：open → 登录等待 → 打开 publishUrl → 自动填充 → 停止
  //   destroySession(platformId)       销毁平台的登录态（关闭后清空 Storage）
  //   diagnostics(platformId)          v1.10 白屏定位：返回最近 200 条诊断事件
  browserOpen: (platformId) => ipcRenderer.invoke('browser:open', platformId),
  browserClose: (platformId) => ipcRenderer.invoke('browser:close', platformId),
  browserStatus: () => ipcRenderer.invoke('browser:status'),
  browserNavigate: (platformId, url) => ipcRenderer.invoke('browser:navigate', platformId, url),
  browserLoginStatus: (platformId) => ipcRenderer.invoke('browser:login-status', platformId),
  browserFill: (platformId, fillData) => ipcRenderer.invoke('browser:fill', platformId, fillData),
  browserPublish: (platformId, fillData) => ipcRenderer.invoke('browser:publish', platformId, fillData),
  browserDestroySession: (platformId) => ipcRenderer.invoke('browser:destroy-session', platformId),
  browserDiagnostics: (platformId) => ipcRenderer.invoke('browser:diagnostics', platformId)
});
