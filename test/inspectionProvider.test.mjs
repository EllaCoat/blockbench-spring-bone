import assert from 'node:assert/strict'
import test from 'node:test'

const {
	INSPECTION_LIMITS,
	createSpringBoneInspectionApi,
	isInspectionFaultedForGeneration,
	installInspectionGlobal,
} = await import('../dist-test/inspectionProvider.mjs')
const {
	createAjSingleAnimationEvaluator,
	createInspectionProjectLifecycle,
	evaluateInspectionFrame,
	restoreSelectionInPlace,
	suppressInspectionEffects,
} = await import('../dist-test/inspectionAdapter.mjs')
const { SpringRuntime } = await import('../dist-test/springRuntime.mjs')

const input = (provenance = 'complete') => ({
	animation_uuid: 'anim',
	schema_version: 1,
	rest_fade_frames: 4,
	baked: { is_baked: false, baked_from: null, param_hash: null, source_hash: null, version: null },
	spring_bones: [{
		uuid: 'bone-a', parent_uuid: null, state: 'enabled', enabled: true,
		drag: 0.05, stiffness: 1, gravity: 0, rest_length: 16,
		rest_direction: [0, 1, 0], override: null,
	}],
	timing: {
		source_fps: 20, simulation_fps: 60, substeps_per_frame: 3,
		animation_length_seconds: 10, render_sample_count: 201,
		loop_mode: 'once', loop_delay_frames: 0, rest_fade_frames: 4,
		displayed_final_frame: 200, resolved_fade_frames: 4,
	},
	rest_window: { requested_fade_frames: 4, displayed_final_frame: 200, resolved_fade_frames: 4 },
	evaluation_basis: 'aj_export_single_animation',
	load_provenance: provenance,
	project_uuid: 'project', provider_id: 'spring_bone', provider_api_version: 1,
	provider_version: '0.0.17', simulation_version: 'spring-runtime-v1',
})

function makeHost({
	provenance = 'complete',
	mode = 'simulated',
	owner = 'none',
	fail = null,
	inputFactory = () => input(provenance),
	} = {}) {
	const calls = []
	let currentOwner = owner
	let faulted = false
	let generation = 1
	const animation = { uuid: 'anim' }
	const host = {
		provider_version: '0.0.17',
		simulation_version: 'spring-runtime-v1',
		getProjectGeneration: () => generation,
		getProjectUuid: () => 'project',
		getAnimation: (uuid) => uuid === 'anim' ? animation : null,
		getEvaluationInput: inputFactory,
		getNodeUuids: () => ['node-b', 'node-a'],
		getMode: () => mode,
		isModeSupported: () => true,
		getRuntimeOwner: () => currentOwner,
		getRuntimeEvaluating: () => false,
		acquireRuntimeOwner: () => {
			if (currentOwner !== 'none') return false
			currentOwner = 'inspection'
			calls.push('acquire')
			return true
		},
		releaseRuntimeOwner: () => {
			calls.push('release')
			currentOwner = 'none'
			if (fail === 'release') throw new Error('release')
		},
		isFaulted: () => faulted,
		latchFault: () => { faulted = true; calls.push('fault') },
		captureState: () => { calls.push('capture'); return { marker: 'before' } },
		restoreState: () => { calls.push('restore'); if (fail === 'restore') throw new Error('restore') },
		verifyState: () => { calls.push('verify'); return fail !== 'verify' },
		suspendPreview: () => { calls.push('suspend'); if (fail === 'suspend') throw new Error('suspend') },
		resumePreview: () => { calls.push('resume'); if (fail === 'resume') throw new Error('resume') },
		refreshPreview: () => { calls.push('refresh'); if (fail === 'refresh') throw new Error('refresh') },
		suppressEffects: () => { calls.push('suppress'); return () => { calls.push('effects-restore'); if (fail === 'effects') throw new Error('effects') } },
		beginEvaluation: () => { calls.push('begin'); if (fail === 'begin') throw new Error('begin') },
		evaluateFrame: (_animation, frame, step) => { calls.push(['frame', frame, step]); if (fail === 'evaluate') throw new Error('evaluate') },
		readPose: (uuid) => {
			if (fail === 'read') throw new Error('read')
			return { local_quaternion: { x: 0, y: 0, z: 0, w: 1 }, matrix_world: Array.from({ length: 16 }, (_, i) => i === 0 || i === 5 || i === 10 || i === 15 ? 1 : 0) }
		},
		endEvaluation: () => { calls.push('end'); if (fail === 'end') throw new Error('end') },
		isInputCurrent: () => true,
	}
	return { host, calls, get owner() { return currentOwner }, get faulted() { return faulted }, set generation(value) { generation = value } }
}

