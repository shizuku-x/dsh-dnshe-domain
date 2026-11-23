/**
 * dsh-dnshe-domain · DNSHE 免费域名 API 插件
 * ------------------------------------------------------------
 * 把 DNSHE 的免费域名 API V2.0（https://api005.dnshe.com/index.php?m=domain_hub）
 * 接进 DSH：子域名注册/续期/删除，A/AAAA/CNAME/TXT/MX/SRV/CAA 记录增删改查，
 * 配额、到期巡检、WHOIS。
 *
 * 凭据直接吃 DNSHE 后台导出的 JSON（format: "dnshe-accounts"），默认
 *   ~/.dnshe/accounts.json
 * 也可以在插件 config 里内联 accounts 数组，或用 DNSHE_API_KEY/DNSHE_API_SECRET。
 *
 * 工具：dnshe_accounts / dnshe_domains / dnshe_records / dnshe_record_write /
 *       dnshe_domain_write / dnshe_expiring / dnshe_whois
 *
 * 文档没写对、实测校正过的地方（都写进代码了）：
 *   - DNS 记录的 name 只接受相对名或 '@'，传完整域名会 400 invalid_record_name；
 *   - TTL 被平台强制成 600，传 60/120 无效；
 *   - 子域名 status 真实值是 'Registered'，不是文档里的 'active'；
 *   - subdomains/list 是 page 分页，dns_records/list 是 cursor 分页；
 *   - 没有"可注册根域名列表"接口。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const API_BASE = 'https://api005.dnshe.com/index.php'
const MODULE = 'domain_hub'
const DEFAULT_ACCOUNTS_FILE = path.join(os.homedir(), '.dnshe', 'accounts.json')
const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_CACHE_TTL_MS = 60000
const MIN_CALL_GAP_MS = 1000 // 保守按 60 次/分
const SECTION_NAME = 'dnshe-domain:rules'
const SECTION_ORDER = 560
const TTL_NOTE = 'TTL 被平台固定为 600 秒，传别的值不会生效'

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']

const DEFAULT_RULES = [
  '【DNSHE 免费域名 · dnshe-domain 插件】',
  '- 域名托管在 DNSHE（根域常见 us.ci / l.cd / cc.cd / ddns.ge），用 dnshe_* 工具管理；不要拿 Cloudflare 接口去改这些域名。',
  '- 查有哪些域名：dnshe_domains；看某域名的全部解析：dnshe_records（按 type 过滤）。',
  '- 改解析用 dnshe_record_write（action=create/update/delete）；注册/续期/删子域用 dnshe_domain_write。删除类动作必须把 confirm 传 true。',
  '- 记录名 name 用**相对名**：@ 表示子域本身，_acme-challenge 表示 _acme-challenge.<域名>；传完整域名会被 API 拒绝。',
  `- ${TTL_NOTE}。`,
  '- 子域名 status 的真实取值是 Registered；到期看 expires_at，never_expires=1 表示永不过期。',
  '- 一个账号看不到别的账号的域名：查不到某个域名时，先用 dnshe_accounts 换 account 再判断它不存在。',
  '- 改完 DNS 必须回读确认（dnshe_records），公网生效受 600 秒 TTL 影响，别承诺秒生效。',
].join('\n')

// ---------------------------------------------------------------- config

function asString(value, fallback) {
  if (typeof value === 'string') {
    const t = value.trim()
    if (t.length > 0) return t
  }
  return fallback
}

function asInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const inline = Array.isArray(config.accounts) ? normalizeAccounts(config.accounts) : []
  return {
    accountsFile: asString(config.accountsFile, DEFAULT_ACCOUNTS_FILE),
    accounts: inline,
    defaultAccount: asString(config.defaultAccount, ''),
    timeoutMs: asInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 120000),
    cacheTtlMs: asInt(config.cacheTtlMs, DEFAULT_CACHE_TTL_MS, 0, 600000),
    prompt: config.prompt !== false,
    rules: asString(config.rules, DEFAULT_RULES),
  }
}

function normalizeAccounts(list) {
  const out = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const apiKey = asString(item.apiKey ?? item.api_key, '')
    const apiSecret = asString(item.apiSecret ?? item.api_secret, '')
    if (apiKey.length === 0 || apiSecret.length === 0) continue
    out.push({
      name: asString(item.name, apiKey.slice(0, 12)),
      apiKey,
      apiSecret,
      defaultRootDomain: asString(item.defaultRootDomain, ''),
      memo: asString(item.memo, ''),
    })
  }
  return out
}

// ---------------------------------------------------------------- accounts book

let bookCache = { at: 0, mtimeMs: -1, book: null }

function readAccountsBook(config) {
  if (config.accounts.length > 0) {
    return { source: 'config', accounts: config.accounts, note: '凭据来自插件 config' }
  }
  const file = config.accountsFile
  let stat = null
  try {
    stat = fs.statSync(file)
  } catch {
    return {
      source: 'none',
      accounts: [],
      error: `没有凭据：${file} 不存在，插件 config.accounts 也没给账号`,
    }
  }
  if (
    bookCache.book !== null &&
    bookCache.mtimeMs === stat.mtimeMs &&
    Date.now() - bookCache.at < 5000 &&
    bookCache.book.file === file
  ) {
    return bookCache.book
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return { source: 'file', accounts: [], error: `凭据文件解析失败：${file} —— ${error.message}` }
  }
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.accounts)
      ? parsed.accounts
      : []
  const accounts = normalizeAccounts(rawList)
  const book = {
    source: 'file',
    file,
    format: asString(parsed?.format, ''),
    version: parsed?.version ?? null,
    exportedAt: parsed?.exportedAt ?? null,
    accounts,
    note:
      accounts.length > 0
        ? `${file}（${accounts.length} 个账号）`
        : `${file} 里没有能用的账号（需要 apiKey / apiSecret）`,
  }
  bookCache = { at: Date.now(), mtimeMs: stat.mtimeMs, book }
  return book
}

function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return ''
  return key.length <= 14 ? `${key.slice(0, 6)}…` : `${key.slice(0, 9)}…${key.slice(-4)}`
}

function pickAccount(config, wanted) {
  const book = readAccountsBook(config)
  if (book.error !== undefined) return { error: book.error, book }
  if (book.accounts.length === 0) {
    return { error: `没有可用账号：${book.file ?? book.note}`, book }
  }
  let want = asString(wanted, '') || config.defaultAccount
  if (want.length === 0) {
    const envKey = asString(process.env.DNSHE_API_KEY, '')
    const envSecret = asString(process.env.DNSHE_API_SECRET, '')
    if (envKey.length > 0 && envSecret.length > 0) {
      return {
        account: { name: 'env', apiKey: envKey, apiSecret: envSecret, defaultRootDomain: '', memo: '环境变量' },
        book,
      }
    }
    return { account: book.accounts[0], book }
  }
  const hit = book.accounts.find(
    (a) => a.name === want || a.apiKey === want || a.name.toLowerCase() === want.toLowerCase()
  )
  if (hit === undefined) {
    return {
      error: `找不到账号 "${want}"，现有：${book.accounts.map((a) => a.name).join(', ') || '无'}`,
      book,
    }
  }
  return { account: hit, book }
}

// ---------------------------------------------------------------- accounts write

function stampNow() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 只做格式体检，不联网；返回问题列表，空数组表示通过。 */
function inspectCredential(apiKey, apiSecret) {
  const problems = []
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) problems.push('缺 apiKey')
  else if (!/^cfsd_/i.test(apiKey.trim())) problems.push('apiKey 一般以 cfsd_ 开头，确认没贴错')
  if (typeof apiSecret !== 'string' || apiSecret.trim().length === 0) problems.push('缺 apiSecret')
  else if (apiSecret.trim().length < 16) problems.push('apiSecret 看起来太短（正常是 64 位 hex）')
  return problems
}

