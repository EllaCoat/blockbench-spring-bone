// blockbench-spring-bone — Blockbench plugin
// Spring bone physics simulation for hair / cloth / accessory bones.
// v0.0.9 で deterministic replay 方式に切替 :
//   - 物理 sim 進行を整数 step 番号 (= 1/60 秒格子、 springRuntime.ts) ベースで管理
//   - 毎 tick で currentTime を step 番号に snap、 0 → target step まで fixed-dt で完走
//   - 通常前進は cache (= 前 step) から進める軽量化、 逆行 / 大ジャンプは 0 から replay
//   - 結果 = frame ごとに値固定、 scrub 速度 / 履歴に依存しない、 巨大 dt 爆発なし
//   - 旧 accumulator (leftoverTime) + scrub_reset 機構は全廃 (= 履歴依存で deterministic でなかった)
//   - rescanRegistry を idempotent 化 (= 既存 entry の state を保持、 ボーンクリック時のリセット解消)
//   - applyAll は v0.0.8 の setFromUnitVectors 経路 (= 反射 basis half-lock 真因 fix) を維持
//   - 物理は v0.0.7 の VRM SpringBone 風 force injection (= boneAxis * stiffness * dt 注入) を維持
// Loop 連続性 = keyframe 側責任。 deterministic replay の構造上 loop wrap (= time 2.0 → 0) で
//   spring 慣性 state は rest に戻る (= runtime の replay 経路で resetAllToRest)。 周期境界での
//   ガクつきを避けるには「アニメ末端で物理が rest に収まる長さ」 で設計する必要あり。
//   残った場合は Phase 5 のベイク機能で微調整する方針 (= 過剰な loop seamless 機構は入れない)。

import { createState, resetState, step, type SpringConfig, type SpringState } from './springSim'
import {
	SpringRuntime,
	stepIndexFromFrame,
	stepIndexToTime,
	type SpringRuntimeOps,
	type AnimationContext,
	type RestWindowContext,
} from './springRuntime'
import { makeExportAnimationContext, type PreviewAnimationContext } from './animationContext'
import { createExportGate } from './exportGate'
import { createPreviewSession } from './previewSession'
import { installAjRegistrar, type AjRenderHooksApi } from './ajRegistrar'
import { isCapable, resolveEffective, resolveEnabled, shouldMigrate, toSpringBoneState, type SpringBoneState } from './springConfig'
import {
	ANIM_OVERRIDES_KEY,
	ANIM_SCHEMA_VERSION_KEY,
	SPRING_SCHEMA_VERSION,
	normalizeOverrides,
	overridesFingerprint,
	type SpringOverrideMap,
} from './animOverrides'
import { createExportDriver, type ExportDriverHost } from './ajExportBridge'
import {
	ANIM_REST_FADE_KEY,
	DEFAULT_REST_FADE_FRAMES,
	checkPreviewRestWindowTiming,
	checkRestWindowTiming,
	classifyRestWindowWeight,
	createRenderSampleCountCache,
	deriveDisplayedFinalFrame,
	resolveFadeFrames,
	restWindowFingerprint,
} from './restWindow'
import {
	ANIM_BAKED_FROM_KEY,
	ANIM_BAKED_PARAM_HASH_KEY,
	ANIM_BAKED_SOURCE_HASH_KEY,
	ANIM_BAKED_VERSION_KEY,
	BAKE_DENSITY_WARN_KF_PER_SECOND,
	BAKE_VERSION,
	applyBakedCurvesToAnimationData,
	bakeSpringRotations,
	hashFingerprint,
	isBakedAnimation,
	isBakedAnimationContext,
	type BakeResult,
	type BakeSceneOps,
	type BakeTarget,
} from './bakeTimeline'
import type { AxisTriple, QuaternionOps } from './curveFit'
import { registerSpringPanel } from './ui'
import {
	createAjSingleAnimationEvaluator,
	createInspectionHost,
	createInspectionProjectLifecycle,
	evaluateInspectionFrame,
	restoreSelectionInPlace,
	suppressInspectionEffects,
} from './inspectionAdapter'
import {
	createSpringBoneInspectionApi,
	isInspectionFaultedForGeneration,
	installInspectionGlobal,
	type InspectionHost,
	type InspectionMode,
	type InspectionRuntimeOwner,
	type SpringEvaluationInputV1,
	type InspectionPoseRead,
} from './inspectionProvider'

declare const Plugin: { register(id: string, opts: Record<string, unknown>): void }
declare const Blockbench: {
	on(event: string, fn: (...args: unknown[]) => void): void
	removeListener?(event: string, fn: (...args: unknown[]) => void): void
	// bake の結果通知 / 密度警告に使う (= js/api.ts:235)。
	showMessageBox?(options: Record<string, unknown>, callback?: (button: number | string) => void): unknown
}
declare const Project: { uuid?: string; groups?: unknown[]; elements?: unknown[]; saved?: boolean } | null
declare const Group: any
declare const Canvas: { scene?: { updateMatrixWorld?(force?: boolean): void }; updateView?(opt: unknown): void }
declare const Timeline: { time?: number; playing?: boolean }
declare const Animator: {
	showDefaultPose?(reduced?: boolean): void
	resetLastValues?(): void
	stackAnimations?(stack: unknown[], in_loop: boolean, blend?: number): void
	// paused 中の即時反映用 (= Property 値変更で display_animation_frame を強制 fire、
	// 停止中でも Panel slider の効果が視覚に出る)。
	preview?(): void
}
declare const Animation: { selected?: any; all?: any[] } | undefined
declare const Outliner: { selected?: any[]; elements?: any[] } | undefined
// BB の Animation Controller。 controller 再生中は playing flag ではなく controller の
// state が「今再生されている animation」 を決める (= animation_mode.js:357-394)。
declare const AnimationController: { selected?: any } | undefined
declare const Modes: { animate?: boolean; edit?: boolean } | undefined
// BB の現行 format。 bake は `euler_order` (= 全 node の mesh.rotation.order の出所、
// group.js:627) だけを読む。 未定義時は BB core の既定値 'ZYX' へ倒す (= format.ts:704)。
declare const Format: { euler_order?: string } | undefined
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
// AnimatedJava が公開する render hook registry を持つ global。 registry の形 (=
// AjRenderHooksApi) と optional で受ける理由は ajRegistrar.ts 側に集約する。
declare const window: {
	AnimatedJava?: { renderHooks?: AjRenderHooksApi }
	BlockbenchSpringBoneInspection?: unknown
} | undefined

const PLUGIN_ID = 'spring_bone'
const PLUGIN_VERSION = '0.0.17'

// name prefix `spring_` = **旧方式** (= v0.0.10 まで) の spring 化 truth。 現在の truth は
// Group Property `spring_bone_enabled` (= enum 3 値) に移行済みで、 prefix は
// 「旧ファイルからの移行判定 (= springConfig.shouldMigrate)」 だけに使う。
// bone 名自体は plugin から一切変更しない (= AnimatedJava の datapack
// 出力名に直結するため、 名前を書き換えると出力側の識別子まで変わってしまう)。

// 物理パラ (= VRM SpringBone デフォルト相当)。 時刻刻み関連の定数 (= FIXED_DT_SECONDS /
// FAST_FORWARD_STEP_THRESHOLD) は springRuntime.ts 側に集約。
const DEFAULT_CONFIG: Omit<SpringConfig, 'restLength'> = {
	drag: 0.05,        // 速度減衰 = 5% / step (= ふんわり残響、 VRM デフォルト相当)
	stiffness: 1.0,    // 親方向への per-step force coefficient
	gravity: 0,        // world -Y への per-step force、 既定 = 無効。 実機検証で値調整予定
}

// Property key list (= register / unregister / read で共有)。 key 名は
// `spring_<field>` にして、 旧方式の name prefix (= 'spring_') と統一感を持たせる。
const PROPERTY_KEYS = ['spring_drag', 'spring_stiffness', 'spring_gravity'] as const
type SpringPropertyKey = (typeof PROPERTY_KEYS)[number]

// spring bone 化の truth となる enum Property の key と値候補。
// registerProperties / patchMerge / unregisterProperties で共有する。
const SPRING_ENABLED_KEY = 'spring_bone_enabled'
const SPRING_ENABLED_VALUES = ['unset', 'enabled', 'disabled'] as const

// Animation 側の Property key (= ANIM_OVERRIDES_KEY / ANIM_SCHEMA_VERSION_KEY) と
// schema version (= SPRING_SCHEMA_VERSION) は animOverrides.ts に集約。 ui.ts の
// override 書き込み側とも同じ定数を共有するため、 定義箇所は 1 つに保つ。

