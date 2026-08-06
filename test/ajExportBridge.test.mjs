import test from 'node:test'
import assert from 'node:assert/strict'

const { createExportDriver } = await import('../dist-test/ajExportBridge.mjs')

// AJ の export 格子 = 20 fps。 frameIndex → 秒の写像はここでしか使わない
// (= driver 側は秒を一切見ず frameIndex だけで判定する、 という契約の裏返し)。
const EXPORT_FRAME_SECONDS = 1 / 20
// AJ が pre-post 判定に使う side sample の時刻オフセット (= animationRenderer.ts の
// updatePreview(frameTime + 0.001))。 driver がこれに反応してはいけない。
const SIDE_SAMPLE_OFFSET = 0.001

// --- fake host / fake AJ context -------------------------------------------

// driver が呼んだ op を発生順に log へ push するだけの stub host。
// currentStepIndex / isEvaluating は **getter** で持たせる : driver は判定のたびに
// 読み直す前提の設計なので、 値のスナップショットだと advance / reapply が再現できない。
// stepIndex の遷移は SpringRuntime の挙動に合わせる :
//   - beginAnimation / endAnimation で null (= 未評価)
//   - evaluateStepIndex 成功で target を保持
//   - evaluateStepIndex 失敗で null へ戻す (= 次回が必ず 0 replay になる runtime の契約)
// enabledSequence を渡すと isEnabled() の戻り値を呼ばれた順に消費する
// (= 「1 回目 true / 2 回目 false」 のような切り替わりを再現する口)。 尽きたら enabled を返す。
function makeHost({
	enabled = true,
	enabledSequence = [],
	beginAnimationError = null,
	evaluateError = null,
	endAnimationError = null,
	resumeTickError = null,
	invalidatePreviewError = null,
} = {}) {
	const log = []
	const pendingEnabled = [...enabledSequence]
	let stepIndex = null
	let evaluating = false
	let lastBasePoseWrapper = null
	const host = {
		beginAnimation(context, evaluateBasePose) {
			log.push({ fn: 'beginAnimation', context, evaluateBasePose })
			stepIndex = null
			// resolveConfigs 失敗相当 : session を確定させずに throw する
			if (beginAnimationError) throw beginAnimationError
			lastBasePoseWrapper = evaluateBasePose
		},
		evaluateStepIndex(target) {
			log.push({ fn: 'evaluateStepIndex', target })
			if (evaluateError) {
				stepIndex = null
				throw evaluateError
			}
			stepIndex = target
		},
		applyWithoutAdvance() {
			log.push({ fn: 'applyWithoutAdvance' })
			// runtime 側は session 未開始 / 未評価だと throw する契約なので、 stub でも同じ形にする
			if (stepIndex === null) throw new Error('applyWithoutAdvance: not evaluated yet')
		},
		endAnimation() {
			log.push({ fn: 'endAnimation' })
			stepIndex = null
			if (endAnimationError) throw endAnimationError
		},
		get currentStepIndex() {
			return stepIndex
		},
		get isEvaluating() {
			return evaluating
		},
		suspendTick() {
			log.push({ fn: 'suspendTick' })
		},
		resumeTick() {
			log.push({ fn: 'resumeTick' })
			if (resumeTickError) throw resumeTickError
		},
		invalidatePreview() {
			log.push({ fn: 'invalidatePreview' })
			if (invalidatePreviewError) throw invalidatePreviewError
		},
		makeExportContext(animation, excludedNodeUuids, timing) {
			const context = { animation, excludedNodeUuids, timing }
			log.push({ fn: 'makeExportContext', animation, excludedNodeUuids, timing, context })
			return context
		},
		isEnabled() {
			log.push({ fn: 'isEnabled' })
			return pendingEnabled.length > 0 ? pendingEnabled.shift() : enabled
		},
	}
	return {
		host,
		log,
		setEvaluating: (value) => { evaluating = value },
		getBasePoseWrapper: () => lastBasePoseWrapper,
	}
}

// AJ v2 が context に載せる周期情報。 driver は解釈せず makeExportContext へ素通しする。
const DEFAULT_TIMING = {
	animationLengthSeconds: 1,
	renderSampleCount: 21,
	loopMode: 'once',
	loopDelayFrames: 0,
}

