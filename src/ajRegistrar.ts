// AnimatedJava (= AJ) の render hook registry へ driver を登録 / 解除する registrar。
// 「今どの registry object に登録できているか」 の identity 記憶と、 AJ の後追い load /
// reload を拾う再試行 listener の付け外しだけを担当する。
//
// この module は **Blockbench / THREE / AnimatedJava / window を実行時に一切参照しない**
// (= node:test で BB 無しに検証可能)。 registry の取得も event listener の付け外しも
// driver の停止も log 出力も、 すべて呼び出し側 (= index.ts) が注入する ops 経由で行う。
//
// driver の型 D は不透明に扱う (= registry へそのまま渡すだけで中身を見ない)。 driver の
// 生成は呼び出し側の責務で、 registrar は受け取った instance を登録するだけ。

// AnimatedJava が公開する render hook registry。 AJ は module 評価時 (= plugin 読み込み時)
// に window.AnimatedJava を代入するため、 我々の onload より後に生えることがある
// (= installAjExportDriver の loaded_plugin 再試行経路)。 AJ 不在 / 旧 version / 将来の
// 契約変更いずれでも壊れないよう、 全て optional で受けて呼ぶ前に形を確認する。
export interface AjRenderHooksApi {
	version?: number
	register?(id: string, hooks: unknown): void
	unregister?(id: string): void
}

export interface AjRegistrarOptions<D> {
	// registry への登録 id + log の prefix に使う。
	pluginId: string
	// false なら ops を一切呼ばず、 何も登録しない (= rollback flag 相当)。
	enabled: boolean
	// registry へ渡す driver。 registrar は中身を見ない。
	driver: D
}

export interface AjRegistrarOps {
	// 現在の registry (= window.AnimatedJava.renderHooks)。 呼ぶたびに読み直す。
	getApi(): AjRenderHooksApi | undefined
	// AJ の後追い load / reload を拾う event の購読 (= Blockbench の loaded_plugin)。
	onPluginLoaded(listener: () => void): void
	offPluginLoaded(listener: () => void): void
	// unregister より先に driver を非 active にする口 (= ExportDriver.onEndRendering)。
	shutdownDriver(): void
	log(message: string): void
	warn(message: string, error: unknown): void
}

export interface AjRegistrar {
	dispose(): void
	// 実際に登録できている registry (= 未登録なら null)。
	readonly registeredApi: AjRenderHooksApi | null
	// 再試行 listener が購読されているか。
	readonly isRetryAttached: boolean
}

export function installAjRegistrar<D>(options: AjRegistrarOptions<D>, ops: AjRegistrarOps): AjRegistrar {
	const { pluginId, enabled, driver } = options
	// 無効時は driver の登録も listener の購読も行わない (= AJ 側から見て plugin 導入前と
	// 完全に同じ状態にする)。 ops は 1 つも呼ばない。
	if (!enabled) {
		return {
			dispose: (): void => {},
			get registeredApi(): AjRenderHooksApi | null { return null },
			get isRetryAttached(): boolean { return false },
		}
	}

	// 登録先 registry の identity を保持する。 **AJ を単独 reload すると
	// window.AnimatedJava.renderHooks が新しい object に差し替わり、 内部の登録 Map ごと
	// 作り直される** ため、 旧 registry に居る driver は以後無言で呼ばれなくなる。 参照比較なら
	// 「後から load された」 と「reload された」 を同じ経路で拾える。
	// registeredApi = 実際に登録できた registry (= cleanup の unregister 先 + 再登録要否の判定基準)。
	// **失敗時は更新しない** : 旧 driver の unregister 遅れ等で一時的に id が衝突していた場合、
	// 更新してしまうと衝突が解消しても plugin reload まで登録し直せない。 再試行の頻度は
	// loaded_plugin の発火回数に限られるので、 warn の重複は許容する。
	let registeredApi: AjRenderHooksApi | null = null
	let retryListener: (() => void) | null = null

	const detachRetry = (): void => {
		if (retryListener === null) return
		ops.offPluginLoaded(retryListener)
		retryListener = null
	}

	// 現在の API を見て、 未登録 or 別 object に差し替わっていたら登録し直す。
	const syncRegistration = (): void => {
		const api = ops.getApi()
		if (!api || api.version !== 1 || typeof api.register !== 'function') return
		if (api === registeredApi) return
		try {
			api.register(pluginId, driver)
			registeredApi = api
			ops.log(`[${pluginId}] AnimatedJava export driver registered`)
		} catch (e) {
			ops.warn(`[${pluginId}] AnimatedJava export driver registration failed`, e)
		}
	}

	// AJ は module 評価時に window.AnimatedJava を代入し (= AJ src/index.ts)、 loaded_plugin は
	// plugin register 後に発火する (= plugin_loader.ts:391、 reload 経路も
	// loadFromFile → Plugin.register → runOnLoad で同じ event を通る)。 我々が先に load された
	// 場合も AJ が reload された場合も、 この listener が identity 比較で拾い直す。
	// **listener は unload まで外さない** : 外すと reload 検知ができなくなる。 dispatch 中に
	// 自分を remove しない形になるので、 BB の dispatchEvent が listener 配列を for...of で
	// 走査する件 (= js/util/event_system.ts:15) にも触れない。
	syncRegistration()
	retryListener = (): void => { syncRegistration() }
	ops.onPluginLoaded(retryListener)

	return {
		get registeredApi(): AjRenderHooksApi | null { return registeredApi },
		get isRetryAttached(): boolean { return retryListener !== null },
		dispose(): void {
			detachRetry()
			// **unregister より先に driver を畳む** : AJ は beginRenderingSession の時点で
			// participant を snapshot するため、 export 進行中に unregister しても残りの hook は
			// 旧 driver へ届き続ける。 一方 cleanups の実行順 (= tick loop → panel → marker →
			// driver) の都合で、 この時点では registry.clear() が済んでいる。 driver を非 active に
			// しておかないと、 残りの onPose が壊れた state の上で走る。
			// onEndRendering は冪等なので、 export 中でなければ no-op。
			try {
				ops.shutdownDriver()
			} catch (e) {
				ops.warn(`[${pluginId}] AnimatedJava export driver shutdown failed`, e)
			}
			const api = registeredApi
			if (api === null) return
			registeredApi = null
			try {
				api.unregister?.(pluginId)
			} catch (e) {
				ops.warn(`[${pluginId}] AnimatedJava export driver unregistration failed`, e)
			}
		},
	}
}
