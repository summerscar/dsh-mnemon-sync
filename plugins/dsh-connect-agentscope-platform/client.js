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

    // -----------------------------------------------------------------------
    // Copy
    // -----------------------------------------------------------------------

    const zh = {
      settings: 'AgentScope',
      title: 'AgentScope Platform',
      subtitle: '模型供应商（可选）、额度与用量、每日签到',
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

      // credentials
      sectionCredentials: '凭证与模型密钥',
      credHint: '登录态只用于额度、贡献值与用量查询；模型调用另用平台下发的 sk-as- 密钥，两者不能混用。凭证明文只留在本机，页面只显示掩码。',
      accessToken: '登录 accessToken',
      refreshToken: '登录 refreshToken',
      tokenPlaceholderMasked: '已保存（留空表示不修改）',
      autoRefresh: '自动续期',
      accessStatus: '登录态状态',
      accessValid: '有效',
      accessRefreshOnly: '仅 refreshToken（首次请求自动换取 accessToken）',
      accessExpiring: '仅 accessToken（约 2 小时后失效）',
      accessMissing: '未配置',
      refreshFailed: '换取 accessToken 失败',
      phoneExchanged: '已保存并完成续期；浏览器里同一账户的登录态会随之失效，这是平台设计',
      refreshOnlyHint: '只需填 refreshToken 即可：保存后会立刻用它换出一对新的 token 并落盘。',
      refreshTokenHowTo: '怎么获取：在已登录 platform.agentscope.io 的浏览器里按 F12 打开控制台，执行下面这行，把结果粘到上面的输入框。',
      refreshTokenSnippet: "localStorage.getItem('refreshToken')",
      refreshTokenSnippetCopy: 'Chrome 也可以用 copy(...) 包裹，直接复制到剪贴板。',
      lastRefreshed: '最近刷新',
      neverRefreshed: '尚未刷新',
      expiresIn: '剩余有效期',
      modelKey: '模型 API Key',
      modelKeyHint: '调用模型用 Authorization: Bearer sk-as-…，不要用登录 token。',
      modelKeyMissing: '未配置',
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
      modelReasoningValue: 'API 参数值',
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
      usageHint: '按日期范围、记录类型与模型查询，支持分页。时间按平台返回的北京时间（UTC+8）解析后，转换为本机本地时区显示。',
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

      sectionCredentials: 'Credentials and model key',
      credHint: 'The login token only drives credits, contributions and usage. Model calls use a separate sk-as- key issued by the platform; the two are never interchangeable. Credentials stay on the host — this page only ever sees a mask.',
      accessToken: 'Login accessToken',
      refreshToken: 'Login refreshToken',
      tokenPlaceholderMasked: 'Saved (leave blank to keep)',
      autoRefresh: 'Auto-refresh',
      accessStatus: 'Login status',
      accessValid: 'Valid',
      accessRefreshOnly: 'Refresh token only (access token fetched on the first call)',
      accessExpiring: 'Access token only (expires in about 2 hours)',
      accessMissing: 'Not configured',
      refreshFailed: 'Could not exchange for an access token',
      phoneExchanged: 'Saved and refreshed. The browser session for this account is now invalidated — that is the platform\'s design.',
      refreshOnlyHint: 'A refresh token is all you need: saving it exchanges it for a fresh pair immediately.',
      refreshTokenHowTo: 'How to get it: in the browser that is signed in to platform.agentscope.io, open the console (F12) and run the line below, then paste the result above.',
      refreshTokenSnippet: "localStorage.getItem('refreshToken')",
      refreshTokenSnippetCopy: 'In Chrome you can wrap it in copy(...) to put it straight on the clipboard.',
      lastRefreshed: 'Last refreshed',
      neverRefreshed: 'Never',
      expiresIn: 'Time left',
      modelKey: 'Model API key',
      modelKeyHint: 'Model calls use Authorization: Bearer sk-as-…, never the login token.',
      modelKeyMissing: 'Not configured',
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
      modelReasoningValue: 'API value',
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
      usageHint: 'Query by date range, record type and model, with pagination. Times are read as the platform\'s Beijing wall clock (UTC+8) and shown in your local time zone.',
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

    /** One fetch against this plugin's own API, with the JSON body parsed. */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, init)
      const text = await response.text()
      let body
      try { body = text === '' ? {} : JSON.parse(text) } catch { throw new Error(text.slice(0, 200) || `HTTP ${response.status}`) }
      if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`)
      return body
    }

    /** A POST with a JSON body. */
    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
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

    /**
     * The credential status chip.
     *
     * "Refresh only" is a NORMAL, working state — the host exchanges the refresh
     * token on the first call — so it must not read as an error.
     */
    function credentialLabel(t, config) {
      if (config.credentialState === 'both') return t('accessValid')
      if (config.credentialState === 'refresh-only') return t('accessRefreshOnly')
      if (config.credentialState === 'access-only') return t('accessExpiring')
      return t('accessMissing')
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
     * Render one platform timestamp in the viewer's LOCAL time zone.
     *
     * The platform returns Asia/Shanghai wall-clock strings WITHOUT an offset
     * (e.g. "2026-11-12T00:46:33.369183"). `new Date(that)` would parse it as
     * the BROWSER's local time, which is only right on a UTC+8 machine. So the
     * wall clock is first pinned to +08:00 explicitly, then formatted back out in
     * the viewer's own zone. Strings that already carry an offset/Z are used
     * as-is. Anything unparseable is shown verbatim rather than "Invalid Date".
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
        return new Intl.DateTimeFormat(undefined, {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).format(date)
      } catch {
        const pad = value => String(value).padStart(2, '0')
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      }
    }

    /** Format an ISO stamp in local time, or the fallback. */
    function stamp(iso, fallback) {
      if (typeof iso !== 'string' || iso === '') return fallback ?? '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      const pad = value => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
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
      buttonSmall: { padding: '3px 8px', fontSize: '11px', borderRadius: '5px', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
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
      kvVal: { color: 'var(--dsw-alias-label-primary)' },
      modelCard: { border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' },
      check: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
    }

    function Button(props) {
      const { primary, small, children, ...rest } = props
      return h('button', { type: 'button', style: primary ? S.buttonPrimary : small ? S.buttonSmall : S.button, ...rest }, children)
    }

    function Section(props) {
      return h('section', { style: S.section }, [
        h('div', { key: 'title', style: S.sectionTitle }, [
          h('span', { key: 'label' }, props.title),
          props.actions == null ? null : h('span', { key: 'actions', style: S.row }, props.actions),
        ]),
        ...(props.children == null ? [] : Array.isArray(props.children) ? props.children : [props.children]),
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
                h('span', { key: 'id', style: { ...S.mono, fontSize: '11px', minWidth: '48px' } }, tier.id),
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
      const { t, hasToken } = props
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
        api(`/usage?${params.toString()}`)
          .then(answer => { if (live) setData(answer) })
          .catch(caught => { if (live) { setData(null); setError(caught.message) } })
          .finally(() => { if (live) setBusy(false) })
        return () => { live = false }
      }, [query, hasToken])

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
      const { t, hasToken } = props
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      // Which groups are open. Empty = all collapsed, which is the default.
      const [open, setOpen] = React.useState(() => new Set())

      const load = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const answer = await api('/pricing')
          setData(answer.data ?? null)
        } catch (caught) { setError(caught.message) } finally { setBusy(false) }
      }, [])

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

      // Credential drafts: empty means "keep what is stored".
      const [refreshToken, setRefreshToken] = React.useState('')
      const [intervalMin, setIntervalMin] = React.useState('30')
      const [modelKeyDraft, setModelKeyDraft] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const answer = await api('/state')
          setState(answer)
          setIntervalMin(String(answer.credits?.config?.intervalMin ?? 30))
          setError('')
        } catch (caught) { setError(caught.message) }
      }, [])

      React.useEffect(() => { void load() }, [load])
      React.useEffect(() => { void creditsStore.refresh() }, [])

      const run = async (label, action) => {
        setBusy(label)
        setError('')
        setNotice('')
        try { await action() } catch (caught) { setError(caught.message) } finally { setBusy('') }
      }

      if (state === null) {
        return h('div', { style: S.hint }, error === '' ? t('loading') : error)
      }

      const config = state.credits?.config ?? {}
      // ONE source: the shared /quick document, not the /fetch snapshot.
      const credits = sharedCredits.credits ?? {}
      const user = state.credits?.latest?.user ?? {}
      const promo = credits.active_promotion ?? null
      const catalog = Array.isArray(state.catalog) ? state.catalog : []
      // A refresh token alone is enough: the host exchanges it on the first call.
      const hasToken = config.usable === true || config.hasAccessToken === true || config.hasRefreshToken === true
      // The platform hands out a fresh pair on every exchange; a null stamp means
      // the refresh token has never been used here yet.
      const lastRefreshed = typeof config.refreshedAt === 'number' && config.refreshedAt > 0
        ? localTime(new Date(config.refreshedAt).toISOString())
        : t('neverRefreshed')
      const checkin = state.checkin ?? {}
      const meta = state.meta ?? {}

      const saveCredentials = () => run('credentials', async () => {
        const body = { intervalMin: Number(intervalMin) || 30, autoRefresh: true }
        // Only send a token when the user typed one: an empty draft means
        // "unchanged", and sending "" would clear a working credential.
        if (refreshToken.trim() !== '') body.refreshToken = refreshToken.trim()
        const answer = await post('/config', body)
        setRefreshToken('')
        setState(previous => previous === null ? previous : { ...previous, credits: { ...previous.credits, ...answer } })
        // A pasted refresh token is exchanged immediately (the host does it on
        // save), so the browser's own session is expected to be invalidated. Say
        // which happened instead of a bare "saved".
        if (answer.exchanged !== undefined && answer.exchanged !== null) {
          if (answer.exchanged.ok === true) setNotice(t('phoneExchanged'))
          else setError(`${t('refreshFailed')}: ${answer.exchanged.error ?? ''}`)
        } else {
          setNotice(t('ok'))
        }
        await load()
      })

      const saveModelKey = () => run('modelKey', async () => {
        const answer = await post('/model-key', { key: modelKeyDraft.trim() })
        setModelKeyDraft('')
        setState(previous => previous === null ? previous : { ...previous, modelKey: answer })
        setNotice(t('ok'))
      })

      const fetchModelKey = () => run('modelKeyFetch', async () => {
        const answer = await post('/model-key/fetch', {})
        setState(previous => previous === null ? previous : { ...previous, modelKey: answer })
        if (answer.configured !== true) setError(t('modelKeyNotReturned'))
        else setNotice(t('modelKeyFetched'))
      })

      const resetModelKey = () => run('modelKeyReset', async () => {
        const answer = await post('/model-key/reset', {})
        setState(previous => previous === null ? previous : { ...previous, modelKey: answer })
        setNotice(answer.rotated ? t('modelKeyFetched') : t('modelKeyNotReturned'))
      })

      const toggleProvider = () => run('provider', async () => {
        const answer = await post('/provider/toggle', { enabled: state.provider?.enabled !== true })
        setState(answer)
        setNotice(t('ok'))
      })

      const toggleCheckin = () => run('checkin', async () => {
        const answer = await post('/config/checkin', { enabled: checkin.enabled !== true })
        setState(previous => previous === null ? previous : { ...previous, checkin: answer })
      })

      const runCheckin = () => run('checkinRun', async () => {
        const answer = await post('/checkin/run', {})
        setState(previous => previous === null ? previous : { ...previous, checkin: answer.view ?? answer })
      })

      const fetchCredits = () => run('credits', async () => {
        // Same endpoint the pill uses. A click here refreshes BOTH surfaces.
        await creditsStore.refresh(true)
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
          h('p', { key: 's', style: S.sub }, `${t('subtitle')} · ${t('build')} ${state.build ?? '—'}`),
        ]),

        // ---- credentials ----
        h(Section, {
          key: 'cred',
          title: t('sectionCredentials'),
          children: [
            h('div', { key: 'hint', style: S.hint }, t('credHint')),
            h('div', { key: 'roHint', style: S.hint }, t('refreshOnlyHint')),
            h(Row, { key: 'rt', label: t('refreshToken') }, h('input', {
              id: 'asp-refresh-token',
              name: 'asp-refresh-token',
              'data-lpignore': 'true',
              // Chrome IGNORES autoComplete="off" on a password field: its
              // password manager still treats this as a login form and fills the
              // saved credential in, which is exactly the "first input is
              // auto-filled" report. Only "new-password" makes it stand down.
              autoComplete: 'new-password',
              style: S.input,
              type: 'password',
              value: refreshToken,
              placeholder: config.hasRefreshToken ? `${t('tokenPlaceholderMasked')} · ${config.refreshTokenMask ?? ''}` : '',
              onChange: event => setRefreshToken(event.target.value),
            })),
            // How to obtain the refresh token. The platform's console keeps it in
            // `localStorage` under `refreshToken` (raw string, no JSON wrapper) —
            // verified against the shipped console bundle, not assumed — so the
            // console line is the one thing that actually works.
            h('div', { key: 'howto', style: S.hint }, [
              h('div', { key: 'p' }, t('refreshTokenHowTo')),
              h('code', {
                key: 'c',
                style: { ...S.mono, display: 'block', marginTop: '4px', padding: '5px 7px', borderRadius: '5px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', userSelect: 'all', wordBreak: 'break-all' },
              }, t('refreshTokenSnippet')),
              h('div', { key: 'c2', style: { marginTop: '4px' } }, t('refreshTokenSnippetCopy')),
            ]),
            h(Row, { key: 'st', label: t('accessStatus') }, [
              h('span', { key: 'p', style: S.pill(hasToken ? 'ok' : 'bad') }, credentialLabel(t, config)),
              h('span', { key: 'e', style: S.hint }, config.hasRefreshToken ? (config.refreshTokenMask ?? '') : t('accessMissing')),
            ]),
            h(Row, { key: 'rf', label: t('lastRefreshed') }, h('span', { style: S.hint }, lastRefreshed)),
            h(Row, { key: 'iv', label: t('pullInterval') }, h('input', {
              id: 'asp-pull-interval',
              style: S.inputNarrow,
              type: 'number',
              min: 5,
              max: 1440,
              value: intervalMin,
              onChange: event => setIntervalMin(event.target.value),
            })),
            h('div', { key: 'mk', style: { display: 'flex', flexDirection: 'column', gap: '8px', borderTop: '1px solid var(--dsw-alias-border-l4)', paddingTop: '10px' } }, [
              h('div', { key: 'h', style: S.hint }, t('modelKeyHint')),
              h(Row, { key: 's', label: t('modelKey') }, [
                h('span', { key: 'p', style: S.pill(state.modelKey?.configured === true ? 'ok' : 'bad') },
                  state.modelKey?.configured === true ? state.modelKey.mask : t('modelKeyMissing')),
                h(Button, { key: 'f', small: true, onClick: fetchModelKey, disabled: busy !== '' }, t('modelKeyFetch')),
                h(Button, { key: 'r', small: true, onClick: resetModelKey, disabled: busy !== '', title: t('modelKeyResetWarn') }, t('modelKeyReset')),
              ]),
              h(Row, { key: 'paste', label: t('modelKeyPaste') }, [
                h('input', {
                  key: 'i',
                  id: 'asp-model-key-paste',
                  name: 'asp-model-key-paste',
                  'data-lpignore': 'true',
                  // "new-password" rather than "off": Chrome otherwise autofills
                  // password inputs with a saved credential (see the refreshToken
                  // field above for the full reason).
                  autoComplete: 'new-password',
                  style: S.input,
                  type: 'password',
                  value: modelKeyDraft,
                  placeholder: 'sk-as-…',
                  onChange: event => setModelKeyDraft(event.target.value),
                }),
                h(Button, { key: 'b', small: true, onClick: saveModelKey, disabled: busy !== '' || modelKeyDraft.trim() === '' }, t('save')),
              ]),
            ]),
            h('div', { key: 'save', style: S.row }, h(Button, { primary: true, onClick: saveCredentials, disabled: busy !== '' }, busy === 'credentials' ? t('saving') : t('save'))),
          ],
        }),

        // ---- provider ----
        h(Section, {
          key: 'provider',
          title: t('sectionProvider'),
          actions: [h('span', { key: 'p', style: S.pill(state.provider?.enabled === true ? 'ok' : undefined) },
            state.provider?.enabled === true ? t('providerOn') : t('providerOff'))],
          children: [
            h('div', { key: 'hint', style: S.hint }, t('providerHint')),
            h(Row, { key: 'toggle' }, [
              h('label', { style: S.check }, [
                h('input', { id: 'asp-provider-enable', type: 'checkbox', checked: state.provider?.enabled === true, onChange: toggleProvider, disabled: busy !== '' }),
                t('providerEnable'),
              ]),
            ]),
            h(Row, { key: 'id', label: t('providerId') }, h('span', { style: { ...S.mono, fontSize: '12px' } }, state.provider?.id ?? 'agentscope')),
            h(Row, { key: 'dn', label: t('providerDisplayName') }, h('span', { style: S.kvVal }, state.provider?.displayName ?? 'AgentScope Platform')),
            h(Row, { key: 'bu', label: t('providerBaseUrl') }, h('span', { style: { ...S.mono, fontSize: '12px' } }, state.provider?.baseUrl ?? '—')),
            h(Row, { key: 'pr', label: t('providerProtocol') }, h('span', { style: S.kvVal }, t('providerProtocolOpenAI'))),
          ],
        }),

        // ---- catalog ----
        h(Section, {
          key: 'catalog',
          title: t('sectionCatalog'),
          actions: [h(Button, { key: 'meta', small: true, onClick: refreshMeta, disabled: busy !== '' }, busy === 'meta' ? t('metaRefreshing') : t('metaRefresh'))],
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
              h('div', { key: 'f', style: S.kv }, [h('span', { key: 'k', style: S.kvKey }, t('creditsFetched')), h('span', { key: 'v', style: S.kvVal }, sharedCredits.at === 0 ? t('never') : `${stamp(new Date(sharedCredits.at).toISOString())}${sharedCredits.error !== '' ? ` · ${sharedCredits.error}` : ''}`)]),
            ]),
          ],
        }),

        // ---- usage ---- (before the price list: what you SPENT answers "why is
        // my balance what it is", and a reference table is what you reach for
        // afterwards)
        h(Section, { key: 'usage', title: t('sectionUsage'), children: h(UsagePanel, { t, hasToken }) }),

        // ---- pricing ----
        h(Section, { key: 'pricing', title: t('sectionPricing'), children: h(PricingPanel, { t, hasToken }) }),


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
     * Whether the CURRENT projection explicitly names another provider, kept at
     * MODULE scope so it survives the session-scoped slot's re-mounts.
     *
     * `conversation.input.right` is a `scope: session` slot: switching sessions
     * makes the Host RE-MOUNT its occupants, and on the first render of the new
     * instance `useProjection('modelSelection')` is commonly NOT ready yet
     * (undefined). Treating "not ready" as "not ours" made the pill disappear on
     * a session switch until a model switch forced the projection to settle.
     *
     * Rule: an ABSENT projection never hides anything (it is not evidence about
     * the new session). Only a projection that NAMES a different provider hides.
     * This favours a one-frame over-display when moving AWAY from this provider
     * over a long disappearance when moving TO it — the asymmetry is deliberate,
     * and the credits data itself lives in the module-level store, so no blank
     * readout is ever shown.
     */
    let foreignProvider = false

    /**
     * The provider the session is currently pointed at.
     *
     * `next` outranks `lastUsed`: a switch that has landed but not yet been sent
     * is still what the composer shows, so the readout must follow it.
     */
    function selectedProviderOf(projection) {
      const candidate = projection?.next ?? projection?.lastUsed
      const provider = candidate?.provider
      return typeof provider === 'string' && provider !== '' ? provider : undefined
    }

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
      const provider = selectedProviderOf(projection)
      // undefined = projection not ready (session switch in flight). It is NOT
      // evidence that this session uses another provider, so keep showing.
      if (provider !== undefined) foreignProvider = provider !== COMPOSER_PROVIDER
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