// AJ の RenderAnimationContext 相当。 driver が読むのは animation / excludedNodeUuids /
// evaluateBasePose と周期情報 4 つだけ (= rig 等は載せても無視される)。
function makeAnimationContext(name, excludedNodeUuids = new Set(), timing = DEFAULT_TIMING) {
	const basePoseTimes = []
	return {
		animation: { name },
		rig: { name },
		excludedNodeUuids,
		...timing,
		evaluateBasePose(timeSeconds) {
			basePoseTimes.push(timeSeconds)
		},
		basePoseTimes,
	}
}

// AJ の RenderHookContext 相当。 side = true で pre-post 判定の side sample
// (= timeSeconds だけ +0.001 ズレ、 frameIndex は変わらない) を表す。
function poseContext(animationContext, frameIndex, { side = false } = {}) {
	const frameTimeSeconds = frameIndex * EXPORT_FRAME_SECONDS
	return {
		...animationContext,
		frameIndex,
		frameTimeSeconds,
		timeSeconds: side ? frameTimeSeconds + SIDE_SAMPLE_OFFSET : frameTimeSeconds,
	}
}

// AJ が 1 frame で実際に流す onPose 列 (= animationRenderer.ts:392-440 から抽出した正本)。
//   1. updatePreview 1 回目
//   2. updatePreview 2 回目 (= IK を成立させるための二度呼び)
//   3. getFrame の pre-post side sample (= timeSeconds + 0.001)
//   4. side sample の巻き戻し
//   5. null_object ごとの再評価
// 3-5 は bone / node ごとのループ内なので、 回数は blueprint 構成で変わる
// (= 回数可変版は emitFrameWithExtra)。
function emitMeasuredFrame(driver, animationContext, frameIndex) {
	driver.onPose(poseContext(animationContext, frameIndex))
	driver.onPose(poseContext(animationContext, frameIndex))
	driver.onPose(poseContext(animationContext, frameIndex, { side: true }))
	driver.onPose(poseContext(animationContext, frameIndex))
	driver.onPose(poseContext(animationContext, frameIndex))
}

// 1 frame あたりの追加呼び出しを extra 回にした列。 追加分は side sample と通常を交互に
// 混ぜる (= pre-post の bone 数 / null_object 数で実際に変動する部分の再現)。
function emitFrameWithExtra(driver, animationContext, frameIndex, extra) {
	driver.onPose(poseContext(animationContext, frameIndex))
	for (let i = 0; i < extra; i++) {
		driver.onPose(poseContext(animationContext, frameIndex, { side: i % 2 === 0 }))
	}
}

// log を読みやすい trace へ畳む (= evaluateStepIndex は target 付き)。
const trace = (log) => log.map((entry) => {
	if (entry.fn === 'evaluateStepIndex') return `eval:${entry.target}`
	if (entry.fn === 'applyWithoutAdvance') return 'reapply'
	return entry.fn
})
// pose 判定だけを抜き出した trace (= lifecycle の op を除いたもの)。
const poseTrace = (log) => trace(log).filter((name) => name === 'reapply' || name.startsWith('eval:'))
// evaluateStepIndex に渡った step 番号の列。
const advanceTargets = (log) => log.filter((e) => e.fn === 'evaluateStepIndex').map((e) => e.target)
const countOf = (log, fn) => log.filter((e) => e.fn === fn).length

// fn 実行中の console.warn を捕まえて引数列を返す (= 警告の回数を数えるため)。
// 差し替えた console.warn は finally で必ず戻す。
function captureWarnings(fn) {
	const original = console.warn
	const warnings = []
	console.warn = (...args) => { warnings.push(args) }
	try {
		fn()
	} finally {
		console.warn = original
	}
	return warnings
}

// rendering + animation session を張った driver を返す共通の下ごしらえ。
function startSession(options = {}, animationContext = makeAnimationContext('anim')) {
	const { host, log, setEvaluating, getBasePoseWrapper } = makeHost(options)
	const driver = createExportDriver(host)
	driver.onBeginRendering()
	driver.onBeginAnimation(animationContext)
	return { driver, host, log, setEvaluating, getBasePoseWrapper, animationContext }
}

