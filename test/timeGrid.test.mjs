import test from 'node:test'
import assert from 'node:assert/strict'

const { timeToStepIndex, stepIndexToTime, stepIndexFromFrame, SpringRuntime } = await import('../dist-test/springRuntime.mjs')
const {
	computeRestWindowWeight,
	deriveDisplayedFinalFrame,
	deriveRenderSampleCount,
	checkPreviewRestWindowTiming,
} = await import('../dist-test/restWindow.mjs')

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

test('timeToStepIndex: safe integer を外れる巨大時刻は RangeError', () => {
	// timeSeconds * 60 が Infinity に overflow する領域。 そのまま返すと
	// evaluateSample の sub-step ループが終了しなくなるため throw で弾く
	assert.throws(() => timeToStepIndex(Number.MAX_VALUE), RangeError)
	assert.throws(() => timeToStepIndex(1e308), RangeError)
})

test('stepIndexFromFrame: frame 番号から step を直接引く (k = 0..100000)', () => {
	for (let k = 0; k <= 100000; k++) {
		assert.equal(stepIndexFromFrame(k), k * 3, `k=${k}`)
		if (k > 0) {
			// 連続する frame の差は常に 3 (= 浮動小数の秒を経由しないため変動しない)
			assert.equal(stepIndexFromFrame(k) - stepIndexFromFrame(k - 1), 3, `k=${k}`)
		}
	}
})

test('stepIndexFromFrame: 非整数 / 非有限値は RangeError', () => {
	assert.throws(() => stepIndexFromFrame(1.5), RangeError)
	assert.throws(() => stepIndexFromFrame(Number.NaN), RangeError)
	assert.throws(() => stepIndexFromFrame(Number.POSITIVE_INFINITY), RangeError)
	// Number.MAX_SAFE_INTEGER は isInteger を通過するが、 3 倍した積が safe integer を
	// 外れるため入力側 / 積側の両方の検証で弾く
	assert.throws(() => stepIndexFromFrame(Number.MAX_SAFE_INTEGER), RangeError)
	assert.throws(() => stepIndexFromFrame(Number.MAX_SAFE_INTEGER + 1), RangeError)
	// 積が safe integer に収まる境界は通る
	assert.equal(stepIndexFromFrame(Math.floor(Number.MAX_SAFE_INTEGER / 3)), Math.floor(Number.MAX_SAFE_INTEGER / 3) * 3)
})

test('累積加算した秒は格子に乗らないため export では frame 番号経由を使う', () => {
	// 実測固定 : t += 0.05 を 60 回繰り返すと 2.9999999999999973 となり、
	// timeToStepIndex では 180 ではなく 179 と評価される (= 累積加算された値は
	// 1/60 格子上の点ではないため、 tolerance を広げても根治しない)。
	// これを保証対象外の仕様として固定する。 同じ frame を stepIndexFromFrame で
	// 引けば厳密に 180 になる (= export 経路はこちらを使う)。
	let t = 0
	for (let i = 0; i < 60; i++) t += 0.05
	assert.equal(timeToStepIndex(t), 179)
	assert.equal(stepIndexFromFrame(60), 180)
})

// --- SpringRuntime lifecycle ---

// stub ops : 呼ばれた順に {fn, args} を calls へ push するだけ (= BB 無しで検証するための口)。
// throwOnStep = n で n 回目の stepAndApplyOrdered が 1 度だけ throw (= stepError で例外
// object を指定可能)、 restoreError / updateError / configError を渡すと
// restorePose / updateMatrixWorld / resolveConfigs が常にそれを throw する。
// evaluatingLog には各 call 発生時点の runtime.isEvaluating が記録される。
// restWindow を渡すと context に載る (= 終端 rest 整合の weight が有効になる)。
// 渡さない場合は従来どおり weight ≡ 1。
function makeRuntime(calls, { throwOnStep = -1, stepError = null, restoreError = null, updateError = null, configError = null, restWindow = undefined } = {}) {
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
		resolveConfigs: record('resolveConfigs', () => {
			if (configError) throw configError
		}),
		capturePose: record('capturePose', () => ({ snapshot: true })),
		restorePose: record('restorePose', () => {
			if (restoreError) throw restoreError
		}),
		updateMatrixWorld: record('updateMatrixWorld', () => {
			if (updateError) throw updateError
		}),
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
	const context = { animation: null, restWindow }
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

test('SpringRuntime: updateMatrixWorld が throw しても例外経路が完走する', () => {
	const updateErr = new Error('update failed')
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { updateError: updateErr })
	runtime.beginAnimation(context, basePose)
	calls.length = 0

	// 正常系で updateMatrixWorld だけが throw → その例外がそのまま伝播する
	assert.throws(() => runtime.evaluateSample(0.05), (e) => e === updateErr)
	const names = fnNames(calls)
	assert.ok(names.includes('restorePose'))
	assert.ok(names.includes('updateMatrixWorld'))
	assert.ok(!names.includes('applyOnlyOrdered'))
	assert.equal(runtime.currentStepIndex, null)
	assert.equal(runtime.isEvaluating, false)
})

