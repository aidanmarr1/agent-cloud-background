export interface ZipArchiveEntry {
  path: string
  body: Uint8Array
}

let crc32Table: Uint32Array | null = null

function crc32(bytes: Uint8Array): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let value = n
      for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
      }
      crc32Table[n] = value >>> 0
    }
  }
  let value = 0xffffffff
  for (const byte of bytes) value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function zipHeader(size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size)
  write(new DataView(bytes.buffer))
  return bytes
}

/** Create a portable uncompressed ZIP entirely in memory. */
export function createStoredZipArchive(rawEntries: ZipArchiveEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const entries = rawEntries.map(entry => ({
    name: encoder.encode(entry.path.replace(/\\/g, '/').replace(/^\/+/, '')),
    body: entry.body,
    crc: crc32(entry.body),
    offset: 0,
  }))

  if (entries.length === 0 || entries.length > 0xffff) {
    throw new Error('A ZIP archive requires between 1 and 65,535 files.')
  }
  if (entries.some(entry => entry.name.byteLength === 0 || entry.name.byteLength > 0xffff)) {
    throw new Error('A ZIP entry has an invalid path.')
  }

  const localChunks: Uint8Array[] = []
  let localOffset = 0
  for (const entry of entries) {
    entry.offset = localOffset
    const header = zipHeader(30, view => {
      view.setUint32(0, 0x04034b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, 0, true)
      view.setUint16(8, 0, true)
      view.setUint16(10, 0, true)
      view.setUint16(12, 0, true)
      view.setUint32(14, entry.crc, true)
      view.setUint32(18, entry.body.byteLength, true)
      view.setUint32(22, entry.body.byteLength, true)
      view.setUint16(26, entry.name.byteLength, true)
      view.setUint16(28, 0, true)
    })
    localChunks.push(header, entry.name, entry.body)
    localOffset += header.byteLength + entry.name.byteLength + entry.body.byteLength
  }

  const centralChunks: Uint8Array[] = []
  let centralSize = 0
  for (const entry of entries) {
    const header = zipHeader(46, view => {
      view.setUint32(0, 0x02014b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, 20, true)
      view.setUint16(8, 0, true)
      view.setUint16(10, 0, true)
      view.setUint16(12, 0, true)
      view.setUint16(14, 0, true)
      view.setUint32(16, entry.crc, true)
      view.setUint32(20, entry.body.byteLength, true)
      view.setUint32(24, entry.body.byteLength, true)
      view.setUint16(28, entry.name.byteLength, true)
      view.setUint16(30, 0, true)
      view.setUint16(32, 0, true)
      view.setUint16(34, 0, true)
      view.setUint16(36, 0, true)
      view.setUint32(38, 0, true)
      view.setUint32(42, entry.offset, true)
    })
    centralChunks.push(header, entry.name)
    centralSize += header.byteLength + entry.name.byteLength
  }

  const end = zipHeader(22, view => {
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(4, 0, true)
    view.setUint16(6, 0, true)
    view.setUint16(8, entries.length, true)
    view.setUint16(10, entries.length, true)
    view.setUint32(12, centralSize, true)
    view.setUint32(16, localOffset, true)
    view.setUint16(20, 0, true)
  })

  return concatBytes([...localChunks, ...centralChunks, end])
}
