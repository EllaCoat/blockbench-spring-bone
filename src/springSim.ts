// Verlet integration + spring force + length constraint。
// BB / AJ / THREE の API には依存しない pure な物理 step を提供する。

declare const THREE: any

export interface SpringConfig {
	mass: number       // 質量 (= 既定 1.0)
	stiffness: number  // 仮想末端を rest 方向に引き戻すバネ係数
	damping: number    // 速度減衰係数 (= 1/秒 単位、 exp(-damping*dt) で適用)
	restLength: number // 親 pivot から仮想末端までの距離 (= tipDistance)
}

export interface SpringState {
	pos: any      // 現在の仮想末端 world 位置 (= THREE.Vector3)
	prevPos: any  // 前 step の仮想末端 world 位置
	initialized: boolean
}

export function createState(): SpringState {
	return {
		pos: new THREE.Vector3(),
		prevPos: new THREE.Vector3(),
		initialized: false,
	}
}

export function resetState(state: SpringState, restTipWorld: any): void {
	state.pos.copy(restTipWorld)
	state.prevPos.copy(restTipWorld)
	state.initialized = true
}

// Verlet 1 step。 入力 :
//   state         = 仮想末端の現在 / 前 step world 位置
//   anchorWorld   = 親 Group pivot の world 座標
//   restTipWorld  = 親 pivot + (親 rotation * 親→子方向 * restLength) で得る、 静止時に末端が居るべき world 座標
//   config        = mass / stiffness / damping / restLength
//   dt            = 時間刻み (= 1/60 想定)
export function step(
	state: SpringState,
	anchorWorld: any,
	restTipWorld: any,
	config: SpringConfig,
	dt: number,
): void {
	if (!state.initialized) {
		resetState(state, restTipWorld)
		return
	}

	// spring 加速度 = (restTip - pos) * stiffness / mass
	const accel = new THREE.Vector3()
		.subVectors(restTipWorld, state.pos)
		.multiplyScalar(config.stiffness / Math.max(config.mass, 1e-6))

	// 速度減衰 (= 指数減衰、 dt 変動に強い)
	const decay = Math.exp(-config.damping * dt)
	const displacement = new THREE.Vector3()
		.subVectors(state.pos, state.prevPos)
		.multiplyScalar(decay)

	// Verlet : nextPos = pos + displacement + accel * dt^2
	const next = new THREE.Vector3()
		.copy(state.pos)
		.add(displacement)
		.addScaledVector(accel, dt * dt)

	// constraint 適用前の位置を保存 (= 偽速度補正のため)
	const preConstraint = next.clone()

	// length constraint : anchor からの距離を restLength に強制
	const dir = new THREE.Vector3().subVectors(next, anchorWorld)
	const len = dir.length()
	if (len > 1e-6) {
		dir.multiplyScalar(config.restLength / len)
		next.copy(anchorWorld).add(dir)
	} else {
		next.copy(restTipWorld)
	}

	// 偽速度補正 (= length constraint で snap した分、 prevPos も同方向にシフト
	// しないと次 step で「強制移動 = 巨大速度」 として誤検出され爆発する)
	const correction = new THREE.Vector3().subVectors(next, preConstraint)

	state.prevPos.copy(state.pos)
	state.prevPos.add(correction)
	state.pos.copy(next)
}
