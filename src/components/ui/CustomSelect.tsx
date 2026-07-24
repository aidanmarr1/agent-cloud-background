'use client'

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from '@/components/icons'

export interface CustomSelectOption {
  value: string
  label: string
}

interface CustomSelectProps {
  value: string
  options: CustomSelectOption[]
  onChange: (value: string) => void
  label?: string
  className?: string
}

interface MenuPosition {
  top: number
  left: number
  width: number
  maxHeight: number
  placement: 'top' | 'bottom'
}

const VIEWPORT_PADDING = 12
const MENU_GAP = 8
const MIN_MENU_WIDTH = 192
const MAX_MENU_HEIGHT = 260

export function CustomSelect({ value, options, onChange, label = 'Select option', className = '' }: CustomSelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const selected = options[selectedIndex] || options[0]

  const menuId = useId()

  const updatePosition = useCallback(() => {
    const button = buttonRef.current
    if (!button || typeof window === 'undefined') return

    const rect = button.getBoundingClientRect()
    const width = Math.max(rect.width, MIN_MENU_WIDTH)
    const menuHeight = Math.min(MAX_MENU_HEIGHT, options.length * 42 + 12)
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING
    const spaceAbove = rect.top - VIEWPORT_PADDING
    const placement: MenuPosition['placement'] = spaceBelow < menuHeight && spaceAbove > spaceBelow ? 'top' : 'bottom'
    const availableHeight = placement === 'top' ? spaceAbove - MENU_GAP : spaceBelow - MENU_GAP
    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING)
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, rect.right - width),
      maxLeft
    )

    setPosition({
      top: placement === 'top' ? rect.top - MENU_GAP : rect.bottom + MENU_GAP,
      left,
      width,
      maxHeight: Math.max(120, Math.min(MAX_MENU_HEIGHT, availableHeight)),
      placement,
    })
  }, [options.length])

  useLayoutEffect(() => {
    if (!open) return
    setActiveIndex(selectedIndex)
    updatePosition()
  }, [open, selectedIndex, updatePosition])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleViewportChange = () => updatePosition()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [open, updatePosition])

  const commitValue = (nextValue: string) => {
    onChange(nextValue)
    setOpen(false)
  }

  const handleButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault()
      commitValue(options[activeIndex]?.value || value)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen((next) => !next)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
      } else {
        setActiveIndex((index) => Math.min(options.length - 1, index + 1))
      }
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
      } else {
        setActiveIndex((index) => Math.max(0, index - 1))
      }
      return
    }
  }

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(options.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      commitValue(options[activeIndex]?.value || value)
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((next) => !next)}
        onKeyDown={handleButtonKeyDown}
        className={`h-10 w-full rounded-lg border border-border-primary bg-bg-secondary pl-3.5 pr-3 text-left text-[13px] font-medium text-text-primary outline-none transition-all duration-200 hover:border-border-tertiary focus:border-border-primary focus:ring-2 focus:ring-accent-blue/20 ${className}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <span className="flex items-center justify-between gap-3">
          <span className="truncate">{selected?.label || 'Select'}</span>
          <ChevronDown
            size={14}
            className={`flex-shrink-0 text-text-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
            strokeWidth={2.25}
          />
        </span>
      </button>

      {open && position && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="listbox"
          tabIndex={-1}
          onKeyDown={handleMenuKeyDown}
          className="fixed z-[200] rounded-xl border border-border-primary menu-surface p-1.5 animate-scale-in overflow-y-auto"
          style={{
            top: position.placement === 'top' ? undefined : position.top,
            bottom: position.placement === 'top' ? window.innerHeight - position.top : undefined,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
            transformOrigin: position.placement === 'top' ? 'bottom right' : 'top right',
            boxShadow: 'var(--shadow-menu)',
          }}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value
            const isActive = index === activeIndex
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commitValue(option.value)}
                className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium transition-colors ${
                  isActive ? 'bg-bg-hover text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary focus-visible:bg-bg-hover'
                }`}
              >
                <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                  {isSelected && <Check size={13} strokeWidth={2.4} className="text-accent-blue" />}
                </span>
                <span className="truncate">{option.label}</span>
              </button>
            )
          })}
        </div>,
        document.body
      )}
    </>
  )
}
