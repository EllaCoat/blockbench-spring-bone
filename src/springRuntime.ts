// 時刻写像の純粋関数群。 物理シムの時刻の正本を「浮動小数の秒」 から「整数 step 番号」
// に移行するため、 tick 側は必ず timeToStepIndex で格子化し、 物理 / applyPoseAt に渡す
// 時刻は stepIndexToTime で逆写像する (= 往路で ULP 丸めした格子点を復路で再現)。
export const STEPS_PER_SECOND = 60
export const FIXED_DT_SECONDS = 1 / STEPS_PER_SECOND
// 30 step (= 0.5 秒) ちょうどまでは cache advance、 31 step からは 0 replay に流す
// (= これ以上の前進は cache 経路が重くなる + scrub の大ジャンプ判定)。
export const FAST_FORWARD_STEP_THRESHOLD = 30

// export の frame 格子 (= 20 fps) と物理 sub-step (= 60 Hz) の比。 整数比なので
// 1 export frame = 3 sub-step に厳密対応する。
export const EXPORT_FRAMES_PER_SECOND = 20
export const SUBSTEPS_PER_EXPORT_FRAME = STEPS_PER_SECOND / EXPORT_FRAMES_PER_SECOND  // = 3

// 秒 → step 番号。 非 finite 値 (= NaN / Infinity) は RangeError、 0 以下は 0 へ clamp。
// 1/60 格子上の時刻は浮動小数誤差で最近傍整数から数 ULP ズレることがある
// (= 2.05 * 60 = 122.99999999999999) ため、 ULP 許容幅内なら最近傍整数、 それ以外は
// floor を返す。 固定 epsilon (= Math.floor(scaled + 1e-6) 等) は使わない : 格子の
// わずかに手前の時刻 (= k/60 - 1e-10) を 1 step 先へ切り上げてしまう実測あり
// (= 3600 ケース全件誤判定。 ULP 判定は 0 件)。
// 注意 : 累積加算で作られた時刻 (= t += 0.05 の繰り返し等) は 1/60 格子上の点にならない
// (= 60 回で 2.9999999999999973 → 179 と評価)。 これは tolerance を広げても根治しない
// (= 倍率 4〜64 の 20000 回累積で破れ件数が単調に減らない実測)。 export のように厳密な
// frame 対応が必要な経路ではこの関数を通さず stepIndexFromFrame を使うこと。
// 戻り値が safe integer を外れる大きさ (= 秒数が巨大で scaled が overflow) の場合も
// RangeError を throw する (= evaluateSample の sub-step ループが終了しなくなるのを防ぐ)。
export function timeToStepIndex(timeSeconds: number): number {
	if (!Number.isFinite(timeSeconds)) {
		throw new RangeError(`timeToStepIndex: non-finite time ${timeSeconds}`)
	}
	if (timeSeconds <= 0) return 0
	const scaled = timeSeconds * STEPS_PER_SECOND
	const nearest = Math.round(scaled)
	// scale 不変にするため絶対項と相対項の max を取る
	const tol = Math.max(Number.EPSILON * 4, Math.abs(scaled) * Number.EPSILON * 4)
	const result = Math.abs(scaled - nearest) <= tol ? nearest : Math.floor(scaled)
	if (!Number.isSafeInteger(result)) {
		throw new RangeError(`timeToStepIndex: ${timeSeconds}s is out of safe integer step range`)
	}
	return result
}

// step 番号 → 秒。 applyPoseAt 等へ渡す時刻は必ずこの関数経由にする。
export function stepIndexToTime(stepIndex: number): number {
	return stepIndex / STEPS_PER_SECOND
}

