import { TIER_TIMEOUTS } from '@/lib/agent/config'

export interface TierTimeouts {
  iterationTimeoutMs: number
  inactivityTimeoutMs: number
  contentOnlyTimeoutMs: number | null
  contentOnlyMinChars: number
  checkIntervalMs: number
}

export function getTierTimeouts(buildTask: boolean): TierTimeouts {
  const tier = buildTask ? TIER_TIMEOUTS.build : TIER_TIMEOUTS.research
  return {
    iterationTimeoutMs: TIER_TIMEOUTS.iterationTimeoutMs,
    inactivityTimeoutMs: TIER_TIMEOUTS.inactivityTimeoutMs,
    contentOnlyTimeoutMs: tier.contentOnlyTimeoutMs,
    contentOnlyMinChars: tier.contentOnlyMinChars,
    checkIntervalMs: TIER_TIMEOUTS.checkIntervalMs,
  }
}