/**
 * 把整份账号列表写回凭据文件：保留原有 format / version / exportedAt 等顶层字段，
 * 先备份再原子替换（tmp + rename），写完清掉凭据与域名/配额缓存。
 */
function persistAccounts(config, accounts) {
  const file = config.accountsFile
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let base = { format: 'dnshe-accounts', version: 1, exportedAt: Date.now() }
  let existed = false
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
      base = { ...current }
      existed = true
    }
  } catch {
    // 文件不存在或坏了：按标准格式重建（坏件会在下面被备份成 .bak）
  }
  const payload = {
    ...base,
    accounts: accounts.map((a) => ({
      name: a.name,
      apiKey: a.apiKey,
      apiSecret: a.apiSecret,
      defaultRootDomain: a.defaultRootDomain ?? '',
      memo: a.memo ?? '',
    })),
  }
  let backup = ''
  if (existed) {
    backup = `${file}.bak-${stampNow()}`
    fs.copyFileSync(file, backup)
  }
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 4)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
  bookCache = { at: 0, mtimeMs: -1, book: null }
  domainCache.clear()
  quotaCache.clear()
  return { file, backup, count: payload.accounts.length }
}

// ---------------------------------------------------------------- http

let lastCallAt = 0
let queue = Promise.resolve()

async function throttle() {
  const run = queue.then(async () => {
    const wait = MIN_CALL_GAP_MS - (Date.now() - lastCallAt)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastCallAt = Date.now()
  })
  queue = run.catch(() => {})
  return run
}

function friendlyError(httpStatus, json) {
  const code = asString(json?.error_code, '')
  const message = asString(json?.message, asString(json?.error, ''))
  const hints = {
    invalid_record_name: '记录的 name 只能写相对名（@ 或 _acme-challenge 这种），不能写完整域名',
    auth_invalid_credentials: 'apiKey / apiSecret 不对，或者缺了认证据头',
    auth_ip_not_allowed: '这个 key 开了 IP 白名单，当前出口 IP 不在里面',
    api_access_disabled: '后台把 API 访问关掉了',
    not_found: '资源不存在，或者不属于当前账号',
    subdomain_not_found: '子域名不存在，或者不属于当前账号（换个 account 试试）',
    dns_record_not_found: '记录不存在',
    quota_exceeded: '免费名额用完了，可以换账号，或者先续期/清理旧域名',
    rate_limit_exceeded: '请求太频繁，等一会儿再试',
    provider_operation_failed: '上游 DNS 服务商失败，重试一次通常就好',
    internal_error: '服务端异常',
  }
  const hint = hints[code]
  const tail = hint !== undefined ? `\n  提示：${hint}` : ''
  const detail =
    json?.details !== null && typeof json?.details === 'object' && Object.keys(json.details).length > 0
      ? `\n  details：${JSON.stringify(json.details)}`
      : ''
  return `${code || `HTTP ${httpStatus}`}：${message || '未知错误'}${tail}${detail}`
}

async function apiCall(config, account, endpoint, action, options = {}) {
  const url = new URL(API_BASE)
  url.searchParams.set('m', MODULE)
  url.searchParams.set('endpoint', endpoint)
  if (action !== null && action !== undefined) url.searchParams.set('action', action)
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v === undefined || v === null || v === '') continue
    url.searchParams.set(k, String(v))
  }

  const headers = {
    accept: 'application/json',
    'user-agent': 'dsh-dnshe-domain/1.0',
    'X-API-Key': account.apiKey,
    'X-API-Secret': account.apiSecret,
  }
  const init = { method: options.method ?? 'GET', headers }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8'
    init.body = JSON.stringify(options.body)
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(config.timeoutMs)
  }

  await throttle()

  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    const name = error !== null && typeof error === 'object' ? error.name : ''
    const reason = error !== null && typeof error === 'object' ? error.message : String(error)
    return {
      ok: false,
      message:
        name === 'TimeoutError'
          ? `请求超时（${config.timeoutMs}ms）：${url.href}`
          : `连不上 DNSHE API：${url.href} —— ${reason}`,
    }
  }

  let text
  try {
    text = await response.text()
  } catch (error) {
    return { ok: false, message: `读取响应失败：${error.message}` }
  }

  let json
  try {
    json = JSON.parse(text)
  } catch {
    return {
      ok: false,
      message:
        `返回不是 JSON（HTTP ${response.status}）：${text.slice(0, 300)}` +
        '\n  提示：DNSHE 对「不属于当前账号」的资源会直接丢回 HTML 404 页；这条记录可能挂在别的账号下，用 account 指定或给 domain 让它自动定位',
      httpStatus: response.status,
    }
  }

  if (json !== null && typeof json === 'object' && json.success === false) {
    return {
      ok: false,
      message: friendlyError(response.status, json),
      errorCode: asString(json.error_code, ''),
      httpStatus: response.status,
    }
  }
  if (!response.ok) {
    return { ok: false, message: friendlyError(response.status, json), httpStatus: response.status }
  }
  return { ok: true, json, httpStatus: response.status }
}

// ---------------------------------------------------------------- caches

const domainCache = new Map() // apiKey -> { at, rows }
const quotaCache = new Map() // apiKey -> { at, quota }

function cacheValid(config, entry) {
  return entry !== undefined && config.cacheTtlMs > 0 && Date.now() - entry.at < config.cacheTtlMs
}

function invalidateDomains(account) {
  domainCache.delete(account.apiKey)
  quotaCache.delete(account.apiKey)
}

async function listAllDomains(config, account, options = {}) {
  const entry = domainCache.get(account.apiKey)
  if (!options.refresh && cacheValid(config, entry)) return { ok: true, rows: entry.rows, cached: true }
  const rows = []
  let page = 1
  for (let guard = 0; guard < 40; guard++) {
    const result = await apiCall(config, account, 'subdomains', 'list', {
      params: { page, per_page: 500, fields: 'all' },
    })
    if (!result.ok) return { ok: false, message: result.message }
    const items = Array.isArray(result.json.subdomains) ? result.json.subdomains : []
    rows.push(...items)
    const pg = result.json.pagination ?? {}
    if (pg.has_more !== true || items.length === 0) break
    page = Number.isInteger(pg.next_page) ? pg.next_page : page + 1
  }
  domainCache.set(account.apiKey, { at: Date.now(), rows })
  return { ok: true, rows, cached: false }
}

