// Spring Bone plugin の animate モード用 sidebar Panel。
// edit モードは BB 標準 Element panel (= element_panel.ts) に任せる (= Property の
// element_panel input が自動で出る)。 element_panel は condition: {modes: ['edit']}
// で animate モード非表示のため、 animate 中の値編集を本 Panel が担う。
//
// Panel の役割は 3 層 :
//   - NumSlider 3 個 = Group Property (= 全 animation 共通の既定値) の編集。 spring bone
//     (= capable) を選択中のみ表示
//   - animation 選択中 かつ bone 選択中のみ出る 2 行 (= inline_select `spring_state` と
//     inline_multi_select `overrides`) = 選択中 animation だけの override 編集
//   - animation 選択中に出る rest fade slider = 選択中 animation の終端 rest 整合
//     (= 上 2 つと違い **bone に依存しない** Animation Property)
// **Panel 自体は animate モードで常時表示** (= display_condition を持たない) : rest fade は
// animation 単位の値なので、 bone を選択していなくても編集できる必要がある。 bone / animation
// への依存は行ごとの condition で表現する。
//
// 実装 pattern は BB 5.1.4 の element_panel.ts 実装を踏襲 :
//   - new InputForm({}) + form_config への input 追加 + buildForm() で dynamic 生成
//   - form.on('input', ...) で値を反映
//   - Blockbench.on('update_selection', ...) で選択追従の form.setValues()
// ただし Undo の掛け方だけは踏襲しない : slider は drag 中 transaction を開かず、
// drag 終了時 (= onAfter) の同期処理内で 1 entry にまとめる (= 詳細は下の gesture 節)。
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
import { ANIM_REST_FADE_KEY, DEFAULT_REST_FADE_FRAMES } from './restWindow'

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

// group が **現在の project に** まだ存在するかの判定。 Group.all = Project.groups
// (= BB outliner/types/group.js:534-540) なので、 削除済み group だけでなく
// 「別 project の group」 も false になる。 slider gesture の書き込み対象検証で使う :
// BB の Undo は現在 project の UndoSystem を返す getter のため、 project A で drag を
// 始めて B へ切り替えてから mouse を離すと、 A の group への変更を B の Undo 履歴へ
// 積んで B を dirty 化してしまう (= B 側で Undo すると B の group を壊す / 旧 group を
// 生やす)。 選択されているかは見ない (= 選択同一性の検証は「開始時に掴んだ対象へ
// 書き続ける」 gesture context の設計と矛盾する)。
function isGroupAlive(group: any): boolean {
	const all = Group?.all
	return Array.isArray(all) && all.includes(group)
}

