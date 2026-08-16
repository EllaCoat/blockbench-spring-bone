import test from 'node:test'
import assert from 'node:assert/strict'

const {
	createLoadSignalCoalescer,
	installAjCodecObserver,
} = await import('../dist-test/ajCodecObserver.mjs')

class FakeEventTarget {
	constructor() {
		this.listeners = new Map()
	}

	on(event, listener) {
		const listeners = this.listeners.get(event) ?? new Set()
		listeners.add(listener)
		this.listeners.set(event, listeners)
		return () => listeners.delete(listener)
	}

	removeListener(event, listener) {
		this.listeners.get(event)?.delete(listener)
	}

	emit(event, data) {
		for (const listener of [...(this.listeners.get(event) ?? [])]) listener(data)
	}

	listenerCount(event) {
		return this.listeners.get(event)?.size ?? 0
	}
}

class FakeCodec extends FakeEventTarget {}

class FakeCodecHandle {
	constructor(codec = null) {
		this.current = codec
		this.created = new Set()
		this.deleted = new Set()
	}

	get() {
		return this.current
	}

	onCreated(listener) {
		this.created.add(listener)
		return () => this.created.delete(listener)
	}

	onDeleted(listener) {
		this.deleted.add(listener)
		return () => this.deleted.delete(listener)
	}

	create(codec) {
		this.current = codec
		for (const listener of [...this.created]) listener(codec)
	}

	delete(codec = this.current) {
		if (!codec) return
		if (this.current === codec) this.current = null
		for (const listener of [...this.deleted]) listener(codec)
	}
}

function makeHarness(initialCodec = null) {
	const pluginEvents = new FakeEventTarget()
	const handle = new FakeCodecHandle(initialCodec)
	let parsed = 0
	const dispose = installAjCodecObserver({
		getHandle: () => handle,
		onPluginLoaded: (listener) => pluginEvents.on('loaded_plugin', listener),
		onPluginUnloaded: (listener) => pluginEvents.on('unloaded_plugin', listener),
	}, () => { parsed += 1 })
	return { handle, pluginEvents, get parsed() { return parsed }, dispose }
}

test('no parsed event leaves load provenance unverified', () => {
	const codec = new FakeCodec()
	const harness = makeHarness(codec)
	harness.pluginEvents.emit('loaded_plugin')
	assert.equal(harness.parsed, 0)
	harness.dispose()
})

test('parsed event completes load provenance for the current codec', () => {
	const codec = new FakeCodec()
	const harness = makeHarness(codec)
	codec.emit('parsed', { model: {} })
	assert.equal(harness.parsed, 1)
	harness.dispose()
})

test('AJ loaded after Spring is observed without blessing the open project', () => {
	const codec = new FakeCodec()
	const handle = new FakeCodecHandle(codec)
	const pluginEvents = new FakeEventTarget()
	let availableHandle = null
	let parsed = 0
	const dispose = installAjCodecObserver({
		getHandle: () => availableHandle,
		onPluginLoaded: (listener) => pluginEvents.on('loaded_plugin', listener),
	}, () => { parsed += 1 })

	availableHandle = handle
	pluginEvents.emit('loaded_plugin')
	assert.equal(parsed, 0)
	codec.emit('parsed')
	assert.equal(parsed, 1)
	dispose()
})

test('AJ handle replacement and unload detach stale listeners', () => {
	const firstCodec = new FakeCodec()
	const secondCodec = new FakeCodec()
	const firstHandle = new FakeCodecHandle(firstCodec)
	const secondHandle = new FakeCodecHandle(secondCodec)
	const pluginEvents = new FakeEventTarget()
	let availableHandle = firstHandle
	let parsed = 0
	const dispose = installAjCodecObserver({
		getHandle: () => availableHandle,
		onPluginLoaded: (listener) => pluginEvents.on('loaded_plugin', listener),
		onPluginUnloaded: (listener) => pluginEvents.on('unloaded_plugin', listener),
	}, () => { parsed += 1 })

	assert.equal(firstCodec.listenerCount('parsed'), 1)
	availableHandle = secondHandle
	pluginEvents.emit('loaded_plugin')
	assert.equal(firstHandle.created.size, 0)
	assert.equal(firstHandle.deleted.size, 0)
	assert.equal(firstCodec.listenerCount('parsed'), 0)
	assert.equal(secondCodec.listenerCount('parsed'), 1)

	firstCodec.emit('parsed')
	secondCodec.emit('parsed')
	assert.equal(parsed, 1)

	availableHandle = null
	pluginEvents.emit('unloaded_plugin')
	assert.equal(secondHandle.created.size, 0)
	assert.equal(secondHandle.deleted.size, 0)
	assert.equal(secondCodec.listenerCount('parsed'), 0)
	dispose()
})

test('load_project and parsed in one synchronous load mark one generation', async () => {
	const project = {}
	const shouldMark = createLoadSignalCoalescer()
	assert.equal(shouldMark(project), true)
	assert.equal(shouldMark(project), false)

	const nextProject = {}
	assert.equal(shouldMark(nextProject), true)
	await Promise.resolve()
	assert.equal(shouldMark(nextProject), true)
})

test('codec replacement detaches the old parsed listener and follows the new codec', () => {
	const first = new FakeCodec()
	const second = new FakeCodec()
	const harness = makeHarness(first)
	assert.equal(first.listenerCount('parsed'), 1)

	first.emit('parsed')
	harness.handle.create(second)
	assert.equal(first.listenerCount('parsed'), 0)
	assert.equal(second.listenerCount('parsed'), 1)
	first.emit('parsed')
	second.emit('parsed')
	assert.equal(harness.parsed, 2)

	harness.handle.delete(second)
	assert.equal(second.listenerCount('parsed'), 0)
	second.emit('parsed')
	assert.equal(harness.parsed, 2)
	harness.dispose()
})

test('observer dispose removes plugin, handle, and codec listeners', () => {
	const codec = new FakeCodec()
	const harness = makeHarness(codec)
	assert.equal(harness.handle.created.size, 1)
	assert.equal(harness.handle.deleted.size, 1)
	assert.equal(codec.listenerCount('parsed'), 1)

	harness.dispose()
	assert.equal(harness.handle.created.size, 0)
	assert.equal(harness.handle.deleted.size, 0)
	assert.equal(codec.listenerCount('parsed'), 0)
	assert.equal(harness.pluginEvents.listenerCount('loaded_plugin'), 0)
	assert.equal(harness.pluginEvents.listenerCount('unloaded_plugin'), 0)
	codec.emit('parsed')
	assert.equal(harness.parsed, 0)
})
