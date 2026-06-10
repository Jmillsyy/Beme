import { useEffect, useState } from 'react'
import {
  formatLengthInputValue,
  lengthInputPlaceholder,
  lengthInputSuffix,
  parseLengthInput,
} from '../lib/units'
import { useUserSettings } from '../lib/userSettings'

/**
 * One length input, units-aware.
 *
 * Stores `valueMm` as a number (the canonical mm value) and renders
 * a string that respects the user's metric / imperial preference.
 * Typing accepts feet-inches notation (8'-6", 8' 6 1/2", 1/2"),
 * metric notation with suffix (2400mm, 2.4m), or plain numbers
 * (interpreted per the units setting).
 *
 * Behaviour:
 *   - On mount and whenever valueMm or units change, the input
 *     re-formats to canonical. The user's in-progress edits are
 *     preserved while the input is focused.
 *   - On every keystroke, the string is parsed. If it parses cleanly
 *     to a value within [minMm, maxMm], onChangeMm fires with the
 *     parsed mm. Invalid intermediate strings (e.g. "8'-") do NOT
 *     fire onChange — the input keeps the string, the parent's
 *     valueMm doesn't change.
 *   - On blur, the input re-formats from the parent's valueMm so
 *     the user sees the canonical form (e.g. "8'-6 1/2\"" not "8.54'").
 *
 * Use as a drop-in replacement for `<input type="number">` on any
 * length field.
 */
export default function LengthInput({
  valueMm,
  onChangeMm,
  minMm,
  maxMm,
  disabled,
  placeholder,
  ariaLabel,
  className,
  onEnter,
}: {
  valueMm: number
  onChangeMm: (mm: number) => void
  /** Optional clamp — invalid values outside this range don't commit. */
  minMm?: number
  maxMm?: number
  disabled?: boolean
  /** Override the units-appropriate placeholder if you need custom copy. */
  placeholder?: string
  ariaLabel?: string
  className?: string
  /** Optional callback when the user presses Enter (e.g. submit a form). */
  onEnter?: () => void
}) {
  const { settings } = useUserSettings()
  const units = settings.preferences.units
  // Local string state — what the user is typing right now.
  // Initialised from valueMm in canonical form and re-synced whenever
  // valueMm or units change (e.g. parent reset, units toggle).
  const [text, setText] = useState(() => formatLengthInputValue(valueMm, units))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    // Don't clobber the user's keystrokes while they're editing —
    // only re-format when the field is not focused.
    if (!focused) setText(formatLengthInputValue(valueMm, units))
  }, [valueMm, units, focused])

  const handleChange = (next: string) => {
    setText(next)
    const parsed = parseLengthInput(next, units)
    if (parsed === null || !Number.isFinite(parsed)) return
    if (minMm !== undefined && parsed < minMm) return
    if (maxMm !== undefined && parsed > maxMm) return
    onChangeMm(parsed)
  }

  return (
    <div className={`inline-flex items-stretch ${className ?? ''}`}>
      <input
        type="text"
        inputMode="text"
        value={text}
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={placeholder ?? lengthInputPlaceholder(units)}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          // Re-format from the canonical parent value on blur so the
          // user sees the tidy form ("8'-6 1/2\"") even if they typed
          // a sloppy version ("8' 6.5").
          setText(formatLengthInputValue(valueMm, units))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            onEnter()
          }
        }}
        className="flex-1 min-w-0 px-3 py-2 border border-ink-600 rounded-l-lg text-sm bg-ink-900 text-ink-50 focus:outline-none focus:border-beme-400 disabled:bg-ink-800 disabled:text-ink-400 disabled:cursor-not-allowed"
      />
      <span className="inline-flex items-center px-2 border border-l-0 border-ink-600 rounded-r-lg text-xs text-ink-400 bg-ink-800 select-none">
        {lengthInputSuffix(units)}
      </span>
    </div>
  )
}
