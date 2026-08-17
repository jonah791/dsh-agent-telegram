# dsh-agent-telegram — Telegram 远程连接插件

DSH（DeepSeek Harness）插件：通过 Telegram Bot 远程连接主会话——随时随地向 agent 发消息、接收实时回复与任务直播。

## 功能特性

- **长轮询接入**：getUpdates 免公网端口/webhook；offset 确认防丢消息（处理成功才确认）
- **steer 实时干预**：主会话任务执行中，消息在下一个决策点实时插入——远程干预不用等整轮结束
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
| `mainSessionId` | 主会话 ID（必填） | — |
| `ownerChatId` | 主人 chat id（可选，首条消息自动绑定） | — |
| `startDelayMs` | 启动延迟（让哨兵唤醒消息先处理） | 5000 |
| `maxReplyChars` | 单条回复上限 | 3800 |

## 使用

向 Bot 发消息即可对话；支持命令：`/status`（状态）/ `/ping`（心跳）/ `/help`（用法）。

## 技术要点

- 代理依赖 `NODE_USE_ENV_PROXY=1`（进程启动时注入，由哨卫 watch 负责）
- 时间敏感：offset 至少一次语义 + pending 持久化保证「重启窗口不丢消息」

## 相关

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life)

## License

MIT
