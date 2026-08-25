/**
 * dsh-agent-telegram：Telegram 一体化插件（inbound + outbound 合并，2026-08-21）
 *
 * 取代旧双插件架构（dsh-agent-telegram inbound + dsh-agent-telegram-outbound）。
 * 一个 bot 连接、共享 owner 绑定 / offset / 日志文件，双向能力统一：
 *
 * ── Inbound（收）：长轮询 getUpdates（timeout=25s）→ owner 白名单绑定 →
 *    文本注入主会话（agent.steer，空闲开 turn / 运行中 step 边界实时干预）→
 *    回复回传（pending 覆盖 + typing 心跳 + assistant/message 事件回传）。
 *    命令：/status /help /ping。
 * ── Outbound（发）：telegram_send（爱丽丝主动发） + telegram_status（诊断）。
 *    可靠：429 尊重 retry_after 退避；5xx/网络退避重试；MarkdownV2 智能转义 +
 *    降级纯文本（内容必达）；4096 分片不切开结构；失败入 outbox 持久化防丢失
 *    （启动 + 周期 flush 自动重发）。
 *
 * 安全：token 在 Config（主人显式提供）；owner 白名单（配置 > 绑定文件 > 首个消息）；
 * 非 owner 静默忽略；不写记忆库；无未知会话访问。
 *
 * 持久化（DSH_HOME 下）：telegram-owner.json / telegram-offset.json / telegram.log /
 * telegram-pending.json / telegram-outbox.json / telegram-outbound.log
 *
 * 代理：依赖 watch 守护注入 NODE_USE_ENV_PROXY=1（Node 内置 EnvHttpProxyAgent 走系统代理）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent' // Context.agents / session 事件类型 merge
import type {} from '@deepseek-ai/dsh-session'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'agent-telegram'
export const inject = ['agents', 'sessions', 'tools'] as const

export interface Config {
  botToken: string
  ownerChatId?: number
  /** 可选：显式锁定目标会话（缺省=追踪最新活跃主会话） */
  mainSessionId?: string
  pollTimeoutMs?: number
  maxReplyChars?: number
  startDelayMs?: number
  /** outbound 重试 */
  maxRetries?: number
  retryBackoffMs?: number
  flushIntervalMs?: number
  /** 自定义 outbox 路径 */
  outboxPath?: string
  /** 禁用 inbound 轮询（只留 outbound 工具） */
  inboundEnabled?: boolean
  /** 禁用 outbound 工具（只留 inbound） */
  outboundEnabled?: boolean
}
export const Config = z.object({
  botToken: z.string().required(true),
  ownerChatId: z.number().required(false),
  mainSessionId: z.string().required(false),
  pollTimeoutMs: z.number().default(25000),
  maxReplyChars: z.number().default(3800),
  startDelayMs: z.number().default(5000),
  maxRetries: z.number().default(3),
  retryBackoffMs: z.number().default(1500),
  flushIntervalMs: z.number().default(60000),
  outboxPath: z.string().required(false),
  inboundEnabled: z.boolean().default(true),
  outboundEnabled: z.boolean().default(true),
})

const API = 'https://api.telegram.org/bot'
const homeDir = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ownerFile = () => join(homeDir(), 'telegram-owner.json')
const offsetFile = () => join(homeDir(), 'telegram-offset.json')
const logFile = () => join(homeDir(), 'telegram.log')
const pendingFile = () => join(homeDir(), 'telegram-pending.json')
const outboxFile = () => join(homeDir(), 'telegram-outbox.json')

function tgLog(level: 'info' | 'warn' | 'error', event: string, detail?: string): void {
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' + event + (detail ? ' ' + detail : '')
  console.log('[dsh-agent-telegram] ' + line)
  try { appendFileSync(logFile(), line + '\n', 'utf8') } catch { /* 日志失败不阻塞 */ }
}

// ════════════════════════ Markdown 处理（inbound/outbound 共用） ════════════════════════

