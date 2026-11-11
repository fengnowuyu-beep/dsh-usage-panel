# dsh-usage-panel · 服务余额与用量面板

DSH 桌面端（DeepSeek Harness）的侧边栏页面，把两件事分开摆清楚：**各服务官方余额还剩多少**，以及**本机 DSH 这个月钱花在哪**（账本口径，标「估算」）。手动刷新、Key 打码、单卡失败降级。

> 当前版本 **0.1.1（P0 + P0.1）**。
> P0.1 布局：顶部跨服务汇总条；卡片区只放官方余额；账本明细收进默认收起的折叠面板；页脚写明两种口径的差异。
> 开发计划、优先级与状态以 **[PLAN.md](PLAN.md)** 为准（本文档跟随计划）。MiniMax / 阿里云 / 告警 / 多 Key / CSV 仍未实现。

![实时状态](docs/panel-live.png)

另有 [账本明细展开](docs/panel-details.png)、[缓存状态](docs/panel-cached.png)、[未配置状态](docs/panel-unconfigured.png) 三张截图。

---

## 一、做了什么

| 能力 | 说明 |
| --- | --- |
| 侧边栏入口 | 侧边栏新增「用量」行（图标 + 文字），点开是全局面板；不占用会话页面 |
| 跨服务汇总条 | 「本月合计（账本口径）」+ 各服务本月消耗（如 DeepSeek / MiniMax），全部标 **估算**；右侧显示账本更新时间 |
| DeepSeek 余额卡 | `GET https://api.deepseek.com/user/balance`，**只显示官方余额**（总额 / 赠金 / 充值），多币种时主数字取 CNY，其余币种单列 |
| 账本明细（折叠） | 默认收起；展开后显示近 7 天趋势、按模型（provider + model）本月消耗与调用、按会话说明、账本文件与写入时间 |
| 手动刷新 | 页头「刷新」按钮；初次打开先渲染快照，再在后台补一次刷新（有加载态，不阻塞界面） |
| Key 打码 | 页面只收到 `sk-…3f2a` 形式的掩码；明文只在 Host 端使用，接口不返回明文 |
| 测试连接 | 走真实请求，显示耗时 / 余额 / 失败原因；不复用缓存 |
| 失败降级 | 5 秒超时 + 单卡错误态；有上次成功结果时显示缓存数据并标「数据可能过期」；DSH 启动不受影响 |
| 数据来源标记 | 余额卡右上角标 **实时 / 缓存 / 异常**；账本推算出来的消耗标 **估算** |
| 配置页 | 面板内联配置表单（不弹窗）：API Key、API 根地址、保存、清除 Key |

页面组成（P0.1，官方余额与账本分开）：

```
服务余额与用量                                       更新于 20:51  [刷新]
本月合计（账本口径） ¥192.49 [估算]  [DeepSeek ¥192.49 估算]   账本更新于 20:51
官方余额  来自各服务官方接口，来源标记见卡片右下角
┌──────────────────────────────┐
│ ● DeepSeek           [实时]   │
│ ¥110.00                      │
│ 赠金 ¥10.00   充值 ¥100.00    │
│ 数据时间 20:51 · 实时          │
│ sk-…3f2a  测试连接  去配置     │
└──────────────────────────────┘
账本明细  本月 ¥192.49 · 15,441 次调用                    展开 ▾
（展开后：近 7 天趋势 / 按模型 / 按会话说明 / 账本文件）
官方余额 = 还剩多少钱；本机账本 = 钱花在哪。两者口径不同，可能不一致。
```

---

## 二、安装

**当前会话没有替你安装**（安装会改 profile，需要你确认）。两种方式二选一：

### 方式 A：插件管理器

DSH → 设置 → 插件 → 安装，填入本目录：

```
E:/Data/Project/DeepSeekHarness/DSH-Homemade-Plugins/dsh-usage-panel
```

### 方式 B：手工登记（与本工作区其它自用插件一致）

在 `~/.dsh/profiles/desktop/package.json` 里加依赖与 bundle：

