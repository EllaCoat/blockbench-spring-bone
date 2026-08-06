// export 中の preview 抑止を **本物の module を繋いだ状態** で固定する統合テスト。
//
// 各 module の unit test (= exportGate / previewSession / ajExportBridge / animationContext)
// は「部品単体が正しいか」 だけを見る。 ここで見るのは **繋ぎ方** : PR #7 の review loop で
// 2 度 MUST が出たのはどれも配線側の誤りで、 部品の unit test では拾えなかった。
//
// fake にするのは **SpringRuntime と rescanRegistry の 2 つだけ**。 gate / session / driver /
// export context factory はすべて本物を import して繋ぐ。
//
// **この配線は src/index.ts の `createPreviewSession(...)` 呼び出しと `exportDriverHost`
// の定義を写したもの。 index.ts 側の配線が変わったらここも追従すること。**
// (= 行番号は commit ごとにずれるため識別子で指す)
// 写経である以上 drift のリスクはあるが、 繋ぎ方の退行を検出する価値の方が大きいと判断して
// 受容している (= 追従先を上に明示しておくのがその対価)。
import test from 'node:test'
import assert from 'node:assert/strict'

const { createExportGate } = await import('../dist-test/exportGate.mjs')
const { createPreviewSession } = await import('../dist-test/previewSession.mjs')
const { createExportDriver } = await import('../dist-test/ajExportBridge.mjs')
const { makeExportAnimationContext } = await import('../dist-test/animationContext.mjs')
const {
	ANIM_REST_FADE_KEY,
	DEFAULT_REST_FADE_FRAMES,
	checkRestWindowTiming,
} = await import('../dist-test/restWindow.mjs')

// AJ の export 格子 = 20 fps。 driver は秒を見ず frameIndex だけで判定する。
const EXPORT_FRAME_SECONDS = 1 / 20
// AJ が pre-post 判定に使う side sample の時刻オフセット (= updatePreview(frameTime + 0.001))。
const SIDE_SAMPLE_OFFSET = 0.001
// stepIndexFromFrame の倍率 (= 1 export frame あたりの物理 sub-step 数)。
const SUBSTEPS_PER_EXPORT_FRAME = 3

// index.ts の readRestFadeFrames 相当 (= 非 finite / 未設定は既定値へ倒す)。
function readRestFadeFrames(animation) {
	const raw = animation?.[ANIM_REST_FADE_KEY]
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_REST_FADE_FRAMES
}

// AJ v2 が context に載せる周期情報の既定値 (= 1 秒 / once)。
const DEFAULT_TIMING = {
	animationLengthSeconds: 1,
	renderSampleCount: 21,
	loopMode: 'once',
	loopDelayFrames: 0,
}

// --- fake SpringRuntime ------------------------------------------------------

// 本物 (= src/springRuntime.ts) の外部契約だけを再現する stub。 再現するのは :
// - beginAnimation は **先に旧 session を破棄してから** 確定させる (= 失敗時に残さない)
// - evaluateStepIndex は session 未開始なら throw、 失敗時は stepIndex を null へ戻す
//   (= 次回が必ず 0 replay になる契約)、 実行中だけ isEvaluating が true
// - applyWithoutAdvance は session 未開始 / 未評価なら throw
// - endAnimation は context / evaluator / stepIndex を破棄する
// currentStepIndex / isEvaluating は **getter** で持たせる : 値のスナップショットだと
// driver の advance / reapply 判定が再現できない。
function makeRuntime(log, { beginError = null, evaluateError = null } = {}) {
	let context = null
	let evaluator = null
	let stepIndex = null
	let evaluating = false
	return {
		get currentStepIndex() { return stepIndex },
		get isEvaluating() { return evaluating },
		// session に載っている context の観測口 (= 本物には無いテスト専用の窓)
		get sessionContext() { return context },
		beginAnimation(nextContext, evaluateBasePose) {
			log.push('runtime:begin')
			context = null
			evaluator = null
			stepIndex = null
			if (beginError) throw beginError
			context = nextContext
			evaluator = evaluateBasePose
		},
		evaluateStepIndex(target) {
			log.push(`runtime:evaluate:${target}`)
			if (context === null || evaluator === null) {
				throw new Error('SpringRuntime.evaluateStepIndex: session not started')
			}
			evaluating = true
			try {
				if (evaluateError) {
					stepIndex = null
					throw evaluateError
				}
				stepIndex = target
			} finally {
				evaluating = false
			}
		},
		applyWithoutAdvance() {
			log.push('runtime:apply')
			if (context === null || stepIndex === null) {
				throw new Error('SpringRuntime.applyWithoutAdvance: session not started or not evaluated yet')
			}
		},
		endAnimation() {
			log.push('runtime:end')
			context = null
			evaluator = null
			stepIndex = null
		},
	}
}

