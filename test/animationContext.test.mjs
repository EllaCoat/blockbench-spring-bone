import test from 'node:test'
import assert from 'node:assert/strict'

const { makeExportAnimationContext } = await import('../dist-test/animationContext.mjs')

// --- makeExportAnimationContext: 引数の素通し ---

test('makeExportAnimationContext: animation は identity のまま context に載る', () => {
	const animation = { name: 'walk' }
	const excluded = new Set(['uuid-a'])
	const context = makeExportAnimationContext(animation, excluded)
	assert.equal(context.animation, animation)
})

test('makeExportAnimationContext: animationStack は長さ 1 で [0] が animation と同一', () => {
	const animation = { name: 'walk' }
	const context = makeExportAnimationContext(animation, new Set())
	assert.equal(context.animationStack.length, 1)
	assert.equal(context.animationStack[0], animation)
})

// excludedNodeUuids は previewOps.resolveConfigs が identity で読む前提なので、
// コピーせず **同じ Set instance** を通すことを固定する (= 後から AJ 側が同じ
// instance を書き換えた場合も含めて挙動が一致する)。
test('makeExportAnimationContext: excludedNodeUuids は同一 Set instance が通る', () => {
	const excluded = new Set(['uuid-a', 'uuid-b'])
	const context = makeExportAnimationContext({}, excluded)
	assert.equal(context.excludedNodeUuids, excluded)
})

test('makeExportAnimationContext: 空の excludedNodeUuids も同一 instance のまま通る', () => {
	const excluded = new Set()
	const context = makeExportAnimationContext({}, excluded)
	assert.equal(context.excludedNodeUuids, excluded)
	assert.equal(context.excludedNodeUuids.size, 0)
})

// --- makeExportAnimationContext: animation の型を問わない ---

// AJ が渡してくる animation の中身は解釈しない (= 判定も正規化もしない) 契約。
// null / primitive でも加工せずそのまま載せる。
test('makeExportAnimationContext: animation が null でも加工せず素通しする', () => {
	const context = makeExportAnimationContext(null, new Set())
	assert.equal(context.animation, null)
	assert.deepEqual(context.animationStack, [null])
})

test('makeExportAnimationContext: animation が primitive でも加工せず素通しする', () => {
	for (const animation of ['walk', 0, 42, false, undefined]) {
		const context = makeExportAnimationContext(animation, new Set())
		assert.equal(context.animation, animation)
		assert.equal(context.animationStack.length, 1)
		assert.equal(context.animationStack[0], animation)
	}
})

test('makeExportAnimationContext: 任意 object の中身に触らない (= 変異させない)', () => {
	const animation = { name: 'walk', length: 1.5, nested: { a: 1 } }
	const before = JSON.parse(JSON.stringify(animation))
	makeExportAnimationContext(animation, new Set())
	assert.deepEqual(animation, before)
})

// --- makeExportAnimationContext: 呼び出しごとの独立性 ---

// ensurePreviewSession は animationStack を identity 比較して session の張り直しを
// 判定する。 stack を使い回すと同一判定になって挙動が変わるため、 呼び出しごとに
// 新しい配列を返す現行挙動を固定する。
test('makeExportAnimationContext: 呼び出しごとに新しい stack 配列を返す', () => {
	const animation = { name: 'walk' }
	const excluded = new Set()
	const first = makeExportAnimationContext(animation, excluded)
	const second = makeExportAnimationContext(animation, excluded)
	assert.notEqual(first.animationStack, second.animationStack)
	assert.equal(first.animationStack[0], second.animationStack[0])
	assert.notEqual(first, second)
})
