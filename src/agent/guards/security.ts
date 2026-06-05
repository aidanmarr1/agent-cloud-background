export const PROMPT_INJECTION_PATTERNS = [
  /(?:what(?:'s|\s+is)|show|reveal|print|output|dump|share|give\s+me|tell\s+me)\s+(?:your|the)\s*system\s*prompt\b/i,
  /reveal\s*(your|the)\s*(instructions|prompt|system)/i,
  /ignore\s*(all\s*)?(previous|prior|above)\s*(instructions|prompts)/i,
  /what\s*are\s*your\s*(instructions|rules|directives|guidelines)/i,
  /repeat\s*(?:everything|all|the\s*text)\s*(?:above|before).{0,80}\b(?:system|developer|hidden|internal|instructions?|prompts?)\b/i,
  /show\s*(me\s*)?(your|the)\s*(prompt|instructions|system)/i,
  /print\s*(your|the)\s*(prompt|instructions|system)/i,
  /output\s*(your|the)\s*(prompt|instructions|system)/i,
  /dump\s*(your|the)\s*(prompt|instructions|system)/i,
  /disregard\s*(all\s*)?(previous|prior|above)/i,
  /forget\s*(all\s*)?(previous|prior|above)\s*(instructions|prompts)/i,
  /you\s*are\s*now\s*(a|in)\s*(new|different|jailbreak)/i,
  /(?:enable|enter|activate|switch\s+to|jailbreak)\s+(?:jailbreak\s+)?(?:mode|you|the\s+assistant|this\s+agent)\b/i,
  /(?:enable|enter|activate|switch\s+to)\s+DAN\s*mode\b|\bDAN\s*mode\b.{0,80}\b(?:ignore|bypass|override|unrestricted|unfiltered)\b/i,
  /act\s*as\s*if\s*you\s*have\s*no\s*(restrictions|rules|guidelines)/i,
  /pretend\s*(you\s*have\s*)?no\s*(rules|restrictions|guidelines)/i,
  /bypass\s*(your|the)\s*(safety|content|restrictions|rules|filters)/i,
  /override\s*(your|the)\s*(safety|content|restrictions|rules|instructions)/i,
  /what\s*(?:was|is)\s*(?:the\s*)?(?:system|developer|hidden|internal)\s*(?:text|message|content|instructions?)\s*(?:above|before|preceding)?/i,
  /echo\s*(?:back\s*)?(?:the\s*)?(?:system|developer|hidden|internal)\s*(?:prompt|message|instructions)/i,
  /(?:what|tell\s*me)\s*(?:the\s*)?rules\s*(?:you|u|ya)\s*(?:follow|have|got|use)/i,
  /(?:what|which)\s*(?:rules|guidelines|constraints)\s*(?:do|did|are)\s*(?:you|u)/i,
  /(?:how|what)\s*(?:do|does|were|are)\s*(?:you|u)\s*(?:work|function|operate|behave)\s*(?:internally)?/i,
  /(?:what|how)\s*(?:were|are)\s*(?:you|u)\s*(?:configured|programmed|set\s*up|designed|built)/i,
  /(?:what|which)\s*(?:were|are|have)\s*(?:you|u)\s*(?:been\s*)?(?:told|given|instructed|directed)/i,
  /(?:pretend|act|imagine|roleplay)\s*(?:you(?:'re|\s*are)\s*)?(?:a\s*)?(?:prompt\s*(?:debugger|inspector|engineer)|unrestricted|unfiltered)/i,
  /(?:describe|explain|list|enumerate)\s+(?:your(?:self)?\s+(?:(?:system|developer|internal)\s+)?)(?:behavior|rules|guidelines|instructions|modes)\b/i,
  /s[\s._-]+y[\s._-]+s[\s._-]+t[\s._-]+e[\s._-]+m[\s._-]+p[\s._-]+r[\s._-]+o[\s._-]+m[\s._-]+p[\s._-]+t/i,
  /\b(?:enable|enter|switch\s+to|activate)\s+(?:sudo|admin)\s*mode\b/i,
  /enter\s*(?:developer|debug|admin|maintenance)\s*mode/i,
  /(?:reset|clear|wipe)\s+your\s+(?:instructions|context|memory|rules)\b|\bnew\s+system\s+(?:instructions|context|memory|rules)\b/i,
  /(?:from\s*now\s*on|henceforth)[^.?!]{0,160}\b(?:ignore|disregard|bypass|override|unrestricted|unfiltered|no\s+(?:rules|restrictions|guidelines|safety)|without\s+(?:rules|restrictions|guidelines|safety))\b/i,
  /\[\s*(?:system|admin|root|developer)\s*\]\s*(?:ignore|disregard|override|bypass|reveal|show|print|output|dump|you\s+are|from\s+now\s+on|new\s+instructions)/i,
  /(?:translate|convert|encode|decode)\s*your\s*(?:system|initial)\s*(?:prompt|instructions|message)/i,
  /(?:base64|hex|rot13|binary|morse)\s*(?:encode|decode|of)\s*your\s*(?:prompt|instructions)/i,
  /(?:what|how)\s*(?:would|could|should)\s*your\s*(?:system|instructions)\s*(?:look|be|read)/i,
]

export function isPromptInjection(text: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some((p) => p.test(text))
}

export const LEAKAGE_FINGERPRINTS = [
  'execution_framework',
  'browser_protocol',
  'specialized_protocols',
  'Do NOT batch multiple tool calls',
  'report-[topic]',
  'analysis-[topic]',
  'Goal-obsessed',
  'CIRCUIT_BREAKER',
  'task decomposition engine',
  // Removed: 'INLINE STATUS NOTES' (no longer in prompt)
  // Removed: 'lucide-react', 'rounded-xl or rounded-2xl', 'Space Grotesk',
  //   'Playfair Display', 'JetBrains Mono', 'shadow-sm or shadow-md',
  //   'border-black/5', 'picsum.photos/seed' — these appear in normal code
  //   output and cause false positive leakage deflection
]

export function checkForLeakage(text: string): boolean {
  let matches = 0
  const lower = text.toLowerCase()
  for (const fp of LEAKAGE_FINGERPRINTS) {
    if (lower.includes(fp.toLowerCase())) {
      matches++
      if (matches >= 2) return true
    }
  }
  return false
}
