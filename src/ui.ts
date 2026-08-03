// Spring Bone plugin の animate モード用 sidebar Panel。
// edit モードは BB 標準 Element panel (= element_panel.ts) に任せる (= Property の
// element_panel input が自動で出る)。 element_panel は condition: {modes: ['edit']}
// で animate モード非表示のため、 animate 中の値編集を本 Panel が担う。
//
// 実装 pattern は BB 5.1.4 の element_panel.ts 実装を踏襲 :
//   - new InputForm({}) + form_config への input 追加 + buildForm() で dynamic 生成
//   - form.on('input', ...) で group[key] = result[key] を Undo wrap で反映
//   - Blockbench.on('update_selection', ...) で選択追従の form.setValues()
//
// mode 制約 = animate のみ表示にすることで edit モードは element_panel、 animate モードは
// 本 Panel が担う分業。 UX 上の重複を回避しつつ両モードで NumSlider 編集を提供できる。

declare const Panel: any
declare const InputForm: any
declare const Blockbench: any
declare const Group: any
declare const Undo: any

const BONE_NAME_PREFIX = 'spring_'

// Property 3 パラの UI メタ情報 (= registerProperties と 1:1 対応、 range / step も同値)。
const PANEL_INPUTS = [
	{ key: 'drag', label: 'Drag', min: 0, max: 1, step: 0.01, defaultValue: 0.05 },
	{ key: 'stiffness', label: 'Stiffness', min: 0, max: 10, step: 0.1, defaultValue: 1.0 },
	{ key: 'gravity', label: 'Gravity', min: 0, max: 100, step: 1, defaultValue: 0 },
] as const

// Panel 単一インスタンス + selection listener を管理する module state。
// register / unregister は plugin onload / onunload から 1 回ずつ呼ばれる想定。
let spring_panel: any = null
let selection_listener: ((...args: unknown[]) => void) | null = null

function isSpringSelectionActive(): boolean {
	const g = Group.first_selected
	return !!(g && typeof g.name === 'string' && g.name.startsWith(BONE_NAME_PREFIX))
}

// 選択中 group の Property 値を form にプッシュ (= 選択切替時の値同期)。
// group が spring_ でない場合は何もしない (= Panel は display_condition で自動非表示)。
function pushValuesFromSelectedGroup(form: any): void {
	if (!isSpringSelectionActive()) return
	const g = Group.first_selected
	const values: Record<string, number> = {}
	for (const meta of PANEL_INPUTS) {
		const raw = g?.[`spring_${meta.key}`]
		values[meta.key] = typeof raw === 'number' && Number.isFinite(raw) ? raw : meta.defaultValue
	}
	try {
		form.setValues?.(values)
		form.update?.(values)
	} catch (e) {
		console.warn('[spring_bone] panel setValues failed', e)
	}
}

// Panel + form + selection listener を register して cleanup 関数を返す。
// onChange = index.ts の onSpringPropertyChange (= registry sync + invalidatePreviewSession() による session 破棄)。
export function registerSpringPanel(onChange: () => void): () => void {
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
		// display_condition = spring_ prefix group が単独選択されているときのみ Panel 内容表示。
		// 非選択時は Panel が collapse or 非表示になる (= BB core 側の挙動)。
		display_condition: isSpringSelectionActive,
		default_position: {
			slot: 'right_bar',
			float_position: [0, 0],
			float_size: [300, 200],
			height: 200,
			sidebar_index: 3,
		},
		form,
	})

	// form_config に NumSlider 3 個を dynamic 追加してから buildForm。 element_panel.ts の
	// updateElementForm() と同 pattern (= form_config オブジェクト直接書き換え + buildForm)。
	// type: 'num_slider' = BB 5.1.4 の NumSlider (= slider 内蔵 + Ctrl/Shift 倍率変更 modifier
	// 対応)。 UX 要件 (= 数値入力 + スライドバーで直感的に連続調整) を満たす。 'number' 型は
	// NumericInput (= slider なし) で不適。
	const form_config = form.form_config
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
				if (!isSpringSelectionActive()) return
				try {
					Undo?.initEdit?.({ groups: [Group.first_selected] })
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

	// form input event : 値変更を group Property に反映 + registry sync。
	// Undo wrap は onBefore/onAfter に寄せた (= per-gesture 集約) ため、 ここでは書き込みと
	// registry sync だけ担う (= per-move-event で発火するが Undo entry は積まれない)。
	form.on('input', ({ result, changed_keys }: { result: Record<string, number>; changed_keys: string[] }) => {
		if (!isSpringSelectionActive()) return
		const g = Group.first_selected
		try {
			// changed_keys は PANEL_INPUTS の key (= drag / stiffness / gravity) から来るので
			// 追加の whitelist ガードは不要 (= 元の or チェーン常に true で冗長だった)。
			// NumSlider text 入力の Molang 分岐 (= BB actions.ts:1421-1435) は NaN を返し得るため、
			// 書き込み前に finite check (= 潜在バグ Fable #2)。 非 finite は silent drop、
			// readSpringProp 側 fallback (= DEFAULT_CONFIG) と併せて sim が汚染されない。
			for (const key of changed_keys) {
				const v = result[key]
				if (typeof v === 'number' && Number.isFinite(v)) {
					g[`spring_${key}`] = v
				}
			}
		} catch (e) {
			console.warn('[spring_bone] panel input handler failed', e)
		}
		// registry sync + fingerprint invalidate (= 次 tick で 0 replay、 preview 即反映)
		try {
			onChange()
		} catch (e) {
			console.warn('[spring_bone] onChange failed', e)
		}
	})

	// selection tracker : 選択 group 変わったら form 値を再同期。
	selection_listener = () => pushValuesFromSelectedGroup(form)
	Blockbench.on('update_selection', selection_listener)

	// 初回値同期 (= plugin load 時に既に spring group を選択済ケース)。
	pushValuesFromSelectedGroup(form)

	return () => {
		try {
			if (selection_listener) {
				Blockbench.removeListener?.('update_selection', selection_listener)
				selection_listener = null
			}
			spring_panel?.delete?.()
			spring_panel = null
		} catch (e) {
			console.warn('[spring_bone] panel unregister failed', e)
		}
	}
}