async function listAllRecords(config, account, subdomainId) {
  const rows = []
  let cursor = 0
  for (let guard = 0; guard < 40; guard++) {
    const result = await apiCall(config, account, 'dns_records', 'list', {
      params: { subdomain_id: subdomainId, cursor },
    })
    if (!result.ok) return { ok: false, message: result.message }
    const items = Array.isArray(result.json.records) ? result.json.records : []
    rows.push(...items)
    const pg = result.json.pagination ?? {}
    if (pg.has_more !== true || items.length === 0 || pg.next_cursor === null || pg.next_cursor === undefined) break
    cursor = pg.next_cursor
  }
  return { ok: true, rows }
}

async function getQuota(config, account, options = {}) {
  const entry = quotaCache.get(account.apiKey)
  if (!options.refresh && cacheValid(config, entry)) return { ok: true, quota: entry.quota, cached: true }
  const result = await apiCall(config, account, 'quota', null)
  if (!result.ok) return { ok: false, message: result.message }
  const quota = result.json.quota ?? {}
  quotaCache.set(account.apiKey, { at: Date.now(), quota })
  return { ok: true, quota, cached: false }
}

// ---------------------------------------------------------------- resolve helpers

function relName(input, fullDomain) {
  if (input === undefined || input === null || input === '' || input === '@') return '@'
  const raw = String(input).trim()
  if (raw === fullDomain) return '@'
  const suffix = `.${String(fullDomain).toLowerCase()}`
  if (raw.toLowerCase().endsWith(suffix)) return raw.slice(0, -suffix.length)
  return raw
}

function absName(relNameValue, fullDomain) {
  return relNameValue === '@' ? fullDomain : `${relNameValue}.${fullDomain}`
}

async function resolveDomain(config, account, ref) {
  const raw = asString(ref, '')
  if (raw.length === 0) return { ok: false, message: '缺 domain（填完整域名，或者 subdomain_id）' }
  if (/^\d+$/.test(raw)) {
    const result = await apiCall(config, account, 'subdomains', 'get', { params: { subdomain_id: raw } })
    if (!result.ok) return { ok: false, message: result.message }
    const sub = result.json.subdomain ?? {}
    return { ok: true, sub, dnsRecords: result.json.dns_records ?? [], dnsCount: result.json.dns_count }
  }
  const full = raw.toLowerCase().replace(/\.$/, '')
  let all = await listAllDomains(config, account)
  if (!all.ok) return { ok: false, message: all.message }
  let hit = all.rows.find((d) => String(d.full_domain).toLowerCase() === full)
  if (hit === undefined) {
    all = await listAllDomains(config, account, { refresh: true })
    if (!all.ok) return { ok: false, message: all.message }
    hit = all.rows.find((d) => String(d.full_domain).toLowerCase() === full)
  }
  if (hit === undefined) {
    const near = all.rows
      .filter((d) => String(d.full_domain).toLowerCase().includes(full.split('.')[0]))
      .slice(0, 8)
      .map((d) => d.full_domain)
    return {
      ok: false,
      message:
        `账号 ${account.name} 下没有 ${full}` +
        (near.length > 0 ? `\n  相近的有：${near.join(', ')}` : '') +
        '\n  换个 account 再查一遍也是一种可能（不同账号的域名互不可见）',
    }
  }
  return { ok: true, sub: hit }
}

async function resolveDomainAny(config, account, ref) {
  const first = await resolveDomain(config, account, ref)
  if (first.ok) return { ...first, account, switched: false }
  // 没显式指定账号时，域名可能挂在别的账号下 —— 挨个找一遍（结果按账号缓存，不会每次都全量拉）
  const book = readAccountsBook(config)
  for (const other of book.accounts ?? []) {
    if (other.apiKey === account.apiKey) continue
    const hit = await resolveDomain(config, other, ref)
    if (hit.ok) return { ...hit, account: other, switched: true }
  }
  return { ...first, account, switched: false }
}

async function findRecord(config, account, options) {
  if (typeof options.id === 'string' && options.id.length > 0) {
    return { ok: true, record: { id: options.id }, account }
  }
  const domain = asString(options.domain, '')
  if (domain.length === 0) {
    return {
      ok: false,
      message: '要定位记录：给 recordId，或者给 domain + name + type（给 domain 才能识别它属于哪个账号）',
    }
  }
  const resolved = await resolveDomainAny(config, account, domain)
  if (!resolved.ok) return resolved
  const sub = resolved.sub
  const owner = resolved.account
  const records = await listAllRecords(config, owner, sub.id)
  if (!records.ok) return { ...records, account: owner }
  const wantName = relName(options.name, sub.full_domain).toLowerCase()
  const wantType = asString(options.type, '').toUpperCase()
  const hits = records.rows.filter((r) => {
    const name = relName(r.name, sub.full_domain).toLowerCase()
    const type = String(r.type).toUpperCase()
    return name === wantName && (wantType.length === 0 || type === wantType)
  })
  if (hits.length === 0) {
    return {
      ok: false,
      message:
        `在 ${sub.full_domain} 里没找到 name=${wantName}${wantType.length > 0 ? ` type=${wantType}` : ''} 的记录` +
        '\n  先用 dnshe_records 看一遍现有记录和它们的 id',
      account: owner,
    }
  }
  return { ok: true, record: hits[0], matches: hits.length, sub, account: owner, switched: resolved.switched }
}

/**
 * 只给记录 id 时无从知道它属于哪个账号：先试指定账号，再挨个试其它账号。
 * 记录 id 全局唯一，删/改打错账号只会拿到 404，不会误伤别的账号的数据。
 */
async function runOnRecordOwner(config, account, located, run) {
  if (located.sub !== undefined) {
    const owner = located.account ?? account
    return { ...(await run(owner)), account: owner }
  }
  const book = readAccountsBook(config)
  const order = [account, ...(book.accounts ?? []).filter((a) => a.apiKey !== account.apiKey)]
  let last = null
  for (const candidate of order) {
    const result = await run(candidate)
    last = { ...result, account: candidate }
    if (result.ok) return last
    const mismatch =
      result.httpStatus === 404 || /not_found|不是 JSON|记录不存在/.test(String(result.message ?? ''))
    if (!mismatch) return last
  }
  return last
}

// ---------------------------------------------------------------- render helpers

function daysLeft(expiresAt) {
  if (typeof expiresAt !== 'string' || expiresAt.length === 0) return null
  const t = new Date(expiresAt.replace(' ', 'T')).getTime()
  if (!Number.isFinite(t)) return null
  return Math.floor((t - Date.now()) / 86400000)
}

function expiryLabel(row) {
  if (Number(row.never_expires) === 1) return '永不'
  const left = daysLeft(row.expires_at)
  if (left === null) return row.expires_at ?? '-'
  if (left < 0) return `${row.expires_at}（已过期）`
  return `${row.expires_at}（剩 ${left} 天）`
}

function domainLine(row) {
  return `${row.full_domain}  id=${row.id}  ${row.status ?? '?'}  ${expiryLabel(row)}`
}

