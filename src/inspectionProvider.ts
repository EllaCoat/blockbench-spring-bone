// AMP-2S の Spring pose provider。Blockbench 依存の scene 操作は host へ注入し、
// 契約・事前検査・transaction・結果の正規化をこの module に閉じる。

import {
	FAST_FORWARD_STEP_THRESHOLD,
	stepIndexFromFrame,
} from './springRuntime'

export const INSPECTION_API_VERSION = 1 as const
export const INSPECTION_PROVIDER_ID = 'spring_bone' as const

export const INSPECTION_LIMITS = Object.freeze({
	max_frames_per_request: 64,
	max_nodes_per_request: 32,
	max_pose_samples_per_request: 512,
	max_total_substeps_per_request: 3600,
})

export type InspectionRuntimeOwner = 'none' | 'aj_export' | 'bake' | 'inspection'
export type InspectionMode = 'simulated' | 'baked_keyframes' | 'no_active_spring'
export type LoadProvenance = 'complete' | 'unverified_late_enable'

export function isInspectionFaultedForGeneration(
	fault: { generation: unknown } | null,
	generation: unknown,
): boolean {
	return fault !== null && Object.is(fault.generation, generation)
}

export interface ProviderError {
	code: string
	message: string
	details?: Record<string, unknown>
}

export type ProviderResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: ProviderError }

export interface SpringBoneInspectionInputV1 {
	uuid: string
	parent_uuid: string | null
	state: 'enabled' | 'disabled'
	enabled: boolean
	drag: number
	stiffness: number
	gravity: number
	rest_length: number
	rest_direction: [number, number, number]
	override: Record<string, unknown> | null
}

export interface SpringBakedMetadataV1 {
	is_baked: boolean
	baked_from: string | null
	param_hash: string | null
	source_hash: string | null
	version: number | null
}

export interface SpringEvaluationTimingV1 {
	source_fps: 20
	simulation_fps: 60
	substeps_per_frame: 3
	animation_length_seconds: number
	render_sample_count: number
	loop_mode: string
	loop_delay_frames: number
	rest_fade_frames: number
	displayed_final_frame: number
	resolved_fade_frames: number
}

export interface SpringEvaluationInputV1 {
	animation_uuid: string
	schema_version: number | null
	rest_fade_frames: number
	baked: SpringBakedMetadataV1
	spring_bones: SpringBoneInspectionInputV1[]
	timing: SpringEvaluationTimingV1
	rest_window: {
		requested_fade_frames: number
		displayed_final_frame: number
		resolved_fade_frames: number
	}
	evaluation_basis: 'aj_export_single_animation'
	load_provenance: LoadProvenance
	project_uuid: string | null
	provider_id: typeof INSPECTION_PROVIDER_ID
	provider_api_version: typeof INSPECTION_API_VERSION
	provider_version: string
	simulation_version: string
}

export interface SpringPoseSampleV1 {
	frame_index: number
	node_uuid: string
	time_seconds: number
	step_index: number
	local_quaternion: { x: number; y: number; z: number; w: number }
	matrix_world: number[]
	mode: InspectionMode
}

export interface SpringPoseBatchV1 {
	animation_uuid: string
	evaluation_basis: 'aj_export_single_animation'
	mode: InspectionMode
	frame_indices: number[]
	node_uuids: string[]
	samples: SpringPoseSampleV1[]
	evaluation_input: SpringEvaluationInputV1
}

export interface InspectionPoseRead {
	local_quaternion: { x: number; y: number; z: number; w: number }
	matrix_world: readonly number[]
}

export interface InspectionHost<Animation = unknown, State = unknown> {
	readonly provider_version: string
	readonly simulation_version: string

	getProjectGeneration(): unknown
	getProjectUuid(): string | null
	getAnimation(animationUuid: string): Animation | null
	getEvaluationInput(animation: Animation): SpringEvaluationInputV1
	getNodeUuids(): readonly string[]
	getMode(animation: Animation, input: SpringEvaluationInputV1): InspectionMode
	isModeSupported?(animation: Animation): boolean

