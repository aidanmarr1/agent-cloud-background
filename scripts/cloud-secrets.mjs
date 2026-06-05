import { randomBytes } from 'node:crypto'

const args = process.argv.slice(2)

function randomSecret() {
  return randomBytes(32).toString('base64url')
}

const values = {
  AUTH_SECRET: process.env.AUTH_SECRET?.trim() || randomSecret(),
  AGENT_INTERNAL_HEALTH_SECRET: process.env.AGENT_INTERNAL_HEALTH_SECRET?.trim() || randomSecret(),
}

if (args.includes('--json')) {
  console.log(JSON.stringify(values, null, 2))
} else {
  console.log('# Paste these secret values into Render when the Blueprint prompts for them.')
  console.log('# Keep them private. Use the same AUTH_SECRET anywhere this app reads Auth.js sessions.')
  console.log(`AUTH_SECRET=${values.AUTH_SECRET}`)
  console.log(`AGENT_INTERNAL_HEALTH_SECRET=${values.AGENT_INTERNAL_HEALTH_SECRET}`)
  console.log('')
  console.log('# To run deployed readiness/smoke checks from this shell:')
  console.log(`export AGENT_INTERNAL_HEALTH_SECRET=${values.AGENT_INTERNAL_HEALTH_SECRET}`)
}
