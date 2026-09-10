/**
 * cold-alert.test.mjs — coldstart 告警送达的离线单测（零依赖，不启 web）
 *
 * 覆盖 AGENTS.md 5.10 §4「唤醒要重试 **+ 告警**」的告警半条 + 5.13 §3 冷路径纪律：
 *   未绑定 owner / 文件不存在 / mtime 未前进（防重复）/ 内容损坏（不漏报）→ 边界必测。
 * 运行：node --test tests/cold-alert.test.mjs（在插件根目录）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideColdAlertPush } from '../lib/cold-alert.js'

/** 判定输入缺省值 = 现场：已绑定 owner、告警文件存在、mtime 前进、内容完整。 */
function input(over = {}) {
  return {
    ownerBound: true,
    alertExists: true,
    alertMtimeMs: 2_000,
    lastPushedMtimeMs: 1_000,
    alert: {
      at: '2026-09-11T00:00:00.000Z',
      reason: '无活跃 agent 且自救重试已耗尽（3/3，session=session-main-1）',
      attempts: 3,
      lastMainSessionId: 'session-main-1',
      hints: ['打开 GUI', '发一条 telegram 消息'],
    },
    ...over,
  }
}

test('未绑定 owner → 不推送（无人可送达，且不记状态以便绑定后补推）', () => {
  assert.equal(decideColdAlertPush(input({ ownerBound: false })), null)
})

test('告警文件不存在 → 不推送（正常态零副作用）', () => {
  assert.equal(decideColdAlertPush(input({ alertExists: false })), null)
})

test('mtime 非法（0 / 负）→ 不推送（防异常输入误触发）', () => {
  assert.equal(decideColdAlertPush(input({ alertMtimeMs: 0 })), null)
  assert.equal(decideColdAlertPush(input({ alertMtimeMs: -1 })), null)
})

test('mtime 未前进 → 不推送（同一条告警不重复刷屏）', () => {
  assert.equal(decideColdAlertPush(input({ alertMtimeMs: 1_000, lastPushedMtimeMs: 1_000 })), null)
  assert.equal(decideColdAlertPush(input({ alertMtimeMs: 999, lastPushedMtimeMs: 1_000 })), null)
})

test('新告警（mtime 前进）→ 推送，且文本含关键字段', () => {
  const text = decideColdAlertPush(input())
  assert.equal(typeof text, 'string')
  assert.match(text, /我可能不在/)
  assert.match(text, /重试已耗尽/)
  assert.match(text, /已重试：3 次/)
  assert.match(text, /session-main-1/)
  assert.match(text, /2026-09-11T00:00:00\.000Z/)
})

test('hints 非空 → 逐条列出排查方向', () => {
  const text = decideColdAlertPush(input())
  assert.match(text, /排查方向：/)
  assert.match(text, /· 打开 GUI/)
  assert.match(text, /· 发一条 telegram 消息/)
})

test('内容解析失败（alert=null）→ 仍然推送（宁可文案简略，不可漏报）', () => {
  const text = decideColdAlertPush(input({ alert: null }))
  assert.equal(typeof text, 'string')
  assert.match(text, /我可能不在/)
  // 缺字段时不应出现空标签
  assert.doesNotMatch(text, /原因：\s*\n/)
  assert.doesNotMatch(text, /已重试：undefined/)
})

test('部分字段缺失 → 只输出存在的字段（不产生 undefined/空行噪音）', () => {
  const text = decideColdAlertPush(input({ alert: { reason: '仅原因' } }))
  assert.match(text, /原因：仅原因/)
  assert.doesNotMatch(text, /undefined/)
  assert.doesNotMatch(text, /排查方向：/)
})

test('hints 为空数组 → 不输出「排查方向」标题（避免空列表）', () => {
  const text = decideColdAlertPush(input({ alert: { reason: 'x', hints: [] } }))
  assert.doesNotMatch(text, /排查方向：/)
})

test('首次推送（lastPushedMtimeMs=0）→ 推送（历史告警在重启后仍能补报）', () => {
  const text = decideColdAlertPush(input({ lastPushedMtimeMs: 0 }))
  assert.equal(typeof text, 'string')
  assert.match(text, /我可能不在/)
})
