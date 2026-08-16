// Inspection の Blockbench adapter 境界。
// provider 本体はこの module の外側で scene/runtime の具体実装を注入して使う。

import { stepIndexToTime } from './springRuntime'
import type { InspectionHost } from './inspectionProvider'

export interface InspectionFrameRuntime<Result = unknown> {
	evaluateStepIndex(stepIndex: number): Result
}

/**
 * Inspection の requested frame を、現在の editor pose ではなく canonical base pose から評価する。
 * runtime 自体の replay / advance 判定は SpringRuntime に委譲し、ここではその入力 pose の境界だけを固定する。
 */
export function evaluateInspectionFrame<Result>(
	runtime: InspectionFrameRuntime<Result>,
	evaluateCanonicalBasePose: (timeSeconds: number) => void,
	stepIndex: number,
): Result {
	evaluateCanonicalBasePose(stepIndexToTime(stepIndex))
	return runtime.evaluateStepIndex(stepIndex)
}

export interface SingleAnimationEvaluatorDependencies {
	timeline?: { time?: number }
	animator: {
		showDefaultPose?(reduced?: boolean): void
		resetLastValues?(): void
	}
	canvas?: { scene?: { updateMatrixWorld?(force?: boolean): void } }
	getAnimatableNodes(): readonly unknown[]
}

/**
 * AJ animationRenderer の updatePreviewBase と同じ、effect/hook を通さない
 * animation 単体の keyframe pose evaluator。Spring inspection からはこの関数を
 * 1 時刻につき 2 回呼ぶ (IK のための AJ 側の契約)。
 */
export function createSingleAnimationEvaluator(
	dependencies: SingleAnimationEvaluatorDependencies,
): (animation: unknown, time: number) => void {
	return (animation, time): void => {
		const timeline = dependencies.timeline
		const savedTime = timeline?.time
		try {
			if (timeline) timeline.time = time
			dependencies.animator.showDefaultPose?.(true)
			for (const node of dependencies.getAnimatableNodes()) {
				if (!((node as { constructor?: { animator?: unknown } } | null)?.constructor?.animator)) continue
				dependencies.animator.resetLastValues?.()
				const animator = (animation as { getBoneAnimator?(value: unknown): { displayFrame?(): void } | null } | null)?.getBoneAnimator?.(node)
				animator?.displayFrame?.()
			}
			dependencies.animator.resetLastValues?.()
			dependencies.canvas?.scene?.updateMatrixWorld?.(true)
		} finally {
			if (timeline && savedTime !== undefined) timeline.time = savedTime
		}
	}
}

export function createAjSingleAnimationEvaluator(
	dependencies: SingleAnimationEvaluatorDependencies,
): (animation: unknown, time: number) => void {
	const evaluateBase = createSingleAnimationEvaluator(dependencies)
	return (animation, time): void => {
		evaluateBase(animation, time)
		evaluateBase(animation, time)
	}
}

/**
 * Blockbench の Outliner.selected は setter を持たないため、選択配列は identity を保ったまま
 * 復元する。通常の配列を受ける target なら同じ参照を mutation し、初期化前の host だけ
 * setter fallback を使う。
 */
export function restoreSelectionInPlace(
	target: { selected?: unknown[] | null },
	savedSelection: readonly unknown[],
): void {
	const current = target.selected
	if (Array.isArray(current)) {
		current.splice(0, current.length, ...savedSelection)
		return
	}
	target.selected = savedSelection.slice()
}

export type InspectionHostDependencies<Animation = unknown, State = unknown> = InspectionHost<Animation, State>

export function createInspectionHost<Animation = unknown, State = unknown>(
	dependencies: InspectionHostDependencies<Animation, State>,
): InspectionHost<Animation, State> {
	return { ...dependencies }
}

export interface InspectionFault {
	generation: number
	reason: unknown
}