	getRuntimeOwner(): InspectionRuntimeOwner
	getRuntimeEvaluating(): boolean
	acquireRuntimeOwner(owner: 'inspection'): boolean
	releaseRuntimeOwner(owner: 'inspection'): void
	isFaulted(generation: unknown): boolean
	latchFault(generation: unknown, reason: unknown): void

	captureState(): State
	restoreState(state: State): void
	verifyState(state: State): boolean
	suspendPreview(): void
	resumePreview(): void
	refreshPreview(): void
	suppressEffects(animation: Animation): () => void
	beginEvaluation(animation: Animation): void
	evaluateFrame(animation: Animation, frameIndex: number, stepIndex: number): void
	readPose(nodeUuid: string): InspectionPoseRead | null
	endEvaluation(): void

	// Optional because ordinary synchronous evaluation has no asynchronous writer. Tests and
	// host adapters can use it to detect a project/source mutation during the transaction.
	isInputCurrent?(animation: Animation, input: SpringEvaluationInputV1): boolean
}

export interface SpringBoneInspectionApiV1 {
	readonly version: typeof INSPECTION_API_VERSION
	readonly provider_id: typeof INSPECTION_PROVIDER_ID
	readonly provider_version: string
	readonly capabilities: { readonly evaluate_pose_batch: 1 }
	readonly limits: typeof INSPECTION_LIMITS
	inspectAnimation(animationUuid: string): ProviderResult<SpringEvaluationInputV1>
	evaluatePoseBatch(request: unknown): ProviderResult<SpringPoseBatchV1>
}

function safeString(value: unknown): string {
	try {
		if (value instanceof Error) return value.message
		return String(value)
	} catch {
		return 'unknown provider failure'
	}
}

function errorResult(code: string, message: string, details?: Record<string, unknown>): ProviderResult<never> {
	return { ok: false, error: details === undefined ? { code, message } : { code, message, details } }
}

function caughtError(error: unknown, fallbackCode = 'EVALUATION_FAILED'): ProviderResult<never> {
	const candidate = error as { code?: unknown; message?: unknown } | null
	const code = typeof candidate?.code === 'string' && candidate.code.length > 0
		? candidate.code
		: fallbackCode
	const message = typeof candidate?.message === 'string' && candidate.message.length > 0
		? candidate.message
		: safeString(error)
	return errorResult(code, message)
}