/** 直播消息清洗：移除 Markdown 符号（粗体/斜体/代码/链接 → 纯文本内容） */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
    .replace(/[_*\`~]/g, '')
}

/** 智能分片：切片终点避开未闭合的 Markdown 符号（* _ \`） */
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

/** MarkdownV2 智能转义（Telegram 方言：不支持 # 标题 / - 列表 / > 引用） */
function toMarkdownV2(text: string): string {
  const placeholders: string[] = []
  const protect = (m: string): string => { placeholders.push(m); return '§§' + String(placeholders.length - 1) + '§§' }
  const escapeContent = (s: string): string => s.replace(/([-_\[\]()~\`>#+\-=|{}.!\\])/g, '\\$1')
  text = text.replace(/```[^\n]*\n[\s\S]*?\```/g, protect)
  text = text.replace(/`[^`\n]+`/g, protect)
  text = text.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (m: string, p1: string, p2: string) => protect('[' + escapeContent(p1) + '](' + escapeContent(p2) + ')'))
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (m: string, p1: string) => protect('*' + escapeContent(p1) + '*'))
  text = text.replace(/\*([^*\n]+)\*/g, (m: string, p1: string) => protect('_' + escapeContent(p1) + '_'))
  text = text.replace(/([_*\[\]()~\`>#+\-=|{}.!\\])/g, '\\$1')
  return text.replace(/§§(\d+)§§/g, (m: string, i: string) => placeholders[Number(i)] ?? m)
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

// ════════════════════════ 主插件 ════════════════════════

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-agent-telegram')
  tgLog('info', 'apply (HMR probe)', 'inbound=' + String(config.inboundEnabled) + ' outbound=' + String(config.outboundEnabled))

  // ── 共享状态：owner / offset / pending（inbound 用） + outbox（outbound 用） ──
  let ownerChatId: number | null = config.ownerChatId ?? null
  try {
    if (ownerChatId === null && existsSync(ownerFile())) {
      const saved = JSON.parse(readFileSync(ownerFile(), 'utf8')) as { ownerChatId?: number }
      if (typeof saved.ownerChatId === 'number') ownerChatId = saved.ownerChatId
    }
  } catch { /* 损坏忽略 */ }

  // ── Telegram API 原语（共享：poll 用超时 90s，send 用 30s + 重试） ──
  async function apiCall<T>(method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number; retry?: boolean }): Promise<T | null> {
    const timeoutMs = opts?.timeoutMs ?? 30000
    const doRetry = opts?.retry ?? false
    const maxRetries = config.maxRetries ?? 3
    const retryBackoffMs = config.retryBackoffMs ?? 1500
    let lastErr = ''
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = (await fetch(API + config.botToken + '/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs),
        })) as unknown as {
          ok: boolean
          status: number
          text(): Promise<string>
          json(): Promise<{ ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }>
        }
        if (res.ok) {
          const json = await res.json()
          if (json.ok && json.result !== undefined) return json.result
          if (json.description !== undefined) {
            if (json.description.includes('Too Many Requests') && doRetry) {
              const retryAfter = json.parameters?.retry_after ?? 2
              tgLog('warn', '429 限流', 'attempt=' + attempt + ' retry_after=' + retryAfter)
              await new Promise((r) => setTimeout(r, retryAfter * 1000))
              continue
            }
            lastErr = json.description
            return null
          }
          return null
        }
        lastErr = 'HTTP ' + res.status
        if (doRetry) tgLog('warn', 'api ' + method + ' HTTP ' + res.status, 'attempt=' + attempt)
      } catch (e) {
        lastErr = String(e)
        if (doRetry) tgLog('warn', 'api ' + method + ' 网络错误', 'attempt=' + attempt + ' ' + lastErr)
      }
      if (doRetry && attempt < maxRetries) {
        const backoff = retryBackoffMs * Math.pow(2, attempt)
        await new Promise((r) => setTimeout(r, backoff))
      } else if (!doRetry) {
        break
      }
    }
    if (doRetry) tgLog('warn', 'api ' + method + ' 重试耗尽', lastErr)
    return null
  }

  // 发送（分片 + MarkdownV2 降级链）：返回 message_id 或 null
  async function sendText(chatId: number, text: string, plain = false, retry = false): Promise<number | null> {
    if (text.length === 0) return null
    const limit = Math.min(4096, config.maxReplyChars ?? 3800)
    const chunks = plain ? [text] : smartChunks(text, limit)
    let firstId: number | null = null
    for (const chunk of chunks) {
      if (plain) {
        const r = await apiCall<{ message_id: number }>('sendMessage', { chat_id: chatId, text: chunk }, { retry })
        if (r === null) return null
        firstId = r.message_id
        continue
      }
      let r = await apiCall<{ message_id: number }>('sendMessage', {
        chat_id: chatId, text: toMarkdownV2(chunk), parse_mode: 'MarkdownV2',
      }, { retry })
      if (r === null) r = await apiCall<{ message_id: number }>('sendMessage', { chat_id: chatId, text: stripMarkdown(chunk) }, { retry })
      if (r === null) return null
      firstId = r.message_id
    }
    return firstId
  }

  // ════════════════════════ Inbound：长轮询 + 注入 + 回传 ════════════════════════
  let offset = 0
  let stopped = false
  let pending: { chatId: number; messageId: number; sessionId?: string } | null = null
  let typingTimer: NodeJS.Timeout | null = null
  let polling = false
  const TYPING_TTL_MS = 15000
  let lastGoodSessionId: string | null = null

  try {
    const saved = JSON.parse(readFileSync(offsetFile(), 'utf8')) as { offset?: number }
    if (typeof saved.offset === 'number' && saved.offset > 0) offset = saved.offset
  } catch { /* 无记录或损坏忽略 */ }

  function savePending(): void {
    if (pending === null) return
    try {
      writeFileSync(pendingFile(), JSON.stringify({ chatId: pending.chatId, messageId: pending.messageId, sessionId: pending.sessionId, at: new Date().toISOString() }), 'utf8')
    } catch { /* 持久化失败忽略 */ }
  }
  function clearPending(): void {
    pending = null
    if (typingTimer !== null) { clearInterval(typingTimer); typingTimer = null }
    try { rmSync(pendingFile(), { force: true }) } catch { /* 忽略 */ }
  }
  function startTyping(chatId: number): void {
    if (typingTimer !== null) { clearInterval(typingTimer); typingTimer = null }
    const startedAt = Date.now()
    typingTimer = setInterval(() => {
      if (pending === null) return
      if (Date.now() - startedAt > TYPING_TTL_MS) {
        if (typingTimer !== null) { clearInterval(typingTimer); typingTimer = null }
        return
      }
      void apiCall<unknown>('sendChatAction', { chat_id: pending.chatId, action: 'typing' })
    }, 4000)
  }

  // 恢复持久化 pending（哨兵重启不丢回传目标）
  try {
    const saved = JSON.parse(readFileSync(pendingFile(), 'utf8')) as { chatId?: number; messageId?: number; sessionId?: string }
    if (typeof saved.chatId === 'number' && typeof saved.messageId === 'number' && typeof saved.sessionId === 'string') {
      pending = { chatId: saved.chatId, messageId: saved.messageId, sessionId: saved.sessionId }
      tgLog('info', '恢复 pending', 'chat=' + saved.chatId + ' mid=' + saved.messageId + ' session=' + saved.sessionId)
      startTyping(saved.chatId)
    }
  } catch { /* 无记录或损坏忽略 */ }

  // 目标会话解析：追踪最新活跃主会话（带缓存兜底）
  function resolveTargetSessionId(): string | null {
    if (config.mainSessionId !== undefined) return config.mainSessionId
    let best: { id: string; time: number } | null = null
    for (const s of ctx.sessions.list()) {
      if ((s.header?.delegationDepth ?? 0) !== 0) continue
      const events = s.events
      const lastTime = events.length > 0 ? (events[events.length - 1]?.time ?? 0) : 0
      if (best === null || lastTime > best.time) best = { id: s.id, time: lastTime }
    }
    if (best !== null) { lastGoodSessionId = best.id; return best.id }
    if (lastGoodSessionId !== null) {
      tgLog('info', '目标会话兜底', 'use cached session=' + lastGoodSessionId)
      return lastGoodSessionId
    }
    return null
  }

  // 事件：assistant 回复 → 回传 Telegram
  ctx.on('session/event', (session, event) => {
    const ev = event as { type?: string; data?: { message?: Message } }
    if (ev.type === 'user/message' || ev.type === 'assistant/message') {
      tgLog('info', '会话事件', 'type=' + ev.type + ' session=' + session.id + ' pending=' + (pending !== null ? 'yes' : 'no'))
    }
    if (pending === null) return
    if (pending.sessionId !== undefined && session.id !== pending.sessionId) return
    if (ev.type !== 'assistant/message') return
    const message = ev.data?.message
    const blocks = message?.content ?? []
    const text = summarizeBlocks(message)
    const toolNames = blocks
      .filter((b) => b.type === 'tool-call')
      .map((b) => (b as { name?: string }).name ?? '?')
    if (toolNames.length > 0) {
      if (toolNames.includes('telegram_send') && pending !== null) {
        tgLog('info', '检测到 telegram_send 工具调用，清除 pending+typing', 'chat=' + pending.chatId)
        clearPending()
        return
      }
      const live = (text.trim().length > 0 ? stripMarkdown(text).slice(0, 800) + '\n' : '') + '（工具：' + toolNames.join(', ') + '）'
      tgLog('info', '中间消息直播', 'len=' + live.length)
      void sendText(pending.chatId, live, true)
      return
    }
    if (text.trim().length === 0) return
    const target = pending
    clearPending()
    if (typingTimer !== null) { clearInterval(typingTimer); typingTimer = null }
    tgLog('info', '回复回传', 'chat=' + target.chatId + ' len=' + text.length)
    void sendText(target.chatId, text).then((ok) => {
      if (ok === null) tgLog('warn', '回复回传失败', 'chat=' + target.chatId)
    })
  })

  // 消息处理（inbound）
  function handleUpdate(chatId: number, messageId: number, text: string): void {
    if (ownerChatId === null) {
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
      void sendText(chatId, statusText())
      return
    }
    if (trimmed === '/help' || trimmed === '/start') {
      void sendText(chatId, helpText())
      return
    }
    if (trimmed === '/ping') {
      void sendText(chatId, 'pong ' + new Date().toISOString())
      return
    }
    if (trimmed === '/sessions') {
      const lines = ctx.sessions.list().map((s) => {
        const dep = s.header?.delegationDepth ?? 0
        return (dep === 0 ? '*' : ' ') + s.id + ' ev=' + s.events.length
      })
      void sendText(chatId, '会话列表 (' + lines.length + '，*主会话):\n' + (lines.join('\n') || '（空）'))
      return
    }
    if (trimmed === '/context') {
      const targetId = resolveTargetSessionId()
      const s = targetId !== null ? ctx.sessions.list().find((x) => x.id === targetId) : undefined
      if (s === undefined) { void sendText(chatId, '无活跃会话'); return }
      const events = s.events
      const last = events.length > 0 ? new Date(events[events.length - 1]?.time ?? 0).toISOString() : '-'
      const msgCount = events.filter((e) => (e as { type?: string }).type === 'user/message' || (e as { type?: string }).type === 'assistant/message').length
      void sendText(chatId, '上下文 ' + targetId + '\nevents=' + events.length + ' msgs=' + msgCount + '\nlast=' + last)
      return
    }
    if (trimmed.startsWith('/content')) {
      const n = Number(trimmed.split(/\s+/)[1] ?? '3')
      const k = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 20) : 3
      const targetId = resolveTargetSessionId()
      const s = targetId !== null ? ctx.sessions.list().find((x) => x.id === targetId) : undefined
      if (s === undefined) { void sendText(chatId, '无活跃会话'); return }
      const msgs: string[] = []
      for (const ev of s.events) {
        const type = (ev as { type?: string }).type
        if (type !== 'user/message' && type !== 'assistant/message') continue
        const msg = (ev as { data?: { message?: Message } }).data?.message
        const text = summarizeBlocks(msg).trim().slice(0, 300)
        if (text.length === 0) continue
        msgs.push((type === 'user/message' ? '[用户] ' : '[爱丽丝] ') + text)
      }
      const tail = msgs.slice(-k)
      void sendText(chatId, '最近 ' + tail.length + ' 条消息:\n' + (tail.join('\n---\n') || '（无文本消息）'))
      return
    }

    const targetId = resolveTargetSessionId()
    if (targetId === null) {
      void sendText(chatId, '当前没有可注入的活跃会话（sessions 为空）')
      return
    }
    const agent = ctx.agents.get(targetId as never)
    if (agent === undefined) {
      void sendText(chatId, '目标会话不可用（' + targetId + '）')
      return
    }
    tgLog('info', '收到消息', 'chat=' + chatId + ' mid=' + messageId + ' session=' + targetId + ' text=' + trimmed.slice(0, 80))
    pending = { chatId, messageId, sessionId: targetId }
    savePending()
    startTyping(chatId)
    try {
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

  async function pollOnce(): Promise<void> {
    const updates = await apiCall<{
      update_id: number
      message?: { chat?: { id?: number }; message_id?: number; text?: string }
    }[]>('getUpdates', {
      offset: offset === 0 ? undefined : offset,
      timeout: config.pollTimeoutMs,
      allowed_updates: ['message'],
    }, { timeoutMs: 90000 })
    if (updates === null) {
      tgLog('warn', 'getUpdates 返回 null（API 异常，含 409 冲突）')
      return
    }
    if (updates.length > 0) tgLog('info', 'getUpdates 收到', 'count=' + updates.length)
    for (const u of updates) {
      if (u.update_id < offset) continue
      const chatId = u.message?.chat?.id
      const messageId = u.message?.message_id
      const text = u.message?.text
      if (chatId === undefined || messageId === undefined || text === undefined) continue
      try {
        handleUpdate(chatId, messageId, text)
        offset = Math.max(offset, u.update_id + 1)
        try {
          writeFileSync(offsetFile(), JSON.stringify({ offset, updatedAt: new Date().toISOString() }), 'utf8')
        } catch { /* 持久化失败忽略 */ }
      } catch (e) {
        tgLog('warn', 'handleUpdate 异常（保留 offset 下轮重试）', String(e))
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      if (!polling) {
        polling = true
        try { await pollOnce() } catch (e) { tgLog('warn', 'poll 异常', String(e)) }
        finally { polling = false }
      }
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  function statusText(): string {
    const now = new Date().toISOString()
    const targetId = resolveTargetSessionId()
    const agent = targetId !== null ? ctx.agents.get(targetId as never) : undefined
    return (
      '八千代在线 ' + now +
      '\n目标会话: ' + (targetId ?? '（无）') + (agent !== undefined ? ' (可用)' : ' (不可用)') +
      '\nagent 状态: ' + (agent !== undefined ? String(agent.status) : '?') +
      '\nowner chat: ' + String(ownerChatId ?? '未绑定') +
      '\npoll offset: ' + offset + (pending !== null ? ' | pending 回复中' : '') +
      '\noutbox 待发: ' + outbox.length
    )
  }

  function helpText(): string {
    return (
      '八千代 Telegram 远程\n' +
      '/status 状态\n' +
      '/ping 心跳\n' +
      '/sessions 会话列表\n' +
      '/context 上下文压力（events/消息数）\n' +
      '/content [n] 最近 n 条消息摘要（默认 3）\n' +
      '其他消息 → 注入主会话（空闲=正常对话；忙碌=实时干预）'
    )
  }

  // ════════════════════════ Outbound：工具 + outbox ════════════════════════
  interface OutboxItem { id: string; chatId: number; text: string; plain: boolean; createdAt: string; attempts: number }
  let outbox: OutboxItem[] = []
  let outboxDirty = false
  let flushing = false

  const obPath = () => config.outboxPath ?? outboxFile()
  function loadOutbox(): void {
    try {
      if (existsSync(obPath())) {
        const saved = JSON.parse(readFileSync(obPath(), 'utf8')) as { items?: OutboxItem[] }
        if (Array.isArray(saved.items)) outbox = saved.items
      }
    } catch (e) { tgLog('warn', 'outbox 载入失败', String(e)) }
    if (outbox.length > 0) tgLog('info', 'outbox 恢复', 'count=' + outbox.length)
  }
  function saveOutbox(): void {
    outboxDirty = false
    try {
      writeFileSync(obPath(), JSON.stringify({ items: outbox, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    } catch (e) { tgLog('warn', 'outbox 持久化失败', String(e)) }
  }
  function enqueue(chatId: number, text: string, plain: boolean): void {
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    outbox.push({ id, chatId, text, plain, createdAt: new Date().toISOString(), attempts: 0 })
    outboxDirty = true
    saveOutbox()
    tgLog('info', '已入 outbox（防丢失）', 'id=' + id + ' len=' + text.length)
  }

  async function flushOutbox(): Promise<void> {
    if (flushing) return
    flushing = true
    try {
      if (outbox.length === 0) return
      const pendingItems = [...outbox]
      outbox = []
      const stillFail: OutboxItem[] = []
      for (const item of pendingItems) {
        const r = await sendText(item.chatId, item.text, item.plain, true)
        if (r !== null) {
          tgLog('info', 'outbox 重发成功', 'id=' + item.id)
        } else {
          item.attempts += 1
          if (item.attempts < 5) stillFail.push(item)
          else tgLog('warn', 'outbox 弃置（重试超限）', 'id=' + item.id)
        }
      }
      if (stillFail.length > 0) {
        outbox = [...stillFail, ...outbox]
        tgLog('warn', 'outbox 仍失败', 'count=' + stillFail.length)
      }
      outboxDirty = true
      saveOutbox()
    } finally {
      flushing = false
    }
  }

  async function push(chatId: number, text: string, plain: boolean): Promise<{ ok: boolean; messageId?: number; queued: boolean; error?: string }> {
    if (text.length === 0) return { ok: true, queued: false }
    const r = await sendText(chatId, text, plain, true)
    if (r !== null) return { ok: true, messageId: r, queued: false }
    enqueue(chatId, text, plain)
    return { ok: false, queued: true, error: '即时发送失败，已入 outbox 保底重发' }
  }

  // 工具注册（outbound）
  if (config.outboundEnabled !== false) {
    ctx.tools.register(defineTool({
      name: 'telegram_send',
      description: '主动发送一条 Telegram 消息给主人（可靠 outbound：429 退避/重试/失败入 outbox 防丢失/4096 分片/MarkdownV2 自动降级）。plain=true 走纯文本（直播/进度播报推荐）；plain=false 走 MarkdownV2 渲染。',
      parameters: {
        text: { type: 'string', description: '消息正文（可含 Markdown；>4096 自动分片）', required: true },
        plain: { type: 'boolean', description: 'true=纯文本直发（推荐直播用）；缺省 false=MarkdownV2 渲染' },
        chat_id: { type: 'number', description: '目标 chat id（缺省=owner 白名单）' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, messageId: { type: 'number' }, queued: { type: 'boolean' }, error: { type: 'string' } } }, render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '已发送' + (v.messageId !== undefined ? ' (msg ' + v.messageId + ')' : '') : '发送失败：' + (v.queued ? '已入 outbox 保底' : (v.error ?? '未知')) }] },
      async execute(args: { text: string; plain?: boolean; chat_id?: number }) {
        if (ownerChatId === null) {
          return { ok: false, error: 'owner 未绑定：请在配置 ownerChatId 或先发一条消息完成绑定' }
        }
        const chatId = args.chat_id ?? ownerChatId
        const plain = args.plain ?? false
        logger.info('send ' + (plain ? 'plain' : 'mdv2') + ' chat=' + chatId + ' len=' + args.text.length)
        return await push(chatId, args.text, plain)
      },
    }))

    ctx.tools.register(defineTool({
      name: 'telegram_status',
      description: 'Telegram outbound 通道诊断：owner 绑定、outbox 待发队列、通道健康。发消息前可先查。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, ownerBound: { type: 'boolean' }, ownerChatId: { type: 'number' }, outboxPending: { type: 'number' }, botPrefix: { type: 'string' } } }, render: (_a: unknown, v: any) => [{ type: 'text', text: 'owner=' + (v.ownerBound ? String(v.ownerChatId) : '未绑定') + ' outbox=' + v.outboxPending }] },
      async execute() {
        return {
          ok: ownerChatId !== null,
          ownerBound: ownerChatId !== null,
          ownerChatId: ownerChatId ?? undefined,
          outboxPending: outbox.length,
          botPrefix: config.botToken.slice(0, 8),
        }
      },
    }))
  }

  // ════════════════════════ 生命周期 ════════════════════════
  if (config.outboundEnabled !== false) loadOutbox()

  // HMR/卸载清理：清 typing 心跳 + pending 内存态
  ctx.effect(() => () => {
    if (typingTimer !== null) { clearInterval(typingTimer); typingTimer = null }
    pending = null
  }, 'dsh-agent-telegram lifecycle cleanup')

  // 启动：inbound 轮询 + outbound flush
  ctx.effect(() => {
    stopped = false
    if (config.outboundEnabled !== false && outbox.length > 0) {
      tgLog('info', '启动 flush outbox', 'count=' + outbox.length)
      void flushOutbox()
    }
    if (config.inboundEnabled !== false) {
      tgLog('info', 'loop start', 'delay=' + String(config.startDelayMs ?? 5000) + 'ms offset=' + offset)
      setTimeout(() => {
        if (stopped) return
        void loop()
      }, config.startDelayMs ?? 5000)
    }
    const flushTimer = setInterval(() => {
      if (outbox.length > 0) void flushOutbox()
    }, config.flushIntervalMs ?? 60000)
    return () => {
      stopped = true
      clearInterval(flushTimer)
      if (outboxDirty) saveOutbox()
      tgLog('info', 'loop stop')
    }
  })

  tgLog('info', 'ready', 'bot=' + config.botToken.slice(0, 8) + '… inbound=' + String(config.inboundEnabled) + ' outbound=' + String(config.outboundEnabled) + ' owner=' + String(ownerChatId ?? '未绑定') + ' outbox=' + outbox.length)
}
