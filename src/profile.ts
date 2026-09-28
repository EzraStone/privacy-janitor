/**
 * A profile's age range as "lo-hi", undefined when none was given, or null
 * when it cannot be read. Match hints compare a listing's age against it, so
 * an unreadable range ("25 to 30", "30-25") must be refused, not stored and
 * silently treated as unknown. A single age is refused too: a listing whose
 * age is a birthday ahead would read as a contradiction.
 */
export function normalizeAgeRange(raw: string): string | undefined | null {
  const text = raw.trim()
  if (!text) return undefined
  const match = text.match(/^(\d{1,3})\s*[-–—]\s*(\d{1,3})$/)
  const lo = Number(match?.[1])
  const hi = Number(match?.[2])
  if (!match || lo < 18 || hi > 119 || lo > hi) return null
  return `${lo}-${hi}`
}
