import test from 'node:test'
import assert from 'node:assert/strict'

const {
	SUBSTEPS_PER_EXPORT_FRAME,
	KNOWN_LOOP_MODES,
	checkRestWindowTiming,
	checkPreviewRestWindowTiming,
	createRenderSampleCountCache,
	deriveRenderSampleCount,
	nextRenderSampleTime,
	deriveDisplayedFinalFrame,
	resolveFadeFrames,
	computeRestWindowWeight,
	classifyRestWindowWeight,
	restWindowFingerprint,
} = await import('../dist-test/restWindow.mjs')
const runtime = await import('../dist-test/springRuntime.mjs')

// timing の生成ヘルパ (= 既定は loop でない / 待機なし)
const timing = (renderSampleCount, loopMode = 'once', loopDelayFrames = 0) => ({
	renderSampleCount,
	loopMode,
	loopDelayFrames,
})

// --- SUBSTEPS_PER_EXPORT_FRAME ---

test('SUBSTEPS_PER_EXPORT_FRAME: springRuntime 側の定義と一致する', () => {
	// 循環 import を避けるため両 module に別々の定義を置いている。 片方だけ変えると
	// step 格子と frame 格子の対応が静かにズレるため、 一致を test で固定する
	assert.equal(SUBSTEPS_PER_EXPORT_FRAME, runtime.SUBSTEPS_PER_EXPORT_FRAME)
	assert.equal(SUBSTEPS_PER_EXPORT_FRAME, 3)
})

// --- deriveRenderSampleCount ---

// AJ の render loop (= animationRenderer.ts) をそのまま再現した参照実装。
// test 側でも閉じた式に置き換えず、 同じ loop で期待値を作る。
const roundToNth = (n, x) => Math.round(n * x) / x
const referenceSampleCount = (lengthSeconds) => {
	let count = 0
	for (let time = 0; time <= lengthSeconds; time = roundToNth(time + 0.05, 20)) count++
	return count
}

test('deriveRenderSampleCount: 格子ちょうどの length は AJ の loop と同じ回数', () => {
	// 0.05 の整数倍 = frame 格子ちょうど。 length / 0.05 + 1 sample になる
	assert.equal(deriveRenderSampleCount(0.05), 2)
	assert.equal(deriveRenderSampleCount(0.1), 3)
	assert.equal(deriveRenderSampleCount(1), 21)
	assert.equal(deriveRenderSampleCount(2), 41)
	for (const length of [0.05, 0.1, 0.5, 1, 2, 3.35, 10]) {
		assert.equal(deriveRenderSampleCount(length), referenceSampleCount(length), `length=${length}`)
	}
})

test('deriveRenderSampleCount: 格子際の length でも AJ の loop と一致する', () => {
	// 閉じた式 (= Math.floor(length / 0.05) + 1) だと丸めの入り方が違って off-by-one が出る帯
	for (const length of [
		0.049999999999999996, 0.05000000000000001, 0.09999999999999999, 0.15000000000000002,
		0.7000000000000001, 0.9499999999999998, 1.0500000000000003, 2.9999999999999996,
	]) {
		assert.equal(deriveRenderSampleCount(length), referenceSampleCount(length), `length=${length}`)
	}
})

test('deriveRenderSampleCount: length 0 は 1 sample (= time 0 だけ)', () => {
	assert.equal(deriveRenderSampleCount(0), 1)
})

test('deriveRenderSampleCount: 極小の length も 1 sample', () => {
	for (const length of [1e-9, 0.001, 0.04999]) {
		assert.equal(deriveRenderSampleCount(length), 1, `length=${length}`)
	}
})

test('deriveRenderSampleCount: NaN / -Infinity / 負は 0 件で通す', () => {
	// 旧実装の `time <= NaN` が偽になる挙動と一致 (= AJ 側と同じ扱い)。
	// 「数え切れない」 (= null) とは区別する : 0 件は preview 側で契約違反として拾われる
	for (const length of [Number.NaN, Number.NEGATIVE_INFINITY, -1, -0.01, undefined]) {
		assert.equal(deriveRenderSampleCount(length), 0, `length=${String(length)}`)
	}
})