// export frame 番号 → step 番号。 浮動小数の秒を経由しないため、 累積誤差が原理的に
// 発生しない。 戻り値は evaluateStepIndex にそのまま渡せる (= 秒への逆変換も
// timeToStepIndex の再通過も不要)。 export driver (= Phase γ) はこちらを使い、
// timeToStepIndex は通さない。
export function stepIndexFromFrame(frameIndex: number): number {
	if (!Number.isSafeInteger(frameIndex)) {
		throw new RangeError(`stepIndexFromFrame: frameIndex must be a safe integer, got ${frameIndex}`)
	}
	if (frameIndex <= 0) return 0
	const result = frameIndex * SUBSTEPS_PER_EXPORT_FRAME
	// 積が safe integer を外れる巨大 frame も弾く (= evaluateStepIndex のループ上限を守る)
	if (!Number.isSafeInteger(result)) {
		throw new RangeError(`stepIndexFromFrame: frame ${frameIndex} is out of safe integer step range`)
	}
	return result
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
// session の流れ : beginAnimation → evaluateStepIndex (or evaluateSample) × N → endAnimation。
// - beginAnimation = 前 session を破棄してから resolveConfigs を 1 回呼び、 成功した時点で
//   session を確定する (= resolveConfigs が throw した場合は session 未開始のまま残る)。
//   pose / 物理 state は触らない (= 最初の評価が 0 から初期化)
// - evaluateStepIndex = 整数 step を直接受ける評価の本体。 capturePose →
//   (replay 時のみ basePose(0) + resetAllToRest) → 各 sub-step で basePose +
//   stepAndApplyOrdered → restorePose → updateMatrixWorld → applyOnlyOrdered の順を保証する。
//   例外時は restorePose / updateMatrixWorld を通した後 step cache を null にして再 throw
//   (= 次回が必ず 0 replay になる)。 例外時は applyOnlyOrdered を呼ばない。 例外が複数段で
//   発生した場合は最も原因に近いものを伝播させる (= 優先順位 sub-step > restorePose >
//   updateMatrixWorld、 後段の失敗は警告に落とす)
// - evaluateSample = 秒を受ける preview 用の薄いラッパー (= timeToStepIndex で格子化して
//   evaluateStepIndex に渡すだけ)
// - applyWithoutAdvance = state を進めずに描画だけ更新する (= ops.applyOnlyOrdered)。
//   session 未開始 / 初回評価前の呼び出しは契約違反として Error を throw する
// - endAnimation = context / evaluator / step cache を破棄。 scene pose は変更しない
// - isEvaluating = 評価 (= evaluateStepIndex / evaluateSample) 実行中のみ true。
//   export hook からの再入を弾く口
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
		// 先に旧 session を破棄する (= 失敗時に古い session が残らない)
		this.context = null
		this.evaluateBasePose = null
		this.stepIndex = null
		// resolveConfigs が成功してから session を確定させる (= 失敗時に半端な
		// context / evaluator が「開始済み」 として残らないようにする)
		this.ops.resolveConfigs(context)
		this.context = context
		this.evaluateBasePose = evaluateBasePose
	}

	// 秒を受ける評価 API (= preview 用の薄いラッパー)。
	// Blockbench の Timeline.time は可変デルタの累積で任意の float になるため、
	// preview はこちらで格子化する。 export driver は使わず evaluateStepIndex を直接呼ぶ。
	evaluateSample(sampleTimeSeconds: number): EvaluationResult {
		return this.evaluateStepIndex(timeToStepIndex(sampleTimeSeconds))
	}

	// 整数 step 番号を直接受ける評価 API (= 本体)。 export driver はこちらを使う。
	// stepIndexFromFrame(frameIndex) の戻り値をそのまま渡せば、 浮動小数の秒を一切経由しない。
	evaluateStepIndex(targetStepIndex: number): EvaluationResult {
		const context = this.context
		const evaluateBasePose = this.evaluateBasePose
		if (context === null || evaluateBasePose === null) {
			throw new Error('SpringRuntime.evaluateStepIndex: session not started')
		}
		if (!Number.isSafeInteger(targetStepIndex) || targetStepIndex < 0) {
			throw new RangeError(`SpringRuntime.evaluateStepIndex: target step must be a non-negative safe integer, got ${targetStepIndex}`)
		}
		const target = targetStepIndex
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
					// restore が失敗しても matrix 更新は必ず通す。 matrix 更新の失敗も
					// 同じく pendingError 経路に乗せる (= finally からの throw で元例外を
					// 上書きしない)。 優先順位は sub-step > restorePose > updateMatrixWorld。
					try {
						this.ops.updateMatrixWorld()
					} catch (updateError) {
						if (!hasPendingError) {
							pendingError = updateError
							hasPendingError = true
						} else {
							console.warn('[spring_bone] updateMatrixWorld failed while another error was pending', updateError)
						}
					}
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
