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
import { registerSpringPanel } from './ui'

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
// BB 5.1.4 の Property class (= js/util/property.ts)。 Group.properties[name] に登録され
// blueprint (.bbmodel) の save/load、 Undo、 multi-select、 削除 cleanup、 Element panel
// input 自動生成 (= condition: {modes: ['edit']} 越しに edit モードのみ表示) が本体側で担保。
// element_panel は edit モード限定なので animate モードでは自然に消え、 animate 時の
// 値編集は本 plugin の専用 Panel (= Phase 3 Commit 2) 側で提供する。
declare const Property: any

const PLUGIN_ID = 'spring_bone'
const PLUGIN_VERSION = '0.0.10'

// per-bone UI / Property panel は今後の Phase で追加予定 (= 現行 plan では
// Phase 1 chain graph + Phase 2 ordered pass + Phase 3 gravity まで済、 UI は未着手)。
const BONE_NAME_PREFIX = 'spring_'

// 物理パラ (= VRM SpringBone デフォルト相当)
const FIXED_DT = 1 / 60
// 0.5s 超の前進は cache 経路が重くなる + scrub の大ジャンプ判定なので 0 から replay に流す
const FAST_FORWARD_THRESHOLD = 0.5
const DEFAULT_CONFIG: Omit<SpringConfig, 'restLength'> = {
	drag: 0.05,        // 速度減衰 = 5% / step (= ふんわり残響、 VRM デフォルト相当)
	stiffness: 1.0,    // 親方向への per-step force coefficient
	gravity: 0,        // world -Y への per-step force、 既定 = 無効。 実機検証で値調整予定
}

// Property key list (= register / unregister / read で共有)。 key 名は
// `spring_<field>` にして、 name prefix (= BONE_NAME_PREFIX = 'spring_') と統一感を持たせる。
const PROPERTY_KEYS = ['spring_drag', 'spring_stiffness', 'spring_gravity'] as const
type SpringPropertyKey = (typeof PROPERTY_KEYS)[number]

