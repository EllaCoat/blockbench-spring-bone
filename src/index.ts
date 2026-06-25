// blockbench-spring-bone — Blockbench plugin
// Spring bone physics simulation for hair / cloth / accessory bones.
// v0.0.9 で deterministic replay 方式に切替 :
//   - 物理 sim 進行を simTime (= 0 基準の sim 内部時刻) ベースに変更
//   - 毎 tick で currentTime を FIXED_DT 単位に snap、 0 → targetSimTime まで FIXED_DT で完走
//   - 通常前進は cache (= 前 simTime) から進める軽量化、 逆行 / 大ジャンプは 0 から replay
//   - 結果 = frame ごとに値固定、 scrub 速度 / 履歴に依存しない、 巨大 dt 爆発なし
//   - 旧 accumulator (leftoverTime) + scrub_reset 機構は全廃 (= 履歴依存で deterministic でなかった)
//   - rescanRegistry を idempotent 化 (= 既存 entry の state を保持、 ボーンクリック時のリセット解消)
//   - applyAll は v0.0.8 の setFromUnitVectors 経路 (= 反射 basis half-lock 真因 fix) を維持
//   - 物理は v0.0.7 の VRM SpringBone 風 force injection (= boneAxis * stiffness * dt 注入) を維持
// Loop 連続性 = keyframe 側責任。 deterministic replay の構造上 loop wrap (= time 2.0 → 0) で
//   spring 慣性 state は rest に戻る (= replayFromStartTo(0) で resetAllToRest)。 周期境界での
//   ガクつきを避けるには「アニメ末端で物理が rest に収まる長さ」 で設計する必要あり。
//   残った場合は Phase 5 のベイク機能で微調整する方針 (= 過剰な loop seamless 機構は入れない)。

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
const PLUGIN_VERSION = '0.0.9'

// Phase 1 PoC 設定。 Phase 3 で per-bone UI / property に置き換える。
const BONE_NAME_PREFIX = 'spring_'

// 物理パラ (= VRM SpringBone デフォルト相当)
const FIXED_DT = 1 / 60
// 0.5s 超の前進は cache 経路が重くなる + scrub の大ジャンプ判定なので 0 から replay に流す
const FAST_FORWARD_THRESHOLD = 0.5
const DEFAULT_CONFIG: Omit<SpringConfig, 'restLength'> = {
	drag: 0.05,        // 速度減衰 = 5% / step (= ふんわり残響、 VRM デフォルト相当)
	stiffness: 1.0,    // 親方向への引力係数
}

interface BoneEntry {
	group: any
	config: SpringConfig
	state: SpringState
	restLocalDir: any
}

const registry = new Map<string, BoneEntry>()
let simTime = -1          // 現在 sim 状態が表現してる時刻 (= 秒)、 -1 = 未初期化
let inhibitTick = false   // applyPoseAt 由来の再描画で tick が再入するのを防ぐ

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
	registry.set(group.uuid, {
		group,
		config: { ...DEFAULT_CONFIG, restLength },
		state: createState(),
		restLocalDir,
	})
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

function getBoneAxisWorld(entry: BoneEntry, out: any): boolean {
	const parent = entry.group.mesh?.parent
	if (!parent) return false
	const parentQuat = new THREE.Quaternion()
	parent.getWorldQuaternion(parentQuat)
	out.copy(entry.restLocalDir).applyQuaternion(parentQuat)
	return true
}

function stepAll(dt: number): void {
	if (registry.size === 0) return
	const anchorWorld = new THREE.Vector3()
	const boneAxisWorld = new THREE.Vector3()
	for (const entry of registry.values()) {
		if (!getAnchorWorld(entry, anchorWorld)) continue
		if (!getBoneAxisWorld(entry, boneAxisWorld)) continue
		step(entry.state, anchorWorld, boneAxisWorld, entry.config, dt)
	}
}

