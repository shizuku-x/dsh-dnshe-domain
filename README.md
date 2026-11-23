# dsh-dnshe-domain

DeepSeek Harness（DSH）插件：把 DNSHE 的免费域名 API V2.0 接进来——免费二级域名的注册 / 续期 / 删除，A / AAAA / CNAME / TXT / MX / SRV / CAA 解析的增删改查，名额用量、到期巡检、WHOIS，全部由 8 个工具覆盖。

```
https://api005.dnshe.com/index.php?m=domain_hub&endpoint=<模块>&action=<动作>
认证：X-API-Key + X-API-Secret
```

## 快速开始

1）装插件

```bash
dsh plugin --profile desktop add dsh-dnshe-domain
```

改代码时也可以装本地目录（软链，改完即时生效）：

```bash
dsh plugin --profile desktop add D:\dsh\plugins\dsh-dnshe-domain
```

2）放凭据

把 DNSHE 后台「免费域名管理 → API管理 → 导出」得到的 JSON 放到：

```
~/.dnshe/accounts.json          # Windows: C:\Users\<你>\.dnshe\accounts.json
```

`format` 字段必须是 `dnshe-accounts`。它长这样（`apiSecret` 不要提交进 git）：

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

3）开一个新会话，直接说话

- 「我 DNSHE 上还有多少免费名额」→ `dnshe_accounts{ probe: true }`
- 「`shizuku.l.cd` 现在解析到哪」→ `dnshe_records{ domain: "shizuku.l.cd" }`
- 「给 `new.example.l.cd` 加一条 A 记录指向 1.2.3.4」→ `dnshe_record_write{ action: "create" }`
- 「把 `www` 那条改成新 IP」→ `dnshe_record_write{ action: "update" }`（先 `dnshe_records` 拿 id）

装完要开新会话，工具才会出现（本地 bundle 需要新的模块世代）。

## 八个工具

### dnshe_accounts_write — 写账号凭据（AI 可以直接落盘）

`{ action: add|update|remove|test, name?, apiKey?, apiSecret?, defaultRootDomain?, memo?, account?, skipVerify?, confirm? }`

- `add`：新增账号。默认先拿这对 key 调一次 `quota` 验证有效，不通过就不写。
- `update`：`account` 定位（别名或 apiKey），可改 `name` / `apiKey` / `apiSecret` / `defaultRootDomain` / `memo`。
- `remove`：`account` 定位 + `confirm: true`；只删本地这份凭据库，DNSHE 那边域名不动。
- `test`：只验证不写，`account` 或直接给 `apiKey` + `apiSecret`。

写入前会把原文件备份成 `accounts.json.bak-<时间戳>`，再 tmp + rename 原子替换，顶层 `format` / `version` / `exportedAt` 原样保留；写完清空凭据与域名/配额缓存。密钥从不出现在输出里。

```
「把 cfsd_xxx 和它的 secret 加上，别名 myapp」
  → dnshe_accounts_write { action: "add", name: "myapp", apiKey: "cfsd_xxx", apiSecret: "..." }
```
### dnshe_accounts — 账号与名额
`{ probe?: boolean, account?: string }`
默认只读凭据文件；`probe: true` 会逐个账号问一次实时配额与域名数。

### dnshe_domains — 子域名列表 / 单域名详情
`{ account?, detail?, search?, rootdomain?, status?, page?, perPage? }`
`detail: "<完整域名>"` 时返回该域名的详情 + 全部解析记录。到期时间会算好剩余天数。

### dnshe_records — 解析记录
`{ domain, account?, type? }`
返回每条记录的 `id` —— 改和删都用它最稳。

### dnshe_record_write — 记录增 / 改 / 删
`{ action: create|update|delete, account?, domain?, recordId?, name?, type?, content?, priority?, ttl?, newName?, newType?, confirm? }`

- create：`domain` + `type` + `content`（`name` 可选，默认 `@`）
- update：`recordId`，或 `domain` + `name` + `type` 定位；然后给 `content` / `newName` / `newType` / `priority`
- delete：定位同上 + `confirm: true`（不传只回一句「要删的是什么」，不动手）