// --- 1. 標準列 : frame ごとに advance 1 回、 残りは reapply ---

test('ExportDriver: AJ の実測 1 frame 5 回列で advance は frame ごとに 1 回だけ', () => {
	const { driver, log, animationContext } = startSession()
	log.length = 0
	for (let frameIndex = 0; frameIndex < 3; frameIndex++) {
		emitMeasuredFrame(driver, animationContext, frameIndex)
	}
	assert.deepEqual(poseTrace(log), [
		'eval:0', 'reapply', 'reapply', 'reapply', 'reapply',
		'eval:3', 'reapply', 'reapply', 'reapply', 'reapply',
		'eval:6', 'reapply', 'reapply', 'reapply', 'reapply',
	])
})

// --- 2. 回数非依存 (= 判定表の肝) ---

test('ExportDriver: 1 frame あたりの追加呼び出しが 0 / 1 / 7 でも advance 回数 = frame 数', () => {
	// AJ の onPose 回数は pre-post の bone 数 / null_object 数で変わるため、
	// driver は回数を数えず frameIndex の変化だけを見る契約。
	for (const extra of [0, 1, 7]) {
		const { driver, log, animationContext } = startSession()
		log.length = 0
		const frameCount = 4
		for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
			emitFrameWithExtra(driver, animationContext, frameIndex, extra)
		}
		assert.deepEqual(advanceTargets(log), [0, 3, 6, 9], `extra=${extra}`)
		assert.equal(countOf(log, 'evaluateStepIndex'), frameCount, `extra=${extra}`)
		assert.equal(countOf(log, 'applyWithoutAdvance'), frameCount * extra, `extra=${extra}`)
	}
})

// --- 3. step 番号の写像 ---

test('ExportDriver: evaluateStepIndex に渡るのは frameIndex * 3', () => {
	// export frame (= 20 fps) と物理 sub-step (= 60 Hz) の整数比。 秒を経由しないので
	// 累積誤差が原理的に発生しない。
	const { driver, log, animationContext } = startSession()
	log.length = 0
	const frames = [0, 1, 2, 5, 20, 1234]
	for (const frameIndex of frames) {
		emitMeasuredFrame(driver, animationContext, frameIndex)
	}
	assert.deepEqual(advanceTargets(log), frames.map((k) => k * 3))
})

// --- 4. side sample (roadmap S-4) ---

test('ExportDriver: pre-post の side sample (= +0.001) では advance せず reapply (roadmap S-4)', () => {
	// 「side sample では state を進めず、 同じ Δ を post 側 base pose へ合成する」 の
	// driver 側の担保。 時刻の正本は frameIndex なので、 timeSeconds が +0.001 ズレても
	// 同じ frame として扱い、 物理を進めてはいけない。
	const { driver, log, animationContext } = startSession()
	log.length = 0
	driver.onPose(poseContext(animationContext, 4))
	driver.onPose(poseContext(animationContext, 4, { side: true }))
	driver.onPose(poseContext(animationContext, 4))
	assert.deepEqual(poseTrace(log), ['eval:12', 'reapply', 'reapply'])
	// side sample の timeSeconds が実際にズレていること自体も固定しておく (= 前提の自己検査)
	assert.equal(poseContext(animationContext, 4, { side: true }).timeSeconds, 0.2 + SIDE_SAMPLE_OFFSET)
})

// --- 5. 初回 (currentStepIndex === null) ---

test('ExportDriver: frame 0 の初回は currentStepIndex null から evaluate へ流れる', () => {
	// target = 0 なので「null と一致しない」 判定が効かないと reapply に落ちてしまう。
	const { driver, host, log, animationContext } = startSession()
	assert.equal(host.currentStepIndex, null)
	log.length = 0
	driver.onPose(poseContext(animationContext, 0))
	assert.deepEqual(poseTrace(log), ['eval:0'])
	assert.equal(host.currentStepIndex, 0)
})

// --- 6. 評価失敗後の復帰 ---

