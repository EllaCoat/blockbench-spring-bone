// 物理シミュレーション結果 (= frame 単位の Euler 時系列) を、 Blockbench の bezier keyframe
// 列へ落とすためのフィッティング層。
//
// この module は **Blockbench / THREE / AnimatedJava / window を実行時に一切参照しない**
// (= node:test で BB 無しに検証可能)。 quaternion 演算だけは呼び出し側から ops として
// 注入する (= THREE.Quaternion を直接触らないため)。
//
// BB の bezier keyframe の形 (= blockbench/js/animations/keyframe.js:220-261 getBezierLerp) :
//   P0 = (before.time,                            before.value)
//   P1 = (before.time + before.bezier_right_time, before.value + before.bezier_right_value)
//   P2 = (after.time  + after.bezier_left_time,   after.value  + after.bezier_left_value)
//   P3 = (after.time,                             after.value)
// right_time は [0, gap]、 left_time は [-gap, 0] に clamp される。
//
// 採用した形 = **handle の時間成分を gap/3 に固定した Hermite** :
//   bezier_right_time = gap/3、 bezier_left_time = -gap/3 とすると control point の x が等間隔に
//   なり、 x(s) = t0 + gap*s と厳密に線形化する。 効果は 2 つ。
//     1. パラメトリック fitting の「時間軸と値軸でスケールが違うと x 方向が最適化されない」
//        問題が消える (= 自由度が各 knot の傾きだけになる)
//     2. BB の 200 分割最近傍 lerp (= getBezierLerp) のサンプルが x 等間隔になり、
//        評価器固有の誤差がほぼ消える
//   時間成分も最適化する Schneider 型 (= パラメトリック最小二乗) は spike で却下した :
//   handle の clamp が x の単調性を保証せず、 BB の最近傍探索が破綻するため。
//   **gap/3 固定は変更しないこと**。

const EPS = 1e-12

// BB の getBezierLerp が curve.getPoints(200) で取るサンプル数 (= 分割数)。
// 実際のサンプル点数は 201 個 (= k = 0..200)。
export const BB_BEZIER_DIVISIONS = 200

// BB の bezier handle 既定値 (= keyframe.js:602-605 の Property default)。
// 区間を持たない端点 keyframe (= 先頭の left 側 / 末尾の right 側) に使う。
export const BB_DEFAULT_HANDLE_TIME = 0.1

export type Axis = 'x' | 'y' | 'z'

const AXES: readonly Axis[] = ['x', 'y', 'z']
const DEG2RAD = Math.PI / 180

export interface AxisTriple {
	x: number
	y: number
	z: number
}

// 軸ごとの時系列 (= degrees)。 3 軸とも同じ長さで、 times と対応する。
export interface AxisSeries {
	readonly x: ArrayLike<number>
	readonly y: ArrayLike<number>
	readonly z: ArrayLike<number>
}

// 1 区間 (= 隣接する 2 knot の間) の cubic bezier。 handle 4 値は BB の keyframe へ
// そのまま書ける形 (= right 側が左端 keyframe、 left 側が右端 keyframe の値)。
// P0..P3 は [time, value] の control point で、 評価 (= evalBezierBB) に使う。
export interface BezierSegment {
	rightTime: number
	rightValue: number
	leftTime: number
	leftValue: number
	P0: readonly [number, number]
	P1: readonly [number, number]
	P2: readonly [number, number]
	P3: readonly [number, number]
}

// 中央差分の傾き (= C1 連続にするため内部 knot では左右で同じ傾きを使う)。
// 一括最小二乗 (= solveTangents) を使わない場合の傾き、 および solveTangents で係数が
// 全て 0 になった自由度の fallback。
function centralSlope(times: ArrayLike<number>, values: ArrayLike<number>, i: number): number {
	const n = times.length
	if (n < 2) return 0
	if (i <= 0) return (values[1] - values[0]) / (times[1] - times[0])
	if (i >= n - 1) return (values[n - 1] - values[n - 2]) / (times[n - 1] - times[n - 2])
	return (values[i + 1] - values[i - 1]) / (times[i + 1] - times[i - 1])
}