// Group instance に自動で生える Property 値を読む helper。 Property が未定義
// or 未 register or NaN の場合は fallback を返す (= DEFAULT_CONFIG 値)。
function readSpringProp(group: unknown, key: SpringPropertyKey, fallback: number): number {
	const raw = (group as Record<string, unknown> | null)?.[key]
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

// Property 変更時の同期 hook。 element_panel input の onChange から呼ばれる。
// - 全 registered spring group の Property 値を entry.config に反映
// - fingerprint invalidate (= 次 tick で 0 replay 経路が走り、 preview 即反映)
function onSpringPropertyChange(): void {
	for (const entry of registry.values()) {
		entry.config.drag = readSpringProp(entry.group, 'spring_drag', DEFAULT_CONFIG.drag)
		entry.config.stiffness = readSpringProp(entry.group, 'spring_stiffness', DEFAULT_CONFIG.stiffness)
		entry.config.gravity = readSpringProp(entry.group, 'spring_gravity', DEFAULT_CONFIG.gravity)
	}
	// fingerprint を空文字にすることで rescanRegistry 経由の invalidate を必ずトリガする
	// (= 次 tick の rescanRegistry で fp !== lastGraphFingerprint 判定が真になる)。
	lastGraphFingerprint = ''
	simTime = -1
}

// spring group name prefix 判定 (= BB 側 condition callback から呼ばれる)。
// Property.condition に function を渡すと Group 各インスタンス単位で判定される
// (= 対象 group だけに Property が生えて汚染しない)。
function isSpringGroupForProperty(group: unknown): boolean {
	const name = (group as { name?: unknown } | null)?.name
	return typeof name === 'string' && name.startsWith(BONE_NAME_PREFIX)
}

// Property 3 個を Group に register。 plugin onload で 1 回だけ呼ぶ。
// element_panel input は edit モードのみ表示 (= BB 本体側の element_panel.ts condition)、
// animate モードでは自然に消える。 animate モード用の値編集は Commit 2 の専用 Panel で提供。
function registerProperties(): void {
	if (typeof Property !== 'function') {
		console.warn(`[${PLUGIN_ID}] Property class not available, skipping property registration`)
		return
	}

	const makeConfig = (label: string, defaultValue: number, min: number, max: number, step: number) => ({
		default: defaultValue,
		condition: isSpringGroupForProperty,
		inputs: {
			element_panel: {
				input: { label, type: 'number', min, max, step },
				onChange: onSpringPropertyChange,
			},
		},
	})

	new Property(Group, 'number', 'spring_drag', makeConfig('Spring drag', DEFAULT_CONFIG.drag, 0, 1, 0.01))
	new Property(Group, 'number', 'spring_stiffness', makeConfig('Spring stiffness', DEFAULT_CONFIG.stiffness, 0, 10, 0.1))
	new Property(Group, 'number', 'spring_gravity', makeConfig('Spring gravity', DEFAULT_CONFIG.gravity, 0, 100, 1))
}

// plugin onunload で Property を Group.properties から delete。 unload → reload で
// 二重登録警告が出るのを避ける。 Group instance 側の値は blueprint 側に既に serialize
// されていれば reload 時に自動で復帰する。
function unregisterProperties(): void {
	const props = (Group as { properties?: Record<string, unknown> } | undefined)?.properties
	if (!props) return
	for (const key of PROPERTY_KEYS) {
		delete props[key]
	}
}

interface BoneEntry {
	group: any
	config: SpringConfig
	state: SpringState
	restLocalDir: any
	// chain 情報。 parentUuid = 直上の spring group の uuid (= root なら null)、
	// depth = chain root からの距離 (= root なら 0、 rebuildTopoOrder で再計算)。
	parentUuid: string | null
	depth: number
}

const registry = new Map<string, BoneEntry>()
// topoOrder = registry のキーを chain root → leaf の順に並べた配列。
// depth 昇順、 tie-break は Project.groups の出現順 (= deterministic 確保)。
// stepAndApplyOrdered / applyOnlyOrdered / resetAllToRest の iteration 順に使う。
let topoOrder: string[] = []
// chain 構造の指紋 (= uuid:parentUuid:restLength の連結)。 rescan で fingerprint が
// 変わった = topology が変化 (= reparent / rename / restLength / add / remove) と判定、
// 変化時に simTime = -1 で次 tick の 0 replay をトリガする。 update_selection の
// クリック保持は「構造不変 = fingerprint 不変」 のため simTime 影響なし。
let lastGraphFingerprint = ''
let simTime = -1          // 現在 sim 状態が表現してる時刻 (= 秒)、 -1 = 未初期化
let inhibitTick = false   // applyPoseAt 由来の再描画で tick が再入するのを防ぐ

function isSpringGroup(group: unknown): boolean {
	const name = (group as { name?: unknown } | null)?.name
	return typeof name === 'string' && name.startsWith(BONE_NAME_PREFIX)
}

// outliner 上を上に辿って最寄りの spring 祖先を返す。 中間に非 spring group を
// 挟んだ chain (= spring_a > plain > spring_c) でも spring_c の parent を spring_a
// と解釈するため。 chain root (= spring 祖先なし) は null。 updateMatrixWorld(true)
// は中間 plain group を通して子孫まで伝播するので、 depth / topo 順さえ正しければ
// anchor / boneAxis の read は正しく親の物理反映後を見る。
function getSpringParentUuid(group: unknown): string | null {
	// visited Set で cycle 防御。 BB outliner の tree 構造では通常 cycle は作れないが、
	// 非 spring group 同士で parent 循環が存在する malformed state でも無限ループしない。
	const visited = new Set<object>()
	let cursor = (group as { parent?: unknown } | null)?.parent
	while (cursor && typeof cursor === 'object') {
		if (visited.has(cursor)) return null
		visited.add(cursor)
		if (isSpringGroup(cursor)) {
			const uuid = (cursor as { uuid?: unknown }).uuid
			return typeof uuid === 'string' ? uuid : null
		}
		cursor = (cursor as { parent?: unknown }).parent
	}
	return null
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
	if (typeof group?.uuid !== 'string') return
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
		// Property 値を初期 config に反映 (= Property 未 register / 未設定なら DEFAULT_CONFIG fallback)。
		// registerGroup は idempotent スキップで state を保持するため、 このパスは新規 register 時のみ通る。
		config: {
			drag: readSpringProp(group, 'spring_drag', DEFAULT_CONFIG.drag),
			stiffness: readSpringProp(group, 'spring_stiffness', DEFAULT_CONFIG.stiffness),
			gravity: readSpringProp(group, 'spring_gravity', DEFAULT_CONFIG.gravity),
			restLength,
		},
		state: createState(),
		restLocalDir,
		parentUuid: getSpringParentUuid(group),
		depth: 0, // rebuildTopoOrder で再計算される
	})
}