function recordLine(record, fullDomain) {
  const name = relName(record.name, fullDomain)
  const shown = name === '@' ? fullDomain : `${name}.${fullDomain}`
  const prio = record.priority === null || record.priority === undefined ? '' : `  priority=${record.priority}`
  return `id=${record.id}  ${String(record.type).padEnd(6)} ${shown.padEnd(44)} → ${record.content}  ttl=${record.ttl}${prio}`
}

function accountLine(account) {
  return `${account.name}  ${maskKey(account.apiKey)}${account.defaultRootDomain ? `  默认根域=${account.defaultRootDomain}` : ''}${account.memo ? `  ${account.memo}` : ''}`
}

function text(parts) {
  const lines = parts.filter((p) => typeof p === 'string' && p.length > 0)
  return lines.join('\n')
}

// ---------------------------------------------------------------- tools

const OK_MESSAGE = { type: 'string' }

function accountsTool(live) {
  return {
    name: 'dnshe_accounts',
    description:
      '列出 DNSHE 账号（apiKey 脱敏）以及每个账号的免费名额用量。默认只读凭据文件，probe=true 时会真的去问一遍 API（慢一点但配额是实时的）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        probe: { type: 'boolean', description: 'true = 逐账号查一次配额与域名数（需要联网，慢）' },
        account: { type: 'string', description: '只看某一个账号（别名或 apiKey）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: OK_MESSAGE,
          source: { type: 'string' },
          accounts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                apiKey: { type: 'string' },
                defaultRootDomain: { type: 'string' },
                memo: { type: 'string' },
                domains: { type: 'integer' },
                quotaUsed: { type: 'integer' },
                quotaTotal: { type: 'integer' },
                quotaAvailable: { type: 'integer' },
                error: { type: 'string' },
              },
              required: ['name', 'apiKey'],
            },
          },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const config = live()
      const input = args !== null && typeof args === 'object' ? args : {}
      const book = readAccountsBook(config)
      if (book.error !== undefined) return { ok: false, message: book.error, source: book.source, accounts: [] }
      let targets = book.accounts
      const want = asString(input.account, '')
      if (want.length > 0) {
        targets = targets.filter((a) => a.name === want || a.apiKey === want)
        if (targets.length === 0) {
          return {
            ok: false,
            message: `没有账号 "${want}"；现有：${book.accounts.map((a) => a.name).join(', ')}`,
            source: book.source,
            accounts: [],
          }
        }
      }

      const rows = []
      const lines = [`凭据来源：${book.note ?? book.file ?? book.source}`]
      if (book.format !== undefined && book.format.length > 0) {
        lines.push(`导出格式：${book.format} v${book.version ?? '?'}`)
      }
      for (const account of targets) {
        const row = {
          name: account.name,
          apiKey: maskKey(account.apiKey),
          defaultRootDomain: account.defaultRootDomain ?? '',
          memo: account.memo ?? '',
        }
        if (input.probe === true) {
          const quota = await getQuota(config, account, { refresh: true })
          const domains = await listAllDomains(config, account, { refresh: true })
          if (!quota.ok) {
            row.error = quota.message
            lines.push(`• ${accountLine(account)}\n    ✗ ${quota.message}`)
          } else {
            const q = quota.quota
            row.quotaUsed = Number(q.used ?? 0)
            row.quotaTotal = Number(q.total ?? 0)
            row.quotaAvailable = Number(q.available ?? 0)
            if (domains.ok) row.domains = domains.rows.length
            lines.push(
              `• ${accountLine(account)}\n    名额 ${q.used}/${q.total}（还能注册 ${q.available} 个）` +
                (domains.ok ? `  域名 ${domains.rows.length} 个` : `  域名查询失败：${domains.message}`)
            )
          }
        } else {
          lines.push(`• ${accountLine(account)}`)
        }
        rows.push(row)
      }
      if (input.probe !== true) {
        lines.push('（没查实时配额：需要的话把 probe 传 true）')
      }
      return { ok: true, message: text(lines), source: book.source, accounts: rows }
    },
  }
}

