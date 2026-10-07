/**
 * inbound 断线告警的纯决策层（2026-10-07 收信静默事故驱动）。
 *
 * 背景：inbound（getUpdates 长轮询）与 outbound（sendMessage）是**两条独立路径**。
 * 事故当天 inbound 连续失败近 2 小时（webhook 抢占导致 409），而 outbound 全程健康——
 * **却没有任何信号送达主人**：失败只落本地日志，而日志没人看。
 * 本模块决定「该不该用 outbound 把这件事喊出去」。
 *
 * 设计纪律：
 * - 纯函数：不读时钟、不碰网络、不写盘——只做判定与文案，便于离线测试与推演。
 * - 机制只送信号：不代替主体决定如何处置，也不自动删除外部设置
 *   （webhook 有可能是主人自己接的服务——擅自删就是对抗）。
 * - 一次故障期只喊一次（alreadyAlerted 由调用方持有；恢复时再报一次）。
 */

export interface PollAlertInput {
  /** 连续失败次数（任何一次成功即归零） */
  pollFailCount: number
  /** 触发阈值；<=0 表示关闭告警 */
  threshold: number
  /** 本次故障期是否已经告警过（去重） */
  alreadyAlerted: boolean
  /** owner 是否已绑定（未绑定就无处可送） */
  ownerBound: boolean
  /** 最近一次失败的原始原因（来自 apiCall 的 lastApiFailure；空串 = 未记录） */
  cause: string
}

/** 该不该喊「收信断了」；返回 null = 不喊 */
export function decidePollAlert(input: PollAlertInput): string | null {
  if (!input.ownerBound) return null
  if (input.threshold <= 0) return null
  if (input.alreadyAlerted) return null
  if (input.pollFailCount < input.threshold) return null
  return (
    '⚠️ 收信通道断了\n\n' +
    'getUpdates 已连续失败 ' + input.pollFailCount + ' 次 —— 您发到电报的消息我收不到。' +
    '（这条能送到，是因为发信与收信是两条独立路径）\n\n' +
    '原因：' + (input.cause !== '' ? input.cause : '未记录') +
    '\n\n恢复后我会再报一次。'
  )
}

export interface PollRecoveryInput {
  /** 断线期间是否告警过（没告过就不必报平安，免得噪音） */
  alreadyAlerted: boolean
  ownerBound: boolean
}

/** 该不该报「收信已恢复」；返回 null = 不报 */
export function decidePollRecovery(input: PollRecoveryInput): string | null {
  if (!input.alreadyAlerted) return null
  if (!input.ownerBound) return null
  return '✅ 收信通道已恢复（断线期间您发的电报我没收到，需要的话请重发）'
}