// Property 3 パラの UI メタ情報 (= registerProperties と 1:1 対応、 range / step も同値)。
const PANEL_INPUTS = [
	{ key: 'drag', label: 'Drag', min: 0, max: 1, step: 0.01, defaultValue: 0.05 },
	{ key: 'stiffness', label: 'Stiffness', min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
	{ key: 'gravity', label: 'Gravity', min: 0, max: 100, step: 1, defaultValue: 0 },
] as const
type PanelSliderKey = (typeof PANEL_INPUTS)[number]['key']

// 終端 rest 整合の fade 長 slider。 **PANEL_INPUTS とは別枠** : あちらは選択中 bone の
// Group Property (= per-bone) だが、 こちらは選択中 **animation** の Animation Property
// (= per-animation) で、 bone の選択内容に依らず同じ値を出す。
// min は 1 (= 正整数)。 0 を許しても「最終 frame の 1 つ手前まで Δ 全開 → 終端で 0」 の
// hard cut になるだけで rest 整合の有無は変わらないため、 段階を選べる範囲に絞る。
const REST_FADE_INPUT = {
	key: 'rest_fade_frames',
	label: 'Rest fade (frames)',
	min: 1,
	max: 200,
	step: 1,
	defaultValue: DEFAULT_REST_FADE_FRAMES,
} as const
type RestFadeKey = typeof REST_FADE_INPUT.key

// animation の fade 長を読む (= index.ts の readRestFadeFrames と同じ規則。 非 finite /
// 未設定は既定値へ倒す)。
function readRestFade(anim: any): number {
	const raw = anim?.[ANIM_REST_FADE_KEY]
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : REST_FADE_INPUT.defaultValue
}

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

// slider gesture (= NumSlider の drag / arrow key / text 確定 1 回分) の書き込み先。
// onBefore で確定し onAfter で破棄する。 **gesture 中に Undo transaction は開かない**
// 設計のため、 この context が持つのは「どこへ書くか」 と「drag 前の値」 だけ。
interface SliderGestureContext {
	// この gesture で書き換える項目 (= slider 1 個 = 1 項目)
	key: PanelSliderKey | RestFadeKey
	// 書き込み種別。 'group' / 'animation' は onBefore 時点の override checkbox 状態で
	// 決まる。 'rest_fade' は bone に依らない Animation Property (= 専用 slider) の編集。
	kind: 'group' | 'animation' | 'rest_fade'
	// 対象 Group の参照と uuid (= Undo aspects と同じ参照)。 kind 'rest_fade' では
	// 書き込みに使わない (= bone 非依存)。
	group: any
	boneUuid: string
	// kind === 'animation' / 'rest_fade' の対象 animation (= 同様に aspects と同じ参照)
	animation: any | null
	// drag 前の実データ値 (= onAfter で正しい before を捕捉するために一度戻す値)。
	// kind 'group' は Property の生値、 'animation' は override 値 (= 未設定は undefined)
	before: unknown
}
let gesture_context: SliderGestureContext | null = null

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
// - rest fade 行 = 選択中 animation の Property 値 (= **bone の選択状態に依存しない**)
// **per-bone 部分と rest fade を分けて同期する** : spring bone 未選択でも Panel は出たままに
// なったため、 per-bone 側の早期 return で rest fade の同期まで巻き添えにしない。
function pushValuesFromSelectedGroup(
	form: any,
	isSpringCapableGroup: IsSpringCapableGroup,
	readOverrides: ReadOverrides,
): void {
	const animSelected = Animation?.selected ?? null
	// 削除済み animation が selected に残っているケース (= remove_animation が
	// selected=null より先に発火する) は「未選択」として扱う (= Round 5 MUST-2)。
	// これが無いと削除直後の同期で削除済み animation の override を表示に張り直す。
	const anim = animSelected !== null && isAnimationAlive(animSelected) ? animSelected : null
	const values: Record<string, unknown> = {}
	// fade 長は選択中 animation の Property から (= bone には依存しない)。 animation 未選択時は
	// 行自体が隠れるが、 widget の値は既定値に揃えておく (= 次に animation を選んだ時に
	// 前の animation の値が残らない)。
	values[REST_FADE_INPUT.key] = anim !== null ? readRestFade(anim) : REST_FADE_INPUT.defaultValue

	if (isSpringSelectionCapable(isSpringCapableGroup)) {
		const g = Group.first_selected
		const base = readGroupBase(g)
		const groupState = toSpringBoneState(g?.spring_bone_enabled)
		const boneUuid = typeof g?.uuid === 'string' ? g.uuid : null
		const override = anim !== null && boneUuid !== null ? readOverrides(anim)[boneUuid] : undefined
		const inherited = resolveEffective(base, groupState, undefined, PANEL_DEFAULTS)
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
	} else {
		// per-bone 行は隠れているので値は触らない。 checkbox の直前状態だけは空へ戻す
		// (= 次に bone を選んだ時に前の bone の状態が残らない)。
		last_override_checks = {}
	}
	// gesture 中は form への書き戻しだけ抑止する (= 表示の問題であって Undo とは無関係)。
	// BB の NumSlider drag は「現在の widget 値 + delta」 で次の値を作る
	// (= actions.ts slide())ため、 drag 中に setValues で widget 値を差し替えると
	// 以降の drag が別の起点から動いて表示が飛ぶ。 last_override_checks 等の内部状態は
	// 抑止せず最新に保つ。
	if (gesture_context !== null) return
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
		// **display_condition は付けない** : rest fade は animation 単位の値なので、 spring bone を
		// 選択していなくても編集できる必要がある。 bone 依存の 3 slider + override 2 行だけを
		// form element の condition で隠し、 Panel 自体は animate モードで常時出す。
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
	// bone 依存の行 (= 3 slider + override 2 行) の表示条件。 Panel を animate モード常時表示に
	// したため、 spring bone 未選択のときは書き込み先が無い。 出したままだと「操作できるのに
	// どこへ書かれるか分からない」 UI になるので、 行ごと隠す。
	const isBoneRowVisible = (): boolean => isSpringSelectionCapable(isSpringCapableGroup)

	const isOverrideRowVisible = (): boolean => {
		if (!isBoneRowVisible()) return false
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

	// 終端 rest 整合の fade 長 (= 選択中 animation の Animation Property)。 override 行と
	// 違って schema version gate は通さない : この Property は override map の schema とは
	// 独立した additive な field なので、 上位 version の raw を壊す経路が無い。
	const isRestFadeRowVisible = (): boolean => {
		const anim = Animation?.selected
		return !!anim && isAnimationAlive(anim)
	}
	form_config[REST_FADE_INPUT.key] = {
		label: REST_FADE_INPUT.label,
		type: 'num_slider',
		min: REST_FADE_INPUT.min,
		max: REST_FADE_INPUT.max,
		step: REST_FADE_INPUT.step,
		value: REST_FADE_INPUT.defaultValue,
		condition: isRestFadeRowVisible,
	}

	// NumSlider 3 個 = Group Property (= 全 animation 共通の既定値) の編集。
	// type: 'num_slider' = BB 5.1.4 の NumSlider (= slider 内蔵 + Ctrl/Shift 倍率変更 modifier
	// 対応)。 UX 要件 (= 数値入力 + スライドバーで直感的に連続調整) を満たす。 'number' 型は
	// NumericInput (= slider なし) で不適。
	// **condition で bone 選択に追従させる** (= isBoneRowVisible、 override 2 行と同じ扱い)。
	for (const meta of PANEL_INPUTS) {
		form_config[meta.key] = {
			label: meta.label,
			type: 'num_slider',
			min: meta.min,
			max: meta.max,
			step: meta.step,
			value: meta.defaultValue,
			condition: isBoneRowVisible,
		}
	}
	try {
		form.buildForm?.()
	} catch (e) {
		console.warn('[spring_bone] form.buildForm failed', e)
	}

	// form 値を実データから張り直す共通入口 (= 選択追従 / 書き込み後の再同期)。
	const sync = (): void => pushValuesFromSelectedGroup(form, isSpringCapableGroup, readOverrides)

	// 症状 1 (Undo 粒度爆発) の fix : NumSlider の 1 gesture (= drag / arrow key /
	// text 確定 1 回分) を 1 Undo entry に集約する。 BB core の NumSlider
	// (= actions.ts:1179/1210) は drag 開始 → onBefore、 drag 終了 → onAfter を
	// per-gesture 1 回ずつ発火する。 arrow key (:1112/1119)、 text 確定 (:1445-1454) も同経路。
	// これで form.on('input') が per-move-event で発火しても Undo entry は 1 gesture 1 個で済む。
	// form.buildForm() 後に form.form_data[key].slider が生きているタイミングで差し替える。
	//
	// **drag 中は Undo transaction を開かない** (= 本 Panel が BB 本体と違う点)。
	// onBefore で initEdit → onAfter で finishEdit にすると、 transaction が
	// 「ユーザーがマウスを押している間」 ずっと開いたままになる。 その区間には
	// project 切替 / animation 削除 / 選択変更 / 例外 / 中断 event が割り込めてしまい、
	// 閉じる側が別 project の UndoSystem を掴んで **他 project の Undo entry を壊す**、
	// 開きっぱなしで後続の Undo が壊れる、 といった事故が起きる。 開いている区間自体を
	// 無くせばこの種類の問題が丸ごと消えるため、 transaction は onAfter の同期処理内だけで
	// 開いて閉じる。 drag 中も値は書いて onChange() を呼ぶので preview の追従は従来どおり。
	//
	// **gesture context** : onBefore で「書き込み先を確定した context」 を作り、
	// gesture 中の form.on('input') はその context だけを見る (= 現在の選択を毎回
	// 見に行かない)。 drag 中に選択や checkbox 状態が変わっても開始時に掴んだ対象へ
	// 書き続けるため、 別の bone / animation へ値が飛ばない。

	// gesture 対象が今も書き込み可能か。 kind に関わらず **対象が現在の project に
	// 生存しているか** を必ず見る : group / animation のどちらも、 削除や project 切替で
	// 現在の project から外れた対象へ Undo transaction を張ると、 別 project の Undo 履歴を
	// 汚染する (= isGroupAlive のコメント参照)。 animation はさらに schema version gate を通す。
	const isGestureTargetValid = (ctx: SliderGestureContext): boolean => {
		// rest fade は bone に依存しない (= 書き込み先は animation だけ) ため、 group の
		// 生存は問わない。 選択中 bone が drag 中に消えても animation への書き込みは成立する。
		if (ctx.kind === 'rest_fade') {
			return ctx.animation !== null && isAnimationAlive(ctx.animation)
		}
		if (!isGroupAlive(ctx.group)) return false
		if (ctx.kind !== 'animation') return true
		const anim = ctx.animation
		return anim !== null && isAnimationAlive(anim) && canWriteOverrides(anim)
	}

	// gesture 対象の実データ値を読む (= 未設定なら undefined)。
	const readGestureValue = (ctx: SliderGestureContext): unknown => {
		if (ctx.kind === 'rest_fade') return ctx.animation?.[ANIM_REST_FADE_KEY]
		if (ctx.kind === 'animation') {
			return readOverrides(ctx.animation)[ctx.boneUuid]?.[ctx.key as PanelSliderKey]
		}
		return ctx.group[`spring_${ctx.key}`]
	}

	// gesture 対象へ値を書く。 **onChange() は呼ばない** : onAfter の巻き戻し区間で
	// registry sync と preview invalidate が余分に走らないよう、 書き込みと onChange の
	// 呼び出しを分離しておく (= 呼ぶ責任は呼び出し側)。
	// override map の書き換えは setOverrideField / clearOverrideField の戻り値代入だけで
	// 行う (= in-place 変更は readOverrides の memo も Undo の差分捕捉も壊す)。
	const writeGestureValue = (ctx: SliderGestureContext, value: unknown): void => {
		if (ctx.kind === 'rest_fade') {
			// 単一 Property の代入。 override map と違い正規化は読み側 (= restWindow.ts) が
			// 担うため、 ここでは値をそのまま書く (= rollback で undefined を戻す経路も含む)。
			ctx.animation[ANIM_REST_FADE_KEY] = value
			return
		}
		if (ctx.kind === 'animation') {
			const map = readOverrides(ctx.animation)
			const key = ctx.key as PanelSliderKey
			ctx.animation[ANIM_OVERRIDES_KEY] =
				typeof value === 'number' && Number.isFinite(value)
					? setOverrideField(map, ctx.boneUuid, key, value)
					: clearOverrideField(map, ctx.boneUuid, key)
			return
		}
		ctx.group[`spring_${ctx.key}`] = value
	}

	// gesture の書き込みを drag 前の値へ戻す (= Undo に載らなかった変更を消す)。
	// 中断 gesture (= onAfter が来ない経路) と失効 gesture (= 対象が project から
	// 外れた / 削除された) の後始末で使う。 **commit ではなく rollback を選ぶ理由** :
	// drag 中の書き込みは Undo transaction の外なので、 そのまま残すと復元不能な変更が
	// `Project.saved === true` のまま実データに残る。 中断された途中値をユーザーが
	// 意図したとは限らないため、 「操作が無かった」 状態へ戻す方が一貫する。
	// 書き戻し先が上位 schema version の animation の場合だけ raw を触らない
	// (= gate を迂回して未知構造を壊さない)。 対象が project から外れていても
	// 参照は context が握っているため書き戻し自体は成立する (= 代入は Undo に触れない)。
	const rollbackGesture = (ctx: SliderGestureContext): void => {
		try {
			if (ctx.kind !== 'animation' || canWriteOverrides(ctx.animation)) {
				writeGestureValue(ctx, ctx.before)
			}
			// preview / registry を巻き戻し後の実データに揃える (= drag 中の onChange で
			// 途中値が反映されたままになるのを防ぐ)。 **raw を触らなかった場合も必ず呼ぶ** :
			// 上位 schema へ変わった経路でも drag 中の書き込みで preview / session は
			// 途中値へ更新済みなので、 再解決を起動しないと Panel 表示だけが実態と食い違う。
			onChange()
		} catch (e) {
			console.warn('[spring_bone] gesture rollback failed', e)
		}
	}
	// gesture の開始手順 (= 全 slider 共通)。 書き込み先の解決だけを makeContext に委ね、
	// 前 gesture の後始末と context の確定はここで一元化する。
	// makeContext が null を返した場合は gesture を開始せず form を実データから再同期する
	// (= 書き込み先が無いのに widget の表示だけが動いた状態を残さない)。
	const beginSliderGesture = (makeContext: () => SliderGestureContext | null): void => {
		// 前 gesture が onAfter を受け取らずに終わっていた場合 (= touchcancel /
		// mouseup 取りこぼし / gesture 中の Panel 破棄) の後始末。 開いた Undo
		// transaction は無い (= drag 中は開かない) が、 **drag 中に書いた値は
		// 実データに残っている** ため、 放置すると Undo 不能な変更が
		// Project.saved === true のまま残る。 drag 前の値へ rollback する。
		const stale = gesture_context
		gesture_context = null
		if (stale !== null) {
			rollbackGesture(stale)
			// widget の表示値は中断時点のまま動いているので実データへ張り直す
			// (= context を null にした後に呼ぶこと、 でないと setValues が抑止される)。
			sync()
		}
		const ctx = makeContext()
		if (ctx === null) {
			sync()
			return
		}
		// drag 前の値を控える (= onAfter で before を捕捉するために戻す値)。
		ctx.before = readGestureValue(ctx)
		gesture_context = ctx
	}

	// Group 既定値 / animation override 用 slider (= PANEL_INPUTS) の書き込み先解決。
	const makePanelSliderContext = (key: PanelSliderKey): SliderGestureContext | null => {
		if (!isSpringSelectionCapable(isSpringCapableGroup)) return null
		const g = Group.first_selected
		const boneUuid = typeof g?.uuid === 'string' ? g.uuid : null
		if (boneUuid === null) return null
		const wantsOverride = last_override_checks[key] === true
		const anim = Animation?.selected ?? null
		// override 編集の成立条件 : animation が選択中で、 削除済みでなく
		// (= AnimationController 選択 / 削除では表示が stale になり得る)、
		// 書き込み可能な schema version であること。
		const useAnimation =
			wantsOverride && anim !== null && isAnimationAlive(anim) && canWriteOverrides(anim)
		// 表示上は override 編集中なのに書き込み先が無効。 このまま Group 既定値へ
		// フォールスルーすると意図しない対象を書き換えるため gesture を開始しない。
		if (wantsOverride && !useAnimation) return null
		return {
			key,
			kind: useAnimation ? 'animation' : 'group',
			group: g,
			boneUuid,
			animation: useAnimation ? anim : null,
			before: undefined,
		}
	}

	// rest fade slider の書き込み先解決。 **bone は見ない** : 対象は選択中 animation の
	// Property で、 どの bone を選んでいても同じ値を編集する。
	const makeRestFadeContext = (): SliderGestureContext | null => {
		const anim = Animation?.selected ?? null
		if (anim === null || !isAnimationAlive(anim)) return null
		const g = Group.first_selected
		return {
			key: REST_FADE_INPUT.key,
			kind: 'rest_fade',
			group: g,
			// Undo aspects にも書き込みにも使わないが、 context の形は共通に保つ。
			boneUuid: typeof g?.uuid === 'string' ? g.uuid : '',
			animation: anim,
			before: undefined,
		}
	}

	// gesture を張る slider 一覧 (= per-bone の 3 個 + per-animation の rest fade 1 個)。
	// onBefore の書き込み先解決だけが違い、 onAfter (= Undo transaction の張り方) は共通。
	const sliderTargets: Array<{ key: string; makeContext: () => SliderGestureContext | null }> = [
		...PANEL_INPUTS.map((meta) => ({
			key: meta.key as string,
			makeContext: () => makePanelSliderContext(meta.key),
		})),
		{ key: REST_FADE_INPUT.key, makeContext: makeRestFadeContext },
	]
	for (const target of sliderTargets) {
		const element = (form as any).form_data?.[target.key]
		const slider = element?.slider
		if (slider) {
			slider.onBefore = () => {
				beginSliderGesture(target.makeContext)
			}
			slider.onAfter = () => {
				// BB の NumSlider は drag / arrow key / wheel / text 確定の全経路で
				// onAfter を無条件発火する (= actions.ts)。
				const ctx = gesture_context
				if (ctx === null || !isGestureTargetValid(ctx)) {
					// 書き込み先が無い / gesture 中に失効した (= animation 削除 /
					// project 切替で対象が現在の project から外れた等)。 開いた
					// transaction は無いので閉じる処理は不要だが、 **drag 中の書き込みは
					// 実データに残っている** ため rollback する (= 失効した対象へ
					// Undo entry を張ると別 project の履歴を汚染するので commit しない)。
					gesture_context = null
					if (ctx !== null) rollbackGesture(ctx)
					// widget の表示値だけは動いている (= onBefore の早期 return は BB の
					// NumSlider 操作自体をキャンセルしない) ため、 実データから再同期する。
					sync()
					return
				}
				// initEdit を呼ぶ前に UndoSystem を local に確保する : BB の Undo は
				// 現在 project の UndoSystem を返す getter なので、 例外処理で再評価すると
				// 別 project の transaction を掴んで閉じる事故になる。 この同期区間だけの
				// ローカル追跡で足りる (= module scope の状態は増やさない)。
				// **initEdit の戻り値では判定しない** : BB は current_save を設定してから
				// init_edit を同期 dispatch する (= undo.js:24 → :28) ため、 listener が
				// throw すると代入式自体が完了せず戻り値が取れない。 initEdit 前の
				// current_save を控えて「変わったか」 で自分の transaction を判定する。
				let owner: any = null
				let prev_save: any = null
				try {
					// drag 中に書き込まれた最終値を退避する。
					const after = readGestureValue(ctx)
					// 値が変わっていない gesture では initEdit ごと行わない
					// (= 空の Undo entry も Project.saved = false も起こさない)。
					if (Object.is(after, ctx.before)) return
					// **一度 drag 前の値へ戻してから initEdit する** : initEdit は
					// 呼んだ瞬間の状態を before として記録するため、 戻さないと drag 後の
					// 値が before になり、 Undo しても何も戻らない entry ができる。
					// ここから finishEdit までは同期処理で、 描画も onChange も挟まらない
					// (= writeGestureValue は値を書くだけで onChange を呼ばない)。
					writeGestureValue(ctx, ctx.before)
					// 書き込み先が animation の 2 種 (= override / rest fade) は animation を、
					// Group 既定値は group を aspects に載せる。
					const aspects =
						ctx.kind === 'group' ? { groups: [ctx.group] } : { animations: [ctx.animation] }
					owner = Undo ?? null
					prev_save = owner?.current_save ?? null
					if (prev_save !== null) {
						// 既に開いている transaction がある = 他所の編集の最中。 BB の
						// initEdit は guard 無しで current_save を置換する (= undo.js:24) ので、
						// ここで開くとその編集が Undo から丸ごと消える。 gesture 側を諦めて
						// 「操作が無かった」 状態へ戻す (= 中断 gesture と同じ扱い)。
						console.warn('[spring_bone] slider onAfter skipped: another undo transaction is open')
						rollbackGesture(ctx)
						return
					}
					owner?.initEdit?.(aspects)
					writeGestureValue(ctx, after)
					owner?.finishEdit?.(
						ctx.kind === 'rest_fade' ? 'Change spring rest fade' : 'Change spring config',
					)
					// registry sync + preview invalidate は巻き戻しを挟まない最終状態で 1 回だけ。
					// **onChange は独立して catch する** : ここまで来た時点で Undo entry は
					// 確定済みなので、 onChange の例外で下の rollback を走らせると
					// 「entry は after / 実データは before」 という不整合になる。
					try {
						onChange()
					} catch (e) {
						console.warn('[spring_bone] onChange failed', e)
					}
				} catch (e) {
					// 巻き戻し区間は原子的に扱う : initEdit / finishEdit は同期 event を
					// dispatch するため listener の例外も伝播し得る。 中断すると
					// (a) 値が巻き戻し途中 (b) transaction が開いたまま (c) preview だけ
					// drag 後、 という 3 重の不整合が残るので個別に始末する。
					console.warn('[spring_bone] slider onAfter failed', e)
					// **どこで throw したかは current_save の状態で判定する**。
					// 自分の transaction が開いたまま (= initEdit 前から変わっている) なら
					// commit は成立していない。 消えているなら finishEdit が履歴へ entry を
					// 追加した後 (= undo.js:68 以降の dispatch / EditSession 送信) の throw で、
					// commit は成立している。
					const current = owner?.current_save ?? null
					if (current !== null && current !== prev_save) {
						// commit 未成立。 自分が開いた transaction だけを破棄し
						// (= cancelEdit の既定は revert しない = current_save を捨てるだけ、
						// BB undo.js:143-151)、 Undo entry の無い変更を残さないよう rollback する。
						try {
							owner.cancelEdit?.()
						} catch (e2) {
							console.warn('[spring_bone] slider onAfter cancelEdit failed', e2)
						}
						rollbackGesture(ctx)
					} else if (owner !== null) {
						// commit 成立済み (= 履歴の after は drag 後の値)。 ここで rollback すると
						// 履歴と実データが逆転して最初の Undo が効かなくなるため **戻さない**。
						// preview / registry だけ実データに揃える。
						// initEdit へ到達せず throw した経路 (= startChange 内の失敗) も
						// current_save が変わらないためここに来るが、 その場合は実データが
						// 既に巻き戻し済みなので onChange だけで整合する。
						try {
							onChange()
						} catch (e2) {
							console.warn('[spring_bone] onChange failed', e2)
						}
					} else {
						// initEdit 領域に入る前 (= 退避 / 巻き戻しの時点) で失敗した。
						// transaction は存在しないので rollback だけで足りる。
						rollbackGesture(ctx)
					}
				} finally {
					// 例外経路でも context を残さない (= 次 gesture が古い対象へ書くのを防ぐ)。
					gesture_context = null
					// gesture 中は pushValuesFromSelectedGroup 側で setValues を抑止して
					// いるため、 終了時に必ず実データから再同期する。 呼ばないと drag 中に
					// 選択が変わった場合、 form が旧対象の値を表示したまま次の同期 event まで
					// 実データと乖離する。 値が変わらず early return した no-op 経路も
					// finally を通るので同じ保証が効く。
					// **context を null にした後に呼ぶこと** (= 抑止が解けてから同期する)。
					sync()
				}
			}
		}
	}

	// form input event : 値変更を group Property または animation override に反映 + registry sync。
	form.on('input', ({ result, changed_keys }: { result: Record<string, any>; changed_keys: string[] }) => {
		try {
			// slider (= 数値項目) の drag 中の書き込み。 Undo transaction は開かず
			// (= onAfter で同期完結させる)、 ここでは実データへの反映だけ担う。
			// handler 末尾の onChange() で preview がリアルタイムに追従する。
			// **書き込み先は gesture context に固定されている** :
			//   kind 'animation' → onBefore で確定した animation の override map
			//   kind 'group'     → onBefore で確定した Group の既定値
			// gesture 中に選択や checkbox 状態が変わっても書き込み先は動かない
			// (= 現在の選択を毎回見に行くと別の bone へ値が飛ぶ)。
			// checkbox OFF (= kind 'group') でも slider を readonly にはしない :
			// animate モードで Group 既定値を編集できる唯一の手段が本 Panel の
			// slider であり、 readonly にするとその機能が失われるため。
			// slider の値変更はすべて onBefore/onAfter の gesture に包まれている
			// (= BB NumSlider は drag / arrow key / text 確定のいずれでも onBefore を
			// 発火する) ため、 gesture context が無い入力は書き込まない (= context
			// 無しの書き込みは onAfter の Undo 捕捉から漏れて復元不能になる)。
			// NumSlider text 入力の Molang 分岐 (= BB actions.ts:1421-1435) は NaN を返し得るため、
			// 書き込み前に finite check (= 潜在バグ Fable #2)。 非 finite は silent drop。
			for (const key of changed_keys) {
				const ctx = gesture_context
				// gesture 対象の項目以外は書かない (= 他 slider の値は別 gesture の担当)。
				if (ctx === null || key !== ctx.key) continue
				const v = result[key]
				if (typeof v !== 'number' || !Number.isFinite(v)) continue
				// 対象が gesture 中に無効化した (= animation 削除 / schema version 変化)
				// 場合は書き込みを止める。 onAfter 側でも同じ判定を通し form を再同期する。
				if (!isGestureTargetValid(ctx)) continue
				writeGestureValue(ctx, v)
			}
		} catch (e) {
			console.warn('[spring_bone] panel input handler failed', e)
		}

		// checkbox / selector の操作 = drag ではないため initEdit → 書き込み → finishEdit を
		// ここで 1 操作分完結させる。 slider の move event と混ざらないよう changed_keys で分岐する。
		// **現在の選択を見るのはこの経路だけ** : slider 側は gesture context に固定した
		// 対象へ書くため、 選択ベースの判定を通さない。
		const stateChanged = changed_keys.includes('spring_state')
		const overridesChanged = changed_keys.includes('overrides')
		if ((stateChanged || overridesChanged) && isSpringSelectionCapable(isSpringCapableGroup)) {
			const g = Group.first_selected
			const anim = Animation?.selected ?? null
			const boneUuid = typeof g?.uuid === 'string' ? g.uuid : null
			// slider 経路と同じ生存判定を書き込み前に通す : remove_animation の dispatch が
			// 別 listener の例外で中断された場合など、 Animation.selected が削除済み instance を
			// 保持したまま操作されうる。 現在の project に生存していない対象を現 project の
			// Undo 対象として書き換えると、 別 project / 削除済みデータの履歴を汚染する。
			const canWriteOverride =
				anim !== null && boneUuid !== null && isGroupAlive(g) && isAnimationAlive(anim)
			if (canWriteOverride && canWriteOverrides(anim)) {
				// slider 経路と同じく、 initEdit を呼ぶ前に UndoSystem と その時点の
				// current_save を local に確保する (= 例外時に Undo を再評価して別 project の
				// transaction を閉じない / initEdit の戻り値が取れない経路でも検出するため)。
				let owner: any = null
				let prev_save: any = null
				// 例外で transaction を作れなかった場合に書き込みを取り消すための退避。
				const prevRaw = anim[ANIM_OVERRIDES_KEY]
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
						// この transaction は handler 内で init → 書き込み → finish が
						// 同期的に完結する (= 開いている区間に project 切替や中断が
						// 割り込めない = slider gesture 側と同じ原則)。
						owner = Undo ?? null
						prev_save = owner?.current_save ?? null
						if (prev_save !== null) {
							// 既に開いている transaction がある = 他所の編集の最中。
							// initEdit は guard 無しで current_save を置換する (= undo.js:24)
							// ため、 ここで開くとその編集が Undo から消える。 書き込み自体を
							// 中止し、 失敗経路と同じく後段の sync() で form を実データから
							// 再同期する (= クリック済みの表示だけが残るのを防ぐ)。
							console.warn('[spring_bone] override write skipped: another undo transaction is open')
						} else {
							owner?.initEdit?.({ animations: [anim] })
							anim[ANIM_OVERRIDES_KEY] = map
							owner?.finishEdit?.('Change spring animation override')
						}
					}
				} catch (e) {
					// slider 経路と同じ後始末 : initEdit / finishEdit は同期 event を
					// dispatch するため listener の例外も伝播し得る。 開いたままの
					// transaction を残すと後続の Undo が壊れ、 Undo entry 無しの書き込みを
					// 残すと復元不能な変更になる。 判定は slider 経路と同じく
					// 「initEdit 前の current_save から変わったか」 で行う。
					console.warn('[spring_bone] panel override handler failed', e)
					const current = owner?.current_save ?? null
					if (current !== null && current !== prev_save) {
						// commit 未成立 : transaction を破棄し、 書き込み済みなら退避して
						// おいた raw へ戻す (= 代入は 1 文なので部分適用は起きず、 戻せば
						// 「操作が無かった」 状態に一致する)。
						try {
							owner.cancelEdit?.()
						} catch (e2) {
							console.warn('[spring_bone] panel override cancelEdit failed', e2)
						}
						try {
							anim[ANIM_OVERRIDES_KEY] = prevRaw
						} catch (e2) {
							console.warn('[spring_bone] panel override rollback failed', e2)
						}
					}
					// current_save が消えている場合は finishEdit が entry を追加した後の
					// throw = commit 成立なので **raw を戻さない** (= 履歴と実データが
					// 逆転して最初の Undo が効かなくなる)。 initEdit へ到達せず throw した
					// 経路もここに来るが、 その場合は代入前なので戻す対象自体が無い。
					// preview / registry / form は後段の onChange と sync が揃える。
				}
				// 書き込み後の再同期 (= ON → OFF で slider を継承値へ戻し、
				// last_override_checks を新しい map の truth に張り直す)。
				// setValues は 'input' を再発火しない (= cause: 'update_value') ため再帰しない。
				sync()
			} else {
				// 書き込み対象が無効な stale override 行の操作 (= Round 7 WANT-1) :
				// AnimationController.select() 後等で override 行が表示残留している
				// 状態で操作すると、 guard が偽で保存データは守られるがクリック済みの
				// selector / checkbox の表示がそのまま残る。 再同期して行を非表示にし、
				// 表示とデータの不一致を解消する。
				sync()
			}
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
	// 同期はその場で実行してよい (= 守るべき開いた Undo transaction が無いため)。
	// gesture 中の form 書き換えだけは pushValuesFromSelectedGroup 側で抑止している。
	sync_listeners = []
	for (const event of ['update_selection', 'select_animation', 'remove_animation', 'undo', 'redo', 'select_project', 'load_project']) {
		Blockbench.on(event, sync)
		sync_listeners.push({ event, fn: sync })
	}

	// 初回値同期 (= plugin load 時に既に spring group を選択済ケース)。
	sync()

	return () => {
		try {
			// gesture 中の Panel 破棄 / plugin unload。 開いた Undo transaction は無い
			// (= drag 中は開かない) が、 drag 中に書いた値は Undo に載らないまま実データに
			// 残るため、 onBefore の中断経路と同じく drag 前の値へ rollback する。
			const stale = gesture_context
			gesture_context = null
			if (stale !== null) rollbackGesture(stale)
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
