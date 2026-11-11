# dsh-usage-panel 开发计划

> 本文档是开发依据：**改代码之前先改这里**。代码、README、测试与本文冲突时，以本文为准。
> 当前版本：0.2.0（P0 + P0.1 + P1）
> 状态：P0 已完成；P0.1 已完成；P1 已完成（代码 + mock 测试；真实 API 未测）
> 最后更新：2026-11-11

---

## 1. 目标与范围

### 1.1 目标

在 DSH 桌面端提供一个侧边栏页面，把两件本来分开的事摆清楚：

- **官方余额**：各个 API 服务「还剩多少钱」——只能来自各服务自己的接口；
- **本机账本**：DSH 在这台机器上「钱花在哪」——来自 `~/.dsh/dsh-usage/usage-ledger.json`。

两者口径不同、可能不一致，页面必须在视觉上分开呈现，不能混成一个数。

### 1.2 范围

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **P0** | DeepSeek 余额卡、本地账本卡、手动刷新 + 最后更新时间、Key 打码 + 测试连接、失败降级、实时/缓存/估算标记 | ✅ 已完成（0.1.0） |
| **P0.1** | 布局调整：顶部跨服务汇总条；卡片区只放官方余额；账本明细收进默认收起的折叠面板；页脚写明口径差异 | ✅ 已完成（0.1.1） |
| **P1** | MiniMax 订阅/余额卡、阿里云余额卡；接入后汇总条才覆盖全部服务；账本明细补「按会话」数据源（见 3.3 / 4.3） | ✅ 已完成（0.2.0；mock 测试，真实 API 未测） |
| **P2** | 自定义数据源（URL + 请求头 + JSON 取值路径）、余额阈值告警（卡片标红 + 可选系统通知） | ⏳ 未开始 |
| **P3** | 同一服务多 Key 的分别用量、导出 CSV | ⏳ 未开始 |

### 1.3 本次调整的结论（2026-11-11 讨论）

1. **本地账本不是冗余信息，但原来的摆法冗余了。**
   - DSH 右下角状态栏已经显示「今日消耗」，独立账本卡与它重复；
   - 账本真正不可替代的价值是**跨服务汇总**和**按会话/模型拆分**，P0 只有 DeepSeek 时体现不出来。
2. **布局调整（P0.1）**：
   - 顶部改为「跨服务汇总条」：本月合计、各服务本月消耗（账本口径，明确标「估算」）；
   - 卡片区只放各服务的**官方余额**（DeepSeek 用余额接口）；
   - 账本明细（7 天趋势 / 按模型 / 按会话）收进折叠面板，**默认收起**；
   - 页脚说明口径：官方余额 = 还剩多少钱；账本 = 钱花在哪，两者可能不一致。
3. **优先级**：P0.1 先做布局；P1 接入 MiniMax / 阿里云后，汇总条才完整。

### 1.4 硬约束

- Key 只在 Host 端使用；不明文进仓库；页面只拿掩码。
- 单接口超时 ≤ 5 秒；失败只影响对应卡片。
- 插件加载失败或接口不可达不得影响 DSH 启动。
- 每张卡 / 每个数字标明来源（实时 / 缓存 / 估算）。
- **不改动本工作区其他插件；不安装插件；不修改 profile。**
- 不伪造数据：账本没有的维度（例如会话）不编造，明确写「数据源待接入」。

---

## 2. 数据源与口径

| 数据 | 来源 | 口径 | 标记 |
| --- | --- | --- | --- |
| DeepSeek 余额 | `GET https://api.deepseek.com/user/balance` | 官方账户余额（总额 / 赠金 / 充值） | 实时 / 缓存 |
| 各服务本月消耗、本月调用 | 本机账本 `days[YYYY-MM-DD][provider][model]` 汇总 | DSH 本机调用花费，不一定等于 API 账户的实际扣费 | 估算 |
| 7 天趋势 | 本机账本近 7 天按天汇总 | 同上 | 估算 |
| 按模型 | 本机账本 `provider + model` 本月汇总 | 同上 | 估算 |
| 按会话 | **无现成数据源**：账本 v1 只按 天/服务/模型 汇总，不含会话维度 | 需要读取会话日志（`.jsonl.zstd`）并重新定价，列为 P1 | 未开始 |

