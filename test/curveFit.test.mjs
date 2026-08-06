import test from 'node:test'
import assert from 'node:assert/strict'

const {
	hermiteSegment,
	evalBezierBB,
	solveTangents,
	fitSharedKnots,
	BB_BEZIER_DIVISIONS,
	BB_DEFAULT_HANDLE_TIME,
} = await import('../dist-test/curveFit.mjs')

// --- テスト用の最小 quaternion 演算 (= 本番は THREE を注入する) ---

// three.js Quaternion.setFromEuler (order 'XYZ') と同一式。 引数は radians。
function quaternionFromEuler(ex, ey, ez) {
	const c1 = Math.cos(ex / 2), c2 = Math.cos(ey / 2), c3 = Math.cos(ez / 2)
	const s1 = Math.sin(ex / 2), s2 = Math.sin(ey / 2), s3 = Math.sin(ez / 2)
	return {
		x: s1 * c2 * c3 + c1 * s2 * s3,
		y: c1 * s2 * c3 - s1 * c2 * s3,
		z: c1 * c2 * s3 + s1 * s2 * c3,
		w: c1 * c2 * c3 - s1 * s2 * s3,
	}
}

// 2 姿勢の角度差 (degrees)。 符号違いの同一姿勢を同一視するため dot の絶対値を取る。
function quatAngleDeg(a, b) {
	const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
	return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI
}

const OPS = { quaternionFromEuler, quatAngleDeg }
const DEG2RAD = Math.PI / 180

// --- BB getBezierLerp の独立な写し (= 実装と突き合わせる参照) ---
//
// blockbench/js/animations/keyframe.js:220-261 の手順をそのまま書き下したもの。
// curve.getPoints(200) 相当のサンプル列を作り、 最近傍とその次を **参照一致** で
// 区別して 2 点 lerp する (= BB は point オブジェクトの同一性で除外している)。
function referenceGetBezierLerp(seg, t) {
	const { P0, P1, P2, P3 } = seg
	const points = []
	for (let d = 0; d <= 200; d++) {
		// three.js CubicBezier の式 (= 係数の組み立て順も合わせる)
		const s = d / 200
		const k = 1 - s
		const px = k * k * k * P0[0] + 3 * k * k * s * P1[0] + 3 * k * s * s * P2[0] + s * s * s * P3[0]
		const py = k * k * k * P0[1] + 3 * k * k * s * P1[1] + 3 * k * s * s * P2[1] + s * s * s * P3[1]
		points.push({ x: px, y: py })
	}
	let closest = null
	let closestDiff = Infinity
	for (const point of points) {
		const diff = Math.abs(point.x - t)
		if (diff < closestDiff) {
			closestDiff = diff
			closest = point
		}
	}
	let second = null
	closestDiff = Infinity
	for (const point of points) {
		if (point === closest) continue
		const diff = Math.abs(point.x - t)
		if (diff < closestDiff) {
			closestDiff = diff
			second = point
		}
	}
	const alpha = Math.min(1, Math.max(0, (t - closest.x) / (second.x - closest.x)))
	return closest.y + (second.y - closest.y) * alpha
}

// 10 秒 / 20fps = 201 点の正弦波。 spike の計測条件 (= 振幅 30°、 周期 0.9s) に合わせる。
function makeSine({ amplitude = 30, period = 0.9, fps = 20, frames = 201 } = {}) {
	const times = []
	const values = []
	for (let k = 0; k < frames; k++) {
		const t = k / fps
		times.push(t)
		values.push(amplitude * Math.sin(2 * Math.PI * t / period))
	}
	return { times, values }
}

function zeros(n) {
	return new Array(n).fill(0)
}

// --- hermiteSegment ---

test('hermiteSegment: handle の時間成分は gap/3 固定で、 値は傾き × gap/3', () => {
	const seg = hermiteSegment(1, 10, 4, 22, 2, -5)
	const third = 1 // gap = 3

	assert.equal(seg.rightTime, third)
	assert.equal(seg.leftTime, -third)
	assert.equal(seg.rightValue, 2 * third)
	assert.equal(seg.leftValue, 5 * third)
	assert.deepEqual(seg.P0, [1, 10])
	assert.deepEqual(seg.P1, [2, 12])
	assert.deepEqual(seg.P2, [3, 27])
	assert.deepEqual(seg.P3, [4, 22])
})