```jsonc
{
  "dependencies": {
    "dsh-usage-panel": "file:E:/Data/Project/DeepSeekHarness/DSH-Homemade-Plugins/dsh-usage-panel"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …已有条目…
        "dsh-usage-panel"
      ]
    }
  }
}
```

然后在 profile 目录执行：

```powershell
cd $HOME\.dsh\profiles\desktop
pnpm install
```

安装后需要重启 DSH（Loader 会缓存已加载的模块）。重启后左侧栏应出现「用量」；没有的话看 DSH 日志里有没有 `usage-panel:` 开头的行。

---

## 三、配置 DeepSeek Key（一步一步）

1. 打开侧边栏 **用量**。
2. DeepSeek 卡显示「未配置 DeepSeek Key」时，点 **去配置**（或卡片右下角的「去配置」）。
3. 在 **API Key** 粘贴 Key（`sk-` 开头，DeepSeek 开放平台 → API keys 里创建）。
4. **API 根地址** 保持 `https://api.deepseek.com`；只有走代理/网关时才改。
5. 点 **保存**。保存成功后输入框会清空，占位符变成「已保存 sk-…xxxx，留空保持不变」。
6. 点卡片上的 **测试连接**：成功显示「连接正常 · 128 ms · 余额 ¥…」；失败会显示具体原因（Key 无效 / 超时 / 无法连接等）。

### Key 存在哪

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `~/.dsh/usage-panel/credentials.json` | DeepSeek Key（明文，但只在 Host 端读） | 创建时 `0600`（Windows 上 `chmod` 是尽力而为，实际受用户目录 ACL 保护） |
| `~/.dsh/usage-panel/settings.json` | 非密配置：baseUrl / timeoutMs / currency | 同上 |
| `~/.dsh/usage-panel/balance-cache.json` | 上次成功的余额（不含 Key，只有 Key 指纹） | 同上 |

**不使用** DSH 自己的 `~/.dsh/.credentials.yaml`：那是 Harness 的凭据库，插件不去碰它。仓库里也没有任何 Key；`examples/` 里只有占位示例。

### 备选：环境变量

Host 进程若能看到 `DEEPSEEK_API_KEY`，也可以不落盘：

```powershell
[Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', 'sk-…', 'User')
```

重启 DSH 后生效。注意桌面端从资源管理器启动时不继承临时 shell 的环境变量，建议用「用户级」变量并重启应用。环境变量提供的 Key 不能在页面里「清除」（接口会返回 `key-from-env`）。

### 手动写配置文件（可选）

```powershell
# settings.json
Copy-Item examples\settings.example.json "$HOME\.dsh\usage-panel\settings.json"

# credentials.json（把占位 Key 换成真的）
Copy-Item examples\credentials.example.json "$HOME\.dsh\usage-panel\credentials.json"
```

字段说明见 [`examples/settings.example.json`](examples/settings.example.json) 与 [`examples/credentials.example.json`](examples/credentials.example.json)。`timeoutMs` 会被夹在 **1000–5000** 之间，超过 5 秒的配置不生效——这是需求里的硬约束。

---

## 四、接口与数据来源核实

| 数据源 | 状态 | 结论 |
| --- | --- | --- |
| DeepSeek 余额 | ✅ **已核实**（2026-11-11 对照官网） | `GET /user/balance`，`Authorization: Bearer <key>`；返回 `is_available` 与 `balance_infos[]`，金额字段是**字符串**；`currency` 可能为 `CNY`/`USD`。文档：<https://api-docs.deepseek.com/api/get-user-balance> |
| 本机 DSH 账本 | ✅ **已核实（本机实际文件）** | `~/.dsh/dsh-usage/usage-ledger.json`，`version: 1`，`days[YYYY-MM-DD][provider][model]` 下有 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens/calls/cost`。插件只读，不重算价格。 |
| MiniMax | ⚠️ 部分核实，**P0 未实现** | 订阅额度接口 `GET https://www.minimax.cn/v1/token_plan/remains` 社区资料称字段语义为 `current_interval_usage_count = 已用`（不是剩余）；按量余额没有公开接口；订阅 Key 与按量 Key（`sk-cp-*`）是两个体系。上 P1 前需要再用真实 Key 核一遍。 |
| 阿里云 BSS | ✅ 接口形态已知，**P0 未实现** | `QueryAccountBalance`（2017-12-14，RPC 签名，无请求参数）；需 RAM 子账号 + `bss:DescribeAcccount`；不要用主账号 AK。上 P1 时再实现。 |

