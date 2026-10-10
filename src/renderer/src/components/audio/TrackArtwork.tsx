import { useState, type ReactNode } from 'react'
import { AudioLines } from 'lucide-react'
import { coverArtFor } from '@shared/url'
import { cn } from '@/lib/cn'

export interface TrackArtworkProps {
  sourceUrl?: string | null
  thumbnail?: string | null
  title: string
  className?: string
  iconClassName?: string
}

/** Real source artwork, with a neutral placeholder when none is available. */
export function TrackArtwork({ sourceUrl, thumbnail, title, className, iconClassName }: TrackArtworkProps): ReactNode {
  const artworkUrl = thumbnail || coverArtFor(sourceUrl)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const hasArtwork = artworkUrl != null && artworkUrl !== failedUrl

  return (
    <span className={cn('relative block shrink-0 overflow-hidden bg-[var(--sonic-artwork-bg)]', className)}>
      {hasArtwork ? (
        <img
          key={artworkUrl}
          src={artworkUrl}
          alt={`Artwork for ${title}`}
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(artworkUrl)}
          className="block size-full object-cover"
        />
      ) : (
        <span role="img" aria-label={`No artwork available for ${title}`} className="grid size-full place-items-center text-fg-subtle">
          <AudioLines aria-hidden="true" strokeWidth={1.35} className={cn('size-6', iconClassName)} />
        </span>
      )}
    </span>
  )
}