// Group instance に自動で生える Property 値を読む helper。 Property が未定義
// or 未 register or NaN の場合は fallback を返す (= DEFAULT_CONFIG 値)。
function readSpringProp(group: unknown, key: SpringPropertyKey, fallback: number): number {
	const raw = (group as Record<string, unknown> | null)?.[key]
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

// Group instance の `spring_bone_enabled` を 3 値へ正規化して読む唯一の口。
// Property 未 register / 旧ファイル / 手編集で変な値が入っていても 'unset' に倒れる
// (= toSpringBoneState の「既知値以外はすべて 'unset'」 ルール)。
function getSpringBoneState(group: unknown): SpringBoneState {
	return toSpringBoneState((group as { spring_bone_enabled?: unknown } | null)?.spring_bone_enabled)
}

// Group Property から物理パラ (= drag / stiffness / gravity) を解決する唯一の口。
// registerGroup (= 初期 config) / rescanRegistry (= refresh) / onSpringPropertyChange
// (= Property 変更 hook) の 3 経路で共通。 戻り値に restLength / restLocalDir は
// **含めない** : これらは子 group の origin から算出される rig geometry 由来の値で
// Property 解決の対象外であり、 含めると geometry 算出値を DEFAULT へ戻す事故になる。
// 呼び出し側は `Object.assign(entry.base, resolveConfig(entry, null))` で base
// (= Group 既定値) に適用する。 effective (= entry.config) への合成は
// previewOps.resolveConfigs だけが行う (= effective の writer を 1 箇所に固定)。
// _animationContext は将来の per-animation 解決用の口 (= 今は読まない)。
function resolveConfig(
	entry: BoneEntry,
	_animationContext: AnimationContext | null,
): { drag: number; stiffness: number; gravity: number } {
	return {
		drag: readSpringProp(entry.group, 'spring_drag', DEFAULT_CONFIG.drag),
		stiffness: readSpringProp(entry.group, 'spring_stiffness', DEFAULT_CONFIG.stiffness),
		gravity: readSpringProp(entry.group, 'spring_gravity', DEFAULT_CONFIG.gravity),
	}
}

// --- animation 単位 override の読み取り口 ---

// readOverrides の 1 件 memo。 この関数は previewOps.resolveConfigs と
// hasActiveSpringEntry (= session fingerprint 経由) から毎 tick 呼ばれるため、
// 毎回 normalizeOverrides を走らせると object 生成が積む。 UI 側 (= setOverrideField) は
// 必ず新しい map object を代入する契約なので、 「animation instance が同一」 かつ
// 「raw の object identity が同一」 なら前回結果を再利用できる (= BB の Undo / merge 経路も
// structuredClone / normalize で必ず新しい object を入れるため、 値が変われば identity も
// 変わる)。 project 切替 / cleanup でクリアする (= 旧 project の instance 参照を握り続けない)。
// **memo key には正規化済みの schema version も含める** (= Round 5 WANT-1) :
// animation.extend({ spring_bone_schema_version: ... }) のような部分 merge では raw の
// object identity が変わらないため、 version を key に入れないと version を上げても
// 旧 map を返し続け、 下げても空 map のままになる。
let overridesMemo: { animation: any; raw: unknown; version: number | null; map: SpringOverrideMap } | null = null

// schema version の正規化 (= 有限の数値以外は null)。 readOverrides の gate /
// canWriteOverrides / memo key の 3 箇所で同じ判定を共有するため 1 箇所に集約する。
function normalizeSchemaVersion(raw: unknown): number | null {
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

// schema version が新しすぎて override を無視した旨を警告済みの animation uuid。
// readOverrides は毎 tick 呼ばれるため、 同一 animation への警告は 1 回だけに絞る。
// **project 切替 / install / cleanup でクリアする** : uuid 単位の抑止なので、 同一
// blueprint を複数 project で開くと 2 つ目以降の project で警告が出なくなる。
// overridesMemo と同じ 3 箇所でリセットして project ごとに 1 回は出るようにする。
const warnedNewerSchemaUuids = new Set<string>()

// animation の override map を読む唯一の口。 normalizeOverrides を通して返すため、
// 返却値は既知項目が検証済み (= 壊れた値は drop) の null-prototype map。
// - animation が null / undefined → 空 map
// - spring_bone_schema_version が SPRING_SCHEMA_VERSION より大きい → 未知構造の
//   override を解釈して壊さないよう無視して空 map を返す (= Group 既定値へ fallback)。
//   raw データ自体は書き換えない。 警告は animation ごとに 1 回だけ
function readOverrides(animation: any): SpringOverrideMap {
	const raw = animation?.[ANIM_OVERRIDES_KEY]
	const version = normalizeSchemaVersion(animation?.[ANIM_SCHEMA_VERSION_KEY])
	if (
		overridesMemo && overridesMemo.animation === animation &&
		overridesMemo.raw === raw && overridesMemo.version === version
	) {
		return overridesMemo.map
	}
	let map: SpringOverrideMap
	if (
		animation && typeof animation === 'object' &&
		version !== null && version > SPRING_SCHEMA_VERSION
	) {
		const uuid = typeof animation.uuid === 'string' ? animation.uuid : null
		if (uuid === null || !warnedNewerSchemaUuids.has(uuid)) {
			if (uuid !== null) warnedNewerSchemaUuids.add(uuid)
			console.warn(
				`[${PLUGIN_ID}] animation "${animation.name ?? uuid ?? '?'}" has newer ${ANIM_SCHEMA_VERSION_KEY} (${version} > ${SPRING_SCHEMA_VERSION}), ignoring spring bone overrides`,
			)
		}
		map = normalizeOverrides(undefined)
	} else {
		map = normalizeOverrides(raw)
	}
	overridesMemo = { animation, raw, version, map }
	return map
}

// 終端 rest 整合の fade 長 (= frame 単位) を animation から読む唯一の口。 非 finite /
// 未設定は既定値へ倒す (= readSpringProp と同じ規則)。 0 以上の整数への丸めと
// animation 長への圧縮は restWindow.ts 側が担うため、 ここでは raw をそのまま返す。
function readRestFadeFrames(animation: unknown): number {
	const raw = (animation as Record<string, unknown> | null)?.[ANIM_REST_FADE_KEY]
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_REST_FADE_FRAMES
}

// preview の sample 数 memo (= animation identity + raw length を key に 1 件だけ保持)。
// project 切替 / install / cleanup で clear する (= 旧 project の instance 参照を握らない)。
const renderSampleCountCache = createRenderSampleCountCache()

// rest window の timing が契約違反だった旨を警告済みの animation uuid。
// makePreviewRestWindow は毎 tick 走るため、 同一 animation への警告は 1 回だけに絞る。
// overridesMemo / warnedNewerSchemaUuids と同じ 3 箇所でリセットする。
const warnedRestWindowUuids = new Set<string>()

function warnRestWindowOnce(animation: any, reason: string): void {
	const uuid = typeof animation?.uuid === 'string' ? animation.uuid : null
	if (uuid !== null && warnedRestWindowUuids.has(uuid)) return
	if (uuid !== null) warnedRestWindowUuids.add(uuid)
	console.warn(
		`[${PLUGIN_ID}] animation "${animation?.name ?? uuid ?? '?'}" has invalid timing for the rest window (${reason}), disabling end-rest fade in preview`,
	)
}

// preview 経路の rest window を BB の Animation object から組み立てる。
// **preview は AJ を通らない** ため renderSampleCount を自前で数える (= AJ の render loop
// と同じ丸めで数え直す deriveRenderSampleCount)。 loop_delay は BB では string 型
// (= form 入力) なので、 AJ の renderAnimation と同じ `Number(...) || 0` で数値化して
// 値が食い違わないようにする。
//
// **契約違反の値は窓ごと省略する** (= weight ≡ 1 の従来動作へ倒す) : 0 に正規化して
// そのまま使うと weight ≡ 0 になり、 preview から物理が黙って消える。 export 経路と違って
// preview は止めない (= 止めると編集作業そのものが止まる) ので、 警告だけ出して減衰を諦める。
function makePreviewRestWindow(animation: any): RestWindowContext | undefined {
	// animation 未選択 (= 複数 animation の同時 stack preview) では終点が 1 つに定まらない
	// ため rest window を作らない (= weight ≡ 1 で従来動作)。
	if (!animation) return undefined
	// null = 数え切れない (= length が +Infinity、 または時刻が進まなくなった)。
	// **件数を打ち切った近似値では代用しない** : 妥当な整数に見えてしまい、 警告も出ないまま
	// preview と export の終端が食い違う。
	const sampleCount = renderSampleCountCache.get(animation, animation.length)
	if (sampleCount === null) {
		warnRestWindowOnce(
			animation,
			`cannot enumerate render samples for animation.length ${String(animation.length)}`,
		)
		return undefined
	}
	const timing = {
		// length が比較不能 (= NaN / 負 / undefined 等) だと sample 数が 0 になる。
		// checkPreviewRestWindowTiming がこれを契約違反として拾う (= 実在する極小
		// animation の N = 0 と区別する必要があるのは export 側だけ)。
		// **数値以外がすべて 0 になるわけではない** : '2' のような数値へ暗黙変換
		// できる値は AJ の `time <= animation.length` と同じ比較で数え切られる
		// (= 41 件)。ここを型で弾くと同じ length から AJ と preview で件数が
		// 食い違い、両端 rest の終点がズレる。
		renderSampleCount: sampleCount,
		loopMode: animation.loop,
		loopDelayFrames: Number(animation.loop_delay) || 0,
	}
	const violation = checkPreviewRestWindowTiming(timing)
	if (violation !== null) {
		warnRestWindowOnce(animation, violation)
		return undefined
	}
	return { timing, requestedFadeFrames: readRestFadeFrames(animation) }
}

// 「この animation の override を書いてよいか」の判定 (= Round 5 MUST-4)。
// schema version が SPRING_SCHEMA_VERSION より新しい animation には書かない :
// readOverrides は未知の上位 version に空 map を返すため、 その空 map 起点の
// 編集結果を代入すると未知 schema の raw が消え、 かつ version は新しいままなので
// 直後の読み取りで自分の編集すら無視される。 Panel の全書き込み経路
// (= slider gesture / checkbox / selector) は書き込み前にこの判定を通す。
function canWriteOverrides(animation: any): boolean {
	if (!animation || typeof animation !== 'object') return false
	const version = normalizeSchemaVersion((animation as Record<string, unknown>)[ANIM_SCHEMA_VERSION_KEY])
	return version === null || version <= SPRING_SCHEMA_VERSION
}

// `Animator.preview()` を呼ぶ唯一の口。 呼び出し条件と失敗時の扱いをここへ集約する。
// - **export 中は呼ばない** : Animator.preview は scene に base pose を当て直すため、 AJ が
//   確定させた pose を上書きしてしまう。 listener 側の guard では間に合わない
//   (= preview が同期的に scene を書き換えた後の display_animation_frame でしか気付けない)
// - **animate モード限定** : edit モードで呼ぶと Animator.preview 内の stackAnimations が
//   playing=true の Animation を edit viewport に適用して pose を壊す (= animation.js:230 で
//   Animation.select が playing=true を設定、 mode 切替後も flag を保持するため)
// - 失敗は warn に落とす (= preview refresh の失敗で呼び出し元の処理を巻き込まない)
function requestAnimatorPreview(reason: string): void {
	if (exportGate.isExportActive) return
	if (!Modes?.animate) return
	try {
		Animator?.preview?.()
	} catch (e) {
		console.warn(`[${PLUGIN_ID}] Animator.preview failed (${reason})`, e)
	}
}

// Property 変更時の同期 hook。 element_panel input の onChange から呼ばれる。
// - 全 registered spring group の Property 値を entry.base (= Group 既定値) に反映
//   (= effective への合成は次 tick の beginAnimation → resolveConfigs が行う)
// - fingerprint invalidate (= 次 tick で 0 replay 経路が走り、 preview 即反映)
// - `Animator.preview()` 明示呼び : playback 停止中は display_animation_frame が
//   自然発火しないため、 fingerprint invalidate だけでは scrub まで値が反映されない。
//   `Animator.preview()` を明示的に呼ぶことで停止中の即時反映を確保する (= 受け入れ条件 (c))。
function onSpringPropertyChange(): void {
	// **export 中は entry.base を書き換えない** : 進行中の export が読む物理パラを frame の
	// 途中で差し替えてしまう。 Property の値自体は BB 側 (= Group Property) に入っているので、
	// export 後の rescan (= 同じ resolveConfig の読み直し) で必ず追いつく。
	if (exportGate.deferRescanIfActive()) return
	for (const entry of registry.values()) {
		Object.assign(entry.base, resolveConfig(entry, null))
	}
	// fingerprint を空文字にすることで rescanRegistry 経由の invalidate を必ずトリガする
	// (= 次 tick の rescanRegistry で fp !== lastGraphFingerprint 判定が真になる)。
	lastGraphFingerprint = ''
	invalidatePreviewSession()
	// playback 停止中は display_animation_frame が自然発火しないため、 明示 preview で
	// 即時反映を確保する (= 受け入れ条件 (c))。 animate モード限定 / export 中 skip /
	// 失敗時の warn は requestAnimatorPreview に集約。
	requestAnimatorPreview('property change')
}

// 数値 Property 3 つ (= spring_drag / spring_stiffness / spring_gravity) の condition 判定。
// **capable (= 'enabled' | 'disabled') 基準** : condition は Property.copy の gate でもある
// (= property.ts:200) ため、 解除済み ('disabled') の group でも値が保存され続ける必要がある。
// prefix 依存のままだと `spring_` を外す rename / Property 解除で物理パラメータが
// 保存時に黙って消える。
// **context 2 経路** は従来通り :
//   (1) Property.merge / copy 経路 = BB core が instance を渡す (= 引数あり)
//   (2) element_panel input.condition 経路 = BB core が **context 無し** で呼ぶ
//       (element_panel.ts:56-58 `method: () => Condition(property.condition)` = 引数省略)
// 引数省略時は Group.first_selected (= 現在 UI で選択中の group) を参照する。
// なお、 Property.merge の load 時 ordering 問題 (= properties merge が instance の
// state 復元前に走る、 group.js:29-33) は本 condition では解消不可 (= merge 時点では
// spring_bone_enabled がまだ default の 'unset')。 そのため Property 各 instance の
// `.merge` を override して condition 迂回する (= registerProperties 内で instance
// method 直接差し替え)。
function isSpringGroupForProperty(group?: unknown): boolean {
	if (group === undefined || group === null) {
		// context 無し呼び出し = 現在選択中 group で判定
		return isCapable(getSpringBoneState((Group as { first_selected?: unknown })?.first_selected))
	}
	return isCapable(getSpringBoneState(group))
}

// Property 11 個を register (= Group 側 4 個 : 数値 3 + enum `spring_bone_enabled`、
// Animation 側 7 個 : object `spring_bone_overrides` + number `spring_bone_schema_version`
// + number `spring_bone_rest_fade_frames` + bake metadata 4 個 (= string `spring_bone_baked_from`
// / string `spring_bone_baked_param_hash` / string `spring_bone_baked_source_hash`
// / number `spring_bone_baked_version`))。
// plugin onload で 1 回だけ呼ぶ。 数値 Property の element_panel input は edit モードのみ
// 表示 (= BB 本体側の element_panel.ts condition)、 animate モードでは自然に消える。
// animate モード用の値編集は専用 Panel (= ui.ts) で提供。
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

	// Property.merge の load 時 ordering 問題 (= properties merge が instance の state /
	// name 復元前に走る、 group.js:29-33) を回避するため、 各 Property の .merge を
	// override して condition 迂回。 data 側に値がある (= 保存済みの証拠) 場合は無条件 copy。
	// これで .bbmodel reload で値が復帰する。 標準 merge の condition gate だけを迂回し、
	// 値の妥当性検証は型ごとに残す (= 数値は finite number、 enum は SPRING_ENABLED_VALUES
	// に含まれる文字列のみ)。
	// merge data に key が無い場合は **数値 / enum ともに skip** (= 何もしない)。
	// enum に「key 欠落時に default へ書き戻す」 分岐があったが、 BB は `Group.extend({origin: ...})`
	// のような一部 key だけを持つ data での部分更新に extend を日常的に使うため、 そのたびに
	// spring 状態が 'unset' へ巻き戻り、 数値 Property の capable condition も連鎖で偽になって
	// 保存時に spring_drag 等が丸ごと欠落する (= Critical review 指摘)。 enum Property の
	// condition を外したことで Undo 捕捉 / blueprint 保存に key が必ず入るようになり、
	// 「欠落 = 'unset' だった」 と解釈する必要自体が消えた。
	// copy / element_panel visibility は数値 Property の condition (= isSpringGroupForProperty)
	// が保持 (= 非 spring group への数値 Property 汚染ゼロ)。
	const patchMerge = (prop: any, key: string, enumValues?: readonly string[]): void => {
		prop.merge = function (instance: any, data: any) {
			if (data?.[key] === undefined) return
			const value = data[key]
			if (enumValues) {
				if (typeof value === 'string' && enumValues.includes(value)) {
					instance[key] = value
				}
			} else if (typeof value === 'number' && Number.isFinite(value)) {
				instance[key] = value
			}
		}
	}

	// object 型 Property (= spring_bone_overrides) 用の merge patch。
	// BB 標準の object merge (= property.ts:188-192) は structuredClone してそのまま入れる
	// だけで中身を検証しないため、 こちらでは normalizeOverrides を通して既知項目の妥当性を
	// 検証する (= 壊れた項目だけを drop し、 未知 key は前方互換のため保持)。
	// data[key] === undefined は skip (= 部分更新の extend で override が巻き戻らないようにする)。
	// **未知の上位 schema version の data は normalize せず raw をそのまま保持する**
	// (= Round 5 MUST-3) : 新しい version の blueprint を開いて保存するだけで未知構造や
	// field が脱落して raw が壊れるのを防ぐ。 version は **data 側を優先し、 data に
	// 無ければ instance 側を fallback にする** : data 側優先は merge 順への非依存のため
	// (= merge は Property ごとに独立して走る)、 instance fallback は部分更新の
	// extend (= `animation.extend({ spring_bone_overrides: raw })` のように version を
	// 含まない data) が instance 側の gate を迂回して上位 schema の raw を normalize
	// してしまうのを防ぐため (= Round 8 WANT-2)。 本 patch は ANIM_OVERRIDES_KEY 専用で、
	// version key も Animation 側のものを直接参照する。
	const patchMergeObject = (prop: any, key: string): void => {
		prop.merge = function (instance: any, data: any) {
			if (data?.[key] === undefined) return
			const version =
				normalizeSchemaVersion(data?.[ANIM_SCHEMA_VERSION_KEY]) ??
				normalizeSchemaVersion(instance?.[ANIM_SCHEMA_VERSION_KEY])
			if (version !== null && version > SPRING_SCHEMA_VERSION) {
				// **前提契約 (= Round 7 WANT-2)** : この raw 保持が保存まで機能するには、
				// `spring_bone_overrides` の top-level が将来の schema version でも
				// 常に object である必要がある。 Property の登録型は 'object' で、
				// BB の Property.copy は `typeof value === 'object'` の値しか出力
				// しない (= property.ts:217-220) ため、 将来の schema で top-level が
				// 文字列等の primitive に変わると、 開いて保存するだけで raw が
				// 黙って消える。 version を上げる際は top-level を object に保つこと。
				instance[key] = structuredClone(data[key])
			} else {
				instance[key] = normalizeOverrides(data[key])
			}
		}
	}

	const drag_prop = new Property(Group, 'number', 'spring_drag', makeConfig('Spring drag', DEFAULT_CONFIG.drag, 0, 1, 0.01))
	const stiffness_prop = new Property(Group, 'number', 'spring_stiffness', makeConfig('Spring stiffness', DEFAULT_CONFIG.stiffness, 0, 10, 0.1))
	const gravity_prop = new Property(Group, 'number', 'spring_gravity', makeConfig('Spring gravity', DEFAULT_CONFIG.gravity, 0, 100, 1))

	// spring bone 化の唯一の truth となる enum Property。 **3 値にする理由** : boolean +
	// default false だと「旧ファイルで未設定」と「明示的に解除した」が instance 上で区別
	// できず、 BB が constructor で全 Property を default へ reset する
	// (property.ts:225-236) ため、 prefix 付き bone の解除 → 保存 → 再読込で移行処理が
	// 再び有効化してしまう。 3 値なら移行済み判定が値そのものから出るため、 別の marker
	// や project 単位の version は要らない。
	// element_panel input は付けない (= 有効化 / 解除は右クリ action が担う)。
	// **condition は付けない** : condition は save gate だけでなく Property.copy の gate
	// も兼ねる (= property.ts:200) ため、 付けると 'unset' の group で Undo 捕捉
	// (= getChildlessCopy → Property.copy) と blueprint 保存の両方から key が欠落する。
	// 欠落した key は部分更新の merge 経路で巻き戻りを誘発するため、 condition を外して
	// copy に常に値を書かせる (= 部分更新 merge も Undo 捕捉も key 欠落が起きない形に揃える)。
	// 代償として無関係な project の全 group に "unset" が書き出されるが、 blueprint の
	// サイズ微増のみで AnimatedJava の datapack 出力には影響しないため許容する。
	const enabled_prop = new Property(Group, 'enum', SPRING_ENABLED_KEY, {
		default: 'unset',
		values: SPRING_ENABLED_VALUES,
	})

	patchMerge(drag_prop, 'spring_drag')
	patchMerge(stiffness_prop, 'spring_stiffness')
	patchMerge(gravity_prop, 'spring_gravity')
	patchMerge(enabled_prop, SPRING_ENABLED_KEY, SPRING_ENABLED_VALUES)

	// --- Animation Property (= animation ごとの override) ---
	// **condition は付けない** (Group の enum Property と同じ理由) : BB の Property.copy は
	// condition が false のとき key を丸ごと落とす (= property.ts:200) ため、 付けると
	// Undo の before/after copy で key が欠落し、 「override を全部消す → Redo」 で after 側に
	// key が無く merge が skip され、 消したはずの override が復活する (= PR-A で Group の
	// enum Property に condition を付けて踏んだ致命バグと同型)。
	// 代償として無関係な project の全 animation に `{}` と `1` が serialize されるが、
	// blueprint のサイズ微増のみで許容する。
	// element_panel input は付けない (= 値編集は後続 commit の専用 UI が担う)。
	// object default は BB の getDefault が instance ごとに複製する (= property.ts:156-158)
	// ため、 全 animation で default object を共有することはない。
	if (typeof Animation === 'function') {
		const overrides_prop = new Property(Animation, 'object', ANIM_OVERRIDES_KEY, {
			default: {},
		})
		const version_prop = new Property(Animation, 'number', ANIM_SCHEMA_VERSION_KEY, {
			default: SPRING_SCHEMA_VERSION,
		})
		// 終端 rest 整合の fade 長 (= frame 単位)。 **schema version は上げない** :
		// override map とは独立した additive な optional field で、 欠落時は既定値へ
		// 倒れるだけなので、 この Property を知らない旧 version で開いても壊れない
		// (= 上位 version 扱いにすると旧 plugin が override を丸ごと無視してしまう)。
		const rest_fade_prop = new Property(Animation, 'number', ANIM_REST_FADE_KEY, {
			default: DEFAULT_REST_FADE_FRAMES,
		})
		patchMergeObject(overrides_prop, ANIM_OVERRIDES_KEY)
		patchMerge(version_prop, ANIM_SCHEMA_VERSION_KEY)
		patchMerge(rest_fade_prop, ANIM_REST_FADE_KEY)

		// bake で作った派生 animation のメタデータ 4 個。 **schema version は上げない** :
		// rest fade と同じく additive な optional field で、 欠落時は「bake 由来ではない」
		// へ倒れるだけなので、 この Property を知らない旧 version で開いても壊れない。
		// condition は付けない (= 他の Animation Property と同じ理由 : Property.copy の
		// gate も兼ねるため、 付けると Undo 捕捉と blueprint 保存から key が落ちる)。
		// 既定値は「bake 由来ではない」 を表す空文字 / 0 (= isBakedAnimation が false になる)。
		// patchMerge は通さない : condition を付けていないので BB 標準の merge
		// (= Merge.string / Merge.number) で load 時も正しく復帰する。
		new Property(Animation, 'string', ANIM_BAKED_FROM_KEY, { default: '' })
		new Property(Animation, 'string', ANIM_BAKED_PARAM_HASH_KEY, { default: '' })
		new Property(Animation, 'string', ANIM_BAKED_SOURCE_HASH_KEY, { default: '' })
		new Property(Animation, 'number', ANIM_BAKED_VERSION_KEY, { default: 0 })

		// **登録前から存在する Animation instance への backfill** (= Group 側と同じ理由 :
		// Property の default は新規 instance の constructor でしか入らないため、 plugin を
		// 後から有効化した場合の既存 Animation には値が無いまま)。
		// Animation.all が取れない (= Project 未オープン) 場合は何もしない。
		try {
			const all = (Animation as { all?: unknown[] }).all
			if (Array.isArray(all)) {
				for (const a of all) {
					const anim = a as Record<string, unknown> | null
					if (anim == null) continue
					if (anim[ANIM_OVERRIDES_KEY] === undefined) anim[ANIM_OVERRIDES_KEY] = {}
					if (anim[ANIM_SCHEMA_VERSION_KEY] === undefined) anim[ANIM_SCHEMA_VERSION_KEY] = SPRING_SCHEMA_VERSION
					if (anim[ANIM_REST_FADE_KEY] === undefined) anim[ANIM_REST_FADE_KEY] = DEFAULT_REST_FADE_FRAMES
				}
			}
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] animation property backfill failed`, e)
		}
	} else {
		console.warn(`[${PLUGIN_ID}] Animation class not available, skipping animation property registration`)
	}

	// **登録前から存在する Group instance への backfill** : Property は新規 instance の
	// constructor で Property.reset 経由の default (= 'unset') が入るが、 登録より前から
	// 生きている instance (= plugin を後から有効化した場合の既存 Group) には値が無いまま。
	// enum Property の condition を外したため Property.copy は無条件に値を書く一方、
	// merge 側 (= patchMerge) は undefined を skip する。 値が undefined のままだと Undo の
	// before-copy に undefined が入り、 非 prefix Group の初回「Spring 化」を Undo しても
	// 'enabled' のまま 'unset' に戻らない。 ここで 'unset' を補完して両経路を揃える。
	// Group.all が取れない (= Project 未オープン) 場合は何もしない。
	try {
		const all = (Group as { all?: unknown[] })?.all
		if (Array.isArray(all)) {
			for (const g of all) {
				if ((g as { spring_bone_enabled?: unknown } | null)?.spring_bone_enabled === undefined) {
					;(g as Record<string, unknown>).spring_bone_enabled = 'unset'
				}
			}
		}
	} catch (e) {
		console.warn(`[${PLUGIN_ID}] spring_bone_enabled backfill failed`, e)
	}
}

// plugin onunload で Property を Group.properties から delete。 unload → reload で
// 二重登録警告が出るのを避ける。 Group instance 側の値は blueprint 側に既に serialize
// されていれば reload 時に自動で復帰する。
function unregisterProperties(): void {
	const props = (Group as { properties?: Record<string, unknown> } | undefined)?.properties
	if (props) {
		for (const key of PROPERTY_KEYS) {
			delete props[key]
		}
		delete props[SPRING_ENABLED_KEY]
	}
	// Animation 側 (= animation ごとの override) も同様に delete。
	// instance 側の値は blueprint に serialize されていれば reload 時に復帰する。
	const animProps = (Animation as { properties?: Record<string, unknown> } | undefined)?.properties
	if (animProps) {
		delete animProps[ANIM_OVERRIDES_KEY]
		delete animProps[ANIM_SCHEMA_VERSION_KEY]
		delete animProps[ANIM_REST_FADE_KEY]
		delete animProps[ANIM_BAKED_FROM_KEY]
		delete animProps[ANIM_BAKED_PARAM_HASH_KEY]
		delete animProps[ANIM_BAKED_SOURCE_HASH_KEY]
		delete animProps[ANIM_BAKED_VERSION_KEY]
	}
}

// Group 右クリ context menu に「Spring 化 / Spring 解除」 の 4 action を追加する。
// 実装 gesture (= 唯一の truth) は Group Property `spring_bone_enabled` の書き換え。
// **名前は一切変更しない** (= bone 名は AnimatedJava の datapack 出力名に直結するため)。
// action は BB core の Group.prototype.menu.structure に append され、 group 右クリで表示される。
// condition で「対象 group の Property 状態」 に応じて片方のみを visible にする
// (= mutually exclusive)。
let registeredMenuEntries: unknown[] = []

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
// - 順序 = pre-order DFS (= 親 → 子)、 Property 書き換え側では順序に依存しないが consistency のため
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
		// (空なら first_selected fallback) を対象に「'enabled' でない group が 1 個でもあるか」 で判定。
		// 判定範囲を click 側 (= multi_selected filter) と一致させ、 状態が異なる複数選択で
		// 「表示されるが発火しない」 症状を排除する (Sol Round 3 MUST-2 = 単独 action 側の同型 bug)。
		condition: (context?: unknown) =>
			evaluateActionScope(context, (g) => getSpringBoneState(g) !== 'enabled', false),
		click() {
			const groups = ((Group as { multi_selected?: unknown[] })?.multi_selected ?? []).filter(
				(g) => getSpringBoneState(g) !== 'enabled',
			) as Array<{ spring_bone_enabled?: unknown }>
			if (groups.length === 0) return
			try {
				Undo?.initEdit?.({ groups })
				for (const g of groups) g.spring_bone_enabled = 'enabled'
				Undo?.finishEdit?.('Spring 化')
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] springify failed`, e)
			}
			// Property 変更直後に registry を再構築 (= 新規 spring group を pick up、 fingerprint
			// 変化で次 tick に 0 replay 起動)。 これで context menu 直後の物理追従が selection
			// 変更を待たずに即発火する。
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
			requestAnimatorPreview('springify')
		},
	})

	const unspringify = new Action(`${PLUGIN_ID}_unspringify`, {
		name: 'Spring 解除',
		icon: 'link_off',
		// springify 側と対称の evaluateActionScope 経由判定 (Sol Round 3 MUST-2)。
		// 「'enabled' の group が 1 個でも選択範囲にあれば表示」、 click 側 (multi_selected filter)
		// と一致する走査で、 混在選択時の表示発火食い違い排除。
		condition: (context?: unknown) =>
			evaluateActionScope(context, (g) => getSpringBoneState(g) === 'enabled', false),
		click() {
			const groups = ((Group as { multi_selected?: unknown[] })?.multi_selected ?? []).filter(
				(g) => getSpringBoneState(g) === 'enabled',
			) as Array<{ spring_bone_enabled?: unknown }>
			if (groups.length === 0) return
			try {
				Undo?.initEdit?.({ groups })
				// 解除は必ず 'disabled' にする。 'unset' に戻すと名前に prefix が残っている
				// group (= 旧方式由来) で次の rescan の移行処理が再び有効化してしまう。
				// なお animation 側の override は削除しない (= 後続 commit の animation 単位
				// override 設計で、 再有効化時に復帰できるようにするため)。
				for (const g of groups) g.spring_bone_enabled = 'disabled'
				Undo?.finishEdit?.('Spring 解除')
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] unspringify failed`, e)
			}
			// Property 変更直後に registry を再構築 (= 解除された group は capable のため registry に
			// 残るが、 fingerprint に含めた state 変化で次 tick に 0 replay が起動し、 step / apply の
			// 対象から外れる)。 これで残存 spring group の物理が selection 変更を待たずに継続する。
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
			// 凍結解決の primary fix : 物理対象から外れた後、 mesh.rotation には plugin が最後に書いた
			// 物理姿勢が残る。 paused / 純物理 bone (= keyframe を持たない) の場合、
			// showDefaultPose → stackAnimations の loop が「何も当てない」 状態で rest 固定となり
			// 「アニメーションが完全停止」 に見える (= 症状 3 凍結の真因)。 Animator.preview を明示発火し
			// 現在 Timeline.time の pose を apply して mesh.rotation を上書きすることで、
			// 解除された bone の visual が最新 animation state に追従する。
			requestAnimatorPreview('unspringify')
		},
	})

	// 子孫再帰版の spring 化 sub-action (= 選択 group + 全子孫を一括で spring 化)。
	// 単独 spring 化 (= springify) は残す、 opt-in で子孫再帰版を選ぶ形。
	// condition = 選択 group または子孫のいずれかが 'enabled' でなければ表示
	// (= 選択部分木が既に全 spring 化済みなら意味ないので隠す)。
	const springify_recursive = new Action(`${PLUGIN_ID}_springify_recursive`, {
		name: 'Spring 化 (子孫含む)',
		icon: 'account_tree',
		condition: (context?: unknown) =>
			evaluateActionScope(context, (g) => getSpringBoneState(g) !== 'enabled', true),
		click() {
			// multi-select 対応 = 選択中の全 root group と、 各々の子孫全部を集める
			// (= uuid dedup で「兄弟同士で親子関係にある」 malformed 選択も安全)
			const selected = ((Group as { multi_selected?: unknown[] })?.multi_selected ?? []) as unknown[]
			const seenUuids = new Set<string>()
			const targets: Array<{ spring_bone_enabled?: unknown }> = []
			for (const s of selected) {
				for (const g of collectGroupAndDescendants(s)) {
					const uuid = (g as { uuid?: unknown } | null)?.uuid
					if (typeof uuid !== 'string' || seenUuids.has(uuid)) continue
					seenUuids.add(uuid)
					if (getSpringBoneState(g) !== 'enabled') {
						targets.push(g as { spring_bone_enabled?: unknown })
					}
				}
			}
			if (targets.length === 0) return
			try {
				Undo?.initEdit?.({ groups: targets })
				for (const g of targets) g.spring_bone_enabled = 'enabled'
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
			requestAnimatorPreview('springify_recursive')
		},
	})

	// 子孫再帰版の spring 解除 sub-action (= 選択 group + 全子孫を一括で 'disabled' にする)。
	// springify_recursive の対称版、 chain 途中で不用意に spring 化した range を一気に戻す用途。
	const unspringify_recursive = new Action(`${PLUGIN_ID}_unspringify_recursive`, {
		name: 'Spring 解除 (子孫含む)',
		icon: 'link_off',
		// 選択部分木 (context or multi_selected) に対象があれば表示、 evaluateActionScope で
		// click 側 (= multi_selected 走査) と一致する範囲判定 = Action.trigger 経路の食い違い解消
		condition: (context?: unknown) =>
			evaluateActionScope(context, (g) => getSpringBoneState(g) === 'enabled', true),
		click() {
			const selected = ((Group as { multi_selected?: unknown[] })?.multi_selected ?? []) as unknown[]
			const seenUuids = new Set<string>()
			const targets: Array<{ spring_bone_enabled?: unknown }> = []
			for (const s of selected) {
				for (const g of collectGroupAndDescendants(s)) {
					const uuid = (g as { uuid?: unknown } | null)?.uuid
					if (typeof uuid !== 'string' || seenUuids.has(uuid)) continue
					seenUuids.add(uuid)
					if (getSpringBoneState(g) === 'enabled') {
						targets.push(g as { spring_bone_enabled?: unknown })
					}
				}
			}
			if (targets.length === 0) return
			try {
				Undo?.initEdit?.({ groups: targets })
				// 単独版と同じく必ず 'disabled' にする (= 'unset' へ戻すと prefix 残存 group で
				// 次の rescan の移行処理が再有効化する)。 animation 側の override は削除しない。
				for (const g of targets) g.spring_bone_enabled = 'disabled'
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
			requestAnimatorPreview('unspringify_recursive')
		},
	})

	// Group.prototype.menu.structure に append (= 「rename」「delete」 の末尾に並ぶ)。
	const sep = new MenuSeparator(`${PLUGIN_ID}_actions`)
	menu.structure.push(sep, springify, springify_recursive, unspringify, unspringify_recursive)
	registeredMenuEntries.push(sep, springify, springify_recursive, unspringify, unspringify_recursive)
}

// Animation 右クリ context menu (= Animations panel) に追加した entry。 Group 側とは
// menu が別なので保持も別にする。
let registeredAnimationMenuEntries: unknown[] = []

// menu から渡された context を Animation instance として解決する。 Action は menu 経由なら
// clicked entry を第 1 引数で受け取る (= menu.js:511 `s.click(scope_context, e)`) が、
// keybind 等の Action.trigger 経由では Event が来るため、 生存確認を通したものだけ採用し、
// 駄目なら選択中 animation へ fallback する (= Group 側の isRealGroup と同じ考え方)。
function resolveMenuAnimation(context: unknown): any | null {
	const all: any[] = Array.isArray((Animation as any)?.all) ? (Animation as any).all : []
	if (context && all.includes(context)) return context
	const selected = (Animation as any)?.selected
	return selected && all.includes(selected) ? selected : null
}

// Animation 右クリ menu に bake action を 1 つ追加する。 対象は clicked animation
// (= 無ければ選択中)。 bake 由来の派生 animation では出さない (= 二重 bake の防止)。
function registerBakeAction(): void {
	if (typeof Action !== 'function' || typeof MenuSeparator !== 'function') {
		console.warn(`[${PLUGIN_ID}] Action or MenuSeparator not available, skipping bake action registration`)
		return
	}
	const menu = (Animation as unknown as { prototype?: { menu?: { structure?: unknown[] } } })?.prototype?.menu
	if (!menu || !Array.isArray(menu.structure)) {
		console.warn(`[${PLUGIN_ID}] Animation.prototype.menu.structure not available, skipping bake action registration`)
		return
	}

	const bake = new Action(`${PLUGIN_ID}_bake_animation`, {
		name: 'Spring を bake (派生 animation)',
		icon: 'save_as',
		// spring bone が 1 本も無い project や、 既に bake 済みの派生 animation では隠す。
		condition: (context?: unknown) => {
			if (registry.size === 0) return false
			const animation = resolveMenuAnimation(context)
			return animation !== null && !isBakedAnimation(animation)
		},
		click(context?: unknown) {
			const animation = resolveMenuAnimation(context)
			if (!animation) return
			runSpringBake(animation)
		},
	})

	const sep = new MenuSeparator(`${PLUGIN_ID}_bake`)
	menu.structure.push(sep, bake)
	registeredAnimationMenuEntries.push(sep, bake)
}

function unregisterContextMenuActions(): void {
	const menu = (Group as { prototype?: { menu?: { structure?: unknown[] } } })?.prototype?.menu
	if (menu?.structure && Array.isArray(menu.structure)) {
		menu.structure = menu.structure.filter((entry) => !registeredMenuEntries.includes(entry))
	}
	const animMenu = (Animation as unknown as { prototype?: { menu?: { structure?: unknown[] } } })?.prototype?.menu
	if (animMenu?.structure && Array.isArray(animMenu.structure)) {
		animMenu.structure = animMenu.structure.filter((entry) => !registeredAnimationMenuEntries.includes(entry))
	}
	for (const entry of [...registeredMenuEntries, ...registeredAnimationMenuEntries]) {
		try {
			;(entry as { delete?: () => void })?.delete?.()
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] action.delete failed`, e)
		}
	}
	registeredMenuEntries = []
	registeredAnimationMenuEntries = []
}

