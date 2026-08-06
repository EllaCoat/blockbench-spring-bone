import test from 'node:test'
import assert from 'node:assert/strict'

const { continuifyEulerSeries } = await import('../dist-test/eulerContinuity.mjs')

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

// --- テスト用の最小 quaternion / Euler 変換 (= three.js と同一式) ---

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

// three.js Euler.setFromQuaternion (order 'XYZ') と同一式。 y を [-90°, 90°] に収める正準形を返す
// = 姿勢が滑らかでも境界で x / z が約 180° 飛ぶ。 これが連続化の対象。
function eulerFromQuaternion(q) {
	const { x, y, z, w } = q
	const x2 = x + x, y2 = y + y, z2 = z + z
	const xx = x * x2, xy = x * y2, xz = x * z2
	const yy = y * y2, yz = y * z2, zz = z * z2
	const wx = w * x2, wy = w * y2, wz = w * z2
	const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy
	const m22 = 1 - (xx + zz), m23 = yz - wx
	const m32 = yz + wx, m33 = 1 - (xx + yy)
	const clamped = Math.min(1, Math.max(-1, m13))
	const ey = Math.asin(clamped)
	if (Math.abs(m13) < 0.9999999) {
		return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)]
	}
	return [Math.atan2(m32, m22), ey, 0]
}

// degrees の Euler 系列 (= 真値) から、 quaternion 経由の正準形抽出を通した系列を作る。
// 実際の bake 経路 (= 物理で作った姿勢を Euler へ戻す) と同じ形。
function canonicalizeThroughQuaternion(truth) {
	const out = { x: [], y: [], z: [] }
	for (let i = 0; i < truth.x.length; i++) {
		const q = quaternionFromEuler(truth.x[i] * DEG2RAD, truth.y[i] * DEG2RAD, truth.z[i] * DEG2RAD)
		const [ex, ey, ez] = eulerFromQuaternion(q)
		out.x.push(ex * RAD2DEG)
		out.y.push(ey * RAD2DEG)
		out.z.push(ez * RAD2DEG)
	}
	return out
}

function maxAdjacentJump(series) {
	let worst = 0
	for (let i = 1; i < series.x.length; i++) {
		for (const ax of ['x', 'y', 'z']) {
			worst = Math.max(worst, Math.abs(series[ax][i] - series[ax][i - 1]))
		}
	}
	return worst
}

// ±360° shift だけで前 frame へ寄せる素朴な連続化 (= 双対解を候補に入れない版)
function shift360Only(series) {
	const out = { x: [series.x[0]], y: [series.y[0]], z: [series.z[0]] }
	for (let i = 1; i < series.x.length; i++) {
		for (const ax of ['x', 'y', 'z']) {
			const prev = out[ax][i - 1]
			const v = series[ax][i]
			out[ax].push(v + 360 * Math.round((prev - v) / 360))
		}
	}
	return out
}

// --- 連続な入力はそのまま通す ---

test('continuifyEulerSeries: 既に連続な系列は値を変えない', () => {
	const series = {
		x: [0, 5, 10, 15, 20],
		y: [-3, -2.5, -2, -1.5, -1],
		z: [40, 41, 42, 43, 44],
	}

	const out = continuifyEulerSeries(series)

	assert.deepEqual(out.x, series.x)
	assert.deepEqual(out.y, series.y)
	assert.deepEqual(out.z, series.z)
})

test('continuifyEulerSeries: 入力を変異させず新しい配列を返す', () => {
	const series = { x: [0, 5], y: [0, 1], z: [0, -1] }
	const copy = { x: [...series.x], y: [...series.y], z: [...series.z] }

	const out = continuifyEulerSeries(series)

	assert.notEqual(out.x, series.x)
	assert.deepEqual(series.x, copy.x)
	assert.deepEqual(series.y, copy.y)
	assert.deepEqual(series.z, copy.z)
})

// --- ±360° の巻き戻り ---

test('continuifyEulerSeries: ±180° 境界の折り返しを 360° shift で伸ばす', () => {
	const series = {
		x: [0, 0, 0, 0, 0],
		y: [0, 0, 0, 0, 0],
		z: [170, 175, 180, -175, -170],
	}

	const out = continuifyEulerSeries(series)

	assert.deepEqual(out.z, [170, 175, 180, 185, 190])
	assert.ok(maxAdjacentJump(out) <= 5.0001)
})

// --- gimbal 付近の双対解 ---

