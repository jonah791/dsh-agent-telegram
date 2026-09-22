# 语义文档：dsh-agent-telegram（Telegram 远程通道 · inbound + outbound 一体）

> 版本 v0.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（本份是 2026-09-14 可维护性工程的**补课**文档）
> 实现落点：`self-plugins/dsh-agent-telegram/src/index.ts`（+ 纯判定 `src/cold-alert.ts`）

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-telegram（Telegram 一体化：inbound 注入/回传 + outbound 可靠推送 + telegram_ask 远程提问 + coldstart 告警送达） |
| 主副本路径 | `self-plugins/dsh-agent-telegram/docs/semantic.md`（本文件） |
| 实现落点 | `src/index.ts`（1165 行单体：轮询 / 目标会话解析 / 回传 / 工具 / outbox / coldstart 告警）、`src/cold-alert.ts`（告警送达判定纯函数） |
| 版本 | 0.3.1（git head `f21ee48`） |
| 挂载位置 | `.dsh/profiles/web/cordis.patch.yml` **行 117–121** `insert` 块：行 id `agent-agent-telegram`（:118）、name `dsh-agent-telegram`（:119）、config `pollTimeoutMs: 25000`（:121）。**botToken 不在 patch 里**（凭据走 `.credentials.yaml`，防入 git） |
| 状态 | **draft** |
| 测试 | `tests/cold-alert.test.mjs`（coldstart 告警判定边界） |

## 1 · 定位与反定位

**定位**：我（爱丽丝）与主人之间的**远程生命线**。一个 bot 连接、一份 owner 绑定、一份日志，承载四件事：
① **inbound**：`getUpdates` 长轮询收主人消息 → 注入主会话（`agent.steer`，运行中可在 step 边界实时干预）→
把回复回传 Telegram；② **outbound**：`telegram_send` / `telegram_send_file` 主动推送（429 退避、MarkdownV2
转义 + 降级、4096 分片、失败入 outbox 防丢失）；③ **telegram_ask**：把问题发到主人的电报并挂起等待答案；
④ **coldstart 告警送达**：轮询 `life-core/coldstart-alert.json`，把我「不在」的事实推给主人。

**反定位（本文不管什么）**：
- **不是 GUI**：`telegram_ask` 绕过 GUI 弹窗，但会话/上下文/记忆都不归它管
- **不是 agent 本体**：它只做投递（`agent.steer` / `agent.send`），不做任何内容决策
- **不保证送达顺序**：inbound 用 offset 至少一次语义；outbox 是**补发**不是重放（attempts ≥ 5 即弃置）
- **不是告警唯一通道**：coldstart 告警的**生产者**是 `dsh-life-core`（写文件），本插件只是**通道**（不反向依赖）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| owner | 主人 chat id。解析顺序：`config.ownerChatId` > `telegram-owner.json` > **首条消息自动绑定**；非 owner 消息**静默忽略** |
| inbound | `getUpdates` 长轮询（`pollTimeoutMs`，HTTP 超时 90s）→ `handleUpdate` |
| 目标会话（target） | 注入对象。`resolveTargetSessionId()` **六级回退**（见 §4.2） |
| pending | 「已注入、等回复」的会话状态 `{chatId, messageId, sessionId}`，持久化到 `telegram-pending.json`；回传后清除 |
| typing 心跳 | 每 4s 发 `sendChatAction(typing)`，TTL 15s（`TYPING_TTL_MS`） |
| 中间消息直播 | 带 `tool-call` 的 assistant 消息 → 清洗 Markdown 后作为直播文本推送（不结束 pending） |
| outbox | 发送失败的消息队列（`telegram-outbox.json`），启动 + 每 `flushIntervalMs` 补发；`attempts ≥ 5` 弃置 |
| 重试队列 | **inbound** 会话不可用时消息入队（`retryMaxMs` 内每 2s 重投），与 outbox 不同 |
| coldstart 告警 | `$DSH_HOME/life-core/coldstart-alert.json`（life-core 写），本插件读并推送 |
| 预检试运行实例 | `DSH_PREFLIGHT_TRIAL=1` 的 web：**跳过轮询**，避免与 live 实例争 bot（409） |