test('hermiteSegment: control point の x が等間隔になる (= x が線形化する条件)', () => {
	const seg = hermiteSegment(0.35, -4, 1.1, 7, 13, -2)
	const d1 = seg.P1[0] - seg.P0[0]
	const d2 = seg.P2[0] - seg.P1[0]
	const d3 = seg.P3[0] - seg.P2[0]

	assert.ok(Math.abs(d1 - d2) < 1e-12, `${d1} vs ${d2}`)
	assert.ok(Math.abs(d2 - d3) < 1e-12, `${d2} vs ${d3}`)
})

// --- evalBezierBB ---

test('evalBezierBB: 分割数は BB と同じ 200', () => {
	assert.equal(BB_BEZIER_DIVISIONS, 200)
})

test('evalBezierBB: 端点では knot の値をそのまま返す', () => {
	const seg = hermiteSegment(0.5, -3, 1.25, 8, 4, -7)

	assert.ok(Math.abs(evalBezierBB(seg, 0.5) - (-3)) < 1e-9)
	assert.ok(Math.abs(evalBezierBB(seg, 1.25) - 8) < 1e-9)
})

test('evalBezierBB: 直線 (= 両端の傾きが弦と一致) は誤差なく再現する', () => {
	const slope = (8 - 2) / (1.5 - 0.5)
	const seg = hermiteSegment(0.5, 2, 1.5, 8, slope, slope)

	for (const t of [0.5, 0.6, 0.77, 1.0, 1.23, 1.5]) {
		const expected = 2 + slope * (t - 0.5)
		assert.ok(Math.abs(evalBezierBB(seg, t) - expected) < 1e-9, `t=${t}`)
	}
})

test('evalBezierBB: BB の 200 分割 + 最近傍 2 点 lerp と一致する', () => {
	// 傾きを両端で大きく食い違わせて、 解析解との差が出る形にする
	const seg = hermiteSegment(0, 0, 1, 10, 40, -40)

	for (let k = 0; k <= 40; k++) {
		const t = k / 40
		const actual = evalBezierBB(seg, t)
		const expected = referenceGetBezierLerp(seg, t)
		assert.ok(Math.abs(actual - expected) < 1e-9, `t=${t}: ${actual} vs ${expected}`)
	}
})

test('evalBezierBB: サンプル間は折れ線なので解析解とはわずかにずれる', () => {
	// 200 分割の折れ線近似であること自体の確認 (= 解析解を返す実装ではない)。
	// x は線形なのでサンプルは x 等間隔になり、 ずれは弦と曲線の差ぶんだけ残る。
	const seg = hermiteSegment(0, 0, 1, 10, 40, -40)
	const analytic = s => {
		const u = 1 - s
		return u * u * u * seg.P0[1] + 3 * u * u * s * seg.P1[1] + 3 * u * s * s * seg.P2[1] + s * s * s * seg.P3[1]
	}
	let worst = 0
	for (let k = 1; k < 400; k++) {
		const t = k / 400
		worst = Math.max(worst, Math.abs(evalBezierBB(seg, t) - analytic(t)))
	}

	assert.ok(worst > 0, '折れ線近似ならサンプル間でずれが出るはず')
	assert.ok(worst < 1e-3, `ずれが大きすぎる : ${worst}`)
})

// --- solveTangents ---

test('solveTangents: 直線データでは全 knot の傾きが弦の傾きになる', () => {
	const times = []
	const values = []
	for (let k = 0; k <= 10; k++) {
		times.push(k / 10)
		values.push(3 * (k / 10) + 1)
	}

	const m = solveTangents(times, values, [0, 10])

	assert.equal(m.length, 2)
	assert.ok(Math.abs(m[0] - 3) < 1e-9, `${m[0]}`)
	assert.ok(Math.abs(m[1] - 3) < 1e-9, `${m[1]}`)
})

