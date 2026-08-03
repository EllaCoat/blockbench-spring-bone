import test from 'node:test'
import assert from 'node:assert/strict'

const { timeToStepIndex, stepIndexToTime } = await import('../dist-test/springRuntime.mjs')

test('timeToStepIndex: バグ再現ケース (2.05 → 123)', () => {
	// 旧実装 Math.floor(2.05 / (1/60)) は 122.99999999999999 を floor して 122 を返していた
	assert.equal(timeToStepIndex(2.05), 123)
})

test('timeToStepIndex: 1/60 格子の identity (k = 0..360000)', () => {
	for (let k = 0; k <= 360000; k++) {
		assert.equal(timeToStepIndex(k / 60), k, `k=${k}`)
	}
})

test('timeToStepIndex: export 格子 (k * 0.05 → k * 3、 k = 0..72000)', () => {
	for (let k = 0; k <= 72000; k++) {
		assert.equal(timeToStepIndex(k * 0.05), k * 3, `k=${k}`)
	}
})

test('timeToStepIndex: 格子直前を切り上げない (k/60 - 1e-10 → k - 1、 k = 1..3600)', () => {
	for (let k = 1; k <= 3600; k++) {
		assert.equal(timeToStepIndex(k / 60 - 1e-10), k - 1, `k=${k}`)
	}
})

test('timeToStepIndex: 格子間は floor する ((k + 0.4) / 60 → k、 k = 0..3600)', () => {
	for (let k = 0; k <= 3600; k++) {
		assert.equal(timeToStepIndex((k + 0.4) / 60), k, `k=${k}`)
	}
})

test('timeToStepIndex: 負値は 0 へ clamp', () => {
	assert.equal(timeToStepIndex(-0.01), 0)
	assert.equal(timeToStepIndex(-1), 0)
	assert.equal(timeToStepIndex(0), 0)
})

test('timeToStepIndex: NaN / Infinity は RangeError を throw', () => {
	assert.throws(() => timeToStepIndex(Number.NaN), RangeError)
	assert.throws(() => timeToStepIndex(Number.POSITIVE_INFINITY), RangeError)
	assert.throws(() => timeToStepIndex(Number.NEGATIVE_INFINITY), RangeError)
})

test('stepIndexToTime: round-trip', () => {
	for (const k of [0, 1, 3, 123, 3600, 72000, 360000]) {
		assert.equal(timeToStepIndex(stepIndexToTime(k)), k, `k=${k}`)
	}
	assert.equal(stepIndexToTime(3), 0.05)
})