test('SpringRuntime: sub-step と updateMatrixWorld が両方 throw → sub-step 由来が伝播', () => {
	const stepErr = new Error('step failed')
	const updateErr = new Error('update failed')
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, {
		throwOnStep: 1,
		stepError: stepErr,
		updateError: updateErr,
	})
	runtime.beginAnimation(context, basePose)
	calls.length = 0

	// 優先順位 sub-step > restorePose > updateMatrixWorld。 identity で判定する
	assert.throws(() => runtime.evaluateSample(0.05), (e) => e === stepErr)
	const names = fnNames(calls)
	assert.ok(names.includes('restorePose'))
	assert.ok(names.includes('updateMatrixWorld'))
	assert.ok(!names.includes('applyOnlyOrdered'))
	assert.equal(runtime.currentStepIndex, null)
})

test('SpringRuntime: session は beginAnimation ごとに独立 (= 張り直しで step cache が戻る)', () => {
	// index.ts の ensurePreviewSession は BB 依存で node:test から触れないため、
	// runtime 側の契約 (= beginAnimation が前 session を破棄する) で代替検証する。
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(0.05)
	calls.length = 0

	// 同じ context で続けると step cache が維持される (= advance 経路)
	const advance = runtime.evaluateSample(0.10)
	assert.equal(advance.mode, 'advance')
	assert.equal(runtime.currentStepIndex, 6)

	// 別 context で beginAnimation し直すと step cache は null に戻る (= 次が replay)
	const contextB = { animation: { name: 'B' } }
	runtime.beginAnimation(contextB, basePose)
	assert.equal(runtime.currentStepIndex, null)
	calls.length = 0
	const replay = runtime.evaluateSample(0.10)
	assert.equal(replay.mode, 'replay')
	assert.equal(runtime.currentStepIndex, 6)
	// 新しい context が ops / evaluator へ届いている
	for (const c of calls.filter((c) => ['resetAllToRest', 'stepAndApplyOrdered', 'applyOnlyOrdered'].includes(c.fn))) {
		assert.ok(c.args[c.args.length - 1] === contextB, `${c.fn}`)
	}
})

test('SpringRuntime: applyWithoutAdvance は applyOnlyOrdered を 1 回だけ呼ぶ', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(0.05)
	calls.length = 0

	runtime.applyWithoutAdvance()
	assert.deepEqual(fnNames(calls), ['applyOnlyOrdered'])
	// step / base pose は呼ばれず、 step cache も変化しない
	assert.equal(runtime.currentStepIndex, 3)
})

test('SpringRuntime: evaluateStepIndex(stepIndexFromFrame(k)) は各 frame で 3 sub-step', () => {
	// 1 export frame = 3 sub-step の直接検証。 秒を一切経由しない export driver の
	// 呼び方そのまま (= stepIndexFromFrame の戻り値を evaluateStepIndex に渡す)。
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)

	// k = 0 は初回 replay で step 0 に初期化されるだけ (= sub-step 無し)
	const first = runtime.evaluateStepIndex(stepIndexFromFrame(0))
	assert.equal(first.mode, 'replay')
	assert.equal(first.substepCount, 0)
	assert.equal(first.stepIndex, 0)

	// k = 1..10 は各回ちょうど 3 sub-step (= 浮動小数の累積誤差で変動しない)
	for (let k = 1; k <= 10; k++) {
		const result = runtime.evaluateStepIndex(stepIndexFromFrame(k))
		assert.equal(result.substepCount, 3, `k=${k}`)
		assert.equal(result.stepIndex, k * 3, `k=${k}`)
		assert.equal(result.mode, 'advance', `k=${k}`)
	}
})

