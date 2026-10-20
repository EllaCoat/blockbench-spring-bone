import test from 'node:test'
import assert from 'node:assert/strict'

const { timeToStepIndex, stepIndexToTime, SpringRuntime, MAX_ADVANCE_STEPS, FIXED_DT_SECONDS } = await import('../dist-test/runtime.mjs')
const { restWindowWeight } = await import('../dist-test/restWindow.mjs')

test('timeToStepIndex: 浮動小数で格子から数 ULP ずれた時刻も格子の step にする (2.05 → 123)', () => {
	assert.equal(timeToStepIndex(2.05), 123)
})

test('timeToStepIndex: 1/60 格子と tick 格子 (k * 0.05) はそのまま step になる', () => {
	for (let k = 0; k <= 360000; k++) assert.equal(timeToStepIndex(k / 60), k, `k=${k}`)
	for (let k = 0; k <= 72000; k++) assert.equal(timeToStepIndex(k * 0.05), k * 3, `k=${k}`)
})

test('timeToStepIndex: 格子の直前は切り上げず、 格子の間は切り捨てる', () => {
	for (let k = 1; k <= 3600; k++) assert.equal(timeToStepIndex(k / 60 - 1e-10), k - 1, `k=${k}`)
	for (let k = 0; k <= 3600; k++) assert.equal(timeToStepIndex((k + 0.4) / 60), k, `k=${k}`)
})

test('timeToStepIndex: 負は 0、 非有限と step の範囲を超える時刻は RangeError', () => {
	assert.equal(timeToStepIndex(-1), 0)
	assert.equal(timeToStepIndex(0), 0)
	for (const t of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_VALUE, 1e308]) assert.throws(() => timeToStepIndex(t), RangeError)
})

test('stepIndexToTime: timeToStepIndex と往復する', () => {
	for (const k of [0, 1, 3, 123, 3600, 72000, 360000]) assert.equal(timeToStepIndex(stepIndexToTime(k)), k)
	assert.equal(stepIndexToTime(3), 0.05)
})

// ops の呼び出しを記録する。 snapshot は capture した回数で区別する。
function recorder(overrides = {}) {
	const calls = []
	let captures = 0
	const ops = {
		resolveConfigs: (context) => calls.push(['resolve', context]),
		basePose: (time) => calls.push(['base', time]),
		capturePose: () => {
			calls.push(['capture'])
			return ++captures
		},
		restorePose: (snapshot) => calls.push(['restore', snapshot]),
		resetAllToRest: () => calls.push(['reset']),
		stepAndApply: (dt, weight) => calls.push(['step', dt, weight]),
		applyOnly: (weight) => calls.push(['apply', weight]),
		...overrides,
	}
	return { calls, ops }
}

const names = (calls) => calls.map((call) => call[0])

test('SpringRuntime: 最初の評価は step 0 の基底ポーズで静止させてから目標まで進め、 控えた姿勢へ戻して差分を載せる', () => {
	const { calls, ops } = recorder()
	const runtime = new SpringRuntime(ops)
	const context = {}
	runtime.begin(context)
	assert.equal(runtime.evaluateStep(3), 'replay')
	assert.deepEqual(names(calls), ['resolve', 'capture', 'base', 'reset', 'base', 'step', 'base', 'step', 'base', 'step', 'restore', 'apply'])
	assert.deepEqual(calls.filter((c) => c[0] === 'base').map((c) => c[1]), [0, 1 / 60, 2 / 60, 3 / 60])
	assert.equal(calls[0][1], context)
	assert.deepEqual(calls.find((c) => c[0] === 'step').slice(1), [FIXED_DT_SECONDS, 1])
	assert.deepEqual(calls.find((c) => c[0] === 'restore'), ['restore', 1])
	assert.equal(runtime.currentStepIndex, 3)
})

test('SpringRuntime: 短い前進は続きから、 同じ step は進めず、 戻りと長い前進は step 0 から', () => {
	const { calls, ops } = recorder()
	const runtime = new SpringRuntime(ops)
	runtime.begin({})
	runtime.evaluateStep(3)
	const modes = [6, 6, 3, 3 + MAX_ADVANCE_STEPS, 4 + 2 * MAX_ADVANCE_STEPS].map((step) => runtime.evaluateStep(step))
	assert.deepEqual(modes, ['advance', 'same-step', 'replay', 'advance', 'replay'])
	calls.length = 0
	runtime.evaluateStep(4 + 2 * MAX_ADVANCE_STEPS)
	assert.deepEqual(names(calls), ['capture', 'restore', 'apply'])
})

