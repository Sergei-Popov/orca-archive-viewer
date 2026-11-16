import { assert, test } from 'orca/testing'
import { pointerFocus } from './focus'
import { css } from './styles'

function tree() {
  return Object.assign(new EventTarget(), { dataset: {} as DOMStringMap })
}

const key = (name: string) => Object.assign(new Event('keydown'), { key: name })

test('a pointer press hides the tree focus ring until a key press', () => {
  const el = tree()
  pointerFocus(el)
  assert.equal('pointer' in el.dataset, false)
  el.dispatchEvent(new Event('pointerdown'))
  assert.equal(el.dataset.pointer, '')
  el.dispatchEvent(key('Meta'))
  assert.equal(el.dataset.pointer, '', 'a modifier alone keeps it hidden')
  el.dispatchEvent(key('ArrowDown'))
  assert.equal('pointer' in el.dataset, false)
})

test('the ring shows again once focus leaves the tree', () => {
  const el = tree()
  pointerFocus(el)
  el.dispatchEvent(new Event('pointerdown'))
  el.dispatchEvent(new Event('blur'))
  assert.equal('pointer' in el.dataset, false)
})

test('the stylesheet draws the tree ring only without data-pointer', () => {
  assert.ok(css.includes('.av-scroll:focus-visible:not([data-pointer])'))
  assert.ok(!/\.av-scroll:focus-visible\s*\{/.test(css))
})