// --- 配線 (= src/index.ts の写し) --------------------------------------------

function makeHarness({ enabled = true, beginError = null, evaluateError = null } = {}) {
	const log = []
	const runtime = makeRuntime(log, { beginError, evaluateError })
	// rescan が呼ばれた瞬間の gate 状態を記録する (= resume の内部順序を end-to-end で固定)。
	const rescanCalls = []
	// index.ts の applyPoseAt 相当。 preview 経路の base pose 評価は BB 依存なので stub。
	const applyPoseAt = () => { log.push('preview:applyPoseAt') }
	// index.ts の isEnabled は `ENABLE_AJ_EXPORT && registry.size > 0`。
	// どちらも BB / 定数由来なので、 ここでは 1 つの flag に畳む。
	let isEnabled = enabled

	// index.ts: const exportGate = createExportGate({ rescan: () => rescanRegistry() })
	const exportGate = createExportGate({
		rescan: () => {
			log.push('rescan')
			rescanCalls.push({ isExportActive: exportGate.isExportActive })
		},
	})

	// index.ts: const previewSession = createPreviewSession<PreviewAnimationContext>({...})
	const previewSession = createPreviewSession({
		get isExportActive() { return exportGate.isExportActive },
		getAnimation: (context) => context.animation,
		getStack: (context) => context.animationStack,
		endAnimation: () => { runtime.endAnimation() },
		beginAnimation: (context) => { runtime.beginAnimation(context, applyPoseAt) },
	})

	// index.ts: const exportDriverHost: ExportDriverHost<PreviewAnimationContext> = {...}
	// invalidatePreview は index.ts では 1 行 wrapper の invalidatePreviewSession() 経由。
	const exportDriverHost = {
		beginAnimation: (context, evaluateBasePose) => { runtime.beginAnimation(context, evaluateBasePose) },
		evaluateStepIndex: (stepIndex) => { runtime.evaluateStepIndex(stepIndex) },
		applyWithoutAdvance: () => { runtime.applyWithoutAdvance() },
		endAnimation: () => { runtime.endAnimation() },
		get currentStepIndex() { return runtime.currentStepIndex },
		get isEvaluating() { return runtime.isEvaluating },
		suspendTick: () => { exportGate.suspend() },
		resumeTick: () => { exportGate.resume() },
		invalidatePreview: () => { previewSession.invalidate() },
		// index.ts と同じく AJ v2 の周期情報をそのまま rest window の入力にし、
		// fade 長だけを animation Property から読む。 契約違反の timing は throw して
		// export を止める (= 物理が載っていない datapack を黙って出さない)。
		makeExportContext: (animation, excludedNodeUuids, timing) => {
			const restTiming = {
				renderSampleCount: timing.renderSampleCount,
				loopMode: timing.loopMode,
				loopDelayFrames: timing.loopDelayFrames,
			}
			const violation = checkRestWindowTiming(restTiming)
			if (violation !== null) {
				throw new Error(`[spring_bone] AnimatedJava render hook supplied invalid animation timing (${violation})`)
			}
			return makeExportAnimationContext(animation, excludedNodeUuids, {
				timing: restTiming,
				requestedFadeFrames: readRestFadeFrames(animation),
			})
		},
		isEnabled: () => isEnabled,
	}
	const driver = createExportDriver(exportDriverHost)

	return {
		log,
		runtime,
		rescanCalls,
		exportGate,
		previewSession,
		driver,
		setEnabled(value) { isEnabled = value },
		// index.ts の tick 冒頭 guard (= `if (exportGate.isExportActive || ...) return`) 相当。
		// preview 側が止まっているかの観測に使う。
		get isPreviewTickSuppressed() { return exportGate.isExportActive },
	}
}

// index.ts の makePreviewAnimationContext 相当 (= 選択中 animation だけを stack に積む形)。
function previewContext(animation) {
	return { animation, animationStack: animation === null ? [] : [animation] }
}

// AJ が onBeginAnimation へ渡す context。
function ajAnimationContext(animation, excludedNodeUuids = new Set(), timing = DEFAULT_TIMING) {
	return { animation, excludedNodeUuids, ...timing, evaluateBasePose: () => {} }
}

