// Spring Bone plugin の animate モード用 sidebar Panel。
// edit モードは BB 標準 Element panel (= element_panel.ts) に任せる (= Property の
// element_panel input が自動で出る)。 element_panel は condition: {modes: ['edit']}
// で animate モード非表示のため、 animate 中の値編集を本 Panel が担う。
//
// Panel の役割は 2 層 :
//   - NumSlider 3 個 = Group Property (= 全 animation 共通の既定値) の編集
//   - animation 選択中のみ出る 2 行 (= inline_select `spring_state` と
//     inline_multi_select `overrides`) = 選択中 animation だけの override 編集
// animation 未選択でも Panel 自体は出したままにし、 slider による Group 既定値の
// 編集は従来どおり使えるようにする (= 2 行は form element の condition で隠す)。
//
// 実装 pattern は BB 5.1.4 の element_panel.ts 実装を踏襲 :
//   - new InputForm({}) + form_config への input 追加 + buildForm() で dynamic 生成
//   - form.on('input', ...) で値を Undo wrap で反映
//   - Blockbench.on('update_selection', ...) で選択追従の form.setValues()
//
// mode 制約 = animate のみ表示にすることで edit モードは element_panel、 animate モードは
// 本 Panel が担う分業。 UX 上の重複を回避しつつ両モードで NumSlider 編集を提供できる。

import {
	ANIM_OVERRIDES_KEY,
	clearOverrideField,
	setOverrideField,
	type SpringOverrideMap,
} from './animOverrides'
import { resolveEffective, toSpringBoneState, type SpringBaseConfig } from './springConfig'

declare const Panel: any
declare const InputForm: any
declare const Blockbench: any
declare const Group: any
declare const Undo: any
declare const Animation: any

// spring 化判定の述語型。 判定の truth は index.ts 側の Group Property
// (= `spring_bone_enabled`) に一元化されており、 本 module は name prefix を一切見ない
// (= 以前の BONE_NAME_PREFIX 重複定義は廃止、 registerSpringPanel の引数で注入される)。
// **capable (= 'enabled' | 'disabled') 判定の述語** であり、 実際に物理を掛けるかの
// 'enabled' 判定 (= index.ts の isSpringActive) とは別物 (= 命名で混同しないよう
// capable 系に揃える)。
type IsSpringCapableGroup = (group: unknown) => boolean

// override map の読み取り口型。 index.ts の readOverrides (= schema version gate +
// 1 件 memo 付きの唯一の read 経路) を注入する。 ui.ts 側で normalizeOverrides を
// 直接呼ぶと version gate を迂回するため、 read は必ずこの経路を通す。
type ReadOverrides = (animation: any) => SpringOverrideMap

// 「この animation の override を書いてよいか」の判定型。 index.ts の
// canWriteOverrides (= 未知の上位 schema version への書き込み禁止判定) を注入する。
// Panel の全書き込み経路 (= slider gesture / checkbox / selector) は書き込み前に
// この判定を通す (= Round 5 MUST-4)。
type CanWriteOverrides = (animation: any) => boolean

// animation が project にまだ存在するか (= 削除済みでないか) の判定。
// Animation.all = Project.animations (= BB animation.js:653-660)。
// animation 削除時の `remove_animation` event は `Animation.selected = null` より
// **前** に発火する (= animation.js:428 → 429) ため、 event 契機の同期だけでは
// 削除済み animation を selected として読み続ける窓が残る。 表示同期と書き込み
// 検証の両方でこの判定を通してその窓を塞ぐ (= Round 5 MUST-2)。
function isAnimationAlive(anim: any): boolean {
	const all = Animation?.all
	return Array.isArray(all) && all.includes(anim)
}

