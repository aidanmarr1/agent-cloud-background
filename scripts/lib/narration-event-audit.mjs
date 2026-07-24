const HIDDEN_ACTION_TOOLS = new Set(['browser_screenshot', 'browser_resize'])
const INTERNAL_RECOVERY_RE = /^(?:INTERNAL_RECOVERY|Superseded by a newer live instruction)/i

function eventFromRow(row) {
  if (!row) return null
  if (typeof row.event_json === 'string') {
    try {
      return JSON.parse(row.event_json)
    } catch {
      return null
    }
  }
  return row.event || row
}

function eventSeq(row, event, fallback) {
  const value = Number(row?.seq ?? event?.seq)
  return Number.isFinite(value) ? value : fallback
}

function visibleActionLabel(event) {
  const label = event?.args?.action_label
  return typeof label === 'string' && label.trim() ? label.trim() : null
}

function internalRecoveryResult(event) {
  const error = event?.result?.error
  return typeof error === 'string' && INTERNAL_RECOVERY_RE.test(error.trim())
}

function normalizeNarration(text) {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9%$.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function narrationTokens(text) {
  return new Set(normalizeNarration(text).split(' ').filter(token => token.length > 2))
}

function narrationSimilarity(left, right) {
  const leftTokens = narrationTokens(left)
  const rightTokens = narrationTokens(right)
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return normalizeNarration(left) === normalizeNarration(right) ? 1 : 0
  }
  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length
  return intersection / Math.max(1, Math.min(leftTokens.size, rightTokens.size))
}

function isDuplicateNarration(text, acceptedNarrations) {
  const normalized = normalizeNarration(text)
  if (!normalized) return null
  for (const prior of acceptedNarrations.slice(-8)) {
    if (normalized === prior.normalized || narrationSimilarity(text, prior.text) >= 0.78) {
      return prior
    }
  }
  return null
}

function compactText(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300)
}

function successfulStepAdvance(event) {
  return event?.type === 'step_advance' && event.status !== 'incomplete'
}

/**
 * Audits the durable SSE projection rather than internal model-loop state.
 * A visible accepted action is a unique labelled tool_start with a matching
 * non-recovery tool_result. Narration is a text run after accepted results and
 * before the next accepted tool_start, which proves text and action shared the
 * ordinary action turn instead of a narration-only gate. The sole exception is
 * a final synthesis followed by durable proof that the persisted plan completed
 * successfully and the run ended in done without an error.
 */