export interface InspectionProjectLifecycle<Project extends object = object> {
	readonly generation: number
	readonly loadObserved: boolean
	readonly fault: InspectionFault | null
	beginPluginLoad(project: Project | null): void
	observeProject(project: Project | null, loadObserved: boolean): void
	latchFault(generation: number, reason: unknown): void
	isFaulted(generation: number): boolean
}

export function createInspectionProjectLifecycle<Project extends object = object>(
	initialGeneration = 0,
): InspectionProjectLifecycle<Project> {
	let generation = initialGeneration
	let currentProject: Project | null = null
	let loadObserved = false
	let currentFault: InspectionFault | null = null
	let generations = new WeakMap<Project, number>()
	let observedProjects = new WeakSet<Project>()
	let faults = new WeakMap<Project, InspectionFault>()

	const setCurrentProject = (project: Project | null): void => {
		currentProject = project
		loadObserved = project === null || observedProjects.has(project)
		currentFault = project === null ? null : faults.get(project) ?? null
	}

	return {
		get generation(): number { return generation },
		get loadObserved(): boolean { return loadObserved },
		get fault(): InspectionFault | null { return currentFault },
		beginPluginLoad(project): void {
			generation++
			generations = new WeakMap<Project, number>()
			observedProjects = new WeakSet<Project>()
			faults = new WeakMap<Project, InspectionFault>()
			if (project !== null) generations.set(project, generation)
			setCurrentProject(project)
		},
		observeProject(project, projectWasLoaded): void {
			if (project === null) {
				generation++
				setCurrentProject(null)
				return
			}
			if (projectWasLoaded) {
				generation++
				generations.set(project, generation)
				observedProjects.add(project)
				faults.delete(project)
			} else {
				const knownGeneration = generations.get(project)
				if (knownGeneration === undefined) {
					generation++
					generations.set(project, generation)
				} else {
					generation = knownGeneration
				}
			}
			setCurrentProject(project)
		},
		latchFault(faultGeneration, reason): void {
			if (faultGeneration !== generation) return
			const fault = { generation: faultGeneration, reason }
			currentFault = fault
			if (currentProject !== null) faults.set(currentProject, fault)
		},
		isFaulted(faultGeneration): boolean {
			return currentFault !== null && currentFault.generation === faultGeneration
		},
	}
}

interface EffectAnimatorState {
	muted: Record<string, unknown>
	last_displayed_time: unknown
}

function getEffectAnimatorState(animation: unknown): EffectAnimatorState | null {
	const effects = (animation as { animators?: { effects?: unknown } } | null)?.animators?.effects
	if (!effects || typeof effects !== 'object') return null
	const candidate = effects as { muted?: unknown; last_displayed_time?: unknown }
	if (!candidate.muted || typeof candidate.muted !== 'object' || Array.isArray(candidate.muted)) return null
	return {
		muted: candidate.muted as Record<string, unknown>,
		last_displayed_time: candidate.last_displayed_time,
	}
}

// Inspection 用。bake の既存 warn-and-continue semantics とは分離し、restore 失敗を呼び出し側へ戻す。
export function suppressInspectionEffects(animation: unknown): () => void {
	const effects = (animation as { animators?: { effects?: unknown } } | null)?.animators?.effects
	const state = getEffectAnimatorState(animation)
	if (state === null) return (): void => {}
	const savedMuted = { ...state.muted }
	const savedLastDisplayedTime = state.last_displayed_time
	const restoreState = (): void => {
		Object.assign(state.muted, savedMuted)
		;(effects as { last_displayed_time?: unknown }).last_displayed_time = savedLastDisplayedTime
	}
	try {
		for (const channel of Object.keys(state.muted)) state.muted[channel] = true
	} catch (error) {
		try {
			restoreState()
		} catch (restoreError) {
			throw Object.assign(new Error('inspection effect suppression rollback failed'), {
				code: 'EVALUATION_RESTORE_FAILED',
				cause: restoreError,
			})
		}
		throw error
	}
	return restoreState
}
