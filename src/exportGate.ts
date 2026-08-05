// AnimatedJava (= AJ) の datapack export 中だけ preview 側を止めるための gate。
// 状態は「export 中か」 と「export 後に rescan を取り戻すか」 の boolean 2 つだけで、
// 遷移 (= suspend / resume / defer / reset) をここに集約する。
//
// この module は **Blockbench / THREE / AnimatedJava / window を実行時に一切参照しない**
// (= node:test で BB 無しに検証可能)。 registry の作り直しは呼び出し側 (= index.ts) が
// 注入する ops.rescan 経由で行う。

export interface ExportGateOps {
	// export 終了時に取り戻す registry 更新 (= index.ts の rescanRegistry)。
	rescan(): void
}

export interface ExportGate {
	readonly isExportActive: boolean
	readonly hasPendingRescan: boolean
	suspend(): void
	resume(): void
	// export 中なら rescan を予約して true を返す (= 呼び出し側はその場で return する)。
	// export 中でなければ何もせず false を返す。
	deferRescanIfActive(): boolean
	// 両 state を落とす。 予約されていた rescan は **実行せずに捨てる** (= install /
	// cleanup 時に呼ぶ想定で、 install 側は直後に自前で rescan する)。
	reset(): void
}

export function createExportGate(ops: ExportGateOps): ExportGate {
	// AnimatedJava の datapack export 中だけ立つ flag。 export 中は AJ が pose の主導権を持ち、
	// runtime は export driver (= ajExportBridge) 側が駆動するため、 preview 側の tick /
	// invalidate 経路を全部止めて runtime を明け渡す。
	// **inhibitTick を流用してはいけない** : applyPoseAt が finally で inhibitTick = false に
	// 戻すため、 export 中に base pose 評価が走るたび抑制が解けてしまう。
	// **counter ではなく boolean 代入にする** : AJ 側が onEndRendering を届けられなかった後に
	// onBeginRendering が来ると suspend が二重に呼ばれ得るため、 counter だと解除されなくなる。
	let exportActive = false
	// export 中に skip した registry 更新の取り戻し予約。 rescanRegistry / onSpringPropertyChange が
	// export 中に呼ばれたら立て、 export 終了時 (= host.resumeTick) に 1 回だけ rescan する。
	// 「export 中に rig を編集する」 自体が非現実的なので凝った仕組みは作らず、 **状態が古いまま
	// 残らないこと** だけを保証する。
	let pendingRescanAfterExport = false

	return {
		get isExportActive(): boolean { return exportActive },
		get hasPendingRescan(): boolean { return pendingRescanAfterExport },
		suspend(): void { exportActive = true },
		resume(): void {
			// **exportActive を先に倒してから rescan する** : 逆にすると rescan 自身の
			// defer guard (= deferRescanIfActive) が再び予約を立てて永久 pending になる。
			exportActive = false
			// export 中に skip した registry 更新をここで取り戻す (= 古い registry が残らない)。
			// driver はこの直後に invalidatePreview() を呼ぶため、 session は必ず張り直される。
			// 失敗しても後続の後始末を止めない (= driver 側の cleanup runner に例外を渡さない)。
			if (!pendingRescanAfterExport) return
			pendingRescanAfterExport = false
			try {
				ops.rescan()
			} catch (e) {
				console.warn('[spring_bone] rescanRegistry failed after export', e)
			}
		},
		deferRescanIfActive(): boolean {
			if (!exportActive) return false
			pendingRescanAfterExport = true
			return true
		},
		reset(): void {
			exportActive = false
			pendingRescanAfterExport = false
		},
	}
}
