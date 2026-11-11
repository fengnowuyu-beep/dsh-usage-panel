/**
 * dsh-usage-panel — browser half.
 *
 * One job: the sidebar "用量" panel. It registers the sidebar entry
 * (`sidebar.panellist`) and the full page it opens (`main`, keyed by the same
 * id), then renders two cards from the Host's snapshot:
 *
 *  - DeepSeek — the official balance reply, with the key masked and a
 *    "测试连接" action that makes a real request through the Host;
 *  - DSH 本地账本 — today/month spend and call counts read from
 *    `<DSH_HOME>/dsh-usage/usage-ledger.json`.
 *
 * The browser never sees a key, never talks to api.deepseek.com, and never
 * re-prices the ledger: every number is annotated 实时 / 缓存 / 估算 so a
 * cached or ledger-derived figure cannot be mistaken for a live one.
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-panel',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const React = react.default ?? react
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    /** Dictionary namespace owned by this plugin. */
    const NS = 'usagePanel'
    /** The id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'usage'
    /** The route family mounted by the Host half. */
    const ROUTE = '/usage-panel/api'
    /** Where a successful balance stops reading as "实时". Mirrors the Host. */
    const LIVE_TTL_MS = 60_000

    /** Simplified Chinese copy. The key set here is the source of truth. */
    const zh = {
      panel: '用量',
      title: '服务余额与用量',
      subtitle: '余额走官方接口实时读取；消耗来自本机 DSH 账本',
      refresh: '刷新',
      refreshing: '更新中…',
      updatedAt: '更新于 {time}',
      neverUpdated: '尚未更新',
      summaryTitle: '本月合计（账本口径）',
      summaryUpdated: '账本更新于 {time}',
      summaryNoSpend: '本月还没有记录',
      summaryUnavailable: '账本不可用，无法汇总',
      summaryUnavailableShort: '不可用',
      summaryLedgerMissing: '账本文件未找到',
      summaryLedgerUnreadable: '账本读取失败',
      serviceSpendTitle: '本月 {calls} 次调用',
      detailsTitle: '账本明细',
      detailsExpand: '展开 ▾',
      detailsCollapse: '收起 ▴',
      detailsSummary: '本月 {cost} · {calls} 次调用',
      detailsUnavailable: '账本不可用',
      detailsTrend: '近 7 天',
      detailsByModel: '按模型',
      detailsBySession: '按会话',
      detailsSessionNote: '账本只按「天 / 服务 / 模型」汇总，不含会话维度；按会话统计需要另接会话日志（PLAN P1-3）。',
      detailsEmpty: '本月还没有账本记录',
      detailsMore: '只显示消耗最高的 12 行',
      detailsStale: '本次账本读取失败，显示的是上次结果',
      detailsFile: '账本文件：{file}',
      officialBalanceNote: '官方余额 = 还剩多少钱；本机账本 = 钱花在哪。两者口径不同，可能不一致。',
      officialBalance: '官方余额',
      officialBalanceHint: '来自各服务官方接口，来源标记见卡片右下角',
      modelName: '模型',
      modelCost: '本月消耗',
      modelCalls: '调用',
      idleHint: '等待首次读取…',
      cardDeepSeek: 'DeepSeek',
      granted: '赠金',
      toppedUp: '充值',
      estimated: '估算',
      sourceLive: '实时',
      sourceCache: '缓存',
      sourceError: '异常',
      sourceNone: '—',
      dataTime: '数据时间 {time}',
      pageTime: '页面时间 {time}',
      staleHint: '上次刷新失败，显示的可能是过期数据',
      lastError: '上次刷新失败：{message}',
      unconfiguredTitle: '未配置 DeepSeek Key',
      unconfiguredBody: '填入 Key 后即可读取官方余额。Key 只保存在本机 Host 端，页面只能看到打码结果。',
      configure: '去配置',
      closeConfig: '收起配置',
      test: '测试连接',
      testing: '测试中…',
      testOk: '连接正常',
      testFail: '连接失败',
      testOkDetail: '{ms} ms · 余额 {amount}',
      settingsTitle: 'DeepSeek 配置',
      settingsHint: 'Key 保存到本机 ~/.dsh/usage-panel/credentials.json（仅当前用户可读），由 Host 端发起请求。',
      keyLabel: 'API Key',
      keyPlaceholder: 'sk-…（粘贴后点保存）',
      keySavedPlaceholder: '已保存 {mask}，留空保持不变',
      baseUrlLabel: 'API 根地址',
      timeoutNote: '单次请求超时上限 5 秒；失败只影响这一张卡，不影响 DSH。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      clearKey: '清除 Key',
      clearing: '清除中…',
      envKeyNote: '当前 Key 来自环境变量 DEEPSEEK_API_KEY，无法在页面里清除。',
      fileKeyNote: 'Key 已保存在本机凭据文件中，页面不会再拿到明文。',
      ledgerMissingTitle: '账本不可用',
      ledgerUnreadable: '账本读取失败，请稍后刷新。',
      ledgerUpdated: '写入于 {time}',
      errorRoute: '宿主插件路由不可用，请确认插件已随 DSH 启动',
      errorTimeout: '请求超时（5 秒）',
      errorNetwork: '无法连接服务',
      errorUnauthorized: 'Key 无效或已过期',
      errorForbidden: 'Key 没有读取余额的权限',
      errorRateLimited: '请求过于频繁，请稍后再试',
      errorServer: '服务端错误',
      errorHttp: '接口返回异常状态',
      errorBadResponse: '接口返回格式异常',
      errorEmpty: '接口没有返回余额',
      errorNoKey: '未配置 Key',
      errorBaseUrl: 'API 根地址不可用',
      errorKey: 'Key 格式不可用',
      errorKeyEnv: 'Key 由环境变量提供，无法在页面中清除',
      errorPayload: '请求内容不合法',
      errorUnknown: '未知错误',
      retry: '重试',
      pageErrorTitle: '面板加载失败',
      balanceUnavailable: '余额不足，调用可能被拒绝',
      loading: '加载中'
    }

    /** English copy. Must carry exactly the same keys as {@link zh}. */
    const en = {
      panel: 'Usage',
      title: 'Service balance & usage',
      subtitle: 'Balances come from provider APIs; spend comes from the local DSH ledger',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      updatedAt: 'Updated {time}',
      neverUpdated: 'Never updated',
      summaryTitle: 'This month (ledger basis)',
      summaryUpdated: 'Ledger updated {time}',
      summaryNoSpend: 'No records this month yet',
      summaryUnavailable: 'Ledger unavailable; cannot summarize',
      summaryUnavailableShort: 'Unavailable',
      summaryLedgerMissing: 'Ledger file not found',
      summaryLedgerUnreadable: 'Ledger could not be read',
      serviceSpendTitle: '{calls} calls this month',
      detailsTitle: 'Ledger detail',
      detailsExpand: 'Expand ▾',
      detailsCollapse: 'Collapse ▴',
      detailsSummary: '{cost} this month · {calls} calls',
      detailsUnavailable: 'Ledger unavailable',
      detailsTrend: 'Last 7 days',
      detailsByModel: 'By model',
      detailsBySession: 'By session',
      detailsSessionNote: 'The ledger groups by day / service / model only and has no session dimension; per-session stats need the session logs (PLAN P1-3).',
      detailsEmpty: 'No ledger records this month yet',
      detailsMore: 'Showing the top 12 rows only',
      detailsStale: 'The last ledger read failed; showing the previous result',
      detailsFile: 'Ledger file: {file}',
      officialBalanceNote: 'Official balance = how much is left; local ledger = where the money went. The two are different and may not match.',
      officialBalance: 'Official balance',
      officialBalanceHint: 'Read from each service API; the source tag is in the card footer',
      modelName: 'Model',
      modelCost: 'Month spend',
      modelCalls: 'Calls',
      idleHint: 'Waiting for the first read…',
      cardDeepSeek: 'DeepSeek',
      granted: 'Granted',
      toppedUp: 'Topped up',
      estimated: 'Estimate',
      sourceLive: 'Live',
      sourceCache: 'Cached',
      sourceError: 'Error',
      sourceNone: '—',
      dataTime: 'Data at {time}',
      pageTime: 'Page at {time}',
      staleHint: 'The last refresh failed; this may be out of date',
      lastError: 'Last refresh failed: {message}',
      unconfiguredTitle: 'DeepSeek key not configured',
      unconfiguredBody: 'Add a key to read the official balance. The key stays on the Host; this page only ever sees a mask.',
      configure: 'Configure',
      closeConfig: 'Close',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connected',
      testFail: 'Connection failed',
      testOkDetail: '{ms} ms · balance {amount}',
      settingsTitle: 'DeepSeek configuration',
      settingsHint: 'The key is stored at ~/.dsh/usage-panel/credentials.json (owner-only) and used by the Host.',
      keyLabel: 'API key',
      keyPlaceholder: 'sk-… (paste, then save)',
      keySavedPlaceholder: 'Saved {mask}; leave empty to keep it',
      baseUrlLabel: 'API root',
      timeoutNote: 'Requests time out after 5 s; a failure only affects this card, never DSH.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      clearKey: 'Remove key',
      clearing: 'Removing…',
      envKeyNote: 'The key comes from DEEPSEEK_API_KEY and cannot be removed here.',
      fileKeyNote: 'The key is stored in the local credential file; this page never receives it in clear.',
      ledgerMissingTitle: 'Ledger unavailable',
      ledgerUnreadable: 'The ledger could not be read; refresh later.',
      ledgerUpdated: 'Written {time}',
      errorRoute: 'Host plugin route unavailable; make sure the plugin loaded with DSH',
      errorTimeout: 'Timed out after 5 s',
      errorNetwork: 'Cannot reach the service',
      errorUnauthorized: 'Key is invalid or expired',
      errorForbidden: 'Key may not read the balance',
      errorRateLimited: 'Rate limited; try again later',
      errorServer: 'Server error',
      errorHttp: 'Unexpected HTTP status',
      errorBadResponse: 'Unexpected response shape',
      errorEmpty: 'The response carried no balance',
      errorNoKey: 'No key configured',
      errorBaseUrl: 'The API root is not a usable URL',
      errorKey: 'The key is not usable',
      errorKeyEnv: 'The key comes from the environment and cannot be removed here',
      errorPayload: 'Invalid request payload',
      errorUnknown: 'Unknown error',
      retry: 'Retry',
      pageErrorTitle: 'The panel failed to load',
      balanceUnavailable: 'Balance is insufficient; calls may be rejected',
      loading: 'Loading'
    }

    //#region helpers

    /** Fill `{name}` placeholders the way the shell's locale reader does. */
    function interpolate(template, params) {
      if (params === undefined || params === null) return template
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
      ))
    }

    /**
     * Build a reader around the slot's translator. The local dictionary is the
     * fallback, so the page still renders if the locale seat is unavailable.
     * @param t - the slot-injected translator, when present.
     * @returns `(key, params) => string`.
     */
    function readerOf(t) {
      if (typeof t === 'function') {
        return (key, params) => {
          let text
          try {
            text = t(key, params)
          } catch {
            text = undefined
          }
          if (typeof text !== 'string' || text === '' || text === key) {
            return interpolate(zh[key] ?? key, params)
          }
          return text
        }
      }
      return (key, params) => interpolate(zh[key] ?? key, params)
    }

    /** A route-level failure the page can render. */
    class ApiError extends Error {
      /**
       * @param code - a stable machine code.
       * @param message - the Host's description, or a local one.
       */
      constructor(code, message) {
        super(message)
        this.name = 'ApiError'
        this.code = code
      }
    }

    /** Post one method to the plugin's own route family. */
    async function callApi(method, payload) {
      let response
      try {
        response = await fetch(`${ROUTE}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {})
        })
      } catch {
        throw new ApiError('route-unreachable', 'host route unreachable')
      }
      let data
      try {
        data = await response.json()
      } catch {
        throw new ApiError('route-bad-response', 'host answered a non-JSON body')
      }
      if (data === null || typeof data !== 'object' || data.ok !== true) {
        const info = data !== null && typeof data === 'object' && data.error !== null && typeof data.error === 'object'
          ? data.error
          : {}
        throw new ApiError(
          typeof info.code === 'string' ? info.code : 'host-error',
          typeof info.message === 'string' ? info.message : 'host request failed'
        )
      }
      return data
    }

    /** Map a failure code onto the dictionary key that explains it. */
    const ERROR_KEYS = {
      timeout: 'errorTimeout',
      network: 'errorNetwork',
      unauthorized: 'errorUnauthorized',
      forbidden: 'errorForbidden',
      'rate-limited': 'errorRateLimited',
      'server-error': 'errorServer',
      'http-error': 'errorHttp',
      'bad-response': 'errorBadResponse',
      'empty-balance': 'errorEmpty',
      'no-key': 'errorNoKey',
      'invalid-base-url': 'errorBaseUrl',
      'invalid-key': 'errorKey',
      'key-from-env': 'errorKeyEnv',
      'bad-json': 'errorPayload',
      'payload-too-large': 'errorPayload',
      'route-unreachable': 'errorRoute',
      'route-bad-response': 'errorRoute'
    }

    /**
     * Render a failure as one sentence. The code wins over the Host's English
     * message, so a remote failure reads in the page's language.
     * @param error - an Error, or the Host's `{ code, message }`.
     * @param t - the page's reader.
     */
    function describeError(error, t) {
      if (error === null || error === undefined) return ''
      const code = typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
      if (code !== '' && ERROR_KEYS[code] !== undefined) return t(ERROR_KEYS[code])
      const message = typeof error === 'object' && typeof error.message === 'string' ? error.message : ''
      return message !== '' ? message : t('errorUnknown')
    }

    /** Format an amount with its currency symbol and tabular grouping. */
    function money(value, currency = 'CNY') {
      const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
      if (!Number.isFinite(parsed)) return '—'
      const symbol = String(currency).toUpperCase() === 'USD' ? '$' : '¥'
      const text = parsed.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      return `${symbol}${text}`
    }

    /** @returns `HH:mm` in local time, or an em dash. */
    function formatClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
      return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    }

    /** @returns a full local timestamp for a `title` attribute. */
    function formatFull(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** The status colour for one card state. */
    const TONE = {
      live: '#4ade80',
      cached: '#fbbf24',
      idle: '#8a9199',
      unconfigured: '#8a9199',
      unavailable: '#8a9199',
      error: '#f87171'
    }

    /**
     * The label + tone pair for a card.
     * @param state - one of the Host's card states.
     */
    function badgeOf(state) {
      if (state === 'live') return { kind: 'live', key: 'sourceLive' }
      if (state === 'cached') return { kind: 'cache', key: 'sourceCache' }
      if (state === 'error') return { kind: 'error', key: 'sourceError' }
      return { kind: 'none', key: 'sourceNone' }
    }

    //#endregion

    //#region styles

    const STYLESHEET = `
      .dsu-page{box-sizing:border-box;height:100%;overflow-y:auto;background:var(--dsw-alias-bg-base,#101014);color:var(--dsw-alias-label-primary,#f2f4f7);font-size:14px;line-height:1.5;padding:calc(26px + var(--dsh-frame-top-clearance,0px)) clamp(18px,4vw,40px) 56px}
      .dsu-inner{max-width:1060px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
      .dsu-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
      .dsu-title{margin:0;font-size:21px;line-height:1.3;font-weight:600;letter-spacing:.01em}
      .dsu-sub{margin:5px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9199)}
      .dsu-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .dsu-updated{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9199);font-variant-numeric:tabular-nums}
      .dsu-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#3a3f47);background:transparent;color:var(--dsw-alias-label-primary,#f2f4f7);font:inherit;font-size:13px;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
      .dsu-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
      .dsu-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
      .dsu-btn:disabled{opacity:.55;cursor:default}
      .dsu-btn.primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}
      .dsu-btn.primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary-hover,#5f7cff)}
      .dsu-btn.danger{color:#f87171;border-color:rgba(248,113,113,.35)}
      .dsu-summary{display:flex;align-items:center;gap:10px 18px;flex-wrap:wrap;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1,#3a3f47);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1b1b1c);color:var(--dsw-alias-label-secondary,#c9cdd4);font-size:13px}
      .dsu-summary-main{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
      .dsu-summary-label{color:var(--dsw-alias-label-tertiary,#8a9199);font-size:12px}
      .dsu-summary-strong{font-family:ui-monospace,"Cascadia Mono","SFMono-Regular",Consolas,monospace;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f4f7);font-variant-numeric:tabular-nums}
      .dsu-summary-services{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .dsu-service-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#3a3f47);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));font-size:11px;color:var(--dsw-alias-label-secondary,#c9cdd4);white-space:nowrap}
      .dsu-service-name{color:var(--dsw-alias-label-secondary,#c9cdd4)}
      .dsu-service-cost{font-family:ui-monospace,"Cascadia Mono","SFMono-Regular",Consolas,monospace;color:var(--dsw-alias-label-primary,#f2f4f7);font-variant-numeric:tabular-nums}
      .dsu-summary-meta{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9199);font-variant-numeric:tabular-nums}
      .dsu-summary-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9199)}
      .dsu-section-head{display:flex;align-items:baseline;gap:8px;margin:2px 0 -4px}
      .dsu-section-heading{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#c9cdd4)}
      .dsu-section-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9199)}
      .dsu-grid{display:flex;flex-wrap:wrap;gap:16px}
      .dsu-card{display:flex;flex-direction:column;gap:14px;padding:18px;border:1px solid var(--dsw-alias-border-l1,#3a3f47);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1b1b1c);min-height:212px;min-width:0;flex:1 1 320px;max-width:460px}
      .dsu-card[data-state="error"]{border-color:rgba(248,113,113,.5)}
      .dsu-card[data-state="unconfigured"]{border-style:dashed}
      .dsu-card-head{display:flex;align-items:center;gap:8px;min-width:0}
      .dsu-dot{width:8px;height:8px;border-radius:50%;flex:none;box-shadow:0 0 0 3px rgba(255,255,255,.04)}
      .dsu-name{font-size:14px;font-weight:600;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsu-badge{margin-left:auto;font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#3a3f47);color:var(--dsw-alias-label-tertiary,#8a9199);white-space:nowrap;flex:none}
      .dsu-badge[data-kind="live"]{color:#4ade80;border-color:rgba(74,222,128,.4);background:rgba(74,222,128,.08)}
      .dsu-badge[data-kind="cache"]{color:#fbbf24;border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.08)}
      .dsu-badge[data-kind="error"]{color:#f87171;border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.08)}
      .dsu-main{display:flex;align-items:baseline;gap:8px;min-height:38px;flex-wrap:wrap}
      .dsu-number{font-family:ui-monospace,"Cascadia Mono","SFMono-Regular",Consolas,monospace;font-size:30px;line-height:1.15;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
      .dsu-number.small{font-size:24px}
      .dsu-unit{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9199)}
      .dsu-rows{display:flex;flex-direction:column;gap:5px}
      .dsu-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary,#c9cdd4);min-width:0}
      .dsu-row-label{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsu-row b{font-weight:500;color:var(--dsw-alias-label-primary,#f2f4f7);font-variant-numeric:tabular-nums;font-family:ui-monospace,"Cascadia Mono","SFMono-Regular",Consolas,monospace;white-space:nowrap}
      .dsu-note{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-tertiary,#8a9199);word-break:break-word}
      .dsu-error{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.55;color:#f87171;background:rgba(248,113,113,.07);border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:8px 10px;word-break:break-word}
      .dsu-warn{color:#fbbf24;background:rgba(251,191,36,.07);border-color:rgba(251,191,36,.25)}
      .dsu-details{margin-top:2px;border:1px solid var(--dsw-alias-border-l1,#3a3f47);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1b1b1c);overflow:hidden}
      .dsu-details-head{appearance:none;width:100%;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:13px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .dsu-details-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
      .dsu-details-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px}
      .dsu-details-title{font-size:13px;font-weight:600}
      .dsu-details-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a9199);font-variant-numeric:tabular-nums}
      .dsu-chevron{margin-left:auto;color:var(--dsw-alias-label-tertiary,#8a9199);font-size:11px;white-space:nowrap}
      .dsu-details-body{padding:2px 16px 16px;border-top:1px solid var(--dsw-alias-border-l1,#3a3f47)}
      .dsu-section-title{margin:14px 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c9cdd4)}
      .dsu-trend{position:relative;display:flex;align-items:flex-end;gap:8px;height:96px;padding-top:4px}
      .dsu-trend::after{content:"";position:absolute;left:0;right:0;bottom:20px;border-top:1px solid var(--dsw-alias-border-l1,#3a3f47)}
      .dsu-trend-col{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;flex:1;min-width:0;height:100%}
      .dsu-trend-amount{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a9199);font-variant-numeric:tabular-nums;white-space:nowrap}
      .dsu-trend-bar{width:100%;max-width:30px;min-height:2px;border-radius:3px 3px 0 0;background:var(--dsw-alias-brand-primary,#4d6bfe);transition:height .2s ease,opacity .2s ease}
      .dsu-trend-date{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a9199);white-space:nowrap}
      .dsu-table{display:grid;grid-template-columns:minmax(0,1fr) 104px 64px;gap:6px 10px;align-items:baseline}
      .dsu-table-head{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9199)}
      .dsu-table-head.right{text-align:right}
      .dsu-table-row{display:contents}
      .dsu-table-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,#c9cdd4)}
      .dsu-table-name b{font-weight:500;color:var(--dsw-alias-label-primary,#f2f4f7)}
      .dsu-table-cost{text-align:right;font-family:ui-monospace,"Cascadia Mono","SFMono-Regular",Consolas,monospace;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#f2f4f7);white-space:nowrap}
      .dsu-table-calls{text-align:right;font-size:12px;color:var(--dsw-alias-label-secondary,#c9cdd4);font-variant-numeric:tabular-nums;white-space:nowrap}
      .dsu-details-foot{margin:12px 0 0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a9199);word-break:break-all}
      .dsu-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,#3a3f47);font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9199)}
      .dsu-foot .dsu-grow{flex:1;min-width:40px}
      .dsu-key{font-family:ui-monospace,"Cascadia Mono","SFMono-Regular",Consolas,monospace;font-size:11px;white-space:nowrap}
      .dsu-linkbtn{appearance:none;border:0;background:none;color:var(--dsw-alias-brand-primary,#7c94ff);font:inherit;font-size:11px;cursor:pointer;padding:2px 0}
      .dsu-linkbtn:hover{text-decoration:underline}
      .dsu-linkbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px;border-radius:4px}
      .dsu-linkbtn:disabled{opacity:.5;text-decoration:none;cursor:default}
      .dsu-empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start;justify-content:center;flex:1;min-height:120px}
      .dsu-empty-title{font-size:14px;font-weight:600}
      .dsu-empty-body{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a9199);word-break:break-word}
      .dsu-tag{font-size:10px;line-height:16px;padding:0 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,#4a4f57);color:var(--dsw-alias-label-tertiary,#8a9199);white-space:nowrap}
      .dsu-tag.estimate{color:#fbbf24;border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.06)}
      .dsu-form{display:flex;flex-direction:column;gap:12px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1,#3a3f47);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1b1b1c)}
      .dsu-form-title{margin:0;font-size:14px;font-weight:600}
      .dsu-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
      .dsu-field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#c9cdd4);min-width:0}
      .dsu-input{height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#3a3f47);background:var(--dsw-alias-bg-base,#101014);color:var(--dsw-alias-label-primary,#f2f4f7);font:inherit;font-size:13px;min-width:0}
      .dsu-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;border-color:transparent}
      .dsu-form-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .dsu-form-msg{font-size:12px;color:#4ade80}
      .dsu-form-msg.bad{color:#f87171}
      .dsu-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a9199);margin:0}
      .dsu-banner{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:10px;border:1px solid rgba(248,113,113,.3);background:rgba(248,113,113,.07);color:#f87171;font-size:12px}
      .dsu-banner-text{flex:1;min-width:0;word-break:break-word}
      .dsu-skel{position:relative;overflow:hidden;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,#3a3f47);background:var(--dsw-alias-bg-layer-1,#1b1b1c);min-height:212px;padding:18px;display:flex;flex-direction:column;gap:14px}
      .dsu-skel::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.05),transparent);animation:dsu-shimmer 1.4s infinite}
      .dsu-skel-line{height:12px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}
      .dsu-skel-num{height:34px;width:55%;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}
      .dsu-error-page{display:flex;flex-direction:column;gap:10px;padding:18px;border:1px solid rgba(248,113,113,.35);border-radius:12px;background:rgba(248,113,113,.06)}
      .dsu-error-page-title{font-size:15px;font-weight:600;color:#f87171}
      .dsu-error-page-body{font-size:12px;color:var(--dsw-alias-label-secondary,#c9cdd4);word-break:break-word}
      .dsu-footer-note{font-size:11px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#8a9199)}
      @keyframes dsu-shimmer{100%{transform:translateX(100%)}}
      @media (prefers-reduced-motion:reduce){.dsu-skel::after{animation:none}.dsu-trend-bar{transition:none}}
      @media (max-width:640px){.dsu-title{font-size:18px}.dsu-number{font-size:26px}.dsu-summary-meta{margin-left:0}.dsu-card{max-width:none}}
    `

    /** Install the panel stylesheet once per page. */
    function installStyles() {
      if (typeof document === 'undefined' || document === null) return
      const head = document.head
      if (head === undefined || head === null || typeof head.appendChild !== 'function') return
      if (typeof document.querySelector === 'function' && document.querySelector('style[data-dsh-usage-panel]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.dshUsagePanel = ''
      tag.textContent = STYLESHEET
      head.appendChild(tag)
    }

    //#endregion

    //#region components

    /** A status dot whose hue follows the card state. */
    function StatusDot({ state }) {
      return h('span', {
        className: 'dsu-dot',
        style: { background: TONE[state] ?? TONE.idle },
        'aria-hidden': 'true'
      })
    }

    /** A source marker: 实时 / 缓存 / 异常. */
    function Badge({ kind, children }) {
      return h('span', { className: 'dsu-badge', 'data-kind': kind }, children)
    }

    /**
     * The seven-day ledger chart used inside the collapsible detail. Every bar
     * carries its date and amount, because this is the only place spend is shown
     * as a shape rather than a number.
     * @param props.points - `[{ date, cost }]`, oldest first.
     * @param props.t - the reader.
     */
    function TrendChart({ points, t }) {
      const list = Array.isArray(points) ? points : []
      const values = list.map((point) => Math.max(0, Number(point?.cost) || 0))
      const max = values.length === 0 ? 0 : Math.max(...values)
      return h('div', {
        className: 'dsu-trend',
        role: 'img',
        'aria-label': `${t('detailsTrend')} ${list.map((point) => `${point.date} ${money(point.cost)}`).join('，')}`
      }, list.map((point, index) => {
        const height = max <= 0 ? 2 : Math.max(2, Math.round((values[index] / max) * 56))
        const opacity = max <= 0 ? 0.3 : 0.5 + 0.5 * (values[index] / max)
        return h('div', { key: point.date ?? `day-${index}`, className: 'dsu-trend-col' },
          h('span', { className: 'dsu-trend-amount' }, money(values[index])),
          h('span', {
            className: 'dsu-trend-bar',
            style: { height: `${height}px`, opacity }
          }),
          h('span', { className: 'dsu-trend-date' }, String(point.date ?? '').slice(5)))
      }))
    }

    /** One label/value line. */
    function Row({ label, value, tag }) {
      return h('div', { className: 'dsu-row' },
        h('span', { className: 'dsu-row-label' },
          h('span', null, label),
          tag === undefined ? null : h('span', { className: 'dsu-tag estimate' }, tag)),
        h('b', null, value))
    }

    /**
     * The DeepSeek card.
     *
     * States: unconfigured (no key — shows the way in, never a zero), live,
     * cached (a real previous reply with the refresh failing), error (no reply
     * at all), idle (key present, first refresh still pending).
     */
    function DeepSeekCard(props) {
      const { card, t } = props
      const badge = badgeOf(card.state)
      const balance = card.balance
      const extra = Array.isArray(card.items)
        ? card.items.filter((item) => balance === null || item.currency !== balance.currency)
        : []
      const stale = card.state === 'cached'
      const failed = card.state === 'error'
      const time = card.fetchedAt

      return h('article', { className: 'dsu-card', 'data-state': card.state, 'data-testid': 'card-deepseek' },
        h('div', { className: 'dsu-card-head' },
          h(StatusDot, { state: card.state }),
          h('span', { className: 'dsu-name' }, t('cardDeepSeek')),
          card.state === 'unconfigured' ? null : h(Badge, { kind: badge.kind }, t(badge.key))),

        card.state === 'unconfigured'
          ? h('div', { className: 'dsu-empty' },
              h('span', { className: 'dsu-empty-title' }, t('unconfiguredTitle')),
              h('span', { className: 'dsu-empty-body' }, t('unconfiguredBody')),
              h('button', { type: 'button', className: 'dsu-btn primary', onClick: props.onConfigure }, t('configure')))
          : [
              h('div', { key: 'main', className: 'dsu-main' },
                h('span', { className: 'dsu-number' }, balance === null ? '—' : money(balance.total, balance.currency))),

              card.available === false
                ? h('div', { key: 'warn', className: 'dsu-error dsu-warn' }, t('balanceUnavailable'))
                : null,

              balance === null ? null : h('div', { key: 'balance-rows', className: 'dsu-rows' },
                h(Row, { label: t('granted'), value: balance.granted === null ? '—' : money(balance.granted, balance.currency) }),
                h(Row, { label: t('toppedUp'), value: balance.toppedUp === null ? '—' : money(balance.toppedUp, balance.currency) }),
                extra.map((item) => h(Row, {
                  key: item.currency,
                  label: item.currency,
                  value: money(item.total, item.currency)
                }))),

              card.state === 'idle' ? h('div', { key: 'idle', className: 'dsu-note' }, t('idleHint')) : null,
              failed
                ? h('div', { key: 'failed', className: 'dsu-error' }, t('lastError', { message: describeError(card.error, t) }))
                : null,
              stale
                ? h('div', { key: 'stale', className: 'dsu-error dsu-warn' }, t('staleHint'))
                : null,
              props.testResult === null || props.testResult === undefined
                ? null
                : h('div', { key: 'test', className: props.testResult.ok ? 'dsu-note' : 'dsu-error' },
                    props.testResult.ok
                      ? `${t('testOk')} · ${t('testOkDetail', {
                          ms: props.testResult.ms ?? '—',
                          amount: props.testResult.balance === null || props.testResult.balance === undefined
                            ? '—'
                            : money(props.testResult.balance.total, props.testResult.balance.currency)
                        })}`
                      : `${t('testFail')} · ${describeError(props.testResult.error, t)}`),

              h('div', { key: 'foot', className: 'dsu-foot' },
                h('span', { title: card.fetchedAt === null ? '' : formatFull(card.fetchedAt) },
                  `${time === null ? t('neverUpdated') : t('dataTime', { time: formatClock(time) })} · ${t(badge.key)}`),
                h('span', { className: 'dsu-grow' }),
                card.key.masked === '' ? null : h('span', { className: 'dsu-key', title: card.key.source === 'env' ? 'DEEPSEEK_API_KEY' : '' }, card.key.masked),
                h('button', {
                  type: 'button',
                  className: 'dsu-linkbtn',
                  onClick: props.onTest,
                  disabled: props.testing === true,
                  'aria-busy': props.testing === true
                }, props.testing === true ? t('testing') : t('test')),
                h('button', { type: 'button', className: 'dsu-linkbtn', onClick: props.onConfigure }, t('configure')))
            ])
    }

    /**
     * The cross-service summary bar.
     *
     * Spend is always the ledger's figure and always tagged 估算: the official
     * balance answers "how much is left", not "how much went out", and mixing
     * the two is exactly the confusion P0.1 removes.
     */
    function SpendSummary({ snapshot, t }) {
      const { summary, ledger } = snapshot
      const known = summary.monthCost !== null && summary.monthCost !== undefined
      const services = Array.isArray(summary.servicesSpend) ? summary.servicesSpend : []
      const metaParts = []
      if (known && summary.ledgerUpdatedAt !== null && summary.ledgerUpdatedAt !== undefined) {
        metaParts.push(t('summaryUpdated', { time: formatClock(summary.ledgerUpdatedAt) }))
      }
      if (known && ledger.state === 'cached') metaParts.push(t('sourceCache'))
      const meta = known
        ? metaParts.join(' · ')
        : (ledger.error?.code === 'missing' ? t('summaryLedgerMissing') : t('summaryLedgerUnreadable'))
      return h('section', { className: 'dsu-summary', 'data-testid': 'spend-summary' },
        h('div', { className: 'dsu-summary-main' },
          h('span', { className: 'dsu-summary-label' }, t('summaryTitle')),
          h('span', { className: 'dsu-summary-strong' }, known ? money(summary.monthCost) : t('summaryUnavailableShort')),
          known ? h('span', { className: 'dsu-tag estimate' }, t('estimated')) : null),
        h('div', { className: 'dsu-summary-services' },
          services.length === 0
            ? h('span', { className: 'dsu-summary-empty' }, known ? t('summaryNoSpend') : t('summaryUnavailable'))
            : services.map((service) => h('span', {
                key: service.id,
                className: 'dsu-service-chip',
                title: t('serviceSpendTitle', { calls: Number(service.monthCalls ?? 0).toLocaleString('zh-CN') })
              },
              h('span', { className: 'dsu-service-name' }, service.name),
              h('span', { className: 'dsu-service-cost' }, money(service.monthCost)),
              h('span', { className: 'dsu-tag estimate' }, t('estimated'))))),
        meta === '' ? null : h('span', { className: 'dsu-summary-meta' }, meta))
    }

    /**
     * The collapsible ledger detail: where the money went.
     *
     * It is collapsed by default because the page is primarily a balance page;
     * the summary bar already carries the one spend figure most visits need.
     */
    function LedgerDetails({ snapshot, t, open, onToggle }) {
      const ledger = snapshot.ledger
      const unavailable = ledger.state === 'unavailable'
      const models = Array.isArray(ledger.models) ? ledger.models : []
      const summaryText = unavailable
        ? t('detailsUnavailable')
        : t('detailsSummary', {
            cost: money(ledger.month.cost),
            calls: Number(ledger.month.calls ?? 0).toLocaleString('zh-CN')
          })
      return h('section', { className: 'dsu-details', 'data-open': open === true, 'data-testid': 'ledger-details' },
        h('button', {
          type: 'button',
          className: 'dsu-details-head',
          onClick: onToggle,
          'aria-expanded': open === true ? 'true' : 'false'
        },
        h('span', { className: 'dsu-details-title' }, t('detailsTitle')),
        h('span', { className: 'dsu-details-summary' }, summaryText),
        h('span', { className: 'dsu-chevron', 'aria-hidden': 'true' }, open === true ? t('detailsCollapse') : t('detailsExpand'))),

        open === true
          ? h('div', { className: 'dsu-details-body' },
              unavailable
                ? h('p', { className: 'dsu-note' },
                    `${t('detailsFile', { file: ledger.file })} · ${ledger.error?.code === 'missing' ? t('ledgerMissingTitle') : t('ledgerUnreadable')}`)
                : [
                    ledger.stale === true ? h('p', { key: 'stale', className: 'dsu-note' }, t('detailsStale')) : null,
                    h('div', { key: 'trend' },
                      h('h3', { className: 'dsu-section-title' }, t('detailsTrend')),
                      h(TrendChart, { points: ledger.series, t })),
                    h('div', { key: 'models' },
                      h('h3', { className: 'dsu-section-title' }, t('detailsByModel')),
                      models.length === 0
                        ? h('p', { className: 'dsu-note' }, t('detailsEmpty'))
                        : h('div', { className: 'dsu-table' },
                            h('span', { key: 'h-model', className: 'dsu-table-head' }, t('modelName')),
                            h('span', { key: 'h-cost', className: 'dsu-table-head right' }, t('modelCost')),
                            h('span', { key: 'h-calls', className: 'dsu-table-head right' }, t('modelCalls')),
                            models.slice(0, 12).flatMap((model) => [
                              h('span', {
                                key: `${model.provider}/${model.model}/name`,
                                className: 'dsu-table-name',
                                title: `${model.providerName} · ${model.model}`
                              },
                              h('b', null, model.providerName),
                              ` · ${model.model}`),
                              h('span', { key: `${model.provider}/${model.model}/cost`, className: 'dsu-table-cost' }, money(model.cost)),
                              h('span', { key: `${model.provider}/${model.model}/calls`, className: 'dsu-table-calls' }, Number(model.calls ?? 0).toLocaleString('zh-CN'))
                            ]))),
                    models.length > 12 ? h('p', { key: 'models-more', className: 'dsu-note' }, t('detailsMore')) : null,
                    h('div', { key: 'sessions' },
                      h('h3', { className: 'dsu-section-title' }, t('detailsBySession')),
                      h('p', { className: 'dsu-note' }, t('detailsSessionNote'))),
                    h('p', { key: 'file', className: 'dsu-details-foot' },
                      `${t('detailsFile', { file: ledger.file })}${ledger.updatedAt === null ? '' : ` · ${t('ledgerUpdated', { time: formatClock(ledger.updatedAt) })}`}`)
                  ]
            )
          : null)
    }

    /** A skeleton block; the page never shows a full-page spinner. */
    function SkeletonCards({ t }) {
      return h('div', { className: 'dsu-grid', 'aria-label': t('loading'), 'aria-busy': 'true' },
        [0, 1].map((index) => h('div', { className: 'dsu-skel', key: index },
          h('div', { className: 'dsu-skel-line', style: { width: '38%' } }),
          h('div', { className: 'dsu-skel-num' }),
          h('div', { className: 'dsu-skel-line', style: { width: '70%' } }),
          h('div', { className: 'dsu-skel-line', style: { width: '52%' } }))))
    }

    /**
     * The inline configuration form. It posts a key once and clears its own
     * field immediately; the page only ever renders the mask from the Host.
     */
    function ConfigPanel(props) {
      const { settings, t } = props
      const [apiKey, setApiKey] = useState('')
      const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)

      const save = useCallback(async (event) => {
        if (event !== undefined && event !== null && typeof event.preventDefault === 'function') event.preventDefault()
        if (busy !== '') return
        setBusy('save')
        setMessage(null)
        try {
          await props.onSave({ apiKey, baseUrl })
          setApiKey('')
          setMessage({ ok: true, text: t('saved') })
        } catch (error) {
          setMessage({ ok: false, text: describeError(error, t) })
        } finally {
          setBusy('')
        }
      }, [apiKey, baseUrl, busy, props, t])

      const clear = useCallback(async () => {
        if (busy !== '') return
        setBusy('clear')
        setMessage(null)
        try {
          await props.onClear()
          setMessage({ ok: true, text: t('saved') })
        } catch (error) {
          setMessage({ ok: false, text: describeError(error, t) })
        } finally {
          setBusy('')
        }
      }, [busy, props, t])

      return h('form', { className: 'dsu-form', onSubmit: save, 'data-testid': 'config-panel' },
        h('div', { className: 'dsu-card-head' },
          h('h2', { className: 'dsu-form-title' }, t('settingsTitle')),
          h('button', { type: 'button', className: 'dsu-linkbtn', onClick: props.onClose }, t('closeConfig'))),
        h('p', { className: 'dsu-hint' }, t('settingsHint')),
        settings.keySource === 'env' ? h('p', { className: 'dsu-hint' }, t('envKeyNote')) : null,
        settings.keySource === 'file' ? h('p', { className: 'dsu-hint' }, t('fileKeyNote')) : null,
        h('div', { className: 'dsu-form-grid' },
          h('label', { className: 'dsu-field' },
            h('span', null, t('keyLabel')),
            h('input', {
              className: 'dsu-input',
              type: 'password',
              autoComplete: 'off',
              spellCheck: 'false',
              autoFocus: true,
              placeholder: settings.hasKey ? t('keySavedPlaceholder', { mask: settings.maskedKey }) : t('keyPlaceholder'),
              value: apiKey,
              onChange: (event) => setApiKey(event.target.value)
            })),
          h('label', { className: 'dsu-field' },
            h('span', null, t('baseUrlLabel')),
            h('input', {
              className: 'dsu-input',
              type: 'text',
              autoComplete: 'off',
              spellCheck: 'false',
              value: baseUrl,
              onChange: (event) => setBaseUrl(event.target.value)
            }))),
        h('p', { className: 'dsu-hint' }, t('timeoutNote')),
        h('div', { className: 'dsu-form-actions' },
          h('button', { type: 'submit', className: 'dsu-btn primary', disabled: busy !== '' },
            busy === 'save' ? t('saving') : t('save')),
          settings.keySource === 'file'
            ? h('button', { type: 'button', className: 'dsu-btn danger', disabled: busy !== '', onClick: clear },
                busy === 'clear' ? t('clearing') : t('clearKey'))
            : null,
          message === null
            ? null
            : h('span', { className: message.ok ? 'dsu-form-msg' : 'dsu-form-msg bad', role: 'status' }, message.text)))
    }

    /**
     * The page. It paints from the Host snapshot immediately, then refreshes in
     * the background when the balance is older than a minute.
     */
    function UsagePage(props) {
      const t = readerOf(props?.t)
      const [snapshot, setSnapshot] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [pageError, setPageError] = useState(null)
      const [refreshing, setRefreshing] = useState(false)
      const [configOpen, setConfigOpen] = useState(false)
      const [detailsOpen, setDetailsOpen] = useState(false)
      const [testing, setTesting] = useState(false)
      const [testResult, setTestResult] = useState(null)
      const mounted = useRef(true)

      const applySnapshot = useCallback((next) => {
        setSnapshot(next)
        setPhase('ready')
      }, [])

      const refresh = useCallback(async (background) => {
        setRefreshing(true)
        try {
          const data = await callApi('refresh')
          if (!mounted.current) return
          applySnapshot(data.snapshot)
          setPageError(null)
        } catch (error) {
          if (!mounted.current) return
          // A failed refresh must not wipe the cached cards: keep them and put
          // the failure in the banner instead.
          setPageError(error)
          if (background !== true) setPhase((current) => (current === 'loading' ? 'error' : current))
        } finally {
          if (mounted.current) setRefreshing(false)
        }
      }, [applySnapshot])

      useEffect(() => {
        mounted.current = true
        let cancelled = false
        ;(async () => {
          try {
            const data = await callApi('snapshot')
            if (cancelled || !mounted.current) return
            applySnapshot(data.snapshot)
            const card = data.snapshot.deepseek
            const stale = card.state !== 'live'
              || typeof card.fetchedAt !== 'number'
              || Date.now() - card.fetchedAt > LIVE_TTL_MS
            if (data.snapshot.settings.hasKey && stale) await refresh(true)
          } catch (error) {
            if (cancelled || !mounted.current) return
            setPageError(error)
            setPhase('error')
          }
        })()
        return () => {
          cancelled = true
          mounted.current = false
        }
      }, [applySnapshot, refresh])

      const save = useCallback(async (patch) => {
        const data = await callApi('settings.update', patch)
        if (!mounted.current) return
        applySnapshot(data.snapshot)
        setTestResult(null)
        setPageError(null)
        if (data.snapshot.settings.hasKey) await refresh(true)
      }, [applySnapshot, refresh])

      const clearKey = useCallback(async () => {
        const data = await callApi('settings.update', { clearKey: true })
        if (!mounted.current) return
        applySnapshot(data.snapshot)
        setTestResult(null)
        setPageError(null)
      }, [applySnapshot])

      const test = useCallback(async () => {
        setTesting(true)
        setTestResult(null)
        try {
          const data = await callApi('test')
          if (!mounted.current) return
          setTestResult(data.result)
          if (data.result.snapshot !== undefined) applySnapshot(data.result.snapshot)
        } catch (error) {
          if (!mounted.current) return
          setTestResult({ ok: false, ms: null, balance: null, error: { code: error?.code ?? 'unknown', message: error?.message ?? '' } })
        } finally {
          if (mounted.current) setTesting(false)
        }
      }, [applySnapshot])

      const data = snapshot
      const dataTime = data === null ? null : (data.lastAttempt?.at ?? data.deepseek?.fetchedAt ?? null)
      const lastText = data === null
        ? t('neverUpdated')
        : dataTime === null
          ? t('pageTime', { time: formatClock(data.generatedAt) })
          : t('updatedAt', { time: formatClock(dataTime) })

      return h('div', { className: 'dsu-page', 'data-testid': 'usage-page' },
        h('div', { className: 'dsu-inner' },
          h('header', { className: 'dsu-head' },
            h('div', null,
              h('h1', { className: 'dsu-title' }, t('title')),
              h('p', { className: 'dsu-sub' }, t('subtitle'))),
            h('div', { className: 'dsu-actions' },
              h('span', { className: 'dsu-updated', title: formatFull(dataTime ?? data?.generatedAt ?? 0) }, lastText),
              h('button', {
                type: 'button',
                className: 'dsu-btn primary',
                onClick: () => { void refresh(false) },
                disabled: refreshing,
                'aria-busy': refreshing,
                'data-testid': 'refresh'
              }, refreshing ? t('refreshing') : t('refresh')))),

          configOpen && data !== null
            ? h(ConfigPanel, {
                settings: data.settings,
                t,
                onSave: save,
                onClear: clearKey,
                onClose: () => setConfigOpen(false)
              })
            : null,

          pageError !== null && data !== null
            ? h('div', { className: 'dsu-banner', role: 'alert' },
                h('span', { className: 'dsu-banner-text' }, describeError(pageError, t)),
                h('button', { type: 'button', className: 'dsu-btn', onClick: () => { void refresh(false) } }, t('retry')))
            : null,

          phase === 'loading'
            ? [
                h('div', { key: 'sum', className: 'dsu-summary' }, h('div', { className: 'dsu-skel-line', style: { width: '180px' } })),
                h(SkeletonCards, { key: 'cards', t })
              ]
            : null,

          phase === 'error' && data === null
            ? h('div', { className: 'dsu-error-page' },
                h('span', { className: 'dsu-error-page-title' }, t('pageErrorTitle')),
                h('span', { className: 'dsu-error-page-body' }, describeError(pageError, t)),
                h('div', null, h('button', {
                  type: 'button',
                  className: 'dsu-btn primary',
                  onClick: () => {
                    setPhase('loading')
                    setPageError(null)
                    void (async () => {
                      try {
                        const fresh = await callApi('snapshot')
                        applySnapshot(fresh.snapshot)
                        await refresh(true)
                      } catch (error) {
                        setPageError(error)
                        setPhase('error')
                      }
                    })()
                  }
                }, t('retry'))))
            : null,

          phase === 'ready' && data !== null
            ? [
                h(SpendSummary, { key: 'summary', snapshot: data, t }),
                h('div', { key: 'balance-head', className: 'dsu-section-head' },
                  h('h2', { className: 'dsu-section-heading' }, t('officialBalance')),
                  h('span', { className: 'dsu-section-hint' }, t('officialBalanceHint'))),
                h('div', { key: 'cards', className: 'dsu-grid' },
                  data.cards.map((card) => h(DeepSeekCard, {
                    key: card.id,
                    card,
                    t,
                    onConfigure: () => setConfigOpen(true),
                    onTest: () => { void test() },
                    testing,
                    testResult
                  }))),
                h(LedgerDetails, {
                  key: 'details',
                  snapshot: data,
                  t,
                  open: detailsOpen,
                  onToggle: () => setDetailsOpen((current) => !current)
                }),
                h('p', { key: 'note', className: 'dsu-footer-note' }, t('officialBalanceNote'))
              ]
            : null))
    }

    /** The sidebar glyph: a card with a small bar chart, in currentColor. */
    function UsageIcon(props) {
      const size = typeof props?.size === 'number' && Number.isFinite(props.size) ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false'
      },
      h('rect', { x: 1.6, y: 3.1, width: 12.8, height: 9.8, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', { d: 'M1.6 6.2h12.8', stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', { d: 'M4.3 10.6V9.2M6.9 10.6V8M9.5 10.6V8.9M12.1 10.6V7.5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
    }

    //#endregion

    /** Cordis services this browser half needs. */
    const inject = ['slots', 'locale']

    /**
     * Mount the browser half.
     * @param ctx - the Cordis browser context.
     */
    function apply(ctx) {
      installStyles()
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'usage-panel: dictionaries')

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS
      }, UsagePage)), 'usage-panel: main panel')

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        locale: NS,
        label: () => t('panel')
      }, UsageIcon)), 'usage-panel: sidebar entry')
    }

    exports.NS = NS
    exports.PANEL_ID = PANEL_ID
    exports.ROUTE = ROUTE
    exports.apply = apply
    exports.inject = inject
    /**
     * Internals for the offline suite (test/client.test.mjs) and in-page
     * debugging. The module runner ignores unknown exports.
     */
    exports.__internals = {
      zh,
      en,
      STYLESHEET,
      installStyles,
      ApiError,
      callApi,
      describeError,
      interpolate,
      readerOf,
      money,
      formatClock,
      formatFull,
      badgeOf,
      UsagePage,
      UsageIcon,
      DeepSeekCard,
      SpendSummary,
      LedgerDetails,
      TrendChart,
      ConfigPanel,
      SkeletonCards,
      Row
    }
    return module.exports
  }
})