function apiFor(options) {
	const fixture = makeHost(options)
	return { fixture, api: createSpringBoneInspectionApi(fixture.host) }
}

test('fault latch is fail-closed only for its project generation', () => {
	const fault = { generation: 7 }
	assert.equal(isInspectionFaultedForGeneration(fault, 7), true)
	assert.equal(isInspectionFaultedForGeneration(fault, 8), false)
	assert.equal(isInspectionFaultedForGeneration(null, 7), false)
})

test('AJ single-animation adapter evaluates the canonical base pose twice without stack or effects', () => {
	const calls = []
	const displayArguments = []
	const animatedA = { id: 'a', constructor: { animator: {} } }
	const staticNode = { id: 'static', constructor: {} }
	const animatedB = { id: 'b', constructor: { animator: {} } }
	const animation = {
		getBoneAnimator(node) {
			calls.push(['getBoneAnimator', node.id])
			return {
				displayFrame(...args) {
					displayArguments.push(args)
					calls.push(['displayFrame', node.id])
				},
			}
		},
		animators: { effects: { displayFrame() { throw new Error('effects must not run') } } },
	}
	const stackAnimations = () => { throw new Error('stackAnimations must not run') }
	const timeline = { time: 9 }
	const evaluator = createAjSingleAnimationEvaluator({
		timeline,
		animator: {
			showDefaultPose(reduced) { calls.push(['showDefaultPose', reduced]) },
			resetLastValues() { calls.push('resetLastValues') },
			stackAnimations,
		},
		canvas: { scene: { updateMatrixWorld(force) { calls.push(['updateMatrixWorld', force]) } } },
		getAnimatableNodes: () => [animatedA, staticNode, animatedB],
	})

	evaluator(animation, 1.5)
	assert.equal(timeline.time, 9)
	assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === 'showDefaultPose'), [
		['showDefaultPose', true], ['showDefaultPose', true],
	])
	assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === 'getBoneAnimator'), [
		['getBoneAnimator', 'a'], ['getBoneAnimator', 'b'],
		['getBoneAnimator', 'a'], ['getBoneAnimator', 'b'],
	])
	assert.deepEqual(displayArguments, [[], [], [], []])
	assert.equal(calls.filter((call) => call === 'resetLastValues').length, 6)
	assert.deepEqual(calls.filter((call) => Array.isArray(call) && call[0] === 'updateMatrixWorld'), [
		['updateMatrixWorld', true], ['updateMatrixWorld', true],
	])
})

test('inspection frame seam applies the requested base pose before SpringRuntime, including baked and inactive modes', () => {
	for (const [mode, springDelta] of [
		['simulated', 0.25],
		['baked_keyframes', 0],
		['no_active_spring', 0],
	]) {
		const scene = { pose: 900 }
		const baseTimes = []
		const runtime = new SpringRuntime({
			resolveConfigs() {},
			capturePose: () => scene.pose,
			restorePose: (snapshot) => { scene.pose = snapshot },
			updateMatrixWorld() {},
			resetAllToRest() { scene.pose = 0 },
			stepAndApplyOrdered: (_dt, _weight, context) => {
				if (context.mode === 'simulated') scene.pose += springDelta
			},
			applyOnlyOrdered: (_weight, context) => {
				if (context.mode === 'simulated') scene.pose += springDelta
			},
		})
		runtime.beginAnimation({ animation: null, mode }, (time) => {
			baseTimes.push(time)
			scene.pose = time
		})

		const result = evaluateInspectionFrame(runtime, (time) => {
			baseTimes.push(time)
			scene.pose = time
		}, 60)

		assert.equal(result.stepIndex, 60, mode)
		assert.equal(baseTimes[0], 1, mode)
		assert.equal(baseTimes.at(-1), 1, mode)
		assert.equal(scene.pose, 1 + springDelta, mode)
	}
})

