import { explicitlyRequestsInlineAnswer, taskDefaultsToMarkdownDeliverable } from '@/lib/agent/taskConstraints'

function savedArtifactRequestedByFinalStep(text: string): boolean {
  const cleaned = text
    .replace(/\b(?:no|without)\s+(?:a\s+|an\s+)?(?:file|document|pdf|markdown|docx?|slides?|presentation|deck)\b/gi, ' ')
    .replace(/\b(?:don'?t|do\s+not|never)\s+(?:create|make|save|export|generate|write|return|produce)\s+(?:a\s+|an\s+)?(?:file|document|pdf|markdown|docx?|slides?|presentation|deck)\b/gi, ' ')
  const declinesSavedArtifact = explicitlyRequestsInlineAnswer(text)
  const positiveArtifact = /\b(?:pdf|\.md|markdown\s+file|md\s+file|docx?|pptx|xlsx)\b/i.test(cleaned) ||
    /\b(?:save|create|write|export|make|generate|deliver|return|produce)\b.{0,80}\b(?:file|pdf|markdown|document|slides?|presentation|deck|deliverable)\b/i.test(cleaned) ||
    taskDefaultsToMarkdownDeliverable(text)
  return positiveArtifact && !declinesSavedArtifact
}

function finalStepWantsInlineAnswer(step: string, scope?: string): boolean {
  const text = `${step || ''} ${scope || ''}`
  if (savedArtifactRequestedByFinalStep(text)) return false
  return explicitlyRequestsInlineAnswer(text) ||
    /\b(?:answer|respond|reply|summary|summarize|summarise|explain)\b/i.test(text)
}

export function buildStepMessage(planItems: string[], currentIdx: number, extra?: string, stepFindings?: Map<number, string>, complexity: number = 2, strategy: string = 'research', scope?: string): string {
  const progress = planItems
    .map((item, i) => {
      if (i < currentIdx) return `  [DONE] ${i + 1}. ${item}`
      if (i === currentIdx) return `→ [NOW]  ${i + 1}. ${item}`
      return `  [    ] ${i + 1}. ${item}`
    })
    .join('\n')

  // Compact findings summary — only include if we have findings
  let findingsSummary = ''
  if (stepFindings && stepFindings.size > 0) {
    const entries: string[] = []
    for (const [idx, finding] of stepFindings.entries()) {
      if (idx < currentIdx && finding) {
        // Truncate long findings to keep context lean
        const truncated = finding.length > 200 ? finding.slice(0, 200) + '...' : finding
        // Unresolved findings get a visible warning marker so the model cannot
        // miss that the prior step did not actually complete its goal.
        const prefix = finding.startsWith('[INCOMPLETE]') || finding.startsWith('[BLOCKED]') ? '⚠ ' : '- '
        entries.push(`${prefix}Step ${idx + 1}: ${truncated}`)
      }
    }
    if (entries.length > 0) {
      findingsSummary = `\nFINDINGS:\n${entries.join('\n')}`
    }
  }

  const isLastStep = currentIdx === planItems.length - 1
  const inlineFinalAnswer = isLastStep && finalStepWantsInlineAnswer(planItems[currentIdx] || '', scope)
  const phaseBoundary = currentIdx > 0
    ? isLastStep
      ? inlineFinalAnswer
        ? `\nFINAL PHASE SWITCH: Previous research/build/browser steps are closed. Start Step ${currentIdx + 1}'s final answer now; do not continue Step ${currentIdx}'s research/browsing unless this final step explicitly needs a missing source.`
        : `\nFINAL PHASE SWITCH: Previous research/build/browser steps are closed. Start Step ${currentIdx + 1}'s deliverable now; do not continue Step ${currentIdx}'s research/browsing unless this final step explicitly needs a missing source.`
      : `\nPHASE SWITCH: Previous steps are closed. Next tool call must start Step ${currentIdx + 1}, not continue Step ${currentIdx}.`
    : ''

  let instruction: string
  if (isLastStep) {
    // Phase 10 Fix GGG: branch deliverable instruction by task strategy. A hard-coded
    // long research report instruction is wrong for action tasks — it produces
    // hallucinated "guides" when the actual actions failed. Each branch tells the model
    // what the right deliverable looks like for THIS task type.
    if (strategy === 'browse') {
      // Action tasks: deliverable is the actions being COMPLETED, not a written report.
      // The model must verify what actually happened and report honestly — even if that
      // means admitting failure. NEVER write a "guide" for an action task.
      const priorFindings = stepFindings ? Array.from(stepFindings.values()).join(' ') : ''
      const hasIncompleteSteps = priorFindings.includes('[INCOMPLETE]') || priorFindings.includes('[BLOCKED]')
      instruction = `FINAL STEP — verify action and report HONESTLY.
- Verify current state first with screenshot/content/URL.
- If succeeded, write a short .md report (100-300 words) with exact actions and proof.
- If failed/partial, write a short failure report naming blocker, page state, and attempts. DO NOT write a guide, pretend success, include "What I Was Asked To Do", or use placeholder data.${hasIncompleteSteps ? `
- ⚠ AT LEAST ONE PRIOR STEP DID NOT COMPLETE (see ⚠ markers in FINDINGS above). Your report MUST acknowledge this. Do NOT pretend those steps succeeded.` : ''}
- The action is the deliverable; the .md only records what happened.`
    } else if (strategy === 'build' || strategy === 'code') {
      instruction = `FINAL STEP — finalize the artifact.
- Ensure required files exist, run, match the request, and pass edge-case checks.
- Websites/apps default to Next.js + TSX: app/page.tsx, app/layout.tsx importing './globals.css', app/globals.css, and components/*.tsx. Use standalone index.html only when explicitly requested.
- Inspect the local preview with browser_screenshot/browser_scroll at the existing viewport. Fix build errors, blank/unstyled/default-serif/raw-HTML/overlap issues before delivery.
- Report what was built and how to use it.`
    } else if (strategy === 'creative') {
      instruction = `FINAL STEP — produce the creative deliverable.
- Final pass for quality, style, and originality.
- Deliver the prose in a single .md file. If the user requested PDF, export the completed source after the .md exists.`
    } else if (inlineFinalAnswer) {
      instruction = `FINAL STEP — answer directly in chat now.
- Use prior findings in context and write the requested answer/report directly to the user.
- Do not create, save, export, mention, or attach a file unless this final step explicitly requests one.
- Start with the substantive answer, not a planning sentence, status update, or "I will/let me" preface.
- Match requested depth and format. Use natural topic-specific headings when useful, and include citations only when requested or needed by the evidence.`
    } else {
      // 'research', 'general', 'analysis' with an explicit saved artifact request
      instruction = `FINAL STEP — create the deliverable file now.
- Start synthesis now; first substantive action must produce, inspect, or export the deliverable and must not continue prior research.
- Use prior findings in context. Search/browse only if this final step explicitly names a critical missing source.
- Match requested depth/complexity. No outlines, bullet-only sections, or placeholders. Back claims with researched evidence.
- For report-style research deliverables, use a clean Markdown report shape: # specific title, optional compact metadata, ## Executive Summary, numbered thematic sections, ## Conclusion, then ## References with numbered source entries and inline [n] citations.
- Create exactly ONE deliverable file.`
    }
  } else {
    const stepText = planItems[currentIdx]?.toLowerCase() || ''
    const isBuildStrategy = strategy === 'build' || strategy === 'code'
    const looksLikeBuildStep = /\b(build|create|code|implement|develop|design|write|draft|style|css|html|assemble|layout|page|component|file)\b/.test(stepText)
    const explicitlyResearch = /\b(research|gather|find|search|source|collect|asset|image|reference|investigate)\b/.test(stepText)
    const looksLikeWebsitePreviewStep = /\b(boot|run|start|open|launch|serve|local|localhost|server|preview|browser|visual|screenshot|responsive|mobile|desktop)\b/.test(stepText) &&
      /\b(preview|server|localhost|browser|responsive|visual|screenshot|mobile|desktop|local)\b/.test(stepText)

    if (strategy === 'browse') {
      instruction = `Browser action step. PRIORITY: use browser tools to complete ONLY this phase of the live page flow.
- For setup/navigation/dismissal, advance once the requested page is loaded and usable; do not start later search/form/submit/verify work.
- If this step names items/options/fields, complete only those before advancing.
- Do not research, write a guide, or report failure while actionable controls remain.`
    } else if (isBuildStrategy && looksLikeWebsitePreviewStep) {
      instruction = `Website verification step. Inspect the existing local preview with browser_screenshot/browser_scroll; use read_file/edit_file only for targeted fixes. Create initial files only if genuinely missing. Do not treat auto-opened preview as already checked. Do not change the viewport.`
    } else if (isBuildStrategy && looksLikeBuildStep && !explicitlyResearch) {
      instruction = `Build this step directly with create_file, append_file, edit_file, read_file, export_pdf, or preview tools. Website/app builds default to Next.js + TSX; standalone index.html only if requested. Create layout, page, globals, and components before advancing; app/layout.tsx must import './globals.css'. Do not scatter first-time file creation into later phases. Backend opens local previews after required files exist; inspect before final delivery without changing viewport. Do NOT browse generic design/templates. After file tools start, keep calling tools or report a concrete defect/blocker.`
    } else if (isBuildStrategy) {
      instruction = `Do only the specific asset/source gathering this build step requires. Prefer image_search for requested images/assets. Do NOT browse generic design best-practice articles, inspiration galleries, or template roundups unless the user explicitly asked for that research. Advance once the needed facts/assets are gathered.`
    } else {
      instruction = `Research this step with the fewest strong source actions that satisfy it. Use web_search to discover candidates, then read/extract the strongest source pages before searching more. Extract dates, numbers, claims, technical details, caveats, and contradictions. For comparisons, cover each named entity before synthesizing. Report key findings in response text. Notes (.md) only AFTER real research.`
    }
  }

  // FOCUS / AVOID block: only injected when the planner returned an explicit
  // per-step scope. This is the constraint that keeps research from bleeding
  // across steps. When undefined (legacy plans), the block is omitted entirely
  // and behaviour is identical to the pre-scope version.
  const focusBlock = scope
    ? strategy === 'browse'
      ? `\nFOCUS: ${scope}\nAVOID: doing later plan steps inside this browser phase. Stay strictly within FOCUS.`
      : `\nFOCUS: ${scope}\nAVOID: continuing research from prior steps. Stay strictly within FOCUS.`
    : ''

  const modeBlock = (() => {
    switch (strategy) {
    case 'browse':
      return '\nMODE: browser action. Complete the live page flow with browser tools; do not turn it into research or a guide.'
    case 'build':
    case 'code':
      return '\nMODE: build. Make concrete file progress, then verify the running result before delivery.'
    case 'creative':
      return '\nMODE: writing. Save substantial output to files instead of keeping long drafts only in chat.'
    case 'analysis':
      return '\nMODE: analysis. Compare evidence and produce the requested judgment without unnecessary browsing loops.'
    case 'research':
      return '\nMODE: research. Use diverse sources, capture useful findings, and avoid repeating the same source pattern.'
    default:
      return '\nMODE: task. Use the tools needed for this step and stay aligned with the plan.'
    }
  })()

  const toolCallContract = `\nTOOL CALL CONTRACT:
- Include plan_step_index: ${currentIdx + 1}. To work on another step, emit <next_step/> first with no tool call.
- Include action_label: a visible action pill, 2-12 words, task-specific, starts with a capital letter, does not end with a period, no first person, no tool names, no raw JSON, no generic text.`

  return `PLAN PROGRESS:\n${progress}${findingsSummary}${phaseBoundary}\nStep ${currentIdx + 1}/${planItems.length}: "${planItems[currentIdx]}"${focusBlock}${modeBlock}\n${instruction}${toolCallContract}${extra ? '\n' + extra : ''}`
}
