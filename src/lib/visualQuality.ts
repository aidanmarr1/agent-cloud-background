import type sharpFactory from 'sharp'

export interface ScreenshotQuality {
  blank: boolean
  reason: string | null
  nonWhiteRatio: number
  edgeRatio: number
  channelStdDev: number
}

const SAMPLE_SIZE = 96

function stdDev(values: number[], mean: number): number {
  if (values.length === 0) return 0
  const variance = values.reduce((sum, value) => {
    const diff = value - mean
    return sum + diff * diff
  }, 0) / values.length
  return Math.sqrt(variance)
}

export async function analyzeScreenshotQuality(base64: string | undefined): Promise<ScreenshotQuality | null> {
  if (!base64) return null

  let sharp: typeof sharpFactory
  try {
    const sharpModule = await import('sharp') as unknown as { default?: typeof sharpFactory } & typeof sharpFactory
    sharp = sharpModule.default ?? sharpModule
  } catch {
    return null
  }

  try {
    const input = Buffer.from(base64, 'base64')
    const { data, info } = await sharp(input)
      .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const channels = info.channels || 3
    const pixels = info.width * info.height
    if (pixels <= 0 || channels < 3) return null

    let nonWhite = 0
    let edgeCount = 0
    const lumas: number[] = []

    const lumaAt = (idx: number) => {
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const idx = (y * info.width + x) * channels
        const r = data[idx]
        const g = data[idx + 1]
        const b = data[idx + 2]
        const luma = lumaAt(idx)
        lumas.push(luma)

        if (r < 245 || g < 245 || b < 245) nonWhite++

        if (x > 0) {
          const leftIdx = (y * info.width + x - 1) * channels
          if (Math.abs(luma - lumaAt(leftIdx)) > 24) edgeCount++
        }
        if (y > 0) {
          const aboveIdx = ((y - 1) * info.width + x) * channels
          if (Math.abs(luma - lumaAt(aboveIdx)) > 24) edgeCount++
        }
      }
    }

    const meanLuma = lumas.reduce((sum, value) => sum + value, 0) / lumas.length
    const channelStdDev = stdDev(lumas, meanLuma)
    const nonWhiteRatio = nonWhite / pixels
    const edgeRatio = edgeCount / Math.max(1, pixels * 2 - info.width - info.height)
    const uniformScreen = channelStdDev < 3 && edgeRatio < 0.002
    const whiteScreen = meanLuma > 248 && nonWhiteRatio < 0.01 && edgeRatio < 0.002
    const blank = whiteScreen || uniformScreen

    return {
      blank,
      reason: blank
        ? whiteScreen
          ? 'preview screenshot is a blank white page'
          : 'preview screenshot has almost no visible variation or content'
        : null,
      nonWhiteRatio,
      edgeRatio,
      channelStdDev,
    }
  } catch {
    return null
  }
}
