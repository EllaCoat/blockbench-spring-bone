import test from 'node:test'
import assert from 'node:assert/strict'

const { timeToStepIndex, stepIndexToTime, SpringRuntime } = await import('../dist-test/springRuntime.mjs')

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

// --- SpringRuntime lifecycle ---

// stub ops : 呼ばれた順に {fn, args} を calls へ push するだけ (= BB 無しで検証するための口)。
// throwOnStep = n で n 回目の stepAndApplyOrdered が 1 度だけ throw (= stepError で例外
// object を指定可能)、 restoreError を渡すと restorePose が常にそれを throw する。
// evaluatingLog には各 call 発生時点の runtime.isEvaluating が記録される。
function makeRuntime(calls, { throwOnStep = -1, stepError = null, restoreError = null } = {}) {
	let stepCount = 0
	let throwArmed = true
	const evaluatingLog = []
	let runtime = null
	const record = (fn, impl) => (...args) => {
		calls.push({ fn, args })
		if (runtime) evaluatingLog.push(runtime.isEvaluating)
		return impl(...args)
	}
	const ops = {
		resolveConfigs: record('resolveConfigs', () => {}),
		capturePose: record('capturePose', () => ({ snapshot: true })),
		restorePose: record('restorePose', () => {
			if (restoreError) throw restoreError
		}),
		updateMatrixWorld: record('updateMatrixWorld', () => {}),
		resetAllToRest: record('resetAllToRest', () => {}),
		stepAndApplyOrdered: record('stepAndApplyOrdered', () => {
			stepCount++
			if (throwArmed && stepCount === throwOnStep) {
				throwArmed = false
				throw stepError ?? new Error('step failed')
			}
		}),
		applyOnlyOrdered: record('applyOnlyOrdered', () => {}),
	}
	runtime = new SpringRuntime(ops)
	const context = { animation: null }
	const basePose = (timeSeconds, ctx) => {
		calls.push({ fn: 'basePose', args: [timeSeconds, ctx] })
		evaluatingLog.push(runtime.isEvaluating)
	}
	return { runtime, ops, context, basePose, evaluatingLog }
}

const fnNames = (calls) => calls.map((c) => c.fn)

test('SpringRuntime: fresh から evaluateSample(0.05) は replay で正確な呼び出し列', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	assert.deepEqual(fnNames(calls), ['resolveConfigs'])
	calls.length = 0

	const result = runtime.evaluateSample(0.05)
	assert.deepEqual(fnNames(calls), [
		'capturePose',
		'basePose',        // t = 0
		'resetAllToRest',
		'basePose',        // t = 1/60
		'stepAndApplyOrdered',
		'basePose',        // t = 2/60
		'stepAndApplyOrdered',
		'basePose',        // t = 3/60
		'stepAndApplyOrdered',
		'restorePose',
		'updateMatrixWorld',
		'applyOnlyOrdered',
	])
	// base pose evaluator の時刻引数は step 格子に厳密対応
	const basePoseTimes = calls.filter((c) => c.fn === 'basePose').map((c) => c.args[0])
	assert.deepEqual(basePoseTimes, [0, 1 / 60, 2 / 60, 3 / 60])
	assert.equal(result.stepIndex, 3)
	assert.equal(result.timeSeconds, 0.05)
	assert.equal(result.substepCount, 3)
	assert.equal(result.mode, 'replay')
	// 1 sub-step につき stepAndApplyOrdered がちょうど 1 回 (= 分解されていない)
	assert.equal(calls.filter((c) => c.fn === 'stepAndApplyOrdered').length, 3)
})

test('SpringRuntime: 続けて evaluateSample(0.10) は advance (= replay しない)', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(0.05)
	calls.length = 0

	const result = runtime.evaluateSample(0.10)
	assert.equal(result.mode, 'advance')
	assert.equal(result.substepCount, 3)
	assert.equal(result.stepIndex, 6)
	// replay 専用の ops は呼ばれない
	assert.ok(!fnNames(calls).includes('resetAllToRest'))
	assert.equal(calls.filter((c) => c.fn === 'stepAndApplyOrdered').length, 3)
})

test('SpringRuntime: 同一時刻は same-step (= state 不変、 描画のみ)', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(0.10)
	calls.length = 0

	const result = runtime.evaluateSample(0.10)
	assert.equal(result.mode, 'same-step')
	assert.equal(result.substepCount, 0)
	// step / base pose は 1 回も呼ばれないが、 capture → restore → updateMatrixWorld →
	// applyOnlyOrdered は通る (= 描画は更新する)
	assert.deepEqual(fnNames(calls), ['capturePose', 'restorePose', 'updateMatrixWorld', 'applyOnlyOrdered'])
})

test('SpringRuntime: 逆行は replay', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(0.10)
	calls.length = 0

	const result = runtime.evaluateSample(0.05)
	assert.equal(result.mode, 'replay')
	assert.equal(result.stepIndex, 3)
	assert.ok(fnNames(calls).includes('resetAllToRest'))
})

