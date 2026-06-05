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

assert.equal(shouldDefaultFrontendToNextTsx('Build a portfolio website for a ceramic studio'), true)
assert.equal(shouldDefaultFrontendToNextTsx('Build a dashboard for kiln bookings'), true)
assert.equal(shouldDefaultFrontendToNextTsx('Build a standalone HTML website for a ceramic studio'), false)
assert.equal(shouldDefaultFrontendToNextTsx('Make index.html for a ceramic studio'), false)

assert.equal(requestExplicitlyWantsStandaloneHtml('Build a single HTML file'), true)
assert.equal(requestExplicitlyWantsStandaloneHtml('Build a Next.js website'), false)

console.log('frontend default smoke checks passed')