### 没有伪造数据的三个地方

1. **DeepSeek 余额**只来自官方接口；没有配置 Key 时显示「未配置」，不显示 `¥0.00`。
2. **本月合计 / 各服务本月消耗**只来自本机账本，全部标 **估算**；DeepSeek 余额卡不再重复消耗数字。余额接口本身不提供消耗，两种口径的差异在页脚写明。
3. **按会话**统计暂无可信数据源（账本只到「天 / 服务 / 模型」）。折叠面板里明确写「按会话统计需要另接会话日志（PLAN P1-3）」，不拿别的东西冒充。

---

## 五、降级与失败行为

| 情况 | 表现 |
| --- | --- |
| 未配置 Key | 卡片虚线边框 +「未配置 DeepSeek Key」+「去配置」；不显示 0 |
| 请求超时（>5 s） | 该卡红点 +「请求超时（5 秒）」；有旧数据则继续显示旧数据 |
| 401 / 403 | 「Key 无效或已过期」/「Key 没有读取余额的权限」 |
| 断网 / DNS 失败 | 「无法连接服务」；不影响其它卡，也不影响 DSH |
| 有上次成功结果 | 标「缓存」，展示旧余额 + 「上次刷新失败，显示的可能是过期数据」 |
| 账本文件不存在 | 汇总条显示「本月合计 不可用 / 账本文件未找到」；折叠面板可展开看路径；不显示 0 |
| 账本正好写到一半 | 汇总条标「缓存」并显示上次结果；明细面板提示「本次读取失败，显示上次结果」 |
| Host 路由不可用 | 整页错误态 +「重试」，不是白屏 |

所有网络请求都在 Host 端串行收口：**单请求 5 秒上限、不重试、不带 Key 进日志**。前端不做任何 provider 请求，因此没有 CORS，也没有把 Key 放进页面存储。

---

## 六、开发与验证

```powershell
cd E:\Data\Project\DeepSeekHarness\DSH-Homemade-Plugins\dsh-usage-panel

# 50 条离线用例：配置、余额解析、超时、账本汇总、缓存/降级、路由围栏
node test/host.test.mjs

# 27 条离线用例：模块契约、字典、两个 slot 注册、余额卡、汇总条、折叠明细、配置表单、页面挂载
node test/client.test.mjs

# 或者一起跑
npm test
```

测试不联网、不需要 Key：`fetch` 被替换成记录器，写入都落在临时 `DSH_HOME` 下。

### 本地预览（不安装插件也能看）

```powershell
node preview/server.mjs
# http://127.0.0.1:8791/?mode=live
```

`mode` 可选 `live | cached | unconfigured | error | no-ledger`；加 `&details=1` 直接展开账本明细，`&panel=config` 直接看配置表单。
预览里的 **DeepSeek 余额是示例数据**，账本数字来自本机真实账本；页面顶部有醒目提示。预览用 vendored React 17 UMD（`preview/vendor/`，仅预览用，插件本身运行在 DSH 自带的 React 上）。

### 目录结构

```
dsh-usage-panel/
├─ PLAN.md                 # 工作文档：范围、验收、状态、变更记录（以此为准）
├─ package.json            # dsh.bundle.patch + dsh.client（web）
├─ cordis.patch.yml        # 插入一条 Loader row：id = usage-panel
├─ icon.svg
├─ lib/
│  ├─ index.js             # Host：路由、缓存、降级、测试连接、汇总/明细快照
│  ├─ config.js            # 路径、设置、凭据、打码
│  ├─ deepseek.js          # GET /user/balance + 5 秒 deadline
│  ├─ ledger.js            # 账本读取、今日/本月/7 天、按模型汇总
│  └─ client.js            # 浏览器端：sidebar 入口 + 汇总条 + 余额卡 + 折叠明细
├─ test/                   # 离线用例（自带零依赖 harness）
├─ preview/                # 本地视觉预览（非插件运行时）
├─ examples/               # 配置样例（占位 Key）
└─ docs/                   # 截图
```

