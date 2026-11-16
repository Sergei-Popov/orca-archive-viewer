// The tree's focus ring is for the keyboard. Archive Viewer focuses the tree when an archive
// opens, and the rows' mousedown handler keeps focus on the tree by script, so the browser keeps
// :focus-visible on it through every later mouse click. A pointer press in the tree hides the
// ring (`data-pointer`, see styles.ts) until the next key press in it or until focus leaves it.

/** What `pointerFocus` needs of an element: an HTMLElement in the page, a stand-in in tests. */
export type FocusTarget = Pick<EventTarget, 'addEventListener'> & { dataset: DOMStringMap }

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'])

export function pointerFocus(target: FocusTarget): void {
  target.addEventListener('pointerdown', () => {
    target.dataset.pointer = ''
  })
  target.addEventListener('keydown', (event) => {
    if (!MODIFIERS.has((event as KeyboardEvent).key)) delete target.dataset.pointer
  })
  target.addEventListener('blur', () => {
    delete target.dataset.pointer
  })
}
