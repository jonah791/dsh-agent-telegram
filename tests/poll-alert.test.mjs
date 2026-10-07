// inbound 断线告警的离线测试（对应 src/poll-alert.ts）。
// 纪律：每条「应该喊」的用例都配一条「不该喊」的尸体样本——恒为非空的判据不是判据。
// 特别地：最后一组用**2026-10-07 事故的真实 409 原文**做回归夹具，
// 断言告警文案里必须出现 webhook 关键词（根因可见性是这次事故的核心教训）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decidePollAlert, decidePollRecovery } from '../lib/poll-alert.js'

const OK = {
  pollFailCount: 30,
  threshold: 30,
  alreadyAlerted: false,
  ownerBound: true,
  cause: 'getUpdates → HTTP 409 {"ok":false,"error_code":409}',
}
const input = (over = {}) => ({ ...OK, ...over })

test('达到阈值 → 喊', () => {
  const text = decidePollAlert(input())
  assert.notEqual(text, null)
  assert.match(text, /收信通道断了/)
  assert.match(text, /30 次/)
})

test('未达阈值 → 不喊（尸体样本）', () => {
  assert.equal(decidePollAlert(input({ pollFailCount: 29 })), null)
  // 边界：恰好等于阈值要喊（上一行证明它不是在"恒为空"）
  assert.notEqual(decidePollAlert(input({ pollFailCount: 30 })), null)
})

test('已告警过 → 不重复喊（一次故障期只喊一次）', () => {
  assert.equal(decidePollAlert(input({ alreadyAlerted: true })), null)
})

test('owner 未绑定 → 不喊（无处可送）', () => {
  assert.equal(decidePollAlert(input({ ownerBound: false })), null)
})

test('阈值 <=0 → 关闭告警', () => {
  assert.equal(decidePollAlert(input({ threshold: 0 })), null)
  assert.equal(decidePollAlert(input({ threshold: -1 })), null)
})

test('原因缺失时文案必须如实写「未记录」，不得留空', () => {
  const text = decidePollAlert(input({ cause: '' }))
  assert.notEqual(text, null)
  assert.match(text, /未记录/)
})

test('原因必须出现在文案里（告警的价值就在根因可见）', () => {
  const text = decidePollAlert(input({ cause: 'getUpdates → HTTP 500 boom' }))
  assert.match(text, /HTTP 500 boom/)
})

test('回归夹具：2026-10-07 事故真实 409 原文 → 告警必须点名 webhook', () => {
  const realCause =
    'getUpdates → HTTP 409 {"ok":false,"error_code":409,"description":' +
    '"Conflict: can\'t use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"}'
  const text = decidePollAlert(input({ cause: realCause, pollFailCount: 122 }))
  assert.notEqual(text, null)
  assert.match(text, /webhook/)
  assert.match(text, /122 次/)
})

test('恢复：没告过警 → 不报平安（避免噪音）', () => {
  assert.equal(decidePollRecovery({ alreadyAlerted: false, ownerBound: true }), null)
})

test('恢复：告过警 → 必须报（闭环）', () => {
  const text = decidePollRecovery({ alreadyAlerted: true, ownerBound: true })
  assert.notEqual(text, null)
  assert.match(text, /已恢复/)
})

test('恢复：owner 未绑定 → 不报', () => {
  assert.equal(decidePollRecovery({ alreadyAlerted: true, ownerBound: false }), null)
})
