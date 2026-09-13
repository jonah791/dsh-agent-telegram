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
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { decideColdAlertPush, type ColdStartAlertPayload } from './cold-alert.ts'

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
  /** telegram_ask 单题等待超时 ms（缺省 600000=10 分钟） */
  askTimeoutMs?: number
  /** 会话不可用期间消息重试投递的总时限 ms（缺省 300000=5 分钟） */
  retryMaxMs?: number
  /** telegram_ask 是否启用（缺省 true） */
  askEnabled?: boolean
  /** coldstart 告警文件路径（缺省 $DSH_HOME/life-core/coldstart-alert.json） */
  coldstartAlertPath?: string
  /** coldstart 告警轮询间隔 ms（缺省 60000） */
  coldstartWatchIntervalMs?: number
}
export const Config = z.object({
  // botToken 单一来源（2026-09-06）：config 可选（空 → apply 里读 .credentials.yaml refs.TELEGRAM_BOT_TOKEN 兜底）
  botToken: z.string().default(''),
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
  askTimeoutMs: z.number().default(600000),
  retryMaxMs: z.number().default(300000),
  askEnabled: z.boolean().default(true),
  coldstartAlertPath: z.string().required(false),
  coldstartWatchIntervalMs: z.number().default(60000),
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
  // botToken 单一来源（2026-09-06 凭据迁移）：config 优先（兼容旧配置）→ .credentials.yaml refs 兜底。
  // .credentials.yaml 在 DSH_HOME（不入 git），patch config 会被 git 跟踪——凭据迁移到文件更安全。
  if (!config.botToken) {
    try {
      const cred = readFileSync(join(homeDir(), '.credentials.yaml'), 'utf8')
      // YAML 字符串值可能带引号（"..." 或 '...'）——清洗后才是真实 token（2026-09-07 修复：引号污染导致 404）
      const m = cred.match(/^\s*TELEGRAM_BOT_TOKEN:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/m)
      const raw = (m && (m[1] ?? m[2] ?? m[3])) ?? ''
      if (raw) {
        config.botToken = raw
        tgLog('info', 'botToken 来自 .credentials.yaml（config 为空）')
      }
    } catch { /* 无凭据文件：保持 config 值 */ }
  }
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

  // ════════════════════════ 文件传输（outbound） ════════════════════════

  const TG_FILE_MAX = 50 * 1024 * 1024 // Telegram Bot API 单文件上传上限 50MB

  /** 按扩展名选 Telegram 发送方法 */
  function fileMethod(path: string): { method: string; field: string; kind: string } {
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) return { method: 'sendPhoto', field: 'photo', kind: 'photo' }
    if (['gif'].includes(ext)) return { method: 'sendAnimation', field: 'animation', kind: 'animation' }
    if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return { method: 'sendVideo', field: 'video', kind: 'video' }
    if (['mp3', 'm4a', 'ogg', 'wav', 'opus', 'flac'].includes(ext)) return { method: 'sendAudio', field: 'audio', kind: 'audio' }
    return { method: 'sendDocument', field: 'document', kind: 'document' }
  }

  /** 发送本地文件（multipart 上传，429 退避重试）；返回 ok/messageId/kind/error */
  async function sendFile(chatId: number, filePath: string, caption?: string): Promise<{ ok: boolean; messageId?: number; error?: string; kind: string }> {
    let st: { size: number; isFile(): boolean }
    try {
      st = statSync(filePath)
    } catch {
      return { ok: false, error: '文件不存在或不可读: ' + filePath, kind: 'document' }
    }
    if (!st.isFile()) return { ok: false, error: '不是文件: ' + filePath, kind: 'document' }
    if (st.size > TG_FILE_MAX) return { ok: false, error: '文件超过 50MB 上限: ' + Math.round(st.size / 1048576) + 'MB', kind: 'document' }
    const { method, field, kind } = fileMethod(filePath)
    const filename = basename(filePath)
    const maxRetries = config.maxRetries ?? 3
    const retryBackoffMs = config.retryBackoffMs ?? 1500
    let lastErr = ''
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const buf = readFileSync(filePath)
        const form = new FormData()
        form.append(field, new Blob([buf]), filename)
        form.append('chat_id', String(chatId))
        if (caption) form.append('caption', caption.slice(0, 1024))
        const res = (await fetch(API + config.botToken + '/' + method, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(120000),
        })) as unknown as {
          ok: boolean
          status: number
          json(): Promise<{ ok: boolean; result?: { message_id?: number }; description?: string; parameters?: { retry_after?: number } }>
        }
        const json: { ok: boolean; result?: { message_id?: number }; description?: string; parameters?: { retry_after?: number } } =
          await res.json().catch(() => ({ ok: false, description: '响应非 JSON' }))
        if (res.ok && json.ok && json.result?.message_id !== undefined) {
          tgLog('info', 'sendFile 成功', method + ' ' + filename + ' mid=' + json.result.message_id)
          return { ok: true, messageId: json.result.message_id, kind }
        }
        if (json.description?.includes('Too Many Requests')) {
          const retryAfter = json.parameters?.retry_after ?? 2
          tgLog('warn', 'sendFile 429', 'attempt=' + attempt + ' retry_after=' + retryAfter)
          await new Promise((r) => setTimeout(r, retryAfter * 1000))
          continue
        }
        lastErr = json.description ?? ('HTTP ' + res.status)
        tgLog('warn', 'sendFile 失败', method + ' ' + lastErr)
        return { ok: false, error: lastErr, kind }
      } catch (e) {
        lastErr = String(e)
        tgLog('warn', 'sendFile 网络错误', 'attempt=' + attempt + ' ' + lastErr)
      }
      if (attempt < maxRetries) {
        const backoff = retryBackoffMs * Math.pow(2, attempt)
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
    return { ok: false, error: lastErr || '未知错误', kind }
  }

  // ════════════════════════ Inbound：长轮询 + 注入 + 回传 ════════════════════════
  let offset = 0
  let stopped = false
  let pollFailCount = 0 // 2026-09-07：getUpdates 连续失败计数（退避防日志风暴）
  let pending: { chatId: number; messageId: number; sessionId?: string } | null = null
  let typingTimer: NodeJS.Timeout | null = null
  let polling = false
  const TYPING_TTL_MS = 15000
  let lastGoodSessionId: string | null = null

  // ── 会话不可用重试队列（2026-09-07：重启窗口期 agent 未激活时消息被直接丢弃 →
  //    入队轮询重试，agent 就绪后自动补投；retryMaxMs 上限防无限占内存） ──
  interface RetryItem { chatId: number; messageId: number; text: string; deadline: number }
  const retryQueue: RetryItem[] = []
  let retryTimer: NodeJS.Timeout | null = null

  // ── telegram_ask：电报提问等待状态机（2026-09-07 新增）
  //    发问题给 owner → 挂起等待回复 → 把答案作为工具结果返回（不注入会话） ──
  interface AskItem {
    id: string
    question: string
    header?: string
    options?: { label: string; description?: string }[]
    multiSelect: boolean
  }
  let activeAsk: {
    items: AskItem[]
    index: number
    answers: { id: string; selected: string[]; custom?: string }[]
    resolve: (v: { answers: { id: string; selected: string[]; custom?: string }[] }) => void
    reject: (e: Error) => void
    questionMsgId: number | null
    deadline: number
    timer: NodeJS.Timeout | null
    chatId: number
  } | null = null

  function clearRetryTimer(): void {
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
  }
  function pumpRetryQueue(): void {
    clearRetryTimer()
    if (retryQueue.length === 0) return
    const now = Date.now()
    // 清掉超时项
    for (let i = retryQueue.length - 1; i >= 0; i--) {
      if (retryQueue[i]!.deadline <= now) {
        tgLog('warn', '重试队列丢弃（超时）', 'text=' + retryQueue[i]!.text.slice(0, 60))
        retryQueue.splice(i, 1)
      }
    }
    if (retryQueue.length === 0) return
    const item = retryQueue[0]!
    const targetId = tryDeliver(item.chatId, item.messageId, item.text)
    if (targetId !== null) {
      retryQueue.shift()
      tgLog('info', '重试队列投递成功', 'session=' + targetId + ' 剩余=' + retryQueue.length)
    }
    if (retryQueue.length > 0) retryTimer = setTimeout(pumpRetryQueue, 2000)
  }

  /** 生成当前提问的展示文本（含已答/剩余） */
  function askRender(a: NonNullable<typeof activeAsk>): string {
    const cur = a.items[a.index]!
    const lines: string[] = []
    if (cur.header) lines.push('【' + cur.header + '】')
    lines.push('(' + (a.index + 1) + '/' + a.items.length + ') ' + cur.question)
    if (cur.options && cur.options.length > 0) {
      cur.options.forEach((o, i) => {
        lines.push('  ' + (i + 1) + '. ' + o.label + (o.description ? ' — ' + o.description : ''))
      })
      lines.push(cur.multiSelect ? '（可多选：回复 1,3 或 全部）' : '（回复序号选择；或直接输入自定义答案）')
      if (cur.options.some((o) => o.label.toLowerCase().includes('recommended'))) {
        lines.push('（推荐项已标注）')
      }
    }
    lines.push('回复 /cancel 取消本次提问')
    return lines.join('\n')
  }

  /** 解析主人对当前问题的回复 → answers 推进；返回 null 表示解析失败（让主人重答） */
  function askConsume(a: NonNullable<typeof activeAsk>, text: string): { answers: { id: string; selected: string[]; custom?: string }[] } | null {
    const cur = a.items[a.index]!
    const t = text.trim()
    const ans: { id: string; selected: string[]; custom?: string } = { id: cur.id, selected: [] }
    // 序号选择：1 / 1,3 / 1 3 → 选项 index
    if (cur.options && cur.options.length > 0) {
      const sel: number[] = []
      const parts = t.split(/[\s,，、;；]+/).filter(Boolean)
      let allMatched = true
      for (const p of parts) {
        const n = Number(p)
        if (Number.isInteger(n) && n >= 1 && n <= cur.options.length) {
          sel.push(n - 1)
        } else {
          const li = cur.options.findIndex((o) => o.label === t || o.label.toLowerCase() === t.toLowerCase())
          if (li >= 0) { sel.push(li); break }
          allMatched = false
          break
        }
      }
      if (allMatched && sel.length > 0) {
        const unique = [...new Set(sel)]
        if (!cur.multiSelect && unique.length > 1) return null // 单选却给多序号
        ans.selected = unique.map((i) => cur.options![i]!.label)
      } else if (t.toLowerCase() === '全部' || t === 'all') {
        if (cur.multiSelect) {
          ans.selected = cur.options.map((o) => o.label)
        } else { return null }
      } else if (/^\/cancel$/i.test(t)) {
        return { answers: a.answers.concat([{ id: cur.id, selected: [], custom: '/cancel' }]) }
      } else {
        // 自由文本 → custom
        ans.custom = t
        ans.selected = []
      }
    } else {
      if (/^\/cancel$/i.test(t)) return { answers: a.answers.concat([{ id: cur.id, selected: [], custom: '/cancel' }]) }
      ans.custom = t
      ans.selected = []
    }
    return { answers: a.answers.concat([ans]) }
  }

  /** 收尾：resolve/reject activeAsk + 清 timer */
  function finishAsk(v: { answers: { id: string; selected: string[]; custom?: string }[] } | Error): void {
    const a = activeAsk
    if (a === null) return
    activeAsk = null
    if (a.timer !== null) { clearTimeout(a.timer); a.timer = null }
    if (v instanceof Error) a.reject(v)
    else a.resolve(v)
  }

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
  // 2026-09-02 修复：pending 恢复不得绕过 mainSessionId——若配置了主会话且
  // saved.sessionId 与之不符（幽灵会话误选残留），以 mainSessionId 为准并丢弃旧 pending。
  try {
    const saved = JSON.parse(readFileSync(pendingFile(), 'utf8')) as { chatId?: number; messageId?: number; sessionId?: string }
    if (typeof saved.chatId === 'number' && typeof saved.messageId === 'number' && typeof saved.sessionId === 'string') {
      const sessionId = config.mainSessionId !== undefined ? config.mainSessionId : saved.sessionId
      if (sessionId !== saved.sessionId) {
        tgLog('warn', 'pending session 与 mainSessionId 不符，改用主会话', 'saved=' + saved.sessionId + ' main=' + sessionId)
      }
      pending = { chatId: saved.chatId, messageId: saved.messageId, sessionId }
      tgLog('info', '恢复 pending', 'chat=' + saved.chatId + ' mid=' + saved.messageId + ' session=' + sessionId)
      startTyping(saved.chatId)
    }
  } catch { /* 无记录或损坏忽略 */ }

  // 目标会话解析：追踪「最近收到真实 GUI 用户消息」的主会话。
  //
  // 2026-09-03 修复（错投旧会话根因）：
  //   旧实现按「最后任意事件时间」选目标——telegram 自己注入旧会话 → 旧会话事件变新 →
  //   下次又选它（自我强化循环）；且 patch 硬编码 mainSessionId 指向 9/2 的 GUI 主会话，
  //   今天 GUI 切到新会话后失效。
  //   新实现：只认 source.kind==='user' 的真实 GUI 用户消息（telegram 注入是 plugin 源，
  //   不参与判定），实时从 session/event 监听更新 lastUserPromptAt，选择最新者。
  let lastUserPromptAt = 0
  let lastUserSessionId: string | null = null

  ctx.on('session/event', (session, event) => {
    const ev = event as { type?: string; data?: { source?: { kind?: string } } }
    if (ev.type === 'user/message' && ev.data?.source?.kind === 'user') {
      const t = (event as { time?: number }).time ?? Date.now()
      if (t >= lastUserPromptAt) {
        lastUserPromptAt = t
        lastUserSessionId = session.id
      }
    }
  })

  function resolveTargetSessionId(): string | null {
    // ① 显式 mainSessionId（config 直配，如主人想钉死某会话）
    if (config.mainSessionId !== undefined) return config.mainSessionId
    // ② 实时监听到的真实用户会话（本进程内最新）
    if (lastUserSessionId !== null && lastUserPromptAt > 0) {
      const agentLive = ctx.agents.get(lastUserSessionId as never)
      if (agentLive !== undefined) return lastUserSessionId
    }
    // ③ 兜底：扫全部顶层会话，找最后一条 source.kind==='user' 消息所在会话
    let best: { id: string; time: number } | null = null
    for (const s of ctx.sessions.list()) {
      if ((s.header?.delegationDepth ?? 0) !== 0) continue
      const events = s.events
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i] as { type?: string; data?: { source?: { kind?: string } }; time?: number }
        if (ev.type !== 'user/message') continue
        if (ev.data?.source?.kind !== 'user') continue
        const t = ev.time ?? 0
        if (best === null || t > best.time) best = { id: s.id, time: t }
        break // 每个会话只看最后一条真实用户消息
      }
    }
    if (best !== null) {
      lastUserSessionId = best.id
      lastUserPromptAt = best.time
      return best.id
    }
    // ④ 最后的兜底：无任何真实用户消息时回退旧缓存
    if (lastGoodSessionId !== null) {
      tgLog('info', '目标会话兜底', 'use cached session=' + lastGoodSessionId)
      return lastGoodSessionId
    }
    // ⑤ 重启恢复：从持久化 pending 文件恢复主会话（重启后内存态清零，
    //    但 telegram-pending.json 记录了上次注入的会话——2026-09-07 修复）
    try {
      const saved = JSON.parse(readFileSync(pendingFile(), 'utf8')) as { sessionId?: string; chatId?: number; messageId?: number }
      if (typeof saved.sessionId === 'string' && saved.sessionId.length > 0) {
        const agentLive = ctx.agents.get(saved.sessionId as never)
        if (agentLive !== undefined) {
          tgLog('info', '目标会话恢复', 'from pending file session=' + saved.sessionId)
          lastGoodSessionId = saved.sessionId
          return saved.sessionId
        }
        // pending 会话 agent 未激活（会话文件在但 agent 未挂载）——
        // 不直接返回，继续尝试其他活跃 agent；同时记日志便于诊断
        tgLog('warn', '目标会话恢复跳过', 'pending session=' + saved.sessionId + ' agent 未激活')
      }
    } catch { /* 无记录或损坏忽略 */ }
    // ⑥ 最终兜底：扫全部活跃 agent，任选一个（重启后 GUI 主会话未激活时，
    //    仍要保证 telegram 消息能注入——2026-09-07 修复）
    const liveAgents = ctx.agents.list()
    if (liveAgents.length > 0) {
      const pick = liveAgents[0]!
      const pickId = String(pick.id ?? pick)
      tgLog('info', '目标会话兜底', 'use live agent session=' + pickId)
      lastGoodSessionId = pickId
      return pickId
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

    // ── telegram_ask 提问中：owner 普通消息 = 当前问题答案（不注入会话；命令已在上方优先处理） ──
    if (activeAsk !== null) {
      if (activeAsk.chatId !== chatId) return
      if (/^\/cancel$/i.test(trimmed)) {
        tgLog('info', 'ask 被 /cancel', 'chat=' + chatId + ' 已答=' + activeAsk.answers.length + '/' + activeAsk.items.length)
        void sendText(chatId, '已取消提问。')
        finishAsk(new Error('the user cancelled telegram_ask'))
        return
      }
      const step = askConsume(activeAsk, trimmed)
      if (step === null) {
        void sendText(chatId, '无法解析（单选请只回一个序号；或直接输入自定义答案）。\n' + askRender(activeAsk))
        return
      }
      activeAsk.answers = step.answers
      activeAsk.index += 1
      if (activeAsk.index >= activeAsk.items.length) {
        const done = activeAsk.answers
        tgLog('info', 'ask 全部答完', 'count=' + done.length)
        finishAsk({ answers: done })
        return
      }
      void sendText(chatId, '收到。\n\n' + askRender(activeAsk))
      return
    }

    const targetId = tryDeliver(chatId, messageId, trimmed)
    if (targetId === null) {
      // 会话不可用：入重试队列（重启窗口期 agent 未激活时防丢消息）
      const retryMaxMs = config.retryMaxMs ?? 300000
      retryQueue.push({ chatId, messageId, text: trimmed, deadline: Date.now() + retryMaxMs })
      tgLog('warn', '会话不可用，入重试队列', 'text=' + trimmed.slice(0, 60) + ' 队列=' + retryQueue.length)
      void sendText(chatId, '（当前会话尚未就绪，消息已排队，稍后自动送达）')
      if (retryQueue.length === 1) pumpRetryQueue()
    }
  }

  /** 解析目标会话并注入主会话。成功返回 sessionId；失败（无可注入会话/agent 未激活）返回 null。 */
  function tryDeliver(chatId: number, messageId: number, trimmed: string): string | null {
    const targetId = resolveTargetSessionId()
    if (targetId === null) return null
    const agent = ctx.agents.get(targetId as never)
    if (agent === undefined) return null
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
      return targetId
    } catch (e) {
      clearPending()
      if (typingTimer !== null) { clearInterval(typingTimer); typingTimer = null }
      tgLog('error', '注入失败', 'chat=' + chatId + ' err=' + String(e))
      void sendText(chatId, '注入失败：' + String(e))
      return null
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
      // 2026-09-07 修复：失败退避防日志风暴（此前 200ms 死循环每秒刷 warn，日志 17MB）
      pollFailCount += 1
      const backoffMs = Math.min(pollFailCount * 2000, 60000)
      tgLog('warn', 'getUpdates 返回 null（API 异常，含 409 冲突）', 'fail#' + pollFailCount + ' backoff=' + backoffMs + 'ms')
      await new Promise((r) => setTimeout(r, backoffMs))
      return
    }
    pollFailCount = 0
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
    // 预检试运行实例（dsh-agent-preflight 以 DSH_PREFLIGHT_TRIAL=1 spawn 的完整 web）：
    // 跳过长轮询——两个实例轮询同一 bot 会 409 冲突，且后者的 getUpdates 可能吞掉主人的消息
    // （2026-09-13 实测 .watch-web.log 内 409 冲突与预检窗口同行）。插件本身照常加载（组合验证不受影响）。
    if (process.env.DSH_PREFLIGHT_TRIAL === '1') {
      tgLog('info', 'DSH_PREFLIGHT_TRIAL=1（预检试运行实例）→ 跳过 getUpdates 长轮询，避免与 live 实例争抢 bot')
      return
    }
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

    ctx.tools.register(defineTool({
      name: 'telegram_send_file',
      description: '发送一个本地文件给主人（Telegram 可靠文件传输：自动按扩展名选 sendPhoto/sendAnimation/sendVideo/sendAudio/sendDocument；支持中文路径；单文件上限 50MB；429 退避重试）。用于把 ComfyUI 生图输出/截图/文档/音频等本地文件直发主人。',
      parameters: {
        path: { type: 'string', description: '本地文件绝对路径（如 D:\\\\桌面\\\\ComfyUI\\\\output\\\\xxx.png 或 E:/alice/_tmp_review/xxx.png）', required: true },
        caption: { type: 'string', description: '可选说明文字（≤1024 字符，纯文本）' },
        chat_id: { type: 'number', description: '目标 chat id（缺省=owner 白名单）' },
      },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, messageId: { type: 'number' }, kind: { type: 'string' }, error: { type: 'string' } } }, render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '文件已发送 (' + (v.kind ?? 'file') + ')' + (v.messageId !== undefined ? ' msg=' + v.messageId : '') : '文件发送失败：' + (v.error ?? '未知') }] },
      async execute(args: { path: string; caption?: string; chat_id?: number }) {
        if (ownerChatId === null) {
          return { ok: false, error: 'owner 未绑定：请在配置 ownerChatId 或先发一条消息完成绑定', kind: 'document' }
        }
        const chatId = args.chat_id ?? ownerChatId
        logger.info('sendFile chat=' + chatId + ' path=' + args.path)
        return await sendFile(chatId, args.path, args.caption)
      },
    }))
  }

  // ════════════════════════ telegram_ask：电报提问工具（2026-09-07 新增） ════════════════════════
  // 模型侧工具：把问题发到 owner 电报 → 挂起等待回复（inbound 消息作为答案）→
  // 全部答完返回 answers（不进 GUI 弹窗，主人远程即可作答）。不依赖 outbound 工具集
  // （inbound 轮询收答案 + sendText 发问题）；HMR 卸载时 reject 挂起调用。
  if (config.askEnabled !== false) {
    ctx.tools.register(defineTool({
      name: 'telegram_ask',
      description: '通过 Telegram 向主人提问并等待回复（无需 GUI）。需要确认/选择/补充信息时使用——问题会发到主人绑定的 Telegram 频道，主人回复后作为工具结果返回。questions 数组，每项含稳定 id/question/可选 header/options/multi_select；推荐项放 options 首位并标 "(Recommended)"。主人可回序号（单选一个/多选逗号分隔）或直接输入自定义答案；/cancel 取消。注意：一次只应有一个活跃 telegram_ask（并发调用会报错）。',
      parameters: {
        questions: {
          type: 'array',
          required: true,
          description: '要问的问题列表（逐题发送，主人逐题作答）。',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string', required: true, description: '稳定 id，答案里原样回显' },
              question: { type: 'string', required: true, description: '问题正文' },
              header: { type: 'string', description: '可选的简短标题（如 Confirm / 选择模式）' },
              options: {
                type: 'array',
                description: '可选选项（主人可回序号选择或输入自定义）',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    label: { type: 'string', required: true, description: '选项标签' },
                    description: { type: 'string', description: '一句说明' },
                  },
                },
              },
              multi_select: { type: 'boolean', description: '是否允许多选（默认 false）' },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answers: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  selected: { type: 'array', required: true, items: { type: 'string' } },
                  custom: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_a: unknown, v: any) => [{ type: 'text', text: v.answers.map((x: any) => x.id + '=' + (x.custom ?? x.selected.join(','))).join('; ') }],
      },
      async execute(args: { questions: { id: string; question: string; header?: string; options?: { label: string; description?: string }[]; multi_select?: boolean }[] }, exec) {
        if (ownerChatId === null) {
          throw new Error('owner 未绑定：请在配置 ownerChatId 或先发一条消息完成绑定')
        }
        if (activeAsk !== null) {
          throw new Error('已有活跃的 telegram_ask 正在等待主人回复——请勿并发提问')
        }
        if (!args.questions || args.questions.length === 0) {
          throw new Error('telegram_ask 需要至少一个问题')
        }
        const chatId = ownerChatId
        const items: AskItem[] = args.questions.map((q) => ({
          id: q.id,
          question: q.question,
          ...q.header !== undefined ? { header: q.header } : {},
          ...q.options !== undefined ? { options: q.options } : {},
          multiSelect: q.multi_select ?? false,
        }))
        const askTimeoutMs = config.askTimeoutMs ?? 600000
        tgLog('info', 'telegram_ask 开始', 'questions=' + items.length + ' chat=' + chatId)

        return await new Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>((resolve, reject) => {
          // 先发第一题；发送失败直接 reject
          const a: NonNullable<typeof activeAsk> = {
            items, index: 0, answers: [], resolve, reject,
            questionMsgId: null, deadline: Date.now() + askTimeoutMs, timer: null, chatId,
          }
          activeAsk = a
          // 整体超时（从头到尾）
          a.timer = setTimeout(() => {
            tgLog('warn', 'telegram_ask 超时', 'ms=' + askTimeoutMs)
            finishAsk(new Error('telegram_ask timed out after ' + askTimeoutMs + 'ms without a full answer'))
          }, askTimeoutMs)
          void sendText(chatId, '🔔 主人，我有问题要问：\n\n' + askRender(a)).then((ok) => {
            if (ok === null) {
              finishAsk(new Error('telegram_ask 问题发送失败（Telegram API 错误）'))
            }
          })
          // 绑定 exec.signal 取消
          if (exec.signal !== undefined) {
            exec.signal.addEventListener('abort', () => {
              if (activeAsk !== null) finishAsk(new Error('telegram_ask aborted by caller'))
            }, { once: true })
          }
        }).then((v) => ({ answers: v.answers }))
      },
    }))
  }

  // ════════════════════════ 生命周期 ════════════════════════
  if (config.outboundEnabled !== false) loadOutbox()

  // HMR/卸载清理：清 typing 心跳 + pending 内存态 + 重试队列 + activeAsk
  ctx.effect(() => () => {
    if (typingTimer !== null) { clearInterval(typingTimer); typingTimer = null }
    pending = null
    clearRetryTimer()
    retryQueue.length = 0
    if (activeAsk !== null) {
      const a = activeAsk
      activeAsk = null
      if (a.timer !== null) { clearTimeout(a.timer); a.timer = null }
      a.reject(new Error('telegram_ask aborted: plugin reloaded'))
    }
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

    // coldstart 告警送达（2026-09-11）：life-core 自救失败只落盘告警，插件内部无法通知主人。
    // 本插件作为通道轮询该文件，发现新告警（mtime 晚于上次已**成功推送**的）即送达。
    const coldAlertPath = config.coldstartAlertPath ?? join(homeDir(), 'life-core', 'coldstart-alert.json')
    const coldAlertStatePath = join(homeDir(), 'telegram-coldstart-pushed.json')
    let lastColdAlertPushedMs = 0
    try {
      if (existsSync(coldAlertStatePath)) {
        const st = JSON.parse(readFileSync(coldAlertStatePath, 'utf8')) as { lastPushedMtimeMs?: number }
        if (typeof st.lastPushedMtimeMs === 'number') lastColdAlertPushedMs = st.lastPushedMtimeMs
      }
    } catch { /* 状态文件损坏 → 从 0 开始（宁可重复推送一次，不可漏报） */ }

    const checkColdAlert = (): void => {
      try {
        if (ownerChatId === null) return
        if (!existsSync(coldAlertPath)) return
        let mtimeMs = 0
        try { mtimeMs = statSync(coldAlertPath).mtimeMs } catch { return }
        if (!(mtimeMs > lastColdAlertPushedMs)) return
        let payload: ColdStartAlertPayload | null = null
        try { payload = JSON.parse(readFileSync(coldAlertPath, 'utf8')) as ColdStartAlertPayload } catch { payload = null }
        const text = decideColdAlertPush({
          ownerBound: ownerChatId !== null,
          alertExists: true,
          alertMtimeMs: mtimeMs,
          lastPushedMtimeMs: lastColdAlertPushedMs,
          alert: payload,
        })
        if (text === null) return
        void sendText(ownerChatId, text, true).then((ok) => {
          // 只有真的送达才记状态——推送失败必须能重试（否则漏报，比重复更严重）
          if (ok === null) {
            tgLog('warn', 'coldstart 告警推送失败（未记状态，下轮重试）', 'mtime=' + String(mtimeMs))
            return
          }
          lastColdAlertPushedMs = mtimeMs
          try {
            writeFileSync(coldAlertStatePath, JSON.stringify({ lastPushedMtimeMs: mtimeMs, at: new Date().toISOString() }), 'utf8')
          } catch { /* 状态落盘失败 → 下轮可能重复推送一次，可接受 */ }
          tgLog('info', 'coldstart 告警已送达主人', 'mtime=' + String(mtimeMs))
        })
      } catch (e) {
        tgLog('warn', 'coldstart 告警检查异常（已吞，不炸 web）', String(e))
      }
    }
    const coldAlertTimer = setInterval(checkColdAlert, config.coldstartWatchIntervalMs ?? 60000)

    return () => {
      stopped = true
      clearInterval(flushTimer)
      clearInterval(coldAlertTimer)
      if (outboxDirty) saveOutbox()
      tgLog('info', 'loop stop')
    }
  })

  tgLog('info', 'ready', 'bot=' + config.botToken.slice(0, 8) + '… inbound=' + String(config.inboundEnabled) + ' outbound=' + String(config.outboundEnabled) + ' owner=' + String(ownerChatId ?? '未绑定') + ' outbox=' + outbox.length)
}
