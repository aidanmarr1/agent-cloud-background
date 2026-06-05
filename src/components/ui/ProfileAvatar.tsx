'use client'

import { useEffect, useRef, useState } from 'react'
import { User } from '@/components/icons'

function initialsFor(name: string | null | undefined): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'U'
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase()
  return `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(0, 1)}`.toUpperCase()
}

export function ProfileAvatar({
  imageUrl,
  name,
  className = 'h-9 w-9',
  textClassName = 'text-[13px]',
  iconSize = 15,
}: {
  imageUrl?: string | null
  name?: string | null
  className?: string
  textClassName?: string
  iconSize?: number
}) {
  const hasImage = typeof imageUrl === 'string' && imageUrl.trim().length > 0
  const imageRef = useRef<HTMLImageElement>(null)
  const [imageFailed, setImageFailed] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)

  useEffect(() => {
    setImageFailed(false)
    setImageLoaded(false)
  }, [imageUrl])

  useEffect(() => {
    const image = imageRef.current
    if (!image || !hasImage) return
    if (image.complete && image.naturalWidth > 0) {
      setImageLoaded(true)
      return
    }
    const frame = window.requestAnimationFrame(() => {
      if (image.complete && image.naturalWidth > 0) {
        setImageLoaded(true)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [hasImage, imageUrl])

  const fallback = name && name !== 'User' ? (
    <span className={`font-semibold tracking-[0] ${textClassName}`}>{initialsFor(name)}</span>
  ) : (
    <User size={iconSize} className="text-text-secondary" strokeWidth={2.25} />
  )

  return (
    <div className={`relative flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-border-primary bg-bg-primary text-text-primary ${className}`}>
      {(!hasImage || imageFailed || !imageLoaded) && fallback}
      {hasImage && !imageFailed && (
        <img
          ref={imageRef}
          src={imageUrl}
          alt={name ? `${name} profile picture` : 'Profile picture'}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-150 ${imageLoaded ? 'opacity-100' : 'opacity-0'}`}
          decoding="async"
          fetchPriority="high"
          loading="eager"
          draggable={false}
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageFailed(true)}
        />
      )}
    </div>
  )
}
