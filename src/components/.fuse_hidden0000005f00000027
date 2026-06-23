import { useEffect, useState } from 'react'

/**
 * Image / video card used throughout the Beme guide.
 *
 * Files live under public/guide/. When the file is missing (e.g. still
 * to be captured), the component renders a dashed-border placeholder
 * showing the filename + intended caption — so unfinished sections look
 * intentionally pending rather than broken.
 *
 * Click an image to open it full-screen in a lightbox overlay. Videos
 * autoplay muted + looped (silent demos of interactions like wall
 * drawing or curve placement).
 *
 * `aspect` is OPTIONAL — by default images render at their natural
 * ratio (best for screenshots, which already come in workspace ratios
 * that look right uncropped). Specify '4/3' for narrow modal panels or
 * '1/1' for square crops when you want a smaller, more compact card.
 */
export default function GuideMedia({
  src,
  caption,
  kind = 'image',
  aspect,
}: {
  src: string
  caption: string
  kind?: 'image' | 'video'
  aspect?: '16/9' | '4/3' | '1/1'
}) {
  const [missing, setMissing] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const url = `/guide/${src}`

  // Aspect classes only when explicitly requested. Default = natural
  // ratio (image dictates its own height).
  const aspectClass =
    aspect === '4/3'
      ? 'aspect-[4/3] object-cover object-top'
      : aspect === '1/1'
        ? 'aspect-square object-cover object-top'
        : aspect === '16/9'
          ? 'aspect-video object-cover object-top'
          : ''

  // Placeholder always needs an explicit height — no image to size from.
  const placeholderAspect = aspectClass
    ? aspectClass.split(' ')[0]
    : 'aspect-video'

  return (
    <figure className="my-6">
      {missing ? (
        <Placeholder
          filename={src}
          caption={caption}
          aspectClass={placeholderAspect}
        />
      ) : kind === 'video' ? (
        <video
          src={url}
          className={`w-full ${aspectClass} rounded-lg border border-ink-700 bg-ink-950 shadow-lg`}
          autoPlay
          loop
          muted
          playsInline
          controls
          onError={() => setMissing(true)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setZoomed(true)}
          className="block w-full group cursor-zoom-in"
          aria-label={`View ${caption} full-size`}
        >
          <img
            src={url}
            alt={caption}
            loading="lazy"
            decoding="async"
            className={`w-full ${aspectClass} rounded-lg border border-ink-700 bg-ink-950 shadow-lg transition-opacity group-hover:opacity-90`}
            onError={() => setMissing(true)}
          />
        </button>
      )}
      <figcaption className="text-xs text-ink-400 mt-2 italic">
        {caption}
      </figcaption>

      {zoomed && kind === 'image' && !missing && (
        <Lightbox url={url} caption={caption} onClose={() => setZoomed(false)} />
      )}
    </figure>
  )
}

function Placeholder({
  filename,
  caption,
  aspectClass,
}: {
  filename: string
  caption: string
  aspectClass: string
}) {
  return (
    <div
      className={`w-full ${aspectClass} rounded-lg border-2 border-dashed border-ink-700 bg-ink-900/40 flex flex-col items-center justify-center text-center px-6`}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-500 mb-2">
        Screenshot pending
      </div>
      <div className="text-xs text-ink-400 font-mono mb-1">{filename}</div>
      <div className="text-xs text-ink-500 max-w-sm">{caption}</div>
    </div>
  )
}

/**
 * Click-to-zoom overlay. Escape or backdrop-click dismisses. Body scroll
 * is locked while open so the page underneath can't drift.
 */
function Lightbox({
  url,
  caption,
  onClose,
}: {
  url: string
  caption: string
  onClose: () => void
}) {
  // Lock body scroll + listen for Escape while the lightbox is mounted.
  // Keyboard handler lives here (not on the dialog div) because focus
  // typically isn't on the dialog when the user hits Escape.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center p-6 cursor-zoom-out"
    >
      <img
        src={url}
        alt={caption}
        className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="text-sm text-ink-200 mt-4 max-w-2xl text-center">
        {caption}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 text-ink-300 hover:text-ink-50 text-2xl leading-none"
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  )
}
