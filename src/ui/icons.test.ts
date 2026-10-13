import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORIES } from '../db/defaults'
import { CATEGORY_ICON_CHOICES, Icon, ICON_LABELS, isIconName } from './Icon'

const drawn = (name: string) => renderToStaticMarkup(createElement(Icon, { name }))

describe('category icons (D-127)', () => {
  it('every choice is drawn, labelled, and looks different from every other one', () => {
    for (const n of CATEGORY_ICON_CHOICES) {
      expect(isIconName(n), n).toBe(true)
      expect(ICON_LABELS[n], n).toBeTruthy()
    }
    const pictures = CATEGORY_ICON_CHOICES.map(drawn)
    expect(new Set(pictures).size).toBe(CATEGORY_ICON_CHOICES.length)
  })

  it('獎金 no longer looks exactly like 禮物', () => {
    expect(drawn('bonus')).not.toBe(drawn('gift'))
  })

  it('every default category uses an icon that exists and can be picked again', () => {
    for (const c of DEFAULT_CATEGORIES) {
      expect(isIconName(c.icon), c.name).toBe(true)
      expect((CATEGORY_ICON_CHOICES as readonly string[]).includes(c.icon), c.name).toBe(true)
    }
  })
})
