// 時刻写像の純粋関数群。 物理シムの時刻の正本を「浮動小数の秒」 から「整数 step 番号」
// に移行するため、 tick 側は必ず timeToStepIndex で格子化し、 物理 / applyPoseAt に渡す
// 時刻は stepIndexToTime で逆写像する (= 往路で ULP 丸めした格子点を復路で再現)。
export const STEPS_PER_SECOND = 60
export const FIXED_DT_SECONDS = 1 / STEPS_PER_SECOND
// 30 step (= 0.5 秒) ちょうどまでは cache advance、 31 step からは 0 replay に流す
// (= これ以上の前進は cache 経路が重くなる + scrub の大ジャンプ判定)。
export const FAST_FORWARD_STEP_THRESHOLD = 30

// 秒 → step 番号。 非 finite 値 (= NaN / Infinity) は RangeError、 0 以下は 0 へ clamp。
// 1/60 格子上の時刻は浮動小数誤差で最近傍整数から数 ULP ズレることがある
// (= 2.05 * 60 = 122.99999999999999) ため、 ULP 許容幅内なら最近傍整数、 それ以外は
// floor を返す。 固定 epsilon (= Math.floor(scaled + 1e-6) 等) は使わない : 格子の
// わずかに手前の時刻 (= k/60 - 1e-10) を 1 step 先へ切り上げてしまう実測あり
// (= 3600 ケース全件誤判定。 ULP 判定は 0 件)。
export function timeToStepIndex(timeSeconds: number): number {
	if (!Number.isFinite(timeSeconds)) {
		throw new RangeError(`timeToStepIndex: non-finite time ${timeSeconds}`)
	}
	if (timeSeconds <= 0) return 0
	const scaled = timeSeconds * STEPS_PER_SECOND
	const nearest = Math.round(scaled)
	// scale 不変にするため絶対項と相対項の max を取る
	const tol = Math.max(Number.EPSILON * 4, Math.abs(scaled) * Number.EPSILON * 4)
	return Math.abs(scaled - nearest) <= tol ? nearest : Math.floor(scaled)
}

// step 番号 → 秒。 applyPoseAt 等へ渡す時刻は必ずこの関数経由にする。
export function stepIndexToTime(stepIndex: number): number {
	return stepIndex / STEPS_PER_SECOND
}
