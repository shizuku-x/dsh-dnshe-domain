# DNSHE 免费域名

把 DNSHE 的免费域名 API（V2.0）接进 DSH。免费二级域名的注册、续期、删除，A / AAAA / CNAME / TXT / MX / SRV / CAA 解析的增删改查，名额用量、到期巡检、WHOIS，全部由 8 个工具覆盖。

## 工具

| 工具 | 作用 |
|---|---|
| `dnshe_accounts` | 列出账号（apiKey 脱敏）与各账号名额；`probe=true` 时真的去查一次实时配额与域名数 |
| `dnshe_accounts_write` | `action=add/update/remove/test`：把 apiKey / apiSecret 写进凭据库，默认先联网验证、写前备份、原子替换 |
| `dnshe_domains` | 列子域名（可按 `search` / `rootdomain` / `status` 过滤），`detail=<完整域名>` 时返回该域名的详情 + 全部解析记录 |
| `dnshe_records` | 列某个域名的解析记录，可按 `type` 过滤；返回的 `id` 就是改 / 删要用的标识 |
| `dnshe_record_write` | `action=create/update/delete`：加、改、删解析记录；删除必须 `confirm=true` |
| `dnshe_domain_write` | `action=register/renew/delete`：注册（先查名额）、续期、删子域（必须 `confirm=true`） |
| `dnshe_expiring` | 到期巡检，默认 30 天；过期的也会列出来 |
| `dnshe_whois` | WHOIS 查询（注册时间、到期、NS、DNSSEC） |

## 凭据

默认读 DNSHE 后台导出的账号 JSON：

```
~/.dnshe/accounts.json        # Windows: C:\Users\<你>\.dnshe\accounts.json
```

格式就是后台「导出账号」得到的原样：

```json
{
  "format": "dnshe-accounts",
  "version": 1,
  "exportedAt": 1794917083998,
  "accounts": [
    {
      "name": "shizuku",
      "apiKey": "cfsd_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "apiSecret": "（64 位 hex）",
      "defaultRootDomain": "",
      "memo": ""
    }
  ]
}
```

也支持另外两条路：插件 config 里直接内联 `accounts` 数组，或者环境变量 `DNSHE_API_KEY` / `DNSHE_API_SECRET`。

每个账号能看到的域名互不相通——某个域名查不到时，先换 `account` 再判断它不存在。

## 配置

```yaml
- id: dsh-dnshe-domain
  name: dsh-dnshe-domain
  config:
    accountsFile: C:\Users\mynlp\.dnshe\accounts.json
    defaultAccount: shizuku
    timeoutMs: 30000
    cacheTtlMs: 60000
    prompt: true
```

- `cacheTtlMs`：域名列表与配额的缓存，写操作会自动失效；`0` 表示不缓存。
- `prompt`：注入一段常驻规则（记录名用相对名、TTL 固定 600、status 是 Registered、删除要回读确认等）。

## 实测校正过的行为

以下都是真正打接口验证过的，官方文档写错或写漏的地方：

- **记录名 `name` 只接受相对名或 `@`**。传 `_acme-challenge.api.l.cd` 会 `400 invalid_record_name`，要传 `_acme-challenge.api`；插件会自动把完整域名折成相对名。
- **TTL 被平台强制成 600**，传 60 / 120 都不生效。
- 子域名的 `status` 真实取值是 **`Registered`**，不是文档里的 `active`。
- `subdomains/list` 是 `page` 分页，`dns_records/list` 是**游标分页**（`cursor` / `next_cursor`），两套不一样。
- 没有"可注册根域名列表"接口（`endpoint=rootdomains` 直接 404），根域只能从已有域名反推或去后台看。
- `dns_records/list` 的 `search` / `fields` 参数会被忽略，永远返回全量记录，筛选在插件里本地做。

## 安全

- 删除类动作（删记录、删子域）不带 `confirm=true` 一律只回一句话说明将要删什么，不执行。
- 插件日志、工具输出里不出现 `apiSecret`，`dnshe_accounts` 只显示脱敏的 apiKey。
- 改完 DNS 会提示用 `dnshe_records` 回读确认；公网生效受 600 秒 TTL 影响，不承诺秒生效。