test('SpringRuntime: evaluateStepIndex は負値 / 非整数 / 非 safe-integer で RangeError', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	assert.throws(() => runtime.evaluateStepIndex(-1), RangeError)
	assert.throws(() => runtime.evaluateStepIndex(1.5), RangeError)
	assert.throws(() => runtime.evaluateStepIndex(Number.NaN), RangeError)
	assert.throws(() => runtime.evaluateStepIndex(Number.MAX_SAFE_INTEGER + 1), RangeError)
	// いずれも ops は呼ばれない
	assert.deepEqual(fnNames(calls), ['resolveConfigs'])
})

test('SpringRuntime: evaluateSample と evaluateStepIndex は同じ結果を返す', () => {
	const callsA = []
	const callsB = []
	const a = makeRuntime(callsA)
	const b = makeRuntime(callsB)
	a.runtime.beginAnimation(a.context, a.basePose)
	b.runtime.beginAnimation(b.context, b.basePose)

	for (const seconds of [0.05, 0.10, 0.15, 0.10, 0.50]) {
		const viaSample = a.runtime.evaluateSample(seconds)
		const viaStep = b.runtime.evaluateStepIndex(timeToStepIndex(seconds))
		assert.deepEqual(viaStep, viaSample, `seconds=${seconds}`)
	}
	// 呼び出し列も一致する (= 薄いラッパーであることの検証)
	assert.deepEqual(fnNames(callsA), fnNames(callsB))
})

test('SpringRuntime: resolveConfigs が throw したら session は確定しない', () => {
	const configErr = new Error('config resolve failed')
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { configError: configErr })

	assert.throws(() => runtime.beginAnimation(context, basePose), (e) => e === configErr)
	// 半端な session が残っていない (= 後続の evaluateSample は「session 未開始」 で弾く)
	assert.equal(runtime.currentStepIndex, null)
	assert.throws(() => runtime.evaluateSample(0.05), /session not started/)

	// 正常な ops で begin し直せば復帰できる
	const calls2 = []
	const ok = makeRuntime(calls2)
	ok.runtime.beginAnimation(ok.context, ok.basePose)
	assert.equal(ok.runtime.evaluateSample(0.05).mode, 'replay')
})

// --- 終端 rest 整合の weight ---

// timing = 21 sample (= length 1 秒相当) の once。 displayedFinalFrame = 20、
// fadeEndStep = 60、 fade 4 frame なので fadeStartStep = 48。
const REST_TIMING = { renderSampleCount: 21, loopMode: 'once', loopDelayFrames: 0 }
const REST_WINDOW = { timing: REST_TIMING, requestedFadeFrames: 4 }
const FINAL_FRAME = deriveDisplayedFinalFrame(REST_TIMING)
const expectedWeight = (stepIndex) => computeRestWindowWeight(stepIndex, FINAL_FRAME, 4)
// ops の呼び出し記録から weight 引数だけを抜く (= stepAndApplyOrdered は args[1]、
// applyOnlyOrdered は args[0])。
const stepWeights = (calls) => calls.filter((c) => c.fn === 'stepAndApplyOrdered').map((c) => c.args[1])
const applyWeights = (calls) => calls.filter((c) => c.fn === 'applyOnlyOrdered').map((c) => c.args[0])

test('SpringRuntime: rest window が無い context では weight ≡ 1 (= 従来動作)', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls)
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(0.05)
	runtime.applyWithoutAdvance()

	assert.deepEqual(stepWeights(calls), [1, 1, 1])
	assert.deepEqual(applyWeights(calls), [1, 1])
})

// index.ts の makePreviewRestWindow 相当。 数え切れない length と契約違反の timing の
// どちらでも窓ごと省略する (= preview は止めず、 減衰だけ諦めて従来動作へ倒す)。
const makePreviewRestWindow = (lengthSeconds, loopMode = 'once', loopDelayFrames = 0) => {
	const renderSampleCount = deriveRenderSampleCount(lengthSeconds)
	if (renderSampleCount === null) return undefined
	const timing = { renderSampleCount, loopMode, loopDelayFrames }
	return checkPreviewRestWindowTiming(timing) !== null ? undefined : { timing, requestedFadeFrames: 4 }
}

