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
	// paused 中の即時反映用 (= Property 値変更で display_animation_frame を強制 fire、
	// 停止中でも Panel slider の効果が視覚に出る)。
	preview?(): void
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
declare const Action: any
declare const MenuSeparator: any
declare const Undo: any
// BB global : selection 変化を UI 全体に伝播する (= element_panel の input 可視性、
// Panel の display_condition、 outliner ハイライト等が再評価される)。 spring 化 / 解除の
// name 変更後や undo/redo 後に手動で叩いて UI 状態と rig state のズレを解消する。
declare function updateSelection(): void

const PLUGIN_ID = 'spring_bone'
const PLUGIN_VERSION = '0.0.10'

// name prefix `spring_` = spring 化の唯一の truth (= per-group で spring 化を判定する gesture)。
// per-bone UI (= drag / stiffness / gravity の Property + Panel + 右クリ rename sugar) は
// この prefix を前提に register される。
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
// - `Animator.preview()` 明示呼び : playback 停止中は display_animation_frame が
//   自然発火しないため、 fingerprint invalidate だけでは scrub まで値が反映されない。
//   `Animator.preview()` を明示的に呼ぶことで停止中の即時反映を確保する (= 受け入れ条件 (c))。
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
	// **animate モード限定で** Animator.preview を呼ぶ (= Round 2 review MUST-1 regression fix)。
	// element_panel の onChange 経路は modes: ['edit'] で edit 専用、 その場合 Animator.preview は
	// (a) tick() が !Modes?.animate で early-return するため意味がない、 加えて
	// (b) Animator.preview 内の stackAnimations が playing=true の Animation を edit viewport に
	//     適用してしまい pose 破壊 (= animation.js:230 で Animation.select が playing=true を設定、
	//     mode 切替後も flag 保持)。 animate モードのみで呼ぶことで両方回避。
	if (Modes?.animate) {
		try {
			Animator?.preview?.()
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] Animator.preview failed`, e)
		}
	}
}

// spring group name prefix 判定 (= BB 側 condition callback から呼ばれる)。
// **context 2 経路** :
//   (1) Property.merge / copy 経路 = BB core が instance を渡す (= 引数あり)
//   (2) element_panel input.condition 経路 = BB core が **context 無し** で呼ぶ
//       (element_panel.ts:56-58 `method: () => Condition(property.condition)` = 引数省略)
// 引数省略時は Group.first_selected (= 現在 UI で選択中の group) を参照する。
// これで edit モード element_panel でも「選択中 group が spring_ prefix ならば表示」 となる。
// なお、 Property.merge の load 時ordering 問題 (= properties merge → name merge の順、
// group.js:29-33) は本 condition では解消不可 (= merge 時点で name = default 'group')。
// そのため Property 各 instance の `.merge` を override して condition 迂回する
// (= registerProperties 内で instance method 直接差し替え)。
function isSpringGroupForProperty(group?: unknown): boolean {
	if (group === undefined || group === null) {
		// context 無し呼び出し = 現在選択中 group で判定
		const first = (Group as { first_selected?: { name?: unknown } })?.first_selected
		return !!(first && typeof first.name === 'string' && first.name.startsWith(BONE_NAME_PREFIX))
	}
	const name = (group as { name?: unknown }).name
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
				// BB 5.1.4 の NumSlider は type: 'num_slider' で生成される (= 'number' は
				// NumericInput = 数値のみで slider なし)。 UX 要件 (= NumSlider で連続調整) 準拠。
				// value を明示することで element_panel の初期表示が 0 でなく defaultValue になる
				// (= form.ts の value ?? default fallback に確実な値を渡す)。
				input: { label, type: 'num_slider', min, max, step, value: defaultValue },
				onChange: onSpringPropertyChange,
			},
		},
	})

	// Property.merge の load 時 ordering 問題 (= properties merge → name merge の順、
	// group.js:29-33) を回避するため、 各 Property の .merge を override して condition 迂回。
	// data 側に値がある (= 元々 spring_ prefix の group を save した証拠) 場合は無条件 copy。
	// これで .bbmodel reload で 3 パラ値が復帰する (= 受け入れ条件 (a) を満たす)。
	// copy / element_panel visibility は元の condition (= isSpringGroupForProperty) が保持
	// (= 非 spring group への Property 汚染ゼロ)。
	const patchMerge = (prop: any, key: string): void => {
		prop.merge = function (instance: any, data: any) {
			if (data?.[key] === undefined) return
			if (typeof data[key] === 'number' && Number.isFinite(data[key])) {
				instance[key] = data[key]
			}
		}
	}

	const drag_prop = new Property(Group, 'number', 'spring_drag', makeConfig('Spring drag', DEFAULT_CONFIG.drag, 0, 1, 0.01))
	const stiffness_prop = new Property(Group, 'number', 'spring_stiffness', makeConfig('Spring stiffness', DEFAULT_CONFIG.stiffness, 0, 10, 0.1))
	const gravity_prop = new Property(Group, 'number', 'spring_gravity', makeConfig('Spring gravity', DEFAULT_CONFIG.gravity, 0, 100, 1))

	patchMerge(drag_prop, 'spring_drag')
	patchMerge(stiffness_prop, 'spring_stiffness')
	patchMerge(gravity_prop, 'spring_gravity')
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

// Group 右クリ context menu に「Spring 化 / Spring 解除」 の 2 action を追加する。
// 実装 gesture (= 唯一の truth) は依然 name prefix (= `spring_`) の付け外し。
// action は BB core の Group.prototype.menu.structure に append され、 group 右クリで表示される。
// condition で「対象 group の prefix 状態」 に応じて片方のみを visible にする (= mutually exclusive)。
let registeredMenuEntries: unknown[] = []

function hasSpringPrefix(name: unknown): boolean {
	return typeof name === 'string' && name.startsWith(BONE_NAME_PREFIX)
}

// context が Group instance かの判定。 Group.all は BB core が全 Group を保持する list。
// Action.trigger() 内での condition 再評価時に渡される context (= Action instance) を弾き、
// menu 表示時の clicked Group context のみ採用するために使う (= Sol Round 3 MUST-1 の fix)。
function isRealGroup(context: unknown): boolean {
	if (!context) return false
	const all = (Group as { all?: unknown[] })?.all
	if (!Array.isArray(all)) return false
	return all.includes(context)
}

// action の condition 判定範囲を click 側 (= multi_selected 経由の走査) と一致させる helper。
// 問題 (Sol Round 2 MUST-3 = recursive / Sol Round 3 MUST-2 = 単独) : condition が「context =
// clicked Group / first_selected 1 個」 で判定していたため、 Action.trigger 経路 (= keybind 等、
// context = Action instance の fallback で first_selected を使う) と click の multi_selected 走査で
// 範囲がズレ、 「状態が異なる複数 Group 選択時に表示は出るが click で発火しない」 症状。
// fix = menu 表示経路 (context = Group instance) は context を対象、 それ以外は multi_selected
// 全体 (= click と一致する走査、 空なら first_selected fallback) を対象に predicate を評価する。
// recursive=true の時は各 group の子孫まで再帰、 recursive=false の時は group 単発で判定。
function evaluateActionScope(
	context: unknown,
	predicate: (group: unknown) => boolean,
	recursive: boolean,
): boolean {
	if (isRealGroup(context)) {
		if (recursive) {
			for (const g of collectGroupAndDescendants(context)) {
				if (predicate(g)) return true
			}
			return false
		}
		return predicate(context)
	}
	const multi = ((Group as { multi_selected?: unknown[] })?.multi_selected ?? []) as unknown[]
	const sources: unknown[] = multi.length > 0
		? multi
		: [(Group as { first_selected?: unknown })?.first_selected].filter(Boolean)
	for (const s of sources) {
		if (recursive) {
			for (const g of collectGroupAndDescendants(s)) {
				if (predicate(g)) return true
			}
		} else {
			if (predicate(s)) return true
		}
	}
	return false
}

// 指定 group + 全子孫 Group を DFS で列挙 (= 子孫再帰 spring 化用)。
// - Group instance のみ収集 (= Cube / Element 等は除外)
// - 循環回避 = visited Set (BB の Group tree では通常発生しないが malformed state 防御)
// - 順序 = pre-order DFS (= 親 → 子)、 rename 側では順序に依存しないが consistency のため
function collectGroupAndDescendants(root: unknown): unknown[] {
	const result: unknown[] = []
	const visited = new Set<object>()
	const stack: unknown[] = [root]
	while (stack.length > 0) {
		const g = stack.pop()
		if (!g || typeof g !== 'object' || visited.has(g)) continue
		visited.add(g)
		if (!(g instanceof Group)) continue
		result.push(g)
		const children = (g as { children?: unknown[] }).children
		if (Array.isArray(children)) {
			// stack に push する順は子孫方向、 順序保持したいので逆順 push
			for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
		}
	}
	return result
}

function registerContextMenuActions(): void {
	if (typeof Action !== 'function' || typeof MenuSeparator !== 'function') {
		console.warn(`[${PLUGIN_ID}] Action or MenuSeparator not available, skipping context menu registration`)
		return
	}
	const menu = (Group as { prototype?: { menu?: { structure?: unknown[] } } })?.prototype?.menu
	if (!menu || !Array.isArray(menu.structure)) {
		console.warn(`[${PLUGIN_ID}] Group.prototype.menu.structure not available, skipping context menu registration`)
		return
	}

	const springify = new Action(`${PLUGIN_ID}_springify`, {
		name: 'Spring 化',
		icon: 'gesture',
		// menu 表示は clicked Group 単独、 Action.trigger 経由 (= keybind 等) は multi_selected 全体
		// (空なら first_selected fallback) を対象に「非 spring group が 1 個でもあるか」 で判定。
		// 判定範囲を click 側 (= multi_selected filter) と一致させ、 状態が異なる複数選択で
		// 「表示されるが発火しない」 症状を排除する (Sol Round 3 MUST-2 = 単独 action 側の同型 bug)。
		condition: (context?: unknown) =>
			evaluateActionScope(context, (g) =>
				!hasSpringPrefix((g as { name?: unknown } | null)?.name),
			false),
		click() {
			const groups = ((Group as { multi_selected?: unknown[] })?.multi_selected ?? []).filter(
				(g) => !hasSpringPrefix((g as { name?: unknown } | null)?.name),
			) as Array<{ name: string }>
			if (groups.length === 0) return
			try {
				Undo?.initEdit?.({ groups })
				for (const g of groups) g.name = `${BONE_NAME_PREFIX}${g.name}`
				Undo?.finishEdit?.('Spring 化')
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] springify failed`, e)
			}
			// rename 直後に registry を再構築 (= 新規 spring group を pick up、 fingerprint 変化で
			// 次 tick に 0 replay 起動)。 これで context menu 直後の物理追従が selection 変更を
			// 待たずに即発火する (= 受け入れ条件 (f) の物理側)。
			try {
				rescanRegistry()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] rescanRegistry failed after springify`, e)
			}
			// BB core の updateSelection を叩いて element_panel input の可視性 + Panel display_condition を
			// 再評価させる。 これが無いと直後の UI 状態が古いままで「toggle が逆に動いたように見える」
			// 感覚を生む (= 症状 3 toggle 逆挙動の primary)。
			try {
				updateSelection()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] updateSelection failed after springify`, e)
			}
			// animate モード時は preview 明示 refresh、 mesh.rotation を最新 rig state に追従させる。
			if (Modes?.animate) {
				try {
					Animator?.preview?.()
				} catch (e) {
					console.warn(`[${PLUGIN_ID}] preview refresh failed after springify`, e)
				}
			}
		},
	})

	const unspringify = new Action(`${PLUGIN_ID}_unspringify`, {
		name: 'Spring 解除',
		icon: 'link_off',
		// springify 側と対称の evaluateActionScope 経由判定 (Sol Round 3 MUST-2)。
		// 「spring group が 1 個でも選択範囲にあれば表示」、 click 側 (multi_selected filter) と一致する
		// 走査で、 混在選択時の表示発火食い違い排除。
		// 名前がちょうど `spring_` (= prefix のみで本体空) の Group は除外 = click 側の長さ guard と揃える
		// (Sol Round 4 IMO-1、 表示されるが click で発火しない見せかけを排除)。
		condition: (context?: unknown) =>
			evaluateActionScope(context, (g) => {
				const n = (g as { name?: unknown } | null)?.name
				return typeof n === 'string' && n.startsWith(BONE_NAME_PREFIX) && n.length > BONE_NAME_PREFIX.length
			}, false),
		click() {
			// prefix 除去後に空文字にならない (= 「spring_」 だけの group を弾く、 N-3 guard) 条件込みで filter。
			const groups = ((Group as { multi_selected?: unknown[] })?.multi_selected ?? []).filter(
				(g) => {
					const n = (g as { name?: unknown } | null)?.name
					return typeof n === 'string' && n.startsWith(BONE_NAME_PREFIX) && n.length > BONE_NAME_PREFIX.length
				},
			) as Array<{ name: string }>
			if (groups.length === 0) return
			try {
				Undo?.initEdit?.({ groups })
				for (const g of groups) g.name = g.name.slice(BONE_NAME_PREFIX.length)
				Undo?.finishEdit?.('Spring 解除')
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] unspringify failed`, e)
			}
			// rename 直後に registry を再構築 (= 解除された group を registry から除外、 fingerprint 変化で
			// 次 tick に replay 起動)。 これで残存 spring group の物理が selection 変更を待たずに継続する。
			try {
				rescanRegistry()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] rescanRegistry failed after unspringify`, e)
			}
			// updateSelection = UI 状態 (= element_panel input 可視性、 Panel display_condition) を最新化。
			try {
				updateSelection()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] updateSelection failed after unspringify`, e)
			}
			// 凍結解決の primary fix : 登録解除後、 mesh.rotation には plugin が最後に書いた
			// 物理姿勢が残る。 paused / 純物理 bone (= keyframe を持たない) の場合、
			// showDefaultPose → stackAnimations の loop が「何も当てない」 状態で rest 固定となり
			// 「アニメーションが完全停止」 に見える (= 症状 3 凍結の真因)。 Animator.preview を明示発火し
			// 現在 Timeline.time の pose を apply して mesh.rotation を上書きすることで、
			// 解除された bone の visual が最新 animation state に追従する。
			if (Modes?.animate) {
				try {
					Animator?.preview?.()
				} catch (e) {
					console.warn(`[${PLUGIN_ID}] preview refresh failed after unspringify`, e)
				}
			}
		},
	})

	// 子孫再帰版の spring 化 sub-action (= 選択 group + 全子孫を一括で spring 化)。
	// 単独 spring 化 (= springify) は残す、 opt-in で子孫再帰版を選ぶ形。
	// condition = 選択 group または子孫のいずれかが非 spring group であれば表示
	// (= 選択部分木が既に全 spring 化済みなら意味ないので隠す)。
	const springify_recursive = new Action(`${PLUGIN_ID}_springify_recursive`, {
		name: 'Spring 化 (子孫含む)',
		icon: 'account_tree',
		condition: (context?: unknown) =>
			evaluateActionScope(context, (g) =>
				!hasSpringPrefix((g as { name?: unknown } | null)?.name),
			true),
		click() {
			// multi-select 対応 = 選択中の全 root group と、 各々の子孫全部を集める
			// (= uuid dedup で「兄弟同士で親子関係にある」 malformed 選択も安全)
			const selected = ((Group as { multi_selected?: unknown[] })?.multi_selected ?? []) as unknown[]
			const seenUuids = new Set<string>()
			const targets: Array<{ name: string }> = []
			for (const s of selected) {
				for (const g of collectGroupAndDescendants(s)) {
					const uuid = (g as { uuid?: unknown } | null)?.uuid
					if (typeof uuid !== 'string' || seenUuids.has(uuid)) continue
					seenUuids.add(uuid)
					if (!hasSpringPrefix((g as { name?: unknown } | null)?.name)) {
						targets.push(g as { name: string })
					}
				}
			}
			if (targets.length === 0) return
			try {
				Undo?.initEdit?.({ groups: targets })
				for (const g of targets) g.name = `${BONE_NAME_PREFIX}${g.name}`
				Undo?.finishEdit?.('Spring 化 (子孫含む)')
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] springify_recursive failed`, e)
			}
			// springify と同一の後処理 (= registry sync + UI 状態更新 + preview refresh)
			try {
				rescanRegistry()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] rescanRegistry failed after springify_recursive`, e)
			}
			try {
				updateSelection()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] updateSelection failed after springify_recursive`, e)
			}
			if (Modes?.animate) {
				try {
					Animator?.preview?.()
				} catch (e) {
					console.warn(`[${PLUGIN_ID}] preview refresh failed after springify_recursive`, e)
				}
			}
		},
	})

	// 子孫再帰版の spring 解除 sub-action (= 選択 group + 全子孫の spring_ prefix を一括剥がし)。
	// springify_recursive の対称版、 chain 途中で不用意に spring 化した range を一気に戻す用途。
	const unspringify_recursive = new Action(`${PLUGIN_ID}_unspringify_recursive`, {
		name: 'Spring 解除 (子孫含む)',
		icon: 'link_off',
		// 選択部分木 (context or multi_selected) に対象があれば表示、 evaluateActionScope で
		// click 側 (= multi_selected 走査) と一致する範囲判定 = Action.trigger 経路の食い違い解消
		condition: (context?: unknown) =>
			evaluateActionScope(context, (g) => {
				const n = (g as { name?: unknown } | null)?.name
				return typeof n === 'string' && n.startsWith(BONE_NAME_PREFIX) && n.length > BONE_NAME_PREFIX.length
			}, true),
		click() {
			const selected = ((Group as { multi_selected?: unknown[] })?.multi_selected ?? []) as unknown[]
			const seenUuids = new Set<string>()
			const targets: Array<{ name: string }> = []
			for (const s of selected) {
				for (const g of collectGroupAndDescendants(s)) {
					const uuid = (g as { uuid?: unknown } | null)?.uuid
					if (typeof uuid !== 'string' || seenUuids.has(uuid)) continue
					seenUuids.add(uuid)
					const n = (g as { name?: unknown } | null)?.name
					if (typeof n === 'string' && n.startsWith(BONE_NAME_PREFIX) && n.length > BONE_NAME_PREFIX.length) {
						targets.push(g as { name: string })
					}
				}
			}
			if (targets.length === 0) return
			try {
				Undo?.initEdit?.({ groups: targets })
				for (const g of targets) g.name = g.name.slice(BONE_NAME_PREFIX.length)
				Undo?.finishEdit?.('Spring 解除 (子孫含む)')
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] unspringify_recursive failed`, e)
			}
			try {
				rescanRegistry()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] rescanRegistry failed after unspringify_recursive`, e)
			}
			try {
				updateSelection()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] updateSelection failed after unspringify_recursive`, e)
			}
			if (Modes?.animate) {
				try {
					Animator?.preview?.()
				} catch (e) {
					console.warn(`[${PLUGIN_ID}] preview refresh failed after unspringify_recursive`, e)
				}
			}
		},
	})

	// Group.prototype.menu.structure に append (= 「rename」「delete」 の末尾に並ぶ)。
	const sep = new MenuSeparator(`${PLUGIN_ID}_actions`)
	menu.structure.push(sep, springify, springify_recursive, unspringify, unspringify_recursive)
	registeredMenuEntries.push(sep, springify, springify_recursive, unspringify, unspringify_recursive)
}

function unregisterContextMenuActions(): void {
	const menu = (Group as { prototype?: { menu?: { structure?: unknown[] } } })?.prototype?.menu
	if (menu?.structure && Array.isArray(menu.structure)) {
		menu.structure = menu.structure.filter((entry) => !registeredMenuEntries.includes(entry))
	}
	for (const entry of registeredMenuEntries) {
		try {
			;(entry as { delete?: () => void })?.delete?.()
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] action.delete failed`, e)
		}
	}
	registeredMenuEntries = []
}