### dnshe_domain_write — 子域注册 / 续期 / 删除
`{ action: register|renew|delete, account?, subdomain?, rootdomain?, domain?, confirm? }`

- register：`subdomain`（前缀）+ `rootdomain`，会先查 `quota.available`
- renew / delete：`domain`（完整域名或 subdomain_id）；delete 要 `confirm: true`

### dnshe_expiring — 到期巡检
`{ account?, days? }`　默认 30 天，已过期的也列出来。

### dnshe_whois — WHOIS
`{ domain, account? }`

## 多个账号怎么办

一个账号看不到别的账号的域名。插件默认用凭据文件里的第一个账号，但**域名解析会自动跨账号兜底**：找不到就挨个账号翻，找到后在输出里说明「这个域名挂在账号 X 下，已自动切过去」。也可以直接 `account: "shizuku"` 指定。

## 配置（可选）

不导出 Config schema，配置直接写在 profile 的 `cordis.patch.yml` 里就生效：

```yaml
- id: dsh-dnshe-domain
  config:
    accountsFile: C:\Users\mynlp\.dnshe\accounts.json
    defaultAccount: shizuku
    timeoutMs: 30000
    cacheTtlMs: 60000
    prompt: true
```

`cacheTtlMs` 是域名列表与配额的缓存（默认 60s，写操作后自动失效）；`prompt` 控制是否注入常驻使用规则。

## 实测踩到的坑（代码里已经兜住）

1. `name` 只接受相对名或 `@` —— 传完整域名会 400 `invalid_record_name`。插件用 `relName()` 自动折叠。
2. TTL 被平台固定成 600，写 60 / 120 无效。
3. 子域名 `status` 的真实值是 `Registered`，不是文档里的 `active`（WHOIS 那边又报 `active`）。
4. `subdomains/list` 用 page 分页；`dns_records/list` 用 cursor 分页（`next_cursor`），没有 total。
5. `dns_records/list` 忽略 `search` / `fields`，永远全量返回，筛选在本地做。
6. 没有根域名枚举接口（`endpoint=rootdomains|domains|roots` 全 404）。
7. 写操作后配额缓存与域名缓存会一起失效，避免读到旧值。

## 限速与缓存

- 单进程内串行，最小间隔 1000ms（保守按 60 次/分；文档正文写 30 次/分、错误体写 60 次/分）。
- 域名全量列表与配额各缓存 `cacheTtlMs`（默认 60s），写操作后清空。

## 安全

- `apiSecret` 从不出现在任何工具输出里；`dnshe_accounts` 只显示脱敏的 apiKey。
- 删除类动作不带 `confirm: true` 一律只回复将要删除什么，不执行。
- 改完 DNS 会提示用 `dnshe_records` 回读确认；公网生效受 600 秒 TTL 影响，不承诺秒生效。

## 自检

```bash
node _selftest.mjs
```

在假 ctx 上加载插件，依次跑：账号列表 → 实时配额 → 域名列表 → 域名详情 → 记录列表 → **TXT 记录增 / 查 / 删往返**（删之前先确认一次 `confirm:false` 的行为）→ 到期巡检 → WHOIS。
自检会真的写一条 `_dsh-plugin-selftest` TXT 再删掉，介意就把那段注释掉。

## 更新记录

- **1.0.3** — 新增 `dnshe_accounts_write`：AI 可以把 apiKey / apiSecret 直接写进凭据库（写入前联网验证、写前备份、原子替换、缓存自动失效）。
- **1.0.2** — 修 `dnshe_record_write` 只给 `recordId`（不给 `domain`）时用错账号：默认账号不是记录所属账号时会撞上 DNSHE 的 HTML 404 页。现在会按「指定账号 → 其它账号」逐个试，命中即停；错误信息也会提示「可能是这条记录挂在别的账号下」。
- **1.0.1** — 补齐 README（快速开始 / 全部工具参数 / 配置 / 安全 / 更新记录）。
- **1.0.0** — 首个版本：七个工具 + 常驻提示词分节。

## License

MIT