// 1 区間の Hermite (= 時間成分 gap/3 固定) を control point 形に展開する。
// mI / mJ は区間両端の傾き (= dv/dt)。 隣接区間と共有すれば C1 連続になる。
export function hermiteSegment(
	tI: number, vI: number,
	tJ: number, vJ: number,
	mI: number, mJ: number,
): BezierSegment {
	const third = (tJ - tI) / 3
	return {
		rightTime: third,
		rightValue: mI * third,
		leftTime: -third,
		leftValue: -mJ * third,
		P0: [tI, vI],
		P1: [tI + third, vI + mI * third],
		P2: [tJ - third, vJ - mJ * third],
		P3: [tJ, vJ],
	}
}

// evalBezierBB のサンプル置き場 (= [x0, y0, x1, y1, ...])。 BB 側も curve.getPoints(200) で
// 一度だけ配列を作ってから 2 回走査するので、 ここでも 1 回だけ計算して使い回す。
// single-thread 前提の scratch で、 呼び出し間の値保持は前提しない。
const _samples = new Float64Array((BB_BEZIER_DIVISIONS + 1) * 2)

// BB の getBezierLerp と同じ評価。
// **解析解ではない** : cubic bezier を 200 分割したサンプル列から x が最も近い 2 点を取り、
// その 2 点を x について線形補間する。 BB が実際に再生する値と一致させるため、 誤差評価は
// 必ずこの評価器で行う (= 解析解で測ると BB 上で閾値を超える)。
//
// BB 側の細部も踏襲する :
//   - 最近傍は strict < 判定 (= 同着なら先に出た方が勝つ)
//   - 2 番目は「最近傍 **そのもの** を除いた」 最小 (= 値が同じ別サンプルは候補に残る)。
//     BB は point オブジェクトの参照一致で除外しているので、 ここでは index 一致で除外する
//     (= 値一致で除外すると 2 点目を取り逃して lerp が消える)
// なお handle の clamp (= right_time を [0, gap]、 left_time を [-gap, 0] へ) は行わない :
// この module が作る segment は必ず gap/3 固定でその範囲に入るため。
export function evalBezierBB(segment: BezierSegment, t: number): number {
	const { P0, P1, P2, P3 } = segment
	const count = BB_BEZIER_DIVISIONS + 1
	for (let k = 0; k < count; k++) {
		const s = k / BB_BEZIER_DIVISIONS
		const u = 1 - s
		const b0 = u * u * u
		const b1 = 3 * u * u * s
		const b2 = 3 * u * s * s
		const b3 = s * s * s
		_samples[k * 2] = b0 * P0[0] + b1 * P1[0] + b2 * P2[0] + b3 * P3[0]
		_samples[k * 2 + 1] = b0 * P0[1] + b1 * P1[1] + b2 * P2[1] + b3 * P3[1]
	}

	let closest = 0
	let closestDiff = Infinity
	for (let k = 0; k < count; k++) {
		const diff = Math.abs(_samples[k * 2] - t)
		if (diff < closestDiff) {
			closestDiff = diff
			closest = k
		}
	}
	let second = -1
	let secondDiff = Infinity
	for (let k = 0; k < count; k++) {
		if (k === closest) continue
		const diff = Math.abs(_samples[k * 2] - t)
		if (diff < secondDiff) {
			secondDiff = diff
			second = k
		}
	}

	const cx = _samples[closest * 2]
	const cy = _samples[closest * 2 + 1]
	if (second < 0) return cy
	const sx = _samples[second * 2]
	const sy = _samples[second * 2 + 1]
	const denom = sx - cx
	// 退化区間 (= gap 0 等で全サンプルの x が一致) では BB は 0 除算で NaN を出すが、
	// bake 側にそれを流すと keyframe が壊れるので最近傍の値をそのまま返す。
	if (Math.abs(denom) < EPS) return cy
	const alpha = Math.min(1, Math.max(0, (t - cx) / denom))
	return cy + (sy - cy) * alpha
}