function applyAll(): void {
	if (registry.size === 0) return
	const anchorWorld = new THREE.Vector3()
	const forward = new THREE.Vector3()
	const parentQuat = new THREE.Quaternion()
	const parentInv = new THREE.Quaternion()
	const localForward = new THREE.Vector3()
	const localQuat = new THREE.Quaternion()
	const euler = new THREE.Euler()

	for (const entry of registry.values()) {
		if (!entry.state.initialized) continue
		const mesh = entry.group?.mesh
		const parent = mesh?.parent
		if (!mesh || !parent) continue

		anchorWorld.setFromMatrixPosition(mesh.matrixWorld)
		forward.subVectors(entry.state.pos, anchorWorld)
		if (forward.lengthSq() < 1e-8) continue
		forward.normalize()

		parent.getWorldQuaternion(parentQuat)
		parentInv.copy(parentQuat).invert()

		// world forward を parent local 化 → restLocalDir からこの方向に向ける最短回転を直接計算。
		// 旧 basis 構築 (= forward / right / trueUp + lastRight parallel transport) は
		// trueUp = forward × right が left-handed (= 反射) basis を生み、 setFromRotationMatrix
		// が非単位 quat を返し、 Euler 抽出で角度が「正確に半分」 になっていた (= half-lock の真因)。
		// setFromUnitVectors は restLocalDir → localForward の最短回転を直接計算するので、
		// 反射トラップ + +Y 軸固定仮定 + lastRight hysteresis を一気に解消、 連続性も自然に担保。
		localForward.copy(forward).applyQuaternion(parentInv)
		localQuat.setFromUnitVectors(entry.restLocalDir, localForward)

		const order = mesh.rotation.order || 'ZYX'
		euler.setFromQuaternion(localQuat, order)
		mesh.rotation.x = euler.x
		mesh.rotation.y = euler.y
		mesh.rotation.z = euler.z
	}
}

// 全 entry の state を「現時刻 frame の rest 位置」 にリセット (= scrub / 初回 invoke 時)
function resetAllToRest(): void {
	const anchorWorld = new THREE.Vector3()
	const boneAxisWorld = new THREE.Vector3()
	const restTip = new THREE.Vector3()
	for (const entry of registry.values()) {
		if (!getAnchorWorld(entry, anchorWorld)) continue
		if (!getBoneAxisWorld(entry, boneAxisWorld)) continue
		restTip.copy(anchorWorld).addScaledVector(boneAxisWorld, entry.config.restLength)
		resetState(entry.state, restTip)
	}
}

// 0 → targetTime まで FIXED_DT 単位で fixed-dt sub-step 完走 (= deterministic replay の起点)
function replayFromStartTo(targetTime: number): void {
	applyPoseAt(0)
	resetAllToRest()
	simTime = 0
	advanceSimTo(targetTime)
}

// 現 simTime から targetTime まで FIXED_DT 単位で sub-step (= cache 経路 + replay の共通実装)
function advanceSimTo(targetTime: number): void {
	while (simTime + FIXED_DT <= targetTime + 1e-6) {
		applyPoseAt(simTime + FIXED_DT)
		stepAll(FIXED_DT)
		simTime += FIXED_DT
	}
}

function tick(): void {
	if (inhibitTick) return
	if (registry.size === 0) {
		simTime = -1
		return
	}
	if (!Modes?.animate) {
		simTime = -1
		return
	}
	const currentTime = (Timeline?.time as number) ?? 0

	// currentTime を FIXED_DT 単位に snap (= frame ごとの値固定、 deterministic 確保)
	const targetSimTime = Math.max(0, Math.floor(currentTime / FIXED_DT) * FIXED_DT)

	if (simTime < 0 || targetSimTime < simTime - 1e-6 || targetSimTime - simTime > FAST_FORWARD_THRESHOLD) {
		// 初回 / 逆行 / 大ジャンプ = 0 から replay (= deterministic 完全保証)
		replayFromStartTo(targetSimTime)
	} else if (targetSimTime > simTime + 1e-6) {
		// 通常前進 = cache (= 前 simTime) から進める (= 軽量化、 1 tick で 1-3 step)
		advanceSimTo(targetSimTime)
	}
	// 同時刻 (= |targetSimTime - simTime| < 1e-6) = sim 進めない (= state 不変、 描画のみ)

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
		// idempotent rescan で既存 entry の state は保持、 simTime もそのまま (= 物理継続)。
		rescanRegistry()
	}
	const onModeChange = (): void => {
		// mode 切替で sim 状態を捨てる (= 次 animate モード復帰時に頭から replay)
		simTime = -1
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
		registry.clear()
		simTime = -1
	}
}

Plugin.register(PLUGIN_ID, {
	title: 'Spring Bone',
	author: 'EllaCoat',
	description:
		'Spring bone physics (deterministic replay + VRM SpringBone 風 force injection) for hair / cloth / accessory bones. Real-time preview in the editor and AnimatedJava export bake.',
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
