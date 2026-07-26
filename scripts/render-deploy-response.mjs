function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function unwrapRenderDeploy(value) {
  if (!isRecord(value)) return null
  return isRecord(value.deploy) ? value.deploy : value
}

export function renderDeployId(value) {
  const deploy = unwrapRenderDeploy(value)
  return typeof deploy?.id === 'string' ? deploy.id.trim() : ''
}

export function renderDeployCommitId(value) {
  const deploy = unwrapRenderDeploy(value)
  const candidates = [
    deploy?.commit?.id,
    deploy?.commit?.commitId,
    deploy?.commitId,
    deploy?.commit_id,
  ]
  const commitId = candidates.find((candidate) => (
    typeof candidate === 'string' && candidate.trim()
  ))
  return commitId ? commitId.trim().toLowerCase() : ''
}

export function renderDeployStatus(value) {
  const deploy = unwrapRenderDeploy(value)
  return typeof deploy?.status === 'string' ? deploy.status.trim().toLowerCase() : ''
}

export function renderDeployTrigger(value) {
  const deploy = unwrapRenderDeploy(value)
  return typeof deploy?.trigger === 'string' ? deploy.trigger.trim().toLowerCase() : ''
}

export function renderDeployCreatedAtMs(value) {
  const deploy = unwrapRenderDeploy(value)
  const createdAt = typeof deploy?.createdAt === 'string' ? Date.parse(deploy.createdAt) : Number.NaN
  return Number.isFinite(createdAt) ? createdAt : Number.NaN
}

export function parseRenderDeployList(value) {
  if (!Array.isArray(value)) {
    throw new Error('Render List Deploys returned a non-array response.')
  }
  return value
    .map((entry) => unwrapRenderDeploy(entry))
    .filter((deploy) => isRecord(deploy) && renderDeployId(deploy))
}

export function selectNewestExactRenderDeploy(deploys, options) {
  const expectedCommitId = String(options.expectedCommitId || '').trim().toLowerCase()
  if (!expectedCommitId) throw new Error('An exact commit is required to reconcile a Render deploy.')

  const failedStatuses = options.failedStatuses || new Set()
  const createdAfterMs = options.createdAfter
    ? Date.parse(String(options.createdAfter))
    : Number.NaN
  const allowedTriggers = options.allowedTriggers?.size
    ? options.allowedTriggers
    : null

  const matches = deploys.filter((deploy) => {
    if (!renderDeployId(deploy)) return false
    if (renderDeployCommitId(deploy) !== expectedCommitId) return false
    if (failedStatuses.has(renderDeployStatus(deploy))) return false
    if (allowedTriggers && !allowedTriggers.has(renderDeployTrigger(deploy))) return false
    if (Number.isFinite(createdAfterMs)) {
      const createdAtMs = renderDeployCreatedAtMs(deploy)
      if (!Number.isFinite(createdAtMs) || createdAtMs < createdAfterMs) return false
    }
    return true
  })

  matches.sort((left, right) => {
    const timeDifference = renderDeployCreatedAtMs(right) - renderDeployCreatedAtMs(left)
    if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference
    return renderDeployId(right).localeCompare(renderDeployId(left))
  })
  return matches[0] || null
}
