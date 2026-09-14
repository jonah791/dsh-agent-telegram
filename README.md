<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: Telegram 一体化通道——inbound（长轮询 getUpdates 收主人消息 → 注入/steer 主会话，回复回传）+ outbound（telegram_send / telegram_status / telegram_send_file：429 退避、4096 分片、MarkdownV2 降级、失败入 outbox 防丢失）+ telegram_ask（把问题发到主人电报并挂起等回复）+ coldstart 告警送达
  inject: 'agents','sessions','tools'
  tools: telegram_send, telegram_status, telegram_send_file, telegram_ask
  runtime: host-only
  envDeps: **必须**有 Telegram Bot Token（Config `botToken`，或 `DSH_HOME/.credentials.yaml` 的 `refs.TELEGRAM_BOT_TOKEN` 兜底）· 需能访问 api.telegram.org（走代理时依赖 `NODE_USE_ENV_PROXY=1`，由守护进程注入）· owner 白名单需先绑定（配置 `ownerChatId` 或主人先发一条消息）
  boundary: 只有 owner 可用（非 owner 消息**静默忽略**）；token/chat id 属凭据，**只进组合 patch 或凭据文件，绝不进源码与 README**；不写记忆库、不访问未知会话
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6 / dsh-llm ^0.1.0-rc.6 / dsh-session ^0.1.0-rc.6
-->
# dsh-agent-telegram

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-telegram"><img src="https://img.shields.io/badge/version-0.3.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-10%20passed-brightgreen" alt="tests">
</p>

**一句话**：把 agent 接到 Telegram 上——主人随时发消息（实时 steer，不必等整轮结束）、随时收直播与文件、随时回答 agent 的提问；发送失败的消息进 outbox **不丢**。

**为什么值得用**：GUI 不是随时都在。这条通道让 agent 的**存在与告警可达**——agent 不在场时（例如冷启动自救失败、web 起来了但会话没被激活），告警需要一条**比 DSH 自身更宽的外部路径**才能送到人手里，Telegram 就是那条路径。同时它是**可靠**的：offset 至少一次语义 + pending 持久化保证重启窗口不丢消息与回复；outbox 持久化保证发送失败的消息不会蒸发；MarkdownV2 解析失败自动降级纯文本（**内容必达优先于格式**）。

## 能力（4 个工具）

| 工具 | 用途（描述取自源码，逐字） |
|------|--------------------------|
| `telegram_send` | 主动发送一条 Telegram 消息给主人（可靠 outbound：429 退避/重试/失败入 outbox 防丢失/4096 分片/MarkdownV2 自动降级）。`plain=true` 走纯文本（直播/进度播报推荐）；`plain=false` 走 MarkdownV2 渲染。参数：`text`（必需，>4096 自动分片）、`plain`、`chat_id`（缺省 = owner 白名单） |
| `telegram_status` | Telegram outbound 通道诊断：owner 绑定、outbox 待发队列、通道健康。发消息前可先查 |
| `telegram_send_file` | 发送一个本地文件给主人（可靠文件传输：自动按扩展名选 `sendPhoto`/`sendAnimation`/`sendVideo`/`sendAudio`/`sendDocument`；支持中文路径；**单文件上限 50MB**；429 退避重试）。用于把生图输出/截图/文档/音频等本地文件直发主人。参数：`path`（必需，本地文件绝对路径）、`caption`（≤1024 字符纯文本）、`chat_id` |
| `telegram_ask` | 通过 Telegram 向主人提问并等待回复（无需 GUI）。问题发到主人绑定的频道，主人回复后作为工具结果返回。`questions` 数组，每项含稳定 `id`/`question`/可选 `header`/`options`/`multi_select`；推荐项放 `options` 首位并标 `(Recommended)`。主人可回序号（单选一个/多选逗号分隔）或直接输入自定义答案；`/cancel` 取消。**一次只应有一个活跃 `telegram_ask`**（并发调用会报错） |

**inbound（无工具面，被动工作）**：