// knot の傾きを C1 連続を保ったまま一括最小二乗で解く。
//
// gap/3 固定で x が線形なので、 区間内の各サンプル時刻 k は s = (t_k - t_I)/gap で決まり、
// Hermite 基底 h00/h10/h01/h11 の係数は傾き m について線形になる。 つまり
//   v_fit(k) = h00*v_I + h01*v_J + (h10*gap)*m_I + (h11*gap)*m_J
// で、 残差二乗和を m について最小化する正規方程式は「各区間が隣接する 2 つの傾きだけを
// 結合する」 形 = 三重対角になる。 Thomas algorithm で O(K) で解ける。
//
// times / values / breaks は変異させない。 breaks は昇順の sample index。
export function solveTangents(
	times: ArrayLike<number>,
	values: ArrayLike<number>,
	breaks: ArrayLike<number>,
): Float64Array {
	const K = breaks.length
	if (K === 0) return new Float64Array(0)

	const diag = new Float64Array(K)
	const upper = new Float64Array(K)
	const lower = new Float64Array(K)
	const rhs = new Float64Array(K)

	for (let b = 0; b < K - 1; b++) {
		const i = breaks[b]
		const j = breaks[b + 1]
		const tI = times[i]
		const tJ = times[j]
		const gap = tJ - tI
		if (gap <= 0) continue
		const vI = values[i]
		const vJ = values[j]
		for (let k = i; k <= j; k++) {
			const s = (times[k] - tI) / gap
			const s2 = s * s
			const s3 = s2 * s
			const h00 = 2 * s3 - 3 * s2 + 1
			const h10 = s3 - 2 * s2 + s
			const h01 = -2 * s3 + 3 * s2
			const h11 = s3 - s2
			const cI = h10 * gap
			const cJ = h11 * gap
			const res = h00 * vI + h01 * vJ - values[k]
			diag[b] += cI * cI
			diag[b + 1] += cJ * cJ
			upper[b] += cI * cJ
			lower[b + 1] += cI * cJ
			rhs[b] -= cI * res
			rhs[b + 1] -= cJ * res
		}
	}
	// 全区間で係数が 0 になる自由度 (= 孤立点 / 隣と時刻が同じ knot) は中央差分へ落とす。
	// 放置すると diag 0 で Thomas algorithm が壊れる。
	for (let b = 0; b < K; b++) {
		if (diag[b] < 1e-12) {
			diag[b] = 1
			rhs[b] = centralSlope(times, values, breaks[b])
		}
	}

	// Thomas algorithm (= 三重対角の前進消去 + 後退代入)
	const cp = new Float64Array(K)
	const dp = new Float64Array(K)
	cp[0] = upper[0] / diag[0]
	dp[0] = rhs[0] / diag[0]
	for (let b = 1; b < K; b++) {
		const denom = diag[b] - lower[b] * cp[b - 1]
		const safe = Math.abs(denom) < 1e-12 ? 1e-12 : denom
		cp[b] = upper[b] / safe
		dp[b] = (rhs[b] - lower[b] * dp[b - 1]) / safe
	}
	const m = new Float64Array(K)
	m[K - 1] = dp[K - 1]
	for (let b = K - 2; b >= 0; b--) m[b] = dp[b] - cp[b] * m[b + 1]
	return m
}

// quaternion 演算の注入口。 Q は呼び出し側の quaternion 型 (= THREE.Quaternion) で、
// この module は中身に一切触らない。
export interface QuaternionOps<Q> {
	// Euler (= radians、 BB / THREE の 'XYZ' 順) から quaternion を作る
	quaternionFromEuler(x: number, y: number, z: number): Q
	// 2 姿勢の角度差 (= degrees、 geodesic)。 符号違いの同一姿勢は同一視する
	quatAngleDeg(a: Q, b: Q): number
}

export interface FitSharedKnotsOptions<Q> extends QuaternionOps<Q> {
	// knot 同士の最小 sample 間隔 (= 1 で隣接 frame まで許す)
	minGapFrames?: number
	// frame 番号の算出用 (= Math.round(time * fps))
	fps?: number
	// 初期 knot に 3 軸の極値を置くか
	seedExtrema?: boolean
	// 傾きを一括最小二乗で解くか (= false で中央差分)
	useLS?: boolean
}

export interface AxisBezierSegments {
	x: BezierSegment
	y: BezierSegment
	z: BezierSegment
}

// 区間 = 隣接する 2 knot の間。 i / j は元 sample 列の index。
export interface SharedKnotSegment {
	i: number
	j: number
	per: AxisBezierSegments
}

// BB の rotation keyframe 1 個ぶん。 handle は軸ごとに分かれる (= BB 側も vector Property)。
export interface BakedKeyframe {
	// 元 sample 列での index
	index: number
	frame: number
	time: number
	value: AxisTriple
	bezierLeftTime: AxisTriple
	bezierLeftValue: AxisTriple
	bezierRightTime: AxisTriple
	bezierRightValue: AxisTriple
}

