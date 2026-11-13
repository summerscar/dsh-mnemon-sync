/**
 * AgentScope Platform — browser half.
 *
 * Registers two surfaces and nothing else:
 *
 *   1. `settings.section` — the plugin's own page: credentials and the model API
 *      key, the provider switch, the model catalog editor, the daily check-in,
 *      credits and contribution grants, and the paginated usage detail.
 *
 *   2. `conversation.input.right` — a small credit readout next to the model
 *      picker. It polls a credits-only endpoint, renders "—" when there is
 *      nothing to show, and never blocks the composer.
 *
 * Everything it displays comes from `/api/agentscope-platform/*` on the same
 * origin. Credentials never reach this file: the host masks them and this code
 * only ever sends the mask back as "unchanged".
 *
 * The model catalog editor follows the harness's own "add a model provider" form
 * (provider id, display name, API address, protocol, key, then a model table of
 * id / display name / context window / output cap / input types / reasoning
 * tiers, with "fetch available models" filling it from the API). Rows start as
 * text + image because the platform's chat endpoint accepts images.
 */

window.__ModuleLoader__.load({
  id: '@summerscar/dsh-connect-agentscope-platform',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'agentscope-platform'
    /**
     * Defensive translation wrapper.
     *
     * A missing dictionary entry must never take the page down: this panel renders
     * inside the host's settings modal, and one undefined string would blank the
     * whole shell. The key itself is a readable fallback.
     */
    function safeT(t, key) {
      try {
        const value = typeof t === 'function' ? t(key) : undefined
        return typeof value === 'string' && value !== '' ? value : key
      } catch { return key }
    }

    /**
     * Fill `{name}` placeholders in a translated string.
     *
     * WHY NOT `t(key).replace(...)`: a dictionary that has not resolved yet (or a
     * key a future copy edit renames) answers `undefined`, and `.replace` on
     * undefined throws INSIDE a render. React then has an error with no boundary
     * above this panel, so the whole shell — session list included — goes blank.
     * That is exactly the "click AgentScope and the workspace disappears" report.
     *
     * A missing string therefore degrades to the raw key with its placeholders
     * still visible, never to a thrown error.
     */
    function safeFill(t, key, values) {
      const template = safeT(t, key)
      return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
        Object.hasOwn(values ?? {}, name) ? String(values[name]) : whole)
    }
    const API = '/api/agentscope-platform'
    /**
     * The platform this plugin talks to — where an account, its Credits and its
     * model keys actually live. Linked from the panel header so the reader can
     * get to the console without hunting for the hostname.
     */
    const PLATFORM_URL = 'https://platform.agentscope.io/'

    // -----------------------------------------------------------------------
    // Copy
    // -----------------------------------------------------------------------

    const zh = {
      settings: 'AgentScope',
      title: 'AgentScope Platform',
      subtitle: '模型供应商（可选）、额度与用量、每日签到',
      pageLead: '把 AgentScope 平台账号接进 DSH：用它当模型供应商、在输入框下方看额度、每天自动签到。',
      platformLink: 'platform.agentscope.io',
      build: '构建',
      loading: '加载中…',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      refresh: '刷新',
      reset: '重置',
      error: '错误',
      ok: '成功',
      failed: '失败',
      never: '从未',
      none: '无',
      close: '关闭',
      remove: '删除',
      add: '添加',
      unknown: '未知',

      // account pool
      sectionAccounts: '账号池',
      accountHint: '可以并存多个账号，新的请求用「当前」这个的密钥。',
      accountAdd: '添加账号',
      accountLabel: '标签',
      accountCurrent: '计费账号',
      accountSwitch: '切换',
      accountTest: '测活',
      accountDisable: '禁用',
      accountEnable: '启用',
      accountRename: '重命名',
      accountEdit: '编辑',
      accountEditHint: '这里改的是这个账号自己的登录凭据与模型密钥，不会影响其他账号。',
      accountTokenPlaceholder: '粘贴这个账号的 refreshToken',
      accountRemove: '删除',
      accountRemoveConfirm: '确认删除该账号？',
      accountUntitled: '未命名账号',
      accountStateCurrent: '当前',
      accountStateDisabled: '已禁用',
      accountStateExpired: '凭据失效',
      accountStateLowCredit: '额度低',
      accountAutoSwitch: '按额度自动选号',
      accountAutoSwitchHint: '当前账号额度低于阈值时，自动换成额度更高的那个。',
      accountThreshold: '阈值',
      accountEmpty: '还没有任何账号。添加一个即可开始。',
      accountNoneYet: '暂无账号',
      accountCount: '{count} 个账号',
      accountSaving: '保存中…',
      accountTestFailed: '测活失败',
      accountTestOk: '测活通过',
      accountCredits: '可用额度',
      accountLastRefreshed: '最近刷新',
      accountModelKey: 'sk-as- 密钥（可选）',
      accountActivate: '添加后设为当前',
      accountSetCurrent: '设为当前',
      accountSwitchHint: '正在跑的回答不受影响，从下一次提问起换用新账号。',
      accountNeedLabel: '标签不能为空',
      accountNeedToken: '请填写 refreshToken',
      accountsGlobalHint: '全局设置',
      accountCannotDisableLast: '不能禁用最后一个可用账号',

      // credentials
      refreshToken: '登录 refreshToken',
      refreshFailed: '换取 accessToken 失败',
      phoneExchanged: '已保存并完成续期；浏览器里同一账户的登录态会随之失效，这是平台设计',
      refreshTokenHowTo: '怎么获取：在已登录 platform.agentscope.io 的浏览器里按 F12 打开控制台，执行下面这行，把结果粘到上面的输入框。',
      refreshTokenSnippet: "localStorage.getItem('refreshToken')",
      expiresIn: '剩余有效期',
      modelKeyHint: '调用模型用 Authorization: Bearer sk-as-…，不要用登录 token。',
      modelKeyEither: '两条路都行，填同一个输入框：自动获取，或手动粘贴自己的密钥。',
      modelKeyFetchHint: '用上面那个登录 refreshToken 换出平台密钥，换到就自动保存。',
      modelKeyFetchNote: '有时会取不到密钥，这是平台侧的规则，不是出错。取不到就手动粘贴。',
      modelKeyCurrent: '当前密钥',
      modelKeyMissing: '未配置',
      modelKeySourcePasted: '手动粘贴',
      modelKeySourceFetched: '自动获取',
      tokenPasteFirst: '先粘贴 refreshToken 再保存。',
      tokenHowToToggle: '怎么获取 refreshToken',
      modelKeyPasteFirst: '先粘贴密钥再保存；没有 sk-as- 密钥时请点「用登录态获取」。',
      modelKeyPaste: '粘贴 sk-as- 密钥',
      modelKeyFetch: '用登录态获取',
      modelKeyReset: '重置并重新获取',
      modelKeyResetWarn: '重置会立即吊销旧密钥',
      modelKeyFetched: '已获取并保存',
      modelKeyNotReturned: '平台这次没有返回完整密钥（只在生成/重置后显示一次），请手动粘贴或点「重置并重新获取」。',
      pullInterval: '定时拉取间隔（分钟）',

      // provider
      sectionProvider: '模型供应商',
      providerHint: '默认关闭。开启后模型选择器里才会出现 AgentScope；关闭后立即撤下，其余功能不受影响。',
      providerEnable: '启用 AgentScope 模型供应商',
      providerOn: '已启用',
      providerOff: '未启用',
      providerId: '供应商 ID',
      providerDisplayName: '显示名称',
      providerBaseUrl: 'API 地址',
      providerProtocol: 'API 协议',
      providerProtocolOpenAI: 'OpenAI Chat Completions',

      // catalog
      sectionCatalog: '模型目录',
      catalogHint: '可从接口获取、手动添加，并逐行修改元数据。新行默认「文本 + 图片」。',
      catalogSummary: '共 {count} 个模型 · 元数据 {at}',
      fetchModels: '获取可用模型',
      fetching: '正在询问平台…',
      fetchEmpty: '平台没有列出任何模型，请手动添加。',
      addModel: '添加模型',
      modelId: '模型 ID',
      modelName: '显示名称',
      modelContext: '上下文窗口',
      modelMaxTokens: '最大输出 token',
      modelInput: '输入类型',
      modelInputText: '文本',
      modelInputImage: '图片',
      modelReasoning: '推理等级',
      modelReasoningHint: '启用后把档位写入请求的推理参数；平台没有统一的参数名，可自行填。',
      modelReasoningOff: 'Off（不发送）',
      modelAdvanced: '模型选项',
      modelsEmpty: '目录为空；请添加模型或点「获取可用模型」。',
      modelIdRequired: '模型 ID 不能为空',
      modelIdDuplicate: '模型 ID 不能重复',
      modelCapacityInvalid: '容量必须是正数，可加 K 或 M 后缀',
      saveCatalog: '保存模型目录',
      catalogSaved: '模型目录已保存',
      metaSource: '元数据来源',
      metaUpdated: '最后更新',
      metaModels: '模型条目',
      metaRefresh: '立即刷新元数据',
      metaRefreshing: '刷新中…',
      metaDegraded: '远端不可用，正在使用内置快照',
      metaDetail: '字段来源',
      metaCapacityHint: '两个容量字段默认留空。留空时自动采用公开模型表参考范围的最小值（灰色数字里的下限）；表里查不到该模型才用保守默认值。灰色数字只是参考范围，不会被原样采用。需要指定时自己填一个正整数，可加 K 或 M 后缀；填了就以你为准。',
      metaBundled: '内置',
      metaRemote: '参考',
      metaUser: '手动',

      // check-in
      sectionCheckin: '每日签到',
      checkinSummary: '今日 {day}',
      checkinHint: '平台没有独立的签到接口：「每日登录 +1」由服务端在登录时自动计分。这里每天用有效登录态做一次保活，再回查贡献值明细确认当天是否真的计入。',
      checkinEnable: '启用每日自动签到',
      checkinRunNow: '立即执行一次',
      checkinRunning: '执行中…',
      checkinToday: '今日状态',
      checkinStatusIdle: '今日未执行',
      checkinStatusPending: '已保活，待平台计分',
      checkinStatusCredited: '已计入',
      checkinStatusFailed: '失败',
      checkinAttempts: '今日尝试',
      checkinLast: '最近一次',
      checkinDetail: '详情',
      checkinTimezone: '本地日按',

      // credits
      sectionCredits: '额度与贡献值',
      creditsAvailable: '可用 Credits',
      creditsLifetime: '累计积分',
      creditsRedeemable: '可兑换贡献值',
      creditsPromotion: '当前活动',
      creditsFetched: '最近拉取',
      creditsFetchNow: '立即刷新额度',
      creditUser: '账号',

      // pricing
      sectionPricing: '价目表',
      pricingSummary: '展开查看平台公布的参考价。',
      pricingHint: '平台控制台公布的参考价（Credits），按能力分组。默认收起，展开查看明细。',
      pricingLoad: '加载价目表',
      pricingLoading: '加载中…',
      pricingEmpty: '暂无可显示的价目',
      pricingPromo: '当前活动',
      pricingGroupToken: '文本',
      pricingGroupTts: '语音合成',
      pricingGroupImage: '图片',
      pricingGroupAsr: '语音识别',
      pricingGroupVideo: '视频',
      pricingGroupOther: '其他',
      pricingColModel: '模型',
      pricingColTier: '规格',
      pricingColInput: '输入',
      pricingColCache: '缓存读',
      pricingColOutput: '输出',
      pricingColUnit: '计费单位',
      pricingNeedToken: '尚未配置登录 accessToken，无法加载价目表。',

      // usage
      sectionUsage: '用量明细',
      usageSummary: '按日期范围、记录类型与模型查询调用明细，展开后翻页查看。',
      usageHint: '时间按北京时间（UTC+8）显示。',
      usageType: '记录类型',
      usageTypeUsage: '模型调用（扣费）',
      usageTypeRedeem: '积分发放 / 兑换',
      usageModelType: '模型类型',
      usageModelTypeAll: '全部类型',
      usageModelTypeToken: '大语言模型',
      usageModelTypeTts: '语音合成',
      usageModelTypeImage: '图像生成',
      usageModelTypeAsr: '语音识别',
      usageModelTypeVideo: '视频生成',
      usageModelId: '模型名称',
      usageModelIdPlaceholder: '如 qwen3.8-flash',
      usageStart: '开始日期',
      usageEnd: '结束日期',
      usageQuery: '查询',
      usageEmpty: '暂无符合条件的记录',
      usageColTime: '时间',
      usageColModel: '模型',
      usageColUsage: '用量',
      usageColCredits: '结算 Credits',
      usageColBalance: '余额',
      usageColStatus: '状态',
      usageSum: '本页 {count} 条 · 结算 {credits} Credits · 输入 {input} / 输出 {output} token',
      usagePage: '第 {page} / {pages} 页 · 共 {total} 条',
      usagePrev: '上一页',
      usageNext: '下一页',
      usagePageSize: '每页',
      usageNeedToken: '尚未配置登录 accessToken，请先在上方保存凭证。',

      // notify + log
      sectionLog: '拉取记录',
      logEmpty: '暂无记录',
      logClear: '清空记录',
      logColTime: '时间',
      logColResult: '结果',
      logColDetail: '详情',

      // composer pill
      pillCredits: 'Credits',
      pillRedeemable: '可兑换',
      pillNone: '额度 —',
      pillRefreshHint: '点击刷新额度',
      pillLoading: '刷新中…',
    }

    const en = {
      settings: 'AgentScope',
      title: 'AgentScope Platform',
      subtitle: 'Optional model provider, credits and usage, daily check-in',
      pageLead: 'Brings an AgentScope platform account into DSH: use it as a model provider, watch Credits under the composer, and keep the daily check-in running.',
      platformLink: 'platform.agentscope.io',
      build: 'Build',
      loading: 'Loading…',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      refresh: 'Refresh',
      reset: 'Reset',
      error: 'Error',
      ok: 'OK',
      failed: 'Failed',
      never: 'Never',
      none: 'None',
      close: 'Close',
      remove: 'Remove',
      add: 'Add',
      unknown: 'Unknown',

      // account pool
      sectionAccounts: 'Account pool',
      accountHint: 'Several accounts can coexist. New requests use the key of the account marked Current.',
      accountAdd: 'Add account',
      accountLabel: 'Label',
      accountCurrent: 'Billing account',
      accountSwitch: 'Switch',
      accountTest: 'Probe',
      accountDisable: 'Disable',
      accountEnable: 'Enable',
      accountRename: 'Rename',
      accountEdit: 'Edit',
      accountEditHint: 'These fields belong to THIS account only. Changing them leaves every other account alone.',
      accountTokenPlaceholder: "Paste this account's refreshToken",
      accountRemove: 'Remove',
      accountRemoveConfirm: 'Remove this account?',
      accountUntitled: 'Untitled account',
      accountStateCurrent: 'Current',
      accountStateDisabled: 'Disabled',
      accountStateExpired: 'Credentials expired',
      accountStateLowCredit: 'Low credit',
      accountAutoSwitch: 'Pick by credit automatically',
      accountAutoSwitchHint: 'When the current account drops below the threshold, switch to the one with more credit.',
      accountThreshold: 'Threshold',
      accountEmpty: 'No accounts yet. Add one to get started.',
      accountNoneYet: 'No accounts',
      accountCount: '{count} accounts',
      accountSaving: 'Saving…',
      accountTestFailed: 'Probe failed',
      accountTestOk: 'Probe passed',
      accountCredits: 'Available credit',
      accountLastRefreshed: 'Last refreshed',
      accountModelKey: 'sk-as- key (optional)',
      accountActivate: 'Make this the billing account',
      accountSetCurrent: 'Make current',
      accountSwitchHint: 'A reply already streaming is unaffected; the next prompt uses the new account.',
      accountNeedLabel: 'A label is required',
      accountNeedToken: 'A refreshToken is required',
      accountsGlobalHint: 'Global setting',
      accountCannotDisableLast: 'The last usable account cannot be disabled',

      refreshToken: 'Login refreshToken',
      refreshFailed: 'Could not exchange for an access token',
      phoneExchanged: 'Saved and refreshed. The browser session for this account is now invalidated — that is the platform\'s design.',
      refreshTokenHowTo: 'How to get it: in the browser that is signed in to platform.agentscope.io, open the console (F12) and run the line below, then paste the result above.',
      refreshTokenSnippet: "localStorage.getItem('refreshToken')",
      expiresIn: 'Time left',
      modelKeyHint: 'Model calls use Authorization: Bearer sk-as-…, never the login token.',
      modelKeyEither: 'Either route fills the same field: fetch it automatically, or paste your own key.',
      modelKeyFetchHint: 'Exchanges the login refreshToken above for the platform key, and saves it when one comes back.',
      modelKeyFetchNote: 'A fetch sometimes comes back empty \u2014 that is the platform\u2019s rule, not a failure. Paste a key by hand in that case.',
      modelKeyCurrent: 'Current key',
      modelKeyMissing: 'Not configured',
      modelKeySourcePasted: 'Pasted',
      modelKeySourceFetched: 'Fetched',
      tokenPasteFirst: 'Paste a refreshToken first.',
      tokenHowToToggle: 'How to get a refreshToken',
      modelKeyPasteFirst: 'Paste a key first. Without one, use "Fetch with login" above.',
      modelKeyPaste: 'Paste an sk-as- key',
      modelKeyFetch: 'Fetch with the login token',
      modelKeyReset: 'Reset and fetch a new one',
      modelKeyResetWarn: 'Resetting revokes the old key immediately',
      modelKeyFetched: 'Fetched and saved',
      modelKeyNotReturned: 'The platform did not return the full key this time (it is shown only right after generate/reset). Paste it by hand or press "Reset and fetch".',
      pullInterval: 'Snapshot interval (minutes)',

      sectionProvider: 'Model provider',
      providerHint: 'Off by default. Turning it on is what puts AgentScope in the model picker; turning it off withdraws it at once and leaves every other feature working.',
      providerEnable: 'Enable the AgentScope model provider',
      providerOn: 'Enabled',
      providerOff: 'Disabled',
      providerId: 'Provider ID',
      providerDisplayName: 'Display name',
      providerBaseUrl: 'API address',
      providerProtocol: 'API protocol',
      providerProtocolOpenAI: 'OpenAI Chat Completions',

      sectionCatalog: 'Model catalog',
      catalogHint: 'Fetch from the API, add rows by hand, and edit each row. New rows start as text + image.',
      catalogSummary: '{count} models · metadata {at}',
      fetchModels: 'Fetch available models',
      fetching: 'Asking the platform…',
      fetchEmpty: 'The platform listed no models; add them by hand.',
      addModel: 'Add model',
      modelId: 'Model ID',
      modelName: 'Display name',
      modelContext: 'Context window',
      modelMaxTokens: 'Max output tokens',
      modelInput: 'Input types',
      modelInputText: 'Text',
      modelInputImage: 'Image',
      modelReasoning: 'Reasoning tiers',
      modelReasoningHint: 'When enabled, the tier is written into the request. The platform publishes no fixed parameter name, so you can set it.',
      modelReasoningOff: 'Off (send nothing)',
      modelAdvanced: 'Model options',
      modelsEmpty: 'The catalog is empty; add a model or fetch the list.',
      modelIdRequired: 'A model ID is required',
      modelIdDuplicate: 'Model IDs must be unique',
      modelCapacityInvalid: 'Capacity must be a positive number, optionally with a K or M suffix',
      saveCatalog: 'Save catalog',
      catalogSaved: 'Catalog saved',
      metaSource: 'Metadata source',
      metaUpdated: 'Last updated',
      metaModels: 'Model entries',
      metaRefresh: 'Refresh metadata now',
      metaRefreshing: 'Refreshing…',
      metaDegraded: 'Remote unavailable — using the bundled snapshot',
      metaDetail: 'Field source',
      metaCapacityHint: 'Both capacity fields start empty. When empty, the MINIMUM of the public model table\'s reference range (the lower bound shown in grey) is used automatically; a conservative default applies only when the table has no entry for that model. The grey numbers are a reference range, not the value itself. Type a positive integer to set one explicitly (a K or M suffix is accepted); a value you type always wins.',
      metaBundled: 'Bundled',
      metaRemote: 'Reference',
      metaUser: 'Manual',

      sectionCheckin: 'Daily check-in',
      checkinSummary: 'Today {day}',
      checkinHint: 'The platform has no check-in endpoint: the "daily login +1" contribution is scored by the server when the account signs in. This keeps the login alive once a day and then reads the contribution ledger back to confirm whether today was actually scored.',
      checkinEnable: 'Enable the daily check-in',
      checkinRunNow: 'Run once now',
      checkinRunning: 'Running…',
      checkinToday: 'Today',
      checkinStatusIdle: 'Not run today',
      checkinStatusPending: 'Kept alive, waiting for the platform to score it',
      checkinStatusCredited: 'Scored',
      checkinStatusFailed: 'Failed',
      checkinAttempts: 'Attempts today',
      checkinLast: 'Last attempt',
      checkinDetail: 'Detail',
      checkinTimezone: 'Local day',

      sectionCredits: 'Credits and contribution',
      creditsAvailable: 'Available credits',
      creditsLifetime: 'Lifetime score',
      creditsRedeemable: 'Redeemable contribution',
      creditsPromotion: 'Active promotion',
      creditsFetched: 'Last fetched',
      creditsFetchNow: 'Refresh credits now',
      creditUser: 'Account',

      // pricing
      sectionPricing: 'Price list',
      pricingSummary: 'Open to read the platform\u2019s published prices.',
      pricingHint: "The console's published reference prices in Credits, grouped by capability. Collapsed by default; expand a group for the figures.",
      pricingLoad: 'Load price list',
      pricingLoading: 'Loading…',
      pricingEmpty: 'No prices to show',
      pricingPromo: 'Active promotion',
      pricingGroupToken: 'Text',
      pricingGroupTts: 'TTS',
      pricingGroupImage: 'Image',
      pricingGroupAsr: 'ASR',
      pricingGroupVideo: 'Video',
      pricingGroupOther: 'Other',
      pricingColModel: 'Model',
      pricingColTier: 'Tier',
      pricingColInput: 'Input',
      pricingColCache: 'Cache read',
      pricingColOutput: 'Output',
      pricingColUnit: 'Billed per',
      pricingNeedToken: 'No login accessToken yet — the price list cannot load.',
      sectionUsage: 'Usage detail',
      usageSummary: 'Query model calls by date range, record type and model; open to page through them.',
      usageHint: 'Times are shown in Beijing time (UTC+8).',
      usageType: 'Record type',
      usageTypeUsage: 'Model calls (charged)',
      usageTypeRedeem: 'Credit grants / redemptions',
      usageModelType: 'Model type',
      usageModelTypeAll: 'All types',
      usageModelTypeToken: 'Large language models',
      usageModelTypeTts: 'TTS',
      usageModelTypeImage: 'Image generation',
      usageModelTypeAsr: 'ASR',
      usageModelTypeVideo: 'Video generation',
      usageModelId: 'Model name',
      usageModelIdPlaceholder: 'e.g. qwen3.8-flash',
      usageStart: 'Start date',
      usageEnd: 'End date',
      usageQuery: 'Query',
      usageEmpty: 'No matching records',
      usageColTime: 'Time',
      usageColModel: 'Model',
      usageColUsage: 'Usage',
      usageColCredits: 'Settled credits',
      usageColBalance: 'Balance',
      usageColStatus: 'Status',
      usageSum: '{count} on this page · {credits} credits settled · {input} in / {output} out tokens',
      usagePage: 'Page {page} / {pages} · {total} records',
      usagePrev: 'Previous',
      usageNext: 'Next',
      usagePageSize: 'Per page',
      usageNeedToken: 'No login accessToken yet — save credentials above first.',

      sectionLog: 'Fetch history',
      logEmpty: 'No records yet',
      logClear: 'Clear records',
      logColTime: 'Time',
      logColResult: 'Result',
      logColDetail: 'Detail',

      pillCredits: 'Credits',
      pillRedeemable: 'redeemable',
      pillNone: 'credits —',
      pillRefreshHint: 'Click to refresh credits',
      pillLoading: 'Refreshing…',
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Attach the account a request is ABOUT.
     *
     * Every endpoint that reads or writes one account accepts `?accountId=`
     * (a POST takes it in the body instead, see `post`). An EMPTY id is left off
     * entirely: the host then falls back to the billing account, which is exactly
     * what a request that names no account should do — and it keeps the shape of
     * an old request byte-identical for a cached bundle.
     */
    function withAccount(path, accountId) {
      if (typeof accountId !== 'string' || accountId === '') return path
      const separator = path.includes('?') ? '&' : '?'
      return `${path}${separator}accountId=${encodeURIComponent(accountId)}`
    }

    /** One fetch against this plugin's own API, with the JSON body parsed. */
    async function api(path, init, accountId) {
      const response = await fetch(`${API}${withAccount(path, accountId)}`, init)
      const text = await response.text()
      let body
      try { body = text === '' ? {} : JSON.parse(text) } catch { throw new Error(text.slice(0, 200) || `HTTP ${response.status}`) }
      if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`)
      return body
    }

    /** A POST with a JSON body. `accountId` rides in the body, not the query. */
    function post(path, body, accountId) {
      const payload = { ...(body ?? {}) }
      if (typeof accountId === 'string' && accountId !== '') payload.accountId = accountId
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    }

    /** A capacity value shown in the box: ALWAYS a plain integer, because that
     * is exactly what the host receives. No K/M abbreviation in an editable
     * field — abbreviations belong in prose, not in a value the user may submit. */
    function capacity(value) {
      // An absent value must render as an EMPTY box, never as a literal "0".
      if (value === null || value === undefined || value === '') return ''
      const number = Number(value)
      return Number.isFinite(number) && number > 0 ? String(number) : ''
    }

    /** `"128K"`/`"1M"`/`128000` → a positive integer, or undefined. */
    function parseCapacity(text) {
      const match = /^\s*(\d+(?:\.\d+)?)\s*([kKmM])?\s*$/.exec(String(text ?? ''))
      if (match === null) return undefined
      const scale = match[2] === undefined ? 1 : /[kK]/.test(match[2]) ? 1_000 : 1_000_000
      const parsed = Math.round(Number(match[1]) * scale)
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
    }

    /** A remote capacity range as a grey placeholder.
     *
     * The platform (and the host's `contextWindow` / `max_tokens`) takes a
     * PLAIN INTEGER. Abbreviated hints like "918K~1M" are readable but cannot be
     * pasted back into the box — `parseCapacity` only accepts digits (with an
     * optional K/M suffix). So the hint shows the raw integers instead: what you
     * see is what the host will receive if you type it.
     */
    function rangeHint(range) {
      if (!range || typeof range.min !== 'number' || typeof range.max !== 'number') return ''
      return range.min === range.max ? String(range.min) : `${range.min}~${range.max}`
    }

    /**
     * The little label beside a capacity box.
     *
     * Only a value the user actually typed gets a label. An empty box gets
     * NOTHING: the parameter is simply not sent, and the grey range beside it is
     * a reference hint — not a value source to advertise.
     */
    function sourceLabel(t, row, field) {
      const own = field === 'contextWindow' ? row.contextWindow : row.maxTokens
      return own === null || own === undefined ? '' : t('metaUser')
    }


    /**
     * The zone this whole panel states times in.
     *
     * WHY A FIXED ZONE RATHER THAN THE BROWSER'S. The plugin's own day boundary
     * is Asia/Shanghai: the check-in scheduler decides "is today already
     * credited" from a Shanghai date, and the host reports `checkin.day` as that
     * date. Formatting the timestamps BESIDE those fields in the browser's zone
     * produced a panel that contradicted itself — with the browser on UTC+9, the
     * check-in block read "今日 2026-11-14" next to "最近一次 01:04", while the
     * host had recorded 00:04 on the 14th. One clock, the one every rule in this
     * plugin already uses, and a label saying so.
     */
    const PANEL_ZONE = 'Asia/Shanghai'

    /**
     * Render one platform timestamp (a usage-row wall clock) in {@link PANEL_ZONE}.
     *
     * The platform returns Asia/Shanghai wall-clock strings WITHOUT an offset
     * (e.g. "2026-11-12T00:46:33.369183"). `new Date(that)` would parse it as
     * the BROWSER's local time, which is only right on a UTC+8 machine. So the
     * wall clock is first pinned to +08:00 explicitly.
     *
     * It used to be formatted back out in the viewer's zone, which was defensible
     * on its own — but this table sits in the SAME panel as the check-in block,
     * and that block's dates are Shanghai dates. A viewer on UTC+9 therefore saw
     * a usage row at 03:37 next to a "今日 2026-11-14" whose day had been decided
     * in Shanghai. One panel, one clock.
     */
    function localTime(raw) {
      if (typeof raw !== 'string' || raw.trim() === '') return '—'
      const text = raw.trim()
      // Already absolute? (…Z, +08:00, -05:00, or a trailing numeric offset)
      const absolute = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
      let iso = absolute ? text : `${text.replace(' ', 'T')}+08:00`
      let date = new Date(iso)
      if (Number.isNaN(date.getTime())) {
        // A bare "YYYY-MM-DD" or an unusual shape: fall back to raw parsing,
        // then to verbatim text.
        date = new Date(text)
        if (Number.isNaN(date.getTime())) return text
      }
      try {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: PANEL_ZONE,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).format(date)
      } catch {
        return wallClockInPanelZone(date, true)
      }
    }

    /**
     * `YYYY-MM-DD HH:mm[:ss]` computed from an explicit +08:00 offset.
     *
     * The fallback for a runtime without `Intl` time zones. It deliberately does
     * NOT read `getHours()`: that answers in the MACHINE's zone, which is the
     * exact confusion this panel is fixing. Shifting the epoch by eight hours and
     * reading the UTC fields is clock-free arithmetic.
     */
    function wallClockInPanelZone(date, withSeconds) {
      const padded = value => String(value).padStart(2, '0')
      const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
      const day = `${shifted.getUTCFullYear()}-${padded(shifted.getUTCMonth() + 1)}-${padded(shifted.getUTCDate())}`
      const clock = `${padded(shifted.getUTCHours())}:${padded(shifted.getUTCMinutes())}`
      return withSeconds ? `${day} ${clock}:${padded(shifted.getUTCSeconds())}` : `${day} ${clock}`
    }

    /**
     * Format one absolute instant (ISO string or epoch ms) in {@link PANEL_ZONE}.
     *
     * `Intl` is used rather than `Date#getHours` so the result does not depend on
     * where the browser happens to be. A fallback of `undefined` means "return
     * the raw input" — the previous behaviour for unparseable values.
     */
    function stamp(iso, fallback) {
      const raw = typeof iso === 'number' ? iso : iso
      if (raw === null || raw === undefined || raw === '') return fallback ?? '—'
      const date = raw instanceof Date ? raw : new Date(raw)
      if (Number.isNaN(date.getTime())) return typeof raw === 'string' ? raw : (fallback ?? '—')
      try {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: PANEL_ZONE,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(date)
        const get = type => (parts.find(part => part.type === type)?.value ?? '')
        // `en-CA` yields YYYY-MM-DD for the date parts, and hourCycle issues can
        // render midnight as "24" — normalise it back to 00.
        const hour = get('hour') === '24' ? '00' : get('hour')
        return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`
      } catch {
        return wallClockInPanelZone(date, false)
      }
    }

    /**
     * The zone label shown next to a timestamp, so a fixed zone is not a silent
     * decision: a viewer west of Shanghai must not read these as their own clock.
     */
    function stampZoneLabel() {
      return PANEL_ZONE === 'Asia/Shanghai' ? 'UTC+8' : PANEL_ZONE
    }

    /** Number formatting for credits: integers stay integers. */
    function credit(value) {
      if (value === null || value === undefined || value === '') return '—'
      const number = Number(value)
      if (!Number.isFinite(number)) return String(value)
      return Number.isInteger(number) ? String(number) : number.toFixed(2)
    }

    // -----------------------------------------------------------------------
    // Styles (host aliases only: this plugin ships no stylesheet)
    // -----------------------------------------------------------------------

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px' },
      head: { display: 'flex', flexDirection: 'column', gap: '4px' },
      h1: { fontSize: '16px', fontWeight: 600, margin: 0 },
      sub: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
      section: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
      sectionTitle: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', fontSize: '13px', fontWeight: 600 },
      // The whole title is the hit area: a 13px label alone is a small target,
      // and the arrow needs to look like part of the same control.
      sectionToggle: { display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'transparent', border: 'none', padding: 0, margin: 0, cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'left' },
      sectionArrow: { fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)', width: '10px', display: 'inline-block' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto', minWidth: '96px' },
      input: { flex: '1 1 160px', minWidth: '140px', padding: '6px 8px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' },
      // Capacity boxes hold a REFERENCE RANGE as their placeholder (e.g.
      // "917504~1048576"), so they need room for it: a 96px box clipped the hint
      // the moment the range had two large integers.
      capacityInput: { flex: '0 0 auto', width: '176px', padding: '6px 8px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' },
      inputNarrow: { flex: '0 0 auto', width: '96px', padding: '6px 8px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' },
      button: { padding: '6px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      buttonPrimary: { padding: '6px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid transparent', background: 'var(--dsw-alias-accent-primary, #1F6FEB)', color: '#fff', cursor: 'pointer' },
      // 4px vertical padding + 11px text lands at ~26px: the five action chips on
      // an account row were 20px tall, which is under the comfortable pointer
      // target and made "Remove" easy to mis-hit next to "Rename".
      buttonSmall: { padding: '4px 9px', fontSize: '11px', lineHeight: '16px', borderRadius: '5px', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
      // Destructive chip: same box as a small button, error-coloured text. No
      // filled red — this is the routine state, and only the confirmation step
      // should feel alarming.
      buttonDanger: { border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-state-error-primary)' },
      link: { color: 'var(--dsw-alias-accent-primary, #1F6FEB)', textDecoration: 'underline', textUnderlineOffset: '2px' },
      /**
       * The row that pays for new requests.
       *
       * A left rule rather than a filled card: these rows already sit inside a
       * bordered section, and a second box would read as a nested panel. The
       * rule plus a faint tint marks the row without competing with the buttons
       * inside it.
       *
       * The section's own rhythm is `borderTop + paddingTop: 10px` and NO bottom
       * padding, so a rule added to just that box stopped at the buttons and read
       * as a stray floating tick. The row therefore owns a matching bottom edge
       * and a little inset on both sides, which is what makes the highlight look
       * deliberate instead of clipped.
       */
      rowCurrent: {
        borderLeft: '3px solid var(--dsw-alias-accent-primary, #1F6FEB)',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: '0 6px 6px 0',
        paddingLeft: '9px',
        paddingRight: '8px',
        paddingBottom: '8px',
        // Reach the section's right edge so the tint is a band, not a stub.
        marginRight: '-4px',
      },
      detailsSummary: { cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      tableWrap: { overflowX: 'auto', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: { textAlign: 'left', padding: '7px 9px', borderBottom: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 500, whiteSpace: 'nowrap' },
      td: { padding: '7px 9px', borderBottom: '1px solid var(--dsw-alias-border-l4)', verticalAlign: 'top' },
      pill: (tone) => ({
        display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '1px 8px', borderRadius: '999px', fontSize: '11px',
        background: tone === 'ok' ? 'var(--dsw-alias-bg-layer-3)' : tone === 'bad' ? 'var(--dsw-alias-interactive-bg-hover-danger)' : 'var(--dsw-alias-bg-layer-2)',
        color: tone === 'ok' ? 'var(--dsw-alias-state-success-primary)' : tone === 'bad' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
      error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.5 },
      kv: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', fontSize: '12px' },
      kvKey: { color: 'var(--dsw-alias-label-tertiary)' },
      /**
       * A value beside a label. The SIZE is stated, not inherited.
       *
       * It used to carry only a colour, so inside a `Row` it fell back to the
       * browser's default — visibly larger than the 12px label next to it. Only
       * some rows masked the problem with an inline `fontSize: '12px'`, which is
       * why one section showed two different value sizes in the same column.
       * Typography is owned here, once, so a row never has to patch it.
       */
      kvVal: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)' },
      /** Values that are identifiers — routed through the same size as kvVal. */
      kvMono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', color: 'var(--dsw-alias-label-primary)' },
      /** A tier id in the reasoning editor: one step below body, by design. */
      tierId: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', minWidth: '48px' },
      modelCard: { border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' },
      check: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
    }

    function Button(props) {
      const { primary, small, style, disabled, children, ...rest } = props
      const base = primary ? S.buttonPrimary : small ? S.buttonSmall : S.button
      // `style` MERGES over the variant instead of replacing it: a caller that
      // only wants to recolour a chip should not have to restate its padding and
      // font size.
      const merged = style === undefined ? base : { ...base, ...style }
      // A disabled chip that looks identical to an enabled one is the whole bug
      // report: users click it and conclude the feature is broken.
      const finalStyle = disabled === true ? { ...merged, opacity: 0.5, cursor: 'not-allowed' } : merged
      return h('button', { type: 'button', style: finalStyle, disabled, ...rest }, children)
    }

    function Section(props) {
      /**
       * Collapsible section.
       *
       * WHY: the panel had seven sections of equal visual weight and 3.6k px of
       * height, so the two things a user opens this page for — which account is
       * paying, and how many credits are left — were buried above and below a
       * 1.8k px usage table. `defaultOpen` decides what a first visit shows; the
       * summary line keeps a collapsed section informative instead of blank.
       *
       * The header is a real button with `aria-expanded`, and the summary is
       * rendered as ordinary text so it stays readable when collapsed.
       */
      const { collapsible = false, defaultOpen = true, summary = null } = props
      const [open, setOpen] = React.useState(defaultOpen)
      const showing = collapsible ? open : true
      const header = h('div', { key: 'title', style: S.sectionTitle }, [
        collapsible
          ? h('button', {
            key: 'toggle',
            type: 'button',
            'aria-expanded': showing,
            onClick: () => setOpen(value => !value),
            style: S.sectionToggle,
          }, [
            h('span', { key: 'arrow', 'aria-hidden': 'true', style: S.sectionArrow }, showing ? '▾' : '▸'),
            h('span', { key: 'label' }, props.title),
          ])
          : h('span', { key: 'label' }, props.title),
        props.actions == null ? null : h('span', { key: 'actions', style: S.row }, props.actions),
      ])
      return h('section', { style: S.section }, [
        header,
        // A collapsed section still answers "what is in here" with one line.
        showing || summary == null ? null : h('div', { key: 'summary', style: S.hint }, summary),
        ...(showing && props.children != null
          ? (Array.isArray(props.children) ? props.children : [props.children])
          : []),
      ])
    }

    function Row(props) {
      return h('div', { style: S.row }, [
        props.label == null ? null : h('span', { key: 'label', style: S.label }, props.label),
        ...(Array.isArray(props.children) ? props.children : [props.children]),
      ])
    }


    // -----------------------------------------------------------------------
    // Shared credits store — ONE source for both the composer pill and the
    // settings panel.
    //
    // Before this, the pill polled /quick while the panel read state.credits.latest
    // from /fetch. Two different endpoints meant the two surfaces could disagree
    // about the same balance, and a refresh in one never updated the other.
    // Both now subscribe to this store; whoever refreshes (pill tick, pill click,
    // or the panel's button) updates every subscriber at once.
    //
    // /quick is the single read: credits only, no userinfo, no snapshot log.
    // -----------------------------------------------------------------------
    const creditsStore = (() => {
      let snapshot = { credits: null, at: 0, error: '', loading: false }
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) listener() }
      return {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        getSnapshot() { return snapshot },
        set(patch) { snapshot = { ...snapshot, ...patch }; emit() },
        /**
         * Fetch once. Concurrent callers share the in-flight request.
         *
         * `force = false` (the mount path) skips a fetch when the snapshot is
         * still fresh: session switches re-mount the composer slot, and without
         * this every switch would fire another upstream request for data that is
         * already in this module-level store. An explicit click / button always
         * passes force = true.
         */
        async refresh(force = false, freshMs = 30_000) {
          if (snapshot.loading) return
          if (!force && snapshot.at > 0 && Date.now() - snapshot.at < freshMs && snapshot.error === '') return
          this.set({ loading: true })
          try {
            const answer = await api('/quick')
            this.set({
              credits: answer?.credits ?? null,
              at: Date.parse(answer?.at ?? '') || Date.now(),
              error: answer?.error ?? '',
              loading: false,
            })
          } catch (error) {
            this.set({ error: error instanceof Error ? error.message : String(error), loading: false })
          }
        },
      }
    })()

    // -----------------------------------------------------------------------
    // Model catalog editor
    // -----------------------------------------------------------------------

    /**
     * One model row's editable controls.
     *
     * Kept as a component so the parent's re-renders (polling, saving) cannot
     * reset a half-typed capacity: the text is held locally and only committed
     * on blur/change.
     */
    function ModelRow(props) {
      const { row, index, onChange, onRemove, t } = props
      const [advanced, setAdvanced] = React.useState(false)
      // An EMPTY box means "no opinion": the effective value then comes from the
      // remote table. The remote range rides along as a grey placeholder, which is
      // the only place a number may appear that the user did not type.
      const contextTextOf = value => (value === null || value === undefined ? '' : capacity(value))
      const [contextText, setContextText] = React.useState(contextTextOf(row.contextWindow))
      const [maxText, setMaxText] = React.useState(contextTextOf(row.maxTokens))
      React.useEffect(() => { setContextText(contextTextOf(row.contextWindow)) }, [row.contextWindow])
      React.useEffect(() => { setMaxText(contextTextOf(row.maxTokens)) }, [row.maxTokens])
      const contextHint = rangeHint(row.remote?.contextRange)
      const outputHint = rangeHint(row.remote?.outputRange)
      const input = Array.isArray(row.input) ? row.input : []
      const toggleInput = id => {
        const next = input.includes(id) ? input.filter(item => item !== id) : [...input, id]
        // An empty list would mean "supports nothing"; keep at least text.
        onChange({ ...row, input: next.length === 0 ? ['text'] : next })
      }
      const efforts = Array.isArray(row.reasoningEfforts) ? row.reasoningEfforts : []
      const addEffort = () => {
        const used = new Set(efforts.map(item => item.id))
        const id = ['low', 'medium', 'high'].find(candidate => !used.has(candidate))
        if (id === undefined) return
        onChange({ ...row, reasoningEfforts: [...efforts, { id, value: id }] })
      }
      return h('div', { style: S.modelCard }, [
        h(Row, { key: 'id', label: t('modelId') }, [
          h('input', { key: 'i', id: `asp-model-id-${row.id}`, autoComplete: 'off', style: S.input, value: row.id, onChange: event => onChange({ ...row, id: event.target.value }) }),
          h('button', { key: 'a', type: 'button', style: S.buttonSmall, onClick: () => setAdvanced(value => !value) }, advanced ? '▾ ' + t('modelAdvanced') : '▸ ' + t('modelAdvanced')),
          h(Button, { key: 'r', small: true, onClick: onRemove, title: t('remove') }, t('remove')),
        ]),
        h(Row, { key: 'name', label: t('modelName') }, h('input', { id: `asp-model-name-${row.id}`, autoComplete: 'off', style: S.input, value: row.name, onChange: event => onChange({ ...row, name: event.target.value }) })),
        advanced ? h('div', { key: 'adv', style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
          h(Row, { key: 'cap', label: t('modelContext') }, [
            h('input', {
              key: 'i',
              id: `asp-model-context-${row.id}`,
              autoComplete: 'off',
              style: S.capacityInput,
              value: contextText,
              placeholder: contextHint,
              inputMode: 'numeric',
              onChange: event => setContextText(event.target.value),
              onBlur: () => {
                // Clearing the box clears the override; it does not fall back to
                // a number we invented.
                if (contextText.trim() === '') { onChange({ ...row, contextWindow: null }); return }
                const parsed = parseCapacity(contextText)
                if (parsed === undefined) { setContextText(contextTextOf(row.contextWindow)); return }
                onChange({ ...row, contextWindow: parsed })
              },
            }),
            h('span', { key: 'src', style: { ...S.hint, minWidth: '40px' } }, sourceLabel(t, row, 'contextWindow')),
          ]),
          h(Row, { key: 'out', label: t('modelMaxTokens') }, [
            h('input', {
              key: 'i',
              id: `asp-model-max-${row.id}`,
              autoComplete: 'off',
              style: S.capacityInput,
              value: maxText,
              placeholder: outputHint,
              inputMode: 'numeric',
              onChange: event => setMaxText(event.target.value),
              onBlur: () => {
                if (maxText.trim() === '') { onChange({ ...row, maxTokens: null }); return }
                const parsed = parseCapacity(maxText)
                if (parsed === undefined) { setMaxText(contextTextOf(row.maxTokens)); return }
                const ceiling = row.contextWindow ?? row.remote?.contextWindow
                onChange({ ...row, maxTokens: ceiling === undefined ? parsed : Math.min(parsed, ceiling) })
              },
            }),
            h('span', { key: 'src', style: { ...S.hint, minWidth: '40px' } }, sourceLabel(t, row, 'maxTokens')),
          ]),
          h(Row, { key: 'input', label: t('modelInput') }, [
            h('label', { key: 't', style: S.check }, [
              h('input', { id: `asp-model-text-${row.id}`, type: 'checkbox', checked: input.includes('text'), onChange: () => toggleInput('text') }),
              t('modelInputText'),
            ]),
            h('label', { key: 'i', style: S.check }, [
              h('input', { id: `asp-model-image-${row.id}`, type: 'checkbox', checked: input.includes('image'), onChange: () => toggleInput('image') }),
              t('modelInputImage'),
            ]),
          ]),
          h('div', { key: 'reason', style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
            h('div', { key: 'h', style: S.row }, [
              h('span', { key: 'l', style: S.label }, t('modelReasoning')),
              h(Button, { key: 'add', small: true, onClick: addEffort }, `${t('add')} ${t('modelReasoning')}`),
            ]),
            efforts.length === 0
              ? h('div', { key: 'none', style: S.hint }, t('modelReasoningOff'))
              : efforts.map((tier, at) => h('div', { key: `tier-${tier.id}`, style: S.row }, [
                h('span', { key: 'id', style: S.tierId }, tier.id),
                tier.id === 'off' ? null : h('input', {
                  key: 'v',
                  id: `asp-tier-${row.id}-${tier.id}`,
                  autoComplete: 'off',
                  style: S.input,
                  placeholder: 'reasoning_effort',
                  value: tier.value ?? '',
                  onChange: event => {
                    const next = efforts.map((entry, i) => i === at ? { ...entry, value: event.target.value } : entry)
                    onChange({ ...row, reasoningEfforts: next })
                  },
                }),
                h(Button, {
                  key: 'rm',
                  small: true,
                  onClick: () => onChange({ ...row, reasoningEfforts: efforts.filter((_, i) => i !== at) }),
                }, '×'),
              ])),
            h('div', { key: 'hint', style: S.hint }, t('modelReasoningHint')),
          ]),
        ]) : null,
      ])
    }

    /**
     * The catalog editor: fetch from the API, add rows, edit metadata, save.
     *
     * The draft is local until "save" — a refresh from the API fills a
     * candidate list rather than overwriting rows the user already tuned.
     */
    function CatalogEditor(props) {
      const { t, catalog, onSaved } = props
      const [rows, setRows] = React.useState(() => catalog.map(row => ({ ...row, input: [...(row.input ?? ['text', 'image'])], reasoningEfforts: [...(row.reasoningEfforts ?? [])] })))
      const [candidates, setCandidates] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')

      // A catalog pushed from the host (a save echoed back) replaces the draft.
      React.useEffect(() => {
        setRows(catalog.map(row => ({ ...row, input: [...(row.input ?? ['text', 'image'])], reasoningEfforts: [...(row.reasoningEfforts ?? [])] })))
      }, [catalog])

      /**
       * Attach the REFERENCE ranges to rows that do not have them yet.
       *
       * Rows loaded from the host arrive with `remote` already on them. A row the
       * user just typed, or a candidate adopted from discovery, lives only in this
       * draft and therefore has no ranges — which is why the grey placeholder went
       * blank for new rows. This asks the host to look those ids up.
       *
       * Nothing here becomes a value: only `row.remote` is filled, which the two
       * boxes read as their placeholder text.
       */
      // Ids already asked about. A model absent from the table answers "no
      // ranges", and without this the effect would re-ask on every keystroke
      // (rows is a new array each edit) and never stop.
      const lookedUp = React.useRef(new Set())
      React.useEffect(() => {
        const missing = rows
          .filter(row => row.remote === undefined && typeof row.id === 'string' && row.id.trim() !== '')
          .map(row => row.id.trim())
          .filter(id => !lookedUp.current.has(id))
        if (missing.length === 0) return undefined
        for (const id of missing) lookedUp.current.add(id)
        let live = true
        const timer = setTimeout(() => {
          api(`/model-meta/lookup?ids=${encodeURIComponent([...new Set(missing)].join(','))}`)
            .then(answer => {
              if (!live) return
              const ranges = answer?.ranges ?? {}
              if (Object.keys(ranges).length === 0) return
              setRows(current => current.map(row => {
                const key = typeof row.id === 'string' ? row.id.trim() : ''
                return row.remote === undefined && ranges[key] !== undefined ? { ...row, remote: ranges[key] } : row
              }))
            })
            .catch(() => { /* a hint is optional; a failed lookup changes nothing */ })
        }, 300)
        return () => { live = false; clearTimeout(timer) }
      }, [rows])

      const update = (index, next) => setRows(current => current.map((row, at) => at === index ? next : row))
      const remove = index => setRows(current => current.filter((_, at) => at !== index))
      // Capacities are LEFT EMPTY on a brand-new row. The grey placeholder in
      // the box comes from the remote table (min~max); a number appears only if
      // the user actually types one. Hard-coding a default here would turn every
      // new row into a "manual override" before the user touched it.
      const add = () => setRows(current => [...current, { id: '', name: '', contextWindow: null, maxTokens: null, input: ['text', 'image'], reasoningEfforts: [] }])

      const problems = () => {
        // An EMPTY capacity is a legitimate state, not an error: it means "use the
        // remote figure". Only a value the user actually typed has to be a
        // positive integer, so `null` passes and a bad number does not.
        const capacityProblem = value => value === null || value === undefined
          ? ''
          : (Number.isSafeInteger(value) && value > 0 ? '' : t('modelCapacityInvalid'))
        const seen = new Set()
        for (const row of rows) {
          const id = String(row.id ?? '').trim()
          if (id === '') return t('modelIdRequired')
          if (seen.has(id)) return `${t('modelIdDuplicate')}: ${id}`
          seen.add(id)
          const contextProblem = capacityProblem(row.contextWindow)
          if (contextProblem !== '') return contextProblem
          const maxProblem = capacityProblem(row.maxTokens)
          if (maxProblem !== '') return maxProblem
        }
        return ''
      }

      const fetchModels = async () => {
        setBusy('fetch')
        setError('')
        try {
          const answer = await api('/models/discover')
          const list = Array.isArray(answer.models) ? answer.models : []
          if (list.length === 0) { setError(t('fetchEmpty')); return }
          setCandidates(list)
        } catch (caught) { setError(caught.message) } finally { setBusy('') }
      }

      const adopt = candidate => {
        setRows(current => {
          if (current.some(row => row.id === candidate.id)) return current
          return [...current, {
            id: candidate.id,
            name: candidate.name ?? candidate.id,
            // Discovery reports only ids. Any number it happens to carry is NOT
            // the user's decision, so leave both fields empty and let the remote
            // range be the grey hint.
            contextWindow: null,
            maxTokens: null,
            // A fetched candidate with no modality answer still lands as
            // text + image: that is this plugin's default, and the user can tick
            // image off per row afterwards.
            input: Array.isArray(candidate.input) && candidate.input.length > 0 ? [...candidate.input] : ['text', 'image'],
            reasoningEfforts: [],
          }]
        })
        setCandidates(current => (current ?? []).filter(row => row.id !== candidate.id))
      }

      const save = async () => {
        const problem = problems()
        if (problem !== '') { setError(problem); return }
        setBusy('save')
        setError('')
        try {
          const answer = await post('/catalog', { models: rows.map(row => ({ ...row, id: String(row.id).trim(), name: String(row.name ?? '').trim() || String(row.id).trim() })) })
          setNotice(t('catalogSaved'))
          onSaved?.(answer)
        } catch (caught) { setError(caught.message) } finally { setBusy('') }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
        h('div', { key: 'hint', style: S.hint }, t('catalogHint')),
        h('div', { key: 'capHint', style: S.hint }, t('metaCapacityHint')),
        h('div', { key: 'actions', style: S.row }, [
          h(Button, { key: 'fetch', onClick: fetchModels, disabled: busy !== '' }, busy === 'fetch' ? t('fetching') : t('fetchModels')),
          h(Button, { key: 'add', onClick: add, disabled: busy !== '' }, t('addModel')),
          h(Button, { key: 'save', primary: true, onClick: save, disabled: busy !== '' }, busy === 'save' ? t('saving') : t('saveCatalog')),
          notice === '' ? null : h('span', { key: 'ok', style: S.pill('ok') }, notice),
        ]),
        error === '' ? null : h('div', { key: 'err', style: S.error }, error),
        candidates !== null && candidates.length > 0
          ? h('div', { key: 'cand', style: { ...S.modelCard, borderStyle: 'dashed' } }, [
            h('div', { key: 'h', style: { ...S.hint, fontWeight: 600 } }, `${t('fetchModels')} (${candidates.length})`),
            h('div', { key: 'list', style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
              candidates.map(candidate => h(Button, { key: candidate.id, small: true, onClick: () => adopt(candidate) }, `+ ${candidate.id}`))),
          ])
          : null,
        rows.length === 0
          ? h('div', { key: 'empty', style: S.hint }, t('modelsEmpty'))
          : rows.map((row, index) => h(ModelRow, {
            key: `${index}-${row.id}`,
            row,
            index,
            t,
            onChange: next => update(index, next),
            onRemove: () => remove(index),
          })),
      ])
    }

    // -----------------------------------------------------------------------
    // Usage detail
    // -----------------------------------------------------------------------

    function UsagePanel(props) {
      const { t, hasToken, accountId } = props
      const [type, setType] = React.useState('usage')
      const [modelType, setModelType] = React.useState('')
      const [modelId, setModelId] = React.useState('')
      const [start, setStart] = React.useState('')
      const [end, setEnd] = React.useState('')
      const [query, setQuery] = React.useState({ type: 'usage', modelType: '', modelId: '', startDate: '', endDate: '', page: 1, pageSize: 20 })
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        if (!hasToken) { setData(null); return }
        let live = true
        const params = new URLSearchParams({ type: query.type, page: String(query.page), page_size: String(query.pageSize) })
        if (query.modelType) params.set('model_type', query.modelType)
        if (query.modelId) params.set('model_id', query.modelId)
        if (query.startDate) params.set('start_date', query.startDate)
        if (query.endDate) params.set('end_date', query.endDate)
        setBusy(true)
        setError('')
        api(`/usage?${params.toString()}`, undefined, accountId)
          .then(answer => { if (live) setData(answer) })
          .catch(caught => { if (live) { setData(null); setError(caught.message) } })
          .finally(() => { if (live) setBusy(false) })
        return () => { live = false }
      }, [query, hasToken, accountId])

      const apply = (patch) => setQuery(previous => ({
        type,
        modelType,
        modelId: modelId.trim(),
        startDate: start,
        endDate: end,
        page: 1,
        pageSize: previous.pageSize,
        ...(patch ?? {}),
      }))

      if (!hasToken) return h('div', { style: S.hint }, t('usageNeedToken'))

      const items = Array.isArray(data?.items) ? data.items : []
      const sum = data?.sum ?? { count: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
      const pages = data?.pages ?? 1
      const page = data?.page ?? query.page
      const selectOptions = [
        ['', t('usageModelTypeAll')],
        ['token', t('usageModelTypeToken')],
        ['tts', t('usageModelTypeTts')],
        ['image', t('usageModelTypeImage')],
        ['asr', t('usageModelTypeAsr')],
        ['video', t('usageModelTypeVideo')],
      ]

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
        h('div', { key: 'hint', style: S.hint }, t('usageHint')),
        h('div', { key: 'filters', style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } }, [
          h(Row, { key: 'type', label: t('usageType') }, h('select', {
            id: 'asp-usage-type',
            style: S.input,
            value: type,
            onChange: event => setType(event.target.value),
          }, [
            h('option', { key: 'u', value: 'usage' }, t('usageTypeUsage')),
            h('option', { key: 'r', value: 'redeem' }, t('usageTypeRedeem')),
          ])),
          h(Row, { key: 'mt', label: t('usageModelType') }, h('select', {
            id: 'asp-usage-model-type',
            style: S.input,
            value: modelType,
            onChange: event => setModelType(event.target.value),
          }, selectOptions.map(([value, label]) => h('option', { key: value || 'all', value }, label)))),
          h(Row, { key: 'mid', label: t('usageModelId') }, h('input', {
            id: 'asp-usage-model-id',
            autoComplete: 'off',
            style: S.input,
            value: modelId,
            placeholder: t('usageModelIdPlaceholder'),
            onChange: event => setModelId(event.target.value),
          })),
          h(Row, { key: 'start', label: t('usageStart') }, h('input', { id: 'asp-usage-start', style: S.inputNarrow, type: 'date', value: start, onChange: event => setStart(event.target.value) })),
          h(Row, { key: 'end', label: t('usageEnd') }, h('input', { id: 'asp-usage-end', style: S.inputNarrow, type: 'date', value: end, onChange: event => setEnd(event.target.value) })),
          h(Button, { key: 'go', primary: true, onClick: () => apply({}), disabled: busy }, busy ? t('loading') : t('usageQuery')),
          h(Button, {
            key: 'reset',
            onClick: () => {
              setType('usage'); setModelType(''); setModelId(''); setStart(''); setEnd('')
              setQuery({ type: 'usage', modelType: '', modelId: '', startDate: '', endDate: '', page: 1, pageSize: 20 })
            },
          }, t('reset')),
        ]),
        error === '' ? null : h('div', { key: 'err', style: S.error }, error),
        h('div', { key: 'table', style: S.tableWrap }, h('table', { style: S.table }, [
          h('thead', { key: 'head' }, h('tr', null, [
            t('usageColTime'), t('usageColModel'), t('usageColUsage'), t('usageColCredits'), t('usageColBalance'), t('usageColStatus'),
          ].map((label, index) => h('th', { key: index, style: S.th }, label)))),
          h('tbody', { key: 'body' }, items.length === 0
            ? h('tr', { key: 'empty' }, h('td', { colSpan: 6, style: { ...S.td, ...S.hint } }, t('usageEmpty')))
            : items.map((item, index) => h('tr', { key: item.record_id ?? index }, [
              h('td', { key: 't', style: { ...S.td, ...S.mono, whiteSpace: 'nowrap' } }, localTime(item.created_at)),
              h('td', { key: 'm', style: S.td }, item.model_id ?? '—'),
              h('td', { key: 'u', style: S.td }, item.usage_label ?? '—'),
              h('td', { key: 'c', style: S.td }, credit(item.settled_credits)),
              h('td', { key: 'b', style: S.td }, credit(item.balance_after)),
              h('td', { key: 's', style: S.td }, item.status ?? '—'),
            ]))),
        ])),
        h('div', { key: 'sum', style: S.hint }, safeFill(t, 'usageSum', {
          count: sum.count,
          credits: credit(sum.credits),
          input: sum.inputTokens,
          output: sum.outputTokens,
        })),
        h('div', { key: 'pages', style: { ...S.row, justifyContent: 'space-between' } }, [
          h('span', { key: 'info', style: S.hint }, safeFill(t, 'usagePage', { page, pages, total: data?.total ?? 0 })),
          h('span', { key: 'ctl', style: S.row }, [
            h(Button, { key: 'prev', small: true, disabled: page <= 1 || busy, onClick: () => apply({ page: page - 1 }) }, t('usagePrev')),
            h(Button, { key: 'next', small: true, disabled: page >= pages || busy, onClick: () => apply({ page: page + 1 }) }, t('usageNext')),
            h('span', { key: 'size', style: S.label }, t('usagePageSize')),
            h('select', {
              key: 'ps',
              id: 'asp-usage-page-size',
              style: S.inputNarrow,
              value: String(query.pageSize),
              onChange: event => apply({ pageSize: Number(event.target.value) }),
            }, [20, 50, 100].map(size => h('option', { key: size, value: String(size) }, String(size)))),
          ]),
        ]),
      ])
    }


    /**
     * The console's own price list, one collapsible group per capability.
     *
     * Collapsed by default on purpose: a full price table is reference material,
     * not something a reader wants between them and the balance. Every figure is
     * the platform's own `display_*` string — re-deriving "1000 credits per
     * million tokens" from the raw numbers would be a second copy of the price
     * list, and the copy that drifts is always the one on screen.
     */
    function PricingPanel(props) {
      const { t, hasToken, accountId } = props
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      // Which groups are open. Empty = all collapsed, which is the default.
      const [open, setOpen] = React.useState(() => new Set())

      const load = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const answer = await api('/pricing', undefined, accountId)
          setData(answer.data ?? null)
        } catch (caught) { setError(caught.message) } finally { setBusy(false) }
      }, [accountId])

      if (!hasToken) return h('div', { style: S.hint }, t('pricingNeedToken'))

      const groups = Array.isArray(data?.groups) ? data.groups : []
      const promo = data?.active_promotion ?? null
      const toggle = key => setOpen(current => {
        const next = new Set(current)
        if (!next.delete(key)) next.add(key)
        return next
      })
      const groupLabel = type => {
        const key = { token: 'pricingGroupToken', tts: 'pricingGroupTts', image: 'pricingGroupImage', asr: 'pricingGroupAsr', video: 'pricingGroupVideo' }[type]
        return key === undefined ? t('pricingGroupOther') : t(key)
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
        h('div', { key: 'hint', style: S.hint }, t('pricingHint')),
        h('div', { key: 'actions', style: S.row }, [
          h(Button, { key: 'load', primary: true, onClick: load, disabled: busy }, busy ? t('pricingLoading') : t('pricingLoad')),
          promo === null ? null : h('span', { key: 'promo', style: S.pill('ok') },
            `${t('pricingPromo')}: ${promo.title ?? ''}${promo.credit_multiplier != null ? ` ×${promo.credit_multiplier}` : ''}`),
        ]),
        error === '' ? null : h('div', { key: 'err', style: S.error }, error),
        data === null
          ? null
          : groups.length === 0
            ? h('div', { key: 'empty', style: S.hint }, t('pricingEmpty'))
            : groups.map(group => {
              const key = String(group.billing_type ?? 'other')
              const expanded = open.has(key)
              const items = Array.isArray(group.items) ? group.items : []
              return h('div', { key, style: S.modelCard }, [
                h('button', {
                  key: 'head',
                  type: 'button',
                  onClick: () => toggle(key),
                  'aria-expanded': expanded,
                  style: {
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
                    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                    color: 'var(--dsw-alias-label-primary)', fontSize: '12px', fontWeight: 600,
                  },
                }, [
                  h('span', { key: 'l' }, `${expanded ? '▾' : '▸'} ${groupLabel(group.billing_type)} (${items.length})`),
                  group.meter_hint == null ? null : h('span', { key: 'h', style: { ...S.hint, fontWeight: 400 } }, group.meter_hint),
                ]),
                expanded
                  ? h('div', { key: 'body', style: S.tableWrap }, h('table', { style: S.table }, [
                    h('thead', { key: 'head' }, h('tr', null, [
                      t('pricingColModel'), t('pricingColTier'), t('pricingColInput'), t('pricingColCache'), t('pricingColOutput'), t('pricingColUnit'),
                    ].map((label, index) => h('th', { key: index, style: S.th }, label)))),
                    h('tbody', { key: 'body' }, items.map((item, index) => h('tr', { key: `${item.model_id ?? index}-${index}` }, [
                      h('td', { key: 'm', style: { ...S.td, ...S.mono } }, item.model_id ?? '—'),
                      h('td', { key: 'c', style: S.td }, item.context_tier ?? '—'),
                      h('td', { key: 'i', style: S.td }, item.display_input ?? '—'),
                      h('td', { key: 'cache', style: S.td }, item.display_cache ?? '—'),
                      h('td', { key: 'o', style: S.td }, item.display_output ?? '—'),
                      h('td', { key: 'u', style: S.td }, item.display_unit ?? '—'),
                    ]))),
                  ]))
                  : null,
              ])
            }),
      ])
    }

    // -----------------------------------------------------------------------
    // Account pool
    //
    // One installation can now hold several AgentScope accounts. Two words that
    // must never be confused (the plugin glossary keeps them apart):
    //
    //   * BILLING account — the one new requests use. Exactly one at a time, and
    //     the only thing this section ever changes on the wire.
    //   * VIEWED account — whose data the sections below display. Changing it
    //     changes nothing about what gets billed.
    //
    // There is deliberately NO request-level failover here: a switch redirects
    // NEW requests only and never interrupts a stream already in flight, and the
    // copy says so out loud (ADR 0001). The single automatic behaviour is picking
    // a healthier account by remaining credit, and only between probes.
    // -----------------------------------------------------------------------

    /**
     * The status chips for one account row.
     *
     * Tones come from the panel's own pill (`S.pill`): 'ok' for the billing
     * account, 'bad' for the two states that stop an account working at all
     * (disabled / credentials expired), neutral for the advisory ones.
     *
     * `disabledReason` and `probe.outcome` are different questions — "why is this
     * account excluded" versus "what did the last probe say" — so both are shown
     * rather than collapsed into one.
     */
    function accountBadges(t, account) {
      const badges = []
      if (account?.active === true) badges.push({ key: 'current', tone: 'ok', text: safeT(t, 'accountStateCurrent') })
      if (account?.enabled === false) badges.push({ key: 'disabled', tone: 'bad', text: safeT(t, 'accountStateDisabled') })
      if (account?.disabledReason === 'expired' || account?.probe?.outcome === 'expired') {
        badges.push({ key: 'expired', tone: 'bad', text: safeT(t, 'accountStateExpired') })
      }
      if (account?.probe?.outcome === 'out-of-credit') badges.push({ key: 'low', tone: undefined, text: safeT(t, 'accountStateLowCredit') })
      return badges
    }

    /** A millisecond stamp from an account projection, in the panel's own format. */
    function accountStamp(t, ms) {
      return typeof ms === 'number' && ms > 0 ? stamp(new Date(ms).toISOString()) : safeT(t, 'never')
    }

    /** The label to show for an account: never an empty row. */
    function accountTitle(t, account) {
      const label = typeof account?.label === 'string' ? account.label.trim() : ''
      return label === '' ? safeT(t, 'accountUntitled') : label
    }

    /**
     * How the current `sk-as-` key got there: pasted by hand or fetched.
     *
     * It matters when a fetch "succeeds" but the platform returned a key the user
     * did not expect — the badge says which route produced what is on screen.
     * An unknown source renders nothing rather than a guessed word.
     */
    function modelKeySourceLabel(t, source) {
      if (source === 'pasted') return safeT(t, 'modelKeySourcePasted')
      if (source === 'fetched') return safeT(t, 'modelKeySourceFetched')
      return ''
    }

    /**
     * Whether a projection describes usable credentials.
     *
     * `usable` is authoritative when present. A host that only reports
     * `credentialState` still answers the same question — "refresh-only" is a
     * working state, not an error.
     */
    function accountHasToken(account) {
      if (account === null || account === undefined) return false
      if (typeof account.usable === 'boolean') return account.usable
      return typeof account.credentialState === 'string' && account.credentialState !== 'missing'
    }

    /**
     * The account pool: the billing-account picker, one row per account, the
     * add form, and the credit-threshold switch.
     *
     * Every mutation goes through the panel's `run(label, action)` so busy/error/
     * notice behave exactly like the rest of the page — there is no second
     * feedback mechanism here. `onPool` takes a fresh projection from the host;
     * the host stays the single source of truth for the account list.
     */
    function AccountPoolSection(props) {
      const {
        t, pool, onPool, run, busy, notify, patchAccount, reloadPool,
        modelKeyMask = '', modelKeyConfigured = false, modelKeySource = '',
      } = props
      const accounts = Array.isArray(pool.accounts) ? pool.accounts : []
      const activeAccountId = typeof pool.activeAccountId === 'string' ? pool.activeAccountId : ''
      const autoSwitch = pool.autoSwitch ?? {}
      // Same breakpoint as the composer pill: on a phone an account row becomes a
      // single column instead of a row that would overflow the settings panel.
      const narrow = useNarrowScreen()

      const [adding, setAdding] = React.useState(false)
      const [label, setLabel] = React.useState('')
      const [token, setToken] = React.useState('')
      const [modelKey, setModelKey] = React.useState('')
      const [activate, setActivate] = React.useState(false)
      // Two-step delete: the id awaiting confirmation. Nothing is removed until
      // the SAME row is confirmed, so a mis-click on one row cannot delete another.
      const [pendingRemove, setPendingRemove] = React.useState('')
      const [renaming, setRenaming] = React.useState(null)
      const [threshold, setThreshold] = React.useState(String(autoSwitch.thresholdPct ?? 20))
      // The one row whose credential fields are open. One at a time: two open
      // editors for two accounts invite pasting a token into the wrong one.
      const [editing, setEditing] = React.useState('')
      const [editToken, setEditToken] = React.useState('')
      const [editInterval, setEditInterval] = React.useState('')
      const [editModelKey, setEditModelKey] = React.useState('')

      // The host is the authority on the threshold; a fresh projection re-seeds
      // the box (it is an input, so only an outside change may overwrite it).
      React.useEffect(() => { setThreshold(String(autoSwitch.thresholdPct ?? 20)) }, [autoSwitch.thresholdPct])

      const switchTo = accountId => run('account-switch', async () => {
        const answer = await post('/accounts/switch', { accountId })
        onPool(answer)
      })

      /**
       * Probe one account.
       *
       * `/accounts/test` answers with the PROBE, not with the pool projection
       * (`{ probe, credentialState, credits }`), so the row is patched in place
       * and the list is re-read: a probe can flip `disabledReason` to `expired`
       * on the host, and guessing that transition here would be a second copy of
       * a rule the host owns.
       */
      const testAccount = accountId => run('account-test', async () => {
        let answer
        try {
          answer = await post('/accounts/test', { accountId })
        } catch (caught) {
          throw new Error(`${safeT(t, 'accountTestFailed')}: ${caught.message}`)
        }
        patchAccount(accountId, {
          probe: answer?.probe ?? null,
          ...(answer?.credentialState === undefined ? {} : { credentialState: answer.credentialState }),
          ...(answer?.credits === undefined ? {} : { credits: answer.credits }),
        })
        notify(safeT(t, 'accountTestOk'))
        await reloadPool()
      })

      const setEnabled = (account, enabled) => run('account-enable', async () => {
        // Advisory guard, mirrored from the host's own rule: the panel says why
        // before the request goes out, and the host still has the final word.
        if (enabled === false && accounts.filter(row => row.enabled !== false).length <= 1) {
          throw new Error(safeT(t, 'accountCannotDisableLast'))
        }
        const answer = await post('/accounts/enable', { accountId: account.id, enabled })
        onPool(answer)
      })

      const renameAccount = () => run('account-rename', async () => {
        const next = renaming ?? {}
        const name = String(next.label ?? '').trim()
        if (name === '') throw new Error(safeT(t, 'accountNeedLabel'))
        const answer = await post('/accounts/rename', { accountId: next.id, label: name })
        onPool(answer)
        setRenaming(null)
      })

      const removeAccount = accountId => run('account-remove', async () => {
        const answer = await post('/accounts/remove', { accountId })
        onPool(answer)
        setPendingRemove('')
      })

      // ---------------------------------------------------------------------
      // One account's credentials, edited in place
      //
      // These used to be a separate "Credentials and model key" section, which
      // edited whichever account the VIEWED-account picker pointed at — two
      // controls for one file, and two ways for them to disagree. Each action
      // now takes the row's own id, so the account you can see is the account
      // you are changing.
      // ---------------------------------------------------------------------

      const saveToken = account => run('account-token', async () => {
        const draft = editToken.trim()
        if (draft === '') throw new Error(safeT(t, 'accountNeedToken'))
        const body = { refreshToken: draft }
        if (String(editInterval).trim() !== '') body.intervalMin = intervalMinutes()
        const answer = await post('/config', body, account.id)
        setEditToken('')
        patchAccount(account.id, {
          ...(answer?.credentialState === undefined ? {} : { credentialState: answer.credentialState }),
          usable: answer?.usable === true || account.usable === true,
        })
        // A pasted refresh token is exchanged immediately, so a refusal is worth
        // saying out loud: the box is now empty and the stored pair is unchanged.
        if (answer?.exchanged !== undefined && answer.exchanged !== null && answer.exchanged.ok !== true) {
          throw new Error(`${safeT(t, 'refreshFailed')}: ${answer.exchanged.error ?? ''}`)
        }
        notify(safeT(t, answer?.exchanged?.ok === true ? 'phoneExchanged' : 'ok'))
        await reloadPool()
      })

      const fetchKey = account => run('account-key-fetch', async () => {
        const answer = await post('/model-key/fetch', {}, account.id)
        patchAccount(account.id, { credentialState: answer?.configured === true ? account.credentialState : account.credentialState })
        if (answer?.configured !== true) throw new Error(safeT(t, 'modelKeyNotReturned'))
        notify(safeT(t, 'modelKeyFetched'))
      })

      const resetKey = account => run('account-key-reset', async () => {
        const answer = await post('/model-key/reset', {}, account.id)
        notify(safeT(t, answer?.rotated === true ? 'modelKeyFetched' : 'modelKeyNotReturned'))
      })

      const saveKey = account => run('account-key', async () => {
        const draft = editModelKey.trim()
        if (draft === '') throw new Error(safeT(t, 'modelKeyMissing'))
        await post('/model-key', { key: draft }, account.id)
        setEditModelKey('')
        notify(safeT(t, 'ok'))
      })

      const addAccount = () => run('account-add', async () => {
        const name = label.trim()
        const refresh = token.trim()
        if (name === '') throw new Error(safeT(t, 'accountNeedLabel'))
        if (refresh === '') throw new Error(safeT(t, 'accountNeedToken'))
        const body = { label: name, refreshToken: refresh, activate }
        // An empty key means "let the host fetch one": sending "" would look like
        // a deliberate clear.
        if (modelKey.trim() !== '') body.modelKey = modelKey.trim()
        const answer = await post('/accounts', body)
        onPool(answer)
        setLabel(''); setToken(''); setModelKey(''); setActivate(false); setAdding(false)
        // The host verifies the token BEFORE the account appears in the list, so a
        // rejected token is reported the same way /config reports it.
        if (answer?.exchanged !== undefined && answer.exchanged !== null && answer.exchanged.ok !== true) {
          throw new Error(`${safeT(t, 'refreshFailed')}: ${answer.exchanged.error ?? ''}`)
        }
        notify(safeT(t, answer?.exchanged?.ok === true ? 'phoneExchanged' : 'ok'))
      })

      /** The polling interval in minutes, clamped to the range the host accepts. */
      const intervalMinutes = () => {
        const value = Number(editInterval)
        if (!Number.isFinite(value) || value <= 0) return 30
        return Math.min(1440, Math.max(5, Math.round(value)))
      }

      /**
       * The threshold as a percentage.
       *
       * `Number(x) || 20` would turn a deliberate 0 ("always take the healthiest
       * account") into 20, so only an unparseable or out-of-range box falls back.
       */
      const thresholdPct = () => {
        const value = Number(threshold)
        if (!Number.isFinite(value)) return 20
        return Math.min(100, Math.max(0, Math.round(value)))
      }

      // Immediate effect, like every other switch on this page: no draft, no save.
      const applyAutoSwitch = enabled => run('account-auto', async () => {
        const answer = await post('/accounts/auto-switch', { enabled, thresholdPct: thresholdPct() })
        onPool(answer)
      })

      const applyThreshold = () => run('account-auto', async () => {
        const answer = await post('/accounts/auto-switch', { enabled: autoSwitch.enabled === true, thresholdPct: thresholdPct() })
        onPool(answer)
      })

      const rowStyle = {
        display: 'flex',
        flexDirection: narrow ? 'column' : 'row',
        alignItems: narrow ? 'stretch' : 'center',
        gap: '8px',
        flexWrap: 'wrap',
        borderTop: '1px solid var(--dsw-alias-border-l4)',
        paddingTop: '10px',
      }
      const actionsStyle = { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }

      const header = [
        h('span', { key: 'k', style: S.kvKey }, safeT(t, 'accountCurrent')),
        accounts.length === 0
          ? null
          : h('select', {
            key: 's',
            id: 'asp-account-switch',
            style: { ...S.input, flex: '0 0 auto', width: narrow ? '100%' : '220px' },
            value: activeAccountId,
            disabled: busy !== '',
            onChange: event => { void switchTo(event.target.value) },
          }, accounts.map(row => h('option', { key: row.id, value: row.id }, accountTitle(t, row)))),
        h(Button, { key: 'a', id: 'asp-account-add', small: true, onClick: () => setAdding(value => !value), disabled: busy !== '' }, safeT(t, 'accountAdd')),
      ]

      return h(Section, {
        key: 'accounts',
        title: safeT(t, 'sectionAccounts'),
        // This badge used to repeat the CURRENT account's name, which the picker
        // right below already shows and the highlighted row already marks. Three
        // statements of one fact, and none of them the question a visitor has:
        // how many accounts are there? The count answers that, and the picker
        // keeps owning "which one".
        actions: [h('span', { key: 'p', style: S.pill(accounts.length === 0 ? undefined : 'ok') },
          accounts.length === 0 ? safeT(t, 'accountNoneYet') : safeFill(t, 'accountCount', { count: accounts.length }))],
        children: [
          // The two explanations here were the first thing on the page and the
          // least needed on a second visit: they described concepts the controls
          // already show. They are now one quiet hint under the picker instead of
          // a paragraph above it, so the account rows start near the top.
          h('div', { key: 'head', style: S.row }, header),
          h('div', { key: 'switchHint', style: S.hint }, safeT(t, 'accountSwitchHint')),

          adding ? h('div', { key: 'add', style: { ...S.modelCard, gap: '8px' } }, [
            h(Row, { key: 'label', label: safeT(t, 'accountLabel') }, h('input', {
              key: 'i',
              id: 'asp-account-new-label',
              autoComplete: 'off',
              style: S.input,
              value: label,
              placeholder: safeT(t, 'accountUntitled'),
              onChange: event => setLabel(event.target.value),
            })),
            h(Row, { key: 'token', label: safeT(t, 'refreshToken') }, h('input', {
              key: 'i',
              id: 'asp-account-new-token',
              name: 'asp-account-new-token',
              'data-lpignore': 'true',
              // "new-password", never "off": Chrome autofills password fields
              // regardless of off (same reason as the credentials field below).
              autoComplete: 'new-password',
              style: S.input,
              type: 'password',
              value: token,
              onChange: event => setToken(event.target.value),
            })),
            // Reuses the credentials section's instructions: the platform's
            // console is the only place a refresh token comes from.
            h('div', { key: 'howto', style: S.hint }, [
              h('div', { key: 'p' }, safeT(t, 'refreshTokenHowTo')),
              h('code', {
                key: 'c',
                style: { ...S.mono, display: 'block', marginTop: '4px', padding: '5px 7px', borderRadius: '5px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', userSelect: 'all', wordBreak: 'break-all' },
              }, safeT(t, 'refreshTokenSnippet')),
            ]),
            h(Row, { key: 'key', label: safeT(t, 'accountModelKey') }, h('input', {
              key: 'i',
              id: 'asp-account-new-key',
              name: 'asp-account-new-key',
              'data-lpignore': 'true',
              autoComplete: 'new-password',
              style: S.input,
              type: 'password',
              value: modelKey,
              placeholder: 'sk-as-…',
              onChange: event => setModelKey(event.target.value),
            })),
            h(Row, { key: 'activate' }, h('label', { style: S.check }, [
              h('input', {
                id: 'asp-account-new-activate',
                type: 'checkbox',
                checked: activate,
                disabled: busy !== '',
                onChange: event => setActivate(event.target.checked),
              }),
              safeT(t, 'accountActivate'),
            ])),
            h('div', { key: 'go', style: S.row }, [
              h(Button, { key: 'save', id: 'asp-account-new-save', primary: true, onClick: addAccount, disabled: busy !== '' }, busy === 'account-add' ? safeT(t, 'accountSaving') : safeT(t, 'accountAdd')),
              h(Button, { key: 'cancel', id: 'asp-account-new-cancel', onClick: () => setAdding(false), disabled: busy !== '' }, safeT(t, 'cancel')),
            ]),
          ]) : null,

          accounts.length === 0
            ? h('div', { key: 'empty', style: S.hint }, safeT(t, 'accountEmpty'))
            : accounts.map(account => {
              const title = accountTitle(t, account)
              const renamingThis = renaming !== null && renaming.id === account.id
              // WHICH account pays is the one thing this list exists to answer,
              // and every row was drawn identically: the only cue was a small
              // "Current" pill you had to read. The paying row now carries a
              // left rule and a tint, so it is legible before any text is read.
              const isCurrent = account.active === true
              return h('div', {
                key: account.id,
                style: isCurrent ? { ...rowStyle, ...S.rowCurrent } : rowStyle,
              }, [
                h('div', { key: 'id', style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', flex: '1 1 200px', minWidth: 0 } }, [
                  h('span', { key: 'n', style: { ...S.kvVal, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' } }, title),
                  ...accountBadges(t, account).map(badge => h('span', { key: badge.key, style: S.pill(badge.tone) }, badge.text)),
                ]),
                h('div', { key: 'meta', style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', fontSize: '12px' } }, [
                  h('span', { key: 'c', style: S.kvKey },
                    `${safeT(t, 'accountCredits')} ${credit(account.credits)}`),
                  h('span', { key: 'r', style: S.kvKey },
                    `${safeT(t, 'accountLastRefreshed')} ${accountStamp(t, account.lastRefreshedAt)} ${stampZoneLabel()}`),
                ]),
                h('div', { key: 'acts', style: actionsStyle }, [
                  // "Make current" only appears where it can do something.
                  account.active === true || account.enabled === false ? null : h(Button, {
                    key: 'cur',
                    id: `asp-account-current-${account.id}`,
                    small: true,
                    onClick: () => { void switchTo(account.id) },
                    disabled: busy !== '',
                  }, safeT(t, 'accountSetCurrent')),
                  h(Button, {
                    key: 'test',
                    id: `asp-account-test-${account.id}`,
                    small: true,
                    onClick: () => { void testAccount(account.id) },
                    disabled: busy !== '',
                  }, busy === 'account-test' ? safeT(t, 'loading') : safeT(t, 'accountTest')),
                  h(Button, {
                    key: 'en',
                    id: `asp-account-enable-${account.id}`,
                    small: true,
                    onClick: () => { void setEnabled(account, account.enabled === false) },
                    disabled: busy !== '',
                  }, account.enabled === false ? safeT(t, 'accountEnable') : safeT(t, 'accountDisable')),
                  h(Button, {
                    key: 'ed',
                    id: `asp-account-edit-${account.id}`,
                    small: true,
                    onClick: () => {
                      setEditing(editing === account.id ? '' : account.id)
                      setEditToken(''); setEditInterval(''); setEditModelKey('')
                    },
                    disabled: busy !== '',
                  }, safeT(t, 'accountEdit')),
                  h(Button, {
                    key: 'rn',
                    id: `asp-account-rename-${account.id}`,
                    small: true,
                    onClick: () => setRenaming(renamingThis ? null : { id: account.id, label: title }),
                    disabled: busy !== '',
                  }, safeT(t, 'accountRename')),
                  // The destructive pair is pushed to the opposite end, away from
                  // the routine buttons: five same-weight chips in a row made
                  // "Remove" sit one slip away from "Probe".
                  h('span', { key: 'gap', 'aria-hidden': 'true', style: { flex: '1 1 auto' } }),
                  pendingRemove === account.id
                    ? h(Button, {
                      key: 'rm',
                      id: `asp-account-remove-${account.id}`,
                      small: true,
                      onClick: () => { void removeAccount(account.id) },
                      disabled: busy !== '',
                      title: safeT(t, 'accountRemoveConfirm'),
                      style: S.buttonDanger,
                    }, `${safeT(t, 'accountRemoveConfirm')} ${safeT(t, 'ok')}`)
                    : h(Button, {
                      key: 'rm',
                      id: `asp-account-remove-${account.id}`,
                      small: true,
                      onClick: () => setPendingRemove(account.id),
                      disabled: busy !== '',
                      style: S.buttonDanger,
                    }, safeT(t, 'accountRemove')),
                  pendingRemove === account.id
                    ? h(Button, { key: 'no', small: true, onClick: () => setPendingRemove(''), disabled: busy !== '' }, safeT(t, 'cancel'))
                    : null,
                ]),
                renamingThis
                  ? h('div', { key: 'ren', style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', flexBasis: '100%' } }, [
                    h('input', {
                      key: 'i',
                      id: `asp-account-rename-input-${account.id}`,
                      autoComplete: 'off',
                      style: S.input,
                      value: renaming.label,
                      onChange: event => setRenaming({ id: account.id, label: event.target.value }),
                    }),
                    h(Button, { key: 's', id: `asp-account-rename-save-${account.id}`, small: true, onClick: renameAccount, disabled: busy !== '' }, safeT(t, 'save')),
                    h(Button, { key: 'c', id: `asp-account-rename-cancel-${account.id}`, small: true, onClick: () => setRenaming(null), disabled: busy !== '' }, safeT(t, 'cancel')),
                  ])
                  : null,
                editing === account.id
                  ? h('div', { key: 'edit', style: { ...S.modelCard, gap: '8px', flexBasis: '100%' } }, [
                    h('div', { key: 'h', style: S.hint }, safeT(t, 'accountEditHint')),
                    // Login credential. The platform hands out a refresh token in
                    // its own console; the line below is the only reliable way to
                    // read it (verified against the shipped console bundle).
                    h(Row, { key: 'tk', label: safeT(t, 'refreshToken') }, h('input', {
                      key: 'i',
                      id: `asp-account-token-${account.id}`,
                      name: `asp-account-token-${account.id}`,
                      'data-lpignore': 'true',
                      // "new-password", never "off": Chrome autofills password
                      // inputs regardless of off and would paste a saved login.
                      autoComplete: 'new-password',
                      style: S.input,
                      type: 'password',
                      value: editToken,
                      placeholder: safeT(t, 'accountTokenPlaceholder'),
                      onChange: event => setEditToken(event.target.value),
                    })),
                    h('div', { key: 'tksave', style: S.row }, h(Button, {
                      key: 'b',
                      id: `asp-account-token-save-${account.id}`,
                      small: true,
                      onClick: () => { void saveToken(account) },
                      disabled: busy !== '' || editToken.trim() === '',
                      title: editToken.trim() === '' ? safeT(t, 'tokenPasteFirst') : safeT(t, 'save'),
                    }, busy === 'account-token' ? safeT(t, 'saving') : safeT(t, 'save'))),
                    h(Row, { key: 'iv', label: safeT(t, 'pullInterval') }, h('input', {
                      key: 'i',
                      id: `asp-account-interval-${account.id}`,
                      style: S.inputNarrow,
                      type: 'number',
                      min: 5,
                      max: 1440,
                      value: editInterval,
                      placeholder: '30',
                      onChange: event => setEditInterval(event.target.value),
                    })),
                    // The console recipe is a one-time read, not an instruction to
                    // re-read on every visit. It sat ABOVE the save chip and pushed
                    // the actual controls down the panel.
                    h('details', { key: 'howto' }, [
                      h('summary', { key: 's', style: S.detailsSummary }, safeT(t, 'tokenHowToToggle')),
                      h('div', { key: 'body', style: S.hint }, [
                        h('div', { key: 'p' }, safeT(t, 'refreshTokenHowTo')),
                        h('code', {
                          key: 'c',
                          style: { ...S.mono, display: 'block', marginTop: '4px', padding: '5px 7px', borderRadius: '5px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', userSelect: 'all', wordBreak: 'break-all' },
                        }, safeT(t, 'refreshTokenSnippet')),
                      ]),
                    ]),
                    // Model key: a SEPARATE credential from the login token, and
                    // the one model calls actually use.
                    h('div', { key: 'mk', style: { borderTop: '1px solid var(--dsw-alias-border-l4)', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' } }, [
                      h('div', { key: 'h', style: S.hint }, safeT(t, 'modelKeyHint')),
                      // Two ways to fill ONE field, stated as such. The buttons
                      // used to sit above the input with a "paste a key" label
                      // underneath, which read like a required sequence rather
                      // than a choice.
                      h('div', { key: 'src', style: { ...S.hint, fontWeight: 600 } }, safeT(t, 'modelKeyEither')),
                      // WHICH key is in place. The host already answers with a
                      // head-and-tail mask; showing it turns the edit panel from
                      // a blank password box into "this is the key you have, and
                      // it is not the one you just pasted".
                      h('div', { key: 'now', style: { ...S.kv, justifyContent: 'flex-start', gap: '8px' } }, [
                        h('span', { key: 'k', style: S.kvKey }, safeT(t, 'modelKeyCurrent')),
                        modelKeyConfigured
                          ? h('span', { key: 'v', style: S.kvMono }, modelKeyMask)
                          : h('span', { key: 'v', style: S.kvKey }, safeT(t, 'modelKeyMissing')),
                        modelKeyConfigured && modelKeySource !== ''
                          ? h('span', { key: 's', style: S.pill('ok') }, modelKeySourceLabel(t, modelKeySource))
                          : null,
                      ]),
                      h('div', { key: 'acts', style: actionsStyle }, [
                        h(Button, {
                          key: 'f',
                          id: `asp-account-key-fetch-${account.id}`,
                          small: true,
                          onClick: () => { void fetchKey(account) },
                          disabled: busy !== '',
                          title: safeT(t, 'modelKeyFetchHint'),
                        }, busy === 'account-key-fetch' ? safeT(t, 'loading') : safeT(t, 'modelKeyFetch')),
                        h(Button, {
                          key: 'r',
                          id: `asp-account-key-reset-${account.id}`,
                          small: true,
                          onClick: () => { void resetKey(account) },
                          disabled: busy !== '',
                          title: safeT(t, 'modelKeyResetWarn'),
                        }, safeT(t, 'modelKeyReset')),
                      ]),
                      // Why not every account has one: the platform shows a full
                      // key only at generate/reset time, so "fetch" can legitimately
                      // come back empty. Saying so here prevents that being read as
                      // another broken button.
                      h('div', { key: 'fetchNote', style: S.hint }, safeT(t, 'modelKeyFetchNote')),
                      h(Row, { key: 'paste', label: safeT(t, 'modelKeyPaste') }, [
                        h('input', {
                          key: 'i',
                          id: `asp-account-key-${account.id}`,
                          name: `asp-account-key-${account.id}`,
                          'data-lpignore': 'true',
                          autoComplete: 'new-password',
                          style: S.input,
                          type: 'password',
                          value: editModelKey,
                          placeholder: 'sk-as-…',
                          onChange: event => setEditModelKey(event.target.value),
                        }),
                        h(Button, {
                          key: 'b',
                          id: `asp-account-key-save-${account.id}`,
                          small: true,
                          onClick: () => { void saveKey(account) },
                          disabled: busy !== '' || editModelKey.trim() === '',
                          // A DISABLED button with no explanation reads as "this
                          // does nothing" — which is exactly how it was reported.
                          title: editModelKey.trim() === '' ? safeT(t, 'modelKeyPasteFirst') : safeT(t, 'save'),
                        }, safeT(t, 'save')),
                      ]),
                      // The reason the save chip is inert, stated in place rather
                      // than behind a tooltip hover nobody performs.
                      editing === account.id && editModelKey.trim() === ''
                        ? h('div', { key: 'saveHint', style: S.hint }, safeT(t, 'modelKeyPasteFirst'))
                        : null,
                    ]),
                  ])
                  : null,
              ])
            }),

          h('div', { key: 'auto', style: { ...rowStyle, paddingTop: '12px' } }, [
            h('label', { key: 'sw', style: S.check }, [
              h('input', {
                id: 'asp-account-auto-switch',
                type: 'checkbox',
                checked: autoSwitch.enabled === true,
                disabled: busy !== '' || accounts.length === 0,
                onChange: event => { void applyAutoSwitch(event.target.checked) },
              }),
              safeT(t, 'accountAutoSwitch'),
            ]),
            h('label', { key: 'th', style: S.check }, [
              safeT(t, 'accountThreshold'),
              h('input', {
                id: 'asp-account-threshold',
                style: { ...S.input, flex: '0 0 auto', width: '80px' },
                type: 'number',
                min: 0,
                max: 100,
                value: threshold,
                disabled: busy !== '' || accounts.length === 0,
                onChange: event => setThreshold(event.target.value),
                onBlur: applyThreshold,
              }),
              '%',
            ]),
          ]),
          // The one sentence the ADR requires to be visible: this is NOT automatic
          // failover, and it never touches a request already on the wire.
          h('div', { key: 'autoHint', style: S.hint }, safeT(t, 'accountAutoSwitchHint')),
        ],
      })
    }

    // -----------------------------------------------------------------------
    // Settings page
    // -----------------------------------------------------------------------

    function SettingsPanel(props) {
      const { t } = props
      const [state, setState] = React.useState(null)
      // Shared with the composer pill: the panel shows the SAME credits document.
      const sharedCredits = React.useSyncExternalStore(creditsStore.subscribe, creditsStore.getSnapshot)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const answer = await api('/state')
          setState(answer)
          setError('')
        } catch (caught) { setError(caught.message) }
      }, [])
      React.useEffect(() => { void load() }, [load])
      React.useEffect(() => { void creditsStore.refresh() }, [])

      /**
       * Re-read the aggregate state whenever the SHARED credits document moves.
       *
       * `/quick` now records its reading as that account's probe, so the pill's
       * refresh IS a new measurement — but the account rows come from `/state`,
       * which this panel only fetched on mount. The two then showed different
       * balances for one account until the panel was reopened. Keyed on the
       * document's timestamp so a re-render that changes nothing costs no read.
       */
      const creditsAt = sharedCredits.at
      React.useEffect(() => {
        if (creditsAt === 0) return
        void load()
      }, [creditsAt, load])

      const run = async (label, action) => {
        setBusy(label)
        setError('')
        setNotice('')
        try { await action() } catch (caught) { setError(caught.message) } finally { setBusy('') }
      }

      /**
       * The pool the panel renders.
       *
       * There is ONE account in play: the billed-to one. Every per-account
       * section below reads it, and every per-account request omits the id so
       * the host resolves the same account itself — one notion of "the current
       * account" instead of two that can disagree.
       */
      const accounts = Array.isArray(state?.accounts) ? state.accounts : []
      const activeAccountId = typeof state?.activeAccountId === 'string' ? state.activeAccountId : ''
      const billingAccount = accounts.find(row => row.id === activeAccountId) ?? null

      if (state === null) {
        return h('div', { style: S.hint }, error === '' ? t('loading') : error)
      }

      const credits = sharedCredits.credits ?? {}
      const creditsError = sharedCredits.error
      const user = state.credits?.latest?.user ?? {}
      const promo = credits.active_promotion ?? null
      const catalog = Array.isArray(state.catalog) ? state.catalog : []
      // A refresh token alone is enough: the host exchanges it on the first call.
      const hasToken = accountHasToken(billingAccount)
      // GLOBAL by definition: the catalog and its metadata are shared by every
      // account, so they always come from the billing document. The check-in and
      // the model key are per-account and follow the viewed one.
      const checkin = state.checkin ?? {}
      const modelKeyView = state.modelKey ?? {}
      const meta = state.meta ?? {}

      /**
       * Fold an account-pool answer back into the shared page state.
       *
       * The pool endpoints answer with the same projection `GET /accounts` does,
       * so the list, the billing id and the auto-switch preference are taken from
       * it verbatim — the host is the authority, this page only mirrors it.
       */
      const applyPool = answer => {
        if (answer === null || answer === undefined) return
        /**
         * Switching the billed-to account invalidates every reading on screen.
         *
         * The pill, the credits section and the check-in all describe the
         * BILLING account, so after a switch they must re-read or they keep
         * showing the previous account's balance under the new one's name.
         * Forced (not the fresh-skip path): the store's cache belongs to the
         * account it was read from, and this is a different account.
         *
         * Done HERE rather than inside the state updater: an updater must stay
         * pure (React may run it more than once), so the comparison reads the
         * current state first and the fetch is fired outside.
         */
        const switching = typeof answer.activeAccountId === 'string'
          && state !== null && answer.activeAccountId !== state.activeAccountId
        setState(previous => previous === null ? previous : {
          ...previous,
          ...(Array.isArray(answer.accounts) ? { accounts: answer.accounts } : {}),
          ...(typeof answer.activeAccountId === 'string' ? { activeAccountId: answer.activeAccountId } : {}),
          ...(answer.autoSwitch === undefined ? {} : { pool: { ...(previous.pool ?? {}), autoSwitch: answer.autoSwitch } }),
        })
        if (switching) {
          // `load()` directly as well: the check-in block lives on `/state` and
          // does NOT ride the pool projection, and the credits effect is keyed on
          // a timestamp — two refreshes landing in one millisecond would leave it
          // showing the previous account's record.
          void load()
          void creditsStore.refresh(true)
        }
        }

      /**
       * Patch ONE row of the account list in place.
       *
       * The pool endpoints that answer with a full projection go through
       * `applyPool`; a few (the probe) answer with just that account's result, and
       * replacing the whole list with it would empty the section.
       */
      const patchAccount = (accountId, patch) => {
        setState(previous => previous === null || !Array.isArray(previous.accounts) ? previous : {
          ...previous,
          accounts: previous.accounts.map(row => row.id === accountId ? { ...row, ...patch } : row),
        })
      }

      /** Re-read the account list alone: a probe can change state the answer omits. */
      const reloadPool = async () => {
        const answer = await api('/accounts')
        if (Array.isArray(answer?.accounts)) applyPool(answer)
      }

      /** Fold a per-account answer back into the single state document. */
      const setDoc = patch => {
        setState(previous => previous === null ? previous : { ...previous, ...patch })
      }

      // GLOBAL: the provider switch, the catalog and the metadata are one
      // installation-wide setting, so they never name an account.
      const toggleProvider = () => run('provider', async () => {
        const answer = await post('/provider/toggle', { enabled: state.provider?.enabled !== true })
        setState(answer)
        setNotice(t('ok'))
      })

      const toggleCheckin = () => run('checkin', async () => {
        const answer = await post('/config/checkin', { enabled: checkin.enabled !== true })
        setDoc({ checkin: answer })
      })

      const runCheckin = () => run('checkinRun', async () => {
        const answer = await post('/checkin/run', {})
        setDoc({ checkin: answer.view ?? answer })
      })

      const fetchCredits = () => run('credits', async () => {
        // ONE document, one account: this refreshes the shared store the composer
        // pill reads, so the number here and the number there can never disagree.
        await creditsStore.refresh(true)
        await load()
      })

      const refreshMeta = () => run('meta', async () => {
        const answer = await post('/model-meta/refresh', { force: true })
        setState(previous => previous === null ? previous : { ...previous, meta: answer.state ?? previous.meta, catalog: previous.catalog })
        await load()
      })

      const statusTone = checkin.status === 'credited' ? 'ok' : checkin.status === 'failed' ? 'bad' : undefined
      const statusLabel = checkin.status === 'credited' ? t('checkinStatusCredited')
        : checkin.status === 'failed' ? t('checkinStatusFailed')
          : checkin.status === 'pending' ? t('checkinStatusPending')
            : t('checkinStatusIdle')

      // The host's modal layer auto-focuses `[data-modal-autofocus]` (or, if
      // none exists, the first enabled input) and marks it
      // `data-dsh-automatic-focus`. While that marker lives, typed characters
      // are treated as global shortcuts and forwarded — which is what filled the
      // workspace's session-search box and fired `session/search` on open.
      //
      // Giving the marker to a real container is NOT enough: `yi()` calls
      // `.focus()` on it and keeps the marker until a Tab/arrow key, so the
      // container itself becomes a keyboard sink. Instead we hand it a tiny,
      // NON-focusable anchor (`span` with no tabIndex): querySelector finds it,
      // `.focus()` is a no-op on it, and the marker never lands on any control
      // we render. The host's own focus trap still works from its nav buttons.
      const focusAnchor = h('span', {
        key: 'autofocus-anchor',
        'data-modal-autofocus': '',
        'aria-hidden': 'true',
        style: { display: 'none' },
      })
      return h('div', { style: S.page }, [
        focusAnchor,
        h('div', { key: 'head', style: S.head }, [
          h('h1', { key: 'h', style: S.h1 }, t('title')),
          // WHAT this page is, before the build stamp. A settings section that
          // opens on seven control groups with no sentence of context makes the
          // reader work out the point from the controls.
          h('p', { key: 'lead', style: S.sub }, t('pageLead')),
          h('p', { key: 's', style: S.sub }, [
            h('span', { key: 'meta' }, `${t('subtitle')} · ${t('build')} ${state.build ?? '—'} · `),
            // The platform this plugin talks to, where the account itself lives.
            // Opens in a new tab so a half-configured settings panel is not lost.
            h('a', {
              key: 'link',
              href: PLATFORM_URL,
              target: '_blank',
              rel: 'noreferrer noopener',
              style: S.link,
            }, safeT(t, 'platformLink')),
          ]),
        ]),

        // The single feedback line for every `run(label, action)` on this page.
        // It lives at page level because the actions that produce it are spread
        // across sections (credentials, account pool, check-in, catalog), and an
        // error rendered inside one section is invisible while the user is
        // looking at another.
        error === '' ? null : h('div', { key: 'err', style: S.error }, error),
        notice === '' ? null : h('div', { key: 'ok', style: S.row }, h('span', { style: S.pill('ok') }, notice)),

        // ---- account pool ----
        // ABOVE the credentials: "which account am I looking at / who is paying"
        // has to be settled before the fields below mean anything.
        h(AccountPoolSection, {
          key: 'accounts',
          t,
          pool: {
            accounts,
            activeAccountId,
            autoSwitch: state.pool?.autoSwitch ?? state.autoSwitch ?? {},
          },
          // The masked `sk-as-` key of the BILLING account, straight from the
          // host. Without it the edit panel was a blank password box: no way to
          // tell a configured key from a missing one, or one key from another.
          modelKeyMask: typeof modelKeyView.mask === 'string' ? modelKeyView.mask : '',
          modelKeyConfigured: modelKeyView.configured === true,
          modelKeySource: typeof modelKeyView.source === 'string' ? modelKeyView.source : '',
          onPool: applyPool,
          patchAccount,
          reloadPool,
          run,
          busy,
          notify: setNotice,
        }),

        // ---- provider ---- (GLOBAL: one switch for the whole installation)
        h(Section, {
          key: 'provider',
          title: t('sectionProvider'),
          actions: [
            h('span', { key: 'g', style: S.pill(undefined) }, safeT(t, 'accountsGlobalHint')),
            h('span', { key: 'p', style: S.pill(state.provider?.enabled === true ? 'ok' : undefined) },
              state.provider?.enabled === true ? t('providerOn') : t('providerOff')),
          ],
          children: [
            h('div', { key: 'hint', style: S.hint }, t('providerHint')),
            h(Row, { key: 'toggle' }, [
              h('label', { style: S.check }, [
                h('input', { id: 'asp-provider-enable', type: 'checkbox', checked: state.provider?.enabled === true, onChange: toggleProvider, disabled: busy !== '' }),
                t('providerEnable'),
              ]),
            ]),
            h(Row, { key: 'id', label: t('providerId') }, h('span', { style: S.kvMono }, state.provider?.id ?? 'agentscope')),
            h(Row, { key: 'dn', label: t('providerDisplayName') }, h('span', { style: S.kvVal }, state.provider?.displayName ?? 'AgentScope Platform')),
            h(Row, { key: 'bu', label: t('providerBaseUrl') }, h('span', { style: S.kvMono }, state.provider?.baseUrl ?? '—')),
            h(Row, { key: 'pr', label: t('providerProtocol') }, h('span', { style: S.kvVal }, t('providerProtocolOpenAI'))),
          ],
        }),

        // ---- catalog ---- (GLOBAL: the catalog and its metadata are shared by
        // every account; the model route is one installation-wide provider)
        h(Section, {
          key: 'catalog',
          title: t('sectionCatalog'),
          // COLLAPSED BY DEFAULT. A model list is set up once and then left
          // alone, but each row is a full form: an install with many models
          // pushed everything below it off the page. The summary keeps the
          // useful fact (how many models, when they were refreshed) visible.
          collapsible: true,
          defaultOpen: false,
          summary: safeFill(t, 'catalogSummary', {
            count: catalog.length,
            at: meta.checkedAt == null ? t('never') : stamp(new Date(meta.checkedAt).toISOString()),
          }),
          actions: [
            h('span', { key: 'g', style: S.pill(undefined) }, safeT(t, 'accountsGlobalHint')),
            h(Button, { key: 'meta', small: true, onClick: refreshMeta, disabled: busy !== '' }, busy === 'meta' ? t('metaRefreshing') : t('metaRefresh')),
          ],
          children: [
            h('div', { key: 'meta', style: { ...S.modelCard, gap: '4px' } }, [
              h('div', { key: 's', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('metaSource')), h('span', { key: 'v', style: S.kvVal }, meta.source ?? 'bundled')]),
              h('div', { key: 'u', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('metaUpdated')), h('span', { key: 'v', style: S.kvVal }, stamp(meta.checkedAt ? new Date(meta.checkedAt).toISOString() : '', t('never')))]),
              h('div', { key: 'm', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('metaModels')), h('span', { key: 'v', style: S.kvVal }, String(meta.modelCount ?? 0))]),
              meta.degraded === true ? h('div', { key: 'd', style: S.pill('bad') }, t('metaDegraded')) : null,
            ]),
            h(CatalogEditor, { key: 'editor', t, catalog, onSaved: answer => setState(previous => previous === null ? previous : { ...previous, catalog: answer.models ?? previous.catalog }) }),
          ],
        }),

        // ---- check-in ----
        h(Section, {
          key: 'checkin',
          title: t('sectionCheckin'),
          // Collapsed: this runs by itself once enabled, and its four numbers
          // change at most once a day. The state word stays in the header so a
          // collapsed section still answers "did today count".
          collapsible: true,
          defaultOpen: false,
          // The state word already sits in the header as a badge, so the summary
          // carries the fact the badge cannot: which day it refers to.
          summary: safeFill(t, 'checkinSummary', { day: checkin.day ?? '—' }),
          actions: [h('span', { key: 'p', style: S.pill(statusTone) }, statusLabel)],
          children: [
            h('div', { key: 'hint', style: S.hint }, t('checkinHint')),
            h(Row, { key: 'enable' }, h('label', { style: S.check }, [
              h('input', { id: 'asp-checkin-enable', type: 'checkbox', checked: checkin.enabled === true, onChange: toggleCheckin, disabled: busy !== '' }),
              t('checkinEnable'),
            ])),
            h('div', { key: 'kv', style: { ...S.modelCard, gap: '4px' } }, [
              h('div', { key: 'd', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('checkinToday')), h('span', { key: 'v', style: S.kvVal }, checkin.day ?? '—')]),
              h('div', { key: 'a', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('checkinAttempts')), h('span', { key: 'v', style: S.kvVal }, String(checkin.attempts ?? 0))]),
              h('div', { key: 'l', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('checkinLast')), h('span', { key: 'v', style: S.kvVal }, stamp(checkin.lastAttemptAt ? new Date(checkin.lastAttemptAt).toISOString() : '', t('never')))]),
              h('div', { key: 't', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('checkinTimezone')), h('span', { key: 'v', style: S.kvVal }, checkin.timezone ?? 'Asia/Shanghai')]),
              checkin.detail == null || checkin.detail === '' ? null : h('div', { key: 'x', style: S.hint }, checkin.detail),
              checkin.error == null || checkin.error === '' ? null : h('div', { key: 'e', style: S.error }, checkin.error),
            ]),
            h('div', { key: 'switches', style: S.row },
              h(Button, { key: 'run', onClick: runCheckin, disabled: busy !== '' }, busy === 'checkinRun' ? t('checkinRunning') : t('checkinRunNow')),
            ),
          ],
        }),

        // ---- credits ----
        h(Section, {
          key: 'credits',
          title: t('sectionCredits'),
          actions: [h(Button, { key: 'f', small: true, onClick: fetchCredits, disabled: busy !== '' || sharedCredits.loading }, sharedCredits.loading ? t('pillLoading') : t('creditsFetchNow'))],
          children: [
            h('div', { key: 'kv', style: { ...S.modelCard, gap: '4px' } }, [
              h('div', { key: 'u', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('creditUser')), h('span', { key: 'v', style: S.kvVal }, user.displayName ?? user.account ?? user.username ?? '—')]),
              h('div', { key: 'c', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('creditsAvailable')), h('span', { key: 'v', style: { ...S.kvVal, fontWeight: 700, fontSize: '16px' } }, credit(credits.display_available_credits))]),
              h('div', { key: 'l', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('creditsLifetime')), h('span', { key: 'v', style: S.kvVal }, credit(credits.lifetime_score))]),
              h('div', { key: 'r', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('creditsRedeemable')), h('span', { key: 'v', style: S.kvVal }, credit(credits.redeemable_score))]),
              h('div', { key: 'p', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('creditsPromotion')), h('span', { key: 'v', style: S.kvVal }, promo === null ? '—' : `${promo.title ?? ''}${promo.credit_multiplier != null ? ` ×${promo.credit_multiplier}` : ''}`)]),
              h('div', { key: 'f', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('creditsFetched')), h('span', { key: 'v', style: S.kvVal }, creditsAt === 0 ? t('never') : `${stamp(new Date(creditsAt).toISOString())} ${stampZoneLabel()}${creditsError !== '' ? ` · ${creditsError}` : ''}`)]),
            ]),
          ],
        }),

        // ---- usage ---- (before the price list: what you SPENT answers "why is
        // my balance what it is", and a reference table is what you reach for
        // afterwards)
        h(Section, {
          key: 'usage',
          title: t('sectionUsage'),
          // THE BIGGEST OFFENDER, and the least often opened. A page of usage
          // rows measured 1.8k px against a 485 px viewport, so leaving it open
          // meant scrolling past half the panel to reach anything below it.
          collapsible: true,
          defaultOpen: false,
          summary: t('usageSummary'),
          children: [
            h(UsagePanel, { key: 'panel', t, hasToken }),
          ],
        }),

        // ---- pricing ----
        h(Section, {
          key: 'pricing',
          title: t('sectionPricing'),
          collapsible: true,
          defaultOpen: false,
          summary: t('pricingSummary'),
          children: h(PricingPanel, { t, hasToken }),
        }),


      ])
    }


    /**
     * Narrow-screen detection for the composer pill.
     *
     * `conversation.input.right` is a shared row that gets cramped on phones:
     * the model picker, permission control and every other plugin's chip all
     * compete for the same width. On a narrow viewport the readout drops to JUST
     * the rounded credit number (plus its status dot) — no "Credits" label, no
     * redeemable-contribution segment. `matchMedia` is browser-native, needs no
     * service injection, and re-renders if the window crosses the breakpoint.
     */
    function useNarrowScreen(breakpoint = 640) {
      const query = `(max-width: ${breakpoint}px)`
      const subscribe = React.useCallback(listener => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
        const media = window.matchMedia(query)
        // Safari < 14 only has addListener/removeListener.
        if (typeof media.addEventListener === 'function') {
          media.addEventListener('change', listener)
          return () => media.removeEventListener('change', listener)
        }
        media.addListener(listener)
        return () => media.removeListener(listener)
      }, [query])
      const getSnapshot = React.useCallback(() =>
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia(query).matches
          : false, [query])
      return React.useSyncExternalStore(subscribe, getSnapshot, () => false)
    }

    // -----------------------------------------------------------------------
    // Composer credit readout
    // -----------------------------------------------------------------------

    /**
     * The readout next to the model picker.
     *
     * Polls a credits-only endpoint so the numbers stay current without paying
     * for the whole account document on every tick. It is deliberately NOT
     * provider-scoped: this plugin is the only AgentScope source in a profile,
     * so the reading is relevant whatever model the session is on. A missing
     * credential or a failed read renders "—" and never blocks the composer.
     */
    /**
     * The provider route this plugin owns. The readout is shown ONLY while the
     * session's selected model belongs to it — the same rule the WorkBuddy
     * connector uses (MIT, Copyright (c) 2026 LaoDing): its
     * `ComposerCreditsGate` reads the Host's `modelSelection` projection and
     * returns null for every other provider.
     *
     * That is not cosmetic. `conversation.input.right` is a SHARED list row: every
     * plugin that registers there competes for the same width, and an AgentScope
     * credit figure sitting beside a DeepSeek session is a number about nothing.
     * Gating also means no fetch loop runs while another provider is selected.
     */
    const COMPOSER_PROVIDER = 'agentscope'

    /**
     * Whether the CURRENT session is known to run on another provider, kept at
     * MODULE scope so it survives the session-scoped slot's re-mounts.
     *
     * `conversation.input.right` is a `scope: session` slot: switching sessions
     * makes the Host RE-MOUNT its occupants, and on the first render of the new
     * instance `useProjection('modelSelection')` is commonly NOT ready yet
     * (undefined). Treating "not ready" as "not ours" made the pill disappear on
     * a session switch until a model switch forced the projection to settle.
     *
     * Rule: only a KNOWN foreign provider hides. Unknown (no projection yet)
     * keeps the previous answer, so a session switch never blanks the readout.
     * This favours a one-frame over-display when moving AWAY from this provider
     * over a long disappearance when moving TO it — the asymmetry is deliberate,
     * and the credits data itself lives in the module-level store, so no blank
     * readout is ever shown.
     *
     * "Known" includes the brand-new-session case: a projection that is present
     * but names nothing resolves through the deployment default (see
     * {@link defaultProviderStore}), because that is what the picker displays.
     */
    let foreignProvider = false

    /**
     * The provider the session is currently pointed at.
     *
     * `next` outranks `lastUsed`: a switch that has landed but not yet been sent
     * is still what the composer shows, so the readout must follow it.
     *
     * An EMPTY but PRESENT projection (`{ lastUsed: null, next: null }`) is the
     * state of every brand-new session: nothing is recorded yet, and the model
     * picker displays the deployment default instead. That is NOT "no
     * information" — it is exactly the case this gate used to get wrong, see
     * {@link defaultProviderStore}.
     */
    function selectedProviderOf(projection) {
      const candidate = projection?.next ?? projection?.lastUsed
      const provider = candidate?.provider
      return typeof provider === 'string' && provider !== '' ? provider : undefined
    }

    /**
     * The deployment default provider, fetched once per page.
     *
     * WHY THIS EXISTS (the reported defect). A new session's `modelSelection`
     * projection arrives fully populated — `{ lastUsed: null, next: null }` —
     * and names no provider. The gate below previously read "no provider" as
     * "the projection is not ready yet" and kept the readout visible, which is
     * how an AgentScope balance ended up displayed under a session that was
     * actually running on another provider: the very thing this gate exists to
     * prevent. The picker shows the deployment default in that state, so the
     * readout must be compared against the same default.
     *
     * `undefined` = not known yet; `''` = the Host could not answer (an older
     * Host without `agentDefaultModel`). Both keep the previous behaviour rather
     * than hiding a reading that may well be correct.
     */
    const defaultProviderStore = (() => {
      let provider
      let at = 0
      let inflight
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) listener() }
      /**
       * How long an answer stays good.
       *
       * The deployment default is editable in settings, so caching it for the
       * whole page life would leave a fresh session gated on a stale route. A
       * short TTL costs one tiny request per minute at most, and every mount in
       * between reuses the answer.
       */
      const FRESH_MS = 60_000
      return {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        getSnapshot() { return provider },
        /** Fetch when unknown or stale; every failure settles to `''`. */
        load() {
          if (provider !== undefined && Date.now() - at < FRESH_MS) return Promise.resolve(provider)
          inflight ??= api('/provider/default')
            .then(answer => {
              provider = typeof answer?.provider === 'string' ? answer.provider : ''
              at = Date.now()
              return provider
            })
            .catch(() => { provider = ''; at = Date.now(); return provider })
            .finally(() => { inflight = undefined; emit() })
          return inflight
        },
      }
    })()

    /**
     * The gated readout.
     *
     * `useProjection` is injected by the slot itself; it is absent when the
     * component is rendered directly (a test), which is why the answer is read
     * through the result rather than by branching on the hook's presence.
     */
    function ComposerCreditsGate(props) {
      const { useProjection } = props
      // HOOK-ORDER SAFETY. `useProjection` is a React hook injected by the slot.
      // Calling it behind a `?:` would make the number of hooks depend on
      // whether the injection is present on THIS render — React answers that with
      // "Rendered fewer hooks than expected" and tears the whole tree down, which
      // is exactly what "the workspace turns blank after opening the panel" looks
      // like. So the branch is inside a dedicated child component instead: the
      // hook lives in a component that either always renders it or is never
      // mounted at all.
      if (typeof useProjection !== 'function') return h(ComposerCredits, props)
      return h(ProjectedComposerCredits, { ...props })
    }

    /** The readout with the host projection wired in. Mounted only when the slot
     * actually injected `useProjection`, so the hook call count is constant for
     * the lifetime of this component. */
    function ProjectedComposerCredits(props) {
      const projection = props.useProjection('modelSelection')
      // Subscribed so the fetch below can re-render this component once the
      // deployment default lands; a module-level value alone would not.
      const defaultProvider = React.useSyncExternalStore(
        defaultProviderStore.subscribe, defaultProviderStore.getSnapshot)
      const provider = selectedProviderOf(projection)

      // Fetch the default only when the projection is PRESENT and names nothing
      // — the new-session state. An ABSENT projection stays a re-mount artefact
      // (see `foreignProvider`) and must not trigger a request of its own.
      React.useEffect(() => {
        if (projection === undefined || provider !== undefined) return
        void defaultProviderStore.load()
      }, [projection === undefined, provider])

      // Which provider this session is on, decided from evidence:
      //   * the projection names one -> that one, authoritative;
      //   * the projection exists but names none -> the deployment default, which
      //     is precisely what the model picker displays for a fresh session;
      //   * there is no projection at all -> unknown (undefined).
      // Only a KNOWN foreign provider hides. Unknown stays visible, as before.
      const effective = provider !== undefined
        ? provider
        : projection !== undefined && defaultProvider !== undefined && defaultProvider !== ''
          ? defaultProvider
          : undefined
      if (effective !== undefined) foreignProvider = effective !== COMPOSER_PROVIDER
      if (foreignProvider) return null
      return h(ComposerCredits, props)
    }

    function ComposerCredits(props) {
      const { t } = props
      // Shared with the settings panel: one balance, one source, one poll.
      const shared = React.useSyncExternalStore(creditsStore.subscribe, creditsStore.getSnapshot)
      React.useEffect(() => {
        void creditsStore.refresh()
        // Five minutes: a credit balance is not a live counter. The panel's
        // refresh button and a click on this pill both trigger an immediate one.
        const timer = setInterval(() => { void creditsStore.refresh(true) }, 5 * 60 * 1000)
        return () => { clearInterval(timer) }
      }, [])
      const credits = shared.credits ?? null
      const available = credits?.display_available_credits
      const redeemable = credits?.redeemable_score
      const narrow = useNarrowScreen()
      // On a phone the shared composer row must stay narrow: just the ROUNDED
      // available-credit number, no unit label and no contribution segment.
      const label = shared.loading
        ? t('pillLoading')
        : available === null || available === undefined
          ? t('pillNone')
          : narrow
            ? String(Math.round(Number(available) || 0))
            : `${credit(available)} ${t('pillCredits')}${redeemable === null || redeemable === undefined ? '' : ` · ${credit(redeemable)} ${t('pillRedeemable')}`}`
      return h('button', {
        type: 'button',
        title: t('pillRefreshHint'),
        onClick: () => { void creditsStore.refresh(true) },
        'aria-busy': shared.loading ? 'true' : undefined,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '6px', maxWidth: narrow ? '72px' : '260px',
          padding: '3px 9px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
          fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        },
      },
        h('span', { key: 'dot', style: { width: '6px', height: '6px', borderRadius: '999px', background: available === undefined || available === null ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-success-primary)', flex: '0 0 auto' } }),
        h('span', { key: 'text', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
      )
    }

    // -----------------------------------------------------------------------
    // Plugin
    // -----------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agentscope-platform: dictionaries')
        const t = ctx.locale.bind(NS)

        /** Open this plugin's own settings page from the readout. */
        // The readout's click target. Deliberately inert: the settings shell owns
        // which section is open, and a plugin that guesses at an internal store
        // name is one refactor away from throwing inside a click handler.
        const openSettings = () => { /* the readout is informational */ }

        // Settings page.
        // Every built-in section declares the child slots it renders (general ->
        // `settings.general.item`, plugins -> `settings.plugins.tab`). This page
        // renders its own content and owns no child slot, but declaring an empty
        // map keeps the registration shape identical to the first-party ones
        // instead of relying on "absence happens to work".
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-connect-agentscope-platform',
          order: 35,
          label: () => t('settings'),
          locale: NS,
          inject: () => ({ t }),
          children: {},
        }, SettingsPanel))

        // Credit readout in the composer row, right before the model picker.
        // `order: 6` keeps it clear of the connector plugin that claims `order: 4`.
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-connect-agentscope-platform-composer-credits',
          order: 6,
          locale: NS,
          inject: () => ({ t, onOpenSettings: openSettings }),
        }, ComposerCreditsGate))
      },
    }
  },
})