// AJ が onPose へ渡す context。 side=true で pre-post 判定の side sample を作る。
function ajPoseContext(animation, frameIndex, { side = false, excludedNodeUuids = new Set() } = {}) {
	const frameTimeSeconds = frameIndex * EXPORT_FRAME_SECONDS
	return {
		animation,
		excludedNodeUuids,
		...DEFAULT_TIMING,
		evaluateBasePose: () => {},
		frameIndex,
		frameTimeSeconds,
		timeSeconds: side ? frameTimeSeconds + SIDE_SAMPLE_OFFSET : frameTimeSeconds,
	}
}

// =============================================================================
// シナリオ A : export 中の preview invalidate が export session を壊さない
// (= PR #7 review loop 1 巡目の MUST の根)
// =============================================================================

test('統合 A: onBeginRendering は preview session を畳んでから tick を止める', () => {
	const h = makeHarness()
	const previewAnim = { name: 'preview' }
	// export 前に preview session が張られている状態を作る
	h.previewSession.ensure(previewContext(previewAnim))
	assert.deepEqual(h.log, ['runtime:end', 'runtime:begin'])
	assert.equal(h.previewSession.isActive, true)
	assert.equal(h.exportGate.isExportActive, false)

	h.log.length = 0
	h.driver.onBeginRendering()
	// invalidatePreview → suspendTick の順。 逆順だと gate が先に active になって
	// invalidate が no-op に落ち、 stale な preview session が残ったまま export へ入る。
	assert.deepEqual(h.log, ['runtime:end'])
	assert.equal(h.previewSession.isActive, false)
	assert.equal(h.exportGate.isExportActive, true)
	assert.equal(h.isPreviewTickSuppressed, true)
})

test('統合 A: export 中の preview invalidate は runtime に触らない', () => {
	const h = makeHarness()
	const anim = { name: 'walk' }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim))
	h.log.length = 0

	// finished_edit / Property 変更 / project 切替 / mode 切替 / undo … どの経路から来ても
	// 行き着く先は invalidatePreviewSession() の 1 箇所なので、 複数回呼んで固定する。
	h.previewSession.invalidate()
	h.previewSession.invalidate()
	h.previewSession.invalidate()
	assert.deepEqual(h.log, [])
	// export 用 runtime session が生存している
	assert.notEqual(h.runtime.sessionContext, null)
})

test('統合 A: export 中に invalidate を挟んでも後続 onPose が session not started で落ちない', () => {
	const h = makeHarness()
	const anim = { name: 'walk' }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim))

	// frame 0 を評価してから preview 経路の invalidate が割り込む
	h.driver.onPose(ajPoseContext(anim, 0))
	h.log.length = 0
	h.previewSession.invalidate()
	// 同じ frame の 2 回目 (= IK の二度呼び) は applyWithoutAdvance へ流れる。
	// invalidate が漏れていれば runtime の stepIndex が null に戻り、 ここで
	// 「session not started or not evaluated yet」 で throw する = 1 巡目の MUST の症状。
	h.driver.onPose(ajPoseContext(anim, 0))
	h.driver.onPose(ajPoseContext(anim, 0, { side: true }))
	assert.deepEqual(h.log, ['runtime:apply', 'runtime:apply'])

	// 次 frame も advance が正しく走る (= 抑止が効いたまま export が進む)
	h.log.length = 0
	h.previewSession.invalidate()
	h.driver.onPose(ajPoseContext(anim, 1))
	assert.deepEqual(h.log, [`runtime:evaluate:${SUBSTEPS_PER_EXPORT_FRAME}`])
})

test('統合 A: export 中は animation を跨いでも invalidate が漏れない', () => {
	const h = makeHarness()
	const animA = { name: 'A' }
	const animB = { name: 'B' }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(animA))
	h.driver.onPose(ajPoseContext(animA, 0))
	h.previewSession.invalidate()
	h.driver.onEndAnimation()

	h.log.length = 0
	h.previewSession.invalidate()
	h.driver.onBeginAnimation(ajAnimationContext(animB))
	h.previewSession.invalidate()
	// animation B の frame 0 は 0 から張り直す (= onEndAnimation で stepIndex が null)
	h.driver.onPose(ajPoseContext(animB, 0))
	h.driver.onPose(ajPoseContext(animB, 0))
	assert.deepEqual(h.log, ['runtime:begin', 'runtime:evaluate:0', 'runtime:apply'])
})

