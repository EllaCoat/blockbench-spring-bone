// AnimatedJava (= AJ) の datapack export に spring bone 物理を載せるための driver。
// AJ が公開する render hook (= window.AnimatedJava.renderHooks、 version 1) の
// hooks object としてそのまま渡せる形を返す。
//
// この module は **Blockbench / THREE / AnimatedJava / window を実行時に一切参照しない**。
// scene への作用も runtime の制御も preview の制御も、 すべて呼び出し側 (= index.ts) が
// 注入する ExportDriverHost 経由で行う (= node:test で BB 無しに検証可能)。
// AJ 側の型は別 repo にあり import できないため、 構造的に互換な最小型をここで定義する。
//
// AJ 側が保証する契約のうち、 この driver の設計に効くもの :
// - 呼び出し順は onBeginRendering → (animation ごとに onBeginAnimation → frame ごとに
//   onPose → onEndAnimation) → onEndRendering
// - **onPose は同じ frameIndex で 1 frame につき複数回呼ばれる** (= IK 成立のための
//   二度呼び / pre-post 判定の side sample とその巻き戻し / null_object ごとの再評価)。
//   回数は blueprint の構成で変わるため、 **回数は数えず frameIndex の変化だけを見る**
// - 時刻の正本は frameIndex。 timeSeconds は frameTimeSeconds と一致しないことがある
//   (= side sample では +0.001) ので参考値として扱い、 物理の時刻には使わない
// - hook は同期のみ (= Promise を返しても await されない)
// - hook の例外は AJ 側が RenderHookError に包んで export エラーへ surface するため、
//   握り潰さずそのまま throw させてよい
// - 例外経路でも onEndAnimation / onEndRendering は必ず届く (= AJ 側が成功済み
//   participant へ逆順 unwind する)
import { stepIndexFromFrame } from './springRuntime'

// --- AJ 側 hook 契約の最小型 (= 構造的互換のみ、 AJ repo からは import しない) ---

// animation 単位の context。 AJ 本体は rig 等も載せるが、 driver が読むのはここだけ。
export interface RenderAnimationContextLike {
	animation: unknown
	excludedNodeUuids: ReadonlySet<string>
	// 指定時刻の keyframe pose を scene へ再評価する (= AJ 側が閉包として詰める)
	evaluateBasePose(timeSeconds: number): void
}

// frame 単位の context (= animation 単位の context に時刻情報を足したもの)。
export interface RenderHookContextLike extends RenderAnimationContextLike {
	// frame ループの整数。 side sample でも変わらない (= 時刻の正本)
	frameIndex: number
	// frameIndex / 20
	frameTimeSeconds: number
	// updatePreview の実引数 (= side sample では frameTimeSeconds + 0.001)
	timeSeconds: number
}

// --- driver が要求する注入口 ---

// C = host が作る export 用 context の型。 driver は中身を知らない
// (= animation / 除外 node の解釈も物理 config の解決も host 側の責務)。
export interface ExportDriverHost<C> {
	// --- runtime 相当 (= SpringRuntime の該当 API へ繋ぐ) ---
	beginAnimation(context: C, evaluateBasePose: (timeSeconds: number, context: C) => void): void
	evaluateStepIndex(stepIndex: number): void
	applyWithoutAdvance(): void
	endAnimation(): void
	readonly currentStepIndex: number | null
	readonly isEvaluating: boolean
	// --- preview 制御 ---
	suspendTick(): void
	resumeTick(): void
	invalidatePreview(): void
	// --- context 生成 ---
	makeExportContext(animation: unknown, excludedNodeUuids: ReadonlySet<string>): C
	// --- 有効判定 (= plugin 設定や rig の状態で export への注入自体を切る口) ---
	isEnabled(): boolean
}

// AJ の RenderHooks としてそのまま渡せる形。 状態は読み取り口だけ公開し、
// 外から書き換える口は作らない。
export interface ExportDriver {
	onBeginRendering(): void
	onBeginAnimation(context: RenderAnimationContextLike): void
	onPose(context: RenderHookContextLike): void
	onEndAnimation(): void
	onEndRendering(): void
	// --- 内部状態の読み取り口 (= テスト用) ---
	// onBeginRendering で export session を張ったかどうか (= isEnabled() が false なら false)
	readonly isRenderingActive: boolean
	// onBeginAnimation が成功して runtime の session が張られているかどうか
	readonly isAnimationActive: boolean
}

