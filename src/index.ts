// blockbench-spring-bone — Blockbench plugin
// Spring bone physics simulation for hair / cloth / accessory bones.
// Verlet integration + spring + damper、 リアルタイム editor preview。
// AnimatedJava の export bake は Phase 5 で別経路を作る。

import { createState, resetState, step, type SpringConfig, type SpringState } from './springSim'

declare const Plugin: { register(id: string, opts: Record<string, unknown>): void }
declare const Blockbench: {
	on(event: string, fn: (...args: unknown[]) => void): void
	removeListener?(event: string, fn: (...args: unknown[]) => void): void
}
declare const Project: { groups?: unknown[] } | null
declare const Group: any
declare const Canvas: { scene?: { updateMatrixWorld?(force?: boolean): void }; updateView?(opt: unknown): void }
declare const Timeline: { time?: number; playing?: boolean }
declare const Animator: {
	showDefaultPose?(reduced?: boolean): void
	stackAnimations?(stack: unknown[], in_loop: boolean, blend?: number): void
}
declare const Animation: { selected?: any; all?: any[] } | undefined
declare const Modes: { animate?: boolean; edit?: boolean } | undefined
declare const THREE: any

const PLUGIN_ID = 'spring_bone'
const PLUGIN_VERSION = '0.0.4'

// Phase 1 PoC 設定。 Phase 3 で per-bone UI / property に置き換える。
const BONE_NAME_PREFIX = 'spring_'
const FIXED_DT = 1 / 60
const MAX_SUBSTEPS_PER_TICK = 16  // 通常 tick 内の上限 (= 大きく遅延した時の暴走防止)
const DEFAULT_CONFIG: Omit<SpringConfig, 'restLength'> = {
	mass: 1.0,
	stiffness: 50.0,
	damping: 4.0,
}
// scrub 判定 : 前回 tick から time が逆行 / 大ジャンプしたら頭から replay
const SCRUB_FORWARD_THRESHOLD = 0.25

interface BoneEntry {
	group: any
	config: SpringConfig
	state: SpringState
	restLocalDir: any
	restEulerDeg: [number, number, number]  // animate モード外で rest pose に戻すための保存値
}

const registry = new Map<string, BoneEntry>()
let simTime = -1            // sim 状態が表現してる animation 内部時刻 (= 秒、 -1 = 未初期化)
let inhibitTick = false      // applyPoseAt 由来の再描画で tick が再入するのを防ぐ

function isSpringGroup(group: unknown): boolean {
	const name = (group as { name?: unknown } | null)?.name
	return typeof name === 'string' && name.startsWith(BONE_NAME_PREFIX)
}

function originDelta(parent: { origin?: number[] }, child: { origin?: number[] }): {
	dir: any | null
	length: number
} {
	if (!Array.isArray(parent.origin) || !Array.isArray(child.origin)) {
		return { dir: null, length: 0 }
	}
	const dx = child.origin[0] - parent.origin[0]
	const dy = child.origin[1] - parent.origin[1]
	const dz = child.origin[2] - parent.origin[2]
	const length = Math.sqrt(dx * dx + dy * dy + dz * dz)
	if (length < 1e-4) return { dir: null, length: 0 }
	return {
		dir: new THREE.Vector3(dx / length, dy / length, dz / length),
		length,
	}
}

function findChildGroup(group: { children?: unknown[] }): { origin?: number[] } | null {
	const children = Array.isArray(group.children) ? group.children : []
	for (const c of children) {
		if (c instanceof Group) return c as { origin?: number[] }
	}
	return null
}

function registerGroup(group: any): void {
	if (registry.has(group.uuid)) return
	const child = findChildGroup(group)
	let restLength = 16
	let restLocalDir = new THREE.Vector3(0, 1, 0)
	if (child) {
		const d = originDelta(group, child)
		if (d.dir && d.length > 0) {
			restLength = d.length
			restLocalDir = d.dir
		}
	}
	const r = group.rotation
	const restEulerDeg: [number, number, number] =
		Array.isArray(r) && r.length === 3 ? [r[0], r[1], r[2]] : [0, 0, 0]
	registry.set(group.uuid, {
		group,
		config: { ...DEFAULT_CONFIG, restLength },
		state: createState(),
		restLocalDir,
		restEulerDeg,
	})
}

// animate モード外では物理結果を rest pose に戻す (= Edit / Paint / Display タブで原典姿勢を保つ)
function restoreRestPose(): void {
	for (const entry of registry.values()) {
		const r = entry.group?.rotation
		if (!Array.isArray(r) || r.length !== 3) continue
		r[0] = entry.restEulerDeg[0]
		r[1] = entry.restEulerDeg[1]
		r[2] = entry.restEulerDeg[2]
	}
}

function rescanRegistry(): void {
	registry.clear()
	const groups = (Project as { groups?: unknown[] } | null)?.groups
	if (!Array.isArray(groups)) return
	for (const g of groups) {
		if (isSpringGroup(g)) registerGroup(g as any)
	}
}