> 注：DSH 右下角的「今日消耗」是**会话/状态栏口径**，与本机账本的「今日」可能因统计时点不同而略有差异；本页面以账本文件为准，并标「估算」。

---

## 3. 各阶段验收标准

### 3.1 P0（已完成，保留验收记录）

| # | 验收项 | 状态 |
| --- | --- | --- |
| 1 | 配置 Key 后 DeepSeek 余额与官方后台一致 | ⏳ 待安装 + 真实 Key 联调 |
| 2 | 账本今日/本月与 DSH 状态栏一致 | ⏳ 账本数字已核对；状态栏交叉验证待装 |
| 3 | Key 打码、测试连接可用 | ✅ 打码/接口已测；真实 Key 联调待装 |
| 4 | 断网时错误状态，DSH 不崩溃不卡死 | ✅ 离线用例覆盖 |
| 5 | 刷新不阻塞界面（有加载态） | ✅ 骨架屏 + 刷新中按钮 |
| 6 | 每张卡有更新时间与来源标记 | ✅ |
| 7 | README 写清权限、已核实/未核实 | ✅ |

### 3.2 P0.1（已完成）

| # | 验收项 | 状态 |
| --- | --- | --- |
| A1 | 顶部汇总条显示「本月合计」+ 各服务本月消耗，全部标「估算」 | ✅ 已完成（Host 快照 + 离线用例 + 预览） |
| A2 | 卡片区只保留官方余额卡；卡上不再重复「今日/本月消耗」和迷你趋势 | ✅ 已完成 |
| A3 | 账本明细为折叠面板，默认收起；展开后含 7 天趋势、按模型、按会话说明 | ✅ 已完成（按会话为数据源缺口说明） |
| A4 | 页脚写明「官方余额 = 还剩多少钱；账本 = 钱花在哪，二者可能不一致」 | ✅ 已完成 |
| A5 | 账本缺失/读失败时，汇总条与折叠面板显式提示，不显示 0 假数据 | ✅ 已完成（缺失 + 读到一半的缓存回退） |
| A6 | Key 打码、测试连接、超时降级等 P0 行为不回归 | ✅ 已完成（全量用例通过） |
| A7 | 测试用例更新并全绿（Host + Client） | ✅ Host 50 / Client 27 |

### 3.3 P1（已完成，真实 API 未测）

> 设计日期：2026-11-11。以下用例先于实现写入；通过/失败标准必须可判真假。
> **真实 API 调用需要 MiniMax 订阅 Key / 阿里云 RAM AccessKey。未提供前，真实调用一律标「未测」；mock 测试通过不得写成真实接口已验证。**

#### P1-a MiniMax 订阅额度

数据源：`GET {base}/v1/token_plan/remains`，`Authorization: Bearer <订阅 Key>`。
区域：CN `https://www.minimax.cn`；Global `https://www.minimax.io`（可配置）。
字段语义：按需求文档，`/v1/token_plan/remains` 的 `current_interval_usage_count` 按**已用**解释；若响应提供 `current_interval_remaining_percent` / `current_weekly_remaining_percent`，优先采用「剩余百分比」；同时保留原始 used/total 供界面核对，避免语义再变时静默反转。周窗口字段：`current_weekly_total_count` / `current_weekly_usage_count` / `weekly_end_time` / `weekly_remains_time`。
展示：主数字 = 当前 5 小时窗口剩余百分比（无百分比且 total>0 时 `100 - used/total`）；行 = 5h 已用/总量 + 重置时间、周窗口剩余%、套餐名；按量 Key/无订阅以错误态说明，不显示假 0。

离线测试（mock fetch，不联网）：