function accountsWriteTool(live) {
  return {
    name: 'dnshe_accounts_write',
    description:
      '写 DNSHE 账号凭据：add 新增、update 改、remove 删、test 只验证不写。凭据落在 ~/.dnshe/accounts.json（先备份再原子替换），默认写入前用这对 key 调一次 quota 确认有效。密钥不回显。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove', 'test'], description: '要做哪个动作' },
        name: { type: 'string', description: '账号别名（add 必填；update 也可用它改别名）' },
        apiKey: { type: 'string', description: 'X-API-Key，一般 cfsd_ 开头' },
        apiSecret: { type: 'string', description: 'X-API-Secret（64 位 hex）' },
        defaultRootDomain: { type: 'string', description: '默认根域，可空' },
        memo: { type: 'string', description: '备注，可空' },
        account: { type: 'string', description: 'update / remove / test 的定位：别名或 apiKey' },
        skipVerify: { type: 'boolean', description: 'add / update 跳过联网验证（不推荐）' },
        confirm: { type: 'boolean', description: 'remove 必须为 true' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: OK_MESSAGE,
          file: { type: 'string' },
          backup: { type: 'string' },
          count: { type: 'integer' },
          verified: { type: 'boolean' },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const config = live()
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = asString(input.action, '')
      if (!['add', 'update', 'remove', 'test'].includes(action)) {
        return { ok: false, message: 'action 只能是 add / update / remove / test' }
      }

      const book = readAccountsBook(config)
      const current = (book.accounts ?? []).map((a) => ({ ...a }))
      const want = asString(input.account, '')
      const locate = () => {
        if (want.length === 0) return -1
        return current.findIndex(
          (a) => a.name === want || a.apiKey === want || a.name.toLowerCase() === want.toLowerCase()
        )
      }
      const verify = async (name, apiKey, apiSecret) => {
        const result = await apiCall(config, { name, apiKey, apiSecret }, 'quota', null)
        if (!result.ok) return { ok: false, message: result.message }
        return { ok: true, quota: result.json.quota ?? {} }
      }

      if (action === 'test') {
        const index = locate()
        const apiKey = asString(input.apiKey, index >= 0 ? current[index].apiKey : '')
        const apiSecret = asString(input.apiSecret, index >= 0 ? current[index].apiSecret : '')
        const problems = inspectCredential(apiKey, apiSecret)
        if (problems.length > 0) return { ok: false, message: `凭据格式有问题：\n  - ${problems.join('\n  - ')}`, verified: false }
        const checked = await verify(asString(input.name, index >= 0 ? current[index].name : 'probe'), apiKey, apiSecret)
        if (!checked.ok) return { ok: false, message: `验证失败：${checked.message}`, verified: false }
        const q = checked.quota
        return {
          ok: true,
          message: `✓ 这对 key 有效：名额 ${q.used}/${q.total}（还能注册 ${q.available} 个）`,
          verified: true,
        }
      }

      if (action === 'remove') {
        const index = locate()
        if (index < 0) return { ok: false, message: `没找到账号 "${want}"` }
        const target = current[index]
        if (input.confirm !== true) {
          return {
            ok: false,
            message:
              `要从凭据文件里删掉 ${target.name}（${maskKey(target.apiKey)}）吗？` +
              '\n只影响本地这份凭据库，DNSHE 那边的域名不动。确认请把 confirm 传 true',
          }
        }
        current.splice(index, 1)
        const written = persistAccounts(config, current)
        return {
          ok: true,
          message: text([
            `✓ 已删除账号 ${target.name}，还剩 ${written.count} 个`,
            `文件：${written.file}`,
            written.backup ? `备份：${written.backup}` : '',
          ]),
          file: written.file,
          backup: written.backup,
          count: written.count,
        }
      }

      if (action === 'add') {
        const name = asString(input.name, '')
        const apiKey = asString(input.apiKey, '')
        const apiSecret = asString(input.apiSecret, '')
        if (name.length === 0) return { ok: false, message: 'add 需要 name（账号别名，之后用 account 指定）' }
        if (current.some((a) => a.name === name || (apiKey.length > 0 && a.apiKey === apiKey))) {
          return { ok: false, message: `已有账号 "${name}" 或同一把 apiKey；要改它请用 action=update` }
        }
        const problems = inspectCredential(apiKey, apiSecret)
        if (problems.length > 0) return { ok: false, message: `凭据格式有问题：\n  - ${problems.join('\n  - ')}` }

        let quotaLine = ''
        if (input.skipVerify !== true) {
          const checked = await verify(name, apiKey, apiSecret)
          if (!checked.ok) {
            return {
              ok: false,
              message: `验证失败，没有写入：${checked.message}\n  确认这对 key 能用再来；坚持要写就把 skipVerify 传 true`,
              verified: false,
            }
          }
          const q = checked.quota
          quotaLine = `已验证：名额 ${q.used}/${q.total}（还能注册 ${q.available} 个）`
        }

        current.push({
          name,
          apiKey,
          apiSecret,
          defaultRootDomain: asString(input.defaultRootDomain, ''),
          memo: asString(input.memo, ''),
        })
        const written = persistAccounts(config, current)
        return {
          ok: true,
          message: text([
            `✓ 已写入账号 ${name}（${maskKey(apiKey)}）`,
            quotaLine,
            `现在共 ${written.count} 个账号`,
            `文件：${written.file}`,
            written.backup ? `备份：${written.backup}` : '',
          ]),
          file: written.file,
          backup: written.backup,
          count: written.count,
          verified: input.skipVerify !== true,
        }
      }

      const index = locate()
      if (index < 0) return { ok: false, message: `没找到账号 "${want}"（update 需要 account 定位）` }
      const target = current[index]
      const nextName = asString(input.name, target.name)
      const nextKey = asString(input.apiKey, target.apiKey)
      const nextSecret = asString(input.apiSecret, target.apiSecret)
      if (nextName !== target.name && current.some((a, i) => i !== index && a.name === nextName)) {
        return { ok: false, message: `别名 "${nextName}" 已经被别的账号占了` }
      }
      const problems = inspectCredential(nextKey, nextSecret)
      if (problems.length > 0) return { ok: false, message: `凭据格式有问题：\n  - ${problems.join('\n  - ')}` }

      let quotaLine = ''
      if (input.skipVerify !== true) {
        const checked = await verify(nextName, nextKey, nextSecret)
        if (!checked.ok) return { ok: false, message: `验证失败，没有改动：${checked.message}`, verified: false }
        const q = checked.quota
        quotaLine = `已验证：名额 ${q.used}/${q.total}`
      }

      current[index] = {
        name: nextName,
        apiKey: nextKey,
        apiSecret: nextSecret,
        defaultRootDomain: asString(input.defaultRootDomain, target.defaultRootDomain ?? ''),
        memo: asString(input.memo, target.memo ?? ''),
      }
      const written = persistAccounts(config, current)
      return {
        ok: true,
        message: text([
          `✓ 已更新账号 ${nextName}（${maskKey(nextKey)}）`,
          quotaLine,
          `文件：${written.file}`,
          written.backup ? `备份：${written.backup}` : '',
        ]),
        file: written.file,
        backup: written.backup,
        count: written.count,
        verified: input.skipVerify !== true,
      }
    },
  }
}

function domainsTool(live) {
  return {
    name: 'dnshe_domains',
    description:
      '列 DNSHE 账号下的免费子域名（可按关键词/根域/状态过滤），或按完整域名取单个域名的详情（含全部解析记录）。到期时间会一并算好剩余天数。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account: { type: 'string', description: '账号别名（不给就用默认账号）' },
        detail: { type: 'string', description: '填完整域名：只取这一个域名的详情 + 全部解析记录' },
        search: { type: 'string', description: '关键词，匹配子域前缀或根域' },
        rootdomain: { type: 'string', description: '只看某个根域，例如 l.cd' },
        status: { type: 'string', description: '状态过滤；实际取值是 Registered' },
        page: { type: 'integer', description: '页码，默认 1' },
        perPage: { type: 'integer', description: '每页条数，默认 200，最大 500' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: OK_MESSAGE,
          account: { type: 'string' },
          count: { type: 'integer' },
          hasMore: { type: 'boolean' },
          nextPage: { type: 'integer' },
          domains: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                full_domain: { type: 'string' },
                subdomain: { type: 'string' },
                rootdomain: { type: 'string' },
                status: { type: 'string' },
                expires_at: { type: 'string' },
                never_expires: { type: 'boolean' },
                daysLeft: { type: 'integer' },
              },
              required: ['id', 'full_domain'],
            },
          },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const config = live()
      const input = args !== null && typeof args === 'object' ? args : {}
      const picked = pickAccount(config, input.account)
      if (picked.error !== undefined) return { ok: false, message: picked.error }
      const account = picked.account

      if (typeof input.detail === 'string' && input.detail.trim().length > 0) {
        const resolved = await resolveDomainAny(config, account, input.detail.trim())
        if (!resolved.ok) return { ok: false, message: resolved.message, account: account.name }
        const sub = resolved.sub
        const owner = resolved.account
        const detail =
          resolved.dnsRecords !== undefined
            ? { sub, records: resolved.dnsRecords }
            : await (async () => {
                const recs = await listAllRecords(config, owner, sub.id)
                return recs.ok ? { sub, records: recs.rows } : { sub, records: [], error: recs.message }
              })()
        const lines = [
          `${sub.full_domain}（id=${sub.id}，账号 ${owner.name}）`,
          `状态 ${sub.status ?? '?'}   到期 ${expiryLabel(sub)}   根域 ${sub.rootdomain ?? '?'}`,
          `解析记录 ${detail.records.length} 条：`,
        ]
        for (const record of detail.records) lines.push(`  ${recordLine(record, sub.full_domain)}`)
        if (detail.error !== undefined) lines.push(`  ✗ ${detail.error}`)
        return {
          ok: true,
          message: text(lines),
          account: account.name,
          count: 1,
          domains: [
            {
              id: String(sub.id),
              full_domain: String(sub.full_domain),
              subdomain: String(sub.subdomain ?? ''),
              rootdomain: String(sub.rootdomain ?? ''),
              status: String(sub.status ?? ''),
              expires_at: String(sub.expires_at ?? ''),
              never_expires: Number(sub.never_expires) === 1,
              ...(daysLeft(sub.expires_at) === null ? {} : { daysLeft: daysLeft(sub.expires_at) }),
            },
          ],
        }
      }

      const result = await apiCall(config, account, 'subdomains', 'list', {
        params: {
          page: asInt(input.page, 1, 1, 100000),
          per_page: asInt(input.perPage, 200, 1, 500),
          search: asString(input.search, ''),
          rootdomain: asString(input.rootdomain, ''),
          status: asString(input.status, ''),
          sort_by: 'expires_at',
          sort_dir: 'asc',
          fields: 'all',
        },
      })
      if (!result.ok) return { ok: false, message: result.message, account: account.name }
      const items = Array.isArray(result.json.subdomains) ? result.json.subdomains : []
      const pg = result.json.pagination ?? {}
      const lines = [`${account.name}：${items.length} 个域名${pg.has_more === true ? '（还有下一页）' : ''}`]
      for (const row of items) lines.push(`  ${domainLine(row)}`)
      if (items.length === 0) lines.push('  （一个都没有；换 search/rootdomain，或者换个 account）')
      const otherAccounts = (picked.book?.accounts ?? []).filter((a) => a.apiKey !== account.apiKey)
      if (otherAccounts.length > 0) {
        lines.push(
          `（只看的是 ${account.name} 这一个账号；另有 ${otherAccounts.length} 个账号（${otherAccounts
            .map((a) => a.name)
            .join(' / ')}），用 account 参数切换——不同账号的域名互不可见）`
        )
      }
      return {
        ok: true,
        message: text(lines),
        account: account.name,
        count: items.length,
        hasMore: pg.has_more === true,
        ...(Number.isInteger(pg.next_page) ? { nextPage: pg.next_page } : {}),
        domains: items.map((row) => ({
          id: String(row.id),
          full_domain: String(row.full_domain ?? ''),
          subdomain: String(row.subdomain ?? ''),
          rootdomain: String(row.rootdomain ?? ''),
          status: String(row.status ?? ''),
          expires_at: String(row.expires_at ?? ''),
          never_expires: Number(row.never_expires) === 1,
          ...(daysLeft(row.expires_at) === null ? {} : { daysLeft: daysLeft(row.expires_at) }),
        })),
      }
    },
  }
}

