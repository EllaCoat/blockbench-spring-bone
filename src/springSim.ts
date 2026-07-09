// VRM SpringBone / Dynamic Bone 風 Verlet。 BB / AJ / THREE の API には依存しない pure な物理 step。
// v0.0.7 で「親 rotation を spring 加速度の "位置目標" に流し込む」 旧設計を廃止し、
// 「親 rotation を希望方向 (= boneAxis) として "力" で毎 step 注入する」 産業標準パターンに変更。
// 旧設計は anchor が curved path で動くため snap が中途半端な代数的固定点を作り、
// 「parent.x × −0.5 で同位相の半分張り付き」 + 慣性余韻ゼロ という挙動になっていた。

declare const THREE: any

export interface SpringConfig {
	drag: number       // 速度減衰係数 (= 0 = 完全慣性、 1 = 即停止)、 既定 0.05
	stiffness: number  // 親方向への引力係数、 既定 1.0
	restLength: number // 親 pivot から仮想末端までの距離 (= tipDistance)
	gravity: number    // world -Y 方向への加速度 (= 常時働く重力)、 既定 0 = 無効
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

// VRM SpringBone 風 1 step :
//   state          = 仮想末端の現在 / 前 step world 位置
//   anchorWorld    = 親 bone の world pos (= sim 全体で「中心」、 length constraint の中心)
//   boneAxisWorld  = 親 world quat × restLocalDir = 親が回ると変化する「希望方向」
//                    (= 親 +X 回転で boneAxis が +X 旋回、 spring tip がここに向かう力で引かれる)
//   config         = drag / stiffness / restLength
//   dt             = 時間刻み (= 1/60 想定)
//
// 設計 :
//   - 慣性 = (curr - prev) * (1 - drag) で自然に維持 (= velocity を陽に持たず Verlet で暗黙)
//   - 親回転由来の力 = boneAxis * stiffness * dt を nextTail に毎 step 加算 (= 産業標準)
//   - length constraint = anchor からの距離を restLength に hard snap
//   - 旧設計の「親 rotation で動いた rest tip 位置を spring 加速度の目標にする」 は廃止
export function step(
	state: SpringState,
	anchorWorld: any,
	boneAxisWorld: any,
	config: SpringConfig,
	dt: number,
): void {
	if (!state.initialized) {
		const restTip = new THREE.Vector3()
			.copy(anchorWorld)
			.addScaledVector(boneAxisWorld, config.restLength)
		resetState(state, restTip)
		return
	}

	// 慣性 = 前 step displacement を drag で減衰
	const inertia = new THREE.Vector3()
		.subVectors(state.pos, state.prevPos)
		.multiplyScalar(1 - config.drag)

	// 親回転由来の力 = boneAxis 方向に毎 step 引き寄せる
	// (= 親が回ると boneAxis が変わる → spring tip が次第に新方向に追従、 慣性 lag が出る)
	const stiffnessForce = new THREE.Vector3()
		.copy(boneAxisWorld)
		.multiplyScalar(config.stiffness * dt)

	// 重力 = world -Y 方向に常時働く加速度。 dt スケーリング (= stiffness と同じ「force per dt」 慣習)。
	// 既定 0 で無効、 値を入れると t=0 直後に垂れ下がる settle 過渡が deterministic に出現する
	// (= replay 起点で rest tip 位置から始まり、 gravity で平衡点まで自然落下)。
	const gravityForce = new THREE.Vector3(0, -config.gravity * dt, 0)

	const next = new THREE.Vector3()
		.copy(state.pos)
		.add(inertia)
		.add(stiffnessForce)
		.add(gravityForce)

	// length constraint : anchor からの距離を restLength に hard snap
	const dir = new THREE.Vector3().subVectors(next, anchorWorld)
	const len = dir.length()
	if (len > 1e-6) {
		dir.multiplyScalar(config.restLength / len)
		next.copy(anchorWorld).add(dir)
	} else {
		next.copy(anchorWorld).addScaledVector(boneAxisWorld, config.restLength)
	}

	state.prevPos.copy(state.pos)
	state.pos.copy(next)
}
