import test from 'node:test'
import assert from 'node:assert/strict'

const { installAjRegistrar } = await import('../dist-test/ajRegistrar.mjs')

const PLUGIN_ID = 'spring_bone'

// AJ の registry stub。 version / register / unregister をそれぞれ差し替えられる形にして、
// 「旧 version」「register が関数でない」「unregister を持たない」 を再現する。
function makeApi({ version = 1, registerError = null, unregisterError = null, withUnregister = true, register } = {}) {
	const api = { version }
	if (register !== undefined) {
		api.register = register
	} else {
		api.register = (id, hooks) => {
			api.registered.push({ id, hooks })
			if (registerError) throw registerError
		}
	}
	if (withUnregister) {
		api.unregister = (id) => {
			api.unregistered.push(id)
			if (unregisterError) throw unregisterError
		}
	}
	api.registered = []
	api.unregistered = []
	return api
}

// ops 呼び出しを発生順に log へ push する stub。 getApi は呼ばれるたびに読み直す前提なので
// 現在値を返す closure にする (= AJ の後追い load / reload を再現する口)。
function makeOps({ api = null, shutdownError = null } = {}) {
	const log = []
	const listeners = []
	const logs = []
	const warns = []
	let current = api
	return {
		log,
		listeners,
		logs,
		warns,
		setApi(next) { current = next },
		fireLoadedPlugin() { for (const l of [...listeners]) l() },
		ops: {
			getApi: () => current ?? undefined,
			onPluginLoaded(listener) {
				log.push('onPluginLoaded')
				listeners.push(listener)
			},
			offPluginLoaded(listener) {
				log.push('offPluginLoaded')
				const i = listeners.indexOf(listener)
				if (i >= 0) listeners.splice(i, 1)
			},
			shutdownDriver() {
				log.push('shutdownDriver')
				if (shutdownError) throw shutdownError
			},
			log(message) {
				log.push('log')
				logs.push(message)
			},
			warn(message, error) {
				log.push('warn')
				warns.push({ message, error })
			},
		},
	}
}

const DRIVER = { name: 'driver' }

function install(harness, { enabled = true, driver = DRIVER } = {}) {
	return installAjRegistrar({ pluginId: PLUGIN_ID, enabled, driver }, harness.ops)
}

// --- enabled: false ---

test('AjRegistrar: enabled false なら ops を一切呼ばない', () => {
	const h = makeOps({ api: makeApi() })
	const registrar = install(h, { enabled: false })
	assert.deepEqual(h.log, [])
	assert.equal(registrar.registeredApi, null)
	assert.equal(registrar.isRetryAttached, false)
	// dispose も no-op
	registrar.dispose()
	assert.deepEqual(h.log, [])
})

// --- 初回登録 ---

test('AjRegistrar: 初回 sync で driver を identity のまま 1 回 register し log を出す', () => {
	const api = makeApi()
	const h = makeOps({ api })
	const registrar = install(h)
	assert.equal(api.registered.length, 1)
	assert.equal(api.registered[0].id, PLUGIN_ID)
	assert.equal(api.registered[0].hooks, DRIVER)
	assert.deepEqual(h.logs, [`[${PLUGIN_ID}] AnimatedJava export driver registered`])
	assert.equal(registrar.registeredApi, api)
	assert.equal(registrar.isRetryAttached, true)
	// 登録 → listener 購読の順
	assert.deepEqual(h.log, ['log', 'onPluginLoaded'])
})

test('AjRegistrar: offPluginLoaded に渡る listener は onPluginLoaded と同一 identity', () => {
	const attached = []
	const detached = []
	const h = makeOps({ api: makeApi() })
	const baseOn = h.ops.onPluginLoaded
	const baseOff = h.ops.offPluginLoaded
	h.ops.onPluginLoaded = (listener) => { attached.push(listener); baseOn.call(h.ops, listener) }
	h.ops.offPluginLoaded = (listener) => { detached.push(listener); baseOff.call(h.ops, listener) }
	const registrar = install(h)
	registrar.dispose()
	assert.equal(attached.length, 1)
	assert.equal(detached.length, 1)
	assert.equal(detached[0], attached[0])
})

// --- 登録できない形 ---

test('AjRegistrar: API 不在なら no-op だが retry listener は付く', () => {
	const h = makeOps({ api: null })
	const registrar = install(h)
	assert.equal(registrar.registeredApi, null)
	assert.equal(registrar.isRetryAttached, true)
	assert.deepEqual(h.logs, [])
	assert.deepEqual(h.warns, [])
	assert.deepEqual(h.log, ['onPluginLoaded'])
})

test('AjRegistrar: version が 1 以外なら登録しない', () => {
	const api = makeApi({ version: 2 })
	const h = makeOps({ api })
	const registrar = install(h)
	assert.equal(registrar.registeredApi, null)
	assert.deepEqual(api.registered, [])
	assert.equal(registrar.isRetryAttached, true)
})

