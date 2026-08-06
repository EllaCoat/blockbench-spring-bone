// quaternion から Euler (= degrees) へ変換した時系列を、 フィッティング前に連続化する。
//
// この module は **Blockbench / THREE / AnimatedJava / window を実行時に一切参照しない**
// (= node:test で BB 無しに検証可能)。 入力は変換済みの Euler 系列だけを受け取る。
//
// なぜ必要か :
//   quaternion → Euler の抽出 (= THREE.Euler.setFromQuaternion 'XYZ') は y を [-90°, 90°] に
//   収める正準形しか返さない。 姿勢が滑らかに動いていても、 抽出結果は正準形の境界で不連続に
//   飛ぶ。 その飛びは姿勢としては存在しない偽の急変なので、 そのまま bezier フィッティングに
//   かけると分割が誘発されて keyframe が無駄に増える (= 最悪、 全 frame に打つことになる)。
//
// 何を候補にするか :
//   **±360° shift だけでは足りない**。 gimbal (= y が ±90° を跨ぐ) 付近では正準形が
//   「双対解」 側へ切り替わるため、 x と z が同時に約 180° 飛び、 y が折り返す。 XYZ 順の Euler
//   には
//       R(x, y, z) = R(x + 180°, 180° − y, z + 180°)
//   という恒等式があり (= quaternion では符号反転 = 同一姿勢)、 この双対解を候補に入れないと
//   飛びを解消できない。 したがって候補は
//       {そのまま, 双対解} × 各成分の ±360° shift
//   の組み合わせになる。 ±360° shift は成分ごとに独立なので、 各成分を前 frame へ最も近い
//   代表元へ丸めれば、 その族の中の最良解が直接得られる (= 組み合わせ爆発は起きない)。
//
// 限界 :
//   厳密な gimbal lock (= |sin(y)| = 1) では x と z の配分が一意に決まらず (= x ± z のみ確定)、
//   等価解は 1 径数族になる。 そこまでは扱わない (= 有限個の候補から選ぶだけ)。 実データが
//   完全な lock 上に乗る確率は無視できるうえ、 lock 近傍は双対解の候補で十分に連続化できる。

// 入力 (= degrees)。 3 軸とも同じ長さ。 配列は変異させない。
export interface EulerSeriesInput {
	readonly x: ArrayLike<number>
	readonly y: ArrayLike<number>
	readonly z: ArrayLike<number>
}

// 出力 (= degrees)。 入力と同じ長さの新しい配列。
export interface EulerSeries {
	x: number[]
	y: number[]
	z: number[]
}

// value と等価な (= 360° の整数倍だけ違う) 値のうち、 reference に最も近いものへ丸める
function shiftNear(value: number, reference: number): number {
	return value + 360 * Math.round((reference - value) / 360)
}

// 前 frame からの距離 (= 3 軸の二乗和)。 大小比較だけに使うので平方根は取らない
function distanceSq(x: number, y: number, z: number, px: number, py: number, pz: number): number {
	const dx = x - px
	const dy = y - py
	const dz = z - pz
	return dx * dx + dy * dy + dz * dz
}

// Euler 系列を連続化する。 各 frame で等価な表現 (= そのまま / 双対解、 いずれも ±360° shift 込み)
// を作り、 直前の **出力** に最も近いものを選ぶ (= 選択を逐次的に引き継ぐ)。
// 先頭 frame は基準が無いので入力のまま通す。
export function continuifyEulerSeries(series: EulerSeriesInput): EulerSeries {
	const n = series.x.length
	if (series.y.length !== n || series.z.length !== n) {
		throw new RangeError(`continuifyEulerSeries: axis length mismatch (x=${n}, y=${series.y.length}, z=${series.z.length})`)
	}

	const out: EulerSeries = { x: new Array<number>(n), y: new Array<number>(n), z: new Array<number>(n) }
	if (n === 0) return out

	out.x[0] = series.x[0]
	out.y[0] = series.y[0]
	out.z[0] = series.z[0]

	for (let i = 1; i < n; i++) {
		const px = out.x[i - 1]
		const py = out.y[i - 1]
		const pz = out.z[i - 1]

		// そのままの表現を前 frame へ寄せたもの
		const ax = shiftNear(series.x[i], px)
		const ay = shiftNear(series.y[i], py)
		const az = shiftNear(series.z[i], pz)
		const aCost = distanceSq(ax, ay, az, px, py, pz)

		// 双対解 (x + 180, 180 − y, z + 180) を前 frame へ寄せたもの
		const bx = shiftNear(series.x[i] + 180, px)
		const by = shiftNear(180 - series.y[i], py)
		const bz = shiftNear(series.z[i] + 180, pz)
		const bCost = distanceSq(bx, by, bz, px, py, pz)

		// 同着なら「そのまま」 側を採る (= 無意味な表現の切り替わりを起こさない)
		if (bCost < aCost) {
			out.x[i] = bx
			out.y[i] = by
			out.z[i] = bz
		} else {
			out.x[i] = ax
			out.y[i] = ay
			out.z[i] = az
		}
	}

	return out
}