test('deriveRenderSampleCount: +Infinity は数え切れないので null', () => {
	// `time <= +Infinity` が永久に真になる = 終わらない条件
	assert.equal(deriveRenderSampleCount(Number.POSITIVE_INFINITY), null)
})

test('deriveRenderSampleCount: 件数の上限が無い (= 打ち切って preview と export を食い違わせない)', () => {
	// 上限 100000 件で打ち切っていた頃は length 5000 で N = 100000 になり、 AJ 側の
	// N = 100001 と 1 frame ずれていた。 しかも打ち切った値は妥当な整数として契約検査を
	// 通るため警告も出ない (= preview と export が黙って食い違う)。
	assert.equal(deriveRenderSampleCount(5000), 100001)
	assert.equal(deriveRenderSampleCount(5000), referenceSampleCount(5000))
})

test('nextRenderSampleTime: 通常の時刻では 0.05 進み、 精度限界では null', () => {
	// 「時刻が進まない」 判定そのものの固定。 deriveRenderSampleCount は time 0 から
	// 0.05 刻みで数えるため、 この帯に到達させるには非現実的な反復が要る (= 直接固定する)
	assert.equal(nextRenderSampleTime(0), 0.05)
	assert.equal(nextRenderSampleTime(0.05), 0.1)
	assert.equal(nextRenderSampleTime(1e10), 10000000000.05)
	// double の精度限界 : time + 0.05 が丸めで消える
	for (const time of [1e15, 1e16, 1e17, 2 ** 49, Number.MAX_SAFE_INTEGER]) {
		assert.equal(nextRenderSampleTime(time), null, `time=${time}`)
	}
})

// --- checkRestWindowTiming (= export 経路の契約判定) ---

test('checkRestWindowTiming: 正当な timing は null', () => {
	for (const loopMode of KNOWN_LOOP_MODES) {
		for (const renderSampleCount of [0, 1, 2, 3, 21, 1000]) {
			assert.equal(
				checkRestWindowTiming({ renderSampleCount, loopMode, loopDelayFrames: 0 }),
				null,
				`${loopMode} / N=${renderSampleCount}`,
			)
		}
	}
})

test('checkRestWindowTiming: 正当な N = 0 / 1 / 2 は契約違反にしない (= w ≡ 0 の縮退のまま)', () => {
	// 実在する極小 animation。 契約違反 (= 下の test) と混同すると、 正しい出力まで止まる
	for (const renderSampleCount of [0, 1, 2]) {
		assert.equal(checkRestWindowTiming(timing(renderSampleCount, 'once', 0)), null)
		assert.equal(checkRestWindowTiming(timing(renderSampleCount, 'loop', 0)), null)
	}
	// 中間 sample を持たない組み合わせ (= E = 0) は従来どおり weight ≡ 0 の縮退へ落ちる
	for (const t of [timing(0, 'once', 0), timing(1, 'once', 0), timing(2, 'loop', 0)]) {
		const finalFrame = deriveDisplayedFinalFrame(t)
		assert.equal(finalFrame, 0)
		for (const step of [0, 1, 10]) {
			assert.strictEqual(computeRestWindowWeight(step, finalFrame, 4), 0)
		}
	}
	// N = 2 の once は 1 frame ぶんの区間を持つ (= 潰さない)
	assert.equal(deriveDisplayedFinalFrame(timing(2, 'once', 0)), 1)
})

test('checkRestWindowTiming: 非有限 / 負 / 非整数の renderSampleCount は契約違反', () => {
	for (const renderSampleCount of [
		Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5, 2.5, '21', null, undefined,
	]) {
		const reason = checkRestWindowTiming({ renderSampleCount, loopMode: 'once', loopDelayFrames: 0 })
		assert.equal(typeof reason, 'string', `N=${String(renderSampleCount)}`)
		assert.match(reason, /renderSampleCount/)
	}
})

