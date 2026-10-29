# feishu-bridge

把 **OpenCode** 接入 **飞书 / Lark** 机器人。基于飞书 **长连接（WebSocket）**，无需公网 IP，支持流式卡片回复、独立会话目录、定时任务、文件互传、多机器人、会话迁移与心跳自愈。

> 技术栈：TypeScript + Node.js（>= 20）。底层通过 `@larksuiteoapi/node-sdk` 的 `LarkChannel` 收发飞书消息，通过 OpenCode V2 的 HTTP API 与事件流（SSE）驱动 AI。

---

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 文本 / 富媒体 / 卡片 | 普通文本、Markdown、图片、文件、交互卡片 |
| 流式输出 | AI 回复边生成边刷新到飞书卡片（cardkit 打字机或整卡刷新） |
| 群聊 + 私聊 | 私聊、群聊、@提及策略，均可 |
| 独立会话绑定 | 每个「机器人 × 会话」绑定一个 OpenCode session，本地持久化 |
| 会话目录隔离 | 每个会话独立工作目录，上下文互不干扰；群内可按用户再隔离 |
| 定时任务 | 配置文件 cron + 聊天内 `/cron` 运行时动态增删，持久化 |
| 文件传输 | 收到的图片/文件下载进会话 `inbox/`；AI 可通过标记主动发文件/截图 |
| 多机器人 | 每个机器人可配置不同 agent / 模型 / 工作目录 |
| 聊天内回答问题 | OpenCode 的 permission / form 渲染成飞书卡片，直接在聊天里作答 |
| 会话迁移 | `/export` 导出 JSON，`/import` 在另一设备/机器人接力 |
| 个性化技能 | 在飞书卡片里填「触发词 + 执行步骤 + 输出要求」，攒成自己的技能；命中后自动注入 prompt |
| 心跳监控 | 周期性健康检查，连续失败自动重启 OpenCode 服务并告警 |
| 操作日志 | 结构化运行日志 + 追加式审计日志（`audit.jsonl`） |

---

## 前置要求

1. **Node.js >= 20**
2. **OpenCode V2** 已安装并能作为共享服务运行：
   ```bash
   opencode --version          # 需要 v2.x
   opencode serve --service    # 启动/查看共享服务
   ```
   > 桥接默认以 `service` 模式通过 `@opencode/client` 自动发现/启动共享服务；也可用 `remote` 模式直连一个 `baseUrl`。
3. 一个**飞书企业自建应用**（见下一节）。

---

## 飞书应用配置

