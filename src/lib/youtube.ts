import { guardedFetch, validateHttpUrl, type GuardedFetchInit } from './ssrf'

export interface YouTubeTranscriptResult {
  videoId: string
  title: string
  channel: string
  transcript: string
  duration: string
}

const MAX_REDIRECTS = 5
const MAX_WATCH_PAGE_BYTES = 3 * 1024 * 1024
const MAX_CAPTION_BYTES = 2 * 1024 * 1024

/**
 * fetch wrapper that follows redirects manually and re-validates each hop
 * against the SSRF rules. Default fetch redirect handling does NOT re-check
 * the host, so a 302 from youtube.com to http://169.254.169.254/ would
 * succeed and bypass the upfront safety checks.
 */
async function fetchWithSsrfChecks(url: string, init: GuardedFetchInit): Promise<Response> {
  let currentUrl = url
  let response: Response | null = null
  validateHttpUrl(currentUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await guardedFetch(currentUrl, { ...init, redirect: 'manual' })
    const isRedirect = response.status >= 300 && response.status < 400 && response.headers.has('location')
    if (!isRedirect) return response
    if (hop === MAX_REDIRECTS) throw new Error(`too many redirects (max ${MAX_REDIRECTS})`)
    const location = response.headers.get('location')!
    currentUrl = new URL(location, currentUrl).toString()
    validateHttpUrl(currentUrl)
  }
  if (!response) throw new Error('no response')
  return response
}

const VIDEO_ID_PATTERNS = [
  /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  /^([a-zA-Z0-9_-]{11})$/,
]

function extractVideoId(urlOrId: string): string | null {
  for (const pattern of VIDEO_ID_PATTERNS) {
    const match = urlOrId.match(pattern)
    if (match) return match[1]
  }
  return null
}

function parseTranscriptXml(xml: string): Array<{ start: number; dur: number; text: string }> {
  const segments: Array<{ start: number; dur: number; text: string }> = []
  const regex = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g
  let match
  while ((match = regex.exec(xml)) !== null) {
    const start = parseFloat(match[1]) || 0
    const dur = parseFloat(match[2]) || 0
    const text = match[3]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]+>/g, '')
      .trim()
    if (text) segments.push({ start, dur, text })
  }
  return segments
}

function formatTimestamp(seconds: number): string {
  // Guard against NaN/Infinity/negative — callers may pass parseInt('') = NaN
  // when YouTube's lengthSeconds field is missing, which would otherwise
  // produce "NaN:NaN" in the output.
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const MAX_TRANSCRIPT_CHARS = 15_000

export async function getYouTubeTranscript(urlOrId: string): Promise<YouTubeTranscriptResult> {
  const videoId = extractVideoId(urlOrId.trim())
  if (!videoId) {
    return { videoId: '', title: '', channel: '', transcript: 'Error: could not extract video ID from input', duration: '' }
  }

  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    let res: Response
    try {
      res = await fetchWithSsrfChecks(watchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
        maxBytes: MAX_WATCH_PAGE_BYTES,
      })
    } finally {
      clearTimeout(timeout)
    }
    const html = await res.text()

    // Extract player response
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});(?:\s*var\s|\s*<\/script>)/)
    if (!playerMatch) {
      return { videoId, title: '', channel: '', transcript: 'Error: could not find player response. Video may be unavailable.', duration: '' }
    }

    let playerData: Record<string, unknown>
    try {
      playerData = JSON.parse(playerMatch[1])
    } catch {
      return { videoId, title: '', channel: '', transcript: 'Error: could not parse player response', duration: '' }
    }

    const videoDetails = playerData.videoDetails as Record<string, unknown> | undefined
    const title = (videoDetails?.title as string) || ''
    const channel = (videoDetails?.author as string) || ''
    const lengthSeconds = parseInt((videoDetails?.lengthSeconds as string) || '0', 10)
    const duration = formatTimestamp(lengthSeconds)

    // Find caption tracks
    const captions = (playerData.captions as Record<string, unknown>)?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined
    const captionTracks = captions?.captionTracks as Array<Record<string, unknown>> | undefined
    if (!captionTracks || captionTracks.length === 0) {
      return { videoId, title, channel, transcript: 'Error: no captions available for this video', duration }
    }

    // Prefer English, fall back to first available
    const enTrack = captionTracks.find(t => (t.languageCode as string)?.startsWith('en'))
    const track = enTrack || captionTracks[0]
    const captionUrl = track.baseUrl as string
    if (!captionUrl) {
      return { videoId, title, channel, transcript: 'Error: caption URL not found', duration }
    }

    // Validate caption URL is from YouTube/Google. Use URL.hostname so we can't
    // be tricked by prefix-style spoofs like https://www.youtube.com.attacker.com/
    // (the SSRF check still runs in fetchWithSsrfChecks below — this is the
    // origin allowlist).
    try {
      const captionHost = new URL(captionUrl).hostname.toLowerCase()
      const allowedHosts = new Set(['www.youtube.com', 'youtube.com', 'www.google.com'])
      if (!allowedHosts.has(captionHost)) {
        return { videoId, title, channel, transcript: 'Error: unexpected caption URL origin', duration }
      }
    } catch {
      return { videoId, title, channel, transcript: 'Error: invalid caption URL', duration }
    }

    const captionController = new AbortController()
    const captionTimeout = setTimeout(() => captionController.abort(), 15_000)
    let captionRes: Response
    try {
      captionRes = await fetchWithSsrfChecks(captionUrl, { signal: captionController.signal, maxBytes: MAX_CAPTION_BYTES })
    } finally {
      clearTimeout(captionTimeout)
    }
    const captionXml = await captionRes.text()
    const segments = parseTranscriptXml(captionXml)

    if (segments.length === 0) {
      return { videoId, title, channel, transcript: 'Error: no transcript segments found', duration }
    }

    let transcript = segments
      .map(s => `[${formatTimestamp(s.start)}] ${s.text}`)
      .join('\n')

    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n... [truncated]'
    }

    return { videoId, title, channel, transcript, duration }
  } catch (err) {
    return { videoId, title: '', channel: '', transcript: `Error: ${(err as Error).message}`, duration: '' }
  }
}