function recordsTool(live) {
  return {
    name: 'dnshe_records',
    description:
      '列某个 DNSHE 子域名的全部解析记录（可按类型过滤）。返回每条的 id —— 改和删都用这个 id 最稳。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        domain: { type: 'string', description: '完整域名，例如 shizuku.l.cd（也可以给 subdomain_id）' },
        account: { type: 'string', description: '账号别名' },
        type: { type: 'string', description: `只看某类型：${RECORD_TYPES.join(' / ')}` },
      },
      required: ['domain'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: OK_MESSAGE,
          domain: { type: 'string' },
          subdomainId: { type: 'string' },
          count: { type: 'integer' },
          records: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                type: { type: 'string' },
                content: { type: 'string' },
                ttl: { type: 'integer' },
                status: { type: 'string' },
              },
              required: ['id', 'type'],
            },
          },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const config = live()
      const input = args !== null && typeof args === 'object' ? args : {}
      const picked = pickAccount(config, input.account)
      if (picked.error !== undefined) return { ok: false, message: picked.error }
      const account = picked.account
      const resolved = await resolveDomainAny(config, account, input.domain)
      if (!resolved.ok) return { ok: false, message: resolved.message }
      const sub = resolved.sub
      const owner = resolved.account
      const all = await listAllRecords(config, owner, sub.id)
      if (!all.ok) return { ok: false, message: all.message, domain: sub.full_domain }
      const type = asString(input.type, '').toUpperCase()
      const rows = type.length > 0 ? all.rows.filter((r) => String(r.type).toUpperCase() === type) : all.rows
      const lines = [`${sub.full_domain}（id=${sub.id}）：${rows.length} 条记录${type.length > 0 ? ` · ${type}` : ''}`]
      if (resolved.switched) lines.push(`（这个域名挂在账号 ${owner.name} 下，已自动切过去）`)
      for (const record of rows) lines.push(`  ${recordLine(record, sub.full_domain)}`)
      if (rows.length === 0) lines.push('  （没有记录）')
      return {
        ok: true,
        message: text(lines),
        domain: String(sub.full_domain),
        subdomainId: String(sub.id),
        count: rows.length,
        records: rows.map((record) => ({
          id: String(record.id),
          name: String(record.name ?? ''),
          type: String(record.type ?? ''),
          content: String(record.content ?? ''),
          ttl: Number(record.ttl ?? 600),
          status: String(record.status ?? ''),
        })),
      }
    },
  }
}