test('AjRegistrar: version 未定義なら登録しない', () => {
	const api = makeApi()
	// makeApi の default parameter を避けるため、 生成後に落とす
	delete api.version
	const h = makeOps({ api })
	const registrar = install(h)
	assert.equal(registrar.registeredApi, null)
	assert.deepEqual(api.registered, [])
})

test('AjRegistrar: register が関数でなければ登録しない (throw もしない)', () => {
	const api = makeApi({ register: 'nope' })
	const h = makeOps({ api })
	const registrar = install(h)
	assert.equal(registrar.registeredApi, null)
	assert.equal(registrar.isRetryAttached, true)
	assert.deepEqual(h.warns, [])
})

// --- 後追い load / reload ---

test('AjRegistrar: AJ が後から load されたら loaded_plugin で拾う', () => {
	const h = makeOps({ api: null })
	const registrar = install(h)
	assert.equal(registrar.registeredApi, null)

	const api = makeApi()
	h.setApi(api)
	h.fireLoadedPlugin()
	assert.equal(registrar.registeredApi, api)
	assert.equal(api.registered.length, 1)
	assert.deepEqual(h.logs, [`[${PLUGIN_ID}] AnimatedJava export driver registered`])
})

test('AjRegistrar: 同一 API identity なら loaded_plugin が再発火しても再登録しない', () => {
	const api = makeApi()
	const h = makeOps({ api })
	const registrar = install(h)
	h.fireLoadedPlugin()
	h.fireLoadedPlugin()
	h.fireLoadedPlugin()
	assert.equal(api.registered.length, 1)
	assert.equal(h.logs.length, 1)
	assert.equal(registrar.registeredApi, api)
})

// AJ を単独 reload すると renderHooks が新しい object に差し替わる。 参照比較なので
// 「後から load された」 と同じ経路で拾い直せる。 旧 API への unregister は呼ばない
// (= 旧 registry は内部の登録 Map ごと作り直されているため意味が無い)。
test('AjRegistrar: API object が差し替わったら新 API へ登録し、 旧 API を unregister しない', () => {
	const oldApi = makeApi()
	const h = makeOps({ api: oldApi })
	const registrar = install(h)
	assert.equal(registrar.registeredApi, oldApi)

	const newApi = makeApi()
	h.setApi(newApi)
	h.fireLoadedPlugin()
	assert.equal(registrar.registeredApi, newApi)
	assert.equal(newApi.registered.length, 1)
	assert.deepEqual(oldApi.unregistered, [])
	assert.equal(oldApi.registered.length, 1)
	assert.equal(h.logs.length, 2)
})

test('AjRegistrar: reload 後の dispose は新 API だけを unregister する', () => {
	const oldApi = makeApi()
	const h = makeOps({ api: oldApi })
	const registrar = install(h)
	const newApi = makeApi()
	h.setApi(newApi)
	h.fireLoadedPlugin()
	registrar.dispose()
	assert.deepEqual(newApi.unregistered, [PLUGIN_ID])
	assert.deepEqual(oldApi.unregistered, [])
})

// --- register の失敗 ---

// 失敗時に registeredApi を更新しないので、 次の loaded_plugin で同じ API へ再試行できる。
// 更新してしまうと、 id 衝突が解消しても plugin reload まで登録し直せなくなる。
test('AjRegistrar: register が throw したら registeredApi を更新せず warn に落とす', () => {
	const error = new Error('id already taken')
	const api = makeApi({ registerError: error })
	const h = makeOps({ api })
	const registrar = install(h)
	assert.equal(registrar.registeredApi, null)
	assert.equal(h.warns.length, 1)
	assert.equal(h.warns[0].message, `[${PLUGIN_ID}] AnimatedJava export driver registration failed`)
	assert.equal(h.warns[0].error, error)
	assert.deepEqual(h.logs, [])
	// listener は付いているので再試行の口が残る
	assert.equal(registrar.isRetryAttached, true)
})

test('AjRegistrar: register 失敗後の loaded_plugin で同じ API へ再試行する', () => {
	let failing = true
	const api = makeApi()
	const baseRegister = api.register
	api.register = (id, hooks) => {
		if (failing) throw new Error('id already taken')
		baseRegister(id, hooks)
	}
	const h = makeOps({ api })
	const registrar = install(h)
	assert.equal(registrar.registeredApi, null)

	// 衝突が解消してから再発火すると、 同じ API instance へ登録が成立する
	failing = false
	h.fireLoadedPlugin()
	assert.equal(registrar.registeredApi, api)
	assert.deepEqual(api.registered, [{ id: PLUGIN_ID, hooks: DRIVER }])
	assert.deepEqual(h.logs, [`[${PLUGIN_ID}] AnimatedJava export driver registered`])
})

