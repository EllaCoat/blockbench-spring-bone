import test from 'node:test'
import assert from 'node:assert/strict'

const { createExportGate } = await import('../dist-test/exportGate.mjs')

// rescan 呼び出しを記録するだけの stub ops。 onRescan を渡すと rescan の **中で**
// gate の状態を覗ける (= resume の内部順序を固定するために使う)。
function makeOps({ error = null, onRescan = null } = {}) {
	const calls = []
	return {
		calls,
		rescan() {
			calls.push('rescan')
			if (onRescan) onRescan()
			if (error) throw error
		},
	}
}

// console.warn を一時差し替えて記録し、 必ず元へ戻す。
function captureWarnings(fn) {
	const original = console.warn
	const warnings = []
	console.warn = (...args) => { warnings.push(args) }
	try {
		fn()
	} finally {
		console.warn = original
	}
	return warnings
}

// --- 初期状態 ---

test('ExportGate: 初期状態は inactive かつ pending なし', () => {
	const ops = makeOps()
	const gate = createExportGate(ops)
	assert.equal(gate.isExportActive, false)
	assert.equal(gate.hasPendingRescan, false)
	assert.deepEqual(ops.calls, [])
})

// --- suspend / resume ---

test('ExportGate: suspend で active、 resume で inactive に戻る', () => {
	const gate = createExportGate(makeOps())
	gate.suspend()
	assert.equal(gate.isExportActive, true)
	gate.resume()
	assert.equal(gate.isExportActive, false)
})

// counter 化への退行を防ぐ固定。 AJ が onEndRendering を届けられないまま次の
// onBeginRendering を送ってくると suspend が二重に届く (= ajExportBridge の
// 二重 onBeginRendering 経路)。 counter だと resume 1 回では解除されず、
// preview が永久に止まる。
test('ExportGate: suspend を二重に呼んでも resume 1 回で inactive になる', () => {
	const gate = createExportGate(makeOps())
	gate.suspend()
	gate.suspend()
	gate.suspend()
	gate.resume()
	assert.equal(gate.isExportActive, false)
})

test('ExportGate: pending なしの resume は rescan を呼ばない', () => {
	const ops = makeOps()
	const gate = createExportGate(ops)
	gate.suspend()
	gate.resume()
	assert.deepEqual(ops.calls, [])
})

test('ExportGate: 非 active での resume も rescan を呼ばず inactive のまま', () => {
	const ops = makeOps()
	const gate = createExportGate(ops)
	gate.resume()
	assert.equal(gate.isExportActive, false)
	assert.deepEqual(ops.calls, [])
})

// --- deferRescanIfActive ---

test('ExportGate: 非 active の deferRescanIfActive は false を返し pending を立てない', () => {
	const ops = makeOps()
	const gate = createExportGate(ops)
	assert.equal(gate.deferRescanIfActive(), false)
	assert.equal(gate.hasPendingRescan, false)
	assert.deepEqual(ops.calls, [])
})

test('ExportGate: active 中の deferRescanIfActive は true を返し pending を立てる', () => {
	const ops = makeOps()
	const gate = createExportGate(ops)
	gate.suspend()
	assert.equal(gate.deferRescanIfActive(), true)
	assert.equal(gate.hasPendingRescan, true)
	// 予約するだけで、 その場では rescan しない
	assert.deepEqual(ops.calls, [])
})

test('ExportGate: active 中の defer → resume で rescan はちょうど 1 回', () => {
	const ops = makeOps()
	const gate = createExportGate(ops)
	gate.suspend()
	// export 中の複数経路 (= rescanRegistry / onSpringPropertyChange) から何度予約されても
	// 取り戻しは 1 回だけ
	gate.deferRescanIfActive()
	gate.deferRescanIfActive()
	gate.deferRescanIfActive()
	gate.resume()
	assert.deepEqual(ops.calls, ['rescan'])
	assert.equal(gate.hasPendingRescan, false)
	// 続けて resume してももう呼ばれない (= 予約は消費済み)
	gate.resume()
	assert.deepEqual(ops.calls, ['rescan'])
})

// --- resume の内部順序 ---

// **exportActive を先に倒してから rescan する** ことの固定。 逆順だと rescan 側の
// defer guard (= deferRescanIfActive) が再び予約を立て、 永久 pending になる。
test('ExportGate: resume は exportActive を倒してから rescan を呼ぶ', () => {
	let activeInsideRescan = null
	const ops = makeOps({ onRescan: () => { activeInsideRescan = gate.isExportActive } })
	const gate = createExportGate(ops)
	gate.suspend()
	gate.deferRescanIfActive()
	gate.resume()
	assert.equal(activeInsideRescan, false)
})

// 上の順序が守られている帰結 : rescan の中で defer guard を通しても予約が
// 立ち直らない (= index.ts の rescanRegistry が冒頭で必ずこの guard を通る)。
test('ExportGate: rescan の中で deferRescanIfActive を通しても再予約されない', () => {
	let deferred = null
	const ops = makeOps({ onRescan: () => { deferred = gate.deferRescanIfActive() } })
	const gate = createExportGate(ops)
	gate.suspend()
	gate.deferRescanIfActive()
	gate.resume()
	assert.equal(deferred, false)
	assert.equal(gate.hasPendingRescan, false)
	assert.deepEqual(ops.calls, ['rescan'])
})

// --- rescan の失敗 ---

test('ExportGate: rescan が throw しても resume は伝播させず warn に落とす', () => {
	const error = new Error('rescan boom')
	const ops = makeOps({ error })
	const gate = createExportGate(ops)
	gate.suspend()
	gate.deferRescanIfActive()
	const warnings = captureWarnings(() => {
		gate.resume()
	})
	assert.equal(warnings.length, 1)
	assert.equal(warnings[0][1], error)
	// 例外経路でも state は畳まれている
	assert.equal(gate.isExportActive, false)
	// 予約は消費済みのまま (= 再 arm しない)。 次の resume で再試行されない
	assert.equal(gate.hasPendingRescan, false)
	gate.resume()
	assert.deepEqual(ops.calls, ['rescan'])
})

// --- reset ---

test('ExportGate: reset は両 state を落とし rescan を呼ばない', () => {
	const ops = makeOps()
	const gate = createExportGate(ops)
	gate.suspend()
	gate.deferRescanIfActive()
	gate.reset()
	assert.equal(gate.isExportActive, false)
	assert.equal(gate.hasPendingRescan, false)
	assert.deepEqual(ops.calls, [])
	// reset 後の resume も予約が無いので rescan しない
	gate.resume()
	assert.deepEqual(ops.calls, [])
})

test('ExportGate: 初期状態への reset は冪等', () => {
	const ops = makeOps()
	const gate = createExportGate(ops)
	gate.reset()
	gate.reset()
	assert.equal(gate.isExportActive, false)
	assert.equal(gate.hasPendingRescan, false)
	assert.deepEqual(ops.calls, [])
})

// --- instance の独立性 ---

test('ExportGate: 別 instance の state は独立している', () => {
	const opsA = makeOps()
	const opsB = makeOps()
	const gateA = createExportGate(opsA)
	const gateB = createExportGate(opsB)
	gateA.suspend()
	gateA.deferRescanIfActive()
	assert.equal(gateB.isExportActive, false)
	assert.equal(gateB.hasPendingRescan, false)
	gateB.resume()
	assert.deepEqual(opsB.calls, [])
	assert.equal(gateA.isExportActive, true)
	assert.equal(gateA.hasPendingRescan, true)
})
