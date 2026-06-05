/**
 * Structured Logger for the agent system.
 *
 * Replaces scattered console.log/console.error calls with a proper
 * logger that includes component names, timestamps, log levels,
 * and structured metadata. Supports log-level filtering.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

interface LogEntry {
  level: LogLevel
  component: string
  message: string
  data?: Record<string, unknown>
  timestamp: number
  elapsed?: number  // ms since logger creation
}

export class Logger {
  private component: string
  private minLevel: LogLevel
  private startTime: number
  private history: LogEntry[] = []
  private maxHistory: number
  private parent: Logger | null = null

  constructor(component: string, opts?: { minLevel?: LogLevel; maxHistory?: number }) {
    this.component = component
    this.minLevel = opts?.minLevel ?? 'info'
    this.maxHistory = opts?.maxHistory ?? 500
    this.startTime = Date.now()
  }

  /**
   * Create a child logger that shares history with the parent.
   */
  child(component: string): Logger {
    const child = new Logger(`${this.component}:${component}`, {
      minLevel: this.minLevel,
      maxHistory: this.maxHistory,
    })
    child.parent = this
    child.startTime = this.startTime
    return child
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data)
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data)
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data)
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data)
  }

  /**
   * Get recent log entries, optionally filtered by level.
   */
  getHistory(opts?: { level?: LogLevel; limit?: number; component?: string }): LogEntry[] {
    const root = this.getRoot()
    let entries = root.history

    if (opts?.level) {
      const minPriority = LEVEL_PRIORITY[opts.level]
      entries = entries.filter(e => LEVEL_PRIORITY[e.level] >= minPriority)
    }
    if (opts?.component) {
      entries = entries.filter(e => e.component.includes(opts.component!))
    }
    if (opts?.limit) {
      entries = entries.slice(-opts.limit)
    }

    return entries
  }

  /**
   * Get a formatted summary of recent errors and warnings.
   */
  getIssueSummary(): string {
    const root = this.getRoot()
    const issues = root.history.filter(e => e.level === 'warn' || e.level === 'error').slice(-10)
    if (issues.length === 0) return ''

    return issues.map(e => {
      const elapsed = e.elapsed ? `+${(e.elapsed / 1000).toFixed(1)}s` : ''
      return `[${e.level.toUpperCase()}] ${e.component} ${elapsed}: ${e.message}`
    }).join('\n')
  }

  /**
   * Set minimum log level at runtime. Applied to the root logger so all
   * descendants share the same threshold (children defer to root in log()).
   */
  setLevel(level: LogLevel): void {
    this.getRoot().minLevel = level
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    // Always check the root's minLevel so runtime setLevel() affects all children.
    const root = this.getRoot()
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[root.minLevel]) return

    const entry: LogEntry = {
      level,
      component: this.component,
      message,
      data,
      timestamp: Date.now(),
      elapsed: Date.now() - this.startTime,
    }

    // Store in root history
    root.history.push(entry)
    if (root.history.length > root.maxHistory) {
      root.history = root.history.slice(-root.maxHistory)
    }

    // Console output
    const elapsed = `+${((entry.elapsed || 0) / 1000).toFixed(1)}s`
    const prefix = `[${this.component}] ${elapsed}`
    let dataStr = ''
    if (data) {
      try {
        dataStr = ` ${JSON.stringify(data)}`
      } catch {
        dataStr = ' [unserializable data]'
      }
    }

    switch (level) {
      case 'debug':
        console.debug(`${prefix} ${message}${dataStr}`)
        break
      case 'info':
        console.log(`${prefix} ${message}${dataStr}`)
        break
      case 'warn':
        console.warn(`${prefix} ${message}${dataStr}`)
        break
      case 'error':
        console.error(`${prefix} ${message}${dataStr}`)
        break
    }
  }

  private getRoot(): Logger {
    let current: Logger = this
    while (current.parent) current = current.parent
    return current
  }
}

/**
 * Create the root logger for an agent session.
 */
export function createAgentLogger(minLevel?: LogLevel): Logger {
  return new Logger('Agent', { minLevel: minLevel ?? 'info' })
}