// restWindow を省略した context で全 step の weight が exact 1 になることを確認する。
const assertNoDecay = (restWindow, label) => {
	const calls = []
	assert.equal(restWindow, undefined, label)
	const { runtime, context, basePose } = makeRuntime(calls, { restWindow })
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(stepIndexToTime(70))
	runtime.applyWithoutAdvance()
	// 物理が消えない (= 全 step で Δ をそのまま載せる)
	for (const w of stepWeights(calls)) assert.strictEqual(w, 1, label)
	for (const w of applyWeights(calls)) assert.strictEqual(w, 1, label)
}

test('SpringRuntime: 数え切れない length の preview context では w ≡ 1 に倒れる', () => {
	// +Infinity = 終わらない条件。 「時刻が進まない」 側も deriveRenderSampleCount が同じ
	// null を返すため、 ここから先の経路は共通 (= 進まない判定自体は restWindow.test.mjs の
	// nextRenderSampleTime で固定している)。
	assert.equal(deriveRenderSampleCount(Number.POSITIVE_INFINITY), null)
	assertNoDecay(makePreviewRestWindow(Number.POSITIVE_INFINITY), 'length=+Infinity')
})

test('SpringRuntime: 契約違反の timing を弾いた preview context では w ≡ 1 に倒れる', () => {
	// length 由来 (= 0 件になる) の経路
	for (const length of [Number.NaN, Number.NEGATIVE_INFINITY, -1]) {
		assertNoDecay(makePreviewRestWindow(length), `length=${length}`)
	}
	// timing 由来 (= 未知 loopMode) の経路
	assertNoDecay(makePreviewRestWindow(1, 'ping_pong'), 'loopMode=ping_pong')

	// 正当な length / loopMode では窓が作られ、 終端で減衰する (= 上の縮退と対になる確認)
	const restWindow = makePreviewRestWindow(1, 'once', 0)
	assert.notEqual(restWindow, undefined)
	assert.equal(restWindow.timing.renderSampleCount, 21)
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { restWindow })
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(stepIndexToTime(60))
	assert.deepEqual(applyWeights(calls), [0])
})

test('SpringRuntime: sub-step の weight は「これから進む step (= next)」 基準', () => {
	// stepIndex はまだ更新されていないため、 現在値で出すと 1 step ぶん手前の weight になる。
	// 減衰区間 (= step 48..60) をまたぐ範囲で列を固定する
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { restWindow: REST_WINDOW })
	runtime.beginAnimation(context, basePose)
	// 初回評価は replay。 ここまでの呼び出しは捨てて、 次の advance だけを見る
	runtime.evaluateSample(stepIndexToTime(20))
	calls.length = 0
	// 20 → 50 step (= 30 step 前進なので advance 経路、 減衰開始 48 をまたぐ)
	runtime.evaluateSample(stepIndexToTime(50))

	const weights = stepWeights(calls)
	assert.equal(weights.length, 30)
	// k 番目の sub-step は step 21..50 に対応する
	assert.deepEqual(weights, Array.from({ length: 30 }, (_, i) => expectedWeight(21 + i)))
	// 減衰開始前は 1、 開始後は 1 未満 (= next 基準で 1 step ズレていないことの裏取り)
	assert.equal(weights[0], 1)                       // step 21
	assert.equal(weights[27], expectedWeight(48))     // step 48 = fadeStartStep → 1
	assert.equal(weights[27], 1)
	assert.ok(weights[28] < 1)                        // step 49 = 減衰区間の内側
})

test('SpringRuntime: sub-step ループ後の applyOnlyOrdered は現在 step の weight', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { restWindow: REST_WINDOW })
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(stepIndexToTime(50))
	// 最後の sub-step (= step 50) と apply の weight が一致する
	const weights = stepWeights(calls)
	assert.equal(weights[weights.length - 1], expectedWeight(50))
	assert.deepEqual(applyWeights(calls), [expectedWeight(50)])
})