test('SpringRuntime: evaluateSample は時刻を step にして評価する', () => {
	const { ops } = recorder()
	const runtime = new SpringRuntime(ops)
	runtime.begin({})
	runtime.evaluateSample(2.05)
	assert.equal(runtime.currentStepIndex, 123)
})

test('SpringRuntime: begin し直すと step 0 からやり直す', () => {
	const { calls, ops } = recorder()
	const runtime = new SpringRuntime(ops)
	runtime.begin({})
	runtime.evaluateStep(3)
	runtime.begin({})
	calls.length = 0
	assert.equal(runtime.evaluateStep(6), 'replay')
	assert.equal(calls.filter((c) => c[0] === 'reset').length, 1)
})

test('SpringRuntime: begin 前と end 後の評価は Error、 負や非整数の step は RangeError', () => {
	const { calls, ops } = recorder()
	const runtime = new SpringRuntime(ops)
	assert.throws(() => runtime.evaluateStep(0), /no animation/)
	runtime.begin({})
	for (const step of [-1, 1.5, Number.NaN]) assert.throws(() => runtime.evaluateStep(step), RangeError)
	runtime.end()
	assert.throws(() => runtime.evaluateSample(0), /no animation/)
	assert.deepEqual(names(calls), ['resolve'])
})

test('SpringRuntime: sub-step の例外は姿勢を戻してから伝え、 次は step 0 からやり直す', () => {
	let fail = true
	const { calls, ops } = recorder({
		stepAndApply: () => {
			if (fail) throw new Error('step failed')
		},
	})
	const runtime = new SpringRuntime(ops)
	runtime.begin({})
	assert.throws(() => runtime.evaluateStep(3), /step failed/)
	assert.deepEqual(names(calls).slice(-1), ['restore'])
	assert.equal(runtime.currentStepIndex, null)
	assert.equal(runtime.isEvaluating, false)
	fail = false
	assert.equal(runtime.evaluateStep(3), 'replay')
})

test('SpringRuntime: 姿勢の復元の例外も伝えるが、 sub-step の例外があればそちらを伝える', () => {
	const warn = console.warn
	console.warn = () => {}
	try {
		const restoreFails = recorder({
			restorePose: () => {
				throw new Error('restore failed')
			},
		})
		const a = new SpringRuntime(restoreFails.ops)
		a.begin({})
		assert.throws(() => a.evaluateStep(3), /restore failed/)
		assert.equal(a.currentStepIndex, null)

		const bothFail = recorder({
			stepAndApply: () => {
				throw new Error('step failed')
			},
			restorePose: () => {
				throw new Error('restore failed')
			},
		})
		const b = new SpringRuntime(bothFail.ops)
		b.begin({})
		assert.throws(() => b.evaluateStep(3), /step failed/)
		assert.equal(b.isEvaluating, false)
	} finally {
		console.warn = warn
	}
})

test('SpringRuntime: isEvaluating は評価の間だけ true', () => {
	let during = null
	let runtime
	const { ops } = recorder({ basePose: () => (during = runtime.isEvaluating) })
	runtime = new SpringRuntime(ops)
	runtime.begin({})
	assert.equal(runtime.isEvaluating, false)
	runtime.evaluateStep(1)
	assert.equal(during, true)
	assert.equal(runtime.isEvaluating, false)
})

test('SpringRuntime: rest window が無ければ weight は常に 1', () => {
	const { calls, ops } = recorder()
	const runtime = new SpringRuntime(ops)
	runtime.begin({})
	runtime.evaluateStep(30)
	assert.ok(calls.filter((c) => c[0] === 'step' || c[0] === 'apply').every((c) => c[c.length - 1] === 1))
})

test('SpringRuntime: sub-step にはこれから進む step の weight、 最後の差分には目標の step の weight を渡す', () => {
	const window = { finalTick: 4, fadeTicks: 2 }
	const { calls, ops } = recorder()
	const runtime = new SpringRuntime(ops)
	runtime.begin({ restWindow: window })
	runtime.evaluateStep(12)
	const steps = calls.filter((c) => c[0] === 'step').map((c) => c[2])
	assert.deepEqual(steps, Array.from({ length: 12 }, (_, i) => restWindowWeight(i + 1, window)))
	assert.deepEqual(calls.at(-1), ['apply', 0])
	calls.length = 0
	runtime.evaluateStep(9)
	assert.deepEqual(calls.at(-1), ['apply', restWindowWeight(9, window)])
})