## 3 · 概念模型

```
                    ┌──────────────── dsh-agent-telegram（web 进程内）────────────────┐
Telegram Bot API ←──┤ loop(): DSH_PREFLIGHT_TRIAL? 跳过 : pollOnce(getUpdates)        │
   ▲   │            │   └─ handleUpdate(chatId, mid, text)                          │
   │   │            │        ① owner 绑定/校验（非 owner 静默忽略）                     │
   │   │            │        ② 命令：/status /help /start /ping /sessions /context /content[n]
   │   │            │        ③ activeAsk? → 作为答案消费（不注入会话）                    │
   │   │            │        ④ tryDeliver → resolveTargetSessionId() → agent.steer(…)   │
   │   │            │            失败 → retryQueue（retryMaxMs 内每 2s 重投）             │
   │   │            │                                                                  │
   │   └── sendText │ ctx.on('session/event')（:521 追踪真实用户会话 / :594 回传 assistant）
   │                │ sendText：MarkdownV2 → 降级纯文本；>limit 分片；429 尊重 retry_after  │
   │                │ push()：失败 → enqueue(outbox) → flushTimer 每 60s 重发              │
   │                │ coldstart 定时器（60s）：读 alert 文件 → decideColdAlertPush → 推送    │
   └────────────────└──────────────────────────────────────────────────────────────────┘
        工具面：telegram_send / telegram_status / telegram_send_file / telegram_ask
```

不变量（invariants）：
1. **I1 owner 唯一且非 owner 静默**：`chatId !== ownerChatId` 直接 `return`（`index.ts:640`）——不给任何反馈（防探测）。
2. **I2 注入必须落 pending**：`tryDeliver` 先 `pending = {...}` + `savePending()` 再 `agent.steer`；注入抛错则 `clearPending()`（`index.ts:738-756`）。
3. **I3 回传目标绑定约束**：`pending.sessionId !== undefined && session.id !== pending.sessionId` 的事件直接忽略（`index.ts:600`）。
4. **I4 目标会话不含派生会话**：兜底扫描跳过 `delegationDepth !== 0`（`index.ts:543`，§5.18）。
5. **I5 一次只有一个 active ask**：第二个 `telegram_ask` 直接抛「已有活跃的 telegram_ask」（`index.ts:1028`）。
6. **I6 coldstart 告警只在 mtime 前进且送达成功后才记状态**：推送失败**不写** `telegram-coldstart-pushed.json`（宁可重复，不可漏报，`index.ts:1139`）。
7. **I7 预检试运行实例不轮询**：`DSH_PREFLIGHT_TRIAL === '1'` → `loop()` 立即返回（`index.ts:800`）。

## 4 · 契约

### 4.1 数据结构 / 文件 / 服务

| 名称 | 路径 / 形状 | 语义 |
|------|------------|------|
| owner 绑定 | `$DSH_HOME/telegram-owner.json` `{ownerChatId, boundAt}` | 首次绑定写；读取优先级见术语表 |
| offset | `$DSH_HOME/telegram-offset.json` `{offset, updatedAt}` | **处理成功才推进**（至少一次语义，`index.ts:786`） |
| pending | `$DSH_HOME/telegram-pending.json` `{chatId,messageId,sessionId,at}` | 注入时写、回传时 `rmSync`；启动恢复时**若配置了 mainSessionId 且不符则以配置为准**（`index.ts:497-508`） |
| outbox | `$DSH_HOME/telegram-outbox.json` `{items:[{id,chatId,text,plain,createdAt,attempts}],updatedAt}` | 即时发送失败入队；≤5 次尝试；可被 `config.outboxPath` 覆盖 |
| 事件日志 | `$DSH_HOME/telegram.log` | `tgLog` 同时 `console.log` + 追加文件（失败吞错） |
| coldstart 状态 | `$DSH_HOME/telegram-coldstart-pushed.json` `{lastPushedMtimeMs, at}` | **只有送达成功才写**；损坏 → 从 0 开始（宁可重复推一次） |
| 凭据 | `$DSH_HOME/.credentials.yaml` 的 `TELEGRAM_BOT_TOKEN` | `config.botToken` 为空时兜底读取；正则清洗引号（`index.ts:165`） |