test('project lifecycle keeps a fault across tab selection and clears it only on load or plugin reload', () => {
	const lifecycle = createInspectionProjectLifecycle()
	const firstProject = {}
	const secondProject = {}

	lifecycle.beginPluginLoad(firstProject)
	lifecycle.observeProject(firstProject, true)
	const firstGeneration = lifecycle.generation
	lifecycle.latchFault(firstGeneration, new Error('restore'))
	assert.equal(lifecycle.isFaulted(firstGeneration), true)

	// select_project must not make an unsafe scene evaluable again.
	lifecycle.observeProject(firstProject, false)
	assert.equal(lifecycle.isFaulted(lifecycle.generation), true)
	lifecycle.observeProject(secondProject, false)
	lifecycle.observeProject(firstProject, false)
	assert.equal(lifecycle.isFaulted(lifecycle.generation), true)

	// A full load/new-project event clears only the project being loaded.
	lifecycle.observeProject(secondProject, true)
	lifecycle.observeProject(firstProject, false)
	assert.equal(lifecycle.isFaulted(lifecycle.generation), true)
	lifecycle.observeProject(firstProject, true)
	assert.equal(lifecycle.loadObserved, true)
	assert.equal(lifecycle.fault, null)

	// Plugin reload starts a new generation and drops all old fault/provenance state.
	lifecycle.latchFault(lifecycle.generation, new Error('restore again'))
	lifecycle.beginPluginLoad(firstProject)
	assert.equal(lifecycle.fault, null)
	assert.equal(lifecycle.loadObserved, false)
})

test('project lifecycle treats Blockbench no-project sentinels as no active project', () => {
	for (const noProject of [undefined, 0]) {
		const lifecycle = createInspectionProjectLifecycle()

		lifecycle.beginPluginLoad(noProject)
		assert.equal(lifecycle.generation, 1)
		assert.equal(lifecycle.loadObserved, true)
		assert.equal(lifecycle.fault, null)

		lifecycle.observeProject(noProject, false)
		assert.equal(lifecycle.generation, 2)
		assert.equal(lifecycle.loadObserved, true)
		assert.equal(lifecycle.fault, null)
	}
})

test('effect suppression restores state and propagates restore and rollback failures', () => {
	const muted = { particle: false, sound: 'off' }
	const effects = { muted, last_displayed_time: 4 }
	const restore = suppressInspectionEffects({ animators: { effects } })
	assert.deepEqual(muted, { particle: true, sound: true })
	restore()
	assert.deepEqual(muted, { particle: false, sound: 'off' })
	assert.equal(effects.last_displayed_time, 4)

	let restorePhase = false
	const restoreFailureMuted = new Proxy({ particle: false }, {
		set(target, property, value) {
			if (restorePhase) throw new Error(`restore ${String(property)}`)
			return Reflect.set(target, property, value)
		},
	})
	const restoreFailure = suppressInspectionEffects({ animators: { effects: { muted: restoreFailureMuted, last_displayed_time: 0 } } })
	restorePhase = true
	assert.throws(restoreFailure, /restore particle/)

	let mutationPhase = 'suppress'
	const rollbackFailureMuted = new Proxy({ particle: false, sound: false }, {
		set(target, property, value) {
			if (mutationPhase === 'suppress' && property === 'sound') {
				mutationPhase = 'rollback'
				throw new Error('suppression')
			}
			if (mutationPhase === 'rollback' && property === 'particle') throw new Error('rollback')
			return Reflect.set(target, property, value)
		},
	})
	assert.throws(
		() => suppressInspectionEffects({ animators: { effects: { muted: rollbackFailureMuted, last_displayed_time: 0 } } }),
		(error) => error?.code === 'EVALUATION_RESTORE_FAILED' && /rollback/.test(error.cause?.message ?? ''),
	)
})