test('ExportDriver: 評価が例外で落ちた後は同じ frameIndex でも再度 evaluate へ流れる', () => {
	// runtime は例外時に step cache を捨てて currentStepIndex を null に戻す。 driver は
	// それを見て「不一致 = evaluate」 に流し、 runtime 側の 0 replay を起動させる。
	const evaluateError = new Error('evaluate failed')
	const failing = makeHost({ evaluateError })
	const driver = createExportDriver(failing.host)
	const animationContext = makeAnimationContext('anim')
	driver.onBeginRendering()
	driver.onBeginAnimation(animationContext)
	failing.log.length = 0

	// 例外は握り潰さず AJ へ伝播させる (= AJ が RenderHookError に包んで export エラーにする)
	assert.throws(() => driver.onPose(poseContext(animationContext, 2)), evaluateError)
	assert.equal(failing.host.currentStepIndex, null)
	assert.throws(() => driver.onPose(poseContext(animationContext, 2)), evaluateError)
	assert.deepEqual(poseTrace(failing.log), ['eval:6', 'eval:6'])
})

// --- 7. 複数 animation ---

test('ExportDriver: animation を跨ぐと frame 0 から張り直る', () => {
	const { host, log } = makeHost()
	const driver = createExportDriver(host)
	const animA = makeAnimationContext('A')
	const animB = makeAnimationContext('B')
	driver.onBeginRendering()
	log.length = 0
	for (const animationContext of [animA, animB]) {
		driver.onBeginAnimation(animationContext)
		for (let frameIndex = 0; frameIndex < 2; frameIndex++) {
			emitMeasuredFrame(driver, animationContext, frameIndex)
		}
		driver.onEndAnimation()
	}
	driver.onEndRendering()
	assert.deepEqual(trace(log), [
		'makeExportContext', 'beginAnimation',
		'eval:0', 'reapply', 'reapply', 'reapply', 'reapply',
		'eval:3', 'reapply', 'reapply', 'reapply', 'reapply',
		'endAnimation',
		'makeExportContext', 'beginAnimation',
		'eval:0', 'reapply', 'reapply', 'reapply', 'reapply',
		'eval:3', 'reapply', 'reapply', 'reapply', 'reapply',
		'endAnimation',
		// onEndRendering は session の取りこぼしを潰すため endAnimation を無条件で呼ぶ
		'endAnimation', 'resumeTick', 'invalidatePreview',
	])
	// animation ごとに別の context が作られる (= 前 animation の context を使い回さない)
	const contexts = log.filter((e) => e.fn === 'makeExportContext').map((e) => e.animation)
	assert.deepEqual(contexts, [animA.animation, animB.animation])
})

// --- 8-12. 契約違反の呼ばれ方 ---

test('ExportDriver: onBeginRendering 無しの onPose は no-op', () => {
	const { host, log } = makeHost()
	const driver = createExportDriver(host)
	const animationContext = makeAnimationContext('anim')
	driver.onPose(poseContext(animationContext, 0))
	driver.onPose(poseContext(animationContext, 1))
	assert.deepEqual(trace(log), [])
	assert.equal(driver.isRenderingActive, false)
})

test('ExportDriver: onBeginAnimation が throw した後の onPose は no-op', () => {
	const beginAnimationError = new Error('resolveConfigs failed')
	const { host, log } = makeHost({ beginAnimationError })
	const driver = createExportDriver(host)
	const animationContext = makeAnimationContext('anim')
	driver.onBeginRendering()
	assert.throws(() => driver.onBeginAnimation(animationContext), beginAnimationError)
	assert.equal(driver.isAnimationActive, false)
	log.length = 0
	emitMeasuredFrame(driver, animationContext, 0)
	assert.deepEqual(trace(log), [])
})

test('ExportDriver: onEndRendering の二重呼び出しは安全 (= 2 回目は no-op)', () => {
	const { driver, log } = startSession()
	log.length = 0
	driver.onEndRendering()
	assert.deepEqual(trace(log), ['endAnimation', 'resumeTick', 'invalidatePreview'])
	log.length = 0
	driver.onEndRendering()
	driver.onEndRendering()
	assert.deepEqual(trace(log), [])
	assert.equal(driver.isRenderingActive, false)
})