// 任意の animation 時刻に rig を当てる (= anim_ux Onion Skin / AJ updatePreview と同パターン)。
// `inhibitTick` で applyPoseAt 起因の display_animation_frame 再発火を弾く。
function applyPoseAt(time: number): void {
	if (typeof Animator?.showDefaultPose !== 'function') return
	if (typeof Animator?.stackAnimations !== 'function') return
	inhibitTick = true
	try {
		const tl: any = Timeline
		if (tl) tl.time = time
		Animator.showDefaultPose(true)
		const animSelected = (Animation as any)?.selected
		const stack: any[] = animSelected
			? [animSelected]
			: ((Animation as any)?.all ?? []).filter((a: any) => a?.playing)
		Animator.stackAnimations(stack, false)
		Canvas?.scene?.updateMatrixWorld?.(true)
	} finally {
		inhibitTick = false
	}
}

function getAnchorWorld(entry: BoneEntry, out: any): boolean {
	const mesh = entry.group.mesh
	if (!mesh) return false
	out.setFromMatrixPosition(mesh.matrixWorld)
	return true
}

function getRestTipWorld(entry: BoneEntry, anchorWorld: any, out: any): boolean {
	const parent = entry.group.mesh?.parent
	if (!parent) return false
	const parentQuat = new THREE.Quaternion()
	parent.getWorldQuaternion(parentQuat)
	const restDirWorld = entry.restLocalDir.clone().applyQuaternion(parentQuat)
	out.copy(anchorWorld).addScaledVector(restDirWorld, entry.config.restLength)
	return true
}

function stepAll(dt: number): void {
	if (registry.size === 0) return
	const anchorWorld = new THREE.Vector3()
	const restTipWorld = new THREE.Vector3()
	for (const entry of registry.values()) {
		if (!getAnchorWorld(entry, anchorWorld)) continue
		if (!getRestTipWorld(entry, anchorWorld, restTipWorld)) continue
		step(entry.state, anchorWorld, restTipWorld, entry.config, dt)
	}
}

function applyAll(): void {
	if (registry.size === 0) return
	const RAD2DEG = 180 / Math.PI
	const anchorWorld = new THREE.Vector3()
	const forward = new THREE.Vector3()
	const up = new THREE.Vector3()
	const right = new THREE.Vector3()
	const trueUp = new THREE.Vector3()
	const parentQuat = new THREE.Quaternion()
	const parentInv = new THREE.Quaternion()
	const mat = new THREE.Matrix4()
	const quat = new THREE.Quaternion()
	const euler = new THREE.Euler()

	for (const entry of registry.values()) {
		if (!entry.state.initialized) continue
		const g = entry.group
		const mesh = g.mesh
		const parent = mesh?.parent
		if (!mesh || !parent) continue

		anchorWorld.setFromMatrixPosition(mesh.matrixWorld)
		forward.subVectors(entry.state.pos, anchorWorld)
		if (forward.lengthSq() < 1e-8) continue
		forward.normalize()

		// 親の world Y を Up として採用 (= 親の roll に追従する自然な挙動)
		parent.getWorldQuaternion(parentQuat)
		up.set(0, 1, 0).applyQuaternion(parentQuat)
		if (Math.abs(forward.dot(up)) > 0.999) {
			// forward と up がほぼ平行ならジンバル方向、 fallback で local Z 軸
			up.set(0, 0, 1).applyQuaternion(parentQuat)
		}

		// 基底 : right = up × forward, trueUp = forward × right
		// Group の local Y を forward 方向に向ける
		right.crossVectors(up, forward).normalize()
		trueUp.crossVectors(forward, right).normalize()
		mat.makeBasis(right, forward, trueUp)
		quat.setFromRotationMatrix(mat)

		// world → local 化 : 親 world quat の inverse を premultiply
		parentInv.copy(parentQuat).invert()
		quat.premultiply(parentInv)

		// BB Group の rotation は ZYX Euler / 度数表記 (= AJ interaction.ts:336 と整合)
		euler.setFromQuaternion(quat, 'ZYX')
		const rx = euler.x * RAD2DEG
		const ry = euler.y * RAD2DEG
		const rz = euler.z * RAD2DEG

		if (Array.isArray(g.rotation) && g.rotation.length === 3) {
			g.rotation[0] = rx
			g.rotation[1] = ry
			g.rotation[2] = rz
		}
	}
}

// simTime → targetTime まで固定 dt で sub-step。 各 step で applyPoseAt(time) で
// その時刻の親 rig を当ててから stepAll を呼ぶ (= deterministic replay)。
function advanceSimTo(targetTime: number, maxSteps: number): void {
	if (registry.size === 0) {
		simTime = targetTime
		return
	}
	let count = 0
	while (simTime < targetTime - 1e-6 && count < maxSteps) {
		const dt = Math.min(FIXED_DT, targetTime - simTime)
		simTime += dt
		applyPoseAt(simTime)
		stepAll(dt)
		count++
	}
	if (count >= maxSteps && simTime < targetTime - 1e-3) {
		// 上限到達 = 残り取りこぼし、 強制的に追いつかせる (= safety)
		simTime = targetTime
		applyPoseAt(simTime)
	}
}