test('SpringRuntime: same-step 評価は現在 step の weight を使う', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { restWindow: REST_WINDOW })
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(stepIndexToTime(55))
	calls.length = 0

	const result = runtime.evaluateSample(stepIndexToTime(55))
	assert.equal(result.mode, 'same-step')
	assert.deepEqual(stepWeights(calls), [])
	assert.deepEqual(applyWeights(calls), [expectedWeight(55)])
})

test('SpringRuntime: applyWithoutAdvance は現在 step の weight を再利用する', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { restWindow: REST_WINDOW })
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(stepIndexToTime(55))
	calls.length = 0

	runtime.applyWithoutAdvance()
	runtime.applyWithoutAdvance()
	// 何度呼んでも同じ weight (= state を進めないので冪等)
	assert.deepEqual(applyWeights(calls), [expectedWeight(55), expectedWeight(55)])
})

test('SpringRuntime: 終点以後の weight は exact 0 で ops へ届く', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { restWindow: REST_WINDOW })
	runtime.beginAnimation(context, basePose)
	// fadeEndStep = 60 ちょうど
	runtime.evaluateSample(stepIndexToTime(60))
	const weights = stepWeights(calls)
	assert.strictEqual(weights[weights.length - 1], 0)
	assert.deepEqual(applyWeights(calls), [0])

	// 終点より後も 0 のまま
	calls.length = 0
	runtime.evaluateSample(stepIndexToTime(70))
	for (const w of stepWeights(calls)) assert.strictEqual(w, 0)
	assert.deepEqual(applyWeights(calls), [0])
})

test('SpringRuntime: replay 経路でも weight は step 番号に追従する', () => {
	// replay は step 0 から数え直すため、 weight 列も step 1..N の順で出る
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { restWindow: REST_WINDOW })
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(stepIndexToTime(60))
	calls.length = 0

	// 逆行 = replay (= 0 から 50 まで数え直す)
	const result = runtime.evaluateSample(stepIndexToTime(50))
	assert.equal(result.mode, 'replay')
	const weights = stepWeights(calls)
	assert.equal(weights.length, 50)
	assert.deepEqual(weights, Array.from({ length: 50 }, (_, i) => expectedWeight(1 + i)))
})

test('SpringRuntime: weight は ops へ context と一緒に届く (= 引数順の固定)', () => {
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, { restWindow: REST_WINDOW })
	runtime.beginAnimation(context, basePose)
	runtime.evaluateSample(stepIndexToTime(1))

	const step = calls.find((c) => c.fn === 'stepAndApplyOrdered')
	// stepAndApplyOrdered(dtSeconds, weight, context)
	assert.equal(step.args.length, 3)
	assert.equal(step.args[0], 1 / 60)
	assert.equal(step.args[1], expectedWeight(1))
	assert.ok(step.args[2] === context)

	const apply = calls.find((c) => c.fn === 'applyOnlyOrdered')
	// applyOnlyOrdered(weight, context)
	assert.equal(apply.args.length, 2)
	assert.equal(apply.args[0], expectedWeight(1))
	assert.ok(apply.args[1] === context)
})

test('SpringRuntime: restorePose と updateMatrixWorld が両方 throw → restorePose 由来が伝播', () => {
	// sub-step は成功し、 後段 2 つが連続で失敗する分岐。 優先順位
	// sub-step > restorePose > updateMatrixWorld の restore > update 部分を検証する。
	const restoreErr = new Error('restore failed')
	const updateErr = new Error('update failed')
	const calls = []
	const { runtime, context, basePose } = makeRuntime(calls, {
		restoreError: restoreErr,
		updateError: updateErr,
	})
	runtime.beginAnimation(context, basePose)
	calls.length = 0

	assert.throws(() => runtime.evaluateSample(0.05), (e) => e === restoreErr)
	const names = fnNames(calls)
	// sub-step は完走している (= 全 3 sub-step 成功) が、 後段失敗で applyOnlyOrdered は呼ばれない
	assert.equal(names.filter((n) => n === 'stepAndApplyOrdered').length, 3)
	assert.ok(names.includes('restorePose'))
	assert.ok(names.includes('updateMatrixWorld'))
	assert.ok(!names.includes('applyOnlyOrdered'))
	assert.equal(runtime.currentStepIndex, null)
})