### 4.2 裁决（纯函数优先）

`resolveTargetSessionId()`（`index.ts:532`）——**六级回退**，顺序即语义：

| 序 | 条件 | 裁决 | 语义依据 |
|---|------|------|---------|
| ① | `config.mainSessionId` 已配 | 直接返回它 | 主人显式钉死优先 |
| ② | 本进程监听到真实用户消息（`source.kind==='user'`）且 agent live | 返回该会话 | §5.18 判据 `isUserSession` |
| ③ | 扫全部**顶层**会话（`delegationDepth===0`）找最后一条真实用户消息 | 返回它（并回填缓存） | 排除派生会话 |
| ④ | 无 → 内存缓存 `lastGoodSessionId` | 返回之 | 重启后兜底 |
| ⑤ | 无 → `telegram-pending.json` 的 sessionId（**且 agent 已激活**） | 返回之；未激活则**不返回**并记 warn | 重启恢复 |
| ⑥ | 无 → `ctx.agents.list()` 取第一个 | 返回之 | 「消息必须能注入」优先于「注入给谁」 |

`decideColdAlertPush(input) → string | null`（`src/cold-alert.ts:55`）：

| 输入状态 | 裁决 | 理由 |
|---------|------|------|
| `ownerBound === false` | `null`（**且不记状态**） | 无人可送达，绑定后仍应补推 |
| `alertExists === false` / `mtime ≤ 0` | `null` | 无告警 |
| `mtime ≤ lastPushedMtimeMs` | `null` | 同一条告警不重复刷屏 |
| `alert === null`（解析失败） | **仍推送**（兜底文案） | 宁可文案简略，不可漏报 |

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号 / 行号） | 时机 |
|-------|--------------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml:117-121`（行 id `agent-agent-telegram`） | web 启动 |
| inject 声明 | `src/index.ts:37` `inject = ['agents','sessions','tools']` | 激活门 |
| 会话事件（目标追踪） | `src/index.ts:521 ctx.on('session/event', …)` → 更新 `lastUserPromptAt` / `lastUserSessionId` | 每事件 |
| 会话事件（回复回传/直播） | `src/index.ts:594 ctx.on('session/event', …)` | 每事件 |
| 生命周期清理 | `src/index.ts:1077 ctx.effect(() => () => …)`：清 typing/pending/retry 队列/**reject 挂起 ask** | unmount / HMR |
| 启动 | `src/index.ts:1091 ctx.effect(() => …)`：flush outbox + inbound loop（`startDelayMs` 5s）+ flushTimer + coldstart 定时器 | mount |
| `telegram_send` | `src/index.ts:909 ctx.tools.register(defineTool(...))` | 工具面（`outboundEnabled !== false`） |
| `telegram_status` | `src/index.ts:929` | 同上 |
| `telegram_send_file` | `src/index.ts:945` | 同上 |
| `telegram_ask` | `src/index.ts:970` | 工具面（`askEnabled !== false`） |
| 落盘产物 | `telegram-owner.json` / `telegram-offset.json` / `telegram.log` / `telegram-pending.json` / `telegram-outbox.json` / `telegram-coldstart-pushed.json` | — |
| 消费方 | 主人（Telegram 客户端）；`dsh-life-core`（告警生产者，只写文件）；所有经本通道远程干预的会话 | — |
| 测试 | `tests/cold-alert.test.mjs` | `pnpm test` |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：owner 白名单是**语义过滤**，不是认证——知道 chat id 就能伪装（Telegram 侧身份由 Bot API 保证）；`telegram_send_file` 能读取本地**任意可读路径**并上传（50MB 上限），故调用者必须自己判断内容是否可外发。
- **不越界清单**：不写记忆库；不访问未知会话（只对 `resolveTargetSessionId` 的结果注入）；不修改 harness 配置；不在 patch 里存凭据。
- **失败面**：
  - `getUpdates` 返回 null（含 409 冲突）→ 指数退避（`pollFailCount*2000`，上限 60s）并记日志（**防 200ms 死循环刷日志**——历史事故：日志涨到 17MB）。
  - 目标会话不可达 → 入 retryQueue + 回执「消息已排队」；超 `retryMaxMs` **丢弃并记 warn**。
  - 发送失败 → 入 outbox（**放行 + 落盘**），`attempts ≥ 5` 弃置并记 warn。
  - `outbox` 载入/落盘失败 → warn 不抛。
  - coldstart 检查异常 → 吞错记 warn（**不炸 web**）。
  - HMR 卸载 → reject 挂起的 `telegram_ask`（调用方拿到明确错误，不静默挂起）。
  - `telegram.log` **无轮转机制**：当前 31.0MB（2026-09-14 实测）——见 U1。

## 6 · 与既有机制的关系

| 机制 | 关系与顺序约束 |
|------|--------------|
| AGENTS.md §5.18 唤醒/通知投递 | 本插件的 `resolveTargetSessionId` 是「锚点不是真源 + 排除派生会话」的**主要实现**（①显式锚点 → ②实时用户会话 → ③顶层扫描）；sentinel 的 wake-target 裁决与之同源 |
| §5.12 提醒防静默失效 | coldstart 告警的「存活证据」= `telegram-coldstart-pushed.json`；「投递前重验」由 mtime 前进判据承担 |
| §5.13 冷启动自唤醒 | 本插件是**外部告警通道**的那一半（life-core 自救失败 → 落盘 → 本插件送达 → 主人介入） |
| §5.10 预防性存活 | 告警必须送达成功才记状态（宁重复勿漏报） |
| §5.15 会话事件契约 | 回复回传/直播读取 `assistant/message` 的 `content` 块（只取 `text`，忽略 reasoning） |
| dsh-agent-preflight | `DSH_PREFLIGHT_TRIAL=1` 是本插件与预检的**协作契约**（试运行实例不抢 bot） |
| dsh-agent-watch | `NODE_USE_ENV_PROXY=1` 由守护注入 web 子进程——本插件依赖它在启动时生效（进程内设置无效） |
| 代理 | Telegram 被墙：靠 env 代理（EnvHttpProxyAgent），patch 里**无代理配置项** |

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（命令/文件/日志行） | 状态 |
|---|-----------|------------------------|------|
| A1 | 运行中的 web 加载的是当前构建 | `lib/index.js` mtime 2026-09-13 11:42:39 **早于** web 启动 2026-09-14 10:05:47 | ✓ 已实测 |
| A2 | owner 已绑定且绑定持久化 | `.dsh/telegram-owner.json` 存在（63B，mtime 2026-08-16 21:58） | ✓ 已实测 |
| A3 | 事件链真的在写 | `.dsh/telegram.log` 31,055,796B，mtime 2026-09-14 10:25 | ✓ 已实测 |
| A4 | coldstart 告警判定边界（未绑定/不存在/mtime 未前进/解析失败） | `node --test tests/cold-alert.test.mjs` | 待验收（未在本轮执行） |
| A5 | 工具可答：`telegram_status` 返回 ownerBound=true 且 outboxPending 数 | 调 `telegram_status` | 待验收 |
| A6 | 非 owner 消息被静默忽略（无任何回发） | 用第二个 chat 发消息 → `telegram.log` 无「注入成功」，Telegram 侧无回复 | 待验收 |
| A7 | 重启不丢回传目标 | 会话回复期间写哨兵重启 → 首个回复仍回传到 Telegram（pending 恢复） | 待验收 |
| A8 | 预检试运行实例不轮询 | 试运行期 `.watch-web.log` 无 409 冲突行；`telegram.log` 含「DSH_PREFLIGHT_TRIAL=1 …跳过」 | 待验收 |
| A9 | 会话不可用期消息不丢 | 重启窗口内发消息 → 回执「已排队」→ agent 就绪后 `telegram.log` 含「重试队列投递成功」 | 待验收 |

## 8 · 与实现的关系

- **主实现**：`src/index.ts`（单体）。**纯判定层**：`src/cold-alert.ts`。
- **同语义副本（I1）**：无。**相邻但不同主**：`dsh-agent-watch/src/alert-transport.ts` 也发 Telegram 告警，但走**独立通道**（守护进程不依赖 web 内的本插件）——两者是「两条生命线」而非副本；语义主副本各自保留。
- **未实现 / 未验证部分（显式标注）**：
  1. `mainSessionId` 未在 patch 中配置 → 目标会话**全靠**②③⑥回退（`resolveTargetSessionId` 的前两跳之一必然生效）；「⑥ 任取一个 live agent」的兜底后果（可能投给非人用的会话）未被排除——§5.18 的 `isUserSession` 判据在本插件**只用于③**，⑥未过滤。
  2. `telegram.log` 无轮转（31MB）——未验证的运维风险。
  3. `retryQueue` / `activeAsk` 是**内存态**：重启即丢（pending 有持久化，这两个没有）。
- **生效判据**（改了代码后怎么证明真的生效）：
  1. **产物 vs 进程**：`lib/index.js` mtime 早于 web 进程启动时间（当前 09-13 11:42:39 < 09-14 10:05:47 ✓ live；若重建后 mtime 更新 → 必须重启 web 才生效）。
  2. **落盘物证**：`telegram.log` 出现 `[dsh-agent-telegram] […][info] apply (HMR probe) inbound=true outbound=true` 与 `ready bot=<前8位>…` 行（每次加载必写）。
  3. **工具可答**：`telegram_status` 返回 `ownerBound/outboxPending/botPrefix`。
- **回退**：
  - 组合面：`plugin_stop dsh-agent-telegram`（写 patch `disabled: true` + 预检 + 哨兵重启）——**代价：远程生命线中断**（主人只能从 GUI 联系我）；更轻的降级是 `plugin_configure` 传 `inboundEnabled:false`（只停轮询、保留 outbound 工具）。
  - 代码面：`git revert <commit>`（head `f21ee48`）+ `pnpm build` + 重启 web。
  - 数据面：`telegram-offset.json` 可安全删除（重新从最新 update 开始，**可能重复处理最近一条**）；`telegram-outbox.json` 删除 = 丢弃待发消息（**不可逆**，删前先读它内容）；`telegram-owner.json` 删除 = 下次收到消息时**任何人可重新绑定**（安全敏感，勿随意删）。

## 9 · 实践修订记录

**2026-09-14 补课：本插件此前无语义文档（可维护性工程）**

- 语义**被确认**：
  - 「owner 白名单 + 非 owner 静默」在实现中成立（`index.ts:631-640`）。
  - 「预检试运行实例跳过轮询」是本插件主动让路（2026-09-13 修 409 冲突），不是 harness 约束。
- 语义**被补充**（本文首次写清的部分）：
  - **凭据来源是 `.credentials.yaml`，不在 patch**（2026-09-06 凭据迁移）——排查「token 404」时先查该文件是否带引号。
  - **`resolveTargetSessionId` 是六级回退**（此前只有 README 的一句「自动追踪最近真实 GUI 用户消息的会话」）；其中 ⑤⑥ 是重启窗口的兜底，**不是**常规路径。
  - `telegram_ask` 期间 owner 的普通文本消息被**当作答案消费**（命令仍优先，`index.ts:695-718`）——这改变了「发消息 = 注入会话」的默认语义，必须显式记录。
- 语义**被修正**：无（未发现实现与文档冲突；README 的配置表已与实际 Config 一致，除 `outboxPath`/`inboundEnabled`/`outboundEnabled` 三项未列——已在 §4.1 补全）。
- 教训（同时回写技能 `semantic-doc-first`）：**模式切换型语义最容易被漏写**——「有 activeAsk 时消息含义改变」这类**输入解释权转移**，README 的「功能列表」永远写不到；语义文档的「契约」节要专门列出**同一输入在不同模式下的不同裁决**。

**2026-09-22 D3 告警复核：无修订（判为假报）**

- **D3 触发源**：`src/index.ts` mtime `2026-09-19 21:52:58` 晚于本文件 `2026-09-14 10:29:15`——同样是**工作区未提交**改动的时间，不是提交时间。
- **取证（可复现）**：`git log --since='2026-09-14 10:35:44' --oneline -- src/index.ts` → **空**；`git diff -- src/index.ts` → +21/−5，全部围绕新增帮手 `sessionEvents()`（`src/index.ts:36-51`）与四处替换（`:560` `/ :675` `/ :684` `/ :697`）。
- **改动是什么**：DSH 0.1.6 平台适配——`Session.events` 公共属性已移除（同步读 Session 历史全线弃用），改用同语义的 `snapshotEvents()`；帮手内保留异常归一（会话未装载时读历史曾抛 TypeError，若从定时器逃逸会杀死宿主 web 进程）。被替换的四处是 **`/sessions`（`:675`）/ `/context`（`:684`）/ `/content`（`:697`）三个只读命令 + 目标会话扫描（`:560`）**——即「读取会话历史的**通道**换了」。
- **与本条语义的关系**：本文档对 `s.events` 无任何断言；§4.2 六级回退、§5 失败面、§7 验收表所写的**判决与投递语义**均未被该改动触及 ⇒ **假报**——告警来自 impl 清单的**文件粒度**（同一 `src/index.ts` 被平台适配碰到），不是内容过时。
- **该改动已构建并 live**：`lib/index.js` mtime `2026-09-20 11:51:21` < web 进程启动 `2026-09-22 12:29:33`，且 `grep -c snapshotEvents lib/index.js` = 2 ⇒ 不存在「线上跑的是未适配旧代码」的隐含风险。
- **附带事实（未回写）**：该未提交改动在文件前部插入 16 行，使 §4.3 引用的行号整体 +16（inject `:37→:53`、`ctx.on('session/event')` `:521/:594→:537/:610`、`resolveTargetSessionId` `:532→:548`、工具面 `:909/:929/:945/:970→:926/:946/:962/:987`、`ctx.effect` `:1077/:1091→:1093/:1107`）。本文件行号仍锚定 HEAD `254d941`——**该改动落盘后需统一回写**。

## 10 · 未决问题

- **U1 `telegram.log` 无轮转**（31MB 且持续增长）：倾向加按大小截断（如 >8MB 截半，与 `.watch-web.log` 同款）；但它同时是最完整的诊断证据链，截断策略需主人确认。
- **U2 ⑥兜底可能投给非人用会话**：`resolveTargetSessionId` 第⑥跳未用 `isUserSession` 过滤（§5.18 判据只用在③）。倾向：⑥改为「在顶层会话中取最近更新的一个」，找不到则**不注入**并回执「无可用会话」。
- **U3 `retryQueue` / `activeAsk` 不持久化**：重启即丢（发送者收到「已排队」但可能永远不到）。倾向：与 pending 同级落盘。
- **U4 出站是否需要「消息 id 回执」**：`push` 已返回 `messageId`，但 outbox 补发成功后主人不知道自己收到的是补发的旧消息。
- **U5 与 `dsh-agent-sentinel` 的告警通道重复**：两条生命线都发 Telegram（各自独立 token/chat 配置项）——**故意冗余**还是应合并？倾向保留冗余（互为兜底），但需主人知晓这会重复告警。
