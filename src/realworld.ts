import type { DayOfWeek } from './types'

/**
 * Real-world grounding for the simulator — actual location, weather, and
 * time-of-day, fetched directly from the browser. No Mistral involved: this
 * is plain browser/HTTP data feeding the deterministic engine's flags
 * exactly like an authored scenario would, just sourced from reality
 * instead of hand-picked. Mistral has no weather or geolocation tool of its
 * own (confirmed against its docs) — this is genuinely separate real-world
 * tool calling, done directly.
 */

export class RealWorldError extends Error {}

export type RealWorldContext = {
  latitude: number
  longitude: number
  /** best-effort human label, e.g. "52.52, 13.41" if no reverse geocode is available */
  placeLabel: string
  temperatureC: number
  isRaining: boolean
  isDay: boolean
  /** local time at the location, minutes since midnight */
  clockMin: number
  dayOfWeek: DayOfWeek
  fetchedAt: number
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new RealWorldError('This browser has no geolocation support.'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      resolve,
      (err) => {
        if (err.code === err.PERMISSION_DENIED) reject(new RealWorldError('Location permission was denied.'))
        else if (err.code === err.TIMEOUT) reject(new RealWorldError('Location request timed out.'))
        else reject(new RealWorldError('Could not determine your location.'))
      },
      { timeout: 8000, maximumAge: 5 * 60_000 },
    )
  })
}

// WMO weather codes (used by Open-Meteo) where precipitation is actually falling —
// drizzle, rain, rain showers, thunderstorm, freezing rain. See open-meteo.com/en/docs.
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99])

async function fetchWeather(lat: number, lon: number, signal?: AbortSignal): Promise<{
  temperatureC: number
  isRaining: boolean
  isDay: boolean
  localTime: string
}> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weather_code,is_day&timezone=auto`
  let res: Response
  try {
    res = await fetch(url, { signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new RealWorldError('Could not reach the weather service.')
  }
  if (!res.ok) throw new RealWorldError(`Weather service returned ${res.status}.`)
  const json = await res.json()
  const current = json?.current
  if (!current || typeof current.temperature_2m !== 'number') {
    throw new RealWorldError('Weather service returned an unexpected response.')
  }
  return {
    temperatureC: current.temperature_2m,
    isRaining: RAIN_CODES.has(current.weather_code) || (current.precipitation ?? 0) > 0,
    isDay: current.is_day === 1,
    localTime: current.time, // "YYYY-MM-DDTHH:MM" in the location's own timezone
  }
}

/** Fetch the user's real location + current weather + local time. Rejects with RealWorldError on any failure. */
export async function fetchRealWorldContext(signal?: AbortSignal): Promise<RealWorldContext> {
  const position = await getPosition()
  const { latitude, longitude } = position.coords
  const weather = await fetchWeather(latitude, longitude, signal)

  const [datePart, timePart] = weather.localTime.split('T')
  const [hh, mm] = (timePart ?? '00:00').split(':').map(Number)
  const clockMin = (hh ?? 0) * 60 + (mm ?? 0)
  const dayOfWeek = (new Date(datePart + 'T00:00:00').getDay() as DayOfWeek) ?? 0

  return {
    latitude,
    longitude,
    placeLabel: `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
    temperatureC: weather.temperatureC,
    isRaining: weather.isRaining,
    isDay: weather.isDay,
    clockMin,
    dayOfWeek,
    fetchedAt: Date.now(),
  }
}

/** OpenStreetMap's own no-key embed URL (same pattern as the "Share" button on openstreetmap.org). */
export function osmEmbedUrl(lat: number, lon: number, spanDeg = 0.06): string {
  const bbox = `${lon - spanDeg},${lat - spanDeg},${lon + spanDeg},${lat + spanDeg}`
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&marker=${lat},${lon}`
}