| 行为 | 说明 |
|------|------|
| 长轮询 | `getUpdates`（`pollTimeoutMs`），免公网端口/webhook；offset **处理成功才确认**（至少一次语义） |
| 会话注入 | 主人消息注入主会话；主会话正在跑任务时走 **steer**——在下一个决策点实时插入，不用等整轮结束 |
| 等待期排队 | 会话不可用（重启窗口 / agent 未激活）期间消息入重试队列，每 2s 重试直至成功或超 `retryMaxMs`——**不再直接丢弃** |
| 直播 | 工具调用的叙述与工具名实时推送（清洗 Markdown 符号防星号外露） |
| typing | 处理期间持续显示「正在输入…」 |
| 回复回传 | `pending` 持久化——哨兵重启后首个回复自动回传 |
| 命令 | `/status` 状态 · `/ping` 心跳 · `/help`（与 `/start` 同义）用法 · `/sessions` 会话列表 · `/context` 上下文压力 · `/content [n]` 最近消息 · `/cancel` 取消当前提问 |

**coldstart 告警送达**：本插件周期性检查 `$DSH_HOME/life-core/coldstart-alert.json`（`coldstartWatchIntervalMs`），把「我不在」的冷启动自救失败告警推给主人。**判定逻辑是纯函数**（`src/cold-alert.ts`，零 IO、时间由调用方注入），已成功推送的告警按 mtime 去重（不会重复轰炸）。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-telegram": "link:<工作区>/self-plugins/dsh-agent-telegram"
```

**2) 构建**：

```bash
cd self-plugins/dsh-agent-telegram && npm install && npm run build && npm test
```

**3) 配置凭据与挂组合**：

```bash
# 推荐：token 放凭据文件（不进 git），Config 留空
# $DSH_HOME/.credentials.yaml:
#   refs:
#     TELEGRAM_BOT_TOKEN: <你的 bot token>
```

```yaml
- id: agent-telegram
  name: dsh-agent-telegram
  config:
    pollTimeoutMs: 25000
    inboundEnabled: true
    outboundEnabled: true
    askEnabled: true
```

**4) 30 秒验证**：

```text
① telegram_status
   → 期望：owner=未绑定 / owner=<id>，outbox=0
② 向 bot 发任意一条消息（完成 owner 绑定；首条消息自动绑定）
③ telegram_status           → 期望：ownerBound=true
④ telegram_send { text: "readme 验证", plain: true }
   → 期望：`已发送 (msg <id>)`；失败时渲染为「发送失败：已入 outbox 保底」