// 別軸 B : Outliner 上で Group Property が 'enabled' の group を視覚的に区別する軽量マーカー。
// - <style> で `.outliner_object.spring-bone-marker` に淡い teal 色を付与
// - BB Outliner (= outliner.js:1187) は Vue で描画、 行要素 `li.outliner_node` の
//   id 属性に node の uuid が入る。 'enabled' な group の uuid 集合を作り、 uuid から
//   行要素を引いて内側の `.outliner_object` に class を付け外しする (= 表示名は読まない。
//   v-model バインドの input value 経由だと rename 途中の DOM 反映タイミングに依存するため)。
// - 副作用ゼロ (= class 追加のみ、 group 内部データは触らない)、 unload で完全クリーンアップ。
const OUTLINER_MARKER_CLASS = 'spring-bone-marker'
const OUTLINER_MARKER_STYLE_ID = 'spring-bone-outliner-marker-style'

function scanOutlinerMarkers(): void {
	// **Group Property が 'enabled' の group だけ**の uuid 集合を作る。 Project 未取得
	// (= 起動直後等) は空集合 = 全マーカー剥がしで安全側に倒す。
	// 判定基準は **Group Property の値のみ**で確定 : registry の加入条件 (= isSpringGroup /
	// isCapable、 'disabled' も保持する) とは別基準にし、 Spring 解除した bone に色が残って
	// 「解除できていない」 ように見えるのを避ける。
	// **選択中 animation の override は意図的に見ない** : animation を切り替えるたびに
	// outliner の色が変わると、 marker が示す rig の構造情報としての意味が失われるため
	// (= 確定仕様。 「override も反映すべき」 の方向へは変更しない)。
	const enabledUuids = new Set<string>()
	const groups = (Project as { groups?: unknown[] } | null)?.groups
	if (Array.isArray(groups)) {
		for (const g of groups) {
			if (getSpringBoneState(g) !== 'enabled') continue
			const uuid = (g as { uuid?: unknown }).uuid
			if (typeof uuid === 'string') enabledUuids.add(uuid)
		}
	}
	// li.outliner_node を走査し、 id (= uuid) が集合に含まれる行の内側 .outliner_object に
	// class を toggle。 集合に無い行 (= cube 等の非 group node、 'unset' の行、 解除済みの
	// 'disabled' の行) は剥がす側に回るため、 stale マーカーの掃除も同じ走査で済む。
	const nodes = document.querySelectorAll('li.outliner_node')
	for (let i = 0; i < nodes.length; i++) {
		const li = nodes[i] as HTMLElement
		const obj = li.querySelector(':scope > .outliner_object') as HTMLElement | null
		if (!obj) continue
		if (enabledUuids.has(li.id)) {
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
	// rAF の ID を保持する (= cleanup で cancel するため)。 boolean の coalesce flag だけだと
	// plugin unload 後にコールバックが走り、 剥がしたはずのマーカーを DOM に再付与し得る。
	// disposed guard は cancel 済みでも残りうるケース (= cancel 後の同一 frame 再予約等) の
	// 保険。
	let scanRafId: number | null = null
	let scanDisposed = false
	const scheduleScan = (): void => {
		if (scanRafId !== null) return
		scanRafId = requestAnimationFrame(() => {
			scanRafId = null
			if (scanDisposed) return
			try {
				scanOutlinerMarkers()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] scanOutlinerMarkers failed`, e)
			}
		})
	}
	const mo = new MutationObserver(scheduleScan)
	mo.observe(outlinerRoot, { childList: true, subtree: true })

	// BB event 経路 : 選択 / Property 変更 / undo redo の直後にも scan を走らせる
	// (= MutationObserver は DOM 構造変化しか拾えず、 値だけ変わる Property toggle は
	// DOM 変化を伴わない場合があるため二重化)。
	// `finished_edit` は BB core が Undo commit 完了直後に fire (= js/undo.js:95)、
	// 右クリ action の Property toggle や outliner 上の dblclick rename 確定経路
	// (= outliner_node.ts saveName) も他イベント待ちにならず即時ハイライト追従する (Opus WANT-1)。
	Blockbench.on('update_selection', scheduleScan)
	Blockbench.on('undo', scheduleScan)
	Blockbench.on('redo', scheduleScan)
	Blockbench.on('select_project', scheduleScan)
	Blockbench.on('finished_edit', scheduleScan)

	// 初回 scan (= plugin load 時に既存 spring group を pick up)
	scheduleScan()

	return (): void => {
		scanDisposed = true
		if (scanRafId !== null) {
			cancelAnimationFrame(scanRafId)
			scanRafId = null
		}
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
	// base = Group Property 由来の既定値 (= 入力側)。 registerGroup / rescanRegistry /
	// onSpringPropertyChange の 3 経路だけが書き、 effective には直接触れない。
	base: { drag: number; stiffness: number; gravity: number }
	// geometry = rig 幾何由来 (= 子 group の origin から算出)。 registerGroup /
	// rescanRegistry が書く。 restLength / restLocalDir は同じ算出元なので 1 箇所にまとめる。
	geometry: { restLength: number; restLocalDir: any }
	// config = effective (解決済み = 出力側)。 previewOps.resolveConfigs だけが書く。
	// springSim.step がそのまま読めるよう SpringConfig の形は維持する。
	config: SpringConfig
	// enabled = effective の有効判定 (= この entry に物理を掛けるか)。 これも
	// previewOps.resolveConfigs だけが書く。 **SpringConfig 型には入れない**
	// (= springSim が読む型を override 解決の概念で汚さないため)。
	enabled: boolean
	state: SpringState
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
// 変化時に invalidatePreviewSession() で次 tick の 0 replay をトリガする。 update_selection の
// クリック保持は「構造不変 = fingerprint 不変」 のため session に影響なし。
let lastGraphFingerprint = ''
// session 層 fingerprint (= computeSessionFingerprint) の保持。 fp 変化の検出専用の
// 独立変数で、 **invalidatePreviewSession() からは触らない** : 触ると 「tick で代入 →
// 直後に invalidate でリセット」 で毎 tick invalidate になる。 他経路からの invalidate は
// previewSessionStack === null を ensurePreviewSession が見て張り直すため整合する。
// installTickLoop の初期化と cleanup で '' に戻す。
let lastSessionFingerprint = ''
let inhibitTick = false   // applyPoseAt 由来の再描画で tick が再入するのを防ぐ
// export 中の抑制 state (= exportActive / rescan 予約) と遷移は exportGate.ts に集約する。
// rescanRegistry は function 宣言で hoist されるため、 ここで参照して問題ない。
const exportGate = createExportGate({ rescan: () => rescanRegistry() })
// project 切替 (= select_project / load_project) 受信から rAF コールバックでの rescan 完了
// までの間だけ立つ flag。 遅延中は旧 project の registry / session が生きたまま残るため、
// parse 完了後に同期的に走る Animation.select() → Animator.preview() が旧 entry を評価
// してしまう。 handler が同期的に立て + session 破棄し、 tick() が冒頭で見て止める
// (= registry.clear() でも止められるが、 rescan が結局作り直すため flag で止める方を採る)。
let projectSwitchPending = false
// onProjectSwitch が予約した rAF の ID。 cleanup (= plugin unload) で cancel するため保持
// する。 保持しないと unload 後にコールバックが走り、 cleanup 済みの registry の再充填や
// 旧 prefix 移行、 Project.saved = false まで起こり得る。
let projectRescanRafId: number | null = null
// installTickLoop の cleanup 済みかの guard。 cancel 漏れ / 再予約された rAF コールバックが
// cleanup 後に走っても何もしないようにする。
let tickLoopDisposed = false

function isSpringGroup(group: unknown): boolean {
	// registry 加入条件 = **capable (= 'enabled' | 'disabled')** 基準。 解除済み
	// ('disabled') の bone も registry に残す : 後続 commit の animation 単位 override で
	// 「この animation だけ有効化」 を可能にするため、 および topology (= parentUuid /
	// topoOrder / depth) を animation 非依存で安定させるため。
	// 実際に物理を掛けるかどうかは isSpringActive が担う。
	return isCapable(getSpringBoneState(group))
}

// 物理 sim (= step / apply) の対象判定。 解決済みの effective (= entry.enabled) を
// 読むだけにする : Group 既定値と animation 単位 override の合成は
// previewOps.resolveConfigs に閉じており (= effective の writer は 1 箇所)、
// ここで再解決すると判定元が 2 箇所に分裂する。
// **resolveConfigs 実行前に呼んではいけない** (= 前 session の解決結果 = stale)。
// resolveConfigs より前の判定が必要な経路 (= tick 冒頭の early-return) は
// hasActiveSpringEntry 側で context から再解決する。
function isSpringActive(entry: BoneEntry): boolean {
	return entry.enabled
}

// bake 由来の派生 animation の判定 (= isBakedAnimation / isBakedAnimationContext) は
// bakeTimeline.ts が持つ。 **物理の抑制判定を通す経路は 2 つあり、 どちらも
// isBakedAnimationContext を使うこと** :
//   - preview = tick 入口の hasActiveSpringEntry (= session ごと張らない)
//   - export / bake = previewOps.resolveConfigs (= 全 entry を disabled に解決する)
// resolveConfigs は preview / export 共用の effective writer なので、 そこに置けば
// AJ export も同じ判定を通る (= exporter だけ見落として datapack で Δ が二重に乗る事故を防ぐ)。

// active (= 実際に物理を掛ける) な entry が 1 つでもあるか。 tick() の
// early-return 判定用。 registry.size は capable (= 'enabled' + 'disabled') の件数なので、
// 全 entry が無効だと size > 0 のまま runtime が pose 全体を capture し、
// replay / advance のたびに Animator.stackAnimations を反復する無駄が出る。 毎 tick
// registry を全走査するが、 entry 数は高々数十なので許容コストと判断する。
// **context を引数で受けて override を再解決する** : この関数は tick() 冒頭で
// resolveConfigs より前に呼ばれるため、 entry.enabled (= 前 session の stale 値) を
// 読んではいけない (= animation 切替直後の初回 tick では旧 animation の解決結果が
// 残っている)。 生の Group 状態と context の override から resolveEnabled で判定する。
function hasActiveSpringEntry(context: PreviewAnimationContext): boolean {
	// bake 由来の派生 animation には物理を **二重に** 掛けない (= keyframe 側に既に
	// 焼き込まれている)。 判定は isBakedAnimationContext に集約し、 export 側
	// (= previewOps.resolveConfigs) も同じ関数を通す。 animation 未選択で複数 animation を
	// 再生している場合は stack 側にしか baked animation が現れないため、 context ごと渡す。
	if (isBakedAnimationContext(context)) return false
	const overrides = readOverrides(context.animation)
	for (const [uuid, entry] of registry) {
		if (resolveEnabled(getSpringBoneState(entry.group), overrides[uuid])) return true
	}
	return false
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
	// entry.base (= Group 既定値) に永遠に届かない (= 実機で観察された「値変更が preview に反映されない」
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
	// entry を先に組み立ててから Property 由来の物理パラ (= drag / stiffness / gravity) を
	// resolveConfig で base に適用する。 残りの restLength は子 group の origin から算出した
	// rig geometry 由来の値で、 resolveConfig の対象外 (= DEFAULT へ戻さない)。
	// registerGroup は idempotent スキップで state を保持するため、 このパスは新規 register 時のみ通る。
	const entry: BoneEntry = {
		group,
		base: {
			drag: DEFAULT_CONFIG.drag,
			stiffness: DEFAULT_CONFIG.stiffness,
			gravity: DEFAULT_CONFIG.gravity,
		},
		geometry: { restLength, restLocalDir },
		config: {
			drag: DEFAULT_CONFIG.drag,
			stiffness: DEFAULT_CONFIG.stiffness,
			gravity: DEFAULT_CONFIG.gravity,
			restLength,
		},
		// effective の初期値。 registerGroup 時点では animation 単位 override を引けない
		// (= context 不在) ため Group 状態からの仮値で、 直後の replay 経路
		// (= beginAnimation → resolveConfigs) で必ず解決済み値に上書きされる。
		enabled: getSpringBoneState(group) === 'enabled',
		state: createState(),
		parentUuid: getSpringParentUuid(group),
		depth: 0, // rebuildTopoOrder で再計算される
	}
	// base を Group Property 由来の値で確定させる。 effective (= config) はここでは触らず、
	// entry 生成時の初期値 (= DEFAULT_CONFIG + 算出済み restLength) のままにする :
	// 「effective の writer は previewOps.resolveConfigs の 1 箇所だけ」 という契約を
	// 守るため。 初期値のままで安全な理由 : config を読むのは物理 step
	// (= stepAndApplyOrdered) と resetAllToRest だけで、 どちらも
	// SpringRuntime.beginAnimation → resolveConfigs (= springRuntime.ts:135-145) の後に
	// 走る replay 経路の中にあるため、 resolveConfigs 未実行の config を読む経路が無い。
	Object.assign(entry.base, resolveConfig(entry, null))
	registry.set(group.uuid, entry)
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
// 昇順に整列した「uuid:state:parentUuid:restLength:restLocalDir:drag,stiffness,gravity」 の連結。
// 数値は **丸めずに** JSON.stringify でそのまま文字列化する (= animOverrides.ts の
// overridesFingerprint と同じ表現)。 toFixed 等で丸めると丸め幅未満の変更で fingerprint が
// 変わらず session が invalidate されない : rescanRegistry は effective (= entry.config) を
// 直接更新しないため、 以前は rescan の直接更新で救われていた微小変更が、 別の event が
// 来るまで stale のまま残ってしまう。 fingerprint 文字列は長くなるが比較にしか使わないため
// 問題ない。 restLocalDir も含めることで「同長で方向だけ変わった origin 編集」
// でも invalidate する。 drag / stiffness / gravity を含めることで、 Property 値変更が
// 「topology 変化と同じ扱い」 で next tick に 0 replay をトリガする (= 値変更が scrub
// を待たずに即 preview に反映される、 element_panel input の onChange と両輪で動作)。
// state (= enabled / disabled) も含める : registry 加入条件が capable 化して以降、
// spring 化 / 解除の toggle では entry の増減が起きないため、 state 自体を fingerprint に
// 入れないと「step / apply 対象集合の変化」を検知できず replay が起きない。
function computeGraphFingerprint(): string {
	const uuids = Array.from(registry.keys()).sort()
	return uuids
		.map((u) => {
			const e = registry.get(u)!
			// 入力側 (= base + geometry) から読む。 effective (= config) 読みだと
			// rescan の fingerprint 計算と resolveConfigs の effective 書き込みが
			// 互いを打ち消し合い、 毎 tick の無駄な invalidate か stale 固着のどちらかを招く。
			const d = e.geometry.restLocalDir
			const b = e.base
			return `${u}:${getSpringBoneState(e.group)}:${e.parentUuid ?? '-'}:${JSON.stringify(e.geometry.restLength)}:${JSON.stringify(d.x)},${JSON.stringify(d.y)},${JSON.stringify(d.z)}:${JSON.stringify(b.drag)},${JSON.stringify(b.stiffness)},${JSON.stringify(b.gravity)}`
		})
		.join('|')
}

// session 層の fingerprint (= animation 単位 override / animation 切替の変化検知用)。
// fingerprint は二層構造 :
// - registry 層 = computeGraphFingerprint (= topology / Group Property)。 rescanRegistry
//   が更新して lastGraphFingerprint に保持する
// - session 層 = この関数 (= registry 層 + animation uuid + override map)。 tick が毎回
//   計算して lastSessionFingerprint と比較する
// registry 層を二層に分ける理由 : override 編集は registry (= topology / base) を変えない
// ため registry 層では検知できない一方、 session 層は毎 tick 走るため registry 層の
// 再計算 (= 全 entry の走査と文字列化) を毎 tick やりたくない。 lastGraphFingerprint を
// そのまま畳み込むことで、 registry 層の変化 (= rescan で更新済み) も session 層の
// 差分として自然に検知される。 override の fingerprint 対象は registry に存在する bone
// の uuid のみ (= 関係ない bone の override 変更では replay しない)。
// **rest window も混ぜる** : fade の終点は animation の長さと loop 設定から決まるため、
// これらを入れないと「length / loop mode / loop_delay / fade 長を変えたのに preview の
// 減衰カーブが古いまま」 になる (= animation uuid も override map も変わらないので
// 他の 3 要素では検知できない)。 fingerprint 側は導出値ではなく raw を並べる
// (= restWindowFingerprint、 導出の bug で invalidate 判定まで壊さないため)。
function computeSessionFingerprint(context: PreviewAnimationContext): string {
	const map = readOverrides(context.animation)
	const animUuid = (context.animation as { uuid?: unknown } | null)?.uuid ?? '-'
	const restWindow = context.restWindow
	const restFp = restWindow
		? restWindowFingerprint(restWindow.timing, restWindow.requestedFadeFrames)
		: '-'
	return `${lastGraphFingerprint}|@${animUuid}|${overridesFingerprint(map, Array.from(registry.keys()))}|${restFp}`
}

// idempotent rescan : 既存 entry の state は保持、 不在 group のみ削除、 新規 group のみ追加。
// 旧版は registry.clear() で全滅 → 再 register で state がリセットされていた
// (= update_selection event 経由のボーンクリックで物理状態が初期化される問題の真因)。
// rescan の末尾で parentUuid を最新の group.parent から refresh し、 topoOrder を再構築する。
function rescanRegistry(): void {
	// **export 中は registry を作り直さない** (= 全経路の入口で 1 箇所止め)。 registry /
	// topoOrder / entry.base をその場で差し替えると、 進行中の export が参照している entry
	// 集合が frame の途中で入れ替わる。 listener 側で経路を列挙する形は漏れる (= project 切替の
	// rAF / undo / redo / context menu action / Property 変更 すべてがここへ来る)。
	// skip した分は export 終了時に取り戻す (= exportGate の rescan 予約)。
	if (exportGate.deferRescanIfActive()) return
	const groups = (Project as { groups?: unknown[] } | null)?.groups
	if (!Array.isArray(groups)) {
		registry.clear()
		topoOrder = []
		lastGraphFingerprint = ''
		return
	}

	// 旧方式 (= name prefix) から Property への移行。 'unset' かつ prefix 付きの group だけを
	// 'enabled' にする (= shouldMigrate は冪等、 一度 'enabled' / 'disabled' になった group は
	// 名前と無関係になる)。 副作用として「editor 内で `spring_` 名を新しく付けた unset の
	// group も次の rescan で自動有効化される」 が、 これは旧 gesture の graceful
	// degradation として仕様に含める。
	// Undo entry は積まない : 本関数は event listener 内から走り、 undo で戻されても次の
	// rescan で再適用されるため状態は一貫する。
	// **書き込みが 1 件でも発生した時だけ** Project.saved = false で dirty 化する
	// (= undo.js:93 の BB core 慣習に合わせる。 毎 rescan で dirty にすると選択操作の
	// たびに「未保存」 表示が出るため、 変化時のみに限定)。
	let migrated = false
	for (const g of groups) {
		if (!(g instanceof Group)) continue
		if (shouldMigrate(getSpringBoneState(g), (g as { name?: unknown }).name)) {
			;(g as { spring_bone_enabled?: unknown }).spring_bone_enabled = 'enabled'
			migrated = true
		}
	}
	if (migrated && Project) {
		Project.saved = false
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
	// 構造情報 (= parentUuid / geometry) は「rig 編集の瞬間」 の
	// 最新値を反映する。 rest 系の反映は length constraint が新値に合わせて hard snap
	// するため若干のジャンプが出るが、 構造整合を優先する。
	// Property 値 (= drag / stiffness / gravity) も同時に読み直す。 これで
	// blueprint reload / Undo / 別チャネル (= 例 : 将来の専用 Panel) からの変更が
	// tick 経路で自然に取り込まれる。
	// 書き込み先は base / geometry のみ。 effective (= entry.config) はここでは触らず、
	// 次 tick の beginAnimation → resolveConfigs に委ねる (= effective の writer を
	// 1 箇所に固定し、 rescan が解決済み値を Group 既定値で上書きする経路を構造的に塞ぐ)。
	for (const entry of registry.values()) {
		entry.parentUuid = getSpringParentUuid(entry.group)
		Object.assign(entry.base, resolveConfig(entry, null))
		const child = findChildGroup(entry.group)
		if (child) {
			const d = originDelta(entry.group, child)
			if (d.dir && d.length > 0) {
				entry.geometry.restLocalDir = d.dir
				entry.geometry.restLength = d.length
			}
		}
	}
	rebuildTopoOrder(groups)

	// topology (= chain 構造 / restLength) が変わったら sim state を invalidate。
	// 次 tick は runtime の replay 経路が起動し、 新構造に合わせて 0 から replay する。
	// クリック保持 (= update_selection) は fingerprint 不変 → session に影響なし。
	const fp = computeGraphFingerprint()
	if (fp !== lastGraphFingerprint) {
		lastGraphFingerprint = fp
		invalidatePreviewSession()
	}
}

// 任意の animation 時刻に rig を当てる (= anim_ux Onion Skin / AJ updatePreview と同パターン)。
// `inhibitTick` で applyPoseAt 起因の display_animation_frame 再発火を弾く。
// tick 中は Timeline.time を snap 時刻に一時的に書き換えるため、 退避 → 復元で playhead
// UI との乖離累積を防ぐ (= 潜在バグ Fable #4)。 tick は毎 frame 呼ばれる + snap 時刻は最大
// 半 step 分ズレるため、 復元しないと ms 単位のズレが累積して UI が微振動する余地がある。
// animation stack は呼び出し側 (= makePreviewAnimationContext) が確定させたものを context 経由で
// 受け取る。 関数内部で Animation.selected を再参照しない (= 選択中 animation への暗黙依存の排除)。
function applyPoseAt(time: number, context: PreviewAnimationContext): void {
	if (typeof Animator?.showDefaultPose !== 'function') return
	if (typeof Animator?.stackAnimations !== 'function') return
	inhibitTick = true
	const tl: any = Timeline
	const savedTime = tl?.time
	try {
		if (tl) tl.time = time
		Animator.showDefaultPose(true)
		Animator.stackAnimations(context.animationStack as any[], false)
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
//   r          = entry.geometry.restLocalDir (parent-local frame の rest bone 軸単位ベクトル)
//   q_base     = 現時点の mesh.quaternion (= keyframe pose、 sub-step では applyPoseAt が当てた
//                「時刻 t の keyframe pose」、 同時刻パスでは BB core が当てた「現時刻 pose」)
//   q_parentW  = mesh.parent の world quaternion
//   d_simW     = normalize(state.pos - anchorWorld) (物理 tip 方向、 world 座標)
//   d_animP    = normalize(r) (rest bone 軸、 parent-local、 own-rotation 独立化で qBase 除外)
//   d_simP     = normalize(inverse(q_parentW) × d_simW) (物理シム目標、 parent-local)
//   ΔP        = setFromUnitVectors(d_animP, d_simP) (rest → 物理 の parent-local swing)
//   q_final   = ΔP × q_base (前乗算)
// 静的 rest からの delta をそのまま代入していた旧経路は、 現行 keyframe rotation の上に
// 「rest→物理」 を二重適用する形になり keyframe pose が消えていた (= 既存アニメパラ無視症状)。
// 4 step 化で keyframe rotation を保存しつつ物理揺れ delta を parent-local で prepend する。
// own-rotation 独立化 (2026-07-10) 以降、 solver 目標 boneAxisWorld と d_animP は q_parentW × r 基準に
// 統一 (= 自身の q_base を solver 目標 + Δ 合成基準から排除、 親 rotation は q_parentW 経由で反映)。
// weight = 終端 rest 整合の窓 (= restWindow.ts が算出、 必ず [0, 1])。 Δ の回転量だけを
// weight 倍する (= 物理 state は呼び出し側で通常どおり進めた上で、 出力に載る量を絞る)。
// 分岐の判断は classifyRestWindowWeight に寄せてあり、 ここは THREE を触る数行だけを持つ。
function composeSpringPose(
	entry: BoneEntry,
	dt: number,
	stepSim: boolean,
	weight: number,
	scratch: {
		anchorWorld: any
		boneAxisWorld: any
		forward: any
		parentQuat: any
		parentInv: any
		qBase: any
		deltaP: any
		identityQ: any
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
		scratch.boneAxisWorld.copy(entry.geometry.restLocalDir).applyQuaternion(scratch.parentQuat)
		step(entry.state, scratch.anchorWorld, scratch.boneAxisWorld, entry.config, dt)
	}

	if (!entry.state.initialized) return

	// weight 0 (= 減衰しきった終端) は **premultiply 自体を通さない** : slerp で identity へ
	// 寄せた Δ は浮動小数では厳密な identity にならず、 前乗算すると純 keyframe pose との差が
	// 残る。 終端で基底ポーズと厳密一致させるのが本機能の目的なので、 qBase をそのまま残す。
	// 物理 state は上の step で通常どおり進めてあるため、 逆行 scrub で weight が戻る経路でも
	// state は連続する。 matrixWorld は **更新する** : 親の Δ が消えた pose を子の
	// anchor / q_parentW へ伝播させるのは仕様どおりの挙動。
	const deltaMode = classifyRestWindowWeight(weight)
	if (deltaMode === 'identity') {
		mesh.updateMatrixWorld(true)
		return
	}

	// d_simW = state.pos - anchorWorld (world 方向)、 lengthSq guard で 0 除算防止
	scratch.forward.subVectors(entry.state.pos, scratch.anchorWorld)
	if (scratch.forward.lengthSq() < 1e-8) return
	scratch.forward.normalize()

	// d_animP = restLocalDir (parent-local frame の rest bone 軸、 own-rotation 独立化で qBase 削除)
	scratch.dAnimP.copy(entry.geometry.restLocalDir).normalize()

	// d_simP = inv(q_parentW) × d_simW (world → parent-local)
	scratch.parentInv.copy(scratch.parentQuat).invert()
	scratch.dSimP.copy(scratch.forward).applyQuaternion(scratch.parentInv).normalize()

	// ΔP = setFromUnitVectors(d_animP, d_simP) : rest → 物理 の parent-local swing (own-rotation 独立化後)。
	// setFromUnitVectors は twist を生成しない = twist を保存 (Sol 見落としバグ 9、
	// 180 度反転付近では回転軸が不連続になり得るが hemisphere 選択は今回未対応 = 次段課題)。
	scratch.deltaP.setFromUnitVectors(scratch.dAnimP, scratch.dSimP)

	// 0 < weight < 1 : ΔP を identity へ向けて slerp する (= 回転量だけを weight 倍する)。
	// slerp は最短弧を取るため、 setFromUnitVectors が返す swing の向きに依らず
	// 「Δ を薄める」 方向に効く。
	if (deltaMode === 'blend') {
		scratch.identityQ.identity()
		scratch.deltaP.slerp(scratch.identityQ, 1 - weight)
	}

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
	identityQ: any
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
		// 減衰中 (= 0 < weight < 1) の slerp 目標。 module scope の定数にはしない
		// (= THREE が未定義の時点で評価されるのを避ける)。
		identityQ: new THREE.Quaternion(),
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
// weight は runtime が算出して渡す (= sub-step ごとに「これから進む step」 基準)。
// **物理 step は weight に関わらず必ず回す** : 減衰は出力段だけの操作で、 state を止めると
// 減衰の途中で速度が消えてしまう。
function stepAndApplyOrdered(dt: number, weight: number): void {
	if (registry.size === 0) return
	const scratch = makeComposeScratch()
	for (const uuid of topoOrder) {
		const entry = registry.get(uuid)
		// 物理を掛けない entry (= Group 状態と animation override の解決で disabled) は
		// topology には残るが step / apply の両方を skip する (= isSpringActive =
		// 解決済み entry.enabled 参照)。 apply だけ止めて step を回し続けると、
		// 再有効化した瞬間に「見えなかった期間の慣性」 が噴き出すため両方止める。
		if (!entry || !isSpringActive(entry)) continue
		composeSpringPose(entry, dt, true, weight, scratch)
	}
}

// 同時刻パス (= tick で sim 進めない、 state 不変で描画のみ更新する経路)。
// pose transaction 化以後は毎 tick 末尾で restore 直後に呼ばれる = mesh.quaternion に
// BB core の「現時刻 keyframe pose」 が乗った状態から Δ を prepend し直す。
// これで restore で消えた spring 揺れが再描画される + keyframe rotation は保存される。
function applyOnlyOrdered(weight: number): void {
	if (registry.size === 0) return
	const scratch = makeComposeScratch()
	for (const uuid of topoOrder) {
		const entry = registry.get(uuid)
		if (!entry || !entry.state.initialized || !isSpringActive(entry)) continue
		composeSpringPose(entry, 0, false, weight, scratch)
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
		// registry 全件 (= capable) を reset する。 Group 状態や animation override で
		// 現時点 disabled の entry も対象にする : disabled 期間中の慣性 (= state.pos) が
		// 残ると、 再有効化した瞬間に「見えなかった期間の慣性」 が噴き出すため。
		if (!entry) continue
		const mesh = entry.group?.mesh
		const meshParent = mesh?.parent
		if (!mesh || !meshParent) continue
		if (!getAnchorWorld(entry, anchorWorld)) continue
		meshParent.getWorldQuaternion(parentQuat)
		boneAxisWorld.copy(entry.geometry.restLocalDir).applyQuaternion(parentQuat)
		// restLength は effective (= config) から読む。 beginAnimation で resolveConfigs が
		// 先に走るためここに来る時点では必ず最新の解決済み値 (= 後続の animation 単位
		// override とも step が読む値と一致する)。
		restTip.copy(anchorWorld).addScaledVector(boneAxisWorld, entry.config.restLength)
		resetState(entry.state, restTip)
	}
}

// --- SpringRuntime 接続 (= preview 用の薄い BB adapter) ---
// 時刻管理と replay / advance / same-step の判断は SpringRuntime (= springRuntime.ts) が持つ。
// ここには「BB 由来の値を context に詰める」 「ops を BB API へ繋ぐ」 「session の張り直し
// 判断」 だけを置く。 capturePose / restorePose / updateMatrixWorld / applyOnlyOrdered は
// runtime.evaluateSample 内で順序保証されているため、 tick から直接呼ばない。

// BB が今このフレームで再生する animation の集合。 Animator.preview の分岐をそのまま写す
// (= animation_mode.js:352-397)。
// - controller 再生中 : selected_state と last_state が参照する animation (= blend 中は両方)
// - それ以外 : playing が truthy な animation 全部 (= `true` と `'locked'` の両方が該当)
// **blend_value は再現しない** : applyPoseAt は stackAnimations を multiplier 無しで呼ぶため、
// controller の blend 比率は反映されない (= 従来からの制約。 ここで直すのは「どれを積むか」 だけ)。
function collectPlayingAnimations(all: any[]): any[] {
	const state = (AnimationController as any)?.selected?.selected_state
	if (!state) return all.filter((a: any) => a?.playing)
	const controller = (AnimationController as any).selected
	// **last_state は blend 中だけ積む** : BB も `blend_value < 1` の間しか last_state を
	// stack しない (= animation_mode.js:362-363 / 380)。 無条件に含めると遷移完了後も
	// 既に再生されていない animation が base pose に乗り、 その state が bake 由来だと
	// isBakedAnimationContext が誤って物理を全停止する。 判定式は BB をそのまま写す。
	const lastState = controller?.last_state
	let blendingFromLastState = false
	if (lastState) {
		const stateTime = typeof state.getStateTime === 'function' ? state.getStateTime() : 0
		const progress = lastState.blend_transition
			? Math.min(1, Math.max(0, stateTime / lastState.blend_transition))
			: 1
		const blendValue = typeof lastState.calculateBlendValue === 'function'
			? lastState.calculateBlendValue(progress)
			: progress
		blendingFromLastState = typeof blendValue === 'number' ? blendValue < 1 : progress < 1
	}
	const out: any[] = []
	for (const source of [state, blendingFromLastState ? lastState : null]) {
		const entries = source?.animations
		if (!Array.isArray(entries)) continue
		for (const entry of entries) {
			const animation = all.find((a: any) => a?.uuid === entry?.animation)
			if (animation && !out.includes(animation)) out.push(animation)
		}
	}
	return out
}

// 選択中 animation (= 物理パラの解決対象) と、 BB が再生している animation 集合
// (= animationStack) を確定させる。 stack の解決はこの関数 1 箇所だけ。
function makePreviewAnimationContext(): PreviewAnimationContext {
	// **削除済み animation は未選択として扱う** : Animation.remove() は
	// Animator.animations.remove() → remove_animation dispatch → selected = null の順で
	// 進む (= animation.js:406-428) ため、 listener が同期的に preview を呼ぶと
	// Animation.selected は削除済み instance を指したままになる。 生存確認なしだと
	// 削除済み animation を stack に積んでその override まで解決してしまい、 UI 側
	// (= isAnimationAlive で未選択扱い) と BB 標準 preview の挙動から乖離する。
	const all: any[] = Array.isArray((Animation as any)?.all) ? (Animation as any).all : []
	const rawSelected = (Animation as any)?.selected
	const animSelected = rawSelected && all.includes(rawSelected) ? rawSelected : null
	// **stack は BB が実際に再生する集合と一致させる** (= Animator.preview の分岐と同じ条件、
	// animation_mode.js:352-397)。 選択中 animation だけに絞ると、 BB が同時に再生している
	// 他の animation が base pose から抜け落ちる :
	//   - `playing === 'locked'` の animation は選択切替でも再生され続ける
	//     (= Animation.select は `playing == true` のものしか false に落とさない、 animation.js:215)
	//   - Animation Controller 再生中は controller の state が再生対象を決める (= playing flag は立たない)
	// stack がズレると base pose がズレ、 preview の物理も bake の収集値もズレる。 さらに
	// bake 由来 animation の検出 (= isBakedAnimationContext) もこの stack を見るため、
	// 抜けがあると物理が二重に載る経路が残る。
	const animationStack: any[] = collectPlayingAnimations(all)
	// rest window は「選択中 animation が 1 つに定まる」 経路でのみ載せる
	// (= makePreviewRestWindow が null 選択で undefined を返す)。
	return { animation: animSelected, animationStack, restWindow: makePreviewRestWindow(animSelected) }
}

// timeToStepIndex は非 finite で RangeError を throw するため、 preview 側で 0 へ正規化する
// (= Timeline 未初期化や NaN の frame で tick 全体が死なないようにする)。
function normalizeTimelineTime(t: unknown): number {
	return typeof t === 'number' && Number.isFinite(t) ? t : 0
}

const previewOps: SpringRuntimeOps<PreviewAnimationContext, AnimatorPoseSnapshot> = {
	resolveConfigs: (context) => {
		// animation 単位の override を引き当てる。 key = bone (Group) の uuid。
		const overrides = readOverrides(context.animation)
		// bake 由来の派生 animation は物理を全面停止する (= 二重適用の防止)。 preview は
		// tick 入口の hasActiveSpringEntry で既に止まるが、 **export 経路はここだけが
		// 通り道** なので、 同じ判定関数をこの effective writer にも通す
		// (= stack 側だけに baked animation がある複数再生も同じ 1 関数で拾う)。
		const suppressed = isBakedAnimationContext(context)
		for (const [uuid, entry] of registry) {
			// effective (= entry.enabled / entry.config) の唯一の writer。
			// 合成は resolveEffective に委譲 (= override → base (= Group 既定値) →
			// DEFAULT_CONFIG の項目単位 sparse)。 restLength は rig 幾何由来で
			// override 対象外のため、 現行どおり geometry から入れる。
			// Object.assign(entry.config, eff) は使わない : eff.enabled が config に
			// 混入して SpringConfig の形を壊すため、 enabled と数値項目は分けて書く。
			const eff = resolveEffective(entry.base, getSpringBoneState(entry.group), overrides[uuid], DEFAULT_CONFIG)
			// AJ export で除外された node は物理も止める (= 出力に載らない bone を計算しても
			// 無駄で、 除外前提の pose と食い違う)。 判定を resolveConfigs の中に置くのは
			// **effective の writer を 1 箇所に保つため** (= isSpringActive 側で再解決すると
			// 判定元が分裂する)。 preview 経路は excludedNodeUuids が undefined なので不変。
			entry.enabled = eff.enabled && !suppressed && !(context.excludedNodeUuids?.has(uuid) ?? false)
			entry.config.drag = eff.drag
			entry.config.stiffness = eff.stiffness
			entry.config.gravity = eff.gravity
			entry.config.restLength = entry.geometry.restLength
		}
	},
	capturePose: () => captureAnimatorPose(),
	restorePose: (snapshot) => restoreAnimatorPose(snapshot),
	updateMatrixWorld: () => { Canvas?.scene?.updateMatrixWorld?.(true) },
	resetAllToRest: () => resetAllToRest(),
	stepAndApplyOrdered: (dt, weight) => stepAndApplyOrdered(dt, weight),
	applyOnlyOrdered: (weight) => applyOnlyOrdered(weight),
}
const runtime = new SpringRuntime<PreviewAnimationContext, AnimatorPoseSnapshot>(previewOps)

// session の張り直し判定と invalidate は previewSession.ts に集約する。 ここには
// 「BB / runtime 側の値を ops へ繋ぐ」 だけを置く。
const previewSession = createPreviewSession<PreviewAnimationContext>({
	// **getter で委譲する** : 値をコピーすると gate の状態変化が反映されない。
	get isExportActive(): boolean { return exportGate.isExportActive },
	getAnimation: (context) => context.animation,
	getStack: (context) => context.animationStack,
	endAnimation: () => { runtime.endAnimation() },
	beginAnimation: (context) => { runtime.beginAnimation(context, applyPoseAt) },
})

// 呼び出し側から見た口は従来どおりこの 2 関数 (= invalidate は 14 箇所から呼ばれる)。
// **判定を足さないこと** : 判定は previewSession.ts 側に置く。
function ensurePreviewSession(context: PreviewAnimationContext): void { previewSession.ensure(context) }
function invalidatePreviewSession(): void { previewSession.invalidate() }

function tick(): void {
	// A failed inspection restore leaves the current scene generation unsafe. Keep the
	// ordinary preview path stopped until a new load or plugin reload clears the latch.
	if (isInspectionFaulted()) return
	// exportActive 中は preview session を張らない : 張ると runtime.evaluateSample が走り、
	// AJ が確定させた scene pose を preview 側の評価結果で上書きしてしまう
	// (= runtime は preview / export で共用する module singleton)。
	if (exportGate.isExportActive || inhibitTick || projectSwitchPending || runtime.isEvaluating) return
	// context 生成は Animation.selected 参照 + playing filter だけで軽いため先に作る。
	// hasActiveSpringEntry が override 解決の入力として必要とするため順序は固定。
	const context = makePreviewAnimationContext()
	// active な entry が 1 つも無い (= registry 空 or 全 entry が Group 状態と
	// animation override の両方で無効) 場合は session を畳んで終わる
	// (= hasActiveSpringEntry 参照)。
	if (!hasActiveSpringEntry(context) || !Modes?.animate) {
		invalidatePreviewSession()
		return
	}
	// session 層 fingerprint (= registry 層 + animation + override) の変化で session を
	// 張り直す (= override 編集が次 tick で 0 replay を起動し、 preview に即反映される)。
	// lastSessionFingerprint は変化検出専用で、 invalidatePreviewSession() からは触らない
	// (= 代入 → リセットの循環で毎 tick invalidate 化するのを防ぐ)。
	const sfp = computeSessionFingerprint(context)
	if (sfp !== lastSessionFingerprint) {
		lastSessionFingerprint = sfp
		invalidatePreviewSession()
	}
	ensurePreviewSession(context)
	runtime.evaluateSample(normalizeTimelineTime(Timeline?.time))
}

let cleanups: Array<() => void> = []

function installTickLoop(): () => void {
	// **rescanRegistry / invalidatePreviewSession より前に倒す** : どちらも exportActive 中は
	// no-op になるため、 後に倒すと install 時の rescan / session 破棄が空振りする
	// (= export 中に plugin reload が挟まった場合に「止まったまま」 で復帰しない)。
	// 直後の rescanRegistry が最新状態を作るので、 持ち越しの予約は捨てる (= reset は
	// 予約された rescan を実行せずに落とす)。
	exportGate.reset()
	rescanRegistry()
	invalidatePreviewSession()
	inhibitTick = false
	projectSwitchPending = false
	tickLoopDisposed = false
	// session 層 fingerprint と override memo を初期化 (= 前回 install 時の値が残っていると
	// 初回 tick の変化検知をすり抜ける / 旧 project の instance 参照を握り続ける)。
	lastSessionFingerprint = ''
	overridesMemo = null
	warnedNewerSchemaUuids.clear()
	renderSampleCountCache.clear()
	warnedRestWindowUuids.clear()

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
		invalidatePreviewSession()
		requestAnimatorPreview('animation cache refresh')
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
		// **export 中は listener 本体ごと止める** (= tick() 冒頭の guard だけでは足りない)。
		// export 中にこの event が飛ぶ主経路は AJ の frame ループではなく `Animation.select()`
		// (= animation ごとに 1 回、 Modes.animate なら内部で Animator.preview() を呼び、 それが
		// display_animation_frame を **同期発火** する = animation.js:246 / animation_mode.js:454)。
		// AJ の frame ループ自体は updatePreviewBase() で animator を直接評価するため、 この
		// event を発火しない。 session 破棄は invalidatePreviewSession 側の guard で止まるが、
		// それだけだと invalidateAnimationCache() が Animator.preview() を呼び返し、 AJ の
		// frame ループへ再入する経路が残る。
		if (exportGate.isExportActive) return
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
			if (active) invalidatePreviewSession()
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
		// AJ は animation ごとに Animation.select() を呼び、 その末尾で select_animation を
		// dispatch する (= animation.js:256)。 guard しないと invalidateAnimationCache() が
		// Animator.preview() を呼び、 export の最中に BB 側の preview が割り込む。
		// なお onAnimFrame 側の guard も別途必要 : Animator.preview() は select_animation の
		// dispatch **より前** に Animation.select() 内から呼ばれる (= animation.js:246)。
		if (exportGate.isExportActive) return
		invalidateAnimationCache()
	}
	// **rAF 遅延が必要な理由** : `select_project` は ModelProject.select() 内で発火し
	// (= js/io/project.ts:399)、 .bbmodel の parse 完了 (= js/formats/bbmodel.js:581 の
	// `parsed` event、 Group 構築を含む) より **前** である。 `load_project` も同様に
	// parse 前 (= js/formats/bbmodel.js:430、 parse dispatch は 431)。 同期で rescan すると
	// Group がまだ存在せず空の registry を作るだけになり、 初回ロードした旧 blueprint の
	// 移行と物理適用が update_selection 等の後続 event まで遅れる (= その間の保存で数値
	// Property が capable condition により脱落し得る)。 parse は同期処理なので rAF
	// コールバックは parse 完了後に走る。 切替 (= select_project) とロード (= load_project)
	// の両 event に同じ handler を登録して二重化する。 rescan は idempotent で重複しても
	// 無害だが、 同一 frame での多重実行は無駄なので outliner marker 側の scheduleScan と
	// 同じ「rAF 1 回にまとめる」 パターンで coalesce する。
	// **pending flag は event 受信のその場で同期的に立てる** : rAF までの間は旧 project の
	// registry / session が有効なまま残り、 parse 完了後・コールバック実行前に同期的に走る
	// Animation.select() → Animator.preview() が旧 entry を評価してしまう。 tick() が冒頭で
	// flag を見て即 return するため、 遅延中の評価は遮断される (= module スコープ側の
	// projectSwitchPending コメント参照)。
	const onProjectSwitch = (loadObserved = false): void => {
		markInspectionProjectGeneration(loadObserved)
		projectSwitchPending = true
		invalidatePreviewSession()
		// override memo をクリア (= 旧 project の animation instance 参照を握り続けない。
		// identity 比較なので残っていても誤ヒットはしないが、 参照保持を避ける)。
		overridesMemo = null
		// 上位 schema 警告の抑止も project 単位に戻す (= 同一 blueprint を別 project で
		// 開いたときに警告が黙るのを防ぐ)。 rest window 側の警告抑止と sample 数 memo も同じ。
		warnedNewerSchemaUuids.clear()
		renderSampleCountCache.clear()
		warnedRestWindowUuids.clear()
		if (projectRescanRafId !== null) return
		projectRescanRafId = requestAnimationFrame(() => {
			projectRescanRafId = null
			if (tickLoopDisposed) return
			try {
				rescanRegistry()
				invalidatePreviewSession()
			} catch (e) {
				console.warn(`[${PLUGIN_ID}] project rescan failed`, e)
			}
			projectSwitchPending = false
			// rescan 完了をその場で preview に反映する。 paused 中は display_animation_frame が
			// 自然発火しないため、 明示 preview 無しだと parse 中に先行した preview (= 空 or 旧
			// registry で評価済み) のまま、 次のユーザー操作まで新 project の spring physics が
			// 表示されない。 **export 中は rescan ごと skip される** (= rescanRegistry の guard)
			// ため、 preview も requestAnimatorPreview 側の guard で自動的に見送られる。
			requestAnimatorPreview('project switch')
		})
	}
	const onProjectLoad = (): void => { onProjectSwitch(true) }
	const onProjectSelect = (): void => { onProjectSwitch(false) }
	const onUpdateSelection = (): void => {
		// export 中の扱いは rescanRegistry() 側の guard に委ねる (= ここで早期 return しない)。
		// この event は AJ の export 中にも飛ぶ : Animation.select() → unselectAllElements() が
		// TickUpdates.selection を立て (= misc.js:256)、 AJ の render loop が
		// await sleepForAnimationFrame() で main loop に制御を返した時点で updateSelection()
		// が update_selection を dispatch する (= misc.js:235)。 rescan は registry / topoOrder /
		// entry.base を **その場で差し替える** ため進行中の export に触らせてはいけないが、
		// **ここで return すると pendingRescanAfterExport が立たず**、 この event でしか
		// 通知されない構造変更が export 後も反映されないまま残る。 guard 済みの
		// rescanRegistry() を通せば skip と予約が同時に成立する。
		// idempotent rescan で既存 entry の state は保持、 session もそのまま (= 物理継続)。
		rescanRegistry()
	}
	const onModeChange = (): void => {
		// mode 切替で sim 状態を捨てる (= 次 animate モード復帰時に頭から replay)
		invalidatePreviewSession()
	}
	// 症状 1 (Undo できない) の primary fix : undo / redo で group.spring_* 値は元に戻るが、
	// plugin 側の entry.base (= Group 既定値) は BB event 経由でしか同期されない。 この listener が無いと
	// 「値は復元されたのに entry.base は旧値のまま」 で「Ctrl+Z が効いていないように見える」
	// 症状となる。 rescanRegistry で base 再読込 + invalidatePreviewSession() で fingerprint 変化経由の
	// 次 tick 0 replay を起動する (= effective への反映は replay 冒頭の resolveConfigs が行う)。 keyframe undo は fingerprint を触らないので invalidate は
	// unconditional 必要 (= Fable IMO-1、 undo-path の厳格さ)。
	//
	// updateSelection() は敢えて呼ばない : BB core の loadUndoSave が 'undo'/'redo' event
	// dispatch 直前 (= undo.js:823) に既発火、 我々の onUpdateSelection listener 経路で rescan
	// も走るため冗長 (= Round 2 review WANT-1、 undo 1 回で 2 rescan の性能ロス回避)。
	//
	// 一方 Animator.preview() は残す : keyframe undo (= fingerprint 変化なし) の場合、 core の
	// preview (= undo.js:830-832) は旧 step のまま走り「復元済み keyframe に古い物理姿勢を
	// 適用」 する。 我々の invalidatePreviewSession() は次 display_animation_frame event を待つが、 paused
	// 中は自然発火しないため paused 中の keyframe undo で spring bones が視覚 stale のまま残る
	// (= Codex Round 2 MUST-1 / Fable Round 2 WANT-1)。 unconditional preview 呼びで最新
	// state を強制反映、 config undo 時の 2 replay 代償は個人スコープで許容 (dirty-flag による
	// conditional skip は overkill 判定)。
	// export 中は rescanRegistry / invalidatePreviewSession / requestAnimatorPreview の
	// いずれも自前の guard で no-op になる (= undo 自体は BB 側で成立し、 我々の同期は
	// export 終了後の rescan に持ち越される)。
	const onUndoRedo = (): void => {
		try {
			rescanRegistry()
			invalidatePreviewSession()
			requestAnimatorPreview('undo/redo')
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] undo/redo refresh failed`, e)
		}
	}

	Blockbench.on('display_animation_frame', onAnimFrame)
	Blockbench.on('select_project', onProjectSelect)
	Blockbench.on('load_project', onProjectLoad)
	Blockbench.on('new_project', onProjectLoad)
	Blockbench.on('update_selection', onUpdateSelection)
	Blockbench.on('select_mode', onModeChange)
	Blockbench.on('undo', onUndoRedo)
	Blockbench.on('redo', onUndoRedo)
	Blockbench.on('finished_edit', onFinishedEdit)
	Blockbench.on('select_animation', onSelectAnimation)

	return (): void => {
		// 予約済み rAF の cancel + disposed guard (= unload 後にコールバックが走って
		// cleanup 済みの registry を再充填するのを防ぐ)。 flag 類も元に戻す。
		tickLoopDisposed = true
		if (projectRescanRafId !== null) {
			cancelAnimationFrame(projectRescanRafId)
			projectRescanRafId = null
		}
		projectSwitchPending = false
		// export 中に unload されても flag を残さない (= 次の install / reload で preview が
		// 止まったままになるのを防ぐ)。
		exportGate.reset()
		Blockbench.removeListener?.('display_animation_frame', onAnimFrame)
		Blockbench.removeListener?.('select_project', onProjectSelect)
		Blockbench.removeListener?.('load_project', onProjectLoad)
		Blockbench.removeListener?.('new_project', onProjectLoad)
		Blockbench.removeListener?.('update_selection', onUpdateSelection)
		Blockbench.removeListener?.('select_mode', onModeChange)
		Blockbench.removeListener?.('undo', onUndoRedo)
		Blockbench.removeListener?.('redo', onUndoRedo)
		Blockbench.removeListener?.('finished_edit', onFinishedEdit)
		Blockbench.removeListener?.('select_animation', onSelectAnimation)
		registry.clear()
		topoOrder = []
		lastGraphFingerprint = ''
		lastSessionFingerprint = ''
		overridesMemo = null
		warnedNewerSchemaUuids.clear()
		renderSampleCountCache.clear()
		warnedRestWindowUuids.clear()
		invalidatePreviewSession()
	}
}

// --- AnimatedJava export driver の接続 ---
// 判定と時刻管理は ajExportBridge の driver が持つ。 ここには「driver が要求する注入口を
// BB / module 状態へ繋ぐ」 「AJ の render hook registry へ登録 / 解除する」 だけを置く。

// rollback 用の feature flag (= コード内定数のみ、 設定 UI は作らない)。 false にすると
// 登録自体を行わず、 AJ の export 出力は plugin 導入前と完全に同一に戻る。
const ENABLE_AJ_EXPORT = true

const exportDriverHost: ExportDriverHost<PreviewAnimationContext> = {
	// runtime は preview と共用する module singleton (= 同時に走らないよう exportActive で
	// preview 側を止める)。 currentStepIndex / isEvaluating は **getter で委譲** する :
	// 値をコピーすると driver が古い state を見て advance / reapply を誤判定する。
	beginAnimation: (context, evaluateBasePose) => { runtime.beginAnimation(context, evaluateBasePose) },
	evaluateStepIndex: (stepIndex) => { runtime.evaluateStepIndex(stepIndex) },
	applyWithoutAdvance: () => { runtime.applyWithoutAdvance() },
	endAnimation: () => { runtime.endAnimation() },
	get currentStepIndex(): number | null { return runtime.currentStepIndex },
	get isEvaluating(): boolean { return runtime.isEvaluating },
	suspendTick: () => {
		exportGate.suspend()
		// export hook と inspection / bake は同じ runtime singleton を共有する。
		// owner を gate とは別に記録して、AJ が評価中の再入を黙って通さない。
		runtimeOwner = 'aj_export'
	},
	resumeTick: () => {
		try {
			exportGate.resume()
		} finally {
			if (runtimeOwner === 'aj_export') runtimeOwner = 'none'
		}
	},
	invalidatePreview: () => { invalidatePreviewSession() },
	// AJ v2 の周期情報をそのまま rest window の入力にする (= export では
	// renderSampleCount が正本。 preview 側の deriveRenderSampleCount で数え直さない)。
	// fade 長だけは animation Property から読む。
	//
	// **契約違反の timing は throw して export を止める** : 0 へ正規化して続行すると
	// weight ≡ 0 = 物理が全く載っていない datapack が黙って出力される。 AJ は hook の例外を
	// RenderHookError に包んで export エラーへ surface するため、 ここで止めれば気付ける。
	// preview 側 (= makePreviewRestWindow) は警告 + 窓の省略に留める (= 編集を止めない)。
	makeExportContext: (animation, excludedNodeUuids, timing) => {
		const restTiming = {
			renderSampleCount: timing.renderSampleCount,
			loopMode: timing.loopMode,
			loopDelayFrames: timing.loopDelayFrames,
		}
		const violation = checkRestWindowTiming(restTiming)
		if (violation !== null) {
			throw new Error(
				`[${PLUGIN_ID}] AnimatedJava render hook supplied invalid animation timing (${violation}); aborting export to avoid baking an animation without spring physics`,
			)
		}
		return makeExportAnimationContext(animation, excludedNodeUuids, {
			timing: restTiming,
			requestedFadeFrames: readRestFadeFrames(animation),
		})
	},
	// capable な bone が 1 つも無い project では export に一切介入しない : 介入すると
	// frame ごとに pose の capture / restore と 3 sub-step 分の base pose 再評価が乗り、
	// 物理を掛ける対象がゼロのまま export だけが重くなる。
	//
	// **runtime を他が握っている間の export は throw して止める** : runtime / exportGate は
	// preview・export・bake で共用する singleton なので、 bake 中 (= stackAnimations 内の同期
	// event 等から) export が始まると、 export 側が同じ gate を取って runtime.beginAnimation で
	// bake の session を上書きし、 さらに bake 側の resume が export 中の gate まで解除してしまう。
	// **false を返して黙って見送らない** : それだと物理の載っていない datapack がそのまま
	// 出力される (= makeExportContext の契約違反時と同じ方針で、 気付ける形で止める)。
	isEnabled: () => {
		if (isInspectionFaulted()) {
			throw new Error(
				`[${PLUGIN_ID}] spring inspection restore failed for the current project; do not save and reopen the project before exporting`,
			)
		}
		if (!ENABLE_AJ_EXPORT || registry.size === 0) return false
		if (runtimeOwner !== 'none' || exportGate.isExportActive || runtime.isEvaluating) {
			throw new Error(
				`[${PLUGIN_ID}] spring runtime is busy (owner=${runtimeOwner}, exportActive=${exportGate.isExportActive}, evaluating=${runtime.isEvaluating}); aborting export instead of producing a datapack without spring physics`,
			)
		}
		return true
	},
}

// driver を AJ の render hook registry (= window.AnimatedJava.renderHooks) へ登録する。
// AJ 不在時は何もせず、 plugin の他機能 (= preview / Panel / context menu) には影響しない。
function installAjExportDriver(): () => void {
	if (!ENABLE_AJ_EXPORT) return (): void => {}
	const driver = createExportDriver(exportDriverHost)
	// 登録先 registry の identity 管理と再試行 listener は ajRegistrar.ts に集約する。
	// ここには「BB / window 側の口を ops へ繋ぐ」 だけを置く。
	const registrar = installAjRegistrar({ pluginId: PLUGIN_ID, enabled: ENABLE_AJ_EXPORT, driver }, {
		getApi: () => window?.AnimatedJava?.renderHooks,
		onPluginLoaded: (listener) => { Blockbench.on('loaded_plugin', listener) },
		offPluginLoaded: (listener) => { Blockbench.removeListener?.('loaded_plugin', listener) },
		shutdownDriver: () => { driver.onEndRendering() },
		log: (message) => { console.log(message) },
		warn: (message, e) => { console.warn(message, e) },
	})
	return (): void => { registrar.dispose() }
}

// --- spring bake (= 派生 animation への焼き込み) ---
// 物理を replay して bone ごとの bezier keyframe を作る純粋部分は bakeTimeline.ts が持つ。
// ここには「scene 側の作用を ops へ繋ぐ」 「派生 animation を BB へ登録する」 だけを置く。
//
// **元 animation は一切変更しない** : 出力は必ず新しい Animation instance で、
// unbake = その派生 animation を削除するだけ (= Undo でも消える)。

const RAD2DEG = 180 / Math.PI

// runtime / exportGate (= preview・export・bake で共用する singleton) を今どの処理が
// 握っているか。 現状は bake だけが明示的に所有権を取る (= export 側は exportGate の
// isExportActive が実質の所有印)。 export driver の isEnabled がこれを見て、 bake 中に
// 始まった export を弾く (= 互いの session と gate を上書きし合うのを防ぐ)。
let runtimeOwner: InspectionRuntimeOwner = 'none'

// evaluation の fault は project identity + generation 単位。復元不能な scene を同じ世代で
// 再利用すると結果や export を壊すため、該当 project の full load / new project / plugin reload まで fail closed。
const inspectionLifecycle = createInspectionProjectLifecycle<object>()

function isInspectionFaulted(): boolean {
	return isInspectionFaultedForGeneration(inspectionLifecycle.fault, inspectionLifecycle.generation)
}

function markInspectionProjectGeneration(loadObserved: boolean): void {
	inspectionLifecycle.observeProject(Project as object | null, loadObserved)
}

// bake の除外 node 集合 (= 常に空)。 AJ export の excluded_nodes 相当の口だが、 bake は
// editor 上の全 spring bone を対象にするため空集合を渡す。
const BAKE_EXCLUDED_NODES: ReadonlySet<string> = new Set<string>()

// 全 node の mesh.rotation.order の出所 (= group.js:627 が Format.euler_order を代入)。
// 誤差評価で Euler → quaternion に戻す時、 ここが食い違うと別の姿勢を測ることになる。
function resolveEulerOrder(): string {
	const order = (Format as { euler_order?: unknown } | undefined)?.euler_order
	return typeof order === 'string' && /^[XYZ]{3}$/.test(order) ? order : 'ZYX'
}

// curveFit へ注入する quaternion 演算。 角度差は符号違いの同一姿勢を同一視する
// (= dot の絶対値)。 **戻り値は毎回新しい instance にする** : fitSharedKnots が
// 全 frame の真値 quaternion を保持するため、 使い回すと全部同じ値になる。
function makeBakeQuaternionOps(): QuaternionOps<any> {
	const order = resolveEulerOrder()
	const euler = new THREE.Euler(0, 0, 0, order)
	return {
		quaternionFromEuler(x: number, y: number, z: number): any {
			euler.set(x, y, z, order)
			return new THREE.Quaternion().setFromEuler(euler)
		},
		quatAngleDeg(a: any, b: any): number {
			const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
			return 2 * Math.acos(Math.min(1, dot)) * RAD2DEG
		},
	}
}

// bone の rest 回転 (= BB の fix_rotation) を degrees で読む。
// **BB の keyframe 適用は「componentwise な Euler の加算」** (= timeline_animators.js:387-389
// `bone.rotation.x += degToRad(value)`、 その手前で showDefaultPose が
// `bone.rotation.copy(bone.fix_rotation)` する = animation_mode.js:103) なので、
//     mesh.rotation = fix_rotation + degToRad(keyframe 値)
// が再生時の関係。 したがって keyframe 値 = 合成後の絶対 Euler − fix_rotation になる。
// fix_rotation が無い mesh は 0 (= rest 無し) 扱い。
function readRestRotationDeg(group: any): AxisTriple {
	const fix = group?.mesh?.fix_rotation
	const read = (axis: 'x' | 'y' | 'z'): number => {
		const raw = fix?.[axis]
		return typeof raw === 'number' && Number.isFinite(raw) ? raw * RAD2DEG : 0
	}
	return { x: read('x'), y: read('y'), z: read('z') }
}

// 物理適用後の **絶対** Euler (= degrees) を読む。 rest 差分への変換は bakeTimeline 側
// (= フィッティングと連続化は絶対 Euler の空間で行う必要があるため。 rest を引いた
// 空間では「双対解」 の関係式も geodesic 誤差も成立しない)。
// composeSpringPose は mesh.quaternion を書くが、 Three.js の Object3D は quaternion の
// onChange で rotation を同期するため、 ここは常に最新の合成結果になる。
function readAbsoluteRotationDeg(uuid: string): AxisTriple | null {
	const rotation = registry.get(uuid)?.group?.mesh?.rotation
	if (!rotation) return null
	return {
		x: rotation.x * RAD2DEG,
		y: rotation.y * RAD2DEG,
		z: rotation.z * RAD2DEG,
	}
}

// bakeTimeline の scene ops を BB / runtime へ繋ぐ。
function makeBakeSceneOps(context: PreviewAnimationContext): BakeSceneOps {
	return {
		beginSession(): void {
			// resolveConfigs (= effective の解決) はここで走る。 listTargets はその後に呼ばれる。
			runtime.beginAnimation(context, applyPoseAt)
		},
		listTargets(): readonly BakeTarget[] {
			const targets: BakeTarget[] = []
			for (const uuid of topoOrder) {
				const entry = registry.get(uuid)
				if (!entry || !isSpringActive(entry) || !entry.group?.mesh) continue
				targets.push({
					uuid,
					name: typeof entry.group.name === 'string' ? entry.group.name : uuid,
					restRotationDeg: readRestRotationDeg(entry.group),
				})
			}
			return targets
		},
		evaluateFrame(frameIndex: number): void {
			const stepIndex = stepIndexFromFrame(frameIndex)
			// **base pose を先に当てる** : runtime.evaluateStepIndex は冒頭で現在の scene pose を
			// capture し、 sub-step 後にそこへ復元してから Δ を載せ直す。 当てておかないと
			// 「前 frame の pose に今 frame の Δ」 という混ざった姿勢を読むことになる
			// (= AJ export では AJ 側が frame の base pose を当ててから onPose を呼ぶ。 その手順を
			// bake でも再現する)。 時刻は step 番号から逆写像して浮動小数の累積を避ける。
			applyPoseAt(stepIndexToTime(stepIndex), context)
			runtime.evaluateStepIndex(stepIndex)
		},
		readRotationDeg(uuid: string): AxisTriple | null {
			return readAbsoluteRotationDeg(uuid)
		},
		endSession(): void {
			runtime.endAnimation()
		},
	}
}

// bake が扱えない「元 animation の非既定な状態」 の検査。 該当したら **bake を拒否する**
// (= 仮機能スコープなので、 中途半端に写すより止める)。
//
// 共通する構造は「stackAnimations の pose 評価には効くが、 派生 animation には正しく写らない
// 状態」。 焼き込んだ rotation にはその効果が **既に入っている** のに、 複製した data 側にも
// 同じ状態が残る (= blend_weight) か、 逆に落ちる (= muted) ため、 再生結果が食い違う。

// blend_weight は Molang 文字列 Property (= animation.js:775、 既定 '')。
// BB は `animation.blend_weight ? parse(...) : 1` で multiplier にする (= animation_mode.js:329)
// ため、 falsy か定数 1 なら「掛からない」 = 既定と等価。 動的な Molang 式は値が読めないので
// 一律拒否する。
function isDefaultBlendWeight(raw: unknown): boolean {
	if (!raw) return true
	const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null
	if (text === null) return false
	if (text.length === 0) return true
	return /^\+?1(\.0*)?$/.test(text)
}

// transform channel (= rotation / position / scale) を mute している animator の名前を返す。
// mute は stackAnimations の pose 評価に効く (= timeline_animators.js:594-596) が、
// getUndoCopy には含まれないため派生側では全 channel が unmute になる。 親 bone の rotation を
// mute した状態で bake すると、 収集時は親回転が無い pose なのに派生再生では復活し、
// 子 spring bone の world pose が変わる。
const BAKE_TRANSFORM_CHANNELS = ['rotation', 'position', 'scale'] as const
function findMutedTransformAnimator(animation: any): string | null {
	const animators = animation?.animators
	if (!animators || typeof animators !== 'object') return null
	for (const key of Object.keys(animators)) {
		const animator = (animators as Record<string, any>)[key]
		const muted = animator?.muted
		if (!muted || typeof muted !== 'object') continue
		for (const channel of BAKE_TRANSFORM_CHANNELS) {
			if (muted[channel]) {
				return typeof animator.name === 'string' && animator.name.length > 0 ? animator.name : key
			}
		}
	}
	return null
}

// bake 中だけ effect channel (= particle / sound / timeline script) を止める。 戻り値は復元関数。
//
// **なぜ必要か** : base pose の評価は Animator.stackAnimations を通り、 その末尾で
// `animation.animators.effects.displayFrame(in_loop)` が走る (= animation_mode.js:344-350)。
// これは transform とは無関係に particle emitter の生成 / jumpTo (= timeline_animators.js:1046-1092)
// と timeline script の Molang 実行 (= 同 :1095-1102) を行う。 preview は 1 frame ずつなので実害が
// 小さいが、 bake は全 frame × sub-step を一気に replay するため桁が違う (= 10 秒の animation で
// 600 sub-step ぶんの emitter 発火と script 実行が一瞬で走る)。
//
// **channel 名はハードコードしない** : AnimatedJava fork は EffectAnimator に `variant`
// channel を足し、 displayFrame を差し替えて `muted.variant` が false なら
// `result?.variant?.select()` を実行する (= animated-java/src/mods/customKeyframes.ts:216-249)。
// 標準 3 channel (= particle / sound / timeline) だけを mute すると、 bake の全 frame で
// variant 切替が走り、 未選択 animation を bake した場合に選択中 variant が元へ戻らない。
// `muted` に **実在する key を全部** 立てる形にすれば、 fork が channel を増やしても追随する。
//
// **transform だけを評価する経路は BB に無い** : 公開されているのは stackAnimations /
// Animator.preview だけで、 どちらも effects を含む。 bone loop を自前で書き写す手はあるが
// (= Animation.sampleIK が部分的にやっている、 animation.js:170-194)、 blend_weight / pre_rotation /
// Outliner.elements の animator 等の扱いまで複製することになり、 **bake と preview / export の
// pose 評価が別実装に分裂する** (= 物理の正しさが評価経路の一致に依存しているので、 分裂させると
// 「preview では合うが bake ではズレる」 を作り込む)。 そこで評価経路は stackAnimations のまま、
// BB 自身の mute 機構で effect 側だけを止める。
// last_displayed_time は mute に関係なく毎回上書きされる (= 同 :1104) ので、 これも復元する。
function suppressEffectAnimator(animation: any): () => void {
	const effects = animation?.animators?.effects
	const muted = effects?.muted
	if (!effects || typeof muted !== 'object' || muted === null) return (): void => {}
	const savedMuted = { ...muted }
	const savedLastDisplayedTime = effects.last_displayed_time
	for (const channel of Object.keys(muted)) {
		;(muted as Record<string, unknown>)[channel] = true
	}
	return (): void => {
		try {
			Object.assign(muted, savedMuted)
			effects.last_displayed_time = savedLastDisplayedTime
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] failed to restore effect animator state`, e)
		}
	}
}

interface InspectionSceneState {
	pose: AnimatorPoseSnapshot
	timelineTime: unknown
	timelinePlaying: unknown
	playing: Array<{ animation: any; value: unknown }>
	selection: {
		outliner: any[] | null
		group: unknown
		animation: unknown
		controller: unknown
	}
	projectSaved: unknown
	projectUuid: string | null
	undoIndex: unknown
	undoHistory: unknown
	undoCurrentSave: unknown
}

function captureInspectionState(): InspectionSceneState {
	const animations = Array.isArray(Animation?.all) ? Animation.all : []
	return {
		pose: captureAnimatorPose(),
		timelineTime: Timeline?.time,
		timelinePlaying: Timeline?.playing,
		playing: animations.map((animation) => ({ animation, value: animation?.playing })),
		selection: {
			outliner: Array.isArray(Outliner?.selected) ? Outliner.selected.slice() : null,
			group: (Group as any)?.selected,
			animation: Animation?.selected,
			controller: AnimationController?.selected,
		},
		projectSaved: Project?.saved,
		projectUuid: typeof Project?.uuid === 'string' ? Project.uuid : null,
		undoIndex: Undo?.index,
		undoHistory: Undo?.history,
		undoCurrentSave: Undo?.current_save,
	}
}

function restoreInspectionState(state: InspectionSceneState): void {
	restoreAnimatorPose(state.pose)
	Canvas?.scene?.updateMatrixWorld?.(true)
	if (Timeline) {
		Timeline.time = state.timelineTime as number
		Timeline.playing = state.timelinePlaying as boolean
	}
	for (const entry of state.playing) entry.animation.playing = entry.value
	if (Outliner && state.selection.outliner !== null) restoreSelectionInPlace(Outliner, state.selection.outliner)
	if (Group) (Group as any).selected = state.selection.group
	if (Animation) Animation.selected = state.selection.animation
	if (AnimationController) AnimationController.selected = state.selection.controller
	if (Project && !Object.is(Project.saved, state.projectSaved)) Project.saved = state.projectSaved as boolean
	if (Undo) {
		Undo.index = state.undoIndex as number
		Undo.current_save = state.undoCurrentSave
	}
}

function sameReferenceList(a: readonly unknown[] | null, b: readonly unknown[] | null): boolean {
	if (a === null || b === null) return a === b
	return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameAnimatorPose(a: AnimatorPoseSnapshot, b: AnimatorPoseSnapshot): boolean {
	if (a.entries.length !== b.entries.length) return false
	return a.entries.every((entry, index) => {
		const other = b.entries[index]
		return entry.mesh === other.mesh &&
			Object.is(entry.px, other.px) && Object.is(entry.py, other.py) && Object.is(entry.pz, other.pz) &&
			Object.is(entry.qx, other.qx) && Object.is(entry.qy, other.qy) &&
			Object.is(entry.qz, other.qz) && Object.is(entry.qw, other.qw) &&
			Object.is(entry.sx, other.sx) && Object.is(entry.sy, other.sy) && Object.is(entry.sz, other.sz) &&
			entry.hasPre === other.hasPre && Object.is(entry.prx, other.prx) &&
			Object.is(entry.pry, other.pry) && Object.is(entry.prz, other.prz) && entry.pro === other.pro
	})
}

function verifyInspectionState(state: InspectionSceneState): boolean {
	const current = captureInspectionState()
	return sameAnimatorPose(state.pose, current.pose) &&
		Object.is(state.timelineTime, current.timelineTime) &&
		Object.is(state.timelinePlaying, current.timelinePlaying) &&
		state.playing.length === current.playing.length &&
		state.playing.every((entry, index) => entry.animation === current.playing[index].animation && Object.is(entry.value, current.playing[index].value)) &&
		sameReferenceList(state.selection.outliner, current.selection.outliner) &&
		state.selection.group === current.selection.group &&
		state.selection.animation === current.selection.animation &&
		state.selection.controller === current.selection.controller &&
		Object.is(state.projectSaved, current.projectSaved) &&
		state.projectUuid === current.projectUuid &&
		Object.is(state.undoIndex, current.undoIndex) &&
		state.undoHistory === current.undoHistory &&
		state.undoCurrentSave === current.undoCurrentSave
}

function inspectionAnimationTiming(animation: any): SpringEvaluationInputV1['timing'] {
	const renderSampleCount = renderSampleCountCache.get(animation, animation?.length)
	if (renderSampleCount === null) {
		throw Object.assign(new Error('animation render samples cannot be enumerated'), { code: 'EVALUATION_STATE_UNAVAILABLE' })
	}
	const loopMode = animation?.loop
	const loopDelayFrames = Number(animation?.loop_delay) || 0
	const violation = checkPreviewRestWindowTiming({ renderSampleCount, loopMode, loopDelayFrames })
	if (violation !== null) {
		throw Object.assign(new Error(`invalid animation timing: ${violation}`), { code: 'EVALUATION_STATE_UNAVAILABLE' })
	}
	const requestedFadeFrames = readRestFadeFrames(animation)
	const displayedFinalFrame = deriveDisplayedFinalFrame({ renderSampleCount, loopMode, loopDelayFrames })
	const resolvedFadeFrames = resolveFadeFrames(requestedFadeFrames, displayedFinalFrame)
	return {
		source_fps: 20,
		simulation_fps: 60,
		substeps_per_frame: 3,
		animation_length_seconds: typeof animation?.length === 'number' ? animation.length : Number(animation?.length),
		render_sample_count: renderSampleCount,
		loop_mode: loopMode,
		loop_delay_frames: loopDelayFrames,
		rest_fade_frames: requestedFadeFrames,
		displayed_final_frame: displayedFinalFrame,
		resolved_fade_frames: resolvedFadeFrames,
	}
}

function makeInspectionEvaluationInput(animation: any): SpringEvaluationInputV1 {
	if (projectSwitchPending) {
		throw Object.assign(new Error('project switch is still being synchronized'), {
			code: 'EVALUATION_STATE_UNAVAILABLE',
		})
	}
	const animationUuid = typeof animation?.uuid === 'string' ? animation.uuid : null
	if (animationUuid === null) {
		throw Object.assign(new Error('animation UUID is unavailable'), { code: 'EVALUATION_TARGET_NOT_FOUND' })
	}
	const timing = inspectionAnimationTiming(animation)
	const overrides = readOverrides(animation)
	const baked = isBakedAnimation(animation)
	const springBones = Array.from(registry.values())
		.sort((a, b) => a.group.uuid.localeCompare(b.group.uuid))
		.map((entry) => {
			const state = getSpringBoneState(entry.group)
			const override = overrides[entry.group.uuid]
			const effective = resolveEffective(entry.base, state, override, DEFAULT_CONFIG)
			const dir = entry.geometry.restLocalDir
			return {
				uuid: entry.group.uuid,
				parent_uuid: entry.parentUuid,
				state,
				enabled: effective.enabled && !baked,
				drag: effective.drag,
				stiffness: effective.stiffness,
				gravity: effective.gravity,
				rest_length: entry.geometry.restLength,
				rest_direction: [dir.x, dir.y, dir.z] as [number, number, number],
				override: override ? { ...override } : null,
			}
		})
	const bakedFrom = animation?.[ANIM_BAKED_FROM_KEY]
	const paramHash = animation?.[ANIM_BAKED_PARAM_HASH_KEY]
	const sourceHash = animation?.[ANIM_BAKED_SOURCE_HASH_KEY]
	const bakedVersion = animation?.[ANIM_BAKED_VERSION_KEY]
	const displayedFinalFrame = timing.displayed_final_frame
	return {
		animation_uuid: animationUuid,
		schema_version: normalizeSchemaVersion(animation?.[ANIM_SCHEMA_VERSION_KEY]),
		rest_fade_frames: timing.rest_fade_frames,
		baked: {
			is_baked: baked,
			baked_from: typeof bakedFrom === 'string' && bakedFrom.length > 0 ? bakedFrom : null,
			param_hash: typeof paramHash === 'string' && paramHash.length > 0 ? paramHash : null,
			source_hash: typeof sourceHash === 'string' && sourceHash.length > 0 ? sourceHash : null,
			version: typeof bakedVersion === 'number' && Number.isFinite(bakedVersion) ? bakedVersion : null,
		},
		spring_bones: springBones,
		timing,
		rest_window: {
			requested_fade_frames: timing.rest_fade_frames,
			displayed_final_frame: displayedFinalFrame,
			resolved_fade_frames: timing.resolved_fade_frames,
		},
		evaluation_basis: 'aj_export_single_animation',
		load_provenance: inspectionLifecycle.loadObserved ? 'complete' : 'unverified_late_enable',
		project_uuid: typeof Project?.uuid === 'string' ? Project.uuid : null,
		provider_id: PLUGIN_ID,
		provider_api_version: 1,
		provider_version: PLUGIN_VERSION,
		simulation_version: 'spring-runtime-v1',
	}
}

let inspectionContext: PreviewAnimationContext | null = null

// AJ animationRenderer.getAnimatableNodes() の順序に寄せた、単独 animation 用の
// node 列挙。Outliner.elements が公開されない旧 BB では Project の配列へフォールバックする。
// Group.all / Project.elements の重複は identity で除去し、同じ node を二度評価しない。
function getInspectionAnimatableNodes(): readonly unknown[] {
	const nodes: any[] = []
	const seen = new Set<any>()
	const candidates = [
		...((Array.isArray((Group as any)?.all) ? (Group as any).all : []) as any[]),
		...((Array.isArray(Outliner?.elements) ? Outliner?.elements : []) as any[]),
		...(((Project as { elements?: unknown[] } | null)?.elements ?? []) as any[]),
		...(((Project as { groups?: unknown[] } | null)?.groups ?? []) as any[]),
	]
	for (const node of candidates) {
		if (node === null || node === undefined || seen.has(node)) continue
		seen.add(node)
		nodes.push(node)
	}
	return nodes
}

const evaluateInspectionSingleAnimation = createAjSingleAnimationEvaluator({
	timeline: Timeline,
	animator: Animator,
	canvas: Canvas,
	getAnimatableNodes: getInspectionAnimatableNodes,
})

const inspectionHost: InspectionHost<any, InspectionSceneState> = createInspectionHost({
	provider_version: PLUGIN_VERSION,
	simulation_version: 'spring-runtime-v1',
	getProjectGeneration: () => inspectionLifecycle.generation,
	getProjectUuid: () => typeof Project?.uuid === 'string' ? Project.uuid : null,
	getAnimation: (animationUuid) => {
		const all = Array.isArray(Animation?.all) ? Animation.all : []
		return all.find((animation) => animation?.uuid === animationUuid) ?? null
	},
	getEvaluationInput: (animation) => makeInspectionEvaluationInput(animation),
	getNodeUuids: () => {
		const uuids = new Set<string>()
		for (const node of [
			...((Project as { groups?: unknown[] } | null)?.groups ?? []),
			...((Project as { elements?: unknown[] } | null)?.elements ?? []),
		]) {
			const uuid = (node as { uuid?: unknown } | null)?.uuid
			if (typeof uuid === 'string') uuids.add(uuid)
		}
		return Array.from(uuids).sort()
	},
	isModeSupported: () => Modes?.animate === true,
	getMode: (_animation, input) => {
		if (input.baked.is_baked) return 'baked_keyframes'
		return input.spring_bones.some((bone) => bone.enabled) ? 'simulated' : 'no_active_spring'
	},
	getRuntimeOwner: () => runtimeOwner,
	getRuntimeEvaluating: () => runtime.isEvaluating,
	acquireRuntimeOwner: (owner) => {
		if (runtimeOwner !== 'none' || exportGate.isExportActive || runtime.isEvaluating) return false
		runtimeOwner = owner
		return true
	},
	releaseRuntimeOwner: (owner) => {
		if (runtimeOwner === owner) runtimeOwner = 'none'
	},
	isFaulted: (generation) => inspectionLifecycle.isFaulted(generation),
	latchFault: (generation, reason) => {
		inspectionLifecycle.latchFault(generation, reason)
	},
	captureState: () => captureInspectionState(),
	restoreState: (state) => restoreInspectionState(state),
	verifyState: (state) => verifyInspectionState(state),
	suspendPreview: () => {
		invalidatePreviewSession()
		exportGate.suspend()
	},
	resumePreview: () => {
		exportGate.resume()
	},
	refreshPreview: () => { invalidatePreviewSession() },
	suppressEffects: (animation) => suppressInspectionEffects(animation),
	beginEvaluation: (animation) => {
		const input = makeInspectionEvaluationInput(animation)
		inspectionContext = makeExportAnimationContext(animation, BAKE_EXCLUDED_NODES, {
			timing: {
				renderSampleCount: input.timing.render_sample_count,
				loopMode: input.timing.loop_mode,
				loopDelayFrames: input.timing.loop_delay_frames,
			},
			requestedFadeFrames: input.timing.rest_fade_frames,
		})
		runtime.beginAnimation(inspectionContext, (time, _context) => {
			evaluateInspectionSingleAnimation(animation, time)
		})
	},
	evaluateFrame: (animation, _frameIndex, stepIndex) => {
		if (inspectionContext === null) throw new Error('inspection session not started')
		evaluateInspectionFrame(
			runtime,
			(time) => evaluateInspectionSingleAnimation(animation, time),
			stepIndex,
		)
	},
	readPose: (nodeUuid): InspectionPoseRead | null => {
		const springGroup = registry.get(nodeUuid)?.group
		const projectNode = [
			...((Project as { groups?: unknown[] } | null)?.groups ?? []),
			...((Project as { elements?: unknown[] } | null)?.elements ?? []),
		].find((node) => (node as { uuid?: unknown } | null)?.uuid === nodeUuid) as { mesh?: any } | undefined
		const mesh = springGroup?.mesh ?? projectNode?.mesh
		const matrix = mesh?.matrixWorld?.elements
		const quaternion = mesh?.quaternion
		if (!mesh || !matrix || !quaternion) return null
		return {
			local_quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
			matrix_world: Array.from(matrix),
		}
	},
	endEvaluation: () => {
		try {
			runtime.endAnimation()
		} finally {
			inspectionContext = null
		}
	},
	isInputCurrent: (animation, input) => {
		try {
			return JSON.stringify(makeInspectionEvaluationInput(animation)) === JSON.stringify(input)
		} catch {
			return false
		}
	},
})

function installInspectionProvider(): () => void {
	inspectionLifecycle.beginPluginLoad(Project as object | null)
	const api = createSpringBoneInspectionApi(inspectionHost)
	const target = window as unknown as { BlockbenchSpringBoneInspection?: unknown }
	const cleanup = installInspectionGlobal(target, api)
	return (): void => {
		cleanup()
		inspectionContext = null
	}
}

// bake の結果 / 中断理由をユーザーへ伝える。 showMessageBox が使えない環境
// (= 旧 BB / テスト) では console へ落とす。
function showBakeMessage(title: string, message: string): void {
	try {
		if (typeof Blockbench.showMessageBox === 'function') {
			Blockbench.showMessageBox({ title, message, icon: 'gesture', buttons: ['dialog.ok'] })
			return
		}
	} catch (e) {
		console.warn(`[${PLUGIN_ID}] showMessageBox failed`, e)
	}
	console.log(`[${PLUGIN_ID}] ${title}: ${message}`)
}

// bake 時の物理入力の snapshot (= param hash の元)。 uuid 昇順に並べて key 順依存を消す。
// 物理パラは effective (= entry.config、 bake session の resolveConfigs が解決した値) を読む
// ため、 animation 単位 override の反映後の値になる。
function collectBakeParamSnapshot(animation: unknown): unknown {
	const uuids = Array.from(registry.keys()).sort()
	const bones = uuids.map((uuid) => {
		const entry = registry.get(uuid)!
		const dir = entry.geometry.restLocalDir
		return {
			uuid,
			state: getSpringBoneState(entry.group),
			parent: entry.parentUuid ?? null,
			enabled: entry.enabled,
			drag: entry.config.drag,
			stiffness: entry.config.stiffness,
			gravity: entry.config.gravity,
			restLength: entry.config.restLength,
			dir: [dir?.x ?? 0, dir?.y ?? 0, dir?.z ?? 0],
		}
	})
	return {
		bones,
		overrides: overridesFingerprint(readOverrides(animation), uuids),
		restFadeFrames: readRestFadeFrames(animation),
	}
}

// bake 本体。 対象 animation の物理を replay して派生 animation を作る。
function runSpringBake(animation: any): void {
	const AnimationCtor = Animation as unknown as (new (data: unknown) => any) | undefined
	if (typeof AnimationCtor !== 'function') {
		showBakeMessage('Spring bake', 'Animation class is not available')
		return
	}
	if (!animation) return
	if (isInspectionFaulted()) {
		showBakeMessage('Spring bake', 'Spring の評価復元に失敗しました。保存せず project を開き直してください')
		return
	}
	// **animate モード限定** : bake は applyPoseAt (= showDefaultPose + stackAnimations) で
	// scene を frame ごとに書き換える。 edit モードで走らせると編集中の pose を壊したまま、
	// 後始末の Animator.preview も (edit モードでは呼べないため) 効かない。
	if (!Modes?.animate) {
		showBakeMessage('Spring bake', 'animate モードで実行してください')
		return
	}
	// export 中 / 評価中 / 別の bake 実行中は runtime (= 共用の singleton) を横取りしない。
	if (runtimeOwner !== 'none' || exportGate.isExportActive || runtime.isEvaluating) {
		showBakeMessage('Spring bake', 'AnimatedJava の export / 別の bake の実行中は bake できません')
		return
	}
	if (isBakedAnimation(animation)) {
		showBakeMessage('Spring bake', 'この animation は既に bake 済みの派生 animation です')
		return
	}
	// **blend_weight が既定でない animation は拒否する** : 収集した rotation には
	// blend_weight が既に掛かっている一方、 複製した data 側にも blend_weight が残るため
	// 再生時に二重に掛かる (= 20° × 0.5 で焼いた 10° が、 再生では 5° になる)。
	// 派生側から消すだけでは、 未 bake のまま複製する position / scale の意味が変わる
	// (= そちらには掛かるべき) ので、 仮機能スコープでは bake ごと止める。
	if (!isDefaultBlendWeight(animation.blend_weight)) {
		showBakeMessage(
			'Spring bake',
			`blend_weight が既定ではありません ("${String(animation.blend_weight)}")。\n` +
			'bake した rotation に blend_weight が二重に掛かるため、 この animation は bake できません。',
		)
		return
	}
	// **transform channel を mute した animator がある animation も拒否する** :
	// mute は pose 評価に効くが派生側には写らないため、 再生で mute した channel が復活する。
	const mutedAnimator = findMutedTransformAnimator(animation)
	if (mutedAnimator !== null) {
		showBakeMessage(
			'Spring bake',
			`animator "${mutedAnimator}" の transform channel が mute されています。\n` +
			'mute は派生 animation に引き継げないため、 解除してから bake してください。',
		)
		return
	}
	// 直前の rig 編集 / Property 変更を取り込んでから走らせる (= registry と topoOrder の最新化)。
	try {
		rescanRegistry()
	} catch (e) {
		console.warn(`[${PLUGIN_ID}] rescanRegistry failed before bake`, e)
	}
	// frame 数は export と同じ数え方 (= 0.05 秒刻みで length 以下の sample 数)。
	const frameCount = renderSampleCountCache.get(animation, animation.length)
	if (frameCount === null || frameCount < 1) {
		showBakeMessage('Spring bake', `animation の長さ (${String(animation.length)}) から frame 数を決められません`)
		return
	}
	const context = makeExportAnimationContext(animation, BAKE_EXCLUDED_NODES, makePreviewRestWindow(animation))

	let result: BakeResult | null = null
	let paramHash = ''
	// 後始末の対象。 **取得前に例外が出ても finally が扱えるよう null 始まりにする**。
	let restoreEffects: (() => void) | null = null
	let poseSnapshot: AnimatorPoseSnapshot | null = null
	// **所有権を先に取る** : この後 stackAnimations 内の同期 event 等から export が始まっても、
	// export driver の isEnabled がこれを見て弾く (= 互いの session / gate の上書きを防ぐ)。
	// **所有権を取った直後から try/finally で囲む** : 準備段階 (= suspend / mute / capturePose) で
	// 例外が出ると、 gate と所有権を握ったまま抜けて preview / export / bake が全部止まる
	// (= plugin reload しないと戻らない)。
	runtimeOwner = 'bake'
	try {
		// export driver と同じ順序で preview を明け渡す (= session を畳んでから tick を止める)。
		invalidatePreviewSession()
		exportGate.suspend()
		// 全 frame 分の particle 発火 / timeline script 実行を止める (= transform だけが要る)。
		restoreEffects = suppressEffectAnimator(animation)
		// **bake 前の scene pose を退避する** : 評価後の scene は最後の bake frame の姿勢のままで、
		// 復帰を requestAnimatorPreview (= 失敗を warn に落とす) だけに任せると、 そこで例外が出た
		// 場合に playhead の姿勢へ戻らない。 runtime へ渡している ops と同じ capture / restore を
		// 使って、 finally で無条件に書き戻す。
		poseSnapshot = previewOps.capturePose()
		result = bakeSpringRotations(makeBakeSceneOps(context), {
			frameCount,
			...makeBakeQuaternionOps(),
		})
		// **param hash は finally より前に取る** : entry.config は bake session の
		// resolveConfigs が解決した値を保持しているが、 finally の requestAnimatorPreview →
		// Animator.preview() は **同期的に** display_animation_frame を発火し、 その listener
		// 経由で tick() → beginAnimation → resolveConfigs が走って entry.config を
		// 「選択中 animation の解決結果」 で上書きする。 右クリック対象と選択中 animation が
		// 違うと、 finally の後に読んだ値は別 animation のものになる。
		paramHash = hashFingerprint(collectBakeParamSnapshot(animation))
	} catch (e) {
		console.warn(`[${PLUGIN_ID}] bake failed`, e)
		showBakeMessage('Spring bake', `bake に失敗しました : ${String(e)}`)
		return
	} finally {
		// **各復元は個別 try** : 1 つの失敗で残りの後始末を巻き込まない。
		// **effect の mute を先に戻す** : この後の Animator.preview が現時刻の emitter を
		// 張り直すため、 mute が残っていると bake 後に particle が出なくなる。
		try {
			restoreEffects?.()
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] failed to restore effect animator state`, e)
		}
		// bake 前の pose へ書き戻す (= 以降の再描画が失敗しても最後の bake frame の姿勢が残らない)。
		try {
			if (poseSnapshot !== null) {
				previewOps.restorePose(poseSnapshot)
				previewOps.updateMatrixWorld()
			}
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] failed to restore the scene pose after bake`, e)
		}
		// suspend の逆順で戻す。 resume で export 中に skip した rescan 予約も取り戻る。
		try {
			exportGate.resume()
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] exportGate.resume failed after bake`, e)
		}
		// bake が張った runtime session を畳み、 現在時刻の pose を editor へ描き直す。
		try {
			invalidatePreviewSession()
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] invalidatePreviewSession failed after bake`, e)
		}
		// **所有権は preview を戻す前に解放する** : requestAnimatorPreview は同期的に
		// tick 経路まで走らせるため、 握ったままだと以降の判定が bake 中扱いのままになる。
		runtimeOwner = 'none'
		requestAnimatorPreview('spring bake')
	}
	if (result === null || result.bones.length === 0) {
		showBakeMessage('Spring bake', 'この animation で有効な spring bone がありません')
		return
	}
	let sourceData: any
	try {
		sourceData = animation.getUndoCopy({})
	} catch (e) {
		console.warn(`[${PLUGIN_ID}] getUndoCopy failed`, e)
		showBakeMessage('Spring bake', `元 animation を複製できませんでした : ${String(e)}`)
		return
	}
	const sourceHash = hashFingerprint(sourceData?.animators ?? null)
	const bakedData = applyBakedCurvesToAnimationData(sourceData, result.bones)
	// uuid は必ず新規に振らせる (= Animation constructor が guid を作り、 extend は uuid を
	// merge しない。 明示的に落として「複製元の uuid が紛れ込まない」 ことを保証する)。
	delete bakedData.uuid
	const baseName = typeof animation.name === 'string' && animation.name.length > 0 ? animation.name : 'animation'
	bakedData.name = `${baseName}_baked`

	let baked: any
	try {
		Undo?.initEdit?.({ animations: [] })
		baked = new AnimationCtor(bakedData)
		// **bake 由来である印**。 これが空だと isBakedAnimation が false になり、 派生
		// animation の再生 / export で物理が二重に載る。 uuid が取れない異常時も空にしない。
		baked[ANIM_BAKED_FROM_KEY] = (typeof animation.uuid === 'string' && animation.uuid) || 'unknown'
		baked[ANIM_BAKED_PARAM_HASH_KEY] = paramHash
		baked[ANIM_BAKED_SOURCE_HASH_KEY] = sourceHash
		baked[ANIM_BAKED_VERSION_KEY] = BAKE_VERSION
		// **BB 標準の複製処理と同じ後始末を通す** (= SharedActions 'duplicate'、 animation.js:846-856) :
		// - resetUniqueValues = 複製してはいけない Property (= copy_value false) を既定へ戻す
		// - saved = false = 未保存であることを明示する。 getUndoCopy は `saved` を含まないが、
		//   Property 経由で複製される値もあるうえ、 Undo の before aspects が `{animations: []}` の
		//   ため BB の finished_edit listener もこの新規 animation を dirty にしてくれない。
		//   保存済み扱いのまま残ると、 外部 animation file の再読み込みで「保存済みの同一 path」
		//   として削除されうる
		try {
			;(Property as { resetUniqueValues?: (type: unknown, instance: unknown) => void })
				?.resetUniqueValues?.(Animation, baked)
		} catch (e) {
			console.warn(`[${PLUGIN_ID}] Property.resetUniqueValues failed`, e)
		}
		// **`path` は resetUniqueValues では消えない** : BB の `Animation.properties.path`
		// (= animation.js:771) に `copy_value: false` が付いていないため、 resetUniqueValues
		// (= property.ts:238-245 が `copy_value == false` の Property だけを reset する) の
		// 対象外になる。 getUndoCopy で複製された元 animation の path が残ると、 外部 animation
		// file の保存 / 削除で同一 file として扱われるので、 ここで明示的に空へ倒す。
		baked.path = ''
		baked.saved = false
		// add(false) = Animator.animations へ追加 + createUniqueName (= 名前衝突の解決)。
		// select はしない (= 選択中 animation を勝手に切り替えない)。
		baked.add(false)
		Undo?.finishEdit?.('Spring bake', { animations: [baked] })
	} catch (e) {
		console.warn(`[${PLUGIN_ID}] failed to register baked animation`, e)
		// **部分生成物は自前で片付ける** : initEdit の aspects は `{animations: []}` なので、
		// cancelEdit(true) の revert 経路 (= undo.js:143-151 → loadSave) では追加済み
		// animation が消えない (= before / after どちらの save にも載っていないため、
		// undo.js:715-722 の「reference にあって save に無い animation を remove」 に
		// 引っかからない)。 先に自分で remove してから transaction を畳む。
		try {
			if (baked && typeof baked.remove === 'function') baked.remove(false, false)
		} catch (removeError) {
			console.warn(`[${PLUGIN_ID}] failed to roll back baked animation`, removeError)
		}
		try {
			// revert_changes は付けない (= 上記のとおり空 aspects では効かず、
			// Canvas.outlines を空にする副作用だけが残るため)。 目的は current_save を
			// 畳んで次の Undo transaction を汚さないこと。
			Undo?.cancelEdit?.()
		} catch (cancelError) {
			console.warn(`[${PLUGIN_ID}] Undo.cancelEdit failed`, cancelError)
		}
		showBakeMessage('Spring bake', `派生 animation を作成できませんでした : ${String(e)}`)
		return
	}

	const summary =
		`"${baked.name}" を作成しました\n` +
		`bone ${result.bones.length} 本 / keyframe ${result.totalKeyframes} 個 ` +
		`(最大 ${result.maxKeyframesPerSecond.toFixed(1)} kf/秒)\n` +
		`姿勢誤差 最大 ${result.maxAngleDeg.toFixed(3)}°`
	console.log(`[${PLUGIN_ID}] bake done : ${summary.replace(/\n/g, ' / ')}`)
	// **どの警告でも bake は拒否しない** : 出来上がった animation はそのまま残し、
	// 「そのまま使うと困りうる点」 だけを伝える。 複数該当しても dialog は 1 回にまとめる。
	const warnings: string[] = []
	if (result.maxKeyframesPerSecond > BAKE_DENSITY_WARN_KF_PER_SECOND) {
		warnings.push(
			`keyframe 密度が ${BAKE_DENSITY_WARN_KF_PER_SECOND} kf/秒 を超えています。` +
			'手編集には向かない密度です (= 揺れが速いほど keyframe が増えます)。',
		)
	}
	// 分割の打ち切り / 分割不能で要求精度に届かなかった bone (= 密度とは別軸の警告)。
	if (result.unconvergedBones.length > 0) {
		warnings.push(
			`次の bone は目標の姿勢誤差に届きませんでした : ${result.unconvergedBones.join(', ')}\n` +
			'物理の動きが速すぎて 20fps の keyframe では表現しきれていない可能性があります。',
		)
	}
	if (warnings.length > 0) {
		showBakeMessage('Spring bake', `${summary}\n\n${warnings.join('\n\n')}`)
	}
	try {
		updateSelection()
	} catch (e) {
		console.warn(`[${PLUGIN_ID}] updateSelection failed after bake`, e)
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
		// Property 4 個 (= spring_drag / spring_stiffness / spring_gravity + enum
		// `spring_bone_enabled`) を Group に register。 数値 Property の element_panel
		// input (= 数値 + NumSlider) が edit モードで自動生成される。
		// tick loop は Property が生えている前提で config 値を読むため、 Property 登録が先。
		registerProperties()
		cleanups.push(installInspectionProvider())
		cleanups.push(installTickLoop())
		// animate モード用の専用 Panel を register (= edit モードは element_panel input に任せる)。
		// 値変更時は onSpringPropertyChange 経由で registry sync + fingerprint invalidate される。
		// spring 化判定の述語 (= isSpringGroup、 Property ベースの **capable** 判定) と
		// override map の読み取り口 (= readOverrides、 schema version gate + memo 付きの
		// 唯一の read 経路)、 書き込み可否判定 (= canWriteOverrides、 上位 schema version
		// への書き込み禁止) はこちらから注入し、 判定元 / 読み取り元を本 module に一元化する。
		cleanups.push(registerSpringPanel({
			onChange: onSpringPropertyChange,
			isSpringCapableGroup: isSpringGroup,
			readOverrides,
			canWriteOverrides,
		}))
		// Group 右クリ context menu に「Spring 化 / 解除」 の Property toggle action を追加。
		// gesture (= 唯一の truth) は Group Property `spring_bone_enabled` の書き換えで、
		// 名前は一切変更しない。
		registerContextMenuActions()
		// Animation 右クリ menu に bake action を追加 (= 物理を派生 animation へ焼き込む)。
		// cleanup は unregisterContextMenuActions 側でまとめて行う。
		registerBakeAction()
		// Outliner 上で Property が 'enabled' の spring group を視覚的に区別する軽量マーカーを install。
		cleanups.push(registerOutlinerMarker())
		// AnimatedJava の datapack export へ物理を注入する driver を登録する。 AJ 不在でも
		// 失敗せず、 後から AJ が load された場合は loaded_plugin 経由で再試行する。
		cleanups.push(installAjExportDriver())
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