在[飞书开放平台](https://open.feishu.cn/app)创建**企业自建应用**后：

### 1. 凭证
在「凭证与基础信息」中拿到 **App ID** 与 **App Secret**，填入 `config/config.json`。

### 2. 开启长连接
「事件与回调 → 事件配置」选择 **使用长连接接收事件**（无需填写请求地址、无需公网 IP）。

### 3. 订阅事件
至少勾选：
- `im.message.receive_v1`（接收消息）
- 卡片回传交互：`card.action.trigger`（按钮回调）

### 4. 申请权限（Scopes）
按需最小化申请，常用如下：

- `im:message`、`im:message:send_as_bot`（收发消息）
- `im:message.group_at_msg:readonly`（群内 @ 消息）
- `im:resource`（上传/下载图片、文件）
- `im:chat:readonly`（读取群信息，可选）
- `im:message.p2p_msg:readonly`（私聊消息）

### 5. 发布版本
创建版本并发布，等待企业管理员审核通过后机器人才可用。

### 6. 把机器人拉进群 / 私聊
群聊中 @机器人 即可（默认 `requireMention: true`）。

---

## 安装与构建

```bash
cd feishu-bridge
npm install

# 生成配置文件
npm run init            # 从 config/config.example.json 复制到 config/config.json

# 只做配置与 OpenCode 连通性自检（不连飞书）
npm run doctor
```

`npm run doctor` 会读取配置、检查占位凭据，并对 OpenCode 做一次健康探测。

---

## 配置说明（`config/config.json`）

```jsonc
{
  "logLevel": "info",              // debug | info | warn | error
  "storageDir": "../data",         // 相对配置文件目录解析；存日志、绑定、cron
  "opencode": {
    "mode": "service",             // service=自动发现/启动共享服务；remote=直连 baseUrl
    "baseUrl": "http://127.0.0.1:4096",
    "password": "",                // service 模式可留空（从服务注册文件读取）
    "location": "D:/myapp/feishu-bridge",   // 会话默认工作目录根
    "dataDir": "../data/opencode", // 会话库(DB)目录；设置后桥启动专属服务，全部会话数据可随 data/ 整包迁移
    "servicePort": 0,              // 专属服务端口，0=自动分配（设置 dataDir 时生效）
    "env": {},                     // 可选：透传给专属服务的环境变量
    "serviceCommand": ["opencode", "serve", "--service"],
    "restartCommand": ["opencode", "service", "restart"],
    "healthIntervalMs": 30000,
    "healthTimeoutMs": 8000,
    "restartOnFailure": true,
    "failureThreshold": 3
  },
  "bots": [
    {
      "name": "assistant",
      "appId": "cli_xxxxxxxxxxxxxxxx",
      "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "domain": "feishu",          // feishu | lark
      "agent": "build",            // 新会话使用的 OpenCode agent
      "model": { "providerID": "myapi", "id": "deepseek-v4-free" },
      "location": "../data/workspaces",   // 会话工作目录根，建议放在 storageDir 下
      "project": "D:/path/to/opencode-project", // 可选：提供 .opencode agents/skills 的项目目录
      "perUserInGroup": false,      // true 时群内每个用户独立会话与目录
      "requireMention": true,       // 群聊需 @机器人
      "commands": true,             // 允许斜杠命令
      "streaming": {
        "strategy": "cardkit",     // cardkit=打字机 | patch=整卡刷新
        "intervalMs": 700,
        "showReasoning": false,
        "showTools": true
      },
      "access": {
        "allowChats": [],          // 群白名单，空=全部允许
        "allowUsers": [],          // 用户白名单，空=全部允许
        "alertChatId": ""          // 健康告警接收的会话 id
      }
    }
  ],
  "cron": [
    {
      "name": "daily-standup",
      "bot": "assistant",
      "schedule": "0 9 * * 1-5",
      "chatId": "oc_xxxxxxxxxxxxxxxx",
      "prompt": "请总结昨天的工作并给出今天的计划。",
      "enabled": false
    }
  ]
}
```

### 密钥可用环境变量覆盖（避免明文入库）

| 变量 | 作用 |
| --- | --- |
| `FEISHU_BRIDGE_CONFIG` | 配置文件路径 |
| `OPENCODE_PASSWORD` | OpenCode 共享服务密码 |
| `OPENCODE_BASE_URL` | `remote` 模式的服务地址 |
| `BOT_<NAME>_APP_ID` | 指定机器人的 App ID（NAME 大写，如 `BOT_ASSISTANT_APP_ID`） |
| `BOT_<NAME>_APP_SECRET` | 指定机器人的 App Secret |

---

## 运行

```bash
# 开发（热重载）
npm run dev

# 生产
npm run build
npm start

# 指定配置
npm run dev -- --config ./config/config.json
```

`--config` 或 `FEISHU_BRIDGE_CONFIG` 均可用。`data/` 下会生成：

```
data/
  bindings.json     # 会话绑定
  cron.json         # 运行时新增的定时任务
  logs/app-YYYY-MM-DD.log
  logs/audit.jsonl  # 审计日志（谁在何时做了什么）
  workspaces/       # 各会话的工作目录（bot.location 设在 data 下时）
  opencode/         # 会话库（opencode.dataDir 设在 data 下时）
    share/opencode/opencode.db
    state/opencode/service.json
```

### 会话数据存放在哪里

| 内容 | 位置 |
| --- | --- |
| 聊天 ↔ 会话绑定 | `data/bindings.json`（`storageDir`） |
| 每个会话的工作目录（文件、`inbox/`、`AGENTS.md`） | `<bot.location>/<bot 名>/<chatId[_userId]>/` |
| OpenCode 的会话库/历史/上下文 | `<opencode.dataDir>/share/opencode/opencode.db` |

**推荐把三者都收进 `data/`**（`bot.location` = `../data/workspaces`，`opencode.dataDir` = `../data/opencode`），这样整个 `data/` 就是自包含的：**迁移时直接拷贝 `data/` 即可带走全部会话、记忆与上下文**（agent 定义另见「接入已有 Agent 项目」）。配合 `bot.project` 让会话目录仍能解析项目里的 Agent/Skill。

给 `opencode.dataDir` 指定目录后，桥接会**启动一个专属的 OpenCode 服务**（`XDG_DATA_HOME`/`XDG_STATE_HOME` 指向该目录），机器人会话数据与全局 OpenCode 完全隔离：

```jsonc
"opencode": {
  "dataDir": "../data/opencode",  // 相对配置文件解析 → <项目>/data/opencode
  "servicePort": 0                // 0 = 自动选空闲端口，避免和共享服务端口冲突
}
```

目录结构：

```
data/opencode/
  share/opencode/opencode.db      # 会话库（session / message / 上下文）
  share/opencode/{log,snapshot,tool-output,shell,repos}/
  state/opencode/service.json     # 专属服务的注册文件（含端口与密码）
```

要点：
- 专属服务会启动自己的 `opencode serve`（`--port 0`），**不会**占用共享服务的端口；健康检查失败时会自动停止并重启它。
- **Provider / 模型配置仍读取全局 `XDG_CONFIG_HOME`**（如 `~/.config/opencode/opencode.json`），因此自定义 provider（如 `myapi`）照常可用。若某 provider 依赖全局认证（OAuth 等），请用 `opencode.env` 透传或改用 `remote` 模式。
- `dataDir` 设为相对路径时，相对**配置文件所在目录**解析。
- 未设置 `dataDir` 时行为不变（发现/复用共享服务，会话库落在全局 `~/.local/share/opencode`）。
- **跨机器迁移**：会话库里存的是绝对路径（`session.location.directory`），新机器路径保持一致即可无缝；换盘符/用户名需改路径。Windows 的 `.opencode` 链接不随拷贝走，但桥建会话时会按需重建。

---

## 聊天内命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 显示帮助卡片 |
| `/whoami` | 显示当前绑定的会话、目录、agent、模型 |
| `/new`、`/reset` | 重置并新建会话 |
| `/sessions` | 列出该机器人已绑定的会话 |
| `/agent <name>` | 切换 OpenCode agent |
| `/model providerID/modelID` | 切换模型（也支持 `:` 分隔） |
| `/stop` | 中断当前执行 |
| `/export` | 导出当前会话 JSON 并作为文件发回 |
| `/import` | 附带导出 JSON 文件发送，导入会话并绑定 |
| `/answer <formId?> key=value ...` | 回答 AI 的提问（卡片不可用时兜底） |
| `/cron list` | 列出定时任务 |
| `/cron add <名称> <分 时 日 月 周> <提示词>` | 新增定时任务（按当前会话/机器人） |
| `/cron remove <名称>` / `/cron run <名称>` | 删除 / 立即触发 |
| `/skills` | 打开「我的技能」管理卡片（也可直接发「技能」） |
| `/skill new` | 打开新建技能表单 |
| `/skill use <名称>` | 立刻按这条技能跑一次（等同卡片上的「试用」） |
| `/skill show <名称>` / `/skill del <名称>` | 查看详情 / 删除 |
| `/skill share <名称>` | 升级为全员共享（仅管理员） |

---

## 个性化技能

用户在聊天里攒出来的工作方法：用卡片填**名称 → 触发词 → 执行步骤 → 输出要求**，保存后
聊天里出现触发词时自动套用；也可以「用XX技能」显式点名，或点卡片上的「试用」先看效果。

```text
发「技能」→ 我的技能卡 → 新建技能
  技能名称：竞品周报
  触发词：  竞品周报 对手动态
  执行步骤：1. 只取最近 7 天动态，来源优先官网与行业媒体；2. 按产品/价格/渠道三段对比；
            3. 结论不超过 5 条，每条一句话；4. 不确定的标「待核实」，不要编数字。
  输出要求：Markdown 表格 + 结论，500 字以内
```

**生效方式**：桥接侧技能库 + 命中注入。消息命中触发词时，桥接把技能正文作为
`【个性化技能：…】` 段落附在用户消息末尾一起发给 OpenCode，并在这个回合的卡片标题前加
`🧩 技能名`。因此：

- 技能存在 `<storageDir>/skills/<openId>/`，**只对创建者生效**；共享技能在 `skills/_shared/`。
- 不写进 OpenCode 项目：OpenCode 只在项目根发现技能，做不到"每人一个技能目录"，所以
  没有走原生 `skill` 工具，而是命中后注入 prompt。
- 创建即生效，无需重启桥接、无需改 agent 定义。
- 不命中任何技能时，行为与原来完全一致。

**共享给全员**：管理员（`templateAdmins` 里的 openId，发 `/whoami` 可看到自己的 openId）
新建时可选「共享给全员」，或用 `/skill share <名称>` 升级。共享技能对所有使用这个机器人的
会话生效；非管理员建的技能一律只有自己能用。

**限额**：名称 2–24 字；触发词 1–8 个、每个 2–20 字；执行步骤 ≤ 4000 字；单轮最多命中 2 条技能
（按触发词长度取更具体的）。

> 共享技能相当于给全员下发一段指令，所以只有管理员能创建。技能正文是用户可写的内容，
> 注入后模型会当指令执行——开放给全员共享前请先自己过一眼。

---

## 文件与多模态

### 接收（飞书 → OpenCode）
用户发送的图片 / 文件会被下载到该会话目录的 `inbox/`，并以 `file:///绝对路径` 作为 OpenCode prompt 的附件提交。文本、PNG/JPEG/GIF/WebP 图片对模型可见（单文件上限 20 MiB）。

**只发文件、没配文字时**：默认不会立刻让 Agent 开跑，而是先回一句「已收到，请说明要做什么」，把文件**暂存**起来，等你的下一句话再把它们作为附件一起交给 Agent（`holdAttachmentsWithoutText: true`，默认）。若希望收到文件就自动让 Agent 处理，设为 `false`。

### 发送（OpenCode → 飞书）
桥接会在每个会话目录写入一段 `AGENTS.md` 指令块，告知模型：需要发文件时，在回复正文中单独一行输出：

```
[[send-file: /绝对路径/文件名]]
[[send-image: /绝对路径/图片.png]]
```

桥接会解析并移除这些标记，然后把真实文件/图片发送到飞书。

---

## 会话隔离与迁移

- 绑定键：`<bot>:<chatId>`；当 `perUserInGroup: true` 且为群聊时，为 `<bot>:<chatId>:<userId>`。
- 会话目录：`<location>/<bot>/<chatId[_userId]>/`，每个会话完全独立。
- **迁移**：在 A 设备 `/export` 得到 JSON；在 B 设备（可换机器人）把 JSON 作为附件发送 `/import`，即可接力同一会话历史。

---

## 对接已有的 OpenCode 项目 / 多 Agent 平台

有两种接法：

**A. 直接把 `location` 指向项目目录**（会话目录就会落在项目里）：

```jsonc
{ "location": "D:/myapp/agent demo" }
```

**B. `location` 放在 `data/` 下，用 `project` 指向项目**（推荐，项目目录保持干净）：

```jsonc
{
  "location": "../data/workspaces",
  "project": "D:/myapp/agent demo"
}
```

此时桥接会**在该机器人自己的文件夹** `<location>/<bot 名>/` 下自动建立指向 `<project>/.opencode` 的目录链接（Windows 用 junction），并复制一份 `opencode.jsonc`。OpenCode 从最近的项目根解析 agent 定义，因此在 `data/workspaces/<bot 名>/` 下的会话依然能派发 `pm-*` 子 Agent、调用 `s*` 技能——而所有会话文件、`inbox/` 都只出现在 `data/` 里。链接是幂等的，每次会话创建前按需补齐。

### 多个不同位置的 Agent（多机器人）

因为链接建立在**每个机器人自己的文件夹**下，所以**多个机器人即使共用同一个 `location`，也能各指向不同的项目**，互不干扰：

```jsonc
"bots": [
  {
    "name": "产品中心agent",
    "layout": "…",
    "location": "../data/workspaces",
    "project": "D:/myapp/agent demo",       // → data/workspaces/产品中心agent/.opencode
    "agent": "pm-brain"
  },
  {
    "name": "研发agent",
    "location": "../data/workspaces",         // 同一个 location 也没关系
    "project": "D:/work/dev-agents",          // → data/workspaces/研发agent/.opencode
    "agent": "dev-brain"
  }
]
```

布局：

```
data/workspaces/
  产品中心agent/
    .opencode ─(junction)→ D:/myapp/agent demo/.opencode
    opencode.jsonc
    <chatId>/...
  研发agent/
    .opencode ─(junction)→ D:/work/dev-agents/.opencode
    opencode.jsonc
    <chatId>/...
```

每个机器人也可以各自用**不同的 `location`**，效果一样。删除某个 `project` 字段则该机器人不再搭链接（回到 A：会话直接落在 `location`，由上层目录决定项目）。

> 两种方式下，`agent` 都用项目里**主 Agent 的名称**（如 `pm-brain`），不是模型名；`model.variant` 对应 OpenCode 模型变体（如 `#high`）。机器人名支持中文，会话目录保留中文名。`project` 省略时等价于 A。

---

## 健康监控与自愈

- 按 `healthIntervalMs` 周期性探测 OpenCode。
- 连续失败达到 `failureThreshold` 且 `restartOnFailure: true` 时，执行 `restartCommand` 重启共享服务，随后复检。
- 状态变化会通过审计日志记录，并在机器人配置了 `access.alertChatId` 时推送告警消息。

### 长任务与"迟到结果"补投

回合不会因为总耗时被掐断：只有当会话**连续 1 小时毫无进展**（既无事件、也不在 OpenCode 的活动列表中）才会判定卡死并结束。像十几个子 Agent 跑半小时以上的任务，只要还在推进就会一直等到最终结果。

此外有一个**补投巡检**（每 30 秒一次），用于兜底"回合已结束、但答案稍后才产出"的情况（例如回合超时、或桥在会话运行期间重启）：

- 每个绑定记录一个"已投递水位线"（`lastDeliveredMessageID`，存在 `bindings.json`）。
- 巡检发现某个会话已空闲、且其最新助手消息与水位线不同，就把该答案作为普通消息补发到飞书，并推进水位线（失败会下次重试，不会重复发送）。
- 升级到该机制时会先对既有会话**静默播种**水位线，避免把历史答案重新群发一遍；只有播种之后产生的新内容才会被补投。

---

## 架构

```
src/
  index.ts              CLI（run / doctor / init）
  app.ts                装配与生命周期
  config/               zod 配置加载 + 环境变量覆盖
  util/                 路径、JSON 原子读写、日志/审计、异步工具
  storage/bindings.ts   会话绑定持久化
  opencode/
    service.ts          发现/认证/健康/重启
    client.ts           fetch HTTP 客户端 + SSE 事件流
    events.ts           共享事件总线（断线重连）
    types.ts            事件与数据结构
  feishu/
    bot.ts              单个机器人（LarkChannel 封装）
    cards.ts            授权/提问/帮助/状态卡片
  core/
    conversations.ts    会话编排（绑定、prompt、流式卡片、文件投递）
    instructions.ts     写入 AGENTS.md 与解析发文件标记
    turn.ts             流式文本/工具活动累积
    commands.ts         斜杠命令路由
    interactions.ts     permission/form 轮询与卡片回调
  scheduler/cron.ts     动态定时任务
  monitor/health.ts     心跳与自动救援
```

---

## 开发辅助

```bash
npm run typecheck                 # 类型检查
npx tsx scripts/smoke.ts          # OpenCode 冒烟测试：建会话→提问→流式输出
```

---

## 故障排查

| 现象 | 排查 |
| --- | --- |
| `npm run doctor` 报 OpenCode 连接失败 | 确认 `opencode serve --service` 在运行；`service` 模式检查服务注册文件，`remote` 模式检查 `baseUrl` / 密码 |
| 飞书收不到消息 | 确认已开启长连接、订阅 `im.message.receive_v1`、应用版本已发布并通过审核 |
| 群里 @机器人无响应 | 需要 `im:message.group_at_msg:readonly` 权限；或把 `requireMention` 设为 `false` |
| 卡片按钮点击无反应 | 确认订阅了卡片回调 `card.action.trigger` |
| 收不到图片/文件 | 需要 `im:resource` 权限 |
| 日志在哪 | `data/logs/app-*.log`（诊断）与 `data/logs/audit.jsonl`（审计） |
