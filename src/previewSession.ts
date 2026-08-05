// preview 用 SpringRuntime session の張り直し判定と invalidate を持つ controller。
// 「今 session が張られている animation / animationStack は何か」 の記憶と、 新しい
// context がそれと同じかの identity 比較だけを担当する。
//
// この module は **Blockbench / THREE / AnimatedJava / window を実行時に一切参照しない**
// (= node:test で BB 無しに検証可能)。 runtime の駆動も export 中かの判定も、 すべて
// 呼び出し側 (= index.ts) が注入する ops 経由で行う。
//
// context の型 C は不透明に扱う (= 構造的制約を課さない)。 animation / animationStack の
// 取り出しを ops へ出すことで、 preview 側の context 型を import せずに済ませている。

export interface PreviewSessionOps<C> {
	// export 中かの判定。 **getter で受ける** : 値をコピーすると controller 生成後の
	// 状態変化が反映されず、 export 中の invalidate を素通ししてしまう。
	readonly isExportActive: boolean
	// 張り直し判定に使う identity の取り出し。
	getAnimation(context: C): unknown
	getStack(context: C): readonly unknown[]
	// runtime の駆動 (= SpringRuntime の該当 API へ繋ぐ)。 base pose evaluator の受け渡しは
	// 呼び出し側の closure に閉じるため、 ここでは context だけを渡す。
	endAnimation(): void
	beginAnimation(context: C): void
}

export interface PreviewSessionController<C> {
	ensure(context: C): void
	invalidate(): void
	// session が張られているか (= 未開始 / invalidate 済みなら false)。
	readonly isActive: boolean
}

export function createPreviewSession<C>(ops: PreviewSessionOps<C>): PreviewSessionController<C> {
	// 現在の session が張られた時の animationStack / animation。 ensurePreviewSession が
	// identity 比較で張り直し要否を判定する。 previewSessionStack === null = session 未開始
	// or invalidate 済み (= 次 tick で begin し直す)。
	let previewSessionStack: readonly unknown[] | null = null
	let previewSessionAnimation: unknown = null

	return {
		get isActive(): boolean { return previewSessionStack !== null },
		// 現 session と新 context を比較し、 違う場合だけ session を張り直す。
		// 同一判定は **両方** の一致を要求する :
		// - animationStack の要素 identity 列 (===)
		// - animation の === (= stack 中身が同じ [A] でも animation: null → A 遷移を検出する。
		//   Phase β の per-animation パラメータ解決で context.animation が resolver の入力になるため)
		// 同じなら何もしない (= step cache を維持して cache advance 経路を生かす)。
		ensure(context: C): void {
			const current = previewSessionStack
			const next = ops.getStack(context)
			const animation = ops.getAnimation(context)
			const same = current !== null &&
				previewSessionAnimation === animation &&
				current.length === next.length &&
				current.every((a, i) => a === next[i])
			if (same) return
			ops.endAnimation()
			// begin が throw した場合は state を更新しない (= 古い state が残るが、 そこへ来た
			// 時点で同一判定は不成立と分かっているため、 次の ensure が必ず再試行する)。
			ops.beginAnimation(context)
			previewSessionStack = next
			previewSessionAnimation = animation
		},
		// preview session の invalidate 唯一の口。 全 invalidate 経路 (= Property 変更 / topology 変化 /
		// keyframe edit / undo / mode 切替 / cleanup) はここに集約する。
		// previewSessionStack を null にすることで、 ensurePreviewSession が次回必ず begin し直す
		// (= runtime の step cache も endAnimation で破棄される = 次回は必ず 0 replay)。
		//
		// **export 中は丸ごと no-op にする** : runtime は preview と共用なので、 ここで
		// runtime.endAnimation() を通すと進行中の export session が壊れ、 次の onPose が
		// applyWithoutAdvance の「session not started」 で throw する。 listener 側で経路を
		// 列挙して塞ぐ形は漏れる (= finished_edit / project 切替 / mode 切替 / undo / Property 変更
		// も invalidate 経路) ため、 **唯一の口であるここ 1 箇所で止める**。 export 中の preview
		// invalidate はそもそも不要 : export 終了時に driver の onEndRendering が
		// invalidatePreview() を必ず呼ぶ (= その時点では既に resumeTick 済みで exportActive は
		// false なので、 この guard には引っかからない)。
		invalidate(): void {
			if (ops.isExportActive) return
			// **state を先に落としてから endAnimation を呼ぶ** : endAnimation が throw しても
			// 観測上は invalidate 済み (= 次の ensure が張り直す) になる。
			previewSessionStack = null
			previewSessionAnimation = null
			ops.endAnimation()
		},
	}
}
