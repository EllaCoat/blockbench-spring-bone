// 物理の時刻管理。 時刻の正本は 1/60 秒の整数 step で、 結果は「step 0 から目標の step まで進めた姿勢」 だけで決まる
// (= scrub の速さや順序に依らない)。 前進が短ければ前回の state から続け、 戻ったり大きく飛んだりしたら step 0 からやり直す。
// Blockbench には依存せず、 scene への作用は ops に任せる。
import { restWindowWeight, type RestWindow } from './restWindow'

export const STEPS_PER_SECOND = 60
export const FIXED_DT_SECONDS = 1 / STEPS_PER_SECOND
// これより長い前進は step 0 からやり直す (= scrub の大きな飛び)。
export const MAX_ADVANCE_STEPS = 30

// 秒 → step。 1/60 格子の点は浮動小数で数 ULP ずれる (2.05 * 60 = 122.99999999999999) ので、
// ULP 幅の内なら最寄りの整数、 外なら切り捨て。 固定の epsilon は格子の少し手前を次の step へ繰り上げてしまう。
export function timeToStepIndex(timeSeconds: number): number {
	if (!Number.isFinite(timeSeconds)) throw new RangeError(`timeToStepIndex: non-finite time ${timeSeconds}`)
	if (timeSeconds <= 0) return 0
	const scaled = timeSeconds * STEPS_PER_SECOND
	const nearest = Math.round(scaled)
	const tolerance = Math.max(Number.EPSILON * 4, Math.abs(scaled) * Number.EPSILON * 4)
	const result = Math.abs(scaled - nearest) <= tolerance ? nearest : Math.floor(scaled)
	if (!Number.isSafeInteger(result)) throw new RangeError(`timeToStepIndex: ${timeSeconds}s is out of the step range`)
	return result
}

export function stepIndexToTime(stepIndex: number): number {
	return stepIndex / STEPS_PER_SECOND
}

export interface RuntimeContext {
	// 無ければ減衰しない (= 選択中の animation が無く、 終わりが 1 つに決まらない preview)。
	restWindow?: RestWindow
}

export interface RuntimeOps<C, P> {
	// 物理パラメータと有効な bone を context から決める。
	resolveConfigs(context: C): void
	// 時刻の基底ポーズ (= keyframe だけの姿勢) を scene に当てる。
	basePose(timeSeconds: number, context: C): void
	capturePose(): P
	// 控えた姿勢へ戻し、 world 行列も更新する。
	restorePose(snapshot: P): void
	resetAllToRest(): void
	stepAndApply(dtSeconds: number, weight: number): void
	applyOnly(weight: number): void
}

export type EvaluationMode = 'replay' | 'advance' | 'same-step'

export class SpringRuntime<C extends RuntimeContext, P> {
	private context: C | null = null
	private stepIndex: number | null = null
	private evaluating = false

	constructor(private readonly ops: RuntimeOps<C, P>) {}

	get isEvaluating(): boolean {
		return this.evaluating
	}

	get currentStepIndex(): number | null {
		return this.stepIndex
	}

	begin(context: C): void {
		this.end()
		this.ops.resolveConfigs(context)
		this.context = context
	}

	end(): void {
		this.context = null
		this.stepIndex = null
	}

	evaluateSample(timeSeconds: number): EvaluationMode {
		return this.evaluateStep(timeToStepIndex(timeSeconds))
	}

	// 呼ぶ前に scene には目標の時刻の基底ポーズが当たっている前提。 sub-step で姿勢を書き換えた後、
	// その姿勢へ戻してから差分だけを載せ直す。
	evaluateStep(target: number): EvaluationMode {
		const context = this.context
		if (context === null) throw new Error('SpringRuntime: no animation has begun')
		if (!Number.isSafeInteger(target) || target < 0) throw new RangeError(`SpringRuntime: step must be a non-negative integer, got ${target}`)
		const from = this.stepIndex
		const mode: EvaluationMode = from === null || target < from || target - from > MAX_ADVANCE_STEPS ? 'replay' : target > from ? 'advance' : 'same-step'

		this.evaluating = true
		const snapshot = this.ops.capturePose()
		let failed = false
		try {
			if (mode === 'replay') {
				this.ops.basePose(0, context)
				this.ops.resetAllToRest()
				this.stepIndex = 0
			}
			while (this.stepIndex! < target) {
				const next = this.stepIndex! + 1
				this.ops.basePose(stepIndexToTime(next), context)
				this.ops.stepAndApply(FIXED_DT_SECONDS, this.weightAt(next, context))
				this.stepIndex = next
			}
		} catch (error) {
			failed = true
			this.stepIndex = null
			throw error
		} finally {
			try {
				this.ops.restorePose(snapshot)
			} catch (error) {
				// 先に起きた例外の方が原因に近いので、 そちらを伝える。
				if (failed) console.warn('[spring_bone] restoring the pose failed after another error', error)
				else {
					this.stepIndex = null
					throw error
				}
			} finally {
				this.evaluating = false
			}
		}
		this.ops.applyOnly(this.weightAt(target, context))
		return mode
	}

	private weightAt(stepIndex: number, context: C): number {
		return context.restWindow ? restWindowWeight(stepIndex, context.restWindow) : 1
	}
}