| ID | 测什么 | 通过标准 |
| --- | --- | --- |
| MM-1 | 解析完整响应（2 个 model，5h total=1000 used=380，weekly total=10000 used=6200，end_time 固定） | 5h 剩余 62%，周剩余 38%；used/total/重置时间逐项相等 |
| MM-2 | 只有 `*_remaining_percent`、没有 count | 直接采用 73%/51%，不自行反推 |
| MM-3 | `base_resp.status_code=1004`（auth 类）/ 含 plan/subscription 文案 / `model_remains=[]` | 分别映射 `minimax-auth` / `minimax-no-plan` / `minimax-empty` |
| MM-4 | fetch 永久不返回 | 5 秒内抛 `timeout`，卡片错误，不影响其它卡 |
| MM-5 | 区域配置 cn/global | 请求 URL 分别为 `https://www.minimax.cn/...`、`https://www.minimax.io/...`；带 Bearer |
| MM-6 | 打码与泄漏 | 快照只有 `mm-…tail` 形式掩码；明文 Key 不出现在快照/错误/日志 |
| MM-7 | total=0 / 缺字段 | 不产生 `NaN`；显示「未提供额度」而不是 0% |

失败判定：任一 NaN、status_code≠0 被当成功、明文 Key 出现、请求超过 5 秒未降级。
未测：真实订阅 Key 调用、真实重置时间。

#### P1-b 阿里云余额

数据源：BSS OpenAPI `QueryAccountBalance`（Version `2017-12-14`），endpoint 默认 `business.aliyuncs.com`；RAM 子账号 + 权限 `bss:DescribeAcccount`。
签名：RPC HMAC-SHA1；公共参数 `Action/Version/Format=JSON/SignatureMethod=HMAC-SHA1/SignatureVersion=1.0/SignatureNonce/Timestamp/AccessKeyId`；`StringToSign = GET&%2F&` + percentEncode(按 key 排序的 query)；`Signature = Base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign))`。
展示：主数字 = `Data.AvailableAmount` + `Data.Currency`；行 = 现金余额 `AvailableCashAmount`、信控额度 `CreditAmount`、网商信用 `MybankCreditAmount`；失败态明确。

离线测试（mock fetch，不联网）：

| ID | 测什么 | 通过标准 |
| --- | --- | --- |
| AL-1 | 固定 AccessKeyId/Secret/nonce/timestamp 的签名已知答案 | canonical query 与 HMAC-SHA1 签名与测试内独立计算值逐字符相等 |
| AL-2 | 请求内容 | 含 Action/Version/Signature/Timestamp/SignatureNonce；AccessKeySecret 不出现在 URL/headers；签名用 `&` 结尾的密钥 |
| AL-3 | 解析官方示例 | AvailableAmount=10000.00、AvailableCashAmount=10000.00、CreditAmount=0.00、Currency=CNY；Success/Code 正确 |
| AL-4 | 错误映射 | `InvalidAccessKeyId.NotFound`→`aliyun-auth`；`SignatureDoesNotMatch`→`aliyun-signature`；`NoPermission/NotAuthorized`→`aliyun-permission`；HTTP 5xx→`server-error`；超时→`timeout` |
| AL-5 | 打码与泄漏 | AccessKeyId 掩码（`LTAI…tail`）；Secret 不出现在快照/错误/日志 |
| AL-6 | endpoint 配置 | 默认 `business.aliyuncs.com`，始终 https；非法值回退默认 |

失败判定：签名不匹配却成功、明文 Secret 出现、`Success=false` 被渲染成余额、超过 5 秒未降级。
未测：真实 RAM AccessKey 调用、余额与阿里云控制台一致性。

#### P1-c 按会话统计

数据源：`~/.dsh/sessions/**/session.v4.jsonl.zstd`。实测格式：文件由多个 zstd 帧拼接，每帧一条 JSON 事件；使用 `session`（id/cwd/createdAt）、`session/title`（data.title）、`assistant/message`（data.usage、data.message.source.model、顶层 time）。
定价：内置 DeepSeek CNY 价表（2026-10-08 版；官方页面 2026-11-11 复核 peak 窗口 01:00–04:00 / 06:00–10:00 UTC 工作日，其余半价；中国节假日不建模，标「估算」）。模型别名 `deepseek-chat`/`deepseek-reasoner`/`deepseek-v4-flash*` → `deepseek-flash`；未知模型不计价并计入 `unpricedCalls`。
聚合：只统计**当前自然月**的事件；同一 `(turn, step)` 多次 usage 以最后一次为准（重试不重复计费）；按 session 汇总 cost/calls/tokens/unpricedCalls/lastAt；返回 top 20，title 缺失时用短 id。**不返回 prompt/content/text**。
性能：只扫描 mtime ≥ 本月 1 日的日志；结果缓存 60 秒；展开「按会话」时异步加载，不阻塞首屏。