```

**无需真实 bot token 的验证**：`npm test`（10 例离线测试）——纯判定层不碰网络。

## 配置

（键名与 `src/index.ts` 的 `Config` schema 一致；默认值取自源码）

| 项 | 默认 | 说明 |
|----|------|------|
| `botToken` | `''`（空则读 `DSH_HOME/.credentials.yaml` 的 `refs.TELEGRAM_BOT_TOKEN`） | Bot（@BotFather 创建）。**单一来源**：优先 config，其次凭据文件——**不要写进 README/源码** |
| `ownerChatId` | 未设 | 主人 chat id（发放白名单）。未设时靠「首条消息自动绑定」，绑定结果落 `telegram-owner.json` |
| `mainSessionId` | 未设 | 主会话 id（可选；缺省时自动追踪最近真实 GUI 用户消息的会话） |
| `pollTimeoutMs` | `25000` | 长轮询 getUpdates 超时 |
| `maxReplyChars` | `3800` | 单条回复上限（与 4096 取小） |
| `startDelayMs` | `5000` | 启动延迟（让守护唤醒消息先处理） |
| `maxRetries` | `3` | 单次发送重试次数 |
| `retryBackoffMs` | `1500` | 重试退避基数 |
| `flushIntervalMs` | `60000` | outbox 冲刷间隔 |
| `outboxPath` | 未设（回退 `$DSH_HOME/telegram-outbox.json`） | outbox 文件路径 |
| `inboundEnabled` | `true` | 是否启用收消息 |
| `outboundEnabled` | `true` | 是否注册发送类工具 |
| `askTimeoutMs` | `600000` | `telegram_ask` 单次提问总超时 |
| `retryMaxMs` | `300000` | 会话不可用期消息排队最长时限 |
| `askEnabled` | `true` | 是否注册 `telegram_ask` |
| `coldstartAlertPath` | 未设（回退 `$DSH_HOME/life-core/coldstart-alert.json`） | coldstart 告警文件路径（**只读**输入） |
| `coldstartWatchIntervalMs` | `60000` | 告警文件检查间隔 |

## 落盘与自证（出问题时先看这里）

本插件**不写 `*-trace.jsonl` 阶段轨迹**；它的自证是**一组状态文件 + 两本日志**（全部在 `$DSH_HOME` 下）：

| 文件 | 内容 |
|------|------|
| `<DSH_HOME>/telegram.log` | **主事件链**（append，纯文本行）：`[ISO] [level] event detail`——收到 / 注入 / 直播 / 回传 / API 异常 |
| `<DSH_HOME>/telegram-outbound.log` | outbound 通道日志（发送、重试、降级、入 outbox） |
| `<DSH_HOME>/telegram-outbox.json` | **未送达消息队列**（持久化防丢失）；`flushIntervalMs` 周期冲刷 |
| `<DSH_HOME>/telegram-pending.json` | 待回传的回复（重启窗口不丢回复） |
| `<DSH_HOME>/telegram-owner.json` | owner 绑定结果（`{ ownerChatId, boundAt }`）——**含 chat id，勿外传** |
| `<DSH_HOME>/telegram-offset.json` | 长轮询 offset（`{ offset, updatedAt }`，至少一次语义的落点） |
| `<DSH_HOME>/life-core/coldstart-alert.json` | **只读**输入：`dsh-life-core` 写的冷启动自救失败告警（本插件负责送达） |
| `<DSH_HOME>/.credentials.yaml` | **只读**输入：`refs.TELEGRAM_BOT_TOKEN`（凭据文件不入 git） |

**一条命令答五问**：

```bash
tail -20 "$DSH_HOME/telegram.log"; echo ---; tail -5 "$DSH_HOME/telegram-outbound.log"
# ① 跑的是哪个构建 → 取不到（日志无 build 自报）；用「生效判据」节的 plugin_boot_status / lib mtime 判
# ② 谁发起 / 投给谁 → 收到消息与投递目标（owner 绑定后唯一）；发送日志含 chat 与长度
# ③ 断在哪一段    → 事件链即断点：有「收到」无「注入」= 会话注入失败（看是否在排队重试）；有「发送」无「送达」= API 侧失败（看 outbound 日志里的 429/降级）；有「入 outbox」= 已保底，等冲刷
# ④ 结果质量      → outbox 待发条数（`telegram-status` 也报）+ 是否发生 MarkdownV2 降级（降级 = 格式丢了但内容到了）
# ⑤ 耗时与预算    → 轮询 `pollTimeoutMs`(25s) / 重试 `maxRetries`(3)×`retryBackoffMs`(1500ms) / 排队上限 `retryMaxMs`(300s) / ask 超时 `askTimeoutMs`(600s) / outbox 冲刷 `flushIntervalMs`(60s)
```

**隐私纪律（本插件的红线）**：`telegram.log` / `telegram-owner.json` / `telegram-outbox.json` 里含 **chat id 与消息正文**。排障时只贴**结构化的字段名与计数**，不要把日志原文外传；token 永远只在 Config 或凭据文件里。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：

1. 行为级（最直接）：`telegram_status` 返回 owner 绑定状态与 outbox 计数（工具在工具面上）⇒ 插件已装载；若 `<DSH_HOME>/telegram.log` 的 mtime 在持续前进 ⇒ inbound 轮询在跑，**不是假活**；
2. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）返回的 `liveNow` 含本插件 ⇒ 进程在跑它；
3. 构建级：`lib/index.js` 的 mtime **早于** web 进程启动时间 ⇒ 当前进程加载的是这个产物。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。本插件也没有 `hasUnverifiedBuilds()` 类兜底，构建完必须重启 web 才生效。
>
> **网络维度的判据**：进程内改代理/凭据不会生效——`NODE_USE_ENV_PROXY=1` 必须在**进程启动时**注入（由守护进程负责）。所以「改了代理配置但还连不上」通常不是代码问题，而是**进程没重启**。

**回退**（三档）：

- 源码级：`git -C self-plugins/dsh-agent-telegram revert <commit>` → `npm run build` → `npm test` → 预检 → 重启；
- 组合级：给 profile 里 `agent-telegram` 行加 `disabled: true`（或精细化：`outboundEnabled: false` 停发送工具、`askEnabled: false` 停提问工具、`inboundEnabled: false` 停收消息）→ 重启；
- 运行期：**消息队列即数据**——`telegram-outbox.json` / `telegram-pending.json` 可手工备份后删除（副作用：待发消息与待回传回复一并丢失）。`telegram-offset.json` 删除会让轮询重新拉取（可能重复投递旧消息，**至少一次**语义，不是故障）。

## 测试

```bash
npm test        # = node --test "tests/*.test.mjs"（跑 lib/ 产物，需先 npm run build）
```

**10 例离线测试全部通过**（`# pass 10 / # fail 0`）：