function recordWriteTool(live) {
  return {
    name: 'dnshe_record_write',
    description:
      '增 / 改 / 删 DNSHE 的解析记录。action=create 要 domain+type+content；update 用 recordId 或 domain+name+type 定位后给新值；delete 必须 confirm=true。name 用相对名（@ 是子域本身）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'], description: '要做哪个动作' },
        account: { type: 'string', description: '账号别名' },
        domain: { type: 'string', description: '完整域名（定位记录时用）' },
        recordId: { type: 'string', description: '记录 id（最稳的定位方式，先 dnshe_records 拿）' },
        name: { type: 'string', description: '@ 或相对名，例如 www / _acme-challenge；不填=@' },
        type: { type: 'string', description: `记录类型：${RECORD_TYPES.join(' / ')}` },
        content: { type: 'string', description: '记录值，例如 IP、目标域名、TXT 串；update 时是新值' },
        priority: { type: 'integer', description: 'MX / SRV 的优先级' },
        ttl: { type: 'integer', description: '不用传：平台固定 600' },
        newName: { type: 'string', description: 'update 专用：把记录名改成这个（相对名）' },
        newType: { type: 'string', description: 'update 专用：把类型改成这个' },
        confirm: { type: 'boolean', description: 'delete 必须为 true' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: OK_MESSAGE,
          recordId: { type: 'string' },
          domain: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const config = live()
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = asString(input.action, '')
      if (!['create', 'update', 'delete'].includes(action)) {
        return { ok: false, message: 'action 只能是 create / update / delete' }
      }
      const picked = pickAccount(config, input.account)
      if (picked.error !== undefined) return { ok: false, message: picked.error }
      const account = picked.account

      if (action === 'create') {
        const resolved = await resolveDomainAny(config, account, input.domain)
        if (!resolved.ok) return { ok: false, message: resolved.message }
        const sub = resolved.sub
        const owner = resolved.account
        const type = asString(input.type, '').toUpperCase()
        if (!RECORD_TYPES.includes(type)) {
          return { ok: false, message: `type 必须在这几个里：${RECORD_TYPES.join(' / ')}` }
        }
        const content = asString(input.content, '')
        if (content.length === 0) return { ok: false, message: 'create 需要 content（记录值）' }
        const name = relName(input.name, sub.full_domain)
        const body = { subdomain_id: Number(sub.id), type, content }
        if (name !== '@') body.name = name
        if (Number.isInteger(input.priority)) body.priority = input.priority
        const result = await apiCall(config, owner, 'dns_records', 'create', { method: 'POST', body })
        if (!result.ok) return { ok: false, message: result.message, domain: String(sub.full_domain) }
        invalidateDomains(owner)
        const shown = absName(name, sub.full_domain)
        return {
          ok: true,
          message: text([
            `✓ 已添加 ${type} ${shown} → ${content}（id=${result.json.id}）`,
            TTL_NOTE,
            '回读确认：dnshe_records domain=' + sub.full_domain,
          ]),
          recordId: String(result.json.id ?? ''),
          domain: String(sub.full_domain),
        }
      }

      const located = await findRecord(config, account, {
        id: asString(input.recordId, ''),
        domain: input.domain,
        name: input.name,
        type: input.type,
      })
      if (!located.ok) return { ok: false, message: located.message }
      const target = located.record
      const recordId = String(target.id)
      const owner = located.account ?? account

      if (action === 'delete') {
        const described =
          target.type !== undefined
            ? `${target.type} ${target.name ?? '?'} → ${target.content ?? '?'}（id=${recordId}）`
            : `记录 id=${recordId}`
        if (input.confirm !== true) {
          return {
            ok: false,
            message:
              `删除记录是不可逆的。要删的是：${described}` +
              '\n确认无误后把 confirm 传 true 再来一次；想先看内容就 dnshe_records 按域名列一遍',
          }
        }
        const result = await runOnRecordOwner(config, account, located, (acc) =>
          apiCall(config, acc, 'dns_records', 'delete', {
            method: 'POST',
            body: { id: Number(recordId) },
          })
        )
        if (!result.ok) return { ok: false, message: result.message, recordId }
        invalidateDomains(result.account)
        return { ok: true, message: `✓ 已删除记录 ${described}`, recordId }
      }

      const body = { id: Number(recordId) }
      let changed = false
      if (input.content !== undefined) {
        body.content = String(input.content)
        changed = true
      }
      if (input.newName !== undefined) {
        body.name = relName(input.newName, located.sub?.full_domain)
        changed = true
      }
      if (input.newType !== undefined) {
        const nt = String(input.newType).toUpperCase()
        if (!RECORD_TYPES.includes(nt)) {
          return { ok: false, message: `newType 必须在这几个里：${RECORD_TYPES.join(' / ')}` }
        }
        body.type = nt
        changed = true
      }
      if (Number.isInteger(input.priority)) {
        body.priority = input.priority
        changed = true
      }
      if (!changed) {
        return { ok: false, message: 'update 要至少改一样：content / newName / newType / priority' }
      }
      const result = await runOnRecordOwner(config, account, located, (acc) =>
        apiCall(config, acc, 'dns_records', 'update', { method: 'POST', body })
      )
      if (!result.ok) return { ok: false, message: result.message, recordId }
      invalidateDomains(result.account)
      const parts = [`✓ 已更新记录 id=${recordId}`]
      if (body.content !== undefined) parts.push(`  content → ${body.content}`)
      if (body.name !== undefined) parts.push(`  name → ${body.name}`)
      if (body.type !== undefined) parts.push(`  type → ${body.type}`)
      if (body.priority !== undefined) parts.push(`  priority → ${body.priority}`)
      parts.push(`回读确认：dnshe_records ${located.sub?.full_domain ?? ''}${input.type ? ` type=${input.type}` : ''}`)
      return { ok: true, message: text(parts), recordId }
    },
  }
}

function domainWriteTool(live) {
  return {
    name: 'dnshe_domain_write',
    description:
      '注册 / 续期 / 删除 DNSHE 免费子域名。register 要 subdomain（前缀）+ rootdomain，会先查名额；renew 给完整域名；delete 必须 confirm=true（连带删掉全部解析记录）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['register', 'renew', 'delete'], description: '要做哪个动作' },
        account: { type: 'string', description: '账号别名（register 时可以选择哪个账号的名额）' },
        subdomain: { type: 'string', description: 'register 用：前缀，例如 myapp' },
        rootdomain: { type: 'string', description: 'register 用：根域，例如 l.cd' },
        domain: { type: 'string', description: 'renew / delete 用：完整域名' },
        confirm: { type: 'boolean', description: 'delete 必须为 true' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: OK_MESSAGE,
          domain: { type: 'string' },
          subdomainId: { type: 'string' },
          expiresAt: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const config = live()
      const input = args !== null && typeof args === 'object' ? args : {}
      const action = asString(input.action, '')
      if (!['register', 'renew', 'delete'].includes(action)) {
        return { ok: false, message: 'action 只能是 register / renew / delete' }
      }
      const picked = pickAccount(config, input.account)
      if (picked.error !== undefined) return { ok: false, message: picked.error }
      const account = picked.account

      if (action === 'register') {
        const subdomain = asString(input.subdomain, '')
        const rootdomain = asString(input.rootdomain, '')
        if (subdomain.length === 0 || rootdomain.length === 0) {
          return { ok: false, message: 'register 需要 subdomain（前缀）+ rootdomain（根域）' }
        }
        const quota = await getQuota(config, account, { refresh: true })
        if (!quota.ok) return { ok: false, message: `查名额失败，先不注册：${quota.message}` }
        const available = Number(quota.quota.available ?? 0)
        if (available <= 0) {
          return {
            ok: false,
            message: `账号 ${account.name} 没名额了（used ${quota.quota.used}/${quota.quota.total}）\n  换一个 account，或先清理不用的域名`,
          }
        }
        const result = await apiCall(config, account, 'subdomains', 'register', {
          method: 'POST',
          body: { subdomain, rootdomain },
        })
        if (!result.ok) return { ok: false, message: result.message }
        invalidateDomains(account)
        return {
          ok: true,
          message: text([
            `✓ 已注册 ${result.json.full_domain}（id=${result.json.subdomain_id}，账号 ${account.name}）`,
            `该账号还剩 ${available - 1} 个名额`,
            `下一步配解析：dnshe_record_write action=create domain=${result.json.full_domain} type=A content=<IP>`,
          ]),
          domain: String(result.json.full_domain ?? ''),
          subdomainId: String(result.json.subdomain_id ?? ''),
        }
      }

      const resolved = await resolveDomainAny(config, account, input.domain)
      if (!resolved.ok) return { ok: false, message: resolved.message }
      const sub = resolved.sub
      const owner = resolved.account

      if (action === 'renew') {
        const result = await apiCall(config, owner, 'subdomains', 'renew', {
          method: 'POST',
          body: { subdomain_id: Number(sub.id) },
        })
        if (!result.ok) return { ok: false, message: result.message, domain: String(sub.full_domain) }
        invalidateDomains(owner)
        const json = result.json
        return {
          ok: true,
          message: text([
            `✓ ${sub.full_domain} 已续期`,
            `  ${json.previous_expires_at ?? sub.expires_at ?? '?'} → ${json.new_expires_at ?? '?'}`,
            `  剩余 ${json.remaining_days ?? '?'} 天，本次扣费 ${json.charged_amount ?? 0}`,
          ]),
          domain: String(sub.full_domain),
          subdomainId: String(sub.id),
          expiresAt: String(json.new_expires_at ?? ''),
        }
      }

      if (input.confirm !== true) {
        return {
          ok: false,
          message: `删除 ${sub.full_domain} 会连带删掉它的全部解析记录，不可恢复。确认后把 confirm 传 true`,
          domain: String(sub.full_domain),
        }
      }
      const result = await apiCall(config, owner, 'subdomains', 'delete', {
        method: 'POST',
        body: { subdomain_id: Number(sub.id) },
      })
      if (!result.ok) return { ok: false, message: result.message, domain: String(sub.full_domain) }
      invalidateDomains(owner)
      return {
        ok: true,
        message: `✓ 已删除 ${result.json.full_domain ?? sub.full_domain}（连带 ${result.json.dns_records_deleted ?? '?'} 条解析记录）`,
        domain: String(result.json.full_domain ?? sub.full_domain),
        subdomainId: String(sub.id),
      }
    },
  }
}