test('solveTangents: 3 次関数は解析的な微係数を厳密に復元する (1 区間)', () => {
	// Hermite は 3 次なので、 データが 3 次関数なら残差 0 の解が存在する = 一意最小解
	const f = t => 2 * t * t * t - 3 * t * t + t + 5
	const df = t => 6 * t * t - 6 * t + 1
	const times = []
	const values = []
	for (let k = 0; k <= 20; k++) {
		times.push(k / 20)
		values.push(f(k / 20))
	}

	const m = solveTangents(times, values, [0, 20])

	assert.ok(Math.abs(m[0] - df(0)) < 1e-6, `${m[0]} vs ${df(0)}`)
	assert.ok(Math.abs(m[1] - df(1)) < 1e-6, `${m[1]} vs ${df(1)}`)
})

test('solveTangents: 三重対角の結合を含む 2 区間でも解析解を復元する', () => {
	// 中央 knot は左右の区間から係数を受ける = 非対角要素が効くケース。
	// 中央差分では出ない値になるので、 fallback へ落ちていないことの確認も兼ねる。
	const f = t => t * t * t - 2 * t + 1
	const df = t => 3 * t * t - 2
	const times = []
	const values = []
	for (let k = 0; k <= 30; k++) {
		times.push(k / 10)
		values.push(f(k / 10))
	}
	const breaks = [0, 12, 30]

	const m = solveTangents(times, values, breaks)

	assert.equal(m.length, 3)
	for (let b = 0; b < breaks.length; b++) {
		const expected = df(times[breaks[b]])
		assert.ok(Math.abs(m[b] - expected) < 1e-6, `b=${b}: ${m[b]} vs ${expected}`)
	}
	// 中央 knot の中央差分は解析解と一致しない = 一括最小二乗が実際に解いている証拠
	const central = (values[13] - values[11]) / (times[13] - times[11])
	assert.ok(Math.abs(central - df(times[12])) > 1e-6)
})

test('solveTangents: 区間を持たない knot は中央差分へ落ちる', () => {
	const times = [0, 0.5, 1, 1.5]
	const values = [0, 1, 4, 9]

	// knot 1 個 = 区間なし → 係数が全て 0 になる自由度
	const m = solveTangents(times, values, [1])

	assert.equal(m.length, 1)
	const central = (values[2] - values[0]) / (times[2] - times[0])
	assert.ok(Math.abs(m[0] - central) < 1e-12, `${m[0]} vs ${central}`)
})

test('solveTangents: 入力配列を変異させない', () => {
	const times = [0, 0.25, 0.5, 0.75, 1]
	const values = [0, 1, 0, -1, 0]
	const breaks = [0, 2, 4]
	const timesCopy = [...times]
	const valuesCopy = [...values]
	const breaksCopy = [...breaks]

	solveTangents(times, values, breaks)

	assert.deepEqual(times, timesCopy)
	assert.deepEqual(values, valuesCopy)
	assert.deepEqual(breaks, breaksCopy)
})

// --- fitSharedKnots ---

test('fitSharedKnots: 正弦波 201 点を閾値 0.5° で 70 個以下の keyframe に収める', () => {
	const { times, values } = makeSine()
	const axes = { x: values, y: zeros(times.length), z: zeros(times.length) }

	const fit = fitSharedKnots(times, axes, 0.5, { fps: 20, ...OPS })

	assert.ok(fit.keyframeCount <= 70, `keyframe が多すぎる : ${fit.keyframeCount}`)
	assert.ok(fit.keyframeCount >= 10, `keyframe が少なすぎる : ${fit.keyframeCount}`)
	assert.ok(fit.maxAngle <= 0.5, `最大角度誤差が閾値超え : ${fit.maxAngle}`)
	assert.ok(fit.avgAngle <= fit.maxAngle)
	assert.equal(fit.keyframes.length, fit.keyframeCount)
	assert.equal(fit.segments.length, fit.keyframeCount - 1)
})