test('SpringRuntime: 30 step ちょうどは advance、 31 step は replay (境界)', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(0) // step 0 に初期化

	const advance = runtime.evaluateSample(stepIndexToTime(30))
	assert.equal(advance.mode, 'advance')
	assert.equal(advance.substepCount, 30)
	assert.equal(advance.stepIndex, 30)

	const replay = runtime.evaluateSample(stepIndexToTime(61))
	assert.equal(replay.mode, 'replay')
	assert.equal(replay.stepIndex, 61)
})

test('SpringRuntime: 例外時は restorePose 経由で再 throw、 step cache は null', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { throwOnStep: 2 })
	runtime.beginAnimation(context, basePose)
	calls.length = 0

	assert.throws(() => runtime.evaluateSample(0.05), /step failed/)
	const names = fnNames(calls)
	assert.ok(names.includes('restorePose'))
	assert.ok(names.includes('updateMatrixWorld'))
	assert.ok(!names.includes('applyOnlyOrdered'))
	assert.equal(runtime.currentStepIndex, null)
	// 次回の評価は必ず 0 replay になる
	calls.length = 0
	const result = runtime.evaluateSample(0.05)
	assert.equal(result.mode, 'replay')
})

test('SpringRuntime: context object が resolveConfigs / basePose の両方へ同一参照で届く', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(0.05)

	const resolved = calls.find((c) => c.fn === 'resolveConfigs')
	assert.ok(resolved.args[0] === context)
	for (const c of calls.filter((c) => c.fn === 'basePose')) {
		assert.ok(c.args[1] === context)
	}
	// ops 系の context 引数も同一参照
	for (const c of calls.filter((c) => ['resetAllToRest', 'stepAndApplyOrdered', 'applyOnlyOrdered'].includes(c.fn))) {
		assert.ok(c.args[c.args.length - 1] === context, `${c.fn}`)
	}
})

test('SpringRuntime: session 未開始の applyWithoutAdvance は Error', () => {
	const calls = []
	const { runtime } = makeRuntime(calls)
	assert.throws(() => runtime.applyWithoutAdvance(), Error)
	assert.deepEqual(calls, [])
})

test('SpringRuntime: endAnimation 後の evaluateSample は ops を呼ばない', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(0.05)
	runtime.endAnimation()
	calls.length = 0

	assert.throws(() => runtime.evaluateSample(0.05), /session not started/)
	assert.deepEqual(calls, [])
	// endAnimation の二重呼び出し (= 未開始状態への呼び出し) は no-op
	assert.doesNotThrow(() => runtime.endAnimation())
})

test('SpringRuntime: restorePose が throw しても updateMatrixWorld は実行される', () => {
	const restoreErr = new Error('restore failed')
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { restoreError: restoreErr })
	runtime.beginAnimation(context, basePose)
	calls.length = 0

	// 正常系で restorePose だけが throw → その例外がそのまま伝播する
	assert.throws(() => runtime.evaluateSample(0.05), (e) => e === restoreErr)
	const names = fnNames(calls)
	assert.ok(names.includes('restorePose'))
	assert.ok(names.includes('updateMatrixWorld'))
	assert.ok(!names.includes('applyOnlyOrdered'))
	assert.equal(runtime.currentStepIndex, null)
})

test('SpringRuntime: sub-step と restorePose が両方 throw → sub-step 由来の例外が伝播', () => {
	const stepErr = new Error('step failed')
	const restoreErr = new Error('restore failed')
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, {
		throwOnStep: 1,
		stepError: stepErr,
		restoreError: restoreErr,
	})
	runtime.beginAnimation(context, basePose)
	calls.length = 0

	// 伝播するのは原因に近い方 (= sub-step 由来)。 identity で判定する
	assert.throws(() => runtime.evaluateSample(0.05), (e) => e === stepErr)
	const names = fnNames(calls)
	assert.ok(names.includes('restorePose'))
	assert.ok(names.includes('updateMatrixWorld'))
	assert.ok(!names.includes('applyOnlyOrdered'))
	assert.equal(runtime.currentStepIndex, null)
})

test('SpringRuntime: 例外時も restorePose → updateMatrixWorld の順序が保たれる', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { throwOnStep: 1 })
	runtime.beginAnimation(context, basePose)
	calls.length = 0

	assert.throws(() => runtime.evaluateSample(0.05))
	const names = fnNames(calls)
	assert.ok(names.indexOf('restorePose') !== -1)
	assert.ok(names.indexOf('restorePose') < names.indexOf('updateMatrixWorld'))
})

test('SpringRuntime: isEvaluating は評価中のみ true (= 例外終了後も false)', () => {
	const calls = []
	const { runtime, context, basePose, evaluatingLog } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	evaluatingLog.length = 0

	// 評価中は全 call 地点で true、 正常終了後は false
	runtime.evaluateSample(0.05)
	assert.ok(evaluatingLog.length > 0)
	assert.ok(evaluatingLog.every((v) => v === true))
	assert.equal(runtime.isEvaluating, false)

	// 例外終了後も false
	const calls2 = []
	const failing = makeRuntime(calls2, { throwOnStep: 1 })
	failing.runtime.beginAnimation(failing.context, failing.basePose)
	assert.throws(() => failing.runtime.evaluateSample(0.05))
	assert.equal(failing.runtime.isEvaluating, false)
})