// export context factory (= C1) まで含めて本物が繋がっていることの確認。
test('統合 A: AJ の excludedNodeUuids は同一 Set instance のまま runtime へ届く', () => {
	const h = makeHarness()
	const anim = { name: 'walk' }
	const excluded = new Set(['uuid-a', 'uuid-b'])
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim, excluded))
	const context = h.runtime.sessionContext
	assert.equal(context.animation, anim)
	assert.equal(context.excludedNodeUuids, excluded)
	assert.deepEqual(context.animationStack, [anim])
})

test('統合 A: AJ の周期情報と animation の fade 長が rest window として runtime へ届く', () => {
	// 配線の全長 (= AJ context → driver → makeExportContext → export context) を通して、
	// weight 算出の入力が欠けずに runtime の session context へ載ることを固定する。
	const h = makeHarness()
	const anim = { name: 'walk', [ANIM_REST_FADE_KEY]: 6 }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim, new Set(), {
		animationLengthSeconds: 3,
		renderSampleCount: 61,
		loopMode: 'loop',
		loopDelayFrames: 0,
	}))
	const restWindow = h.runtime.sessionContext.restWindow
	// timing は AJ の値そのまま (= preview 側の数え直しを export では使わない)
	assert.deepEqual(restWindow.timing, {
		renderSampleCount: 61,
		loopMode: 'loop',
		loopDelayFrames: 0,
	})
	assert.equal(restWindow.requestedFadeFrames, 6)
})

test('統合 A: fade 長 Property が無い animation は既定値で rest window に載る', () => {
	const h = makeHarness()
	const anim = { name: 'walk' }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim))
	assert.equal(h.runtime.sessionContext.restWindow.requestedFadeFrames, DEFAULT_REST_FADE_FRAMES)
})

test('統合 A: 契約違反の timing は export を止める (= throw して session を張らない)', () => {
	// 0 へ正規化して続行すると weight ≡ 0 = 物理が全く載っていない datapack が黙って出る。
	// AJ は hook の例外を RenderHookError に包んで export エラーへ surface するため、
	// ここで throw すればユーザーが気付ける。
	const brokenTimings = [
		{ animationLengthSeconds: 1, renderSampleCount: Number.NaN, loopMode: 'once', loopDelayFrames: 0 },
		{ animationLengthSeconds: 1, renderSampleCount: -1, loopMode: 'once', loopDelayFrames: 0 },
		{ animationLengthSeconds: 1, renderSampleCount: 20.5, loopMode: 'once', loopDelayFrames: 0 },
		{ animationLengthSeconds: 1, renderSampleCount: 21, loopMode: 'ping_pong', loopDelayFrames: 0 },
	]
	for (const timing of brokenTimings) {
		const h = makeHarness()
		const anim = { name: 'walk' }
		h.driver.onBeginRendering()
		assert.throws(
			() => h.driver.onBeginAnimation(ajAnimationContext(anim, new Set(), timing)),
			/invalid animation timing/,
			JSON.stringify(timing),
		)
		// session は張られない (= 以降の onPose は no-op)
		assert.equal(h.driver.isAnimationActive, false)
		assert.equal(h.runtime.sessionContext, null)
		h.log.length = 0
		h.driver.onPose(ajPoseContext(anim, 0))
		assert.deepEqual(h.log, [])
		// onEndRendering は通常どおり後始末できる (= tick が止まったままにならない)
		h.driver.onEndRendering()
		assert.equal(h.exportGate.isExportActive, false)
	}
})

test('統合 A: 正当な極小 animation (= N 0 / 1 / 2) は export を止めない', () => {
	// 契約違反と混同すると、 正しい出力まで export できなくなる
	for (const renderSampleCount of [0, 1, 2]) {
		const h = makeHarness()
		const anim = { name: 'tiny' }
		h.driver.onBeginRendering()
		h.driver.onBeginAnimation(ajAnimationContext(anim, new Set(), {
			animationLengthSeconds: 0,
			renderSampleCount,
			loopMode: 'loop',
			loopDelayFrames: 0,
		}))
		assert.equal(h.driver.isAnimationActive, true, `N=${renderSampleCount}`)
		assert.equal(h.runtime.sessionContext.restWindow.timing.renderSampleCount, renderSampleCount)
	}
})

// =============================================================================
// シナリオ B : export 中の rescan 要求が defer され、 終了時の順序が守られる
// (= PR #7 review loop 2 巡目の MUST の根)
// =============================================================================