离线测试（fixture 日志，测试内生成多帧 zstd）：

| ID | 测什么 | 通过标准 |
| --- | --- | --- |
| SS-1 | 2 个 session、已知 peak/off-peak usage | 每个 session 的 cost 与测试内独立公式误差 ≤1e-9；calls/tokens 精确 |
| SS-2 | 同一 (turn,step) 两条 usage（重试） | 只计最后一条，不重复计费 |
| SS-3 | 跨月事件 | 只计本月事件；上月事件不计入 |
| SS-4 | 未知模型 | cost 不含它；`unpricedCalls` +1；不编造价格 |
| SS-5 | 损坏/空/非 zstd 文件 | 跳过并计数 `skipped`，接口仍 200 |
| SS-6 | 隐私 | 响应 JSON 不含 `content`/`prompt`/`text` 字段；只有 id/title/数字 |
| SS-7 | 缓存 | TTL 内第二次调用不重复读文件；过期后重扫（用读次数探针） |
| SS-8 | 性能 | 50 个 fixture session / 500 条消息 < 2000 ms |
| SS-9 | UI | 折叠面板展开才加载；loading / 空 / 错误 / top 列表四种状态可见 |

失败判定：cost 误差 >1e-6、响应含会话正文、fixture 扫描 >2 秒、重试重复计费。
未测：真实全量会话扫描耗时与准确性（需真机装后观察；不需要 Key）。

#### P1-d 集成与回归

| ID | 测什么 | 通过标准 |
| --- | --- | --- |
| IN-1 | 三张卡并存 | 快照含 DeepSeek/MiniMax/阿里云；任一 provider 超时只影响该卡 |
| IN-2 | 凭据迁移 | 旧 v1 `deepseek.apiKey` 继续可用；保存 MiniMax/阿里云不覆盖 DeepSeek；单独清除互不影响 |
| IN-3 | 汇总条 | 账本里出现的 MiniMax/阿里云 provider 显示为对应服务名；未配置服务不产生假消耗 |
| IN-4 | 回归 | P0/P0.1 全部用例继续通过；5 秒超时、打码、失败降级不回归 |
| IN-5 | 安全 | 提交前 `check:secrets` 通过；凭据/缓存文件被 `.gitignore` 排除 |

**实现与验收回填（2026-11-11，v0.2.0）**：

| 用例组 | 结果 | 备注 |
| --- | --- | --- |
| MM-1…MM-7 | ✅ 全部通过 | 真实 MiniMax 订阅 Key 调用 **未测** |
| AL-1…AL-7 | ✅ 全部通过（含固定向量的 HMAC-SHA1 签名已知答案） | 真实 RAM AccessKey 调用 **未测** |
| SS-1…SS-9 | ✅ 全部通过 | fixture 50 会话扫描 <2s；真实全量日志 **未测** |
| IN-1…IN-5 | ✅ 全部通过 | 三卡隔离、v1 凭据迁移、服务隔离、提交前密钥扫描 |
| 回归 | ✅ Host 50 + P1 29 + Client 27 = 106 全绿 | `npm test` |

真实接口调用：**未测**（缺 MiniMax 订阅 Key / 阿里云 RAM AccessKey / DeepSeek 真实网络环境）。

### 3.4 P2 / P3（未开始）

- P2：自定义数据源（URL + 请求头 + JSON 路径）、余额阈值告警；
- P3：多 Key 分别统计、导出 CSV。

---

## 4. 任务清单与状态

### 4.1 已完成（P0）