test('ExportDriver: isEnabled() が false なら全 hook が no-op', () => {
	// tick を止めない = preview 側の主導権をそのまま残す (= 片側だけ実行される状態を作らない)
	const { host, log } = makeHost({ enabled: false })
	const driver = createExportDriver(host)
	const animationContext = makeAnimationContext('anim')
	driver.onBeginRendering()
	driver.onBeginAnimation(animationContext)
	emitMeasuredFrame(driver, animationContext, 0)
	driver.onEndAnimation()
	driver.onEndRendering()
	assert.deepEqual(trace(log), ['isEnabled'])
	assert.equal(driver.isRenderingActive, false)
	assert.equal(driver.isAnimationActive, false)
})

test('ExportDriver: host.isEvaluating が true の間の onPose は no-op (= 再入防御)', () => {
	const { driver, log, setEvaluating, animationContext } = startSession()
	log.length = 0
	setEvaluating(true)
	emitMeasuredFrame(driver, animationContext, 0)
	assert.deepEqual(trace(log), [])
	// 評価が抜けたら通常どおり advance へ戻る
	setEvaluating(false)
	driver.onPose(poseContext(animationContext, 0))
	assert.deepEqual(poseTrace(log), ['eval:0'])
})

// --- 13-14. rendering session の後始末 ---

test('ExportDriver: rendering 全体で suspend / resume 1 回ずつ、 invalidatePreview は begin と end で 1 回ずつ', () => {
	const { host, log } = makeHost()
	const driver = createExportDriver(host)
	const animationContext = makeAnimationContext('anim')
	driver.onBeginRendering()
	// preview session を畳んでから tick を止める順序 (= 逆順だと stale な state から resume する)
	assert.deepEqual(trace(log), ['isEnabled', 'invalidatePreview', 'suspendTick'])
	driver.onBeginAnimation(animationContext)
	emitMeasuredFrame(driver, animationContext, 0)
	driver.onEndAnimation()
	driver.onEndRendering()
	assert.equal(countOf(log, 'suspendTick'), 1)
	assert.equal(countOf(log, 'resumeTick'), 1)
	assert.equal(countOf(log, 'invalidatePreview'), 2)
	// 後始末は「runtime session 破棄 → tick 再開 → preview session 畳み」 の順
	assert.deepEqual(trace(log).slice(-3), ['endAnimation', 'resumeTick', 'invalidatePreview'])
	assert.equal(countOf(log, 'isEnabled'), 1)
})

test('ExportDriver: onEndRendering の cleanup は 1 つ目が throw しても残りを実行し、 最初の例外を伝播する', () => {
	// export 中に tick を止めたまま復帰しない状態を作らないための契約。
	const endAnimationError = new Error('endAnimation failed')
	const { host, log } = makeHost({ endAnimationError })
	const driver = createExportDriver(host)
	driver.onBeginRendering()
	log.length = 0
	assert.throws(() => driver.onEndRendering(), endAnimationError)
	assert.deepEqual(trace(log), ['endAnimation', 'resumeTick', 'invalidatePreview'])
	assert.equal(driver.isRenderingActive, false)
})

// --- 15-16. context の受け渡し ---

test('ExportDriver: onBeginAnimation の excludedNodeUuids が makeExportContext へそのまま渡る', () => {
	const excluded = new Set(['uuid-a', 'uuid-b'])
	const animationContext = makeAnimationContext('anim', excluded)
	const { log } = startSession({}, animationContext)
	const made = log.find((e) => e.fn === 'makeExportContext')
	// 同一参照で渡す (= 複製しない。 host 側が resolveConfigs で has() するだけ)
	assert.equal(made.excludedNodeUuids, excluded)
	assert.equal(made.animation, animationContext.animation)
	// host が返した context がそのまま beginAnimation に渡る
	const begun = log.find((e) => e.fn === 'beginAnimation')
	assert.equal(begun.context, made.context)
})

test('ExportDriver: AJ v2 の周期情報 4 つが makeExportContext へ素通しで渡る', () => {
	// driver 側は「N - 2 か N - 1 か」 の解釈をしない (= 周期の解釈は host / restWindow.ts の責務)。
	// 値を落とさず、 加工もせずに渡すことだけを固定する。
	const timing = {
		animationLengthSeconds: 2.5,
		renderSampleCount: 51,
		loopMode: 'loop',
		loopDelayFrames: 7,
	}
	const animationContext = makeAnimationContext('anim', new Set(), timing)
	const { log } = startSession({}, animationContext)
	const made = log.find((e) => e.fn === 'makeExportContext')
	assert.deepEqual(made.timing, timing)
})