test('AjRegistrar: register 失敗が続くと warn が重複する (= 許容している挙動)', () => {
	const api = makeApi({ registerError: new Error('boom') })
	const h = makeOps({ api })
	install(h)
	h.fireLoadedPlugin()
	h.fireLoadedPlugin()
	assert.equal(h.warns.length, 3)
})

// --- dispose ---

test('AjRegistrar: dispose の順序は detach → shutdownDriver → unregister', () => {
	const api = makeApi()
	const h = makeOps({ api })
	const registrar = install(h)
	h.log.length = 0
	registrar.dispose()
	assert.deepEqual(h.log, ['offPluginLoaded', 'shutdownDriver'])
	// unregister は API 側に記録される (= ops ではないので log には出ない)
	assert.deepEqual(api.unregistered, [PLUGIN_ID])
	assert.equal(registrar.registeredApi, null)
	assert.equal(registrar.isRetryAttached, false)
})

// registeredApi は unregister を呼ぶ **前** に null 化する (= unregister が throw しても
// 登録済み扱いが残らない)。 unregister の中から観測して固定する。
test('AjRegistrar: registeredApi は unregister より前に null 化される', () => {
	const api = makeApi()
	let seen = 'unset'
	const h = makeOps({ api })
	const registrar = install(h)
	api.unregister = () => { seen = registrar.registeredApi }
	registrar.dispose()
	assert.equal(seen, null)
})

test('AjRegistrar: dispose 後は loaded_plugin が届かない (= listener が外れている)', () => {
	const api = makeApi()
	const h = makeOps({ api })
	const registrar = install(h)
	registrar.dispose()
	const newApi = makeApi()
	h.setApi(newApi)
	h.fireLoadedPlugin()
	assert.deepEqual(newApi.registered, [])
	assert.equal(registrar.registeredApi, null)
})

test('AjRegistrar: shutdownDriver が throw しても warn に落として unregister を続行する', () => {
	const error = new Error('shutdown boom')
	const api = makeApi()
	const h = makeOps({ api, shutdownError: error })
	const registrar = install(h)
	registrar.dispose()
	assert.equal(h.warns.length, 1)
	assert.equal(h.warns[0].message, `[${PLUGIN_ID}] AnimatedJava export driver shutdown failed`)
	assert.equal(h.warns[0].error, error)
	assert.deepEqual(api.unregistered, [PLUGIN_ID])
	assert.equal(registrar.registeredApi, null)
})

test('AjRegistrar: unregister が throw しても warn 止まりで伝播しない', () => {
	const error = new Error('unregister boom')
	const api = makeApi({ unregisterError: error })
	const h = makeOps({ api })
	const registrar = install(h)
	registrar.dispose()
	assert.equal(h.warns.length, 1)
	assert.equal(h.warns[0].message, `[${PLUGIN_ID}] AnimatedJava export driver unregistration failed`)
	assert.equal(h.warns[0].error, error)
	assert.equal(registrar.registeredApi, null)
})

test('AjRegistrar: API に unregister が無くても dispose は安全', () => {
	const api = makeApi({ withUnregister: false })
	const h = makeOps({ api })
	const registrar = install(h)
	registrar.dispose()
	assert.deepEqual(h.warns, [])
	assert.equal(registrar.registeredApi, null)
})

test('AjRegistrar: 未登録のまま dispose したら unregister を呼ばず detach だけ行う', () => {
	const h = makeOps({ api: null })
	const registrar = install(h)
	h.log.length = 0
	registrar.dispose()
	assert.deepEqual(h.log, ['offPluginLoaded', 'shutdownDriver'])
	assert.deepEqual(h.warns, [])
	assert.equal(registrar.isRetryAttached, false)
})

// detach と unregister はどちらも 1 回だけ。 shutdownDriver は driver 側が冪等なので
// dispose のたびに呼ばれる (= 現行挙動)。
test('AjRegistrar: 二重 dispose が安全 (detach 1 回 / unregister 1 回)', () => {
	const api = makeApi()
	const h = makeOps({ api })
	const registrar = install(h)
	h.log.length = 0
	registrar.dispose()
	registrar.dispose()
	registrar.dispose()
	assert.equal(h.log.filter((entry) => entry === 'offPluginLoaded').length, 1)
	assert.deepEqual(api.unregistered, [PLUGIN_ID])
	assert.deepEqual(h.warns, [])
})

// --- instance の独立性 ---

test('AjRegistrar: 別 instance の登録状態は独立している', () => {
	const apiA = makeApi()
	const apiB = makeApi()
	const hA = makeOps({ api: apiA })
	const hB = makeOps({ api: apiB })
	const registrarA = install(hA, { driver: { name: 'A' } })
	const registrarB = install(hB, { driver: { name: 'B' } })
	registrarA.dispose()
	assert.equal(registrarA.registeredApi, null)
	assert.equal(registrarB.registeredApi, apiB)
	assert.deepEqual(apiB.unregistered, [])
	assert.equal(apiB.registered[0].hooks.name, 'B')
})
