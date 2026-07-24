export function utf8ByteWeight(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export async function drainOrderedEventBatches<T>(
  pending: T[],
  batchLimit: number,
  persist: (records: T[]) => Promise<void>,
  options?: {
    maxBatchWeight: number
    weightOf: (record: T) => number
  },
): Promise<void> {
  const limit = Math.max(1, Math.floor(batchLimit))
  while (pending.length > 0) {
    // Do not remove a batch until its durable transaction succeeds. If the
    // response is lost after commit, the caller can retry these exact records
    // through the idempotent run-id/sequence insert fence.
    let batchSize = 0
    let batchWeight = 0
    while (batchSize < pending.length && batchSize < limit) {
      const nextWeight = options
        ? Math.max(1, Math.ceil(options.weightOf(pending[batchSize])))
        : 1
      if (options && batchSize > 0 && batchWeight + nextWeight > options.maxBatchWeight) break
      batchSize += 1
      batchWeight += nextWeight
      if (options && batchWeight >= options.maxBatchWeight) break
    }
    const records = pending.slice(0, Math.max(1, batchSize))
    await persist(records)
    pending.splice(0, records.length)
  }
}