// registry の各 entry に depth を割り付けつつ topoOrder を再構築する。
// - depth = 自 entry から chain root までの距離 (= parentUuid を辿った回数)
// - topoOrder = depth 昇順、 tie-break は Project.groups の出現順で deterministic
// register 順が親 → 子とは限らないため、 rescan 完了後にまとめて計算する。
function rebuildTopoOrder(groups: unknown[]): void {
	const orderIndex = new Map<string, number>()
	groups.forEach((g, i) => {
		const uuid = (g as { uuid?: unknown } | null)?.uuid
		if (typeof uuid === 'string') orderIndex.set(uuid, i)
	})

	const depthCache = new Map<string, number>()
	const depthOf = (uuid: string, seen: Set<string>): number => {
		const cached = depthCache.get(uuid)
		if (cached !== undefined) return cached
		if (seen.has(uuid)) {
			// cycle 検出。 該当 entry の parentUuid を null 化して cycle を破り、
			// depth 0 (= root 扱い) に確定させる。 BB outliner の tree 構造では
			// cycle は通常発生しないが、 万一の防御と検知のため console.warn を 1 発。
			const entry = registry.get(uuid)
			if (entry) entry.parentUuid = null
			depthCache.set(uuid, 0)
			console.warn(`[${PLUGIN_ID}] cycle detected in spring chain at ${uuid}, breaking as root`)
			return 0
		}
		const entry = registry.get(uuid)
		if (!entry || entry.parentUuid === null || !registry.has(entry.parentUuid)) {
			depthCache.set(uuid, 0)
			return 0
		}
		seen.add(uuid)
		const d = 1 + depthOf(entry.parentUuid, seen)
		seen.delete(uuid)
		depthCache.set(uuid, d)
		return d
	}

	for (const [uuid, entry] of registry) {
		entry.depth = depthOf(uuid, new Set())
	}

	// topoOrder = depth 昇順 (= root → leaf)、 tie-break は Project.groups 出現順。
	// sort 内 depth は entry.depth を直接参照 (= depthCache はローカル実装詳細に閉じる)。
	const uuids = Array.from(registry.keys())
	uuids.sort((a, b) => {
		const da = registry.get(a)?.depth ?? 0
		const db = registry.get(b)?.depth ?? 0
		if (da !== db) return da - db
		return (orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER)
	})
	topoOrder = uuids
}

// chain 構造 + Property パラの fingerprint 計算 (= topology / config 変化検知用)。 uuid
// 昇順に整列した「uuid:parentUuid:restLength:restLocalDir:drag,stiffness,gravity」 の連結。
// 数値は小数丸めで安定化。 restLocalDir も含めることで「同長で方向だけ変わった origin 編集」
// でも invalidate する。 drag / stiffness / gravity を含めることで、 Property 値変更が
// 「topology 変化と同じ扱い」 で next tick に 0 replay をトリガする (= 値変更が scrub
// を待たずに即 preview に反映される、 element_panel input の onChange と両輪で動作)。
function computeGraphFingerprint(): string {
	const uuids = Array.from(registry.keys()).sort()
	return uuids
		.map((u) => {
			const e = registry.get(u)!
			const d = e.restLocalDir
			const c = e.config
			return `${u}:${e.parentUuid ?? '-'}:${c.restLength.toFixed(4)}:${d.x.toFixed(3)},${d.y.toFixed(3)},${d.z.toFixed(3)}:${c.drag.toFixed(3)},${c.stiffness.toFixed(3)},${c.gravity.toFixed(3)}`
		})
		.join('|')
}

