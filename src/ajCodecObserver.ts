export type AjCodecEventListener = (data?: unknown) => void
export type AjCodecCleanup = () => void

export interface AjCodecEventTargetLike {
	on?(event: string, listener: AjCodecEventListener): unknown
	addListener?(event: string, listener: AjCodecEventListener): unknown
	removeListener?(event: string, listener: AjCodecEventListener): void
}

export interface AjBlueprintCodecLike extends AjCodecEventTargetLike {}

export interface AjBlueprintCodecHandleLike<TCodec extends AjBlueprintCodecLike = AjBlueprintCodecLike> {
	get?(): TCodec | null | undefined
	onCreated?(listener: (codec: TCodec) => void): unknown
	onDeleted?(listener: (codec: TCodec) => void): unknown
}

export interface AjCodecObserverOps {
	getHandle(): AjBlueprintCodecHandleLike | null | undefined
	onPluginLoaded(listener: () => void): unknown
	offPluginLoaded?(listener: () => void): void
	onPluginUnloaded?(listener: () => void): unknown
	offPluginUnloaded?(listener: () => void): void
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function cleanupToken(token: unknown, fallback?: AjCodecCleanup): AjCodecCleanup {
	let disposed = false
	return (): void => {
		if (disposed) return
		disposed = true
		if (typeof token === 'function') {
			try { token() } catch { /* listener cleanup must not break plugin unload */ }
			return
		}
		if (isObject(token)) {
			const remove = token.delete ?? token.unsubscribe
			if (typeof remove === 'function') {
				try { remove.call(token) } catch { /* listener cleanup must not break plugin unload */ }
				return
			}
		}
		fallback?.()
	}
}

function subscribePluginEvent(
	subscribe: ((listener: () => void) => unknown) | undefined,
	unsubscribe: ((listener: () => void) => void) | undefined,
	listener: () => void,
): AjCodecCleanup {
	if (typeof subscribe !== 'function') return (): void => {}
	let token: unknown
	try {
		token = subscribe(listener)
	} catch {
		return (): void => {}
	}
	return cleanupToken(token, unsubscribe ? () => unsubscribe(listener) : undefined)
}

function subscribeHandle<TCodec extends AjBlueprintCodecLike>(
	handle: AjBlueprintCodecHandleLike<TCodec>,
	method: 'onCreated' | 'onDeleted',
	listener: (codec: TCodec) => void,
): AjCodecCleanup {
	const subscribe = handle[method]
	if (typeof subscribe !== 'function') return (): void => {}
	let token: unknown
	try {
		token = subscribe.call(handle, listener)
	} catch {
		return (): void => {}
	}
	return cleanupToken(token)
}

function subscribeCodecEvent(
	codec: AjBlueprintCodecLike,
	event: string,
	listener: AjCodecEventListener,
): AjCodecCleanup {
	const subscribe = codec.on ?? codec.addListener
	if (typeof subscribe !== 'function') return (): void => {}
	let token: unknown
	try {
		token = subscribe.call(codec, event, listener)
	} catch {
		return (): void => {}
	}
	return cleanupToken(token, codec.removeListener ? () => codec.removeListener?.(event, listener) : undefined)
}

function currentHandle(ops: AjCodecObserverOps): AjBlueprintCodecHandleLike | undefined {
	try {
		return ops.getHandle() ?? undefined
	} catch {
		return undefined
	}
}

function currentCodec(handle: AjBlueprintCodecHandleLike | undefined): AjBlueprintCodecLike | undefined {
	if (!handle || typeof handle.get !== 'function') return undefined
	try {
		return handle.get() ?? undefined
	} catch {
		return undefined
	}
}

export function createLoadSignalCoalescer(): (project: object | null) => boolean {
	let burstOpen = false
	let burstProject: object | null | undefined
	return (project): boolean => {
		const shouldMarkGeneration = !burstOpen || burstProject !== project
		if (!burstOpen) {
			Promise.resolve().then(() => {
				burstOpen = false
				burstProject = undefined
			})
		}
		burstOpen = true
		burstProject = project
		return shouldMarkGeneration
	}
}

/**
 * Connects Spring's load provenance to the actual Animated Java blueprint codec parse.
 * Handle and codec identities are tracked separately so AJ reloads cannot leave stale
 * parsed listeners attached to a deleted codec.
 */
export function installAjCodecObserver(ops: AjCodecObserverOps, onParsed: () => void): AjCodecCleanup {
	let disposed = false
	let observedHandle: AjBlueprintCodecHandleLike | undefined
	let activeCodec: AjBlueprintCodecLike | undefined
	let activeCodecCleanup: AjCodecCleanup = () => {}
	const handleCleanups: AjCodecCleanup[] = []

	const removeCodec = (codec?: AjBlueprintCodecLike): void => {
		if (codec && activeCodec !== codec) return
		activeCodecCleanup()
		activeCodecCleanup = () => {}
		activeCodec = undefined
	}

	const attachCodec = (codec: AjBlueprintCodecLike | null | undefined): void => {
		if (disposed || !codec || activeCodec === codec) return
		removeCodec()
		activeCodec = codec
		activeCodecCleanup = subscribeCodecEvent(codec, 'parsed', () => {
			if (!disposed) onParsed()
		})
	}

	const sync = (): void => {
		if (disposed) return
		const handle = currentHandle(ops)
		if (handle !== observedHandle) {
			for (const cleanup of handleCleanups.splice(0)) cleanup()
			observedHandle = handle
			if (handle) {
				handleCleanups.push(subscribeHandle(handle, 'onCreated', attachCodec))
				handleCleanups.push(subscribeHandle(handle, 'onDeleted', (codec) => removeCodec(codec)))
			}
		}
		const codec = currentCodec(handle)
		if (codec) attachCodec(codec)
		else removeCodec()
	}

	const onPluginLoaded = (): void => { sync() }
	const onPluginUnloaded = (): void => { sync() }
	const pluginCleanups = [
		subscribePluginEvent(ops.onPluginLoaded, ops.offPluginLoaded, onPluginLoaded),
		subscribePluginEvent(ops.onPluginUnloaded, ops.offPluginUnloaded, onPluginUnloaded),
	]
	sync()

	return (): void => {
		if (disposed) return
		disposed = true
		removeCodec()
		for (const cleanup of handleCleanups.splice(0)) cleanup()
		for (const cleanup of pluginCleanups.splice(0)) cleanup()
		observedHandle = undefined
	}
}