test('fitSharedKnots: 閾値を満たせば converged、 分割できなければ false', () => {
	const { times, values } = makeSine()
	const axes = { x: values, y: zeros(times.length), z: zeros(times.length) }

	const ok = fitSharedKnots(times, axes, 0.5, { fps: 20, ...OPS })
	assert.equal(ok.converged, true)

	// minGapFrames を系列長に合わせると knot を追加できず、 誤差が残ったまま打ち切られる
	const short = makeSine({ frames: 21, period: 0.5 })
	const stuck = fitSharedKnots(short.times, {
		x: short.values,
		y: zeros(21),
		z: zeros(21),
	}, 0.5, { fps: 20, minGapFrames: 20, ...OPS })

	assert.equal(stuck.converged, false)
	assert.ok(stuck.maxAngle > 0.5)
})

test('fitSharedKnots: 中央差分 (useLS = false) でも閾値を満たす', () => {
	const { times, values } = makeSine()
	const axes = { x: values, y: zeros(times.length), z: zeros(times.length) }

	const fit = fitSharedKnots(times, axes, 0.5, { fps: 20, useLS: false, ...OPS })

	assert.ok(fit.keyframeCount <= 70, `keyframe が多すぎる : ${fit.keyframeCount}`)
	assert.ok(fit.maxAngle <= 0.5, `最大角度誤差が閾値超え : ${fit.maxAngle}`)
})

test('fitSharedKnots: 3 軸すべてが動く入力でも knot 時刻を共有する', () => {
	const fps = 20
	const times = []
	const axes = { x: [], y: [], z: [] }
	for (let k = 0; k < 201; k++) {
		const t = k / fps
		times.push(t)
		axes.x.push(30 * Math.sin(2 * Math.PI * t / 0.9))
		axes.y.push(12 * Math.sin(2 * Math.PI * t / 1.4 + 0.7))
		axes.z.push(18 * Math.sin(2 * Math.PI * t / 0.6 + 1.3))
	}

	const fit = fitSharedKnots(times, axes, 0.5, { fps, ...OPS })

	// 3 軸独立に打つと軸ごとの knot 時刻の和集合になるが、 共有すればその膨張が起きない
	assert.ok(fit.keyframeCount <= 100, `keyframe が多すぎる : ${fit.keyframeCount}`)
	assert.ok(fit.maxAngle <= 0.5, `最大角度誤差が閾値超え : ${fit.maxAngle}`)
	// 全 keyframe が 3 軸そろった値と handle を持つ
	for (const kf of fit.keyframes) {
		for (const ax of ['x', 'y', 'z']) {
			assert.equal(typeof kf.value[ax], 'number')
			assert.equal(typeof kf.bezierLeftTime[ax], 'number')
			assert.equal(typeof kf.bezierRightValue[ax], 'number')
		}
	}
})

test('fitSharedKnots: 報告された誤差を全 sample で再現できる', () => {
	const { times, values } = makeSine()
	const axes = { x: values, y: zeros(times.length), z: zeros(times.length) }

	const fit = fitSharedKnots(times, axes, 0.5, { fps: 20, ...OPS })

	// 返り値の maxAngle を信用せず、 segment を自前で評価し直して測る
	let worst = 0
	for (const seg of fit.segments) {
		for (let k = seg.i; k <= seg.j; k++) {
			const q = quaternionFromEuler(
				evalBezierBB(seg.per.x, times[k]) * DEG2RAD,
				evalBezierBB(seg.per.y, times[k]) * DEG2RAD,
				evalBezierBB(seg.per.z, times[k]) * DEG2RAD,
			)
			const truth = quaternionFromEuler(axes.x[k] * DEG2RAD, axes.y[k] * DEG2RAD, axes.z[k] * DEG2RAD)
			worst = Math.max(worst, quatAngleDeg(q, truth))
		}
	}

	assert.ok(worst <= 0.5, `再測定した最大誤差が閾値超え : ${worst}`)
	assert.ok(Math.abs(worst - fit.maxAngle) < 1e-9, `${worst} vs ${fit.maxAngle}`)
})

