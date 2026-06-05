'use client'

import { FileTree } from './FileTree'
import { CodeViewer } from './CodeViewer'

export function WebIdeCodePanel() {
  return (
    <div className="flex h-full">
      <div className="w-[200px] border-r border-border-primary overflow-y-auto">
        <FileTree />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <CodeViewer />
      </div>
    </div>
  )
}