function replayFromStart(targetTime: number): void {
	for (const entry of registry.values()) entry.state.initialized = false
	simTime = 0
	// 各 entry の state を rest tip 位置で初期化 (= simTime=0 での rig を当ててから)
	applyPoseAt(0)
	const anchorWorld = new THREE.Vector3()
	const restTipWorld = new THREE.Vector3()
	for (const entry of registry.values()) {
		if (!getAnchorWorld(entry, anchorWorld)) continue
		if (!getRestTipWorld(entry, anchorWorld, restTipWorld)) continue
		resetState(entry.state, restTipWorld)
	}
	// 0 → targetTime まで sub-step 上限なしで一気に進める (= 60fps × 数秒なら数百 step、 軽い)
	const maxSteps = Math.ceil(Math.max(targetTime, 0) / FIXED_DT) + 4
	advanceSimTo(targetTime, maxSteps)
}

function tick(): void {
	if (inhibitTick) return
	if (registry.size === 0) {
		simTime = -1
		return
	}
	// animate モード外 = 物理シム走らせない、 sim 状態もリセット (= 次回戻り時は頭から)
	if (!Modes?.animate) {
		simTime = -1
		return
	}
	const currentTime = (Timeline?.time as number) ?? 0

	if (simTime < 0) {
		// 初回 / project 切替直後 = 頭から replay
		replayFromStart(currentTime)
		applyAll()
		return
	}

	const delta = currentTime - simTime
	if (delta < -1e-6 || delta > SCRUB_FORWARD_THRESHOLD) {
		// 逆行 or 大ジャンプ = スクラブ扱い、 頭から replay
		replayFromStart(currentTime)
	} else if (delta > 1e-6) {
		// 通常前進 = simTime から currentTime まで sub-step
		advanceSimTo(currentTime, MAX_SUBSTEPS_PER_TICK)
	}
	// delta == 0 = 一時停止中の同 frame 再描画、 step なし

	// applyPoseAt は advanceSimTo / replayFromStart 内の最後の sub-step で
	// currentTime に rig を戻している。 ここで再度呼ぶと spring_tail に rest pose を
	// 上書きしてしまう (= keyframe 無いと stackAnimations が rest で塗り直す)
	// ので tick 末尾では呼ばない。
	applyAll()
}

let cleanups: Array<() => void> = []

function installTickLoop(): () => void {
	rescanRegistry()
	simTime = -1
	inhibitTick = false

	const onAnimFrame = (): void => {
		try {
			tick()
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] tick failed`, e)
		}
	}
	const onProjectSwitch = (): void => {
		rescanRegistry()
		simTime = -1
	}
	const onUpdateSelection = (): void => {
		rescanRegistry()
	}
	const onModeChange = (): void => {
		// animate モード以外に切り替わった瞬間 = 物理結果を rest pose に戻す
		// (= keyframe が無い spring bone は applyPoseAt 経由では戻らない、 自前で書き戻し)
		if (!Modes?.animate) {
			restoreRestPose()
			simTime = -1
		} else {
			// animate モードに入った瞬間 = sim を再初期化 (= 次 tick で replayFromStart 走る)
			simTime = -1
		}
	}

	Blockbench.on('display_animation_frame', onAnimFrame)
	Blockbench.on('select_project', onProjectSwitch)
	Blockbench.on('update_selection', onUpdateSelection)
	Blockbench.on('select_mode', onModeChange)

	return (): void => {
		Blockbench.removeListener?.('display_animation_frame', onAnimFrame)
		Blockbench.removeListener?.('select_project', onProjectSwitch)
		Blockbench.removeListener?.('update_selection', onUpdateSelection)
		Blockbench.removeListener?.('select_mode', onModeChange)
		// plugin unload 時にも物理結果を rest に戻す (= cleanup として)
		restoreRestPose()
		registry.clear()
		simTime = -1
	}
}

Plugin.register(PLUGIN_ID, {
	title: 'Spring Bone',
	author: 'EllaCoat',
	description:
		'Spring bone physics (Verlet + spring + damper) for hair / cloth / accessory bones. Real-time preview in the editor and AnimatedJava export bake.',
	icon: 'gesture',
	variant: 'desktop',
	version: PLUGIN_VERSION,
	onload() {
		console.log(`[${PLUGIN_ID}] loaded v${PLUGIN_VERSION}`)
		cleanups.push(installTickLoop())
	},
	onunload() {
		for (const fn of cleanups) {
			try {
				fn()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] cleanup failed`, e)
			}
		}
		cleanups = []
		console.log(`[${PLUGIN_ID}] unloaded`)
	},
})