// 別軸 B : Outliner 上の spring_ prefix group を視覚的に区別する軽量マーカー。
// - <style> で `.outliner_object.spring-bone-marker` に淡い teal 色を付与
// - BB Outliner (= outliner.js:1183+) は Vue で描画、 group name は `input.cube_name` の value
//   にバインドされる (= v-model)。 value 変化は DOM attribute には反映されないため、
//   MutationObserver + BB event の 2 経路で scan トリガを取る。
// - scanOutlinerMarkers = document 内 全 `.outliner_object.group` を走査、
//   input.cube_name.value が spring_ 始まりなら class 付与、 それ以外なら剥がす。
// - 副作用ゼロ (= class 追加のみ、 group 内部データは触らない)、 unload で完全クリーンアップ。
const OUTLINER_MARKER_CLASS = 'spring-bone-marker'
const OUTLINER_MARKER_STYLE_ID = 'spring-bone-outliner-marker-style'

function scanOutlinerMarkers(): void {
	const objects = document.querySelectorAll('.outliner_object.group')
	for (let i = 0; i < objects.length; i++) {
		const obj = objects[i] as HTMLElement
		const input = obj.querySelector('input.cube_name') as HTMLInputElement | null
		const name = input?.value
		const should = typeof name === 'string' && name.startsWith(BONE_NAME_PREFIX)
		if (should) {
			obj.classList.add(OUTLINER_MARKER_CLASS)
		} else {
			obj.classList.remove(OUTLINER_MARKER_CLASS)
		}
	}
}

