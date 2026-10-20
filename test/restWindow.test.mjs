import test from 'node:test'
import assert from 'node:assert/strict'

const { tickCount, restWindowOf, restWindowWeight, DEFAULT_REST_FADE_TICKS, SUBSTEPS_PER_TICK } = await import('../dist-test/restWindow.mjs')

test('tickCount: rigel-anim と同じく長さを tick に切り上げる', () => {
	assert.equal(tickCount(0), 0)
	assert.equal(tickCount(1), 20)
	assert.equal(tickCount(1.5), 30)
	assert.equal(tickCount(1.51), 31)
	// 0.15000000000000002 を 4 にしない
	assert.equal(tickCount(0.05 * 3), 3)
	assert.equal(tickCount(Number.NaN), 0)
	assert.equal(tickCount(-1), 0)
	assert.equal(tickCount(Number.POSITIVE_INFINITY), 0)
})

test('restWindowOf: 減衰の長さは 0 以上の整数にし、 壊れた値は既定値にする', () => {
	assert.deepEqual(restWindowOf(2, 6), { finalTick: 40, fadeTicks: 6 })
	assert.deepEqual(restWindowOf(2, 2.7), { finalTick: 40, fadeTicks: 2 })
	assert.deepEqual(restWindowOf(2, -3), { finalTick: 40, fadeTicks: 0 })
	assert.deepEqual(restWindowOf(2, Number.NaN), { finalTick: 40, fadeTicks: DEFAULT_REST_FADE_TICKS })
	assert.deepEqual(restWindowOf(2, undefined), { finalTick: 40, fadeTicks: DEFAULT_REST_FADE_TICKS })
})

test('restWindowWeight: 減衰の前は 1、 最後の tick とその後は 0、 間は単調に減る', () => {
	const window = { finalTick: 40, fadeTicks: 4 }
	const end = 40 * SUBSTEPS_PER_TICK
	const start = end - 4 * SUBSTEPS_PER_TICK
	for (let step = 0; step <= start; step++) assert.equal(restWindowWeight(step, window), 1)
	assert.equal(restWindowWeight(end, window), 0)
	assert.equal(restWindowWeight(end + 7, window), 0)
	let previous = 1
	for (let step = start + 1; step < end; step++) {
		const weight = restWindowWeight(step, window)
		assert.ok(weight > 0 && weight < previous, `step=${step}`)
		previous = weight
	}
	// 中点は smoothstep の 0.5
	assert.equal(restWindowWeight((start + end) / 2, window), 0.5)
})

test('restWindowWeight: 減衰が animation より長ければ animation 全体で減らし、 0 なら最後の tick で切る', () => {
	assert.equal(restWindowWeight(0, { finalTick: 3, fadeTicks: 10 }), 1)
	assert.ok(restWindowWeight(1, { finalTick: 3, fadeTicks: 10 }) < 1)
	assert.equal(restWindowWeight(8, { finalTick: 3, fadeTicks: 0 }), 1)
	assert.equal(restWindowWeight(9, { finalTick: 3, fadeTicks: 0 }), 0)
})

test('restWindowWeight: 長さ 0 の animation は常に 0', () => {
	assert.equal(restWindowWeight(0, { finalTick: 0, fadeTicks: 4 }), 0)
})