// idempotent rescan : 既存 entry の state は保持、 不在 group のみ削除、 新規 group のみ追加。
// 旧版は registry.clear() で全滅 → 再 register で state がリセットされていた
// (= update_selection event 経由のボーンクリックで物理状態が初期化される問題の真因)。
// rescan の末尾で parentUuid を最新の group.parent から refresh し、 topoOrder を再構築する。
function rescanRegistry(): void {
	const groups = (Project as { groups?: unknown[] } | null)?.groups
	if (!Array.isArray(groups)) {
		registry.clear()
		topoOrder = []
		lastGraphFingerprint = ''
		return
	}
	const currentUuids = new Set<string>()
	for (const g of groups) {
		if (isSpringGroup(g)) {
			const uuid = (g as any).uuid
			if (typeof uuid === 'string') currentUuids.add(uuid)
		}
	}
	for (const uuid of Array.from(registry.keys())) {
		if (!currentUuids.has(uuid)) registry.delete(uuid)
	}
	for (const g of groups) {
		if (isSpringGroup(g)) registerGroup(g as any)
	}

	// 既存 entry の chain link + rest 系 + Property 由来の物理パラを最新の rig 状態から refresh。
	// registerGroup は idempotent スキップで state (= 慣性など) を保持するが、
	// 構造情報 (= parentUuid / restLocalDir / restLength) は「rig 編集の瞬間」 の
	// 最新値を反映する。 rest 系の反映は length constraint が新値に合わせて hard snap
	// するため若干のジャンプが出るが、 構造整合を優先する。
	// Property 値 (= drag / stiffness / gravity) も同時に読み直す。 これで
	// blueprint reload / Undo / 別チャネル (= 例 : 将来の専用 Panel) からの変更が
	// tick 経路で自然に取り込まれる。
	for (const entry of registry.values()) {
		entry.parentUuid = getSpringParentUuid(entry.group)
		entry.config.drag = readSpringProp(entry.group, 'spring_drag', DEFAULT_CONFIG.drag)
		entry.config.stiffness = readSpringProp(entry.group, 'spring_stiffness', DEFAULT_CONFIG.stiffness)
		entry.config.gravity = readSpringProp(entry.group, 'spring_gravity', DEFAULT_CONFIG.gravity)
		const child = findChildGroup(entry.group)
		if (child) {
			const d = originDelta(entry.group, child)
			if (d.dir && d.length > 0) {
				entry.restLocalDir = d.dir
				entry.config.restLength = d.length
			}
		}
	}
	rebuildTopoOrder(groups)

	// topology (= chain 構造 / restLength) が変わったら sim state を invalidate。
	// 次 tick は replayFromStartTo が起動し、 新構造に合わせて 0 から replay する。
	// クリック保持 (= update_selection) は fingerprint 不変 → simTime 影響なし。
	const fp = computeGraphFingerprint()
	if (fp !== lastGraphFingerprint) {
		lastGraphFingerprint = fp
		simTime = -1
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

// getBoneAxisWorld で使い回す quaternion scratch。 per-sub-step の new Quaternion() を
// 避けて GC 圧を減らす (= chain 化で bone × sub-step 数が効く段になったため)。
// single-thread 前提で使い回し、 呼び出し間の値保持は前提しない。
const _boneAxisScratchQuat = new THREE.Quaternion()

function getBoneAxisWorld(entry: BoneEntry, out: any): boolean {
	const parent = entry.group.mesh?.parent
	if (!parent) return false
	parent.getWorldQuaternion(_boneAxisScratchQuat)
	out.copy(entry.restLocalDir).applyQuaternion(_boneAxisScratchQuat)
	return true
}

// Phase 2 : chain 対応の逐次 topo 順 融合 pass。 stepAll + applyAll を 1 つに統合し、
// sub-step 内で「applyPoseAt(t) で全 bone を keyframe pose にリセット」 → 各 entry を
// topo 順に「anchor/boneAxis 読み → step → rotation 書き → updateMatrixWorld(true)」
// で処理する。 これにより chain 子の anchor は「親 spring の物理変位反映後」 の world pos
// を読める。 一斉 stepAll → 一斉 applyAll だと applyPoseAt が全 bone を keyframe pose に
// 戻すため、 chain 子は親の spring 変位を「永遠に見ない」 (= 無限 lag) 問題があった。
// updateMatrixWorld(true) は自分 + 子孫の matrixWorld を伝播 (Blockbench 同梱 Three r129
// の getWorldQuaternion は内部で ancestor 更新するが、 版依存吸収のため明示的に呼ぶ)。
function stepAndApplyOrdered(dt: number): void {
	if (registry.size === 0) return
	const anchorWorld = new THREE.Vector3()
	const boneAxisWorld = new THREE.Vector3()
	const forward = new THREE.Vector3()
	const parentQuat = new THREE.Quaternion()
	const parentInv = new THREE.Quaternion()
	const localForward = new THREE.Vector3()
	const localQuat = new THREE.Quaternion()
	const euler = new THREE.Euler()

	for (const uuid of topoOrder) {
		const entry = registry.get(uuid)
		if (!entry) continue
		const mesh = entry.group?.mesh
		const meshParent = mesh?.parent
		if (!mesh || !meshParent) continue

		if (!getAnchorWorld(entry, anchorWorld)) continue
		if (!getBoneAxisWorld(entry, boneAxisWorld)) continue

		step(entry.state, anchorWorld, boneAxisWorld, entry.config, dt)

		if (!entry.state.initialized) continue

		// world forward を parent local 化 → restLocalDir からこの方向に向ける最短回転を直接計算。
		// 旧 basis 構築 (= forward / right / trueUp + lastRight parallel transport) は
		// trueUp = forward × right が left-handed (= 反射) basis を生み、 setFromRotationMatrix
		// が非単位 quat を返し、 Euler 抽出で角度が「正確に半分」 になっていた (= half-lock の真因)。
		// setFromUnitVectors は restLocalDir → localForward の最短回転を直接計算するので、
		// 反射トラップ + +Y 軸固定仮定 + lastRight hysteresis を一気に解消、 連続性も自然に担保。
		forward.subVectors(entry.state.pos, anchorWorld)
		if (forward.lengthSq() < 1e-8) continue
		forward.normalize()

		meshParent.getWorldQuaternion(parentQuat)
		parentInv.copy(parentQuat).invert()
		localForward.copy(forward).applyQuaternion(parentInv)
		localQuat.setFromUnitVectors(entry.restLocalDir, localForward)

		const order = mesh.rotation.order || 'ZYX'
		euler.setFromQuaternion(localQuat, order)
		mesh.rotation.x = euler.x
		mesh.rotation.y = euler.y
		mesh.rotation.z = euler.z

		// mesh の matrixWorld を伝播 → 次 topo entry (= 子孫方向) が最新の world pos / quat を読める。
		mesh.updateMatrixWorld(true)
	}
}

// 同時刻パス (= tick で sim 進めない、 state 不変で描画のみ更新する経路)。
// この経路では applyPoseAt はこの tick で走らない。 前提は「Blockbench 本体が
// display_animation_frame 発火前に現在時刻 (= 非 snap) の pose を当てている」 こと。
// 状態 (= state.pos) は snap 時刻、 anchor は非 snap 時刻の pose という 1 frame 未満の
// ミスマッチが仕込みだが、 frame 単位では deterministic なので実害なし。
// topo 順に「anchor 読み → rotation 書き → updateMatrixWorld(true)」 で
// 各 entry の物理 state に対応した pose を描画に反映する。
function applyOnlyOrdered(): void {
	if (registry.size === 0) return
	const anchorWorld = new THREE.Vector3()
	const forward = new THREE.Vector3()
	const parentQuat = new THREE.Quaternion()
	const parentInv = new THREE.Quaternion()
	const localForward = new THREE.Vector3()
	const localQuat = new THREE.Quaternion()
	const euler = new THREE.Euler()

	for (const uuid of topoOrder) {
		const entry = registry.get(uuid)
		if (!entry || !entry.state.initialized) continue
		const mesh = entry.group?.mesh
		const meshParent = mesh?.parent
		if (!mesh || !meshParent) continue

		if (!getAnchorWorld(entry, anchorWorld)) continue
		forward.subVectors(entry.state.pos, anchorWorld)
		if (forward.lengthSq() < 1e-8) continue
		forward.normalize()

		meshParent.getWorldQuaternion(parentQuat)
		parentInv.copy(parentQuat).invert()
		localForward.copy(forward).applyQuaternion(parentInv)
		localQuat.setFromUnitVectors(entry.restLocalDir, localForward)

		const order = mesh.rotation.order || 'ZYX'
		euler.setFromQuaternion(localQuat, order)
		mesh.rotation.x = euler.x
		mesh.rotation.y = euler.y
		mesh.rotation.z = euler.z

		mesh.updateMatrixWorld(true)
	}
}

// 全 entry の state を「現時刻 frame の rest 位置」 にリセット (= scrub / 初回 invoke 時)。
// topo 順で走らせて deterministic を確保する (= 単独 bone では順序が意味を持たないが、
// chain の場合は将来的な拡張 (= gravity settle 事前計算等) で親の rest 反映が要る)。
function resetAllToRest(): void {
	const anchorWorld = new THREE.Vector3()
	const boneAxisWorld = new THREE.Vector3()
	const restTip = new THREE.Vector3()
	for (const uuid of topoOrder) {
		const entry = registry.get(uuid)
		if (!entry) continue
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

// 現 simTime から targetTime まで FIXED_DT 単位で sub-step (= cache 経路 + replay の共通実装)。
// Phase 2 以降 : stepAll + applyAll を融合した stepAndApplyOrdered を呼ぶ。
// sub-step ごとに applyPoseAt が keyframe pose を反映してから、 topo 順に物理を進めて
// mesh.rotation を書き込む。 これで chain 子は親の物理変位反映後の world pos を anchor に読める。
function advanceSimTo(targetTime: number): void {
	while (simTime + FIXED_DT <= targetTime + 1e-6) {
		applyPoseAt(simTime + FIXED_DT)
		stepAndApplyOrdered(FIXED_DT)
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

	applyOnlyOrdered()
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
		topoOrder = []
		lastGraphFingerprint = ''
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
		// Property 3 個 (= spring_drag / spring_stiffness / spring_gravity) を Group に register。
		// element_panel input (= 数値 + NumSlider) が edit モードで自動生成される。
		// tick loop は Property が生えている前提で config 値を読むため、 Property 登録が先。
		registerProperties()
		cleanups.push(installTickLoop())
		// animate モード用の専用 Panel を register (= edit モードは element_panel input に任せる)。
		// 値変更時は onSpringPropertyChange 経由で registry sync + fingerprint invalidate される。
		cleanups.push(registerSpringPanel(onSpringPropertyChange))
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
		// Property を Group.properties から delete (= reload 時の二重登録警告回避)。
		// blueprint 側にはシリアライズされた値が残るため、 再 register で自動復帰する。
		unregisterProperties()
		console.log(`[${PLUGIN_ID}] unloaded`)
	},
})
