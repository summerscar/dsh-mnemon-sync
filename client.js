/**
 * Mnemon Sync — browser half.
 *
 * Registers one page into dsh-mnemon's Memory Spaces workbench as an extra tab.
 *
 * How the tab gets there: dsh-mnemon exposes the child slot
 * `mnemon.source.page`, and its page directory groups entries by the id
 * prefix before the slash (`<sourceTypeId>/<pageId>`). The directory filters
 * by which source *type* is currently running — it does not care which plugin
 * contributed the page. Registering as `memory-spaces/sync` therefore lands a
 * tab beside the store's own pages, with no patch to dsh-mnemon itself.
 *
 * Everything the page shows comes from `/api/mnemon-sync/*`; the browser never
 * sees a secret, because the Host masks it before sending and accepts the mask
 * back as "unchanged".
 */

window.__ModuleLoader__.load({
  id: '@summerscar/dsh-mnemon-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'mnemon-sync'
    const API = '/api/mnemon-sync'
    // Its own type, not "memory-spaces". The workbench marks a tab active when
    // the open page shares its source type, so borrowing another type would
    // highlight two tabs at once. This type is backed by the minimal Source in
    // source.js, which is what makes the catalog list it in the first place.
    const SOURCE_TYPE_ID = 'mnemon-sync'
    const PAGE_ID = 'sync'

    // The three components dsh-mnemon groups its own Pack by. Order matches the
    // order its panel lists them, so the page reads the same way.
    const COMPONENT_ROWS = [
      { id: 'memory-spaces', label: 'componentMemorySpaces' },
      { id: 'documents', label: 'componentDocuments' },
      { id: 'runtime', label: 'componentRuntime' },
    ]

    const zh = {
      tabLabel: '同步备份',
      title: '记忆空间同步备份',
      subtitle: '把 Mnemon 的记忆组件打包上传到 S3 或 WebDAV',
      config: '备份配置',
      configNote: '以下三项一起保存。',
      scope: '备份范围',
      scopeNote: '选择要备份的组件，可多选。只有被选中的内容会进入备份包。',
      scopePath: 'Mnemon 数据根目录',
      componentMemorySpaces: '记忆空间',
      componentDocuments: '项目档案',
      componentRuntime: '运行时记忆',
      componentEmpty: '暂无数据',
      componentFiles: '{count} 个文件',
      componentSpaceOne: '1 个空间',
      componentSpaces: '{count} 个空间',
      backups: '备份列表',
      listBackups: '从目标列出备份',
      refresh: '刷新',
      backupsHint: '列出远端已存在的备份包，可查看明细并恢复。',
      noBackups: '目标上还没有备份包',
      backupName: '文件名',
      backupTime: '创建时间',
      details: '明细',
      contains: '包含组件',
      files: '文件数',
      intact: '校验通过',
      damaged: '校验失败',
      missingWarn: '缺少组件：',
      planHint: '将写入 {count} 个文件（{size}）。',
      restorePick: '选择要恢复的组件',
      restorePickOne: '请至少选择一个组件',
      restoreSpacesNote: '{count} 个文件（{size}），将覆盖本地记忆空间数据库',
      restoreDocumentsNote: '{count} 个文件（{size}），将覆盖项目档案',
      restoreRuntimeNote: '{count} 个文件（{size}），将覆盖运行时记忆',
      restoreDryRun: '预览恢复',
      restoreApply: '执行恢复',
      restoring: '恢复中…',
      restoreDone: '已恢复 {count} 个文件（{size}）',
      restorePlan: '将写入 {count} 个文件（{size}），未做改动',
      restoreFailed: '恢复失败',
      missingBlocksRestore: '备份包缺少所选组件，已阻止恢复',
      spaces: '记忆空间',
      noSpaces: '还没有任何记忆空间',
      totalBytes: '数据体积',
      target: '备份目标',
      kind: '类型',
      webdavUrl: 'WebDAV 地址',
      webdavUser: '用户名',
      webdavPassword: '密码',
      s3Endpoint: 'Endpoint',
      s3Bucket: 'Bucket',
      s3Region: 'Region',
      s3AccessKey: 'Access Key ID',
      s3SecretKey: 'Secret Access Key',
      s3SessionToken: 'Session Token（可选）',
      forcePathStyle: '强制 path-style（MinIO / R2 常用）',
      remotePath: '远端目录',
      runAt: '时间',
      schedule: '自动备份',
      autoOff: '关闭',
      autoHour: '每小时',
      autoHours: '每 {hours} 小时',
      autoDay: '每天',
      autoDays: '每 {days} 天',
      autoHintOff: '只在你点“立即备份”时备份',
      autoHintOn: '按间隔在后台备份，和“立即备份”做的事一样',
      autoNext: '下次 {time}',
      autoLast: '上次 {time}',
      autoFailed: '上次自动备份失败：{error}',
      retention: '保留份数',
      retentionNote: '超出后删除最旧的备份包。',
      enabled: '启用自动备份',
      save: '保存设置',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '保存失败',
      backupNow: '立即备份',
      backingUp: '备份中…',
      backupDone: '备份完成',
      backupFailed: '备份失败',
      history: '运行记录',
      noHistory: '还没有运行记录',
      ok: '成功',
      failed: '失败',
      trigger: '触发方式',
      triggerManual: '手动',
      triggerSchedule: '定时',
      duration: '耗时',
      size: '体积',
      componentsCount: '组件',
      clearHistory: '清空记录',
      historyCleared: '运行记录已清空',
      clearFailed: '清空失败',
      error: '错误',
      loading: '读取中…',
      loadFailed: '读取失败',
      retry: '重试',
      credentials: '凭据',
      credentialsNote: '凭据保存在记忆目录下的 0600 文件里，不会写进 DSH 配置，也不会被打包进备份。',
      maskedHint: '已保存的密钥只会显示为掩码，留空或保持掩码表示不修改。',
      danger: '注意',
    }

    const en = {
      tabLabel: 'Sync backup',
      title: 'Memory space sync backup',
      subtitle: 'Pack Mnemon\u2019s memory components to S3 or WebDAV',
      config: 'Backup settings',
      configNote: 'All three sections below save together.',
      scope: 'Backup scope',
      scopeNote: 'Choose which components to back up; only the selected ones enter the archive.',
      scopePath: 'Mnemon data root',
      componentMemorySpaces: 'Memory spaces',
      componentDocuments: 'Project documents',
      componentRuntime: 'Runtime memory',
      componentEmpty: 'no data',
      componentFiles: '{count} files',
      componentSpaceOne: '1 space',
      componentSpaces: '{count} spaces',
      backups: 'Backups',
      listBackups: 'List from target',
      refresh: 'Refresh',
      backupsHint: 'List the archives already on the target, inspect one, and restore it.',
      noBackups: 'No archive on the target yet',
      backupName: 'File',
      backupTime: 'Created',
      details: 'Details',
      contains: 'Components',
      files: 'Files',
      intact: 'Verified',
      damaged: 'Damaged',
      missingWarn: 'Missing components:',
      planHint: 'Would write {count} files ({size}).',
      restorePick: 'Components to restore',
      restorePickOne: 'Select at least one component',
      restoreSpacesNote: '{count} files ({size}); overwrites local memory space databases',
      restoreDocumentsNote: '{count} files ({size}); overwrites project documents',
      restoreRuntimeNote: '{count} files ({size}); overwrites runtime memory',
      restoreDryRun: 'Preview restore',
      restoreApply: 'Restore now',
      restoring: 'Restoring2026',
      restoreDone: 'Restored {count} files ({size})',
      restorePlan: 'Would write {count} files ({size}); nothing changed',
      restoreFailed: 'Restore failed',
      missingBlocksRestore: 'The archive lacks the selected components, so the restore was blocked',
      spaces: 'Memory spaces',
      noSpaces: 'No memory spaces yet',
      totalBytes: 'Data size',
      target: 'Target',
      kind: 'Type',
      webdavUrl: 'WebDAV URL',
      webdavUser: 'Username',
      webdavPassword: 'Password',
      s3Endpoint: 'Endpoint',
      s3Bucket: 'Bucket',
      s3Region: 'Region',
      s3AccessKey: 'Access Key ID',
      s3SecretKey: 'Secret Access Key',
      s3SessionToken: 'Session token (optional)',
      forcePathStyle: 'Force path-style (MinIO / R2)',
      remotePath: 'Remote directory',
      runAt: 'When',
      schedule: 'Automatic backup',
      autoOff: 'Off',
      autoHour: 'Hourly',
      autoHours: 'Every {hours} hours',
      autoDay: 'Daily',
      autoDays: 'Every {days} days',
      autoHintOff: 'Only when you press Backup now',
      autoHintOn: 'Backs up in the background on this interval, the same work as Backup now',
      autoNext: 'Next {time}',
      autoLast: 'Last {time}',
      autoFailed: 'The last automatic backup failed: {error}',
      retention: 'Keep',
      retentionNote: 'Older archives are deleted beyond this count.',
      enabled: 'Enable automatic backup',
      save: 'Save settings',
      saving: 'Saving\u2026',
      saved: 'Saved',
      saveFailed: 'Save failed',
      backupNow: 'Back up now',
      backingUp: 'Backing up\u2026',
      backupDone: 'Backup complete',
      backupFailed: 'Backup failed',
      history: 'Run history',
      noHistory: 'No runs yet',
      ok: 'OK',
      failed: 'failed',
      trigger: 'Trigger',
      triggerManual: 'manual',
      triggerSchedule: 'schedule',
      duration: 'Duration',
      size: 'Size',
      componentsCount: 'Components',
      clearHistory: 'Clear log',
      historyCleared: 'Run history cleared',
      clearFailed: 'Could not clear',
      error: 'Error',
      loading: 'Loading\u2026',
      loadFailed: 'Could not load',
      retry: 'Retry',
      credentials: 'Credentials',
      credentialsNote: 'Stored in a 0600 file inside the memory directory \u2014 never in DSH config, never inside a backup.',
      maskedHint: 'A saved secret shows as a mask; leave it or keep the mask to keep it unchanged.',
      danger: 'Careful',
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /**
     * The one-line summary under a component's name.
     *
     * Memory spaces are counted rather than listed: a home with many spaces
     * would otherwise push the component's own name out of the row. Files are
     * counted the same way, so both rows read as "how much is here".
     */
    function componentDetail(t, id, part) {
      if (id === 'memory-spaces') {
        const spaces = part.spaces || []
        if (spaces.length === 0) return t('componentEmpty')
        return spaceCountLabel(t, spaces.length)
      }
      const files = part.files || []
      if (files.length === 0) return t('componentEmpty')
      return t('componentFiles', { count: files.length })
    }

    /** The same summary with every name spelled out, shown on hover. */
    function componentTitle(id, part, spaceNames) {
      if (id !== 'memory-spaces') return undefined
      const spaces = part.spaces || []
      if (spaces.length === 0) return undefined
      return spaces
        .map((space) => (spaceNames && spaceNames[space.id]) || space.id)
        .join('\n')
    }

    /**
     * One line describing what restoring a component would write.
     *
     * Naming the concrete target keeps the picker honest: "3 files" does not
     * tell anyone that the live databases will be overwritten, and that is the
     * one consequence worth stating before the button is pressed.
     */
    function describeRestoreTarget(component, inspection, t) {
      const plan = inspection.plan || []
      const count = plan.filter((entry) => entry.component === component).length
      const size = humanBytes(plan
        .filter((entry) => entry.component === component)
        .reduce((total, entry) => total + (entry.bytes || 0), 0))
      if (component === 'memory-spaces') return t('restoreSpacesNote', { count, size })
      if (component === 'documents') return t('restoreDocumentsNote', { count, size })
      if (component === 'runtime') return t('restoreRuntimeNote', { count, size })
      return t('componentFiles', { count })
    }

    /** "1 space" reads differently from "3 spaces" in both languages offered. */
    function spaceCountLabel(t, count) {
      return count === 1 ? t('componentSpaceOne') : t('componentSpaces', { count })
    }

    /** One component's display name, shared by the scope rows and the details. */
    function componentLabel(t, component) {
      if (component === 'memory-spaces') return t('componentMemorySpaces')
      if (component === 'documents') return t('componentDocuments')
      if (component === 'runtime') return t('componentRuntime')
      return component
    }

    function humanBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let size = value
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
    }

    function stamp(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString()
    }

    async function api(path, options) {
      const response = await fetch(API + path, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options && options.headers) },
      })
      const text = await response.text()
      let body
      try {
        body = text === '' ? {} : JSON.parse(text)
      } catch {
        body = { error: text }
      }
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    // ---------------------------------------------------------------------
    // Styles (plain objects: the page inherits the workbench theme)
    // ---------------------------------------------------------------------

    const styles = {
      page: { display: 'grid', gap: 16, padding: '4px 2px 28px', minWidth: 0 },
      header: { display: 'grid', gap: 4 },
      title: { margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      subtitle: { margin: 0, fontSize: 12.5, lineHeight: '19px', color: 'var(--dsw-alias-label-tertiary)' },
      card: {
        border: '1px solid var(--dsw-alias-separator-secondary)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-module-platform)',
        padding: '14px 16px',
        display: 'grid',
        gap: 12,
        minWidth: 0,
      },
      cardTitle: { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      // A section inside a card: lighter than the card title, separated by a
      // hairline so the three configuration groups read as parts of one decision.
      group: {
        display: 'grid',
        gap: 10,
        paddingTop: 14,
        borderTop: '1px solid var(--dsw-alias-separator-secondary)',
      },
      groupTitle: {
        margin: 0,
        fontSize: 12.5,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary)',
      },
      // The save bar closes the card: it commits the scope, the target and the
      // cadence together, so it sits under all three rather than under one.
      saveBar: {
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        paddingTop: 14,
        borderTop: '1px solid var(--dsw-alias-separator-secondary)',
      },
      note: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
      field: { display: 'grid', gap: 5, minWidth: 0, flex: '1 1 220px' },
      label: { fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        height: 32,
        padding: '0 10px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-separator-secondary)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
        minWidth: 0,
      },
      select: {
        height: 32,
        padding: '0 8px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-separator-secondary)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
      },
      button: {
        height: 32,
        padding: '0 14px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-separator-secondary)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      },
      primary: {
        height: 32,
        padding: '0 16px',
        borderRadius: 7,
        border: '1px solid transparent',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        font: 'inherit',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
      },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 12.5, alignItems: 'baseline' },
      kvKey: { color: 'var(--dsw-alias-label-tertiary)' },
      kvValue: { color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '1px 8px',
        borderRadius: 20,
        fontSize: 11.5,
        border: '1px solid var(--dsw-alias-separator-secondary)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      pillOk: { color: 'var(--dsw-alias-state-success-primary, #3aa76d)', borderColor: 'currentColor' },
      pillBad: { color: 'var(--dsw-alias-state-error-primary, #d64545)', borderColor: 'currentColor' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-tertiary)',
        padding: '6px 8px',
        borderBottom: '1px solid var(--dsw-alias-separator-secondary)',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '7px 8px',
        borderBottom: '1px solid var(--dsw-alias-separator-secondary)',
        color: 'var(--dsw-alias-label-primary)',
        verticalAlign: 'top',
        overflowWrap: 'anywhere',
      },
      banner: {
        borderRadius: 8,
        padding: '9px 12px',
        fontSize: 12.5,
        lineHeight: '19px',
        border: '1px solid var(--dsw-alias-separator-secondary)',
        overflowWrap: 'anywhere',
      },
      bannerOk: { borderColor: 'var(--dsw-alias-state-success-primary, #3aa76d)', color: 'var(--dsw-alias-state-success-primary, #3aa76d)' },
      bannerBad: { borderColor: 'var(--dsw-alias-state-error-primary, #d64545)', color: 'var(--dsw-alias-state-error-primary, #d64545)' },
      bannerWarn: {
        borderColor: 'var(--dsw-alias-state-warn-primary, #c08a2e)',
        color: 'var(--dsw-alias-state-warn-primary, #c08a2e)',
      },
      selectedRow: { background: 'var(--dsw-alias-bg-module-platform)' },
      detail: {
        marginTop: 12,
        paddingTop: 12,
        borderTop: '1px solid var(--dsw-alias-separator-secondary)',
        display: 'grid',
        gap: 10,
      },
      detailTitle: { fontSize: 12.5, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
      restorePicker: { display: 'grid', gap: 6 },
      pickerTitle: { fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
      // Restore overwrites live data, so its button is visually distinct from
      // the ordinary secondary actions rather than one shade of grey apart.
      dangerButton: {
        height: 32,
        padding: '0 16px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-state-error-primary, #d64545)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #d64545)',
        font: 'inherit',
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
      },
      checkboxRow: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
      componentList: { display: 'grid', gap: 6 },
      componentRow: {
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-separator-secondary)',
        cursor: 'pointer',
      },
      componentText: { display: 'grid', gap: 1, minWidth: 0 },
      componentName: { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
      componentDetail: {
        fontSize: 11.5,
        lineHeight: '17px',
        color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      componentSize: {
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-tertiary)',
        fontVariantNumeric: 'tabular-nums',
      },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
        overflowWrap: 'anywhere',
      },
    }

    function TextField({ label, value, onChange, type, placeholder, disabled }) {
      return h('label', { style: styles.field },
        h('span', { style: styles.label }, label),
        h('input', {
          style: styles.input,
          type: type || 'text',
          value: value == null ? '' : value,
          placeholder: placeholder || '',
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.value),
        }),
      )
    }

    function SelectField({ label, value, onChange, options }) {
      return h('label', { style: styles.field },
        h('span', { style: styles.label }, label),
        h('select', {
          style: styles.select,
          value,
          onChange: (event) => onChange(event.target.value),
        }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
      )
    }

    // ---------------------------------------------------------------------
    // Page
    // ---------------------------------------------------------------------

    function MnemonSyncPage(props) {
      // The Host's translator takes only a key, so placeholders are filled here.
      // Messages such as "would write {count} files" need their values, and a
      // bare `{count}` in the UI would look like a bug because it is one.
      const rawT = props && props.t ? props.t : (key) => (zh[key] || key)
      const t = (key, params) => {
        const text = String(rawT(key))
        if (params === undefined) return text
        return text.replace(/\{(\w+)\}/gu, (whole, name) => (
          Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
        ))
      }
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      // Backups on the target are read on demand, never on mount: listing costs
      // a request against the user's storage and may be slow or denied.
      const [archives, setArchives] = React.useState([])
      const [archivesLoaded, setArchivesLoaded] = React.useState(false)
      const [archivesBusy, setArchivesBusy] = React.useState(false)
      const [archivesError, setArchivesError] = React.useState(null)
      const [selectedArchive, setSelectedArchive] = React.useState(null)
      const [inspection, setInspection] = React.useState(null)
      const [inspectBusy, setInspectBusy] = React.useState(false)
      const [restoreBusy, setRestoreBusy] = React.useState(false)
      const [restoreResult, setRestoreResult] = React.useState(null)
      // Which components of the inspected archive to bring back. `null` means
      // "not chosen yet"; once an archive is inspected it starts with every
      // component that archive holds.
      const [restoreComponents, setRestoreComponents] = React.useState(null)

      const load = React.useCallback(async () => {
        setError(null)
        try {
          const body = await api('/status')
          setState(body)
          setDraft(body.settings)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      React.useEffect(() => { void load() }, [load, props && props.refreshKey])

      const patchDraft = (section, patch) => {
        setDraft((current) => {
          if (current == null) return current
          if (section == null) return { ...current, ...patch }
          return { ...current, [section]: { ...current[section], ...patch } }
        })
      }

      const patchTarget = (patch) => patchDraft('target', patch)

      const save = async () => {
        if (draft == null) return
        setBusy(true)
        setNotice(null)
        try {
          const body = await api('/settings', { method: 'PUT', body: JSON.stringify({ settings: draft }) })
          setState((current) => (current == null ? current : { ...current, settings: body.settings }))
          setDraft(body.settings)
          setNotice({ ok: true, text: t('saved') })
        } catch (cause) {
          setNotice({ ok: false, text: `${t('saveFailed')}: ${cause.message}` })
        } finally {
          setBusy(false)
        }
      }

      const backupNow = async () => {
        setBusy(true)
        setNotice(null)
        try {
          // Send the draft so an unsaved change is honoured, not silently ignored.
          const body = await api('/run', { method: 'POST', body: JSON.stringify({ settings: draft }) })
          const result = body.result || {}
          setNotice({
            ok: true,
            text: `${t('backupDone')} · ${humanBytes(result.bytes)} · ${result.key || ''}`,
          })
          await load()
        } catch (cause) {
          setNotice({ ok: false, text: `${t('backupFailed')}: ${cause.message}` })
          await load()
        } finally {
          setBusy(false)
        }
      }

      /**
       * Drop the run log. Archives on the target are not touched — this is a
       * display reset, and the page says so before the button is pressed.
       */
      const clearHistory = async () => {
        setBusy(true)
        setNotice(null)
        try {
          await api('/clear-history', { method: 'POST', body: '{}' })
          await load()
          setNotice({ ok: true, text: t('historyCleared') })
        } catch (cause) {
          setNotice({ ok: false, text: `${t('clearFailed')}: ${cause.message}` })
        } finally {
          setBusy(false)
        }
      }

      const loadArchives = async () => {
        setArchivesBusy(true)
        setArchivesError(null)
        try {
          const body = await api('/archives')
          setArchives(body.archives || [])
          setArchivesLoaded(true)
        } catch (cause) {
          setArchivesError(cause.message)
          setArchivesLoaded(true)
        } finally {
          setArchivesBusy(false)
        }
      }

      /**
       * Read one archive and show what it holds.
       *
       * The component selection starts as "everything this archive has", which
       * is the safe default for a restore: the operator picks what to bring
       * back here, independently of what the backup scope currently says.
       */
      const inspect = async (key) => {
        setSelectedArchive(key)
        setInspectBusy(true)
        setInspection(null)
        setRestoreResult(null)
        setRestoreComponents(null)
        try {
          const body = await api('/inspect-archive', {
            method: 'POST',
            body: JSON.stringify({ key, components: draft.components }),
          })
          const archiveComponents = Array.isArray(body.archiveComponents) ? body.archiveComponents : []
          setInspection({ ...body, plan: body.plan || [] })
          setRestoreComponents(archiveComponents)
        } catch (cause) {
          setInspection(null)
          setArchivesError(cause.message)
        } finally {
          setInspectBusy(false)
        }
      }

      /**
       * Which components of the inspected archive to restore.
       *
       * Kept separate from the backup scope on purpose: what you back up and
       * what you bring back are two different decisions, and coupling them made
       * it impossible to restore one component out of a full archive.
       */
      const restoreSet = restoreComponents || []
      const toggleRestoreComponent = (component, on) => {
        const currentValue = restoreSet
        const next = on
          ? [...new Set([...currentValue, component])]
          : currentValue.filter((value) => value !== component)
        setRestoreComponents(next)
        // A stale plan next to a changed selection would describe the wrong work.
        setRestoreResult(null)
      }

      /**
       * Restore the inspected archive. `apply=false` is a dry run that reports
       * the plan; `apply=true` writes it. Keeping both behind the same call
       * means the plan shown and the work done cannot diverge.
       */
      const runRestore = async (apply) => {
        if (inspection === null) return
        if (restoreSet.length === 0) {
          setRestoreResult({ ok: false, text: t('restorePickOne') })
          return
        }
        setRestoreBusy(true)
        setRestoreResult(null)
        try {
          const body = await api('/restore', {
            method: 'POST',
            body: JSON.stringify({
              key: inspection.key,
              components: restoreSet,
              apply,
            }),
          })
          if (body.missing && body.missing.length > 0 && !body.applied) {
            setRestoreResult({
              ok: false,
              text: `${t('missingBlocksRestore')} ${body.missing.map((item) => componentLabel(t, item.component)).join('、')}`,
            })
            return
          }
          setRestoreResult({
            ok: true,
            text: body.applied
              ? t('restoreDone', { count: (body.written || []).length, size: humanBytes(body.writtenBytes) })
              : t('restorePlan', { count: (body.plan || []).length, size: humanBytes(body.planBytes) }),
          })
          // Show what the chosen subset would write, so the preview matches the
          // selection instead of the whole archive.
          if (!body.applied && Array.isArray(body.plan)) {
            setInspection((current) => (current === null ? current : { ...current, plan: body.plan, planBytes: body.planBytes }))
          }
          if (body.applied) await load()
        } catch (cause) {
          setRestoreResult({ ok: false, text: `${t('restoreFailed')}: ${cause.message}` })
        } finally {
          setRestoreBusy(false)
        }
      }

      if (error != null) {
        return h('div', { style: styles.page },
          h('div', { style: { ...styles.banner, ...styles.bannerBad } }, `${t('loadFailed')}: ${error}`),
          h('div', null, h('button', { style: styles.button, onClick: () => void load() }, t('retry'))),
        )
      }

      if (state == null || draft == null) {
        return h('div', { style: styles.page }, h('p', { style: styles.note }, t('loading')))
      }

      const spaces = state.state.spaces || []
      const isS3 = draft.target.kind === 's3'
      const history = state.history || []

      /** Keep at least one component selected: a backup of nothing is not a backup. */
      const toggleComponent = (id, on) => {
        const currentValue = draft.components || []
        const next = on
          ? [...new Set([...currentValue, id])]
          : currentValue.filter((value) => value !== id)
        if (next.length === 0) return
        patchDraft(null, { components: next })
      }

      // The same interval list dsh-mnemon's Git backup offers, so the two
      // backup surfaces read alike: off, hourly, 3/6/12 hours, daily, 3 days,
      // weekly.
      const AUTO_SYNC_CHOICES = [0, 60, 180, 360, 720, 1440, 4320, 10080]
      const intervalLabel = (minutes) => {
        if (minutes <= 0) return t('autoOff')
        if (minutes === 60) return t('autoHour')
        if (minutes === 1440) return t('autoDay')
        if (minutes % 1440 === 0) return t('autoDays', { days: minutes / 1440 })
        return t('autoHours', { hours: minutes / 60 })
      }
      const autoOptions = AUTO_SYNC_CHOICES.map((choice) => ({
        value: String(choice),
        label: intervalLabel(choice),
      }))
      const autoMinutes = draft.autoSyncMinutes ?? 0
      const scheduler = state.scheduler || {}
      const autoHint = autoMinutes <= 0
        ? t('autoHintOff')
        : [
            scheduler.nextAt === undefined ? '' : t('autoNext', { time: stamp(scheduler.nextAt) }),
            scheduler.lastAt === undefined ? '' : t('autoLast', { time: stamp(scheduler.lastAt) }),
          ].filter(Boolean).join(' · ') || t('autoHintOn')

      return h('div', { style: styles.page },

        // heading
        h('div', { style: styles.header },
          h('h2', { style: styles.title }, t('title')),
          h('p', { style: styles.subtitle }, t('subtitle')),
        ),

        notice == null ? null : h('div', {
          style: { ...styles.banner, ...(notice.ok ? styles.bannerOk : styles.bannerBad) },
        }, notice.text),

        // Backup configuration: scope, target and cadence are one decision,
        // so they share one card and one save. The save button lives at the
        // bottom of the card, because it commits all three sections rather
        // than the last one it happens to sit under.
        h('section', { style: styles.card },
          h('h3', { style: styles.cardTitle }, t('config')),
          h('p', { style: styles.note }, t('configNote')),

          // --- scope ---
          h('div', { style: styles.group },
            h('h4', { style: styles.groupTitle }, t('scope')),
            h('p', { style: styles.note }, t('scopeNote')),
            // One row per component, each showing whether the store actually has
            // data for it. Selecting a component with no data is allowed — the
            // archive records it as skipped — but the row says so up front.
            h('div', { style: styles.componentList },
              COMPONENT_ROWS.map((row) => {
                const part = state.state.components ? state.state.components[row.id] : undefined
                const available = part ? part.available === true : false
                const checked = (draft.components || []).includes(row.id)
                // The row shows a count, never the full list: a home with a dozen
                // spaces would push the row's own name out of view. The names live
                // in the title attribute, so hovering answers "which ones?".
                const detail = available ? componentDetail(t, row.id, part) : t('componentEmpty')
                return h('label', {
                  key: row.id,
                  style: styles.componentRow,
                  title: available ? componentTitle(row.id, part, state.spaceNames) : undefined,
                },
                  h('input', {
                    type: 'checkbox',
                    checked,
                    onChange: (event) => toggleComponent(row.id, event.target.checked),
                  }),
                  h('span', { style: styles.componentText },
                    h('strong', { style: styles.componentName }, t(row.label)),
                    h('span', { style: styles.componentDetail }, detail),
                  ),
                  h('span', { style: styles.componentSize }, available ? humanBytes(part.totalBytes) : '—'),
                )
              }),
            ),
            h('p', { style: styles.note }, t('scopePath')),
            h('span', { style: styles.code }, state.state.home || state.dataRoot),
          ),

          // --- target ---
          h('div', { style: styles.group },
            h('h4', { style: styles.groupTitle }, t('target')),
            h('div', { style: styles.row },
              h(SelectField, {
                label: t('kind'),
                value: draft.target.kind,
                onChange: (value) => patchTarget({ kind: value }),
                options: [{ value: 'webdav', label: 'WebDAV' }, { value: 's3', label: 'S3' }],
              }),
              h(TextField, {
                label: t('remotePath'),
                value: draft.target.remotePath,
                onChange: (value) => patchTarget({ remotePath: value }),
              }),
            ),

            isS3
              ? h(React.Fragment, null,
                  h('div', { style: styles.row },
                    h(TextField, { label: t('s3Endpoint'), value: draft.target.endpoint, placeholder: 'https://<account>.r2.cloudflarestorage.com', onChange: (v) => patchTarget({ endpoint: v }) }),
                    h(TextField, { label: t('s3Bucket'), value: draft.target.bucket, onChange: (v) => patchTarget({ bucket: v }) }),
                    h(TextField, { label: t('s3Region'), value: draft.target.region, placeholder: 'auto', onChange: (v) => patchTarget({ region: v }) }),
                  ),
                  h('div', { style: styles.row },
                    h(TextField, { label: t('s3AccessKey'), value: draft.target.accessKeyId, onChange: (v) => patchTarget({ accessKeyId: v }) }),
                    h(TextField, { label: t('s3SecretKey'), type: 'password', value: draft.target.secretAccessKey, onChange: (v) => patchTarget({ secretAccessKey: v }) }),
                  ),
                  h('div', { style: styles.row },
                    h(TextField, { label: t('s3SessionToken'), type: 'password', value: draft.target.sessionToken, onChange: (v) => patchTarget({ sessionToken: v }) }),
                  ),
                  h('label', { style: styles.checkboxRow },
                    h('input', {
                      type: 'checkbox',
                      checked: draft.target.forcePathStyle === true,
                      onChange: (event) => patchTarget({ forcePathStyle: event.target.checked }),
                    }),
                    t('forcePathStyle'),
                  ),
                )
              : h(React.Fragment, null,
                  h(TextField, { label: t('webdavUrl'), value: draft.target.url, placeholder: 'https://nas.example.com/dav', onChange: (v) => patchTarget({ url: v }) }),
                  h('div', { style: styles.row },
                    h(TextField, { label: t('webdavUser'), value: draft.target.username, onChange: (v) => patchTarget({ username: v }) }),
                    h(TextField, { label: t('webdavPassword'), type: 'password', value: draft.target.password, onChange: (v) => patchTarget({ password: v }) }),
                  ),
                ),

            h('p', { style: styles.note }, t('credentialsNote')),
            h('p', { style: styles.note }, t('maskedHint')),
          ),

          // --- cadence ---
          h('div', { style: styles.group },
            h('h4', { style: styles.groupTitle }, t('schedule')),
            h('label', { style: styles.checkboxRow },
              h('input', {
                type: 'checkbox',
                checked: draft.enabled === true,
                onChange: (event) => patchDraft(null, { enabled: event.target.checked }),
              }),
              t('enabled'),
            ),
            h('div', { style: styles.row },
              h(SelectField, {
                label: t('schedule'),
                value: String(autoMinutes),
                onChange: (value) => patchDraft(null, { autoSyncMinutes: Number(value) }),
                options: autoOptions,
              }),
              h(TextField, {
                label: t('retention'),
                type: 'number',
                value: draft.retention.keep,
                onChange: (v) => patchDraft('retention', { keep: Number(v) }),
              }),
            ),
            // One line under the control, exactly as the Git backup block does it:
            // what the cadence means, then when it will next run and when it last did.
            h('p', { style: styles.note }, autoHint),
            h('p', { style: styles.note }, t('retentionNote')),
          ),

          // The one action that commits every section above.
          h('div', { style: styles.saveBar },
            h('button', { style: styles.primary, onClick: () => void save(), disabled: busy },
              busy ? t('saving') : t('save')),
            h('button', { style: styles.button, onClick: () => void backupNow(), disabled: busy },
              busy ? t('backingUp') : t('backupNow')),
          ),
        ),

        // backups on the target
        h('section', { style: styles.card },
          h('div', { style: styles.row },
            h('h3', { style: { ...styles.cardTitle, marginRight: 'auto' } }, t('backups')),
            h('button', { style: styles.button, onClick: () => void loadArchives(), disabled: archivesBusy },
              archivesBusy ? t('loading') : (archivesLoaded ? t('refresh') : t('listBackups'))),
          ),
          archivesError === null ? null : h('div', { style: { ...styles.banner, ...styles.bannerBad } }, archivesError),
          !archivesLoaded
            ? h('p', { style: styles.note }, t('backupsHint'))
            : archives.length === 0
              ? h('p', { style: styles.note }, t('noBackups'))
              : h('table', { style: styles.table },
                  h('thead', null,
                    h('tr', null,
                      h('th', { style: styles.th }, t('backupName')),
                      h('th', { style: styles.th }, t('size')),
                      h('th', { style: styles.th }, t('backupTime')),
                      h('th', { style: styles.th }, ''),
                    ),
                  ),
                  h('tbody', null,
                    archives.map((archive) => h('tr', {
                      key: archive.key,
                      style: selectedArchive === archive.key ? styles.selectedRow : undefined,
                    },
                      h('td', { style: { ...styles.td, ...styles.code } }, archive.key),
                      h('td', { style: styles.td }, archive.bytes == null ? '—' : humanBytes(archive.bytes)),
                      h('td', { style: styles.td }, archive.modifiedAt == null ? '—' : stamp(archive.modifiedAt)),
                      h('td', { style: { ...styles.td, textAlign: 'right' } },
                        h('button', {
                          style: styles.button,
                          disabled: inspectBusy,
                          onClick: () => void inspect(archive.key),
                        }, t('details')),
                      ),
                    )),
                  ),
                ),

          // The detail panel: what the chosen archive holds, and what a restore
          // of the selected components would write. Missing components are called
          // out before anything is touched.
          inspection === null ? null : h('div', { style: styles.detail },
            h('div', { style: styles.row },
              h('strong', { style: styles.detailTitle }, inspection.key),
              h('span', { style: { ...styles.pill, ...(inspection.intact ? styles.pillOk : styles.pillBad) } },
                inspection.intact ? t('intact') : t('damaged')),
            ),
            h('div', { style: styles.kv },
              h('span', { style: styles.kvKey }, t('backupTime')),
              h('span', { style: styles.kvValue }, inspection.createdAt == null ? '—' : stamp(inspection.createdAt)),
              h('span', { style: styles.kvKey }, t('contains')),
              h('span', { style: styles.kvValue },
                (inspection.archiveComponents || []).length === 0
                  ? '—'
                  : inspection.archiveComponents.map((component) => h('span', {
                      key: component,
                      style: { ...styles.pill, marginRight: 6, marginBottom: 4 },
                    }, componentLabel(t, component)))),
              h('span', { style: styles.kvKey }, t('files')),
              h('span', { style: styles.kvValue }, String(inspection.files ?? 0)),
            ),

            // What to bring back. Only components this archive actually holds are
            // offered, so a checkbox can never promise something that is not there.
            h('div', { style: styles.restorePicker },
              h('span', { style: styles.pickerTitle }, t('restorePick')),
              h('div', { style: styles.componentList },
                (inspection.archiveComponents || []).map((component) => h('label', {
                  key: component,
                  style: styles.componentRow,
                },
                  h('input', {
                    type: 'checkbox',
                    checked: restoreSet.includes(component),
                    onChange: (event) => toggleRestoreComponent(component, event.target.checked),
                  }),
                  h('span', { style: styles.componentText },
                    h('strong', { style: styles.componentName }, componentLabel(t, component)),
                    h('span', { style: styles.componentDetail }, describeRestoreTarget(component, inspection, t)),
                  ),
                )),
              ),
            ),

            (inspection.missing || []).length === 0 ? null : h('div', { style: { ...styles.banner, ...styles.bannerWarn } },
              h('strong', null, `${t('missingWarn')} `),
              (inspection.missing || []).map((item) => `${componentLabel(t, item.component)}（${item.reason}）`).join('；'),
            ),

            (inspection.plan || []).length === 0 ? null : h('div', null,
              h('p', { style: styles.note }, t('planHint', { count: (inspection.plan || []).length, size: humanBytes(inspection.planBytes) })),
            ),

            h('div', { style: styles.row },
              h('button', {
                style: styles.primary,
                disabled: restoreBusy || restoreSet.length === 0,
                onClick: () => void runRestore(false),
              }, restoreBusy ? t('restoring') : t('restoreDryRun')),
              h('button', {
                style: styles.dangerButton,
                disabled: restoreBusy || restoreSet.length === 0,
                onClick: () => void runRestore(true),
              }, t('restoreApply')),
            ),

            restoreResult === null ? null : h('div', {
              style: { ...styles.banner, ...(restoreResult.ok ? styles.bannerOk : styles.bannerBad) },
            }, restoreResult.text),
          ),
        ),

        // history
        h('section', { style: styles.card },
          h('div', { style: styles.row },
            h('h3', { style: { ...styles.cardTitle, marginRight: 'auto' } }, t('history')),
            // The list keeps the newest 20 on its own; this clears what is left.
            history.length === 0 ? null : h('button', {
              style: styles.button,
              disabled: busy,
              onClick: () => void clearHistory(),
            }, t('clearHistory')),
          ),
          history.length === 0
            ? h('p', { style: styles.note }, t('noHistory'))
            : h('table', { style: styles.table },
                h('thead', null,
                  h('tr', null,
                    h('th', { style: styles.th }, t('runAt')),
                    h('th', { style: styles.th }, t('trigger')),
                    h('th', { style: styles.th }, t('componentsCount')),
                    h('th', { style: styles.th }, t('size')),
                    h('th', { style: styles.th }, t('duration')),
                    h('th', { style: styles.th }, ''),
                  ),
                ),
                h('tbody', null,
                  history.map((run) => h('tr', { key: run.id },
                    h('td', { style: styles.td }, stamp(run.finishedAt || run.startedAt)),
                    h('td', { style: styles.td }, run.trigger === 'schedule' ? t('triggerSchedule') : t('triggerManual')),
                    // What shipped, by component — the unit a backup is now made of.
                    h('td', { style: styles.td }, run.components == null || run.components.length === 0 ? '—' : run.components.map((c) => componentLabel(t, c)).join('、')),
                    h('td', { style: styles.td }, run.bytes == null ? '—' : humanBytes(run.bytes)),
                    h('td', { style: styles.td }, run.durationMs == null ? '—' : `${Math.round(run.durationMs / 1000)}s`),
                    h('td', { style: styles.td },
                      run.ok
                        ? h('span', { style: { ...styles.pill, ...styles.pillOk } }, t('ok'))
                        : h('span', { title: run.error || '', style: { ...styles.pill, ...styles.pillBad } }, t('failed')),
                    ),
                  )),
                ),
              ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mnemon-sync: dictionaries')
        const t = ctx.locale.bind(NS)

        // The Memory Spaces workbench renders whatever registered under
        // `mnemon.source.page` for a running source type, so an extra page
        // appears as an extra tab beside the store's own.
        ctx.effect(() => {
          const mnemonClient = require('dsh-mnemon/client')
          if (mnemonClient == null || typeof mnemonClient.installMemorySourceUI !== 'function') {
            // dsh-mnemon is absent or older: stay silent rather than break the
            // plugin host. The Host half still runs and can be driven by API.
            return () => {}
          }
          return mnemonClient.installMemorySourceUI(ctx, {
            sourceTypeId: SOURCE_TYPE_ID,
            pages: [{
              id: PAGE_ID,
              order: 750,
              label: () => t('tabLabel'),
              navigation: {
                stickyHeader: false,
                group: 'tools',
                // The workbench renders a tab only for entries whose navigation
                // is primary, so this must stay true or the page exists without
                // a way to reach it.
                primary: true,
                glyph: '⇅',
              },
              component: (pageProps) => h(MnemonSyncPage, { ...pageProps, t }),
            }],
          })
        }, 'mnemon-sync: memory source page')
      },
    }
  },
})