test('統合 B: export 中の rescan 要求は defer され、 終了時に非 active で 1 回だけ走る', () => {
	const h = makeHarness()
	const anim = { name: 'walk' }

	h.driver.onBeginRendering()
	assert.equal(h.exportGate.isExportActive, true)

	h.driver.onBeginAnimation(ajAnimationContext(anim))
	h.driver.onPose(ajPoseContext(anim, 0))

	// export 中の rescanRegistry() 相当。 その場では走らず予約だけが立つ。
	h.log.length = 0
	assert.equal(h.exportGate.deferRescanIfActive(), true)
	assert.deepEqual(h.log, [])
	assert.equal(h.exportGate.hasPendingRescan, true)

	h.driver.onEndAnimation()
	h.log.length = 0
	h.driver.onEndRendering()

	// driver の後始末は endAnimation → resumeTick → invalidatePreview の順。
	// resume の中で rescan が走り、 その後の invalidatePreview は gate が非 active に
	// なっているので実際に runtime.endAnimation() まで届く。
	assert.deepEqual(h.log, ['runtime:end', 'rescan', 'runtime:end'])
	// **rescan は gate が非 active の状態で呼ばれる** : 逆順だと rescanRegistry 自身の
	// defer guard が再び予約を立て、 永久 pending になる。
	assert.deepEqual(h.rescanCalls, [{ isExportActive: false }])
	assert.equal(h.exportGate.isExportActive, false)
	assert.equal(h.exportGate.hasPendingRescan, false)
})

test('統合 B: export 終了後は preview invalidate が再び効く', () => {
	const h = makeHarness()
	const anim = { name: 'walk' }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim))
	h.driver.onPose(ajPoseContext(anim, 0))
	h.driver.onEndAnimation()
	h.driver.onEndRendering()

	h.log.length = 0
	// export 中は no-op だった経路が、 終了後は runtime まで届く
	h.previewSession.invalidate()
	assert.deepEqual(h.log, ['runtime:end'])
	assert.equal(h.isPreviewTickSuppressed, false)

	// preview session の張り直しも通る (= 抑止が解けている)
	h.log.length = 0
	const previewAnim = { name: 'preview' }
	h.previewSession.ensure(previewContext(previewAnim))
	assert.deepEqual(h.log, ['runtime:end', 'runtime:begin'])
	assert.equal(h.previewSession.isActive, true)
})

test('統合 B: export 中に defer を何度重ねても resume 後の rescan は 1 回', () => {
	const h = makeHarness()
	const anim = { name: 'walk' }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim))

	// rescanRegistry / onSpringPropertyChange / update_selection … 複数経路から届く想定
	for (let i = 0; i < 5; i += 1) {
		assert.equal(h.exportGate.deferRescanIfActive(), true)
	}
	h.driver.onEndAnimation()
	h.driver.onEndRendering()
	assert.equal(h.rescanCalls.length, 1)

	// 続けて resume 相当が来ても再実行されない
	h.driver.onEndRendering()
	assert.equal(h.rescanCalls.length, 1)
})

test('統合 B: export 中に rescan 要求が無ければ終了時に rescan は走らない', () => {
	const h = makeHarness()
	const anim = { name: 'walk' }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim))
	h.driver.onEndAnimation()
	h.log.length = 0
	h.driver.onEndRendering()
	assert.deepEqual(h.log, ['runtime:end', 'runtime:end'])
	assert.deepEqual(h.rescanCalls, [])
})

// =============================================================================
// シナリオ C : 抑止が固着しない (= 例外経路でも gate が復帰する)
// =============================================================================

test('統合 C: onPose の例外は伝播し、 unwind 後に gate が復帰する', () => {
	const error = new Error('evaluate boom')
	const h = makeHarness({ evaluateError: error })
	const anim = { name: 'walk' }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim))

	// driver は onPose の例外を握り潰さず AJ 側へ伝播させる契約
	assert.throws(() => h.driver.onPose(ajPoseContext(anim, 0)), error)
	// 例外が出た時点ではまだ抑止中 (= AJ の unwind を待つ)
	assert.equal(h.exportGate.isExportActive, true)

	// AJ は例外経路でも onEndAnimation → onEndRendering を必ず届ける
	h.driver.onEndAnimation()
	h.driver.onEndRendering()
	assert.equal(h.exportGate.isExportActive, false)

	h.log.length = 0
	h.previewSession.invalidate()
	assert.deepEqual(h.log, ['runtime:end'])
})

