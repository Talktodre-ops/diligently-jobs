// Time zone names for the Settings picker. The list comes from the browser
// (Intl.supportedValuesOf), so it matches what the API accepts in practice.

/** "America/Argentina/Buenos_Aires" -> "Buenos Aires". */
export function zoneCity(zone: string) {
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ')
}

/** "Africa/Lagos" -> "Africa"; empty for zones without a region, like "UTC". */
export function zoneRegion(zone: string) {
  const parts = zone.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join(', ').replace(/_/g, ' ') : ''
}

/** "GMT+1" for Lagos right now, or null when the browser cannot say. */
export function zoneOffset(zone: string, at = new Date()): string | null {
  try {
    const part = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')
    return part?.value ?? null
  } catch {
    return null
  }
}

/** "Lagos (GMT+1)". */
export function zoneLabel(zone: string) {
  const offset = zoneOffset(zone)
  return offset ? `${zoneCity(zone)} (${offset})` : zoneCity(zone)
}

let cached: string[] | null = null

/** Every zone the browser knows, UTC included. */
export function allZones(): string[] {
  if (cached) return cached
  let list: string[]
  try {
    list = Intl.supportedValuesOf('timeZone')
  } catch {
    list = []
  }
  cached = list.includes('UTC') ? list : [...list, 'UTC']
  return cached
}

const norm = (t: string) => t.toLowerCase().replace(/_/g, ' ')

/** Zones whose name matches every word of `query`, cities that start with it first. */
export function searchZones(query: string, zones = allZones()): string[] {
  const words = norm(query).split(/[\s,/]+/).filter(Boolean)
  if (words.length === 0) return zones
  const hits = zones.filter((z) => words.every((w) => norm(z).includes(w)))
  const first = words[0]!
  const starts = (z: string) => norm(zoneCity(z)).startsWith(first)
  return [...hits.filter(starts), ...hits.filter((z) => !starts(z))]
}