test('checkRestWindowTiming: 未知の loopMode は契約違反', () => {
	// once へ倒すと、 実際が loop だった場合に終点が 1 frame 遅れて Δ が残る
	for (const loopMode of ['ping_pong', 'LOOP', '', 'Once', null, undefined, 0]) {
		const reason = checkRestWindowTiming({ renderSampleCount: 21, loopMode, loopDelayFrames: 0 })
		assert.equal(typeof reason, 'string', `loopMode=${String(loopMode)}`)
		assert.match(reason, /loopMode/)
	}
})

// 文字列化できない外部値の一覧 (= JSON.stringify / String() のどちらかが throw する形)。
// エラー文 / fingerprint の生成でこれらを踏むと、 「窓を省略して w ≡ 1 に倒す」 はずの
// preview が tick ごと失敗する。
function unstringifiableValues() {
	const circular = { name: 'loop' }
	circular.self = circular
	const nullProto = Object.create(null)
	nullProto.mode = 'loop'
	const throwingToString = { toString() { throw new Error('nope') } }
	const throwingPrimitive = { [Symbol.toPrimitive]() { throw new Error('nope') } }
	return [1n, circular, nullProto, throwingToString, throwingPrimitive, Symbol('loop'), () => {}]
}

test('checkRestWindowTiming: 文字列化できない loopMode でも throw せず契約違反として返す', () => {
	for (const loopMode of unstringifiableValues()) {
		let reason
		assert.doesNotThrow(() => {
			reason = checkRestWindowTiming({ renderSampleCount: 21, loopMode, loopDelayFrames: 0 })
		}, `loopMode=${typeof loopMode}`)
		assert.equal(typeof reason, 'string')
		assert.match(reason, /loopMode/)
	}
})

test('checkRestWindowTiming: 文字列化できない renderSampleCount でも throw しない', () => {
	for (const renderSampleCount of unstringifiableValues()) {
		let reason
		assert.doesNotThrow(() => {
			reason = checkRestWindowTiming({ renderSampleCount, loopMode: 'once', loopDelayFrames: 0 })
		}, `N=${typeof renderSampleCount}`)
		assert.equal(typeof reason, 'string')
		assert.match(reason, /renderSampleCount/)
	}
})

test('checkPreviewRestWindowTiming: 文字列化できない値でも throw しない', () => {
	for (const loopMode of unstringifiableValues()) {
		assert.doesNotThrow(() => checkPreviewRestWindowTiming({
			renderSampleCount: 21, loopMode, loopDelayFrames: 0,
		}))
	}
})

test('restWindowFingerprint: 文字列化できない値でも throw しない', () => {
	// fingerprint は毎 tick 計算されるため、 ここで throw すると preview が止まる
	for (const loopMode of unstringifiableValues()) {
		let fp
		assert.doesNotThrow(() => {
			fp = restWindowFingerprint({ renderSampleCount: 21, loopMode, loopDelayFrames: 0 }, 4)
		}, `loopMode=${typeof loopMode}`)
		assert.equal(typeof fp, 'string')
	}
	// BigInt の requestedFrames / renderSampleCount も同様
	assert.doesNotThrow(() => restWindowFingerprint({ renderSampleCount: 1n, loopMode: 'once', loopDelayFrames: 0 }, 1n))
})

