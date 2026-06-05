export type ArtifactPurpose = 'deliverable' | 'support' | 'internal'

export interface Artifact {
  id: string
  fileName: string
  filePath: string
  content: string
  type: 'document' | 'code' | 'data' | 'image'
  imageUrl?: string
  imageDataUrl?: string
  /**
   * New runtime contract: deliverables are the only artifacts shown as final
   * outputs by default. Support/internal files remain accessible in task files.
   * `deliverable` stays for backward compatibility with existing messages.
   */
  purpose?: ArtifactPurpose
  deliverable?: boolean
  createdAt: number
}