function expiringTool(live) {
  return {
    name: 'dnshe_expiring',
    description:
      '到期巡检：列出 N 天内到期的 DNSHE 域名（默认 30 天），按剩余天数升序。已经过期的也会列出来并标红。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account: { type: 'string', description: '账号别名；不给就查所有账号' },
        days: { type: 'integer', description: '多少天内，默认 30' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: OK_MESSAGE,
          days: { type: 'integer' },
          count: { type: 'integer' },
          domains: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                account: { type: 'string' },
                full_domain: { type: 'string' },
                id: { type: 'string' },
                expires_at: { type: 'string' },
                daysLeft: { type: 'integer' },
              },
              required: ['account', 'full_domain'],
            },
          },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const config = live()
      const input = args !== null && typeof args === 'object' ? args : {}
      const days = asInt(input.days, 30, 0, 3650)
      const book = readAccountsBook(config)
      if (book.error !== undefined) return { ok: false, message: book.error, days, count: 0, domains: [] }
      const want = asString(input.account, '')
      const targets =
        want.length > 0 ? book.accounts.filter((a) => a.name === want || a.apiKey === want) : book.accounts
      if (targets.length === 0) {
        return { ok: false, message: `没有账号 "${want}"`, days, count: 0, domains: [] }
      }

      const rows = []
      const lines = []
      for (const account of targets) {
        const all = await listAllDomains(config, account)
        if (!all.ok) {
          lines.push(`${account.name}：查询失败 —— ${all.message}`)
          continue
        }
        const hits = all.rows
          .filter((row) => Number(row.never_expires) !== 1)
          .map((row) => ({ row, left: daysLeft(row.expires_at) }))
          .filter((it) => it.left !== null && it.left <= days)
          .sort((a, b) => a.left - b.left || String(a.row.expires_at).localeCompare(String(b.row.expires_at)))
        lines.push(`${account.name}：${days} 天内到期 ${hits.length} 个（共 ${all.rows.length} 个域名）`)
        for (const it of hits) {
          const tag = it.left < 0 ? `已过期 ${Math.abs(it.left)} 天` : `剩 ${it.left} 天`
          lines.push(`  ${String(it.row.full_domain).padEnd(36)} ${it.row.expires_at}  ${tag}`)
          rows.push({
            account: account.name,
            full_domain: String(it.row.full_domain),
            id: String(it.row.id),
            expires_at: String(it.row.expires_at ?? ''),
            daysLeft: it.left,
          })
        }
      }
      if (rows.length === 0) lines.push('（没有临期域名）')
      return { ok: true, message: text(lines), days, count: rows.length, domains: rows }
    },
  }
}

function whoisTool(live) {
  return {
    name: 'dnshe_whois',
    description:
      'WHOIS 查询（DNSHE 公开接口，支持它自己发的免费域名，也支持外部域名）。看注册时间、到期、NS、DNSSEC。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        domain: { type: 'string', description: '完整域名' },
        account: { type: 'string', description: '账号别名（用它认证；不给用默认账号）' },
      },
      required: ['domain'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: OK_MESSAGE,
          registered: { type: 'boolean' },
          expiresAt: { type: 'string' },
          nameservers: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const config = live()
      const input = args !== null && typeof args === 'object' ? args : {}
      const domain = asString(input.domain, '')
      if (domain.length === 0) return { ok: false, message: '缺 domain' }
      const picked = pickAccount(config, input.account)
      const account =
        picked.error !== undefined
          ? { name: 'anonymous', apiKey: '', apiSecret: '' }
          : picked.account
      const result = await apiCall(config, account, 'whois', null, { params: { domain } })
      if (!result.ok) return { ok: false, message: result.message }
      const json = result.json
      if (json.registered === false) {
        return {
          ok: true,
          message: `${json.domain ?? domain}：未注册（${json.status ?? 'unregistered'}）`,
          registered: false,
        }
      }
      const ns = Array.isArray(json.nameservers) ? json.nameservers : Array.isArray(json.name_servers) ? json.name_servers : []
      const lines = [
        `${json.domain ?? domain}：${json.status ?? '?'}`,
        `  注册 ${json.registered_at ?? json.created_at ?? '?'}  到期 ${json.expires_at ?? '?'}${json.expires_at ? `（剩 ${daysLeft(json.expires_at) ?? '?'} 天）` : ''}`,
        `  NS ${ns.join(', ') || '-'}   DNSSEC ${json.dnssec ?? '-'}   注册商 ${json.registrar ?? '-'}`,
        `  隐私保护 ${json.privacy_enabled === true ? '开' : '关'}`,
      ]
      if (picked.error !== undefined) lines.push(`  （注意：没找到可用账号，这次是匿名查的）`)
      return {
        ok: true,
        message: text(lines),
        registered: true,
        expiresAt: String(json.expires_at ?? ''),
        nameservers: ns.map((n) => String(n)),
      }
    },
  }
}

// ---------------------------------------------------------------- plugin

export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config) {
  const live = () => resolveConfig(config)

  if (live().prompt) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          text: () => live().rules,
        }),
      'dsh-dnshe-domain: rules section'
    )
  }

  const tools = [
    accountsTool(live),
    accountsWriteTool(live),
    domainsTool(live),
    recordsTool(live),
    recordWriteTool(live),
    domainWriteTool(live),
    expiringTool(live),
    whoisTool(live),
  ]
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-dnshe-domain: ${tool.name}`)
  }
}

// 不导出 Config：宿主会对导出的 Config 调 `.validate()`，JSON Schema 字面量没有这个方法，
// 激活会以 `Cannot read properties of undefined (reading 'validate')` 失败。
// 配置仍然从 apply(ctx, config) 进来，resolveConfig() 对每个字段单独兜底，
// 所以在 profile 的 cordis.patch.yml 里写 config 照样生效：
//
//   - id: dsh-dnshe-domain
//     config:
//       accountsFile: C:\Users\mynlp\.dnshe\accounts.json
//       defaultAccount: shizuku