test('continuifyEulerSeries: gimbal を跨ぐ系列で双対解を選び、 真値の表現へ戻す', () => {
	// y が 90° を跨ぐ滑らかな回転。 正準形抽出は y を折り返し、 x / z を約 180° 飛ばす。
	// sample が厳密な gimbal lock (= |y| が 90° から 0.03° 以内) に乗らないよう 0.4° ずらす :
	// lock 上では等価解が 1 径数族になり、 有限個の候補からは選べない (= module の既知の限界)
	const truth = { x: [], y: [], z: [] }
	for (let i = 0; i <= 30; i++) {
		truth.x.push(20)
		truth.y.push(75.4 + i)
		truth.z.push(30)
	}
	const raw = canonicalizeThroughQuaternion(truth)

	// 前提 : 生の抽出には偽の急変がある
	assert.ok(maxAdjacentJump(raw) > 100, `生の抽出が飛んでいない : ${maxAdjacentJump(raw)}`)
	// 前提 : ±360° shift だけでは解消できない (= 双対解が要る根拠)
	assert.ok(maxAdjacentJump(shift360Only(raw)) > 100, '360 shift だけで解消できてしまっている')

	const out = continuifyEulerSeries(raw)

	assert.ok(maxAdjacentJump(out) < 2, `連続化後も飛んでいる : ${maxAdjacentJump(out)}`)
	for (let i = 0; i < truth.x.length; i++) {
		assert.ok(Math.abs(out.x[i] - truth.x[i]) < 1e-9, `x[${i}] = ${out.x[i]}`)
		assert.ok(Math.abs(out.y[i] - truth.y[i]) < 1e-9, `y[${i}] = ${out.y[i]}`)
		assert.ok(Math.abs(out.z[i] - truth.z[i]) < 1e-9, `z[${i}] = ${out.z[i]}`)
	}
})

test('continuifyEulerSeries: −90° 側の gimbal でも飛びを作らない', () => {
	const truth = { x: [], y: [], z: [] }
	for (let i = 0; i <= 40; i++) {
		const t = i / 40
		truth.x.push(-140 + 20 * t)
		truth.y.push(-70 - 40 * t)
		truth.z.push(165 + 30 * t)
	}
	const raw = canonicalizeThroughQuaternion(truth)

	const out = continuifyEulerSeries(raw)

	// 真値の隣接差は 1.5° 未満 = 連続化後も同程度に収まるはず
	assert.ok(maxAdjacentJump(out) < 3, `連続化後も飛んでいる : ${maxAdjacentJump(out)}`)
})

test('continuifyEulerSeries: 出力は元と同じ姿勢を表す', () => {
	const truth = { x: [], y: [], z: [] }
	for (let i = 0; i <= 60; i++) {
		const t = i / 10
		truth.x.push(45 * Math.sin(t))
		truth.y.push(95 * Math.sin(t * 0.7 + 1))
		truth.z.push(150 * Math.cos(t * 0.4))
	}
	const raw = canonicalizeThroughQuaternion(truth)

	const out = continuifyEulerSeries(raw)

	for (let i = 0; i < raw.x.length; i++) {
		const before = quaternionFromEuler(raw.x[i] * DEG2RAD, raw.y[i] * DEG2RAD, raw.z[i] * DEG2RAD)
		const after = quaternionFromEuler(out.x[i] * DEG2RAD, out.y[i] * DEG2RAD, out.z[i] * DEG2RAD)
		// 角度差は acos の精度限界 (= 1e-6° 程度) に当たるので、 成分で直接比べる。
		// 双対解は quaternion の符号が反転するため、 符号を揃えてから差を見る
		const sign = (before.x * after.x + before.y * after.y + before.z * after.z + before.w * after.w) < 0 ? -1 : 1
		for (const key of ['x', 'y', 'z', 'w']) {
			const diff = Math.abs(before[key] - sign * after[key])
			assert.ok(diff < 1e-9, `frame ${i} の ${key} で姿勢が変わった : ${diff}`)
		}
	}
})

test('continuifyEulerSeries: gimbal 近傍を何度も往復しても跳びが増えない', () => {
	// y が 90° を何度も往復する 201 点 (= 10 秒 / 20fps)。 位相は sample が厳密な
	// gimbal lock に乗らないよう選んである (= 最接近でも 90° から 1.5° 離れる)
	const truth = { x: [], y: [], z: [] }
	for (let i = 0; i <= 200; i++) {
		const t = i / 20
		truth.x.push(10 + 5 * Math.sin(t))
		truth.y.push(90.3 + 12 * Math.sin(2 * Math.PI * t / 0.9 + 0.5))
		truth.z.push(-25 + 4 * Math.cos(t))
	}
	const raw = canonicalizeThroughQuaternion(truth)

	const out = continuifyEulerSeries(raw)

	assert.ok(maxAdjacentJump(raw) > 100, `生の抽出が飛んでいない : ${maxAdjacentJump(raw)}`)
	assert.ok(maxAdjacentJump(out) < 10, `連続化後も飛んでいる : ${maxAdjacentJump(out)}`)
})

// --- 退化入力 ---

test('continuifyEulerSeries: 空系列は空のまま返す', () => {
	const out = continuifyEulerSeries({ x: [], y: [], z: [] })

	assert.deepEqual(out, { x: [], y: [], z: [] })
})

test('continuifyEulerSeries: 1 点系列はそのまま通す', () => {
	const out = continuifyEulerSeries({ x: [200], y: [-95], z: [3] })

	assert.deepEqual(out, { x: [200], y: [-95], z: [3] })
})

test('continuifyEulerSeries: 軸の長さが揃っていなければ RangeError', () => {
	assert.throws(() => continuifyEulerSeries({ x: [0, 1], y: [0], z: [0, 1] }), RangeError)
	assert.throws(() => continuifyEulerSeries({ x: [0, 1], y: [0, 1], z: [] }), RangeError)
})