export function auditPersistedNarrationCadence(rows, options = {}) {
  const minGap = options.minGap ?? 3
  const maxGap = options.maxGap ?? 4
  const parsed = rows
    .map((row, index) => {
      const event = eventFromRow(row)
      return event ? { row, event, seq: eventSeq(row, event, index + 1) } : null
    })
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq)

  const startsById = new Map()
  const acceptedIds = new Set()
  for (const entry of parsed) {
    const { event, seq } = entry
    if (event.type === 'tool_start' && event.id && !HIDDEN_ACTION_TOOLS.has(event.name) && visibleActionLabel(event)) {
      if (!startsById.has(event.id)) startsById.set(event.id, { ...entry, startSeq: seq })
    }
    if (event.type === 'tool_result' && event.id && !internalRecoveryResult(event)) {
      acceptedIds.add(event.id)
    }
  }

  const acceptedActions = []
  const acceptedResultOrdinalBySeq = new Map()
  const acceptedStartOrdinalBySeq = new Map()
  const seenAcceptedStarts = new Set()
  const seenAcceptedResults = new Set()
  for (const entry of parsed) {
    const { event, seq } = entry
    if (event.type === 'tool_start' && acceptedIds.has(event.id) && startsById.has(event.id) && !seenAcceptedStarts.has(event.id)) {
      seenAcceptedStarts.add(event.id)
      acceptedStartOrdinalBySeq.set(seq, acceptedActions.length + 1)
      acceptedActions.push({
        id: event.id,
        name: event.name,
        label: visibleActionLabel(event),
        startSeq: seq,
        resultSeq: null,
      })
    }
    if (event.type === 'tool_result' && acceptedIds.has(event.id) && !seenAcceptedResults.has(event.id)) {
      seenAcceptedResults.add(event.id)
      const action = acceptedActions.find(candidate => candidate.id === event.id)
      if (action) {
        action.resultSeq = seq
        acceptedResultOrdinalBySeq.set(seq, acceptedActions.indexOf(action) + 1)
      }
    }
  }

  const acceptedNarrations = []
  const narrationAttempts = []
  const failures = []
  let completedActions = 0
  let acceptedNarrationFrontier = 0
  let textRun = null
  let terminalSeq = null

  const finishTextRun = (nextAcceptedAction = null) => {
    if (!textRun) return
    const text = compactText(textRun.parts.join(''))
    const gap = textRun.completedActionsBefore - acceptedNarrationFrontier
    if (text && gap >= minGap) {
      const duplicateOf = isDuplicateNarration(text, acceptedNarrations)
      const attempt = {
        text,
        startSeq: textRun.startSeq,
        endSeq: textRun.endSeq,
        gap,
        status: duplicateOf ? 'duplicate' : gap <= maxGap ? 'accepted' : 'late',
        duplicateOf: duplicateOf?.text ?? null,
        continuesWithTool: Boolean(nextAcceptedAction),
        nextToolStartSeq: nextAcceptedAction?.startSeq ?? null,
        nextToolName: nextAcceptedAction?.name ?? null,
      }
      narrationAttempts.push(attempt)
      if (!duplicateOf) {
        acceptedNarrations.push({
          ...attempt,
          normalized: normalizeNarration(text),
        })
        acceptedNarrationFrontier = textRun.completedActionsBefore
      }
    }
    textRun = null
  }

  for (const entry of parsed) {
    const { event, seq } = entry
    if (event.type === 'tool_result' && acceptedResultOrdinalBySeq.has(seq)) {
      completedActions = Math.max(completedActions, acceptedResultOrdinalBySeq.get(seq))
    }

    if (event.type === 'progress_update' && typeof event.content === 'string' && event.content.trim()) {
      finishTextRun(null)
      const text = compactText(event.content)
      const placedActionIndex = typeof event.afterToolId === 'string'
        ? acceptedActions.findIndex(action => action.id === event.afterToolId)
        : -1
      const narrationFrontier = placedActionIndex >= 0
        ? placedActionIndex + 1
        : completedActions
      const gap = narrationFrontier - acceptedNarrationFrontier
      if (text && gap >= minGap) {
        const duplicateOf = isDuplicateNarration(text, acceptedNarrations)
        const nextAcceptedAction = acceptedActions[narrationFrontier] || null
        const attempt = {
          text,
          startSeq: seq,
          endSeq: seq,
          gap,
          status: duplicateOf ? 'duplicate' : gap <= maxGap ? 'accepted' : 'late',
          duplicateOf: duplicateOf?.text ?? null,
          continuesWithTool: Boolean(nextAcceptedAction),
          nextToolStartSeq: nextAcceptedAction?.startSeq ?? null,
          nextToolName: nextAcceptedAction?.name ?? null,
          sourceType: 'progress_update',
        }
        narrationAttempts.push(attempt)
        if (!duplicateOf) {
          acceptedNarrations.push({
            ...attempt,
            normalized: normalizeNarration(text),
          })
          acceptedNarrationFrontier = narrationFrontier
        }
      }
      continue
    }

    if (event.type === 'text_delta' && typeof event.content === 'string' && event.content.trim()) {
      if (!textRun) {
        textRun = { startSeq: seq, endSeq: seq, completedActionsBefore: completedActions, parts: [] }
      }
      textRun.endSeq = seq
      textRun.parts.push(event.content)
      continue
    }

    if (event.type === 'tool_start' && acceptedStartOrdinalBySeq.has(seq)) {
      const action = acceptedActions[acceptedStartOrdinalBySeq.get(seq) - 1]
      finishTextRun(action)
      continue
    }

    if (event.type === 'step_advance' || event.type === 'plan' || event.type === 'done' || event.type === 'error') {
      finishTextRun(null)
    }
    if (event.type === 'done' || event.type === 'error') terminalSeq = seq
  }
  finishTextRun(null)

  // A final answer naturally has no following tool. Count it as the cadence
  // update only when the durable event stream proves it was terminal
  // synthesis, rather than a narration-only turn that stopped useful work.
  const persistedPlans = parsed.filter(({ event }) => (
    event.type === 'plan' && Array.isArray(event.items) && event.items.length > 0
  ))
  const persistedPlan = persistedPlans.at(-1) || null
  const planAdvances = persistedPlan
    ? parsed.filter(({ event, seq }) => event.type === 'step_advance' && seq > persistedPlan.seq)
    : []
  const finalPlanAdvance = planAdvances.at(-1) || null
  const planCompletedSuccessfully = Boolean(
    persistedPlan &&
    planAdvances.length === persistedPlan.event.items.length &&
    planAdvances.every(({ event }) => successfulStepAdvance(event)),
  )
  const doneEvents = parsed.filter(({ event }) => event.type === 'done')
  const errorEvents = parsed.filter(({ event }) => event.type === 'error')
  const finalDone = doneEvents.at(-1) || null
  const lastSubstantiveText = parsed.findLast(({ event }) => (
    event.type === 'text_delta' && typeof event.content === 'string' && event.content.trim()
  )) || null

  for (const narration of acceptedNarrations) {
    const acceptedActionAfterNarration = acceptedActions.some(action => action.startSeq > narration.endSeq)
    const verifiedTerminalSynthesis = narration.sourceType === 'progress_update'
      ? Boolean(
          !narration.continuesWithTool &&
          narration.gap >= minGap &&
          narration.gap <= maxGap &&
          persistedPlan &&
          planCompletedSuccessfully &&
          finalPlanAdvance &&
          finalDone &&
          finalDone.seq > narration.endSeq &&
          errorEvents.length === 0
        )
      : Boolean(
          !narration.continuesWithTool &&
          narration.gap >= minGap &&
          narration.gap <= maxGap &&
          persistedPlan &&
          narration.startSeq > persistedPlan.seq &&
          lastSubstantiveText?.seq === narration.endSeq &&
          !acceptedActionAfterNarration &&
          planCompletedSuccessfully &&
          finalPlanAdvance &&
          finalPlanAdvance.seq > narration.endSeq &&
          finalDone &&
          finalDone.seq > finalPlanAdvance.seq &&
          errorEvents.length === 0
        )
    narration.verifiedTerminalSynthesis = verifiedTerminalSynthesis
    const attempt = narrationAttempts.find(candidate => (
      candidate.startSeq === narration.startSeq && candidate.endSeq === narration.endSeq
    ))
    if (attempt) attempt.verifiedTerminalSynthesis = verifiedTerminalSynthesis
  }

  const duplicateAttempts = narrationAttempts.filter(attempt => attempt.status === 'duplicate')
  const lateNarrations = acceptedNarrations.filter(narration => narration.gap > maxGap)
  const narrationOnlyTurns = acceptedNarrations.filter(narration => (
    !narration.continuesWithTool && !narration.verifiedTerminalSynthesis
  ))

  for (const narration of lateNarrations) {
    failures.push(`Narration at seq ${narration.startSeq} arrived after ${narration.gap} accepted actions; maximum is ${maxGap}.`)
  }
  for (const narration of narrationOnlyTurns) {
    failures.push(`Narration at seq ${narration.startSeq} did not continue into an accepted tool start in the same action turn or a verified terminal synthesis.`)
  }
  for (const duplicate of duplicateAttempts) {
    failures.push(`Narration at seq ${duplicate.startSeq} repeats recent narration: "${duplicate.text}".`)
  }

  let frontier = 0
  for (const narration of acceptedNarrations) {
    const actionAtRetry = acceptedActions[frontier + maxGap]
    if (narration.gap > minGap && !actionAtRetry && !narration.verifiedTerminalSynthesis) {
      failures.push(`Narration retry at seq ${narration.startSeq} has no persisted action-${maxGap} start proving cadence stayed non-blocking.`)
    }
    frontier += narration.gap
  }

  const lastAcceptedFrontier = acceptedNarrations.reduce((sum, narration) => sum + narration.gap, 0)
  const openGap = acceptedActions.filter(action => action.resultSeq !== null).length - lastAcceptedFrontier
  if (openGap >= maxGap) {
    const nextAction = acceptedActions[lastAcceptedFrontier + maxGap]
    const retryAttempt = narrationAttempts.find(attempt => (
      attempt.startSeq > (acceptedActions[lastAcceptedFrontier + minGap - 1]?.resultSeq ?? -1) &&
      attempt.gap >= minGap
    ))
    if (!retryAttempt && !nextAction && terminalSeq !== null) {
      failures.push(`Task terminated at seq ${terminalSeq} after ${openGap} accepted actions without narration or a non-blocking retry action.`)
    }
  }

  return {
    ok: failures.length === 0,
    cadenceOk: lateNarrations.length === 0,
    toolProgressOk: narrationOnlyTurns.length === 0 && !failures.some(message => message.includes('non-blocking')),
    uniqueOk: duplicateAttempts.length === 0,
    minGap,
    maxGap,
    acceptedActionCount: acceptedActions.length,
    acceptedActions,
    acceptedNarrationCount: acceptedNarrations.length,
    acceptedNarrations: acceptedNarrations.map(({ normalized: _normalized, ...narration }) => narration),
    narrationAttempts,
    duplicateAttemptCount: duplicateAttempts.length,
    openGap,
    failures,
  }
}