function registerOutlinerMarker(): () => void {
	// <style> を head に注入 (= reload 時の重複対策で既存 id は除去してから append)。
	// 色 = 落ち着いた teal (= spring / hair 系連想)、 淡い accent で他の outliner mark
	// (= selected 反転、 color scope) と衝突しない。 icon 色は !important で BB 側の
	// dynamic-icon color prop に優先させる (= outliner.js:1207)。
	document.getElementById(OUTLINER_MARKER_STYLE_ID)?.remove()
	const styleEl = document.createElement('style')
	styleEl.id = OUTLINER_MARKER_STYLE_ID
	styleEl.textContent = `
		/* :not(.selected) で BB 標準の選択色 (= .outliner_object.selected の background) と
		   共存させる (Sol Round 2 WANT-3、 同 specificity かつ後勝ちで選択色が消える問題)。
		   選択時は左端 box-shadow だけ残して spring group であることを示す。 */
		.outliner_object.${OUTLINER_MARKER_CLASS}:not(.selected) {
			background: linear-gradient(90deg, rgba(64, 192, 176, 0.16), rgba(64, 192, 176, 0.04) 60%, transparent);
		}
		.outliner_object.${OUTLINER_MARKER_CLASS} {
			box-shadow: inset 3px 0 0 rgba(64, 192, 176, 0.7);
		}
		/* BB dynamic-icon 実 class = .material-icons.notranslate.icon (js/api.ts:132-134)、
		   前 revision の .icon-material セレクタは空振りだった (Opus IMO-1)。
		   :not(.outliner_toggle) で visibility / lock 等の Material Icon toggle を除外
		   (outliner.js:1211-1219、 Sol Round 2 NITS)、 primary folder icon だけ teal に染める。 */
		.outliner_object.${OUTLINER_MARKER_CLASS} > i.material-icons.icon:not(.outliner_toggle) {
			color: rgba(64, 192, 176, 0.95) !important;
		}
	`
	document.head.appendChild(styleEl)

	// MutationObserver : outliner root (= #cubes_list) 配下の childList / subtree 変化で
	// 再 scan。 group 追加 / 削除 / expand / undo redo による DOM 差し替えを拾う。
	// attributeFilter は使わない (= Vue の v-model は attribute 経由でなく property 経由で
	// 書くため、 attribute 監視では拾えず、 childList / subtree だけで十分)。
	const outlinerRoot = document.getElementById('cubes_list') ?? document.body
	let scanScheduled = false
	const scheduleScan = (): void => {
		if (scanScheduled) return
		scanScheduled = true
		requestAnimationFrame(() => {
			scanScheduled = false
			try {
				scanOutlinerMarkers()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] scanOutlinerMarkers failed`, e)
			}
		})
	}
	const mo = new MutationObserver(scheduleScan)
	mo.observe(outlinerRoot, { childList: true, subtree: true })

	// BB event 経路 : 選択 / rename / undo redo の直後にも scan を走らせる
	// (= v-model 経由の value 変更は MutationObserver では拾えないため二重化)。
	// `finished_edit` は BB core が Undo commit 完了直後に fire (= js/undo.js:95)、
	// これで outliner 上の dblclick → 直接 rename 確定経路 (= outliner_node.ts saveName)
	// も他イベント待ちにならず即時ハイライト追従する (Opus WANT-1)。
	Blockbench.on('update_selection', scheduleScan)
	Blockbench.on('undo', scheduleScan)
	Blockbench.on('redo', scheduleScan)
	Blockbench.on('select_project', scheduleScan)
	Blockbench.on('finished_edit', scheduleScan)

	// 初回 scan (= plugin load 時に既存 spring group を pick up)
	scheduleScan()

	return (): void => {
		mo.disconnect()
		Blockbench.removeListener?.('update_selection', scheduleScan)
		Blockbench.removeListener?.('undo', scheduleScan)
		Blockbench.removeListener?.('redo', scheduleScan)
		Blockbench.removeListener?.('select_project', scheduleScan)
		Blockbench.removeListener?.('finished_edit', scheduleScan)
		document.getElementById(OUTLINER_MARKER_STYLE_ID)?.remove()
		// 残っているマーカー class を全部剥がす (= reload 時の視覚残留を防ぐ)
		try {
			const marked = document.querySelectorAll(`.outliner_object.${OUTLINER_MARKER_CLASS}`)
			for (let i = 0; i < marked.length; i++) {
				marked[i].classList.remove(OUTLINER_MARKER_CLASS)
			}
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] outliner marker cleanup failed`, e)
		}
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
	// 6 座標 finite validate (= 潜在バグ Codex HIGH)。 手入力 .bbmodel や NumSlider Molang 経路
	// (= BB actions.ts:1421-1435) で NaN / Infinity が origin に紛れ込むと、 dx / length が
	// NaN 伝播し restLocalDir / restLength → step / setFromUnitVectors → mesh.rotation まで
	// 汚染される (= NaN quaternion が rendering 全体を狂わす)。 6 座標いずれかが非 finite なら
	// 「無効な rig」 扱いで invariance を返す。
	const p0 = parent.origin[0]
	const p1 = parent.origin[1]
	const p2 = parent.origin[2]
	const c0 = child.origin[0]
	const c1 = child.origin[1]
	const c2 = child.origin[2]
	if (
		!Number.isFinite(p0) || !Number.isFinite(p1) || !Number.isFinite(p2) ||
		!Number.isFinite(c0) || !Number.isFinite(c1) || !Number.isFinite(c2)
	) {
		return { dir: null, length: 0 }
	}
	const dx = c0 - p0
	const dy = c1 - p1
	const dz = c2 - p2
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
	// 既存 entry がある場合は group 参照を張り替えて return。 uuid 同一で instance 別のケース
	// (= project 再オープン / delete → undo で新 Group instance 生成、 BB undo.js:509) が発生する。
	// outliner_node の get mesh() は uuid 解決なので stale でも物理は動くが、 readSpringProp /
	// element_panel / Panel からの書き込みは旧 instance を read/write するため、 UI 変更が
	// entry.config に永遠に届かない (= 実機で観察された「値変更が preview に反映されない」
	// 症状 primary root cause)。 参照だけ張り替えれば両者が繋がる、 state (= 慣性など) は保持。
	const existing = registry.get(group.uuid)
	if (existing) {
		existing.group = group
		return
	}
	// element_panel の setValues stale value 問題対策 (= Round 1 review W-2)。
	// instance property が undefined だと form.setValues が「値 undefined = skip」 で
	// 前の group の値を form に残してしまう。 spring 化した新規 group に対し
	// DEFAULT_CONFIG 値を明示的に生やすことで setValues が確実に上書きできる状態にする。
	// blueprint 側の値は custom .merge で復元済のためここでは既存値を上書きしない。
	if (typeof group.spring_drag !== 'number') group.spring_drag = DEFAULT_CONFIG.drag
	if (typeof group.spring_stiffness !== 'number') group.spring_stiffness = DEFAULT_CONFIG.stiffness
	if (typeof group.spring_gravity !== 'number') group.spring_gravity = DEFAULT_CONFIG.gravity
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
// tick 中は Timeline.time を snap 時刻に一時的に書き換えるため、 退避 → 復元で playhead
// UI との乖離累積を防ぐ (= 潜在バグ Fable #4)。 tick は毎 frame 呼ばれる + snap 時刻は最大
// 半 FIXED_DT 分ズレるため、 復元しないと ms 単位のズレが累積して UI が微振動する余地がある。
function applyPoseAt(time: number): void {
	if (typeof Animator?.showDefaultPose !== 'function') return
	if (typeof Animator?.stackAnimations !== 'function') return
	inhibitTick = true
	const tl: any = Timeline
	const savedTime = tl?.time
	try {
		if (tl) tl.time = time
		Animator.showDefaultPose(true)
		const animSelected = (Animation as any)?.selected
		const stack: any[] = animSelected
			? [animSelected]
			: ((Animation as any)?.all ?? []).filter((a: any) => a?.playing)
		Animator.stackAnimations(stack, false)
		Canvas?.scene?.updateMatrixWorld?.(true)
	} finally {
		// 元の Timeline.time を復元 (= 呼び出し元の期待する playhead 状態を保つ)。
		// tl.time が undefined だった場合 (= Timeline 未初期化) は復元不要。
		if (tl && savedTime !== undefined) tl.time = savedTime
		inhibitTick = false
	}
}

// pose transaction : BB core が display_animation_frame 直前に当てた「正しい current pose」
// (= 全 animation / blend / controller 適用済の状態) を snapshot、 sub-step の applyPoseAt が
// 全 bone の pose を書き換えても finally で確実に復元する。 これで registry 限定 write-back の
// 非対称 (= 解除済み bone / 非 spring bone が「applyPoseAt が最後に残した pose」 のまま取り残される)
// を排除、 root bone 解除 → keyframe animation 完全停止 bug の根本 fix となる (Sol 推し fix、
// 見落としバグ 1-6 も同経路で連鎖解消)。
// snapshot 対象 = Project.groups (= Group instance) **と** Project.elements (= Cube / Mesh /
// NullObject / ArmatureBone / Locator 等) の両方。 BB の stackAnimations は Group.all.concat(
// Outliner.elements) を対象に animator を回すため (= animation_mode.js:321)、 NullObject や
// ArmatureBone も独立 keyframe channel を持ち applyPoseAt で書き換わる。 Group だけ snapshot
// では NullObject/ArmatureBone の keyframe animation が「最後の sub-step の snap 時刻 pose」 に
// 取り残される別ノード種別版 root-bone bug が残る (Opus MUST-1)。
// mesh 参照は seen Set で dedup、 Cube のように「keyframe channel を持たず親追従だけ」 の要素も
// 含まれるが restore で書き戻すのは no-op で実害なし、 判定コスト回避を優先。
// pre_rotation は BB Group の Object3D 拡張 property (= `js/outliner/types/group.js` で追加)。
// stackAnimations が sub-step ごとに書き換えるが、 従来の snapshot は position/quaternion/scale のみで
// pre_rotation を復元してなかった。 複数 animation stack 中に scrub → 回転キー編集すると、
// pre_rotation が最後の sub-step 時刻の値のまま残り「基準角ずれで keyframe が汚染される」
// (Sol Round 2 MUST-2)。 存在有無 + xyz + order を snapshot し、 存在する mesh だけ復元する。
interface AnimatorPoseSnapshot {
	entries: Array<{
		mesh: any
		px: number
		py: number
		pz: number
		qx: number
		qy: number
		qz: number
		qw: number
		sx: number
		sy: number
		sz: number
		hasPre: boolean
		prx: number
		pry: number
		prz: number
		pro: string
	}>
}

function captureAnimatorPose(): AnimatorPoseSnapshot {
	const entries: AnimatorPoseSnapshot['entries'] = []
	const seen = new Set<object>()
	const pushMesh = (mesh: any): void => {
		if (!mesh || typeof mesh !== 'object' || seen.has(mesh)) return
		seen.add(mesh)
		const pre = mesh.pre_rotation
		const hasPre = !!(pre && typeof pre === 'object' && typeof pre.x === 'number')
		entries.push({
			mesh,
			px: mesh.position.x, py: mesh.position.y, pz: mesh.position.z,
			qx: mesh.quaternion.x, qy: mesh.quaternion.y, qz: mesh.quaternion.z, qw: mesh.quaternion.w,
			sx: mesh.scale.x, sy: mesh.scale.y, sz: mesh.scale.z,
			hasPre,
			prx: hasPre ? pre.x : 0,
			pry: hasPre ? pre.y : 0,
			prz: hasPre ? pre.z : 0,
			pro: hasPre && typeof pre.order === 'string' ? pre.order : 'XYZ',
		})
	}
	const groups = (Project as { groups?: unknown[] } | null)?.groups
	if (Array.isArray(groups)) {
		for (const g of groups) {
			if (!(g instanceof Group)) continue
			pushMesh((g as { mesh?: any }).mesh)
		}
	}
	// Project.elements (= Outliner.elements 相当、 outliner.js:14) の中の pose 保持ノードを追加
	// snapshot。 NullObject / ArmatureBone は独立 animator を持つので必ず対象、 Cube 等も含めて
	// 一律 snapshot する (= 判定コスト回避、 write-back は BB の Object3D property set のみ)。
	const elements = (Project as { elements?: unknown[] } | null)?.elements
	if (Array.isArray(elements)) {
		for (const e of elements) {
			if (!e || typeof e !== 'object') continue
			pushMesh((e as { mesh?: any }).mesh)
		}
	}
	return { entries }
}

function restoreAnimatorPose(snap: AnimatorPoseSnapshot): void {
	for (let i = 0; i < snap.entries.length; i++) {
		const e = snap.entries[i]
		e.mesh.position.set(e.px, e.py, e.pz)
		e.mesh.quaternion.set(e.qx, e.qy, e.qz, e.qw)
		e.mesh.scale.set(e.sx, e.sy, e.sz)
		// pre_rotation は BB group.js の rest Euler 相当 = stackAnimations 経由で書き換わるため、
		// restore しないと複数 animation stack + 回転キー編集時に基準角ずれで keyframe が汚染される
		// (Sol Round 2 MUST-2、 pose transaction の完全性)。
		// hasPre=false ケースは **delete で property そのものを消去** する (Sol Round 4 MUST-1)。
		// xyz=0 埋めだと BB 本体の `mesh.pre_rotation ?? mesh.fix_rotation` fallback が阻害されて
		// 「不存在」 と等価にならず、 非ゼロ rest rotation が無視されるため、 property そのものを
		// delete して fallback を有効化する必要がある。
		if (e.mesh.pre_rotation) {
			if (e.hasPre) {
				e.mesh.pre_rotation.x = e.prx
				e.mesh.pre_rotation.y = e.pry
				e.mesh.pre_rotation.z = e.prz
				if (typeof e.mesh.pre_rotation.order === 'string') {
					e.mesh.pre_rotation.order = e.pro
				}
			} else {
				delete e.mesh.pre_rotation
			}
		}
	}
}

function getAnchorWorld(entry: BoneEntry, out: any): boolean {
	const mesh = entry.group.mesh
	if (!mesh) return false
	out.setFromMatrixPosition(mesh.matrixWorld)
	return true
}

// Sol advice の Δ 加算合成 helper (= 「rest 直代入」 の keyframe 上書きを排除)。
// 記号 :
//   r          = entry.restLocalDir (parent-local frame の rest bone 軸単位ベクトル)
//   q_base     = 現時点の mesh.quaternion (= keyframe pose、 sub-step では applyPoseAt が当てた
//                「時刻 t の keyframe pose」、 同時刻パスでは BB core が当てた「現時刻 pose」)
//   q_parentW  = mesh.parent の world quaternion
//   d_simW     = normalize(state.pos - anchorWorld) (物理 tip 方向、 world 座標)
//   d_animP    = normalize(r) (rest bone 軸、 parent-local、 own-rotation 独立化で qBase 除外)
//   d_simP     = normalize(inverse(q_parentW) × d_simW) (物理シム目標、 parent-local)
//   ΔP        = setFromUnitVectors(d_animP, d_simP) (keyframe → 物理 の parent-local swing)
//   q_final   = ΔP × q_base (前乗算)
// 静的 rest からの delta をそのまま代入していた旧経路は、 現行 keyframe rotation の上に
// 「rest→物理」 を二重適用する形になり keyframe pose が消えていた (= 既存アニメパラ無視症状)。
// 4 step 化で keyframe rotation を保存しつつ物理揺れ delta を parent-local で prepend する。
// own-rotation 独立化 (2026-07-10) 以降、 solver 目標 boneAxisWorld と d_animP は q_parentW × r 基準に
// 統一 (= 自身の q_base を solver 目標 + Δ 合成基準から排除、 親 rotation は q_parentW 経由で反映)。
function composeSpringPose(
	entry: BoneEntry,
	dt: number,
	stepSim: boolean,
	scratch: {
		anchorWorld: any
		boneAxisWorld: any
		forward: any
		parentQuat: any
		parentInv: any
		qBase: any
		deltaP: any
		dAnimP: any
		dSimP: any
	},
): void {
	const mesh = entry.group?.mesh
	const meshParent = mesh?.parent
	if (!mesh || !meshParent) return

	scratch.qBase.copy(mesh.quaternion)
	meshParent.getWorldQuaternion(scratch.parentQuat)

	if (!getAnchorWorld(entry, scratch.anchorWorld)) return

	if (stepSim) {
		// boneAxisWorld = q_parentW × restLocalDir (own-rotation 独立化、 自身の keyframe rotation を
		// solver 目標から排除。 親の rotation は q_parentW 経由で反映される)。
		scratch.boneAxisWorld.copy(entry.restLocalDir).applyQuaternion(scratch.parentQuat)
		step(entry.state, scratch.anchorWorld, scratch.boneAxisWorld, entry.config, dt)
	}

	if (!entry.state.initialized) return

	// d_simW = state.pos - anchorWorld (world 方向)、 lengthSq guard で 0 除算防止
	scratch.forward.subVectors(entry.state.pos, scratch.anchorWorld)
	if (scratch.forward.lengthSq() < 1e-8) return
	scratch.forward.normalize()

	// d_animP = restLocalDir (parent-local frame の rest bone 軸、 own-rotation 独立化で qBase 削除)
	scratch.dAnimP.copy(entry.restLocalDir).normalize()

	// d_simP = inv(q_parentW) × d_simW (world → parent-local)
	scratch.parentInv.copy(scratch.parentQuat).invert()
	scratch.dSimP.copy(scratch.forward).applyQuaternion(scratch.parentInv).normalize()

	// ΔP = setFromUnitVectors(d_animP, d_simP) : rest → 物理 の parent-local swing (own-rotation 独立化後)。
	// setFromUnitVectors は twist を生成しない = twist を保存 (Sol 見落としバグ 9、
	// 180 度反転付近では回転軸が不連続になり得るが hemisphere 選択は今回未対応 = 次段課題)。
	scratch.deltaP.setFromUnitVectors(scratch.dAnimP, scratch.dSimP)

	// q_final = ΔP × q_base (parent-local 前乗算 = premultiply)。
	// mesh.quaternion への直接書き込みで Three.js の Object3D は rotation を自動同期
	// (= quaternion.onChange で euler も同期、 mesh.rotation.x/y/z は自然に最新値になる)。
	mesh.quaternion.copy(scratch.qBase).premultiply(scratch.deltaP)

	// matrixWorld 伝播 → 次 topo entry (= 子孫方向) が親 Δ 反映後の anchor / q_parentW を読める。
	mesh.updateMatrixWorld(true)
}

function makeComposeScratch(): {
	anchorWorld: any
	boneAxisWorld: any
	forward: any
	parentQuat: any
	parentInv: any
	qBase: any
	deltaP: any
	dAnimP: any
	dSimP: any
} {
	return {
		anchorWorld: new THREE.Vector3(),
		boneAxisWorld: new THREE.Vector3(),
		forward: new THREE.Vector3(),
		parentQuat: new THREE.Quaternion(),
		parentInv: new THREE.Quaternion(),
		qBase: new THREE.Quaternion(),
		deltaP: new THREE.Quaternion(),
		dAnimP: new THREE.Vector3(),
		dSimP: new THREE.Vector3(),
	}
}

// Phase 2 : chain 対応の逐次 topo 順 融合 pass。 stepAll + applyAll を 1 つに統合し、
// sub-step 内で「applyPoseAt(t) で全 bone を keyframe pose にリセット」 → 各 entry を
// topo 順に「anchor 読み → step → Δ 合成 (= composeSpringPose) → updateMatrixWorld(true)」
// で処理する。 これにより chain 子の anchor は「親 spring の Δ 反映後」 の world pos を読める。
// updateMatrixWorld(true) は自分 + 子孫の matrixWorld を伝播 (Blockbench 同梱 Three r129
// の getWorldQuaternion は内部で ancestor 更新するが、 版依存吸収のため明示的に呼ぶ)。
function stepAndApplyOrdered(dt: number): void {
	if (registry.size === 0) return
	const scratch = makeComposeScratch()
	for (const uuid of topoOrder) {
		const entry = registry.get(uuid)
		if (!entry) continue
		composeSpringPose(entry, dt, true, scratch)
	}
}

// 同時刻パス (= tick で sim 進めない、 state 不変で描画のみ更新する経路)。
// pose transaction 化以後は毎 tick 末尾で restore 直後に呼ばれる = mesh.quaternion に
// BB core の「現時刻 keyframe pose」 が乗った状態から Δ を prepend し直す。
// これで restore で消えた spring 揺れが再描画される + keyframe rotation は保存される。
function applyOnlyOrdered(): void {
	if (registry.size === 0) return
	const scratch = makeComposeScratch()
	for (const uuid of topoOrder) {
		const entry = registry.get(uuid)
		if (!entry || !entry.state.initialized) continue
		composeSpringPose(entry, 0, false, scratch)
	}
}

// 全 entry の state を「現時刻 frame の rest 位置」 にリセット (= scrub / 初回 invoke 時)。
// rest 姿勢基準 = q_parentW × restLocalDir で restTip を計算。 own-rotation 独立化により
// qBase は初期化から排除 (= scrub / replay 開始時の qBase 混入回避)。
function resetAllToRest(): void {
	const anchorWorld = new THREE.Vector3()
	const boneAxisWorld = new THREE.Vector3()
	const restTip = new THREE.Vector3()
	const parentQuat = new THREE.Quaternion()
	for (const uuid of topoOrder) {
		const entry = registry.get(uuid)
		if (!entry) continue
		const mesh = entry.group?.mesh
		const meshParent = mesh?.parent
		if (!mesh || !meshParent) continue
		if (!getAnchorWorld(entry, anchorWorld)) continue
		meshParent.getWorldQuaternion(parentQuat)
		boneAxisWorld.copy(entry.restLocalDir).applyQuaternion(parentQuat)
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

	// pose transaction : sub-step の applyPoseAt / stepAndApplyOrdered が全 bone を書き換えても
	// finally で displayedBase (= BB core が当てた正しい current pose) に戻す。 これで registry 外の
	// bone (= 解除済み / 非 spring / muted 等) が rest に取り残される root bone 凍結を排除。
	// 例外時も rollback される (Sol 見落としバグ 5、 反復例外による恒久 rest 凍結の防止)。
	const displayedBase = captureAnimatorPose()
	try {
		if (simTime < 0 || targetSimTime < simTime - 1e-6 || targetSimTime - simTime > FAST_FORWARD_THRESHOLD) {
			// 初回 / 逆行 / 大ジャンプ = 0 から replay (= deterministic 完全保証)
			replayFromStartTo(targetSimTime)
		} else if (targetSimTime > simTime + 1e-6) {
			// 通常前進 = cache (= 前 simTime) から進める (= 軽量化、 1 tick で 1-3 step)
			advanceSimTo(targetSimTime)
		}
		// 同時刻 (= |targetSimTime - simTime| < 1e-6) = sim 進めない (= state 不変、 描画のみ)
	} finally {
		restoreAnimatorPose(displayedBase)
		Canvas?.scene?.updateMatrixWorld?.(true)
	}

	// spring bone だけ最終 pose を再適用 (= restore で消えた spring 揺れを書き戻す)。
	// applyOnlyOrdered は registry 限定書き込み + updateMatrixWorld(true) で chain を伝播。
	applyOnlyOrdered()
}

let cleanups: Array<() => void> = []

function installTickLoop(): () => void {
	rescanRegistry()
	simTime = -1
	inhibitTick = false

	// animation pose 由来の cache invalidation は BB event / Undo transaction を境界にする案 A を採用。
	// 案 B (= keyframe 全値を fingerprint 化) は display frame ごとの走査と BB 内部構造への依存が増え、
	// 案 C (= 常時 0 replay) は通常再生の cache を失う。 BB 5.1.4 では数値変更 / 追加 / 削除が
	// `Undo.current_save.aspects.keyframes` を持つ transaction 内で preview され、 commit 後に
	// `finished_edit`、 animation 切替後に `select_animation` が発火するため、この境界だけで十分。
	// 編集中は slider drag 等の連続 preview も毎回 replay し、 transaction 外では従来の cache を保つ。
	const isKeyframeEditActive = (): boolean =>
		Array.isArray(Undo?.current_save?.aspects?.keyframes)

	// wasKeyframeEditActive の宣言は invalidateAnimationCache より先 (= 内部で reset するため)。
	// 詳細な役割は下記 onAnimFrame ブロックのコメント参照。
	let wasKeyframeEditActive = false

	// finished_edit / select_animation は BB core の最後の preview より後に発火する経路があるため、
	// invalidate だけでなく preview を再発火し、paused 中も新 pose をその場で replay する。
	// **重複 invalidate 抑止 (Sol Round 3 MUST-1)** : `Animator.preview()` は BB core (= animation_mode.js:454)
	// で `display_animation_frame` を **同期発火** するため、 onAnimFrame が再入する。 このタイミングで
	// wasKeyframeEditActive がまだ true のままだと、 状態遷移検知 (= !active && wasKeyframeEditActive) が
	// 満たされ再度 invalidateAnimationCache が呼ばれ「1 回の finishEdit で 2 回 invalidate」 になる。
	// invalidate の入口で wasKeyframeEditActive=false に落として全経路 (= onFinishedEdit / onSelectAnimation /
	// onAnimFrame の状態遷移検知) 共通で 1 回発火のみを保証する。
	const invalidateAnimationCache = (): void => {
		wasKeyframeEditActive = false
		simTime = -1
		if (!Modes?.animate) return
		try {
			Animator?.preview?.()
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] animation cache refresh failed`, e)
		}
	}

	// wasKeyframeEditActive = 前 tick 時点で編集 transaction 中だったかの状態 (= 遷移検知用)。
	// `Undo.cancelEdit()` (= viewport gizmo drag 中の Esc、 undo.js:143-151) は event を dispatch せず、
	// keyframe 値を revert するだけで finished_edit / select_animation どちらも fire しない。 その結果
	// drag 中に累積した「編集途中の値ベースの state.pos」 が cancel 後に残り、 revert 済の pose に対して
	// spring だけ stale 表示になる (Opus Round 1 WANT-1)。 前 tick で true → 今 tick で false の
	// 状態遷移で invalidate すれば cancelEdit / finishEdit どちらの経路でも拾えるため、 event に依存せず
	// 「transaction 終了時点で必ず cache 破棄」 が担保される。 finished_edit listener と重複しても
	// invalidateAnimationCache の副作用は「次 tick で 0 replay」 のみで無害。
	// **重要な再入対策 (Sol Round 2 MUST-1)** : `invalidateAnimationCache()` は `Animator.preview()` を
	// 呼び、 BB core (= animation_mode.js:454) は preview 内で `display_animation_frame` を **同期発火** する。
	// つまり onAnimFrame が再入 → 再入時に wasKeyframeEditActive がまだ true のままだと同じ分岐に
	// 再度入って invalidateAnimationCache 再帰 → スタック上限。 shouldInvalidate をローカル決定 +
	// wasKeyframeEditActive を invalidate 呼び出しより **前** に更新することで、 再入時は
	// wasKeyframeEditActive=false = 遷移条件不成立で invalidate が起きない = 再帰を切断する。
	// **重複発火抑止 (Sol Round 3 MUST-1)** : wasKeyframeEditActive の宣言は invalidateAnimationCache
	// より先に移動済 (= 内部で flag reset するため)、 これで onFinishedEdit / onSelectAnimation の
	// 経路と onAnimFrame の状態遷移検知が共通で「1 回だけ発火」 を保証する。
	const onAnimFrame = (): void => {
		try {
			// keyframe edit transaction 中は値が preview ごとに変わり得るため、各 frame を 0 replay。
			// 個人スコープでは長 timeline + 多 chain rig で drag スタッター可能性あるが、
			// transaction の正しさを優先 (Opus Round 1 WANT-2、 意図的トレードオフ)。
			// transaction 外は wasKeyframeEditActive 遷移で 1 回 invalidate → 以降 cache 経路へ自動復帰。
			const active = isKeyframeEditActive()
			const shouldInvalidate = !active && wasKeyframeEditActive
			// 再入対策 : invalidate 呼び出しより前に flag を更新して、 preview 同期発火経由の
			// 再入時に「wasKeyframeEditActive=false」 で遷移条件不成立にし、 再帰を切断する。
			wasKeyframeEditActive = active
			if (active) simTime = -1
			else if (shouldInvalidate) invalidateAnimationCache()
			tick()
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] tick failed`, e)
		}
	}
	const onFinishedEdit = (event: unknown): void => {
		const keyframes = (event as { aspects?: { keyframes?: unknown } } | null)?.aspects?.keyframes
		if (Array.isArray(keyframes)) invalidateAnimationCache()
	}
	const onSelectAnimation = (): void => {
		invalidateAnimationCache()
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
	// 症状 1 (Undo できない) の primary fix : undo / redo で group.spring_* 値は元に戻るが、
	// plugin 側の entry.config は BB event 経由でしか同期されない。 この listener が無いと
	// 「値は復元されたのに entry.config は旧値のまま」 で「Ctrl+Z が効いていないように見える」
	// 症状となる。 rescanRegistry で config 再読込 + simTime = -1 で fingerprint 変化経由の
	// 次 tick 0 replay を起動する。 keyframe undo は fingerprint を触らないので simTime = -1
	// は unconditional 必要 (= Fable IMO-1、 undo-path の厳格さ)。
	//
	// updateSelection() は敢えて呼ばない : BB core の loadUndoSave が 'undo'/'redo' event
	// dispatch 直前 (= undo.js:823) に既発火、 我々の onUpdateSelection listener 経路で rescan
	// も走るため冗長 (= Round 2 review WANT-1、 undo 1 回で 2 rescan の性能ロス回避)。
	//
	// 一方 Animator.preview() は残す : keyframe undo (= fingerprint 変化なし) の場合、 core の
	// preview (= undo.js:830-832) は旧 simTime のまま走り「復元済み keyframe に古い物理姿勢を
	// 適用」 する。 我々の simTime = -1 は次 display_animation_frame event を待つが、 paused
	// 中は自然発火しないため paused 中の keyframe undo で spring bones が視覚 stale のまま残る
	// (= Codex Round 2 MUST-1 / Fable Round 2 WANT-1)。 unconditional preview 呼びで最新
	// state を強制反映、 config undo 時の 2 replay 代償は個人スコープで許容 (dirty-flag による
	// conditional skip は overkill 判定)。
	const onUndoRedo = (): void => {
		try {
			rescanRegistry()
			simTime = -1
			if (Modes?.animate) Animator?.preview?.()
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] undo/redo refresh failed`, e)
		}
	}

	Blockbench.on('display_animation_frame', onAnimFrame)
	Blockbench.on('select_project', onProjectSwitch)
	Blockbench.on('update_selection', onUpdateSelection)
	Blockbench.on('select_mode', onModeChange)
	Blockbench.on('undo', onUndoRedo)
	Blockbench.on('redo', onUndoRedo)
	Blockbench.on('finished_edit', onFinishedEdit)
	Blockbench.on('select_animation', onSelectAnimation)

	return (): void => {
		Blockbench.removeListener?.('display_animation_frame', onAnimFrame)
		Blockbench.removeListener?.('select_project', onProjectSwitch)
		Blockbench.removeListener?.('update_selection', onUpdateSelection)
		Blockbench.removeListener?.('select_mode', onModeChange)
		Blockbench.removeListener?.('undo', onUndoRedo)
		Blockbench.removeListener?.('redo', onUndoRedo)
		Blockbench.removeListener?.('finished_edit', onFinishedEdit)
		Blockbench.removeListener?.('select_animation', onSelectAnimation)
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
		// Group 右クリ context menu に「Spring 化 / 解除」 の rename sugar action を追加。
		// gesture (= 唯一の truth) は依然 name prefix 「spring_」 の付け外し。
		registerContextMenuActions()
		// Outliner 上で spring_ prefix group を視覚的に区別する軽量マーカーを install。
		cleanups.push(registerOutlinerMarker())
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
		// context menu action + separator を Group.prototype.menu.structure から削除。
		unregisterContextMenuActions()
		console.log(`[${PLUGIN_ID}] unloaded`)
	},
})
