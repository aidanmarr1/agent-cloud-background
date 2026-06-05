'use client'

import { useUIStore } from '@/store/ui'
import { useState, useEffect, useCallback } from 'react'
import { ChevronRight, ChevronDown, FileText, FileCode, Image, File } from '@/components/icons'

interface TreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: TreeNode[]
}

interface ApiFile {
  name: string
  path: string
  size: number
  modifiedAt: number
}

function buildTree(files: ApiFile[]): TreeNode[] {
  const root: TreeNode[] = []

  for (const file of files) {
    const parts = file.path.split('/')
    let current = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isFile = i === parts.length - 1
      const existingIdx = current.findIndex((n) => n.name === part)

      if (existingIdx >= 0) {
        if (!isFile && current[existingIdx].children) {
          current = current[existingIdx].children!
        }
      } else {
        const node: TreeNode = {
          name: part,
          path: isFile ? file.path : parts.slice(0, i + 1).join('/'),
          type: isFile ? 'file' : 'directory',
          ...(isFile ? {} : { children: [] }),
        }
        current.push(node)
        if (!isFile) current = node.children!
      }
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach((n) => { if (n.children) sortNodes(n.children) })
  }
  sortNodes(root)
  return root
}

const EXT_COLORS: Record<string, string> = {
  html: 'text-text-secondary',
  htm: 'text-text-secondary',
  css: 'text-accent-blue',
  js: 'text-accent-yellow',
  ts: 'text-accent-blue',
  tsx: 'text-accent-blue',
  jsx: 'text-accent-yellow',
  json: 'text-text-secondary',
  md: 'text-text-muted',
  py: 'text-text-secondary',
  svg: 'text-text-secondary',
  png: 'text-text-secondary',
  jpg: 'text-text-secondary',
  jpeg: 'text-text-secondary',
  gif: 'text-text-secondary',
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const color = EXT_COLORS[ext] || 'text-text-muted'
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) {
    return <Image size={12} className={color} />
  }
  if (['html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'json'].includes(ext)) {
    return <FileCode size={12} className={color} />
  }
  return <File size={12} className={color} />
}

function TreeNodeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(true)
  const webIdeSelectedFile = useUIStore((s) => s.webIdeSelectedFile)
  const setWebIdeSelectedFile = useUIStore((s) => s.setWebIdeSelectedFile)
  const isSelected = node.type === 'file' && webIdeSelectedFile === node.path

  if (node.type === 'directory') {
    return (
      <>
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-1.5 h-7 px-2 rounded-md hover:bg-bg-secondary transition-all duration-150 text-left"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {expanded ? (
            <ChevronDown size={11} className="text-text-muted flex-shrink-0" />
          ) : (
            <ChevronRight size={11} className="text-text-muted flex-shrink-0" />
          )}
          <FileText size={12} className="text-accent-blue flex-shrink-0" strokeWidth={2.25} />
          <span className="text-[11.5px] text-text-secondary font-medium truncate">{node.name}</span>
        </button>
        {expanded && node.children?.map((child) => (
          <TreeNodeRow key={child.path} node={child} depth={depth + 1} />
        ))}
      </>
    )
  }

  return (
    <button
      onClick={() => setWebIdeSelectedFile(node.path)}
      className={`w-full flex items-center gap-1.5 h-7 px-2 rounded-md transition-all duration-150 text-left ${
        isSelected ? 'bg-bg-tertiary text-text-primary' : 'hover:bg-bg-secondary'
      }`}
      style={{ paddingLeft: `${depth * 12 + 20}px` }}
    >
      {getFileIcon(node.name)}
      <span className={`text-[11.5px] truncate ${isSelected ? 'text-text-primary font-semibold' : 'text-text-secondary'}`}>
        {node.name}
      </span>
    </button>
  )
}

export function FileTree() {
  const webIdeConversationId = useUIStore((s) => s.webIdeConversationId)
  const webIdeRefreshKey = useUIStore((s) => s.webIdeRefreshKey)
  const [tree, setTree] = useState<TreeNode[]>([])

  const fetchFiles = useCallback(async () => {
    if (!webIdeConversationId) return
    try {
      const res = await fetch(`/api/files?conversationId=${webIdeConversationId}`)
      const data = await res.json()
      if (data.files) setTree(buildTree(data.files))
    } catch { /* ignore */ }
  }, [webIdeConversationId])

  useEffect(() => {
    fetchFiles()
  }, [fetchFiles, webIdeRefreshKey])

  if (tree.length === 0) {
    return (
      <div className="p-4 text-[12px] text-text-muted [font-family:var(--font-display)]">No files yet</div>
    )
  }

  return (
    <div className="p-1.5">
      {tree.map((node) => (
        <TreeNodeRow key={node.path} node={node} depth={0} />
      ))}
    </div>
  )
}