test('selection restoration mutates the host-owned array in place', () => {
	const first = {}
	const second = {}
	const selected = [first, second]
	const target = {}
	Object.defineProperty(target, 'selected', {
		configurable: true,
		get: () => selected,
		set: () => { throw new Error('Outliner.selected setter must not be used') },
	})

	restoreSelectionInPlace(target, [second])
	assert.equal(target.selected, selected)
	assert.deepEqual(selected, [second])
})

test('inspection API exposes V1 identity, four limits, and canonical frame/node order', () => {
	const { api, fixture } = apiFor()
	assert.equal(api.version, 1)
	assert.equal(api.provider_id, 'spring_bone')
	assert.deepEqual(api.capabilities, { evaluate_pose_batch: 1 })
	assert.deepEqual(api.limits, INSPECTION_LIMITS)
	const result = api.evaluatePoseBatch({
		animation_uuid: 'anim', evaluation_basis: 'aj_export_single_animation',
		frame_indices: [10, 0], node_uuids: ['node-b', 'node-a'],
	})
	assert.equal(result.ok, true)
	assert.deepEqual(result.data.frame_indices, [0, 10])
	assert.deepEqual(result.data.node_uuids, ['node-a', 'node-b'])
	assert.deepEqual(result.data.samples.map((sample) => [sample.frame_index, sample.node_uuid, sample.step_index]), [
		[0, 'node-a', 0], [0, 'node-b', 0], [10, 'node-a', 30], [10, 'node-b', 30],
	])
	assert.deepEqual(fixture.calls.filter((call) => Array.isArray(call)), [['frame', 0, 0], ['frame', 10, 30]])
	assert.deepEqual(fixture.calls.filter((call) => typeof call === 'string'), [
		'acquire', 'capture', 'suppress', 'suspend', 'begin', 'end', 'effects-restore', 'restore', 'resume', 'release', 'refresh', 'verify',
	])
})

test('inspection reports late-load provenance and refuses evaluation', () => {
	const { api } = apiFor({ provenance: 'unverified_late_enable' })
	assert.equal(api.inspectAnimation('anim').data.load_provenance, 'unverified_late_enable')
	const result = api.evaluatePoseBatch({ animation_uuid: 'anim', evaluation_basis: 'aj_export_single_animation', frame_indices: [0], node_uuids: ['node-a'] })
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'EVALUATION_STATE_UNAVAILABLE')
})

test('20 FPS frames map to exact 60 Hz steps and 30/31-step requests remain preflightable', () => {
	const { api, fixture } = apiFor()
	const result = api.evaluatePoseBatch({ animation_uuid: 'anim', evaluation_basis: 'aj_export_single_animation', frame_indices: [0, 10, 20], node_uuids: ['node-a'] })
	assert.equal(result.ok, true)
	assert.deepEqual(fixture.calls.filter((call) => Array.isArray(call)), [['frame', 0, 0], ['frame', 10, 30], ['frame', 20, 60]])
	assert.equal(result.data.samples[2].time_seconds, 1)
	const boundary = api.evaluatePoseBatch({ animation_uuid: 'anim', evaluation_basis: 'aj_export_single_animation', frame_indices: [0, 10, 21], node_uuids: ['node-a'] })
	assert.equal(boundary.ok, true)
})

test('all four limits reject before owner acquisition or scene mutation', () => {
	for (const [request, message] of [
		[{ frame_indices: Array.from({ length: 65 }, (_, i) => i), node_uuids: ['node-a'] }, 'frames'],
		[{ frame_indices: [0], node_uuids: Array.from({ length: 33 }, (_, i) => `node-${i}`) }, 'nodes'],
		[{ frame_indices: Array.from({ length: 64 }, (_, i) => i), node_uuids: Array.from({ length: 9 }, (_, i) => `node-${i}`) }, 'samples'],
		[{ frame_indices: [0, 1201], node_uuids: ['node-a'] }, 'substeps'],
	]) {
		const { api, fixture } = message === 'substeps'
			? apiFor({ inputFactory: () => ({ ...input(), timing: { ...input().timing, render_sample_count: 5000 } }) })
			: apiFor()
		const result = api.evaluatePoseBatch({ animation_uuid: 'anim', evaluation_basis: 'aj_export_single_animation', ...request })
		assert.equal(result.ok, false, message)
		assert.equal(result.error.code, 'EVALUATION_LIMIT_EXCEEDED', message)
		assert.equal(fixture.calls.length, 0, message)
	}
})