| 文件 | 覆盖 |
|------|------|
| `tests/cold-alert.test.mjs` | coldstart 告警送达的纯判定：owner 未绑定（**不记状态**，绑定后仍可补推）/ 告警文件不存在 / mtime 未前进（已推送过去重）/ 已推送 mtime 更新（新告警） / 告警内容解析失败（仍推送，带兜底文案）——**冷路径样本**（「web 起来了但 agent 不在」）逐条覆盖 |

**覆盖范围的诚实说明**：当前**只有 coldstart 告警判定**这一层有单测。inbound 轮询、message 注入/steer、outbox 冲刷、分片与 MarkdownV2 降级、文件发送等路径**没有离线单测**，回归靠真实使用观察。这是本仓库已知的测试缺口。

**是否需要真实外部依赖**：**测试不需要**（不联网、不需 token）。但**功能本身必须有**——真实 `botToken` + 可访问 `api.telegram.org`（走代理时需 `NODE_USE_ENV_PROXY=1`）+ 已绑定的 owner。

## 设计要点

- **「至少一次」优于「恰好一次」**：offset 只在对消息**处理成功之后**才确认；重启窗口靠 `pending` 持久化补投。宁可重复一次，不可丢一次——丢的是主人的话，重复只是噪音。
- **内容必达优先于格式**：MarkdownV2 转义出错会让整条消息被 Telegram 拒收，所以有**降级链**（MarkdownV2 → 纯文本）。`telegram_send { plain: true }` 是直播/进度播报的推荐姿势（内容简单，不需要渲染）。
- **分片不切开结构**：超长消息按 4096 分片，但不把代码块/链接等结构从中间切断——否则每一片都是坏的 Markdown。
- **outbox 是「不丢」的落点，不是「已送达」的证据**：失败入 outbox 只保证消息还在队列里；判「真的送到了」要看 outbound 日志里的送达记录或主人确认。
- **`telegram_ask` 是挂起语义，不是轮询**：提问期间 owner 的**普通文本消息被当作答案消费**（不注入会话），命令仍优先处理；HMR 卸载会自动 reject 挂起调用（不留幽灵等待）。**一次只允许一个活跃提问**——并发会造成答案路由歧义。
- **告警通道不与告警源耦合**：冷启动告警由 `dsh-life-core` 落盘、本插件负责送达，而非让 life-core 反向依赖通道。理由：告警场景正是「web 起来了但我（agent）不在」——此时 Telegram 插件必然在跑，**这条降级路径真的更宽**。
- **owner 白名单是唯一准入**：非 owner 消息**静默忽略**（不回、不注入、不报错）。静默是刻意的——回复非 owner 等于对外暴露「这里有 agent」。
- **凭据单一来源，且不进 git**：`botToken` 优先 Config，其次 `DSH_HOME/.credentials.yaml`（凭据文件不入库）；组合 patch 会被 git 跟踪，所以更推荐凭据文件。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单、实践修订记录、未决问题 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `telegram-markdown-v2` / `preventive-lifecycle` / `plugin-maintainability` | MarkdownV2 转义与降级链、预防性存活与告警证据链、可维护性五问 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