export function createExportDriver<C>(host: ExportDriverHost<C>): ExportDriver {
	// export session (= onBeginRendering 〜 onEndRendering) が有効かどうか。
	// isEnabled() の評価はここ 1 箇所だけで、 結果は session 中ずっと保持する
	// (= rendering の途中で有効 / 無効が切り替わり、 片側の hook だけ実行される状態を作らない)。
	let renderingActive = false
	// runtime の animation session が張られているかどうか。 onBeginAnimation が
	// 失敗した場合は false のままで、 以降の onPose は no-op になる。
	let animationActive = false

	return {
		get isRenderingActive(): boolean {
			return renderingActive
		},

		get isAnimationActive(): boolean {
			return animationActive
		},

		onBeginRendering(): void {
			// 前回の session が例外で end を受け取れなかった場合に備えて、 判定前に落とす
			renderingActive = false
			animationActive = false
			if (!host.isEnabled()) return
			// preview session を先に畳んでから tick を止める。 逆順だと preview session が
			// 生きたまま止まり、 export 後の resume で stale な state から再開する。
			host.invalidatePreview()
			host.suspendTick()
			renderingActive = true
		},

		onBeginAnimation(context: RenderAnimationContextLike): void {
			if (!renderingActive) return
			// beginAnimation が失敗した場合に「開始済み」 が残らないよう先に倒す
			animationActive = false
			const exportContext = host.makeExportContext(context.animation, context.excludedNodeUuids)
			// AJ 側の evaluateBasePose は (timeSeconds) => void、 runtime が要求するのは
			// (timeSeconds, context) => void なので wrapper で包む。 context 引数は使わない
			// (= 対象 animation は AJ 側の閉包が既に持っている)。
			host.beginAnimation(exportContext, (timeSeconds: number) => {
				context.evaluateBasePose(timeSeconds)
			})
			animationActive = true
		},

		onPose(context: RenderHookContextLike): void {
			if (!renderingActive || !animationActive) return
			// runtime の評価中に届いた onPose は再入 (= 想定外)。 runtime の state を
			// 壊さないため何もしない。
			if (host.isEvaluating) return
			// 時刻の正本は frameIndex。 秒を経由しないので累積誤差が原理的に発生しない。
			const target = stepIndexFromFrame(context.frameIndex)
			if (host.currentStepIndex === target) {
				// 同じ frame の 2 回目以降 (= IK の二度呼び / pre-post の side sample と
				// その巻き戻し / null_object ごとの再評価)。 物理 state は進めず、
				// 直前の評価結果を scene へ再適用するだけにする (= 呼ばれた回数に依らず冪等)。
				host.applyWithoutAdvance()
				return
			}
			// currentStepIndex が null (= 初回 / 前回の評価が例外で落ちた後) もここに来る。
			// runtime 側が 0 replay を選ぶため、 これで正しい。
			host.evaluateStepIndex(target)
		},

		onEndAnimation(): void {
			if (!renderingActive) return
			// endAnimation が失敗しても「開始済み」 が残らないよう先に倒す
			animationActive = false
			host.endAnimation()
		},

		onEndRendering(): void {
			// 何度呼ばれても安全にする (= 2 回目以降は no-op)。 先に flag を倒すことで、
			// 後始末中に再入しても二度走らない。
			if (!renderingActive) return
			renderingActive = false
			animationActive = false
			// ここは例外経路からも呼ばれる。 途中で throw しても残りの後始末を必ず通す
			// (= tick を止めたまま復帰しない状態を作らない)。 伝播させるのは最初の例外だけで、
			// 2 件目以降は警告に落とす (= springRuntime.ts の pendingError 経路と同じ方針)。
			let pendingError: unknown = null
			let hasPendingError = false
			const runCleanup = (label: string, cleanup: () => void): void => {
				try {
					cleanup()
				} catch (e) {
					if (!hasPendingError) {
						pendingError = e
						hasPendingError = true
					} else {
						console.warn(`[spring_bone] export driver cleanup failed (${label}) while another error was pending`, e)
					}
				}
			}
			// onBeginRendering で立てた状態を必ず戻す : runtime の session を破棄 →
			// tick 再開 → preview session を畳む (= export 中の物理 state を preview へ
			// 持ち越さず、 次 tick で 0 replay させる)。
			runCleanup('endAnimation', () => host.endAnimation())
			runCleanup('resumeTick', () => host.resumeTick())
			runCleanup('invalidatePreview', () => host.invalidatePreview())
			if (hasPendingError) throw pendingError
		},
	}
}
