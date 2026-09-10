/**
 * cold-alert.ts — coldstart 告警送达的**纯判定逻辑**（零依赖，可离线单测）
 *
 * 存在理由（2026-09-11）：
 *   dsh-life-core 的冷启动自救失败告警只落盘——`writeAlert` 只写
 *   `life-core/coldstart-alert.json`，插件内部无法调用工具通知主人，
 *   而告警文案里却写着「需要外部介入」。这是一条真实的预防缺口
 *   （AGENTS.md 5.10 §4：唤醒要重试 **+ 告警**——告警半条当时缺失）。
 *
 * 由谁送达：本插件（telegram）作为**通道**承担，而不是让 life-core 反向依赖通道。
 *   - 闭环自洽：告警场景是「web 起来了但我（agent）不在」——此时 telegram 插件
 *     必然在运行，所以由它送达是可达的（AGENTS.md 5.13 §1：降级路径必须真的更宽）。
 *   - 边界清晰：该文件由 life-core 显式声明为「外部可读，供主人/外部计划任务
 *     发现『我不在』」——读它是使用公开契约，不是依赖内部实现。
 *
 * 分工：本文件只有**判定与文本生成**（无 IO、时间由调用方注入），
 *       IO 与定时器留在 index.ts。配 tests/cold-alert.test.mjs 离线覆盖边界。
 */

/** coldstart 告警文件的内容契约（由 dsh-life-core 的 writeAlert 写入）。 */
export interface ColdStartAlertPayload {
  at?: string
  reason?: string
  attempts?: number
  lastMainSessionId?: string
  hints?: string[]
}

/** 判定入参（全部显式传入，便于离线测试构造冷样本）。 */
export interface ColdAlertInput {
  /** owner 已绑定（未绑定则无人可送达；**不记状态**，绑定后仍可补推） */
  ownerBound: boolean
  /** 告警文件存在 */
  alertExists: boolean
  /** 告警文件 mtime（ms） */
  alertMtimeMs: number
  /** 上次已**成功推送**的告警 mtime（0 = 从未推送） */
  lastPushedMtimeMs: number
  /** 已解析告警内容（解析失败传 null → 仍推送，带兜底文案） */
  alert: ColdStartAlertPayload | null
}

/**
 * 判定是否应把 coldstart 告警推送给主人。
 *
 * 纪律：
 *   ① 未绑定 owner → 不推送、不记状态（绑定后仍能补推这条告警）
 *   ② 文件不存在 / mtime 非法 → 不推送
 *   ③ mtime 未前进 → 不推送（防同一告警重复刷屏）
 *   ④ 内容解析失败 → **仍然推送**（宁可文案简略，不可漏报）
 *
 * @param input - 判定输入
 * @returns 应推送的文本；不该推送时返回 null
 */
export function decideColdAlertPush(input: ColdAlertInput): string | null {
  if (!input.ownerBound) return null
  if (!input.alertExists) return null
  if (!(input.alertMtimeMs > 0)) return null
  if (input.alertMtimeMs <= input.lastPushedMtimeMs) return null

  const a = input.alert
  const lines: string[] = []
  lines.push('⚠ 告警：我可能不在（冷启动自救失败）')
  lines.push('')
  if (a?.reason) lines.push('原因：' + a.reason)
  if (typeof a?.attempts === 'number') lines.push('已重试：' + a.attempts + ' 次')
  if (a?.lastMainSessionId) lines.push('主会话：' + a.lastMainSessionId)
  if (a?.at) lines.push('发生时间：' + a.at)
  if (a?.hints !== undefined && a.hints.length > 0) {
    lines.push('')
    lines.push('排查方向：')
    for (const h of a.hints) lines.push('· ' + h)
  }
  lines.push('')
  lines.push('（web 已启动但无活跃会话，我无法自行恢复主会话——需要外部介入：打开 GUI 或回一条消息）')
  return lines.join('\n')
}
