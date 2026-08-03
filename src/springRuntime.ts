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

// per-animation 解決の口。 今は animation 参照のみ (= 値の解決は呼び出し側の
// resolveConfigs が行う)。 将来 animation 単位で物理パラを切り替える場合にここへ足す。
export interface AnimationContext<TAnimation = unknown> {
	animation: TAnimation | null
}

// base pose (= keyframe pose) を scene に当てる evaluator。 index.ts の applyPoseAt 相当を
// 注入する。 SpringRuntime 本体は BB / THREE を一切参照せず、 すべて ops / evaluator 経由。
export type BasePoseEvaluator<C> = (timeSeconds: number, context: C) => void

export interface SpringRuntimeOps<C, P> {
	resolveConfigs(context: C): void
	capturePose(): P
	restorePose(snapshot: P): void
	updateMatrixWorld(): void
	resetAllToRest(context: C): void
	stepAndApplyOrdered(dtSeconds: number, context: C): void
	applyOnlyOrdered(context: C): void
}

export type EvaluationMode = 'replay' | 'advance' | 'same-step'

export interface EvaluationResult {
	stepIndex: number
	timeSeconds: number
	substepCount: number
	mode: EvaluationMode
}

// 物理シムの時刻管理を担う runtime。 時刻の正本 = 整数 step 番号 (= timeToStepIndex で
// 1 回だけ格子化)。 BB / AnimatedJava / THREE の API は一切参照せず、 scene への作用は
// すべて constructor で受け取る ops に委譲する (= node:test で BB 無しに検証可能)。
//
// session の流れ : beginAnimation → evaluateSample × N → endAnimation。
// - beginAnimation = 前 session を破棄して step cache を null に戻し、 resolveConfigs を
//   1 回だけ呼ぶ。 pose / 物理 state は触らない (= 最初の evaluateSample が 0 から初期化)
// - evaluateSample = capturePose → (replay 時のみ basePose(0) + resetAllToRest) →
//   各 sub-step で basePose + stepAndApplyOrdered → restorePose → updateMatrixWorld →
//   applyOnlyOrdered の順を保証する。 例外時は restorePose / updateMatrixWorld を通した後
//   step cache を null にして再 throw (= 次回が必ず 0 replay になる)。 例外時は
//   applyOnlyOrdered を呼ばない。 sub-step と restorePose が両方 throw した場合は
//   sub-step 由来の例外を伝播させる (= 原因に近い方。 restore 失敗は警告に落とす)
// - applyWithoutAdvance = state を進めずに描画だけ更新する (= ops.applyOnlyOrdered)。
//   session 未開始 / 初回評価前の呼び出しは契約違反として Error を throw する
// - endAnimation = context / evaluator / step cache を破棄。 scene pose は変更しない
// - isEvaluating = evaluateSample 実行中のみ true。 export hook からの再入を弾く口
export class SpringRuntime<C extends AnimationContext, P> {
	private readonly ops: SpringRuntimeOps<C, P>
	private context: C | null = null
	private evaluateBasePose: BasePoseEvaluator<C> | null = null
	private stepIndex: number | null = null
	private evaluating = false

	constructor(ops: SpringRuntimeOps<C, P>) {
		this.ops = ops
	}

	get currentStepIndex(): number | null {
		return this.stepIndex
	}

	get isEvaluating(): boolean {
		return this.evaluating
	}

	beginAnimation(context: C, evaluateBasePose: BasePoseEvaluator<C>): void {
		this.context = context
		this.evaluateBasePose = evaluateBasePose
		this.stepIndex = null
		this.ops.resolveConfigs(context)
	}

	evaluateSample(sampleTimeSeconds: number): EvaluationResult {
		const context = this.context
		const evaluateBasePose = this.evaluateBasePose
		if (context === null || evaluateBasePose === null) {
			throw new Error('SpringRuntime.evaluateSample: session not started')
		}
		// 秒 → step の変換は timeToStepIndex で 1 回だけ (= 以降の分岐はすべて整数比較)
		const target = timeToStepIndex(sampleTimeSeconds)
		let mode: EvaluationMode
		if (this.stepIndex === null || target < this.stepIndex ||
			target - this.stepIndex > FAST_FORWARD_STEP_THRESHOLD) {
			// 初回 / 逆行 / 31 step 以上の前進 = 0 から replay
			mode = 'replay'
		} else if (target > this.stepIndex) {
			// 1〜30 step の前進 = cache から advance
			mode = 'advance'
		} else {
			mode = 'same-step'
		}

		let substepCount = 0
		this.evaluating = true
		try {
			const snapshot = this.ops.capturePose()
			// 例外を変数で持ち回る (= finally 内の throw で元例外が上書きされるのを防ぐ)。
			// 伝播は sub-step 由来の例外を優先 (= 原因に近い方)。
			let pendingError: unknown = null
			let hasPendingError = false
			try {
				if (mode === 'replay') {
					evaluateBasePose(0, context)
					this.ops.resetAllToRest(context)
					this.stepIndex = 0
				}
				while (this.stepIndex !== null && this.stepIndex < target) {
					const next = this.stepIndex + 1
					evaluateBasePose(stepIndexToTime(next), context)
					this.ops.stepAndApplyOrdered(FIXED_DT_SECONDS, context)
					this.stepIndex = next
					substepCount++
				}
			} catch (e) {
				pendingError = e
				hasPendingError = true
			} finally {
				try {
					this.ops.restorePose(snapshot)
				} catch (restoreError) {
					// 元の例外がある場合はそちらを優先する (= 原因に近い方を伝播させる)。
					// restore 失敗は握り潰さず警告に落とす。
					if (!hasPendingError) {
						pendingError = restoreError
						hasPendingError = true
					} else {
						console.warn('[spring_bone] restorePose failed while another error was pending', restoreError)
					}
				} finally {
					// restore が失敗しても matrix 更新は必ず通す
					this.ops.updateMatrixWorld()
				}
			}
			if (hasPendingError) {
				// 次回の評価が必ず 0 replay になるよう step cache を破棄してから再 throw
				this.stepIndex = null
				throw pendingError
			}
			this.ops.applyOnlyOrdered(context)
			const stepIndex = this.stepIndex as number
			return {
				stepIndex,
				timeSeconds: stepIndexToTime(stepIndex),
				substepCount,
				mode,
			}
		} catch (e) {
			// 次回の評価が必ず 0 replay になるよう step cache を破棄してから再 throw
			this.stepIndex = null
			throw e
		} finally {
			this.evaluating = false
		}
	}

	applyWithoutAdvance(): void {
		if (this.context === null || this.stepIndex === null) {
			throw new Error('SpringRuntime.applyWithoutAdvance: session not started or not evaluated yet')
		}
		this.ops.applyOnlyOrdered(this.context)
	}

	endAnimation(): void {
		this.context = null
		this.evaluateBasePose = null
		this.stepIndex = null
	}
}
