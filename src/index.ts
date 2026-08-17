/**
 * dsh-agent-telegram：Telegram 远程连接（八千代 @jonah_assistant_bot）
 *
 * 设计：
 * - **长轮询**（getUpdates timeout=25s）：免公网端口/webhook；offset 确认机制防丢消息
 * - **白名单**：ownerChatId（配置或首个消息自动绑定）；非 owner 一律忽略（防外人控制会话）
 * - **消息注入**：文本 → createUserMessage → agent.steer(msg)（next-step + 唤醒）——
 *   空闲时正常开 turn；主会话任务执行中（running）时在下一个 step 边界实时插入，实现远程干预
 * - **回复回传**：pending 覆盖——注入后等 assistant/message 事件，取回复文本 sendMessage 回最新消息的发送者（连续干预不丢回复）
 * - **命令**：/status（当前状态）/help（用法）/ping
 * - **安全**：token 在 Config（主人显式提供）；不写记忆库；无未知会话访问
 * - **可靠**：轮询错误退避重试；回复分片（Telegram 单消息 4096 上限）；长轮询中断自动恢复
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent' // Context.agents / session 事件类型 merge
import type {} from '@deepseek-ai/dsh-session'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'agent-telegram'
export const inject = ['agents'] as const

export interface Config {
  botToken: string
  ownerChatId?: number
  mainSessionId: string
  pollTimeoutMs?: number
  maxReplyChars?: number
  startDelayMs?: number
}
export const Config = z.object({
  botToken: z.string().required(true),
  ownerChatId: z.number().required(false),
  mainSessionId: z.string().required(true),
  pollTimeoutMs: z.number().default(25000),
  maxReplyChars: z.number().default(3800),
  startDelayMs: z.number().default(5000),
})

const API = 'https://api.telegram.org/bot'
// 代理说明：依赖 watch 守护注入的 NODE_USE_ENV_PROXY=1（Node 内置 EnvHttpProxyAgent 自动走系统代理）；
// 不用 undici ProxyAgent（实测连接 Telegram 失败，兼容性差）

// owner 绑定持久化（重启/HMR 不丢：内存态曾导致重复绑定消息）
const ownerFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'telegram-owner.json')
// offset 持久化：处理后推进（至少一次语义）+ 重启恢复——HMR/守护重启窗口不丢已确认未处理的消息
const offsetFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'telegram-offset.json')
// 独立日志文件（DSH_HOME/telegram.log）：完整事件链可回溯，不混入 web stdout
const logFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'telegram.log')
// pending 持久化：哨兵重启（kill+重启）会丢内存态——注入时落盘，重启恢复回传目标
const pendingFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'telegram-pending.json')

function tgLog(level: 'info' | 'warn' | 'error', event: string, detail?: string): void {
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' + event + (detail ? ' ' + detail : '')
  console.log('[dsh-agent-telegram] ' + line)
  try {
    appendFileSync(logFile(), line + '\n', 'utf8')
  } catch { /* 日志写入失败不阻塞主流程 */ }
}

