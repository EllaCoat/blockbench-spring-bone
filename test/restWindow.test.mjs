import test from 'node:test'
import assert from 'node:assert/strict'

const {
	SUBSTEPS_PER_EXPORT_FRAME,
	deriveRenderSampleCount,
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

test('deriveRenderSampleCount: 非有限 / 負は 0', () => {
	for (const length of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.01]) {
		assert.equal(deriveRenderSampleCount(length), 0, `length=${length}`)
	}
})

test('deriveRenderSampleCount: 巨大な length でも停止する (= 上限で打ち切り)', () => {
	// 進行不能な入力でも無限ループにならないことを固定する
	const result = deriveRenderSampleCount(1e9)
	assert.ok(Number.isInteger(result) && result > 0 && result <= 100000, `result=${result}`)
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