test('ExportDriver: 周期情報は animation ごとに読み直される', () => {
	// session 中に animation が切り替わったら、 その animation の周期情報が渡ること
	// (= 最初の animation の値を握り続けない)。
	const { host, log } = makeHost()
	const driver = createExportDriver(host)
	driver.onBeginRendering()
	const a = makeAnimationContext('a', new Set(), {
		animationLengthSeconds: 1, renderSampleCount: 21, loopMode: 'once', loopDelayFrames: 0,
	})
	const b = makeAnimationContext('b', new Set(), {
		animationLengthSeconds: 3, renderSampleCount: 61, loopMode: 'loop', loopDelayFrames: 5,
	})
	driver.onBeginAnimation(a)
	driver.onEndAnimation()
	driver.onBeginAnimation(b)
	const timings = log.filter((e) => e.fn === 'makeExportContext').map((e) => e.timing)
	assert.deepEqual(timings, [
		{ animationLengthSeconds: 1, renderSampleCount: 21, loopMode: 'once', loopDelayFrames: 0 },
		{ animationLengthSeconds: 3, renderSampleCount: 61, loopMode: 'loop', loopDelayFrames: 5 },
	])
})

test('ExportDriver: beginAnimation に渡る wrapper は AJ の evaluateBasePose(timeSeconds) を呼ぶ', () => {
	// runtime は (timeSeconds, context) => void を要求するが、 AJ 側は (timeSeconds) => void。
	// driver の wrapper が第 2 引数を落として橋渡しすることを固定する。
	const animationContext = makeAnimationContext('anim')
	const { log, getBasePoseWrapper } = startSession({}, animationContext)
	const wrapper = getBasePoseWrapper()
	const exportContext = log.find((e) => e.fn === 'makeExportContext').context
	wrapper(0, exportContext)
	wrapper(0.05, exportContext)
	assert.deepEqual(animationContext.basePoseTimes, [0, 0.05])
})

// --- 二重 onBeginRendering (= 契約違反) ---

test('ExportDriver: 二重 onBeginRendering で 2 回目が isEnabled() false でも suspend は解除される', () => {
	// **onBeginRendering は判定より先に前 session を畳む** ことの担保。 flag を落とすだけの
	// 実装だと「1 回目の suspendTick が解除されないまま、 以降の onEndRendering は
	// 非 active で no-op」 になり、 呼び出し側の tick が永久に止まったままになる。
	const { host, log } = makeHost({ enabledSequence: [true, false] })
	const driver = createExportDriver(host)
	driver.onBeginRendering()
	assert.deepEqual(trace(log), ['isEnabled', 'invalidatePreview', 'suspendTick'])
	assert.equal(driver.isRenderingActive, true)

	log.length = 0
	driver.onBeginRendering()
	// 後始末が先、 isEnabled() は その後 (= false なので新 session は張らない)
	assert.deepEqual(trace(log), ['endAnimation', 'resumeTick', 'invalidatePreview', 'isEnabled'])
	assert.equal(countOf(log, 'resumeTick'), 1)
	assert.equal(driver.isRenderingActive, false)
	assert.equal(driver.isAnimationActive, false)

	// 以降の hook は no-op のまま (= 片側だけ実行される状態にならない)
	log.length = 0
	driver.onEndRendering()
	assert.deepEqual(trace(log), [])
})

test('ExportDriver: 二重 onBeginRendering で 2 回目も有効なら前 session を畳んでから張り直す', () => {
	const { host, log } = makeHost()
	const driver = createExportDriver(host)
	const animationContext = makeAnimationContext('anim')
	driver.onBeginRendering()
	driver.onBeginAnimation(animationContext)
	emitMeasuredFrame(driver, animationContext, 0)

	log.length = 0
	driver.onBeginRendering()
	// 前 session の後始末 (= runtime session 破棄 → tick 再開 → preview 畳み) を通してから、
	// 新 session を preview 畳み → tick 停止の順で張る
	assert.deepEqual(trace(log), [
		'endAnimation', 'resumeTick', 'invalidatePreview',
		'isEnabled', 'invalidatePreview', 'suspendTick',
	])
	assert.equal(driver.isRenderingActive, true)
	// animation session は 1 回目のものごと畳まれている (= onBeginAnimation 待ちに戻る)
	assert.equal(driver.isAnimationActive, false)
	log.length = 0
	emitMeasuredFrame(driver, animationContext, 1)
	assert.deepEqual(trace(log), [])
})

