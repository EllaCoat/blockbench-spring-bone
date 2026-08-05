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
	const anim = Animation?.selected ?? null
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
// onChange = index.ts の onSpringPropertyChange (= registry sync + invalidatePreviewSession() による session 破棄)。
// isSpringCapableGroup = index.ts の isSpringGroup (= Property ベースの capable 判定) を注入。
// readOverrides = index.ts の readOverrides (= schema version gate + memo 付きの唯一の read 経路) を注入。
export function registerSpringPanel(
	onChange: () => void,
	isSpringCapableGroup: IsSpringCapableGroup,
	readOverrides: ReadOverrides,
): () => void {
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

	// 選択中 animation 限定の override 行 2 つ。 condition は Animation.selected の有無
	// (= animation 未選択でも Panel 自体と Group 既定値 slider は従来どおり使える)。
	// condition は form.update() が form_result を context に評価する
	// (= form.ts:223-232) ので、 値同期のたびに表示 / 非表示が追従する。
	form_config.spring_state = {
		label: 'In this animation',
		type: 'inline_select',
		options: { inherit: '継承', on: '有効', off: '無効' },
		value: 'inherit',
		condition: () => !!Animation?.selected,
	}
	form_config.overrides = {
		label: 'Override',
		type: 'inline_multi_select',
		options: { drag: 'drag', stiffness: 'stiffness', gravity: 'gravity' },
		// inline_multi_select は初期 value が無いと this.value が空 object のままになり、
		// setValue が「this.value に存在する key しか更新しない」 実装 (= form.ts:781-789)
		// のため以降の同期が一切反映されない。 全 key を false で初期化しておく。
		value: { drag: false, stiffness: false, gravity: false },
		condition: () => !!Animation?.selected,
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

	// その項目が override 書き込み対象か (= overrides 行の checkbox ON かつ animation
	// 選択中) の判定。 slider の onBefore (= drag 開始時の aspects 決定) と input
	// handler (= 書き込み先の分岐) の 2 箇所から使う。 form element の生値ではなく
	// last_override_checks (= override map と同期済みの truth) を見る。
	const isOverrideTarget = (key: PanelSliderKey): boolean =>
		!!Animation?.selected && last_override_checks[key] === true

	// 症状 1 (Undo 粒度爆発) の primary fix : NumSlider の onBefore/onAfter に
	// initEdit/finishEdit を寄せて per-gesture 1 Undo entry に集約する。 BB core の
	// NumSlider (= actions.ts:1179/1210) は drag 開始 → onBefore、 drag 終了 → onAfter を
	// per-gesture 1 回ずつ発火する。 arrow key (:1112/1119)、 text 確定 (:1445-1454) も同経路。
	// これで form.on('input') が per-move-event で発火しても Undo entry は 1 gesture 1 個で済む。
	// form.buildForm() 後に form.form_data[key].slider が生きているタイミングで差し替える。
	//
	// edit_started フラグは onBefore で initEdit を実際に発火できたかを追跡する。
	// drag 中に selection が非 spring group へ切り替わっても、 edit_started なら onAfter は
	// 必ず finishEdit を呼んで Undo transaction を閉じる (= Codex Round 3 IMO-1 対策、
	// 未対応だと initEdit が開きっぱなしになり後続の Undo 操作が壊れる)。
	let edit_started = false
	for (const meta of PANEL_INPUTS) {
		const element = (form as any).form_data?.[meta.key]
		const slider = element?.slider
		if (slider) {
			slider.onBefore = () => {
				if (!isSpringSelectionCapable(isSpringCapableGroup)) return
				try {
					// aspects は drag 開始時点の checkbox 状態で切り替える : checkbox ON =
					// 選択中 animation の override を書くため { animations }、 OFF = Group
					// 既定値を書くため { groups }。 drag 中に状態が変わっても aspects は
					// 開始時点で固定する (= before / after が別対象を指すのを防ぐ)。
					const aspects = isOverrideTarget(meta.key)
						? { animations: [Animation.selected] }
						: { groups: [Group.first_selected] }
					Undo?.initEdit?.(aspects)
					edit_started = true
				} catch (e) {
					console.warn('[spring_bone] slider onBefore failed', e)
				}
			}
			slider.onAfter = () => {
				if (!edit_started) return
				try {
					Undo?.finishEdit?.('Change spring config')
				} catch (e) {
					console.warn('[spring_bone] slider onAfter failed', e)
				} finally {
					edit_started = false
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
			// **書き込み先はその項目の override checkbox の状態で分岐する** :
			//   ON  → 選択中 animation の override map (= setOverrideField の戻り値を代入)
			//   OFF → 従来どおり Group 既定値
			// checkbox OFF でも slider を readonly にはしない : animate モードで Group
			// 既定値を編集できる唯一の手段が本 Panel の slider であり、 readonly にすると
			// その機能が失われるため。
			// NumSlider text 入力の Molang 分岐 (= BB actions.ts:1421-1435) は NaN を返し得るため、
			// 書き込み前に finite check (= 潜在バグ Fable #2)。 非 finite は silent drop。
			for (const key of changed_keys) {
				if (!PANEL_INPUTS.some((meta) => meta.key === key)) continue
				const v = result[key]
				if (typeof v !== 'number' || !Number.isFinite(v)) continue
				if (canWriteOverride && result.overrides?.[key] === true) {
					anim[ANIM_OVERRIDES_KEY] = setOverrideField(
						readOverrides(anim),
						boneUuid,
						key as PanelSliderKey,
						v,
					)
				} else {
					g[`spring_${key}`] = v
				}
			}
		} catch (e) {
			console.warn('[spring_bone] panel input handler failed', e)
		}

		// checkbox / selector の操作 = drag ではないため initEdit → 書き込み → finishEdit を
		// ここで 1 操作分完結させる。 slider の move event と混ざらないよう changed_keys で分岐する。
		const stateChanged = changed_keys.includes('spring_state')
		const overridesChanged = changed_keys.includes('overrides')
		if ((stateChanged || overridesChanged) && canWriteOverride) {
			try {
				Undo?.initEdit?.({ animations: [anim] })
				let map = readOverrides(anim)
				if (stateChanged) {
					const state = result.spring_state
					if (state === 'on' || state === 'off') {
						map = setOverrideField(map, boneUuid, 'enabled', state === 'on')
					} else {
						// 'inherit' (= または未知値) = enabled override を外す
						map = clearOverrideField(map, boneUuid, 'enabled')
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
					}
				}
				// map の書き換えは必ず setOverrideField / clearOverrideField の戻り値を
				// 代入する形で行う。 in-place 変更は readOverrides の memo (= raw の
				// object identity 比較) が検出できず、 Undo の差分捕捉も参照 identity
				// 前提のため両方を壊す。
				anim[ANIM_OVERRIDES_KEY] = map
				Undo?.finishEdit?.('Change spring animation override')
			} catch (e) {
				console.warn('[spring_bone] panel override handler failed', e)
			}
			// 書き込み後の再同期 (= ON → OFF で slider を継承値へ戻し、
			// last_override_checks を新しい map の truth に張り直す)。
			// setValues は 'input' を再発火しない (= cause: 'update_value') ため再帰しない。
			pushValuesFromSelectedGroup(form, isSpringCapableGroup, readOverrides)
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
	sync_listeners = []
	const sync = (): void => pushValuesFromSelectedGroup(form, isSpringCapableGroup, readOverrides)
	for (const event of ['update_selection', 'select_animation', 'undo', 'redo', 'select_project', 'load_project']) {
		Blockbench.on(event, sync)
		sync_listeners.push({ event, fn: sync })
	}

	// 初回値同期 (= plugin load 時に既に spring group を選択済ケース)。
	pushValuesFromSelectedGroup(form, isSpringCapableGroup, readOverrides)

	return () => {
		try {
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