| ID | 任务 | 状态 |
| --- | --- | --- |
| P0-1 | 插件骨架（package / patch / icon / README） | ✅ 已完成 |
| P0-2 | Host：设置与凭据、打码、原子写 | ✅ 已完成 |
| P0-3 | Host：DeepSeek 余额接口 + 5 秒超时 | ✅ 已完成 |
| P0-4 | Host：账本读取与今日/本月/7 天汇总 | ✅ 已完成 |
| P0-5 | Host：路由围栏、缓存、失败降级、测试连接 | ✅ 已完成 |
| P0-6 | Client：侧边栏入口 + 主面板 + 两张卡 + 配置表单 | ✅ 已完成 |
| P0-7 | 离线测试（Host 50 / Client 23） | ✅ 已完成 |
| P0-8 | 视觉预览与截图 | ✅ 已完成 |

### 4.2 已完成（P0.1）

| ID | 任务 | 状态 | 备注 |
| --- | --- | --- | --- |
| P0.1-1 | 文档先行：本 PLAN.md（目标/范围/验收/状态/变更记录） | ✅ 已完成 | 先于代码 |
| P0.1-2 | Host：快照新增「各服务本月消耗」「按模型」数据 | ✅ 已完成 | 复用账本，不改账本文件 |
| P0.1-3 | Client：顶部跨服务汇总条（本月合计 + 各服务，标估算） | ✅ 已完成 | |
| P0.1-4 | Client：卡片区改为只放官方余额（DeepSeek 卡去掉消耗/趋势） | ✅ 已完成 | |
| P0.1-5 | Client：账本明细折叠面板（默认收起；7 天 / 按模型 / 按会话说明） | ✅ 已完成 | 按会话为「数据源待接入」说明，不伪造 |
| P0.1-6 | Client：页脚口径说明 | ✅ 已完成 | |
| P0.1-7 | 更新测试、README、预览截图 | ✅ 已完成 | Host 50 / Client 27；预览 6 种状态 |
| P0.1-8 | 回填本计划状态、验收与变更记录 | ✅ 已完成 | 本次 |

### 4.3 已完成（P1）

| ID | 任务 | 阶段 | 状态 |
| --- | --- | --- | --- |
| P1-0 | P1 测试设计与可判定验收标准（写入 3.3） | P1 | ✅ 已完成（2026-11-11，先于代码） |
| P1-1 | MiniMax 订阅额度卡（`token_plan/remains`，注意「已用」语义） | P1 | ✅ 已完成（0.2.0；真实 Key 未测） |
| P1-2 | MiniMax 按量余额（无公开接口，走错误说明；自定义数据源在 P2） | P1 | ✅ 已完成（说明 + 错误映射；接口仍不存在） |
| P1-3 | 按会话统计（会话日志多帧 zstd + 内置定价） | P1 | ✅ 已完成（fixture 全绿；真实全量未测） |
| P1-4 | 阿里云 BSS `QueryAccountBalance`（RAM 子账号 + HMAC-SHA1 签名） | P1 | ✅ 已完成（签名/解析 mock 全绿；真实 RAM 未测） |

### 4.4 未开始

| ID | 任务 | 阶段 | 状态 |
| --- | --- | --- | --- |
| P2-1 | 自定义数据源 | P2 | ⏳ 未开始 |
| P2-2 | 余额阈值告警 | P2 | ⏳ 未开始 |
| P3-1 | 多 Key 分别统计 | P3 | ⏳ 未开始 |
| P3-2 | 导出 CSV | P3 | ⏳ 未开始 |

---

## 5. 变更记录

### 2026-11-11 · v0.1.0（P0 初版）

- 新建插件：`dsh-usage-panel`，Host + 浏览器两半，侧边栏「用量」页面。
- 实现 DeepSeek 余额卡 + 本地账本卡、手动刷新、Key 打码、测试连接、5 秒超时、缓存与失败降级。
- 离线测试：Host 50 / Client 23；本地 Chrome 预览截图。
- 未安装、未使用真实 Key 调接口。

### 2026-11-11 · P1 测试设计（已回填，见 v0.2.0）

- 先于代码写入 3.3：MiniMax（MM-1…MM-7）、阿里云（AL-1…AL-6）、按会话（SS-1…SS-9）、集成（IN-1…IN-5）。
- 已核实：MiniMax Token Plan 端点与字段（含 count/percent 两种语义，采用「已用」并按剩余百分比兜底）；阿里云 QueryAccountBalance 返回字段与 RPC HMAC-SHA1 公共参数；会话日志为多帧 zstd（每帧一条事件）。
- 真实 API 调用仍标「未测」，等用户提供 MiniMax 订阅 Key / 阿里云 RAM AccessKey；实现完成后统一在 P1 验收表回填。