test('simulated, baked, and no-active-spring modes are returned without changing the contract', () => {
	for (const mode of ['simulated', 'baked_keyframes', 'no_active_spring']) {
		const { api } = apiFor({ mode })
		const result = api.evaluatePoseBatch({ animation_uuid: 'anim', evaluation_basis: 'aj_export_single_animation', frame_indices: [0], node_uuids: ['node-a'] })
		assert.equal(result.ok, true)
		assert.equal(result.data.mode, mode)
		assert.equal(result.data.samples[0].mode, mode)
	}
})

test('owner conflict and fault latch fail closed', () => {
	const request = { animation_uuid: 'anim', evaluation_basis: 'aj_export_single_animation', frame_indices: [0], node_uuids: ['node-a'] }
	for (const owner of ['preview', 'aj_export', 'bake', 'inspection']) {
		const busy = apiFor({ owner })
		assert.equal(busy.api.evaluatePoseBatch(request).error.code, 'EVALUATION_RUNTIME_BUSY', owner)
	}
	const failed = apiFor({ fail: 'restore' })
	const first = failed.api.evaluatePoseBatch(request)
	assert.equal(first.ok, false)
	assert.equal(first.error.code, 'EVALUATION_RESTORE_FAILED')
	assert.equal(failed.fixture.faulted, true)
	assert.equal(failed.fixture.owner, 'none')
	assert.equal(failed.api.evaluatePoseBatch(request).error.code, 'EVALUATION_RESTORE_FAILED')
})

test('effect suppression rollback failure faults the project generation', () => {
	const { api, fixture } = apiFor()
	fixture.host.suppressEffects = () => {
		throw Object.assign(new Error('effect rollback failed'), { code: 'EVALUATION_RESTORE_FAILED' })
	}
	const result = api.evaluatePoseBatch({
		animation_uuid: 'anim',
		evaluation_basis: 'aj_export_single_animation',
		frame_indices: [0],
		node_uuids: ['node-a'],
	})
	assert.equal(result.ok, false)
	assert.equal(result.error.code, 'EVALUATION_RESTORE_FAILED')
	assert.equal(fixture.faulted, true)
	assert.equal(fixture.owner, 'none')
})

test('cleanup continues after each injected failure and partial samples are discarded', () => {
	const request = { animation_uuid: 'anim', evaluation_basis: 'aj_export_single_animation', frame_indices: [0], node_uuids: ['node-a'] }
	for (const fail of ['end', 'resume', 'effects', 'restore', 'verify', 'release', 'refresh']) {
		const { api, fixture } = apiFor({ fail })
		const result = api.evaluatePoseBatch(request)
		assert.equal(result.ok, false, fail)
		assert.equal(result.error.code, 'EVALUATION_RESTORE_FAILED', fail)
		assert.equal(result.data, undefined, fail)
		assert.equal(fixture.owner, 'none', fail)
		assert.equal(fixture.faulted, true, fail)
		for (const cleanupCall of ['end', 'effects-restore', 'restore', 'resume', 'release', 'refresh', 'verify']) {
			assert.ok(fixture.calls.includes(cleanupCall), `${fail}: ${cleanupCall}`)
		}
	}
	const partial = apiFor({ fail: 'evaluate' })
	const result = partial.api.evaluatePoseBatch({ ...request, frame_indices: [0, 1] })
	assert.equal(result.ok, false)
	assert.equal(result.data, undefined)
})

test('reload cleanup removes only the identity it installed', () => {
	const target = {}
	const first = apiFor().api
	const second = apiFor().api
	const removeFirst = installInspectionGlobal(target, first)
	const removeSecond = installInspectionGlobal(target, second)
	removeFirst()
	assert.equal(target.BlockbenchSpringBoneInspection, second)
	removeSecond()
	assert.equal('BlockbenchSpringBoneInspection' in target, false)
})