export function apply(ctx: Context, config: Config): void {
  tgLog('info', 'apply (HMR probe)')
  let offset = 0 // getUpdates 确认游标（0 = 只收新消息）
  let ownerChatId: number | null = config.ownerChatId ?? null
  // 恢复持久化绑定（文件优先于 config？不：config 显式 > 文件 > null）
  try {
    if (ownerChatId === null && existsSync(ownerFile())) {
      const saved = JSON.parse(readFileSync(ownerFile(), 'utf8')) as { ownerChatId?: number }
      if (typeof saved.ownerChatId === 'number') ownerChatId = saved.ownerChatId
    }
  } catch { /* 损坏忽略 */ }
  let stopped = false
  let pending: { chatId: number; messageId: number } | null = null
  // 恢复持久化 offset（重启后从上次确认点继续；未确认消息由 Telegram 重发）
  try {
    const saved = JSON.parse(readFileSync(offsetFile(), 'utf8')) as { offset?: number }
    if (typeof saved.offset === 'number' && saved.offset > 0) offset = saved.offset
  } catch { /* 无记录或损坏忽略 */ }
  let typingTimer: NodeJS.Timeout | null = null
  let polling = false

  function savePending(): void {
    if (pending === null) return
    try {
      writeFileSync(pendingFile(), JSON.stringify({ chatId: pending.chatId, messageId: pending.messageId, at: new Date().toISOString() }), 'utf8')
    } catch { /* 持久化失败忽略（内存态仍生效） */ }
  }
  function clearPending(): void {
    pending = null
    try { rmSync(pendingFile(), { force: true }) } catch { /* 忽略 */ }
  }
  // 恢复持久化 pending（哨兵重启不丢回传目标；重启后首个回复即回传）
  try {
    const saved = JSON.parse(readFileSync(pendingFile(), 'utf8')) as { chatId?: number; messageId?: number }
    if (typeof saved.chatId === 'number' && typeof saved.messageId === 'number') {
      pending = { chatId: saved.chatId, messageId: saved.messageId }
      tgLog('info', '恢复 pending', 'chat=' + saved.chatId + ' mid=' + saved.messageId)
      typingTimer = setInterval(() => {
        void apiCall<unknown>('sendChatAction', { chat_id: pending?.chatId ?? 0, action: 'typing' })
      }, 4000)
    }
  } catch { /* 无记录或损坏忽略 */ }

  const log = ctx.logger('dsh-agent-telegram')

  // ---------- Telegram API 原语 ----------
  async function apiCall<T>(method: string, params: Record<string, unknown>): Promise<T | null> {
    try {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(90000), // getUpdates 长轮询 25s + 余量；90s 防掐断
      } as RequestInit
      const res = (await fetch(API + config.botToken + '/' + method, init)) as unknown as {
        ok: boolean
        status: number
        text(): Promise<string>
        json(): Promise<{ ok: boolean; result: T; description?: string }>
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        tgLog('warn', 'api ' + method + ' HTTP ' + res.status, body.slice(0, 200))
        return null
      }
      const json = await res.json()
      if (!json.ok) {
        tgLog('warn', 'api ' + method + ' failed', json.description ?? 'unknown')
        return null
      }
      return json.result
    } catch (e) {
      tgLog('warn', 'api ' + method + ' error', String(e))
      return null
    }
  }

  async function sendText(chatId: number, text: string, plain = false): Promise<boolean> {
    // Telegram 单消息 4096 字符上限：分片（智能切分避免切开 Markdown 结构）
    const limit = Math.min(4096, config.maxReplyChars ?? 3800)
    const chunks = plain ? [text] : smartChunks(text, limit)
    let ok = true
    for (const chunk of chunks) {
      if (plain) {
        // 纯文本（直播消息等）：无 parse_mode，内容原样显示
        const r = await apiCall<{ message_id: number }>('sendMessage', { chat_id: chatId, text: chunk })
        if (r === null) ok = false
        continue
      }
      // 降级链：MarkdownV2（智能转义）→ 纯文本（消息必达）
      // 不降旧版 Markdown：旧版对 ** 双星/未转义保留字符会错渲染（星号外露），纯文本保证内容正确显示
      let r = await apiCall<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: toMarkdownV2(chunk),
        parse_mode: 'MarkdownV2',
      })
      // 降级纯文本也清洗 Markdown 符号（原文 ** 字面会星号外露；strip 后内容保留、符号清理）
      if (r === null) r = await apiCall<{ message_id: number }>('sendMessage', { chat_id: chatId, text: stripMarkdown(chunk) })
      if (r === null) ok = false
    }
    return ok
  }

  // ---------- 事件：assistant 回复 → 回传 Telegram ----------
  // 只回传「最终纯文字回复」：含 tool-call 块的 assistant 消息是中间步骤（思考/工具调用），跳过等最终；
  // reasoning 等非 text 块不进入摘要（避免主人收到 [reasoning]/[tool-call] 占位噪音）
  ctx.on('session/event', (session, event) => {
    // 诊断：事件到达即打点（低频事件：user/assistant 消息类），含 pending 状态
    const ev = event as { type?: string; data?: { message?: Message } }
    if (ev.type === 'user/message' || ev.type === 'assistant/message') {
      tgLog('info', '会话事件', 'type=' + ev.type + ' session=' + session.id + ' pending=' + (pending !== null ? 'yes' : 'no'))
    }
    if (pending === null) return
    if (session.id !== config.mainSessionId) return
    if (ev.type !== 'assistant/message') return
    const message = ev.data?.message
    const blocks = message?.content ?? []
    const text = summarizeBlocks(message)
    const toolNames = blocks
      .filter((b) => b.type === 'tool-call')
      .map((b) => (b as { name?: string }).name ?? '?')
    if (toolNames.length > 0) {
      // 中间消息（含工具调用）：回传叙述文本 + 工具名做直播，不消费 pending
      // 直播清洗：移除 Markdown 符号（截断/嵌套导致未配对星号外露），纯文本播报
      const live = (text.trim().length > 0 ? stripMarkdown(text).slice(0, 800) + '\n' : '') + '（工具：' + toolNames.join(', ') + '）'
      tgLog('info', '中间消息直播', 'len=' + live.length + ' text=' + live.slice(0, 60).replace(/\n/g, ' '))
      void sendText(pending.chatId, live, true)
      return
    }
    if (text.trim().length === 0) return
    // 最终纯文本回复：消费 pending，完整回传
    const target = pending
    clearPending() // 先清再发，防重入
    if (typingTimer !== null) { clearInterval(typingTimer); typingTimer = null }
    tgLog('info', '回复回传', 'chat=' + target.chatId + ' len=' + text.length + ' text=' + text.slice(0, 80).replace(/\n/g, ' '))
    void sendText(target.chatId, text).then((ok) => {
      if (!ok) tgLog('warn', '回复回传失败', 'chat=' + target.chatId)
    })
  })

  // ---------- 消息处理 ----------
  function handleUpdate(chatId: number, messageId: number, text: string): void {
    if (ownerChatId === null) {
      // 首条消息绑定 owner（安全：后续只响应此人）；持久化防重启丢失
      ownerChatId = chatId
      tgLog('info', 'owner 绑定', 'chat=' + chatId)
      try {
        writeFileSync(ownerFile(), JSON.stringify({ ownerChatId: chatId, boundAt: new Date().toISOString() }), 'utf8')
      } catch (e) { tgLog('warn', 'owner 绑定持久化失败', String(e)) }
      void sendText(chatId, '已绑定为八千代的主人频道。发送 /status 查看状态。')
      return
    }
    if (chatId !== ownerChatId) return // 非 owner：静默忽略

    const trimmed = text.trim()
    if (trimmed === '/status') {
      tgLog('info', '命令 /status', 'chat=' + chatId)
      void sendText(chatId, statusText())
      return
    }
    if (trimmed === '/help' || trimmed === '/start') {
      tgLog('info', '命令 /help', 'chat=' + chatId)
      void sendText(chatId, helpText())
      return
    }
    if (trimmed === '/ping') {
      tgLog('info', '命令 /ping', 'chat=' + chatId)
      void sendText(chatId, 'pong ' + new Date().toISOString())
      return
    }

    // 注入主会话（实时干预）
    const agent = ctx.agents.get(config.mainSessionId as never)
    if (agent === undefined) {
      void sendText(chatId, '主会话不可用（' + config.mainSessionId + '）')
      return
    }
    // 实时干预：上一条还在处理时不再拒绝——消息照常注入，pending 覆盖为最新（回复回传给最后一条）
    tgLog('info', '收到消息', 'chat=' + chatId + ' mid=' + messageId + ' text=' + trimmed.slice(0, 80))
    pending = { chatId, messageId }
    savePending()
    // typing 状态：处理期间显示「正在输入…」（Telegram 状态持续约 5s，4s 续一次；fire-and-forget）
    typingTimer = setInterval(() => {
      void apiCall<unknown>('sendChatAction', { chat_id: chatId, action: 'typing' })
    }, 4000)
    try {
      // steer = 实时干预：主会话空闲时开新 turn；运行中（任务执行）在下一个 step 边界插入，
      // 主人发消息可立即介入正在进行的任务，不必等整轮结束
      agent.steer(
        createUserMessage({
          content: [{ type: 'text', text: '[telegram] ' + trimmed }],
          source: { kind: 'plugin', plugin: 'dsh-agent-telegram' },
        }),
      )
      tgLog('info', '注入成功', 'chat=' + chatId + ' mid=' + messageId + ' agent=' + String(agent.status))
    } catch (e) {
      clearPending()
      if (typingTimer !== null) { clearInterval(typingTimer); typingTimer = null }
      tgLog('error', '注入失败', 'chat=' + chatId + ' err=' + String(e))
      void sendText(chatId, '注入失败：' + String(e))
    }
  }

  // ---------- 长轮询循环 ----------
  async function pollOnce(): Promise<void> {
    const updates = await apiCall<{
      update_id: number
      message?: { chat?: { id?: number }; message_id?: number; text?: string }
    }[]>('getUpdates', {
      offset: offset === 0 ? undefined : offset,
      timeout: config.pollTimeoutMs,
      allowed_updates: ['message'],
    })
    if (updates === null) {
      tgLog('warn', 'getUpdates 返回 null（API 异常，含 409 冲突）')
      return
    }
    if (updates.length > 0) tgLog('info', 'getUpdates 收到', 'count=' + updates.length + ' first_update=' + String(updates[0]?.update_id))
    for (const u of updates) {
      if (u.update_id < offset) continue // 已确认消息去重（重启重收场景）
      const chatId = u.message?.chat?.id
      const messageId = u.message?.message_id
      const text = u.message?.text
      if (chatId === undefined || messageId === undefined || text === undefined) continue
      // 至少一次语义：处理成功才推进 offset（HMR/重启窗口不丢消息；失败消息下轮重试）
      try {
        handleUpdate(chatId, messageId, text)
        offset = Math.max(offset, u.update_id + 1)
        try {
          writeFileSync(offsetFile(), JSON.stringify({ offset, updatedAt: new Date().toISOString() }), 'utf8')
        } catch { /* 持久化失败忽略（内存态仍推进） */ }
      } catch (e) {
        tgLog('warn', 'handleUpdate 异常（保留 offset 下轮重试）', String(e))
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      if (!polling) {
        polling = true
        try {
          await pollOnce()
        } catch (e) {
          tgLog('warn', 'poll 异常', String(e))
        } finally {
          polling = false
        }
      }
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  function statusText(): string {
    const now = new Date().toISOString()
    const agent = ctx.agents.get(config.mainSessionId as never)
    return (
      '八千代在线 ' + now +
      '\n主会话: ' + config.mainSessionId + (agent !== undefined ? ' (可用)' : ' (不可用)') +
      '\nagent 状态: ' + (agent !== undefined ? String(agent.status) : '?') +
      '\nowner chat: ' + String(ownerChatId ?? '未绑定') +
      '\npoll offset: ' + offset + (pending !== null ? ' | pending 回复中' : '')
    )
  }

  function helpText(): string {
    return (
      '八千代 Telegram 远程\n' +
      '/status 状态\n' +
      '/ping 心跳\n' +
      '其他消息 → 注入主会话（空闲=正常对话；忙碌=实时干预，下个决策点插入）'
    )
  }

  // 启动轮询（fiber 资源：stopped 置位即停）
  // 启动延迟：重启后先让哨兵唤醒等系统消息注入处理，再开始轮询——避免电报 pending 消息抢占，
  // 把哨兵消息挤进 inbox（FIFO 队列无优先级）
  ctx.effect(() => {
    stopped = false
    tgLog('info', 'loop start', 'delay=' + String(config.startDelayMs ?? 5000) + 'ms offset=' + offset)
    setTimeout(() => {
      if (stopped) return
      void loop()
    }, config.startDelayMs ?? 5000)
    return () => {
      stopped = true
      tgLog('info', 'loop stop')
    }
  })

  tgLog('info', 'ready', 'bot=' + config.botToken.slice(0, 8) + '… mainSession=' + config.mainSessionId)
}

/**
/**




/**
 * 直播消息清洗：移除 Markdown 符号（粗体/斜体/代码/链接 → 纯文本内容），
 * 避免截断/嵌套导致的未配对星号外露。直播是进度播报，不需要渲染。
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/\`([^\`\n]+)\`/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
    .replace(/[_*\`~]/g, '')
}

/**
 * 智能分片：切片终点避开未闭合的 Markdown 符号（* _ \`），
 * 减少 4096 分片切开结构导致的降级/字面符号外露。
 */
function smartChunks(text: string, limit: number): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    const m = rest.slice(cut).match(/^[*_\`]+/)
    if (m) cut -= m[0].length
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  chunks.push(rest)
  return chunks
}

/**
 * MarkdownV2 智能转义（Telegram 方言：不支持 # 标题 / - 列表 / > 引用）：
 * 1. 保护代码块/行内代码/链接/粗体/斜体结构（§§n§§ 占位符）→ 2. 其余文本转义 17 个保留字符 → 3. 还原
 * 保留字符：_ * [ ] ( ) ~ \` > # + - = | { } . !
 */
function toMarkdownV2(text: string): string {
  const placeholders: string[] = []
  const protect = (m: string): string => {
    placeholders.push(m)
    return '§§' + String(placeholders.length - 1) + '§§'
  }
  // 1. 代码块 \`\`\`lang\n...\n\`\`\`
  text = text.replace(/\`\`\`[^\n]*\n[\s\S]*?\`\`\`/g, protect)
  // 2. 行内代码 \`code\`
  text = text.replace(/\`[^\`\n]+\`/g, protect)
  // 3. 链接 [text](url)
  text = text.replace(/\[[^\]\n]+\]\([^)\n]+\)/g, protect)
  // 4. 粗体 **text** → *text*（MarkdownV2 单星粗体）
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (m, p1) => protect('*' + p1 + '*'))
  // 5. 单星强调 *text* → 斜体 _text_
  text = text.replace(/\*([^*\n]+)\*/g, (m, p1) => protect('_' + p1 + '_'))
  // 6. 转义其余保留字符
  text = text.replace(/([_*\[\]()~\`>#+\-=|{}.!\\])/g, '\\$1')
  // 7. 还原占位符
  return text.replace(/§§(\d+)§§/g, (m, i) => placeholders[Number(i)] ?? m)
}

/** 消息文本提取：只取 text 块（reasoning/tool-call 等非文本块不输出） */
function summarizeBlocks(message: Message | undefined): string {
  if (message === undefined) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}
