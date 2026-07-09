// VRM SpringBone / Dynamic Bone 風 Verlet。 BB / AJ / THREE の API には依存しない pure な物理 step。
// v0.0.7 で「親 rotation を spring 加速度の "位置目標" に流し込む」 旧設計を廃止し、
// 「親 rotation を希望方向 (= boneAxis) として "力" で毎 step 注入する」 産業標準パターンに変更。
// 旧設計は anchor が curved path で動くため snap が中途半端な代数的固定点を作り、
// 「parent.x × −0.5 で同位相の半分張り付き」 + 慣性余韻ゼロ という挙動になっていた。

declare const THREE: any

export interface SpringConfig {
	drag: number       // 速度減衰係数 (= 0 = 完全慣性、 1 = 即停止)、 既定 0.05
	stiffness: number  // 親方向への per-step force coefficient (= dt スケーリング)、 既定 1.0
	restLength: number // 親 pivot から仮想末端までの距離 (= tipDistance)
	gravity: number    // world -Y 方向への per-step force coefficient (= dt スケーリング、 stiffness と同慣習)、 既定 0 = 無効
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

// step() の per-sub-step allocation を避ける scratch。 chain 化で bone × sub-step 数が
// 効く段になったため GC 圧削減が実効する。 single-thread 前提で使い回し、 呼び出し間の
// 値保持は前提しない (= 各 step 呼び出しの中で全て書き込んでから使う)。
const _inertia = new THREE.Vector3()
const _stiffnessForce = new THREE.Vector3()
const _gravityForce = new THREE.Vector3()
const _next = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _restTip = new THREE.Vector3()

// VRM SpringBone 風 1 step :
//   state          = 仮想末端の現在 / 前 step world 位置
//   anchorWorld    = 親 bone の world pos (= sim 全体で「中心」、 length constraint の中心)
//   boneAxisWorld  = 親 world quat × restLocalDir = 親が回ると変化する「希望方向」
//                    (= 親 +X 回転で boneAxis が +X 旋回、 spring tip がここに向かう力で引かれる)
//   config         = drag / stiffness / restLength / gravity
//   dt             = 時間刻み (= 1/60 想定)
//
// 設計 :
//   - 慣性 = (curr - prev) * (1 - drag) で自然に維持 (= velocity を陽に持たず Verlet で暗黙)
//   - 親回転由来の力 = boneAxis * stiffness * dt を nextTail に毎 step 加算 (= 産業標準)
//   - 重力 = world -Y に per-step force coefficient (= stiffness と同じ dt スケーリング慣習)
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
		_restTip.copy(anchorWorld).addScaledVector(boneAxisWorld, config.restLength)
		resetState(state, _restTip)
		return
	}

	// 慣性 = 前 step displacement を drag で減衰
	_inertia.subVectors(state.pos, state.prevPos).multiplyScalar(1 - config.drag)

	// 親回転由来の力 = boneAxis 方向に毎 step 引き寄せる
	// (= 親が回ると boneAxis が変わる → spring tip が次第に新方向に追従、 慣性 lag が出る)
	_stiffnessForce.copy(boneAxisWorld).multiplyScalar(config.stiffness * dt)

	// 重力 = world -Y 方向への per-step force coefficient (= stiffness と同じ dt スケーリング)。
	// 既定 0 で無効、 値を入れると t=0 直後に垂れ下がる settle 過渡が deterministic に出現する
	// (= replay 起点で rest tip 位置から始まり、 gravity で平衡点まで自然落下)。
	_gravityForce.set(0, -config.gravity * dt, 0)

	_next.copy(state.pos).add(_inertia).add(_stiffnessForce).add(_gravityForce)

	// length constraint : anchor からの距離を restLength に hard snap
	_dir.subVectors(_next, anchorWorld)
	const len = _dir.length()
	if (len > 1e-6) {
		_dir.multiplyScalar(config.restLength / len)
		_next.copy(anchorWorld).add(_dir)
	} else {
		_next.copy(anchorWorld).addScaledVector(boneAxisWorld, config.restLength)
	}

	state.prevPos.copy(state.pos)
	state.pos.copy(_next)
}