test('統合 C: 例外経路でも defer 済みの rescan は非 active で取り戻される', () => {
	const error = new Error('evaluate boom')
	const h = makeHarness({ evaluateError: error })
	const anim = { name: 'walk' }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim))
	h.exportGate.deferRescanIfActive()

	assert.throws(() => h.driver.onPose(ajPoseContext(anim, 0)), error)
	h.driver.onEndAnimation()
	h.driver.onEndRendering()

	assert.deepEqual(h.rescanCalls, [{ isExportActive: false }])
	assert.equal(h.exportGate.hasPendingRescan, false)
})

test('統合 C: onBeginAnimation が失敗しても onEndRendering で抑止が解ける', () => {
	const error = new Error('resolveConfigs boom')
	const h = makeHarness({ beginError: error })
	const anim = { name: 'walk' }
	h.driver.onBeginRendering()
	assert.equal(h.exportGate.isExportActive, true)

	assert.throws(() => h.driver.onBeginAnimation(ajAnimationContext(anim)), error)
	// session が張れていないので後続の onPose は no-op (= runtime へ触らない)
	h.log.length = 0
	h.driver.onPose(ajPoseContext(anim, 0))
	assert.deepEqual(h.log, [])

	h.driver.onEndRendering()
	assert.equal(h.exportGate.isExportActive, false)
	h.log.length = 0
	h.previewSession.invalidate()
	assert.deepEqual(h.log, ['runtime:end'])
})

// =============================================================================
// 追加 : 介入しない project / 契約違反の二重 onBeginRendering
// =============================================================================

test('統合: isEnabled() が false なら gate も preview session も一切触られない', () => {
	const h = makeHarness({ enabled: false })
	const previewAnim = { name: 'preview' }
	h.previewSession.ensure(previewContext(previewAnim))
	h.log.length = 0

	h.driver.onBeginRendering()
	assert.deepEqual(h.log, [])
	assert.equal(h.exportGate.isExportActive, false)
	// preview session が生き残る (= 介入しない project で preview が止まらない)
	assert.equal(h.previewSession.isActive, true)

	// 以降の hook もすべて no-op
	const anim = { name: 'walk' }
	h.driver.onBeginAnimation(ajAnimationContext(anim))
	h.driver.onPose(ajPoseContext(anim, 0))
	h.driver.onEndAnimation()
	h.driver.onEndRendering()
	assert.deepEqual(h.log, [])
	assert.equal(h.exportGate.isExportActive, false)
	assert.equal(h.previewSession.isActive, true)
})

test('統合: isEnabled() が false でも preview の invalidate / ensure は通常どおり効く', () => {
	const h = makeHarness({ enabled: false })
	h.driver.onBeginRendering()
	h.log.length = 0
	const previewAnim = { name: 'preview' }
	h.previewSession.ensure(previewContext(previewAnim))
	h.previewSession.invalidate()
	assert.deepEqual(h.log, ['runtime:end', 'runtime:begin', 'runtime:end'])
})

// AJ が onEndRendering を落とした後に onBeginRendering が来る契約違反ケース。
// gate が counter だと解除されなくなるため、 boolean である必要がある。
test('統合: 二重 onBeginRendering の後でも onEndRendering 1 回で抑止が解ける', () => {
	const h = makeHarness()
	const anim = { name: 'walk' }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim))
	h.driver.onPose(ajPoseContext(anim, 0))

	// 2 回目の onBeginRendering : driver が前 session を畳んでから張り直す
	h.driver.onBeginRendering()
	assert.equal(h.exportGate.isExportActive, true)

	h.driver.onBeginAnimation(ajAnimationContext(anim))
	h.driver.onPose(ajPoseContext(anim, 0))
	h.driver.onEndAnimation()
	h.driver.onEndRendering()

	assert.equal(h.exportGate.isExportActive, false)
	h.log.length = 0
	h.previewSession.invalidate()
	assert.deepEqual(h.log, ['runtime:end'])
})

test('統合: 二重 onBeginRendering で 2 回目が isEnabled() false でも抑止は解ける', () => {
	const h = makeHarness()
	const anim = { name: 'walk' }
	h.driver.onBeginRendering()
	h.driver.onBeginAnimation(ajAnimationContext(anim))
	assert.equal(h.exportGate.isExportActive, true)

	// 2 回目に入る前に rig が空になった等で無効化される
	h.setEnabled(false)
	h.driver.onBeginRendering()
	// finishRendering が判定より先に走るので suspend は解除される
	assert.equal(h.exportGate.isExportActive, false)
	h.log.length = 0
	h.previewSession.invalidate()
	assert.deepEqual(h.log, ['runtime:end'])
})