test('checkRestWindowTiming: loopDelayFrames は検査しない (= 「> 0 か否か」 しか見ないため)', () => {
	for (const loopDelayFrames of [-3, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(
			checkRestWindowTiming({ renderSampleCount: 21, loopMode: 'loop', loopDelayFrames }),
			null,
			`delay=${loopDelayFrames}`,
		)
	}
})

// --- checkPreviewRestWindowTiming (= preview 経路の契約判定) ---

test('checkPreviewRestWindowTiming: N = 0 は契約違反 (= length 破損の徴候)', () => {
	// preview の N は length から数えた値で、 正当な length なら必ず 1 以上になる
	const reason = checkPreviewRestWindowTiming(timing(0, 'once', 0))
	assert.equal(typeof reason, 'string')
	assert.match(reason, /renderSampleCount/)
	// 対して export 側は N = 0 を正当な縮退として通す
	assert.equal(checkRestWindowTiming(timing(0, 'once', 0)), null)
})

test('checkPreviewRestWindowTiming: N >= 1 は正当 (= 極小 animation は通す)', () => {
	for (const renderSampleCount of [1, 2, 3, 21]) {
		assert.equal(checkPreviewRestWindowTiming(timing(renderSampleCount, 'once', 0)), null)
	}
})

test('checkPreviewRestWindowTiming: export 側の判定も引き継ぐ', () => {
	assert.match(checkPreviewRestWindowTiming(timing(Number.NaN, 'once', 0)), /renderSampleCount/)
	assert.match(checkPreviewRestWindowTiming(timing(21, 'ping_pong', 0)), /loopMode/)
})

test('checkPreviewRestWindowTiming: 壊れた length から数えた結果が必ず違反になる', () => {
	// deriveRenderSampleCount との組み合わせで、 preview 経路の入口から出口まで繋げて固定する。
	// 0 件になる length は契約違反、 数え切れない length は null (= 呼び出し側が窓ごと省略) の
	// 2 経路に分かれるが、 どちらも「窓を作らない」 結果に収束する
	for (const length of [Number.NaN, Number.NEGATIVE_INFINITY, -1, undefined]) {
		const count = deriveRenderSampleCount(length)
		assert.equal(count, 0, `length=${String(length)}`)
		assert.notEqual(checkPreviewRestWindowTiming(timing(count, 'once', 0)), null, `length=${String(length)}`)
	}
	assert.equal(deriveRenderSampleCount(Number.POSITIVE_INFINITY), null)
	// 数値でない length は AJ の loop と同じく比較で暗黙変換される (= 弾かない)。
	// 独自に型で弾くと、 同じ値から AJ 側は 41 件 / preview は 0 件、 と食い違ってしまう
	assert.equal(deriveRenderSampleCount('2'), 41)
	// 正当な length は必ず通る
	for (const length of [0, 0.001, 1, 2.5]) {
		const t = timing(deriveRenderSampleCount(length), 'once', 0)
		assert.equal(checkPreviewRestWindowTiming(t), null, `length=${length}`)
	}
})

// --- createRenderSampleCountCache ---

test('createRenderSampleCountCache: deriveRenderSampleCount と同じ値を返す', () => {
	const cache = createRenderSampleCountCache()
	const anim = { name: 'walk' }
	for (const length of [0, 0.05, 1, 2, 3.35]) {
		assert.equal(cache.get(anim, length), deriveRenderSampleCount(length), `length=${length}`)
	}
})

test('createRenderSampleCountCache: length が変われば再計算する', () => {
	// key に raw length を含めるため、 keyframe 編集で length が伸び縮みしても
	// 呼び出し側が invalidate 条件を持つ必要が無い
	const cache = createRenderSampleCountCache()
	const anim = { name: 'walk' }
	assert.equal(cache.get(anim, 1), 21)
	assert.equal(cache.get(anim, 2), 41)
	// 戻しても正しい値 (= 古い結果に固着しない)
	assert.equal(cache.get(anim, 1), 21)
	assert.equal(cache.get(anim, 0), 1)
})

test('createRenderSampleCountCache: animation の identity が変われば再計算する', () => {
	const cache = createRenderSampleCountCache()
	const a = { name: 'a' }
	const b = { name: 'b' }
	assert.equal(cache.get(a, 1), 21)
	assert.equal(cache.get(b, 2), 41)
	assert.equal(cache.get(a, 1), 21)
	// 同じ length でも別 instance で正しい値を返す
	assert.equal(cache.get(b, 1), 21)
})

test('createRenderSampleCountCache: clear 後も正しい値を返す', () => {
	const cache = createRenderSampleCountCache()
	const anim = { name: 'walk' }
	assert.equal(cache.get(anim, 1), 21)
	cache.clear()
	assert.equal(cache.get(anim, 1), 21)
	assert.equal(cache.get(anim, 2), 41)
})

test('createRenderSampleCountCache: 壊れた length も 0 として扱い、 変化に追従する', () => {
	const cache = createRenderSampleCountCache()
	const anim = { name: 'walk' }
	assert.equal(cache.get(anim, Number.NaN), 0)
	// NaN → NaN は memo hit (= Object.is 比較)、 値は変わらない
	assert.equal(cache.get(anim, Number.NaN), 0)
	// 正常値へ戻れば再計算される
	assert.equal(cache.get(anim, 1), 21)
})

test('createRenderSampleCountCache: 数え切れない length は null を memo する', () => {
	// null を毎 frame 数え直さない (= +Infinity は即返るが、 契約として固定しておく)
	const cache = createRenderSampleCountCache()
	const anim = { name: 'walk' }
	assert.equal(cache.get(anim, Number.POSITIVE_INFINITY), null)
	assert.equal(cache.get(anim, Number.POSITIVE_INFINITY), null)
	// length が変われば再計算される (= null に固着しない)
	assert.equal(cache.get(anim, 1), 21)
})

// --- deriveDisplayedFinalFrame ---

test('deriveDisplayedFinalFrame: loop かつ待機なしは N - 2 (= 末尾 frame は表示されない)', () => {
	// MC runtime は 0 delay の loop で frame >= duration - 2 の時点で先頭へ戻す
	assert.equal(deriveDisplayedFinalFrame(timing(20, 'loop', 0)), 18)
	assert.equal(deriveDisplayedFinalFrame(timing(20, 'loop', -3)), 18)
})

test('deriveDisplayedFinalFrame: loop かつ待機ありは N - 1', () => {
	assert.equal(deriveDisplayedFinalFrame(timing(20, 'loop', 1)), 19)
	assert.equal(deriveDisplayedFinalFrame(timing(20, 'loop', 5)), 19)
	// 非整数の待機でも「待機あり」 側
	assert.equal(deriveDisplayedFinalFrame(timing(20, 'loop', 0.5)), 19)
})

test('deriveDisplayedFinalFrame: once / hold / 想定外の loopMode は N - 1', () => {
	for (const mode of ['once', 'hold', 'ping_pong', '', 'LOOP']) {
		assert.equal(deriveDisplayedFinalFrame(timing(20, mode, 0)), 19, `mode=${mode}`)
		// loop 以外は待機の有無で結果が変わらない
		assert.equal(deriveDisplayedFinalFrame(timing(20, mode, 4)), 19, `mode=${mode} delay=4`)
	}
})

test('deriveDisplayedFinalFrame: loopDelayFrames が非有限なら待機なし側 (= N - 2) に倒す', () => {
	// 終点が 1 frame 早い分には減衰が早く終わるだけだが、 逆に遅いと表示されない
	// frame を終点にしてしまう
	for (const delay of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		assert.equal(deriveDisplayedFinalFrame(timing(20, 'loop', delay)), 18, `delay=${delay}`)
	}
})

test('deriveDisplayedFinalFrame: renderSampleCount が 0 / 1 / 2 でも 0 以上へ clamp する', () => {
	// loop かつ待機なし = N - 2
	assert.equal(deriveDisplayedFinalFrame(timing(0, 'loop', 0)), 0)
	assert.equal(deriveDisplayedFinalFrame(timing(1, 'loop', 0)), 0)
	assert.equal(deriveDisplayedFinalFrame(timing(2, 'loop', 0)), 0)
	assert.equal(deriveDisplayedFinalFrame(timing(3, 'loop', 0)), 1)
	// once = N - 1
	assert.equal(deriveDisplayedFinalFrame(timing(0, 'once', 0)), 0)
	assert.equal(deriveDisplayedFinalFrame(timing(1, 'once', 0)), 0)
	assert.equal(deriveDisplayedFinalFrame(timing(2, 'once', 0)), 1)
})

test('deriveDisplayedFinalFrame: 非有限 / 負 / 非整数の renderSampleCount でも throw せず 0 以上の整数', () => {
	const cases = [
		[Number.NaN, 0],
		[Number.POSITIVE_INFINITY, 0],
		[Number.NEGATIVE_INFINITY, 0],
		[-5, 0],
		[-0.5, 0],
		[20.7, 19],   // floor(20.7) = 20 -> once なので 19
		[20.999, 19],
	]
	for (const [raw, expected] of cases) {
		const result = deriveDisplayedFinalFrame(timing(raw, 'once', 0))
		assert.equal(result, expected, `renderSampleCount=${raw}`)
		assert.ok(Number.isInteger(result) && result >= 0, `renderSampleCount=${raw} -> ${result}`)
	}
})

// --- resolveFadeFrames ---

test('resolveFadeFrames: F < E はそのまま、 F = E / F > E は E へ圧縮する', () => {
	assert.equal(resolveFadeFrames(6, 18), 6)   // F < E
	assert.equal(resolveFadeFrames(18, 18), 18) // F = E
	assert.equal(resolveFadeFrames(40, 18), 18) // F > E
})

test('resolveFadeFrames: 負 / 非整数 / 非有限は 0 以上の整数へ丸める', () => {
	assert.equal(resolveFadeFrames(-4, 18), 0)
	assert.equal(resolveFadeFrames(-0.2, 18), 0)
	assert.equal(resolveFadeFrames(6.9, 18), 6)     // floor
	assert.equal(resolveFadeFrames(Number.NaN, 18), 0)
	assert.equal(resolveFadeFrames(Number.POSITIVE_INFINITY, 18), 0)
	assert.equal(resolveFadeFrames(Number.NEGATIVE_INFINITY, 18), 0)
	// displayedFinalFrame 側が壊れていても 0 以上の整数
	assert.equal(resolveFadeFrames(6, Number.NaN), 0)
	assert.equal(resolveFadeFrames(6, -3), 0)
	assert.equal(resolveFadeFrames(6, 4.8), 4)
})

// --- computeRestWindowWeight ---

test('computeRestWindowWeight: 減衰開始前は 1、 fadeEndStep 以後は exact 0', () => {
	// displayedFinalFrame = 18, fadeFrames = 6 -> fadeEndStep = 54, fadeStartStep = 36
	for (const step of [0, 1, 20, 35, 36]) {
		assert.strictEqual(computeRestWindowWeight(step, 18, 6), 1, `step=${step}`)
	}
	for (const step of [54, 55, 100, 1e6]) {
		// 「限りなく 0 に近い値」 ではなく exact 0 (= 呼び出し側が identity 分岐に使う)
		assert.strictEqual(computeRestWindowWeight(step, 18, 6), 0, `step=${step}`)
	}
	// 区間中央は smoothstep(0.5) = 0.5 の反転
	assert.strictEqual(computeRestWindowWeight(45, 18, 6), 0.5)
})

test('computeRestWindowWeight: 区間内で単調非増加、 全域で [0, 1]', () => {
	let prev = computeRestWindowWeight(0, 18, 6)
	for (let step = 1; step <= 60; step++) {
		const w = computeRestWindowWeight(step, 18, 6)
		assert.ok(w >= 0 && w <= 1, `step=${step} -> ${w}`)
		assert.ok(w <= prev, `step=${step}: ${w} > ${prev}`)
		prev = w
	}
})

test('computeRestWindowWeight: 壊れた入力でも戻り値は [0, 1] に収まる', () => {
	const finals = [0, 1, 2, 18, -5, 3.7, Number.NaN, Number.POSITIVE_INFINITY]
	const fades = [0, 1, 6, 18, 999, -4, 2.5, Number.NaN, Number.POSITIVE_INFINITY]
	for (const final of finals) {
		for (const fade of fades) {
			for (const step of [0, 1, 27, 54, 1000]) {
				const w = computeRestWindowWeight(step, final, fade)
				assert.ok(
					Number.isFinite(w) && w >= 0 && w <= 1,
					`step=${step} final=${final} fade=${fade} -> ${w}`,
				)
			}
		}
	}
})

test('computeRestWindowWeight: stepIndex = 0 の weight は必ず 1 (= animation 前半の振幅を削らない)', () => {
	// resolveFadeFrames を通した値
	for (const final of [1, 2, 18, 60]) {
		for (const requested of [0, 1, 6, 18, 999]) {
			const fade = resolveFadeFrames(requested, final)
			assert.strictEqual(computeRestWindowWeight(0, final, fade), 1, `final=${final} requested=${requested}`)
		}
	}
	// resolveFadeFrames を通し忘れて過大な値を直接渡した場合も 1 (= 内部 clamp の回帰)。
	// clamp が無いと fadeStartStep が負になり、 step 0 が減衰区間の内側と判定される
	for (const fade of [19, 40, 1000, Number.POSITIVE_INFINITY]) {
		assert.strictEqual(computeRestWindowWeight(0, 18, fade), 1, `fade=${fade}`)
	}
	// 過大な fadeFrames は displayedFinalFrame へ圧縮されるので、 E と等価な結果になる
	assert.equal(computeRestWindowWeight(27, 18, 1000), computeRestWindowWeight(27, 18, 18))
})

test('computeRestWindowWeight: displayedFinalFrame === 0 なら全 step が 0', () => {
	// 中間 sample を持たない極端に短い animation。 物理が見えなくなるのが正しい縮退動作
	for (const step of [0, 1, 3, 54, 1e6]) {
		for (const fade of [0, 6, 1000]) {
			assert.strictEqual(computeRestWindowWeight(step, 0, fade), 0, `step=${step} fade=${fade}`)
		}
	}
	// 壊れた displayedFinalFrame も 0 に正規化されるので同じ縮退動作
	for (const final of [-3, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.strictEqual(computeRestWindowWeight(10, final, 6), 0, `final=${final}`)
	}
})

test('computeRestWindowWeight: fadeFrames <= 0 は fadeEndStep 直前まで 1 の hard cut', () => {
	for (const fade of [0, -5, Number.NaN]) {
		for (const step of [0, 1, 30, 53]) {
			assert.strictEqual(computeRestWindowWeight(step, 18, fade), 1, `fade=${fade} step=${step}`)
		}
		// fadeEndStep 以後だけが 0
		assert.strictEqual(computeRestWindowWeight(54, 18, fade), 0, `fade=${fade}`)
		assert.strictEqual(computeRestWindowWeight(55, 18, fade), 0, `fade=${fade}`)
	}
})

test('computeRestWindowWeight: stepIndex が非有限なら 0', () => {
	// NaN をそのまま式へ流すと戻り値が NaN になり [0, 1] の契約が壊れる
	for (const step of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		assert.strictEqual(computeRestWindowWeight(step, 18, 6), 0, `step=${step}`)
	}
})

// --- classifyRestWindowWeight ---

test('classifyRestWindowWeight: weight 0 は identity (= Δ を一切載せない)', () => {
	// 0 の時に premultiply を通すと、 slerp で identity へ寄せた Δ の丸め誤差が
	// 純 keyframe pose との差として残る。 合成そのものを飛ばす分岐であることを固定する
	for (const weight of [0, -0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		assert.equal(classifyRestWindowWeight(weight), 'identity', `weight=${weight}`)
	}
})

test('classifyRestWindowWeight: weight 1 は full、 中間は blend', () => {
	assert.equal(classifyRestWindowWeight(1), 'full')
	assert.equal(classifyRestWindowWeight(1.5), 'full')
	for (const weight of [0.001, 0.25, 0.5, 0.999]) {
		assert.equal(classifyRestWindowWeight(weight), 'blend', `weight=${weight}`)
	}
})

test('classifyRestWindowWeight: computeRestWindowWeight の出力と噛み合う', () => {
	// 減衰前 = full、 区間内 = blend、 終点以後 = identity。 weight の exact 0 が
	// そのまま identity 分岐になることを end-to-end で固定する
	assert.equal(classifyRestWindowWeight(computeRestWindowWeight(0, 18, 6)), 'full')
	assert.equal(classifyRestWindowWeight(computeRestWindowWeight(36, 18, 6)), 'full')
	assert.equal(classifyRestWindowWeight(computeRestWindowWeight(45, 18, 6)), 'blend')
	assert.equal(classifyRestWindowWeight(computeRestWindowWeight(54, 18, 6)), 'identity')
	assert.equal(classifyRestWindowWeight(computeRestWindowWeight(99, 18, 6)), 'identity')
})

// --- restWindowFingerprint ---

test('restWindowFingerprint: 同じ入力なら同じ文字列', () => {
	assert.equal(
		restWindowFingerprint(timing(20, 'loop', 0), 6),
		restWindowFingerprint(timing(20, 'loop', 0), 6),
	)
})

test('restWindowFingerprint: raw 値のどれが変わっても文字列が変わる', () => {
	const base = restWindowFingerprint(timing(20, 'loop', 0), 6)
	assert.notEqual(base, restWindowFingerprint(timing(21, 'loop', 0), 6))
	assert.notEqual(base, restWindowFingerprint(timing(20, 'once', 0), 6))
	assert.notEqual(base, restWindowFingerprint(timing(20, 'loop', 1), 6))
	assert.notEqual(base, restWindowFingerprint(timing(20, 'loop', 0), 7))
	// 丸めないので細かい差も拾う
	assert.notEqual(
		restWindowFingerprint(timing(20, 'loop', 0), 6.0000001),
		restWindowFingerprint(timing(20, 'loop', 0), 6),
	)
})

test('restWindowFingerprint: NaN と Infinity が別の文字列になる', () => {
	// JSON.stringify は NaN も Infinity も null にするため、 数値は String() で載せている
	const nan = restWindowFingerprint(timing(Number.NaN, 'loop', 0), 6)
	const inf = restWindowFingerprint(timing(Number.POSITIVE_INFINITY, 'loop', 0), 6)
	const negInf = restWindowFingerprint(timing(Number.NEGATIVE_INFINITY, 'loop', 0), 6)
	assert.notEqual(nan, inf)
	assert.notEqual(inf, negInf)
	assert.notEqual(nan, negInf)
	// requestedFrames 側も同様
	assert.notEqual(
		restWindowFingerprint(timing(20, 'loop', 0), Number.NaN),
		restWindowFingerprint(timing(20, 'loop', 0), Number.POSITIVE_INFINITY),
	)
})

test('restWindowFingerprint: 導出値ではなく raw 値を見る', () => {
	// どちらも displayedFinalFrame = 18 に導出されるが、 raw が違うので fingerprint は別。
	// 導出関数に bug があっても invalidate 判定を道連れにしないための性質
	const a = timing(20, 'loop', 0)
	const b = timing(19, 'once', 0)
	assert.equal(deriveDisplayedFinalFrame(a), deriveDisplayedFinalFrame(b))
	assert.notEqual(restWindowFingerprint(a, 6), restWindowFingerprint(b, 6))
})
