<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: Telegram 一体化插件：inbound（长轮询收消息注入主会话+回复回传）+ outbound（telegram_send/status 可靠推送+outbox 防丢失）+ telegram_ask（电报提问等待回复）合并单插件
  inject: 'agents','sessions','tools'
  tools: telegram_send,telegram_status,telegram_send_file,telegram_ask
  runtime: host-only
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-telegram — Telegram 远程连接插件


<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-telegram"><img src="https://img.shields.io/badge/version-0.3.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
DSH（DeepSeek Harness）插件：通过 Telegram Bot 远程连接主会话——随时随地向 agent 发消息、接收实时回复与任务直播、远程回答问题（telegram_ask）。

## 功能特性

- **长轮询接入**：getUpdates 免公网端口/webhook；offset 确认防丢消息（处理成功才确认）
- **steer 实时干预**：主会话任务执行中，消息在下一个决策点实时插入——远程干预不用等整轮结束
- **telegram_ask 远程提问**：agent 需要确认/选择时把问题发到主人 Telegram，主人回复即作为答案回填（支持选项序号/自定义答案/多选//cancel），无需打开 GUI
- **重启不丢会话**：会话不可用期间消息入重试队列，agent 就绪后自动补投（不再直接丢弃）
- **中间消息直播**：工具调用的叙述与工具名实时推送（清洗 Markdown 符号防星号外露）
- **MarkdownV2 渲染**：智能转义（保护代码/链接/粗体结构），降级链保证消息必达
- **重启不丢回复**：pending 持久化——哨兵重启后首个回复自动回传
- **owner 白名单**：首条消息自动绑定主人，非 owner 一律忽略
- **完整日志**：`telegram.log` 全事件链（收到/注入/直播/回传/API 异常）
- **typing 状态**：处理期间持续显示「正在输入…」

## 安装

```bash
cd <你的 self-plugins 目录>
git clone https://github.com/jonah791/dsh-agent-telegram.git
cd dsh-agent-telegram
pnpm install
pnpm build
```

## 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `botToken` | Telegram Bot Token（必填，通过 @BotFather 创建） | — |
| `mainSessionId` | 主会话 ID（可选，缺省自动追踪最近真实 GUI 用户消息的会话） | — |
| `ownerChatId` | 主人 chat id（可选，首条消息自动绑定） | — |
| `startDelayMs` | 启动延迟（让哨兵唤醒消息先处理） | 5000 |
| `maxReplyChars` | 单条回复上限 | 3800 |
| `askTimeoutMs` | telegram_ask 单次提问总超时 | 600000 |
| `retryMaxMs` | 会话不可用期消息排队最长时限 | 300000 |
| `askEnabled` | 是否启用 telegram_ask 工具 | true |

## 使用

向 Bot 发消息即可对话；支持命令：`/status`（状态）/ `/ping`（心跳）/ `/help`（用法）/ `/sessions`（会话列表）/ `/context`（上下文压力）/ `/content [n]`（最近消息）。

模型侧工具：
- `telegram_send` / `telegram_send_file`：主动推送消息/文件
- `telegram_ask`：向主人提问并等待回复（替代 GUI 弹窗，远程可答）

## 技术要点

- 代理依赖 `NODE_USE_ENV_PROXY=1`（进程启动时注入，由哨卫 watch 负责）
- 时间敏感：offset 至少一次语义 + pending 持久化保证「重启窗口不丢消息」
- 会话不可用重试队列：重启后 agent 未激活期间的消息入队，每 2s 重试投递直至成功或超时（`retryMaxMs`）
- telegram_ask 答案路由：提问期间 owner 的普通文本消息作为答案消费（不注入会话），命令仍优先处理；HMR 卸载自动 reject 挂起调用

## 相关

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life)

## License

MIT
