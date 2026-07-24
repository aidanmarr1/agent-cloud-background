import assert from 'node:assert/strict'
import {
  isFrontendArtifactRequest,
  requestExplicitlyWantsStandaloneHtml,
  shouldDefaultFrontendToNextTsx,
} from '../src/lib/agent/frontendDefaults.ts'

assert.equal(isFrontendArtifactRequest('Build a portfolio website for a ceramic studio'), true)
assert.equal(isFrontendArtifactRequest('Research ceramic studio pricing in Sydney'), false)
assert.equal(isFrontendArtifactRequest('Fill out the tax form on the government website'), false)
assert.equal(isFrontendArtifactRequest('Write a one page report about kilns'), false)
assert.equal(isFrontendArtifactRequest('Make a page for a ceramic studio'), true)
assert.equal(isFrontendArtifactRequest('Create a kiln booking form component'), true)
assert.equal(isFrontendArtifactRequest('Research how Manus AI uses UI and UX design in its consumer product'), false)
assert.equal(isFrontendArtifactRequest('Explain the UI/UX design choices and their impact on engagement'), false)
assert.equal(isFrontendArtifactRequest('Analyze how AI models generate SVG code'), false)
assert.equal(isFrontendArtifactRequest('Review the website design and write a report'), false)
assert.equal(isFrontendArtifactRequest('Design a dashboard for kiln bookings'), true)
assert.equal(isFrontendArtifactRequest('Please design a better user interface for the booking flow'), true)
assert.equal(isFrontendArtifactRequest('Fix the sidebar layout on mobile'), true)
assert.equal(isFrontendArtifactRequest('The sidebar layout needs to be fixed on mobile'), true)
assert.equal(isFrontendArtifactRequest('Research ceramic styles, then build a portfolio website'), true)
assert.equal(isFrontendArtifactRequest('Analyze the competitors and then design a dashboard'), true)

assert.equal(shouldDefaultFrontendToNextTsx('Build a portfolio website for a ceramic studio'), true)
assert.equal(shouldDefaultFrontendToNextTsx('Build a dashboard for kiln bookings'), true)
assert.equal(shouldDefaultFrontendToNextTsx('Build a standalone HTML website for a ceramic studio'), false)
assert.equal(shouldDefaultFrontendToNextTsx('Make index.html for a ceramic studio'), false)
assert.equal(shouldDefaultFrontendToNextTsx('Research how Manus AI uses UI and UX design in its consumer product'), false)

assert.equal(requestExplicitlyWantsStandaloneHtml('Build a single HTML file'), true)
assert.equal(requestExplicitlyWantsStandaloneHtml('Build a Next.js website'), false)

console.log('frontend default smoke checks passed')