export interface SharedKnotFit {
	// knot に選ばれた sample index (= 昇順)
	breaks: number[]
	segments: SharedKnotSegment[]
	keyframes: BakedKeyframe[]
	keyframeCount: number
	// 実測の姿勢誤差 (= degrees)。 max は打ち切り条件と同じ評価器・同じ量
	maxAngle: number
	avgAngle: number
	// **閾値 (= maxAngleDeg) に届いたか**。 分割ループは上限回数 / 分割不能で打ち切られる
	// ことがあり、 その場合は誤差が閾値を超えたまま返る。 呼び出し側が「この結果は要求精度を
	// 満たしていない」 と気付けるよう明示する (= 黙って成功扱いにしない)。
	converged: boolean
}

function triple(get: (axis: Axis) => number): AxisTriple {
	return { x: get('x'), y: get('y'), z: get('z') }
}

// 3 軸で knot 時刻を共有するフィッティング本体。
//
// BB の rotation keyframe は 1 つの時刻に x/y/z の値をまとめて持ち、 handle だけが軸ごとに
// 分かれる。 したがって軸ごとに独立な時刻へ knot を置くと、 実際に打たれる keyframe は各軸の
// knot 時刻の和集合になる。 最初から時刻を共有して fit すれば和集合の膨張を防げる。
// 分割の判定も軸単位の誤差ではなく、 3 軸を合成した姿勢の角度差 (= geodesic) で行う
// (= 軸単位の誤差は姿勢の誤差と一致しないため、 見た目に直結する量で切る)。
//
// 手順 :
//   1. 初期 knot = 両端 + 3 軸の極値の和集合 (= 揺れの折り返しは 1 本の 3 次で吸収できず、
//      最大誤差点だけで割ると極値をまたぐ区間が残って無駄な分割を誘発する)
//   2. 全区間の傾きを解き (= solveTangents)、 各 sample で合成姿勢の角度差を測る
//   3. 閾値を超える区間のうち最悪のものを、 その最大誤差点で分割して 2 へ戻る
//
// times / axes は変異させない。
export function fitSharedKnots<Q>(
	times: ArrayLike<number>,
	axes: AxisSeries,
	maxAngleDeg: number,
	ops: FitSharedKnotsOptions<Q>,
): SharedKnotFit {
	const {
		minGapFrames = 1,
		fps = 20,
		seedExtrema = true,
		useLS = true,
		quaternionFromEuler,
		quatAngleDeg,
	} = ops
	const n = times.length
	if (n === 0) {
		return { breaks: [], segments: [], keyframes: [], keyframeCount: 0, maxAngle: 0, avgAngle: 0, converged: true }
	}
	const minGap = Math.max(1, minGapFrames)

	// 誤差の基準になる「本来の姿勢」
	const truthQ: Q[] = new Array(n)
	for (let i = 0; i < n; i++) {
		truthQ[i] = quaternionFromEuler(axes.x[i] * DEG2RAD, axes.y[i] * DEG2RAD, axes.z[i] * DEG2RAD)
	}

	// 初期 knot = 両端 + 3 軸の極値の和集合
	const seed = new Set<number>([0, n - 1])
	if (seedExtrema) {
		for (const ax of AXES) {
			const v = axes[ax]
			for (let i = 1; i < n - 1; i++) {
				const d0 = v[i] - v[i - 1]
				const d1 = v[i + 1] - v[i]
				if (d0 === 0 || d1 === 0) continue
				if ((d0 > 0) !== (d1 > 0)) seed.add(i)
			}
		}
	}
	const sorted = [...seed].sort((a, b) => a - b)
	// minGap を満たさない knot を間引く (= 末尾は必ず残す)
	let breaks = sorted.filter((idx, k) => k === 0 || idx === n - 1 || idx - sorted[k - 1] >= minGap)

	const buildSlopes = (): Record<Axis, ArrayLike<number>> => ({
		x: useLS ? solveTangents(times, axes.x, breaks) : breaks.map(idx => centralSlope(times, axes.x, idx)),
		y: useLS ? solveTangents(times, axes.y, breaks) : breaks.map(idx => centralSlope(times, axes.y, idx)),
		z: useLS ? solveTangents(times, axes.z, breaks) : breaks.map(idx => centralSlope(times, axes.z, idx)),
	})

	const buildSegments = (slopes: Record<Axis, ArrayLike<number>>): SharedKnotSegment[] => {
		const segs: SharedKnotSegment[] = []
		for (let b = 0; b < breaks.length - 1; b++) {
			const i = breaks[b]
			const j = breaks[b + 1]
			const per = {} as AxisBezierSegments
			for (const ax of AXES) {
				per[ax] = hermiteSegment(
					times[i], axes[ax][i],
					times[j], axes[ax][j],
					slopes[ax][b], slopes[ax][b + 1],
				)
			}
			segs.push({ i, j, per })
		}
		return segs
	}

	// 区間内の各 sample を bake 後の 3 軸から姿勢へ戻し、 元の姿勢との角度差を測る
	const angleAt = (seg: SharedKnotSegment, k: number): number => {
		const q = quaternionFromEuler(
			evalBezierBB(seg.per.x, times[k]) * DEG2RAD,
			evalBezierBB(seg.per.y, times[k]) * DEG2RAD,
			evalBezierBB(seg.per.z, times[k]) * DEG2RAD,
		)
		return quatAngleDeg(q, truthQ[k])
	}

	let slopes = buildSlopes()
	let segments = buildSegments(slopes)
	// 分割は 1 回につき knot が 1 個増えるので理屈上は n 回で止まるが、 数値的な取りこぼしで
	// 抜けられなくなる場合に備えた上限 (= spike から据え置き)
	let guard = 0
	for (;;) {
		if (++guard > 3000) break
		let worst: { err: number, idx: number, i: number, j: number } | null = null
		for (const seg of segments) {
			let segErr = 0
			let segIdx = -1
			for (let k = seg.i; k <= seg.j; k++) {
				const err = angleAt(seg, k)
				if (err > segErr) {
					segErr = err
					segIdx = k
				}
			}
			if (segErr > maxAngleDeg && (worst === null || segErr > worst.err)) {
				worst = { err: segErr, idx: segIdx, i: seg.i, j: seg.j }
			}
		}
		if (!worst) break
		// 分割点が端に寄りすぎる場合は minGap ぶん内側へ寄せる (= 無限ループ防止)
		let split = worst.idx
		if (split - worst.i < minGap) split = worst.i + minGap
		if (worst.j - split < minGap) split = worst.j - minGap
		if (split <= worst.i || split >= worst.j) break
		if (breaks.includes(split)) break
		breaks.push(split)
		breaks.sort((a, b) => a - b)
		slopes = buildSlopes()
		segments = buildSegments(slopes)
	}

	// 実測の姿勢誤差。 区間の右端は次の区間の左端と同じ sample なので、 最終区間以外は
	// j を除いて数える (= 平均が knot の二重計上で薄まらないように、 全 sample を 1 回ずつ)
	let maxAngle = 0
	let sumAngle = 0
	for (let b = 0; b < segments.length; b++) {
		const seg = segments[b]
		const last = b === segments.length - 1 ? seg.j : seg.j - 1
		for (let k = seg.i; k <= last; k++) {
			const a = angleAt(seg, k)
			if (a > maxAngle) maxAngle = a
			sumAngle += a
		}
	}

	const keyframes: BakedKeyframe[] = breaks.map((idx, b) => {
		const prev = segments[b - 1]
		const next = segments[b]
		return {
			index: idx,
			frame: Math.round(times[idx] * fps),
			time: times[idx],
			value: triple(ax => axes[ax][idx]),
			bezierLeftTime: triple(ax => (prev ? prev.per[ax].leftTime : -BB_DEFAULT_HANDLE_TIME)),
			bezierLeftValue: triple(ax => (prev ? prev.per[ax].leftValue : 0)),
			bezierRightTime: triple(ax => (next ? next.per[ax].rightTime : BB_DEFAULT_HANDLE_TIME)),
			bezierRightValue: triple(ax => (next ? next.per[ax].rightValue : 0)),
		}
	})

	return {
		breaks,
		segments,
		keyframes,
		keyframeCount: breaks.length,
		maxAngle,
		avgAngle: segments.length === 0 ? 0 : sumAngle / n,
		// 打ち切り (= guard 上限 / これ以上割れない) で抜けた場合、 誤差が閾値を超えたまま
		// 返ることがある。 **実測値で判定する** : loop の抜け方を数えるより、 返す結果が
		// 実際に要求を満たしているかを直接見る方が取りこぼしが無い。
		converged: maxAngle <= maxAngleDeg,
	}
}
