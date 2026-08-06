// SpringRuntime に渡す animation context の型と、 その生成のうち BB 非依存な分。
//
// この module は **Blockbench / THREE / AnimatedJava / window を実行時に一切参照しない**
// (= node:test で BB 無しに検証可能)。 Animation.all / Animation.selected を読む
// preview 側の生成 (= makePreviewAnimationContext) は BB 依存なので index.ts に残る。

import type { AnimationContext, RestWindowContext } from './springRuntime'

// preview 用の context。 animationStack = base pose 適用対象の animation 列。
// makePreviewAnimationContext で 1 回だけ確定させ、 applyPoseAt からは
// Animation.selected を再参照させない (= 選択中 animation への暗黙依存の排除)。
// restWindow (= 終端 rest 整合の窓、 optional) は AnimationContext から継承する :
// weight を算出するのは SpringRuntime なので、 型の定義箇所も runtime 側に置く。
export interface PreviewAnimationContext extends AnimationContext<any> {
	animationStack: readonly any[]
	// AJ export の excluded_nodes 由来 (= 出力に載らない node の uuid 集合)。
	// **export 経路だけが詰める** optional。 preview 経路では undefined になり、
	// resolveConfigs の除外判定が常に false = 従来と完全に同一挙動になる。
	excludedNodeUuids?: ReadonlySet<string>
}

// AJ export 用の context。 animation は AJ が渡してきたものをそのまま使い、
// **Animation.selected は参照しない** (= export 対象は選択中 animation とは限らず、
// AJ は全 animation を順に回すため)。 animationStack は型の要求を満たすためだけに
// [animation] を入れる : export 経路の base pose 評価は AJ 側の evaluateBasePose が
// 担い、 applyPoseAt を通らないので実際には読まれない。
// restWindow は AJ の周期情報 (= v2 hook context) と animation Property の fade 長から
// 呼び出し側が組み立てて渡す。 **省略された場合は weight ≡ 1 = 減衰なし** (= 従来動作)。
export function makeExportAnimationContext(
	animation: unknown,
	excludedNodeUuids: ReadonlySet<string>,
	restWindow?: RestWindowContext,
): PreviewAnimationContext {
	return { animation, animationStack: [animation], excludedNodeUuids, restWindow }
}
