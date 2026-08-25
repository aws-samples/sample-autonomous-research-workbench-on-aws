export const locales = ["en"] as const

export type Locale = (typeof locales)[number]

export const defaultLocale: Locale = "en"

export const localeCookieName = "locale"

// Explicit default time zone so server and client render dates consistently.
// next-intl raises ENVIRONMENT_FALLBACK during SSR when this is unset.
export const defaultTimeZone = "UTC"

export function isLocale(value: string | undefined): value is Locale {
  return locales.includes(value as Locale)
}
