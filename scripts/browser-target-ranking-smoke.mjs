import assert from 'node:assert/strict'
import { rankBrowserTargets } from '../src/lib/browserIntelligence.ts'

const productElements = [
  { index: 1, role: 'link', label: 'Store', primary: 'text=Store' },
  { index: 2, role: 'radio', label: '256GB', primary: 'text=256GB', selected: false },
  { index: 3, role: 'radio', label: '512GB', primary: 'text=512GB', selected: false },
  { index: 4, role: 'radio', label: 'Silver', primary: 'text=Silver', selected: false },
  { index: 5, role: 'radio', label: 'Black', primary: 'text=Black', selected: false },
  { index: 6, role: 'button', label: 'Add to Bag', primary: 'text=Add to Bag' },
  { index: 7, role: 'button', label: 'Unavailable', primary: 'text=Unavailable', unavailable: true },
]

const productHints = rankBrowserTargets('Add an iPhone 17 256GB silver to cart', productElements, { limit: 5 })
const productTop = productHints.slice(0, 4).map(hint => hint.index)
assert.equal(productTop.includes(2), true, '256GB option should rank near the top')
assert.equal(productTop.includes(4), true, 'Silver option should rank near the top')
assert.equal(productTop.includes(6), true, 'Add to Bag should rank near the top')
assert.equal(productTop.includes(1), false, 'Unrelated Store nav should not outrank product controls')
assert.equal(productHints.find(hint => hint.index === 7), undefined, 'Unavailable controls should be filtered or heavily penalized')

const selectedElements = [
  { index: 1, role: 'radio', label: '256GB', primary: 'text=256GB', selected: true },
  { index: 2, role: 'button', label: 'Continue', primary: 'text=Continue' },
]
const selectedHints = rankBrowserTargets('256GB is selected continue', selectedElements, { limit: 2 })
assert.equal(selectedHints[0].index, 1, 'Directly requested selected option should remain useful as completion signal')
assert.equal(selectedHints[0].reason.includes('already selected'), true)

const formElements = [
  { index: 1, role: 'text-input', label: 'Email address', primary: '#email' },
  { index: 2, role: 'text-input', label: 'Postcode', primary: '#postcode' },
  { index: 3, role: 'button', label: 'Submit', primary: 'text=Submit' },
  { index: 4, role: 'link', label: 'Privacy policy', primary: 'text=Privacy policy' },
]
const formHints = rankBrowserTargets('Fill email and postcode then submit', formElements, { limit: 4 })
assert.equal(formHints[0].recommendedTool, 'browser_type')
assert.equal(new Set(formHints.slice(0, 3).map(h => h.index)).has(3), true, 'Submit should rank for form completion')

console.log('browser target ranking smoke checks passed')