function isRestoreFailure(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === 'EVALUATION_RESTORE_FAILED'
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validateUniqueNumbers(values: unknown, label: string): ProviderResult<number[]> {
	if (!Array.isArray(values) || values.length === 0) {
		return errorResult('EVALUATION_INVALID_REQUEST', `${label} must be a non-empty array`)
	}
	const out = values.slice()
	const seen = new Set<number>()
	for (const value of out) {
		if (!isSafeNonNegativeInteger(value)) {
			return errorResult('EVALUATION_INVALID_REQUEST', `${label} must contain non-negative safe integers`)
		}
		if (seen.has(value)) {
			return errorResult('EVALUATION_INVALID_REQUEST', `${label} must not contain duplicates`)
		}
		seen.add(value)
	}
	out.sort((a, b) => a - b)
	return { ok: true, data: out }
}

function validateUniqueUuids(values: unknown): ProviderResult<string[]> {
	if (!Array.isArray(values) || values.length === 0) {
		return errorResult('EVALUATION_INVALID_REQUEST', 'node_uuids must be a non-empty array')
	}
	const out = values.slice()
	const seen = new Set<string>()
	for (const value of out) {
		if (typeof value !== 'string' || value.length === 0) {
			return errorResult('EVALUATION_INVALID_REQUEST', 'node_uuids must contain non-empty UUID strings')
		}
		if (seen.has(value)) {
			return errorResult('EVALUATION_INVALID_REQUEST', 'node_uuids must not contain duplicates')
		}
		seen.add(value)
	}
	out.sort()
	return { ok: true, data: out }
}

function preflightSubsteps(frameIndices: readonly number[]): ProviderResult<number> {
	let previous: number | null = null
	let total = 0
	for (const frameIndex of frameIndices) {
		const stepIndex = stepIndexFromFrame(frameIndex)
		const cost = previous === null || stepIndex < previous || stepIndex - previous > FAST_FORWARD_STEP_THRESHOLD
			? stepIndex
			: stepIndex - previous
		total += cost
		if (total > INSPECTION_LIMITS.max_total_substeps_per_request) {
			return errorResult(
				'EVALUATION_LIMIT_EXCEEDED',
				`total substeps exceed ${INSPECTION_LIMITS.max_total_substeps_per_request}`,
				{ limit: INSPECTION_LIMITS.max_total_substeps_per_request, total_substeps: total },
			)
		}
		previous = stepIndex
	}
	return { ok: true, data: total }
}

function validateRequest(request: unknown): ProviderResult<{
	animation_uuid: string
	frame_indices: number[]
	node_uuids: string[]
}> {
	if (typeof request !== 'object' || request === null || Array.isArray(request)) {
		return errorResult('EVALUATION_INVALID_REQUEST', 'request must be an object')
	}
	const raw = request as Record<string, unknown>
	if (raw.evaluation_basis !== 'aj_export_single_animation') {
		return errorResult('EVALUATION_INVALID_REQUEST', 'evaluation_basis must be aj_export_single_animation')
	}
	if (typeof raw.animation_uuid !== 'string' || raw.animation_uuid.length === 0) {
		return errorResult('EVALUATION_INVALID_REQUEST', 'animation_uuid must be a non-empty string')
	}
	const frames = validateUniqueNumbers(raw.frame_indices, 'frame_indices')
	if (!frames.ok) return frames
	const nodes = validateUniqueUuids(raw.node_uuids)
	if (!nodes.ok) return nodes
	if (frames.data.length > INSPECTION_LIMITS.max_frames_per_request) {
		return errorResult('EVALUATION_LIMIT_EXCEEDED', `frame count exceeds ${INSPECTION_LIMITS.max_frames_per_request}`)
	}
	if (nodes.data.length > INSPECTION_LIMITS.max_nodes_per_request) {
		return errorResult('EVALUATION_LIMIT_EXCEEDED', `node count exceeds ${INSPECTION_LIMITS.max_nodes_per_request}`)
	}
	const sampleCount = frames.data.length * nodes.data.length
	if (sampleCount > INSPECTION_LIMITS.max_pose_samples_per_request) {
		return errorResult('EVALUATION_LIMIT_EXCEEDED', `pose sample count exceeds ${INSPECTION_LIMITS.max_pose_samples_per_request}`)
	}
	return { ok: true, data: {
		animation_uuid: raw.animation_uuid,
		frame_indices: frames.data,
		node_uuids: nodes.data,
	} }
}

function runCleanup(cleanups: Array<() => void>): unknown[] {
	const failures: unknown[] = []
	for (let i = cleanups.length - 1; i >= 0; i--) {
		try {
			cleanups[i]()
		} catch (error) {
			failures.push(error)
		}
	}
	return failures
}

export function createSpringBoneInspectionApi<Animation = unknown, State = unknown>(
	host: InspectionHost<Animation, State>,
): SpringBoneInspectionApiV1 {
	const capabilities = Object.freeze({ evaluate_pose_batch: 1 as const })

	const inspectAnimation = (animationUuid: string): ProviderResult<SpringEvaluationInputV1> => {
		try {
			if (typeof animationUuid !== 'string' || animationUuid.length === 0) {
				return errorResult('EVALUATION_INVALID_REQUEST', 'animationUuid must be a non-empty string')
			}
			const animation = host.getAnimation(animationUuid)
			if (animation === null) {
				return errorResult('EVALUATION_TARGET_NOT_FOUND', `animation ${animationUuid} was not found`)
			}
			const input = host.getEvaluationInput(animation)
			if (input.animation_uuid !== animationUuid) {
				return errorResult('EVALUATION_INPUT_STALE', 'provider returned an animation input for a different UUID')
			}
			return { ok: true, data: input }
		} catch (error) {
			return caughtError(error, 'EVALUATION_STATE_UNAVAILABLE')
		}
	}

	const evaluatePoseBatch = (request: unknown): ProviderResult<SpringPoseBatchV1> => {
		let validated: ProviderResult<{
			animation_uuid: string
			frame_indices: number[]
			node_uuids: string[]
		}>
		try {
			validated = validateRequest(request)
		} catch (error) {
			return caughtError(error, 'EVALUATION_INVALID_REQUEST')
		}
		if (!validated.ok) return validated
		let generation: unknown
		let animation: Animation | null = null
		let input: SpringEvaluationInputV1
		let mode: InspectionMode
		try {
			generation = host.getProjectGeneration()
			if (host.isFaulted(generation)) {
				return errorResult(
					'EVALUATION_RESTORE_FAILED',
					'provider is faulted for the current project generation; do not save and reopen the project',
				)
			}
			if (host.getRuntimeOwner() !== 'none' || host.getRuntimeEvaluating()) {
				return errorResult('EVALUATION_RUNTIME_BUSY', 'spring runtime is busy')
			}
			animation = host.getAnimation(validated.data.animation_uuid)
			if (animation === null) {
				return errorResult('EVALUATION_TARGET_NOT_FOUND', `animation ${validated.data.animation_uuid} was not found`)
			}
			input = host.getEvaluationInput(animation)
			if (host.isModeSupported && !host.isModeSupported(animation)) {
				return errorResult('EVALUATION_MODE_UNSUPPORTED', 'current Blockbench mode cannot run deterministic evaluation')
			}
			if (input.load_provenance !== 'complete') {
				return errorResult('EVALUATION_STATE_UNAVAILABLE', 'project load provenance is unverified; reopen the project with Spring enabled')
			}
			const renderSampleCount = input.timing.render_sample_count
			for (const frameIndex of validated.data.frame_indices) {
				if (frameIndex >= renderSampleCount) {
					return errorResult('EVALUATION_FRAME_OUT_OF_RANGE', `frame ${frameIndex} is outside render sample range`, {
						render_sample_count: renderSampleCount,
					})
				}
			}
			const availableNodes = new Set(host.getNodeUuids())
			for (const nodeUuid of validated.data.node_uuids) {
				if (!availableNodes.has(nodeUuid)) {
					return errorResult('EVALUATION_TARGET_NOT_FOUND', `node ${nodeUuid} was not found`)
				}
			}
			const cost = preflightSubsteps(validated.data.frame_indices)
			if (!cost.ok) return cost
			mode = host.getMode(animation, input)
		} catch (error) {
			return caughtError(error, 'EVALUATION_STATE_UNAVAILABLE')
		}

		const samples: SpringPoseSampleV1[] = []
		let releaseOwner: (() => void) | null = null
		let restoreEffects: (() => void) | null = null
		let resumePreview: (() => void) | null = null
		let refreshPreview: (() => void) | null = null
		let endEvaluation: (() => void) | null = null
		let capturedState: State | null = null
		let restoreState: (() => void) | null = null
		let evaluationError: unknown = null
		let cleanupFailures: unknown[] = []
		let postconditionFailed = false
		try {
			if (!host.acquireRuntimeOwner('inspection')) {
				return errorResult('EVALUATION_RUNTIME_BUSY', 'spring runtime is busy')
			}
			releaseOwner = () => host.releaseRuntimeOwner('inspection')

			capturedState = host.captureState()
			restoreState = () => host.restoreState(capturedState as State)

			restoreEffects = host.suppressEffects(animation as Animation)

			host.suspendPreview()
			resumePreview = () => host.resumePreview()
			refreshPreview = () => host.refreshPreview()

			host.beginEvaluation(animation as Animation)
			endEvaluation = () => host.endEvaluation()

			for (const frameIndex of validated.data.frame_indices) {
				const stepIndex = stepIndexFromFrame(frameIndex)
				host.evaluateFrame(animation as Animation, frameIndex, stepIndex)
				for (const nodeUuid of validated.data.node_uuids) {
					const pose = host.readPose(nodeUuid)
					if (pose === null) {
						throw Object.assign(new Error(`node ${nodeUuid} pose is unavailable`), {
							code: 'EVALUATION_TARGET_NOT_FOUND',
						})
					}
					const matrix = Array.from(pose.matrix_world)
					if (matrix.length !== 16 || !matrix.every(Number.isFinite)) {
						throw Object.assign(new Error(`node ${nodeUuid} matrix_world is invalid`), {
							code: 'EVALUATION_FAILED',
						})
					}
					const quaternion = pose.local_quaternion
					if (![quaternion.x, quaternion.y, quaternion.z, quaternion.w].every(Number.isFinite)) {
						throw Object.assign(new Error(`node ${nodeUuid} local quaternion is invalid`), {
							code: 'EVALUATION_FAILED',
						})
					}
					samples.push({
						frame_index: frameIndex,
						node_uuid: nodeUuid,
						time_seconds: frameIndex / 20,
						step_index: stepIndex,
						local_quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
						matrix_world: matrix,
						mode,
					})
				}
			}
		} catch (error) {
			evaluationError = error
		} finally {
			// Registration order is the inverse of the required restore order. Effects and
			// scene state are restored before the gate, owner, and final preview refresh.
			cleanupFailures = runCleanup(
				[refreshPreview, releaseOwner, resumePreview, restoreState, restoreEffects, endEvaluation]
					.filter((cleanup): cleanup is () => void => cleanup !== null),
			)
			if (capturedState !== null) {
				try {
					postconditionFailed = !host.verifyState(capturedState)
				} catch (error) {
					cleanupFailures.push(error)
					postconditionFailed = true
				}
			}
		}

		if (cleanupFailures.length > 0 || postconditionFailed || isRestoreFailure(evaluationError)) {
			try {
				host.latchFault(
					generation,
					cleanupFailures[0] ?? evaluationError ?? new Error('inspection postcondition failed'),
				)
			} catch {
				// Fault latching is best effort at the boundary; the restore failure still
				// invalidates this result even when the host cannot persist its latch.
			}
			return errorResult(
				'EVALUATION_RESTORE_FAILED',
				'inspection cleanup or postcondition verification failed; do not save and reopen the project',
			)
		}
		if (evaluationError !== null) return caughtError(evaluationError)
		try {
			if (!Object.is(generation, host.getProjectGeneration())) {
				return errorResult('EVALUATION_INPUT_STALE', 'project generation changed during evaluation')
			}
			if (host.isInputCurrent && !host.isInputCurrent(animation as Animation, input)) {
				return errorResult('EVALUATION_INPUT_STALE', 'evaluation input changed during evaluation')
			}
		} catch (error) {
			return caughtError(error, 'EVALUATION_INPUT_STALE')
		}
		return {
			ok: true,
			data: {
				animation_uuid: validated.data.animation_uuid,
				evaluation_basis: 'aj_export_single_animation',
				mode,
				frame_indices: validated.data.frame_indices,
				node_uuids: validated.data.node_uuids,
				samples,
				evaluation_input: input,
			},
		}
	}

	return Object.freeze({
		version: INSPECTION_API_VERSION,
		provider_id: INSPECTION_PROVIDER_ID,
		provider_version: host.provider_version,
		capabilities,
		limits: INSPECTION_LIMITS,
		inspectAnimation,
		evaluatePoseBatch,
	})
}

export interface InspectionGlobalTarget {
	BlockbenchSpringBoneInspection?: unknown
}

// onload ごとに新しい API object を公開し、onunload では自分の identity だけを除去する。
export function installInspectionGlobal(
	target: InspectionGlobalTarget,
	api: SpringBoneInspectionApiV1,
): () => void {
	target.BlockbenchSpringBoneInspection = api
	return (): void => {
		if (target.BlockbenchSpringBoneInspection === api) {
			delete target.BlockbenchSpringBoneInspection
		}
	}
}