// Property 3 パラの UI メタ情報 (= registerProperties と 1:1 対応、 range / step も同値)。
const PANEL_INPUTS = [
	{ key: 'drag', label: 'Drag', min: 0, max: 1, step: 0.01, defaultValue: 0.05 },
	{ key: 'stiffness', label: 'Stiffness', min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
	{ key: 'gravity', label: 'Gravity', min: 0, max: 100, step: 1, defaultValue: 0 },
] as const
type PanelSliderKey = (typeof PANEL_INPUTS)[number]['key']

// resolveEffective の defaults 引数 (= 継承値計算の最終 fallback)。 PANEL_INPUTS の
// defaultValue から組み、 既定値の定義箇所を 1 つに保つ。
const PANEL_DEFAULTS = Object.fromEntries(
	PANEL_INPUTS.map((meta) => [meta.key, meta.defaultValue]),
) as SpringBaseConfig

// Panel 単一インスタンス + event listener を管理する module state。
// register / unregister は plugin onload / onunload から 1 回ずつ呼ばれる想定。
let spring_panel: any = null
// form 再同期 listener の登録一覧 (= cleanup で全解除するため event 名と対で保持)。
let sync_listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = []

// inline_multi_select (= overrides 行) の直前同期時点の状態。 BB の
// inline_multi_select は change 時に changed_keys へ 'overrides' しか載せず
// (= form.ts:336-337)、 どの項目が toggle されたか分からないため、 同期時点の
// 状態との diff で変化項目を特定する。 pushValuesFromSelectedGroup のたびに
// override map の truth から張り直す。
let last_override_checks: Record<string, boolean> = {}

function isSpringSelectionCapable(isSpringCapableGroup: IsSpringCapableGroup): boolean {
	return isSpringCapableGroup(Group.first_selected)
}

// 選択中 group の Group Property 値 (= 全 animation 共通の既定値) を読む。
// 非 finite は defaultValue へ fallback (= index.ts readSpringProp と同じ規則)。
function readGroupBase(g: any): SpringBaseConfig {
	const base = {} as SpringBaseConfig
	for (const meta of PANEL_INPUTS) {
		const raw = g?.[`spring_${meta.key}`]
		base[meta.key] = typeof raw === 'number' && Number.isFinite(raw) ? raw : meta.defaultValue
	}
	return base
}

// 選択中 group / animation の状態を form にプッシュ (= 選択・animation 切替・
// undo/redo・project 切替時の値同期)。
// - slider 表示値 = その項目の override があればその値、 無ければ継承値
//   (= resolveEffective(base, groupState, undefined, defaults)。 解決順の定義を
//   springConfig.ts の 1 箇所に保つため、 ここで自前に ?? を並べて再実装しない)
// - overrides 行の各 checkbox = その項目の override が map に存在するか
//   (= normalize 済み map では存在 = 有効値、 が保証されている)
// - spring_state 行 = override.enabled が true → 'on' / false → 'off' / 未設定 → 'inherit'
// group が spring bone でない場合は何もしない (= Panel は display_condition で自動非表示)。
function pushValuesFromSelectedGroup(
	form: any,
	isSpringCapableGroup: IsSpringCapableGroup,
	readOverrides: ReadOverrides,
): void {
	if (!isSpringSelectionCapable(isSpringCapableGroup)) return
	const g = Group.first_selected
	const base = readGroupBase(g)
	const groupState = toSpringBoneState(g?.spring_bone_enabled)
	const animSelected = Animation?.selected ?? null
	// 削除済み animation が selected に残っているケース (= remove_animation が
	// selected=null より先に発火する) は「未選択」として扱う (= Round 5 MUST-2)。
	// これが無いと削除直後の同期で削除済み animation の override を表示に張り直す。
	const anim = animSelected !== null && isAnimationAlive(animSelected) ? animSelected : null
	const boneUuid = typeof g?.uuid === 'string' ? g.uuid : null
	const override = anim !== null && boneUuid !== null ? readOverrides(anim)[boneUuid] : undefined
	const inherited = resolveEffective(base, groupState, undefined, PANEL_DEFAULTS)
	const values: Record<string, unknown> = {}
	const checks: Record<string, boolean> = {}
	for (const meta of PANEL_INPUTS) {
		const ov = override?.[meta.key]
		values[meta.key] = typeof ov === 'number' && Number.isFinite(ov) ? ov : inherited[meta.key]
		checks[meta.key] = ov !== undefined
	}
	values.overrides = checks
	values.spring_state =
		override?.enabled === true ? 'on' : override?.enabled === false ? 'off' : 'inherit'
	last_override_checks = checks
	try {
		form.setValues?.(values)
		form.update?.(values)
	} catch (e) {
		console.warn('[spring_bone] panel setValues failed', e)
	}
}

// Panel + form + event listener を register して cleanup 関数を返す。
// 注入 deps (= Round 5 MUST-4 で object 引数化、 呼び出し元は index.ts onload の 1 箇所) :
// - onChange = index.ts の onSpringPropertyChange (= registry sync + invalidatePreviewSession() による session 破棄)
// - isSpringCapableGroup = index.ts の isSpringGroup (= Property ベースの capable 判定)
// - readOverrides = index.ts の readOverrides (= schema version gate + memo 付きの唯一の read 経路)
// - canWriteOverrides = index.ts の canWriteOverrides (= 上位 schema version への
//   書き込み禁止判定。 全書き込み経路で書き込み前に確認する)
export function registerSpringPanel(deps: {
	onChange: () => void
	isSpringCapableGroup: IsSpringCapableGroup
	readOverrides: ReadOverrides
	canWriteOverrides: CanWriteOverrides
}): () => void {
	const { onChange, isSpringCapableGroup, readOverrides, canWriteOverrides } = deps
	if (typeof Panel !== 'function' || typeof InputForm !== 'function') {
		console.warn('[spring_bone] Panel or InputForm not available, skipping panel registration')
		return () => {}
	}

	const form = new InputForm({})

	spring_panel = new Panel('spring_bone', {
		icon: 'gesture',
		name: 'Spring Bone',
		// animate モード限定 = edit モードは element_panel input に任せて重複回避。
		condition: { modes: ['animate'] },
		// display_condition = spring bone (= capable) group が単独選択されているときのみ Panel 内容表示。
		// 非選択時は Panel が collapse or 非表示になる (= BB core 側の挙動)。
		display_condition: () => isSpringSelectionCapable(isSpringCapableGroup),
		default_position: {
			slot: 'right_bar',
			float_position: [0, 0],
			float_size: [300, 200],
			height: 200,
			sidebar_index: 3,
		},
		form,
	})

	// form_config に input を dynamic 追加してから buildForm。 element_panel.ts の
	// updateElementForm() と同 pattern (= form_config オブジェクト直接書き換え + buildForm)。
	const form_config = form.form_config

	// 選択中 animation 限定の override 行 2 つ。 表示条件 :
	//   - animation が選択されている (= animation 未選択でも Panel 自体と Group
	//     既定値 slider は従来どおり使える)
	//   - 削除済み animation でない (= remove_animation は selected=null より先に
	//     発火するため、 event 契機の同期だけでは削除直後に stale 表示が残る)
	//   - 書き込み可能な schema version である (= Round 5 MUST-4 : 未知の上位
	//     version では readOverrides が空 map を返すため、 その空 map 起点の編集
	//     結果を代入すると未知 schema の raw が消える。 行ごと隠して操作自体を
	//     不可能にする)
	// condition は form.update() が form_result を context に評価する
	// (= form.ts:223-232) ので、 値同期のたびに表示 / 非表示が追従する。
	const isOverrideRowVisible = (): boolean => {
		const anim = Animation?.selected
		if (!anim || !isAnimationAlive(anim)) return false
		return canWriteOverrides(anim)
	}
	form_config.spring_state = {
		label: 'In this animation',
		type: 'inline_select',
		options: { inherit: '継承', on: '有効', off: '無効' },
		value: 'inherit',
		condition: isOverrideRowVisible,
	}
	form_config.overrides = {
		label: 'Override',
		type: 'inline_multi_select',
		options: { drag: 'drag', stiffness: 'stiffness', gravity: 'gravity' },
		// inline_multi_select は初期 value が無いと this.value が空 object のままになり、
		// setValue が「this.value に存在する key しか更新しない」 実装 (= form.ts:781-789)
		// のため以降の同期が一切反映されない。 全 key を false で初期化しておく。
		value: { drag: false, stiffness: false, gravity: false },
		condition: isOverrideRowVisible,
	}

	// NumSlider 3 個 = Group Property (= 全 animation 共通の既定値) の編集。
	// type: 'num_slider' = BB 5.1.4 の NumSlider (= slider 内蔵 + Ctrl/Shift 倍率変更 modifier
	// 対応)。 UX 要件 (= 数値入力 + スライドバーで直感的に連続調整) を満たす。 'number' 型は
	// NumericInput (= slider なし) で不適。
	for (const meta of PANEL_INPUTS) {
		form_config[meta.key] = {
			label: meta.label,
			type: 'num_slider',
			min: meta.min,
			max: meta.max,
			step: meta.step,
			value: meta.defaultValue,
		}
	}
	try {
		form.buildForm?.()
	} catch (e) {
		console.warn('[spring_bone] form.buildForm failed', e)
	}

	// 症状 1 (Undo 粒度爆発) の primary fix : NumSlider の onBefore/onAfter に
	// initEdit/finishEdit を寄せて per-gesture 1 Undo entry に集約する。 BB core の
	// NumSlider (= actions.ts:1179/1210) は drag 開始 → onBefore、 drag 終了 → onAfter を
	// per-gesture 1 回ずつ発火する。 arrow key (:1112/1119)、 text 確定 (:1445-1454) も同経路。
	// これで form.on('input') が per-move-event で発火しても Undo entry は 1 gesture 1 個で済む。
	// form.buildForm() 後に form.form_data[key].slider が生きているタイミングで差し替える。
	//
	// **gesture context (= Round 5 MUST-1)** : onBefore で「書き込み先を確定した context」
	// を作り、 gesture 中の form.on('input') はその context だけを見る。 旧実装は
	// Undo の aspects は onBefore で固定されるのに実際の書き込み先 (= 選択中 animation /
	// Group / checkbox 状態) は input のたびに再計算していたため、 drag 中に選択や
	// checkbox 状態が変わると Undo が捕捉していない animation / Group へ変更が入り、
	// Undo / Redo で復元できなかった。 onAfter で context を破棄する。
	//
	// edit_started フラグは onBefore で initEdit を実際に発火できたかを追跡する。
	// drag 中に selection が非 spring group へ切り替わっても、 edit_started なら onAfter は
	// 必ず transaction を閉じる (= Codex Round 3 IMO-1 対策、 未対応だと initEdit が
	// 開きっぱなしになり後続の Undo 操作が壊れる)。
	// Round 6 での追加保証 :
	//   - gesture 中の form 再同期は requestSync 経由で延期し、 onAfter で 1 回だけ
	//     実行する (= Round 6 MUST-1 : gesture 中に選択が変わっても表示を開始時の
	//     Group のまま保ち、 新しい表示値を元の対象へ書き込む事故を防ぐ)
	//   - onAfter は context の有無や abort 状態に関わらず必ず最後まで走り、
	//     書き込みが 1 度も成立しなかった gesture では form を実データから再同期する
	//     (= Round 6 MUST-2 : onBefore の早期 return は BB の NumSlider 操作自体を
	//     キャンセルしないため、 表示値だけが動いたまま残るのを防ぐ)
	//   - onAfter が来ない中断経路 (= window blur / touchcancel / Panel 破棄) で残った
	//     context / Undo transaction は「次の onBefore 冒頭」 と「cleanup」 で回収する
	//     (= Round 6 WANT-1)
	//   - 書き込みが成立しなかった gesture の transaction は cancelEdit で閉じる
	//     (= BB の finishEdit は空 edit でも entry を push して Project.saved = false
	//     にするため、 no-op で Undo entry を作らない契約を守れない)
	interface SliderGestureContext {
		// 書き込み種別 (= onBefore 時点の checkbox 状態で決まる)
		kind: 'group' | 'animation'
		// 対象 Group の参照と uuid (= Undo aspects と同じ参照)
		group: any
		boneUuid: string
		// kind === 'animation' の対象 animation (= 同様に aspects と同じ参照)
		animation: any | null
		// 書き込み直前検証 (= Round 5 MUST-2 / Round 6 MUST-1) で中止したら true。
		// 以降の input は何も書かず、 onAfter で transaction を閉じて form を
		// 実データから再同期する
		aborted: boolean
		// 1 度でも書き込みが成立したら true (= Round 6 MUST-2)。 false のまま
		// 終了した gesture は widget の表示値だけが動いているため、 onAfter で
		// form を実データから再同期する。 transaction の閉じ方の分岐
		// (= finishEdit / cancelEdit) にも使う
		wrote: boolean
	}
	let edit_started = false
	let gesture_context: SliderGestureContext | null = null
	// gesture 中に延期された form 再同期の flag (= Round 6 MUST-1)。 onAfter で
	// 1 回だけまとめて実行したら下ろす。
	let resync_pending = false

	// form 再同期の唯一の入口 (= Round 6 MUST-1)。 gesture 中 (= gesture_context が
	// 生きている間) に同期契機が来てもその場で form を書き換えない : 書き換えると
	// 表示が gesture 開始時の Group から新しい選択へ切り替わり、 以降の input が
	// 「新しい表示値」 を context に記録した元の Group / animation へ書き込む事故に
	// なる。 gesture 中は flag を立てて延期し、 onAfter でまとめて再同期する。
	// gesture 外 (= context が無い) からの呼び出しは従来どおり即時同期する。
	const requestSync = (): void => {
		if (gesture_context !== null) {
			resync_pending = true
			return
		}
		pushValuesFromSelectedGroup(form, isSpringCapableGroup, readOverrides)
	}

	// 開いている Undo transaction を閉じる (= onAfter / 次 gesture 冒頭の残骸回収 /
	// cleanup の 3 経路で共有)。 書き込みが 1 度も成立していない gesture
	// (= ctx が無い / wrote === false) は cancelEdit で空 entry を積まずに閉じる
	// (= 契約 7 : no-op 操作で Undo entry を作らない)。 cancelEdit() は current_save を
	// 破棄するだけで変更は revert しない (= 書き込み無しなので revert も不要)。
	const closeGestureEdit = (ctx: SliderGestureContext | null): void => {
		if (!edit_started) return
		try {
			if (ctx !== null && ctx.wrote) {
				Undo?.finishEdit?.('Change spring config')
			} else if (typeof Undo?.cancelEdit === 'function') {
				Undo.cancelEdit()
			} else {
				// cancelEdit が無い環境では空 entry が積まれるが、 transaction を
				// 閉じること (= 後続の Undo を壊さない) を優先する
				Undo?.finishEdit?.('Change spring config')
			}
		} catch (e) {
			console.warn('[spring_bone] close gesture edit failed', e)
		} finally {
			edit_started = false
		}
	}
	for (const meta of PANEL_INPUTS) {
		const element = (form as any).form_data?.[meta.key]
		const slider = element?.slider
		if (slider) {
			slider.onBefore = () => {
				// 前 gesture の残骸回収 (= Round 6 WANT-1) : onAfter が来ない中断経路
				// (= window blur / touchcancel 等で BB の mouseup / touchend が届かない)
				// で context や開いた Undo transaction が残ったまま次の gesture が
				// 始まった場合、 先に閉じてから新しい context を作る。 Undo.current_save
				// を開いたまま後続操作へ持ち越さないための保証。 なお window blur /
				// touchcancel の listener は **足さない** : drag 中に別 window へ
				// 切り替えて戻る操作を誤って中断扱いにするリスクがあるため。
				if (gesture_context !== null || edit_started) {
					const stale = gesture_context
					gesture_context = null
					closeGestureEdit(stale)
					resync_pending = false
					// 中断した gesture で widget の表示値だけが動いている可能性が
					// あるため、 新しい gesture を始める前に実データへ張り直す
					pushValuesFromSelectedGroup(form, isSpringCapableGroup, readOverrides)
				}
				if (!isSpringSelectionCapable(isSpringCapableGroup)) return
				const g = Group.first_selected
				const boneUuid = typeof g?.uuid === 'string' ? g.uuid : null
				if (boneUuid === null) return
				const wantsOverride = last_override_checks[meta.key] === true
				const anim = Animation?.selected ?? null
				if (wantsOverride && (anim === null || !isAnimationAlive(anim))) {
					// 表示上は override 編集中だが animation が既に無い (= 削除 /
					// AnimationController 選択は select_animation を発火しないため
					// 表示が stale になり得る、 Round 5 MUST-2)。 このまま Group 既定値へ
					// フォールスルーして書き換えるのを防ぐため gesture を開始せず、
					// form を再同期して stale 表示を解消する。
					pushValuesFromSelectedGroup(form, isSpringCapableGroup, readOverrides)
					return
				}
				const kind: 'group' | 'animation' = wantsOverride && anim !== null ? 'animation' : 'group'
				if (kind === 'animation' && !canWriteOverrides(anim)) {
					// 未知の上位 schema version の animation には書かない (= Round 5
					// MUST-4)。 空 map 起点の編集で未知 schema の raw を消さないよう
					// gesture 自体を開始しない。 通常は行が非表示なのでここには来ない
					// (= 防御的二重化)。
					pushValuesFromSelectedGroup(form, isSpringCapableGroup, readOverrides)
					return
				}
				gesture_context = { kind, group: g, boneUuid, animation: kind === 'animation' ? anim : null, aborted: false, wrote: false }
				try {
					// aspects は drag 開始時点で確定した context から取る : kind が
					// 'animation' なら選択中 animation の override を書くため
					// { animations }、 'group' なら Group 既定値を書くため { groups }。
					// gesture 中に状態が変わっても aspects と書き込み先はともに
					// 開始時点で固定される (= before / after が別対象を指すのを防ぐ)。
					const aspects = kind === 'animation' ? { animations: [anim] } : { groups: [g] }
					Undo?.initEdit?.(aspects)
					edit_started = true
				} catch (e) {
					console.warn('[spring_bone] slider onBefore failed', e)
					// initEdit に失敗した gesture は Undo 捕捉なしの書き込みになる
					// ため、 context ごと破棄して input 側でも何も書かないようにする
					gesture_context = null
				}
			}
			slider.onAfter = () => {
				// context の有無や abort 状態に関わらず必ず最後まで走る (= Round 6 MUST-2)。
				// BB の NumSlider は drag / arrow key / wheel / text 確定の全経路で
				// onAfter を無条件発火する (= actions.ts)。
				const ctx = gesture_context
				gesture_context = null
				closeGestureEdit(ctx)
				// 「書き込みが 1 度も成立しなかった gesture」 (= onBefore の早期 return で
				// context が無い / 書き込み直前検証で abort した) でも、 widget 自体の
				// 表示値は動いている (= onBefore の早期 return は BB の NumSlider 操作を
				// キャンセルしない)。 そのままだと保存データ / preview と slider の表示値が
				// 次の同期 event まで食い違うため、 gesture 終了時に実データから再同期する。
				// gesture 中に延期した同期 (= Round 6 MUST-1 の resync_pending) も
				// ここで 1 回だけまとめて実行する。
				const needsResync = resync_pending || ctx === null || ctx.aborted || !ctx.wrote
				resync_pending = false
				if (needsResync) {
					try {
						pushValuesFromSelectedGroup(form, isSpringCapableGroup, readOverrides)
					} catch (e) {
						console.warn('[spring_bone] slider onAfter resync failed', e)
					}
				}
			}
		}
	}

	// form input event : 値変更を group Property または animation override に反映 + registry sync。
	form.on('input', ({ result, changed_keys }: { result: Record<string, any>; changed_keys: string[] }) => {
		if (!isSpringSelectionCapable(isSpringCapableGroup)) return
		const g = Group.first_selected
		const anim = Animation?.selected ?? null
		const boneUuid = typeof g?.uuid === 'string' ? g.uuid : null
		const canWriteOverride = anim !== null && boneUuid !== null
		try {
			// slider (= 数値項目) の書き込み。 Undo wrap は onBefore/onAfter に寄せた
			// (= per-gesture 集約) ため、 ここでは書き込みと registry sync だけ担う。
			// **書き込み先は gesture context に固定されている** (= Round 5 MUST-1) :
			//   kind 'animation' → onBefore で確定した animation の override map
			//   kind 'group'     → onBefore で確定した Group の既定値
			// gesture 中に選択や checkbox 状態が変わっても書き込み先は動かない。
			// checkbox OFF (= kind 'group') でも slider を readonly にはしない :
			// animate モードで Group 既定値を編集できる唯一の手段が本 Panel の
			// slider であり、 readonly にするとその機能が失われるため。
			// slider の値変更はすべて onBefore/onAfter の gesture に包まれている
			// (= BB NumSlider は drag / arrow key / text 確定のいずれでも onBefore を
			// 発火する) ため、 gesture context が無い入力は書き込まない (= context
			// 無しの書き込みは Undo 捕捉なしの変更 = 復元不能になる)。
			// NumSlider text 入力の Molang 分岐 (= BB actions.ts:1421-1435) は NaN を返し得るため、
			// 書き込み前に finite check (= 潜在バグ Fable #2)。 非 finite は silent drop。
			for (const key of changed_keys) {
				if (!PANEL_INPUTS.some((meta) => meta.key === key)) continue
				const v = result[key]
				if (typeof v !== 'number' || !Number.isFinite(v)) continue
				const ctx = gesture_context
				if (!ctx || ctx.aborted) continue
				// 書き込み直前の Group 同一性検証 (= Round 6 MUST-1) : gesture 中に
				// 選択 Group が context の group から変わった場合は書き込みを中止する。
				// gesture 中の form 再同期は延期している (= requestSync) が、 延期が
				// 漏れる経路が残っても新しい Group の表示値を元の Group / animation の
				// override へ書き込む事故を防ぐ保険 (= kind 'group' / 'animation' 共通)。
				if (ctx.group !== Group.first_selected) {
					ctx.aborted = true
					requestSync()
					continue
				}
				if (ctx.kind === 'animation') {
					// 書き込み直前の検証 (= Round 5 MUST-2) : gesture 中に対象
					// animation が差し替わった / 削除された / 書き込み不可になった
					// 場合は書き込みを中止し、 gesture 終了時に form を再同期する。
					// stale な checkbox 表示のまま Group 既定値を巻き添えに書き換えるのを防ぐ。
					const target = ctx.animation
					if (
						target !== (Animation?.selected ?? null) ||
						!isAnimationAlive(target) ||
						!canWriteOverrides(target)
					) {
						ctx.aborted = true
						requestSync()
						continue
					}
					target[ANIM_OVERRIDES_KEY] = setOverrideField(
						readOverrides(target),
						ctx.boneUuid,
						key as PanelSliderKey,
						v,
					)
					ctx.wrote = true
				} else {
					ctx.group[`spring_${key}`] = v
					ctx.wrote = true
				}
			}
		} catch (e) {
			console.warn('[spring_bone] panel input handler failed', e)
		}

		// checkbox / selector の操作 = drag ではないため initEdit → 書き込み → finishEdit を
		// ここで 1 操作分完結させる。 slider の move event と混ざらないよう changed_keys で分岐する。
		const stateChanged = changed_keys.includes('spring_state')
		const overridesChanged = changed_keys.includes('overrides')
		if ((stateChanged || overridesChanged) && canWriteOverride && canWriteOverrides(anim)) {
			try {
				let map = readOverrides(anim)
				// 実際に値が変わる操作があったか。 no-op 操作 (= 現在値の再クリック等)
				// では Undo entry 自体を作らない (= Round 5 NITS-1 : no-op のたびに
				// animation 全体の Undo entry を作り project を dirty 化するのを防ぐ)。
				let changed = false
				if (stateChanged) {
					const state = result.spring_state
					const desired = state === 'on' ? true : state === 'off' ? false : undefined
					// 現在の override 値と意味的に同一なら書き込みごと省略する
					if (map[boneUuid]?.enabled !== desired) {
						if (desired === undefined) {
							// 'inherit' (= または未知値) = enabled override を外す
							map = clearOverrideField(map, boneUuid, 'enabled')
						} else {
							map = setOverrideField(map, boneUuid, 'enabled', desired)
						}
						changed = true
					}
				}
				if (overridesChanged) {
					// changed_keys には 'overrides' しか載らないため、 直前同期時点
					// (= last_override_checks) との diff で toggle された項目を特定する。
					const inherited = resolveEffective(
						readGroupBase(g),
						toSpringBoneState(g?.spring_bone_enabled),
						undefined,
						PANEL_DEFAULTS,
					)
					for (const meta of PANEL_INPUTS) {
						const now = result.overrides?.[meta.key] === true
						const was = last_override_checks[meta.key] === true
						if (now === was) continue
						if (now) {
							// OFF → ON : その時点の継承値を override 値として格納する
							// (= 見た目の値を変えずに「上書き中」 へ移行する)
							map = setOverrideField(map, boneUuid, meta.key, inherited[meta.key])
						} else {
							// ON → OFF : override を除去 (= slider 表示は後段の再同期で継承値に戻る)
							map = clearOverrideField(map, boneUuid, meta.key)
						}
						changed = true
					}
				}
				if (changed) {
					// map の書き換えは必ず setOverrideField / clearOverrideField の戻り値を
					// 代入する形で行う。 in-place 変更は readOverrides の memo (= raw の
					// object identity 比較) が検出できず、 Undo の差分捕捉も参照 identity
					// 前提のため両方を壊す。
					// initEdit は map 計算後・代入前に行う (= setOverrideField 系は
					// 入力を変異させないため、 代入の瞬間までは animation の状態が
					// 変わらず before-copy が正しく取れる)。
					Undo?.initEdit?.({ animations: [anim] })
					anim[ANIM_OVERRIDES_KEY] = map
					Undo?.finishEdit?.('Change spring animation override')
				}
			} catch (e) {
				console.warn('[spring_bone] panel override handler failed', e)
			}
			// 書き込み後の再同期 (= ON → OFF で slider を継承値へ戻し、
			// last_override_checks を新しい map の truth に張り直す)。
			// setValues は 'input' を再発火しない (= cause: 'update_value') ため再帰しない。
			// requestSync 経由にするのは deferral の一貫性のため (= checkbox 操作は通常
			// gesture 外なので即時同期になるが、 万一 gesture 中に来ても表示を
			// 書き換えず onAfter に延期する = Round 6 MUST-1)。
			requestSync()
		}
		// registry sync + fingerprint invalidate (= 次 tick で 0 replay、 preview 即反映)
		try {
			onChange()
		} catch (e) {
			console.warn('[spring_bone] onChange failed', e)
		}
	})

	// form 値の再同期 trigger : 選択 group 変化 (= update_selection) に加えて、
	// animation 切替 / undo / redo / project 切替 でも override 表示値が変わり得るため
	// 全てで同期する。 登録・解除の形は index.ts installTickLoop の
	// Blockbench.on / removeListener に合わせる。
	// **remove_animation も listener に含める** (= Round 5 MUST-2) : animation の削除は
	// select_animation を発火しない (= animation.js:428 で専用 event が飛ぶ) ため、
	// これが無いと削除後も override 行が旧状態のまま残る。 なお AnimationController の
	// 選択 (= Animation.selected が null になるもう 1 つの経路、
	// animation_controllers.js:1066) には対応する event が存在しないため、 そちらは
	// 書き込み直前検証 (= slider gesture context) と isAnimationAlive による
	// 表示 / 書き込み両面の防御でカバーする。
	// **同期本体は requestSync 経由** (= Round 6 MUST-1) : slider gesture 中にこれらの
	// event が来てもその場で form を書き換えず、 onAfter で 1 回だけまとめて再同期する
	// (= gesture 中の表示を開始時の Group のまま保つ)。
	sync_listeners = []
	const sync = (): void => requestSync()
	for (const event of ['update_selection', 'select_animation', 'remove_animation', 'undo', 'redo', 'select_project', 'load_project']) {
		Blockbench.on(event, sync)
		sync_listeners.push({ event, fn: sync })
	}

	// 初回値同期 (= plugin load 時に既に spring group を選択済ケース)。
	pushValuesFromSelectedGroup(form, isSpringCapableGroup, readOverrides)

	return () => {
		try {
			// gesture 中断経路の回収 (= Round 6 WANT-1) : onAfter が来ない中断
			// (= gesture 中の Panel 破棄 / plugin unload 等) で context や開いた
			// Undo transaction が残っていたら必ず閉じる。 Undo.current_save を
			// 開いたまま unload すると後続の Undo 操作が壊れる。
			const stale = gesture_context
			gesture_context = null
			closeGestureEdit(stale)
			resync_pending = false
			for (const { event, fn } of sync_listeners) {
				Blockbench.removeListener?.(event, fn)
			}
			sync_listeners = []
			spring_panel?.delete?.()
			spring_panel = null
		} catch (e) {
			console.warn('[spring_bone] panel unregister failed', e)
		}
	}
}