test('ExportDriver: session が無い状態の onBeginRendering は余計な cleanup を走らせない', () => {
	// 前 session を畳む処理は冪等 (= 非 active なら no-op)。 通常の 1 回目や、
	// isEnabled() false が続く場合に endAnimation / resumeTick を無駄に叩かないことを固定する。
	const { host, log } = makeHost()
	const driver = createExportDriver(host)
	driver.onBeginRendering()
	assert.deepEqual(trace(log), ['isEnabled', 'invalidatePreview', 'suspendTick'])

	const disabled = makeHost({ enabled: false })
	const disabledDriver = createExportDriver(disabled.host)
	disabledDriver.onBeginRendering()
	disabledDriver.onBeginRendering()
	assert.deepEqual(trace(disabled.log), ['isEnabled', 'isEnabled'])
})

// --- animation identity の検証 ---

test('ExportDriver: onBeginAnimation と別 animation の onPose は no-op、 同じ animation は通常どおり', () => {
	// runtime が持っているのは onBeginAnimation で受けた animation の evaluator と物理 state。
	// 別 animation の frame をそのまま評価すると、 旧 animation の state で別 animation の
	// scene を上書きする。 契約違反は throw せず静かに見送る。
	const animA = makeAnimationContext('A')
	const animB = makeAnimationContext('B')
	const { driver, log } = startSession({}, animA)
	log.length = 0
	captureWarnings(() => {
		driver.onPose(poseContext(animB, 0))
		emitMeasuredFrame(driver, animB, 1)
	})
	assert.deepEqual(trace(log), [])

	// session の animation なら advance / reapply が従来どおり走る (= 正常系を壊していない)
	emitMeasuredFrame(driver, animA, 0)
	assert.deepEqual(poseTrace(log), ['eval:0', 'reapply', 'reapply', 'reapply', 'reapply'])
})

test('ExportDriver: animation 不一致の警告は session ごとに 1 回だけ', () => {
	// 不一致は frame ごとに届き得るので、 毎回警告すると log が溢れる。
	const animA = makeAnimationContext('A')
	const animB = makeAnimationContext('B')
	const { driver, log } = startSession({}, animA)
	log.length = 0
	const warnings = captureWarnings(() => {
		for (let frameIndex = 0; frameIndex < 3; frameIndex++) {
			emitMeasuredFrame(driver, animB, frameIndex)
		}
	})
	// 15 回の onPose すべてが不一致でも警告は 1 回
	assert.equal(warnings.length, 1)
	assert.deepEqual(trace(log), [])
})

test('ExportDriver: onEndAnimation → onBeginAnimation で新しい animation が正になる', () => {
	const animA = makeAnimationContext('A')
	const animB = makeAnimationContext('B')
	const { driver, log } = startSession({}, animA)
	const firstSessionWarnings = captureWarnings(() => driver.onPose(poseContext(animB, 0)))
	assert.equal(firstSessionWarnings.length, 1)

	driver.onEndAnimation()
	driver.onBeginAnimation(animB)
	log.length = 0
	// 正となる animation が入れ替わり、 前 session の animation が今度は no-op 側になる。
	// 警告は session ごとに arm し直されるので、 新 session でも 1 回は出る。
	const secondSessionWarnings = captureWarnings(() => emitMeasuredFrame(driver, animA, 0))
	assert.equal(secondSessionWarnings.length, 1)
	assert.deepEqual(trace(log), [])

	// 新しい animation は frame 0 から通常どおり評価される
	emitMeasuredFrame(driver, animB, 0)
	assert.deepEqual(poseTrace(log), ['eval:0', 'reapply', 'reapply', 'reapply', 'reapply'])
})
