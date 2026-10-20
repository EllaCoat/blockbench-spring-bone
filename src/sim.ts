// VRM SpringBone 風の Verlet。 Blockbench には依存しない (= THREE の Vector3 だけを使う)。

declare const THREE: any

export interface SpringConfig {
	drag: number // 速度の減衰 (0 = 慣性を保つ、 1 = 即停止)
	stiffness: number // 親の向きへ引き戻す力
	restLength: number // pivot から仮想の先端までの距離
	gravity: number // world -Y へ引く力
}

export interface SpringState {
	pos: any // 仮想の先端の world 位置
	prevPos: any
	initialized: boolean
}

export function createState(): SpringState {
	return { pos: new THREE.Vector3(), prevPos: new THREE.Vector3(), initialized: false }
}

export function resetState(state: SpringState, restTipWorld: any): void {
	state.pos.copy(restTipWorld)
	state.prevPos.copy(restTipWorld)
	state.initialized = true
}

const inertia = new THREE.Vector3()
const stiffnessForce = new THREE.Vector3()
const gravityForce = new THREE.Vector3()
const next = new THREE.Vector3()
const dir = new THREE.Vector3()
const restTip = new THREE.Vector3()

// 1 step 進める。 anchorWorld は bone の pivot、 boneAxisWorld は親の向きから見た「戻りたい方向」。
// 慣性を drag で減らし、 boneAxis 方向の力と重力を足してから、 pivot からの距離を restLength に揃える。
export function step(state: SpringState, anchorWorld: any, boneAxisWorld: any, config: SpringConfig, dt: number): void {
	if (!state.initialized) {
		restTip.copy(anchorWorld).addScaledVector(boneAxisWorld, config.restLength)
		resetState(state, restTip)
		return
	}
	inertia.subVectors(state.pos, state.prevPos).multiplyScalar(1 - config.drag)
	stiffnessForce.copy(boneAxisWorld).multiplyScalar(config.stiffness * dt)
	gravityForce.set(0, -config.gravity * dt, 0)
	next.copy(state.pos).add(inertia).add(stiffnessForce).add(gravityForce)

	dir.subVectors(next, anchorWorld)
	const length = dir.length()
	if (length > 1e-6) next.copy(anchorWorld).add(dir.multiplyScalar(config.restLength / length))
	else next.copy(anchorWorld).addScaledVector(boneAxisWorld, config.restLength)

	state.prevPos.copy(state.pos)
	state.pos.copy(next)
}