test('fitSharedKnots: breaks は昇順で両端を含み、 keyframe と対応する', () => {
	const { times, values } = makeSine()
	const axes = { x: values, y: zeros(times.length), z: zeros(times.length) }

	const fit = fitSharedKnots(times, axes, 0.5, { fps: 20, ...OPS })

	assert.equal(fit.breaks[0], 0)
	assert.equal(fit.breaks[fit.breaks.length - 1], times.length - 1)
	for (let b = 1; b < fit.breaks.length; b++) {
		assert.ok(fit.breaks[b] > fit.breaks[b - 1], `breaks が昇順でない : ${fit.breaks}`)
	}
	fit.keyframes.forEach((kf, b) => {
		assert.equal(kf.index, fit.breaks[b])
		assert.equal(kf.time, times[kf.index])
		assert.equal(kf.frame, Math.round(times[kf.index] * 20))
		assert.equal(kf.value.x, axes.x[kf.index])
	})
})

test('fitSharedKnots: 端点の handle は BB の既定値、 内部は隣接区間と共有する', () => {
	const { times, values } = makeSine()
	const axes = { x: values, y: zeros(times.length), z: zeros(times.length) }

	const fit = fitSharedKnots(times, axes, 0.5, { fps: 20, ...OPS })
	const first = fit.keyframes[0]
	const last = fit.keyframes[fit.keyframes.length - 1]

	assert.equal(first.bezierLeftTime.x, -BB_DEFAULT_HANDLE_TIME)
	assert.equal(first.bezierLeftValue.x, 0)
	assert.equal(last.bezierRightTime.x, BB_DEFAULT_HANDLE_TIME)
	assert.equal(last.bezierRightValue.x, 0)

	for (let b = 0; b < fit.segments.length; b++) {
		const seg = fit.segments[b]
		const gapThird = (times[seg.j] - times[seg.i]) / 3
		for (const ax of ['x', 'y', 'z']) {
			assert.ok(Math.abs(fit.keyframes[b].bezierRightTime[ax] - gapThird) < 1e-12)
			assert.ok(Math.abs(fit.keyframes[b + 1].bezierLeftTime[ax] + gapThird) < 1e-12)
			assert.equal(fit.keyframes[b].bezierRightValue[ax], seg.per[ax].rightValue)
			assert.equal(fit.keyframes[b + 1].bezierLeftValue[ax], seg.per[ax].leftValue)
		}
	}
})

test('fitSharedKnots: 動きの無い入力は両端 2 個だけに畳む', () => {
	const times = []
	for (let k = 0; k < 51; k++) times.push(k / 20)
	const axes = { x: zeros(51), y: zeros(51), z: zeros(51) }

	const fit = fitSharedKnots(times, axes, 0.5, { fps: 20, ...OPS })

	assert.equal(fit.keyframeCount, 2)
	assert.deepEqual(fit.breaks, [0, 50])
	assert.equal(fit.maxAngle, 0)
	assert.equal(fit.avgAngle, 0)
})

test('fitSharedKnots: 入力配列を変異させない', () => {
	const { times, values } = makeSine({ frames: 61 })
	const axes = { x: values, y: zeros(61), z: zeros(61) }
	const timesCopy = [...times]
	const axesCopy = { x: [...axes.x], y: [...axes.y], z: [...axes.z] }

	fitSharedKnots(times, axes, 0.5, { fps: 20, ...OPS })

	assert.deepEqual(times, timesCopy)
	assert.deepEqual(axes.x, axesCopy.x)
	assert.deepEqual(axes.y, axesCopy.y)
	assert.deepEqual(axes.z, axesCopy.z)
})

test('fitSharedKnots: 退化入力 (0 点 / 1 点) でも壊れない', () => {
	const empty = fitSharedKnots([], { x: [], y: [], z: [] }, 0.5, { fps: 20, ...OPS })
	assert.equal(empty.keyframeCount, 0)
	assert.deepEqual(empty.breaks, [])
	assert.deepEqual(empty.segments, [])
	assert.deepEqual(empty.keyframes, [])

	const single = fitSharedKnots([0], { x: [5], y: [0], z: [0] }, 0.5, { fps: 20, ...OPS })
	assert.equal(single.keyframeCount, 1)
	assert.deepEqual(single.segments, [])
	assert.equal(single.keyframes[0].value.x, 5)
	assert.equal(single.keyframes[0].bezierLeftTime.x, -BB_DEFAULT_HANDLE_TIME)
	assert.equal(single.keyframes[0].bezierRightTime.x, BB_DEFAULT_HANDLE_TIME)
	assert.equal(single.avgAngle, 0)
})