---

## 七、已知限制 / 未做

- **还没有在真机装过**：本会话按约定停在「需要你确认安装 / 提供 Key」这一步。Host/浏览器两半的离线契约、渲染、路由围栏都有测试；真实 DSH 页面与真实余额的联调待安装后进行。
- **P0.1 已完成布局调整**：汇总条 / 余额卡 / 折叠明细三层。P1 接入 MiniMax、阿里云后，汇总条与卡片区才会覆盖全部服务。
- **「按会话」没有数据源**：账本只按「天 / 服务 / 模型」汇总；折叠面板里明确说明需要另接会话日志（PLAN P1-3），尚未实现。
- **P1/P2 未做**：MiniMax、阿里云、30 天趋势图、按服务占比、自定义数据源、余额告警。
- **P3 未做**：多 Key 细分、导出 CSV。当前一个服务一把 Key。
- **消耗只来自账本**：余额接口不提供消耗；汇总条与明细里的金额都是本机账本口径，标「估算」，与官方账户实际扣费可能有差异。
- **账本里的 `cost` 为 0 的旧日期**：插件如实显示 0，不按价格表补算（避免与 DSH 状态栏口径不一致）。
- **Windows 文件权限**：`chmod 0600` 在 Windows 上不改变 ACL 语义，凭据文件实际由用户目录与 NTFS ACL 保护；如果多人共用这台机器，建议改用环境变量或专门的凭据管理。
- **预览与生产的 React**：预览用 React 17 UMD；DSH 页面用的是自带的 React 运行时。插件只使用 `createElement` 和基础 hooks，两者兼容。

---

## 八、验收标准对照

### P0（保留记录）

| # | 验收项 | 状态 |
| --- | --- | --- |
| 1 | 配置 DeepSeek Key 后余额与官方后台一致 | ⏳ 待装 + 待 Key 联调；解析格式已按官网核对 |
| 2 | 账本今日/本月与 DSH 状态栏一致 | ⏳ 账本数字已与文件逐项核对；状态栏交叉验证待装 |
| 3 | Key 打码、测试连接可用 | ✅ 打码/接口已测；测试连接真实请求逻辑已测，真实 Key 联调待装 |
| 4 | 断网时错误状态、DSH 不崩溃不卡死 | ✅ 超时/网络错误/缓存回退均有离线用例；真实断网待装 |
| 5 | 刷新不阻塞界面（有加载态） | ✅ 骨架屏 + 刷新中按钮；先快照后后台刷新 |
| 6 | 每张卡有更新时间与来源标记 | ✅ 实时/缓存/异常 + 数据时间 |
| 7 | README 写清权限、已核实/未核实 | ✅ 见第四节、第七节 |

### P0.1（本次布局调整）

| # | 验收项 | 状态 |
| --- | --- | --- |
| A1 | 汇总条显示本月合计 + 各服务本月消耗，均标「估算」 | ✅ 离线用例 + 预览 |
| A2 | 卡片区只放官方余额；余额卡不再重复消耗/趋势 | ✅ 离线用例 + 预览 |
| A3 | 账本明细默认收起；展开含 7 天趋势、按模型、按会话说明 | ✅ 离线用例 + 预览 |
| A4 | 页脚写明两种口径的差异 | ✅ |
| A5 | 账本缺失/读失败显式提示，不显示 0 | ✅ 汇总条 + 折叠面板 |
| A6 | P0 的打码、测试连接、超时降级不回归 | ✅ 全量用例 |
| A7 | 测试更新并全绿 | ✅ Host 50 / Client 27 |