### 2026-11-11 · v0.1.1（P0.1 布局调整，本次）

**需求变更**（用户确认）：

1. 账本卡不再与官方余额卡并列：DSH 状态栏已有「今日消耗」，独立账本卡重复。
2. 顶部改为跨服务汇总条：本月合计 + 各服务本月消耗（账本口径，标「估算」）。
3. 卡片区只放官方余额。
4. 账本明细（7 天趋势 / 按模型 / 按会话）收进折叠面板，默认收起。
5. 页脚说明「官方余额 = 还剩多少钱；账本 = 钱花在哪，两者可能不一致」。
6. 优先级：P0.1 布局优先，P1 接入 MiniMax/阿里云后汇总条才完整。
7. 按会话暂无数据源：账本只到「天/服务/模型」，P0.1 在折叠面板中以说明占位，P1-3 再接入会话日志。

**流程约定**：此后改代码前先更新本计划（状态/验收/变更记录），代码与 README 跟随本计划。

**完成情况（同日回填）**：

- 版本 0.1.1，`package.json` 已升版。
- Host：`lib/ledger.js` 新增按模型汇总与 provider 展示名；`lib/index.js` 快照改为 `cards=[余额卡]` + `summary.servicesSpend/ledgerState/ledgerUpdatedAt` + `ledger.models`，余额卡不再带消耗字段。
- Client：`lib/client.js` 改为「汇总条 + 官方余额区 + 折叠账本明细 + 页脚口径」；明细默认收起，展开含 7 天趋势、按模型、按会话说明；账本缺失/陈旧均有显式提示。
- 测试：Host 50/50、Client 27/27 通过（`npm test`）。
- 文档：README 同步 P0.1；新增预览截图 `docs/panel-details.png`；预览支持 `&details=1`。
- 预览：用真实账本 + 示例余额截图验证 `live / cached / unconfigured / error / no-ledger / details` 六种状态。
- 未做（按约定）：未安装插件、未修改 profile、未用真实 Key 调接口。

### 2026-11-11 · v0.2.0（P1 完成）

**实现**：

- 多服务 Engine：`SERVICES=[deepseek,minimax,aliyun]`，每服务独立缓存/attempt/inflight；任一失败不影响其它卡。
- 凭据 v2：`{deepseek:{apiKey}, minimax:{apiKey}, aliyun:{accessKeyId,accessKeySecret}}`，v1 文档兼容；按服务保存/清除不互相覆盖。
- MiniMax：`token_plan/remains` 适配器；cn/global 区域；base_resp 错误映射；`usage_count` 按「已用」、显式 remaining_percent 优先；按量 Key 显示专门说明。
- 阿里云：RPC HMAC-SHA1 签名（固定向量测试）、`QueryAccountBalance` 解析、RAM 权限/签名错误映射、endpoint 规范化。
- 按会话：多帧 zstd 解析；`session/title` + `assistant/message`（usage + model + time）；按本月过滤、(turn,step) 重试去重、内置 DeepSeek CNY 价表（peak 01–04/06–10 UTC 工作日，其余半价，节假日未建模）；只返回标题/数字，不返回正文。
- Client：三张服务卡、按服务配置页签、会话表懒加载（展开明细才扫描）、各服务独立测试连接。
- 安全：提交前 `check:secrets` 扫描暂存区；凭据/缓存被 `.gitignore` 排除。

**测试**：Host 50/50、P1 29/29、Client 27/27，共 106 条通过（`npm test`）。

**真实接口**：DeepSeek / MiniMax / 阿里云 的真实调用均 **未测**（缺真实 Key 与真机环境）；会话全量扫描 **未测**（仅 fixture）。

**文档/预览**：README 同步；截图 `panel-live/details/error/unconfigured/config/cached`；预览支持 `&details=1`、`&panel=config`。

**约束遵守**：未安装插件、未修改 profile、未动其它插件。
