// Region gate, ported from deveco-code
// packages/opencode/src/plugin/deveco/region-policy.ts.
//
// DevEco Code is offered in Mainland China only, and the upstream client uses
// the machine's timezone to spot a request coming from outside it. Answering
// with a clear 451 beats letting every turn fail upstream with an opaque error
// (or, worse, a timeout after the model already started).

export const MAINLAND_CHINA_ONLY_MESSAGE =
  "DevEco Code is currently only available in Mainland China."

export const CHINA_ACCOUNT_ONLY_MESSAGE =
  "DevEco Code currently only supports China-region accounts."

const EUROPEAN_TIMEZONE_PREFIX = "Europe/"

/**
 * Territories the upstream classifies as European for this purpose. Beyond the
 * `Europe/` namespace it covers EU/EEA jurisdictions that live under other
 * names — including the Russian and Central Asian zones the upstream groups
 * with Europe. Copied verbatim so the gate matches the official client.
 */
const EUROPEAN_TIMEZONES = new Set([
  "Atlantic/Azores",
  "Atlantic/Canary",
  "Atlantic/Faroe",
  "Atlantic/Faeroe",
  "Atlantic/Madeira",
  "Atlantic/Reykjavik",
  "Arctic/Longyearbyen",
  "Atlantic/Jan_Mayen",
  "Africa/Ceuta",
  "Asia/Nicosia",
  "Asia/Famagusta",
  "America/Cayenne",
  "America/Guadeloupe",
  "America/Marigot",
  "America/Martinique",
  "America/Miquelon",
  "America/St_Barthelemy",
  "Indian/Kerguelen",
  "Indian/Mayotte",
  "Indian/Reunion",
  "Pacific/Gambier",
  "Pacific/Marquesas",
  "Pacific/Noumea",
  "Pacific/Tahiti",
  "Pacific/Wallis",
  "Antarctica/DumontDUrville",
  "America/Danmarkshavn",
  "America/Nuuk",
  "America/Godthab",
  "America/Scoresbysund",
  "America/Thule",
  "America/Aruba",
  "America/Curacao",
  "America/Kralendijk",
  "America/Lower_Princes",
  "America/Anguilla",
  "America/Cayman",
  "America/Grand_Turk",
  "America/Montserrat",
  "America/Tortola",
  "Atlantic/Bermuda",
  "Atlantic/South_Georgia",
  "Atlantic/Stanley",
  "Atlantic/St_Helena",
  "Indian/Chagos",
  "Pacific/Pitcairn",
  "Antarctica/Rothera",
  "Antarctica/Troll",
  "Asia/Yerevan",
  "Asia/Baku",
  "Asia/Tbilisi",
  "Asia/Almaty",
  "Asia/Aqtau",
  "Asia/Aqtobe",
  "Asia/Atyrau",
  "Asia/Oral",
  "Asia/Qostanay",
  "Asia/Qyzylorda",
  "Asia/Anadyr",
  "Asia/Barnaul",
  "Asia/Chita",
  "Asia/Irkutsk",
  "Asia/Kamchatka",
  "Asia/Khandyga",
  "Asia/Krasnoyarsk",
  "Asia/Magadan",
  "Asia/Novokuznetsk",
  "Asia/Novosibirsk",
  "Asia/Omsk",
  "Asia/Sakhalin",
  "Asia/Srednekolymsk",
  "Asia/Tomsk",
  "Asia/Ust-Nera",
  "Asia/Vladivostok",
  "Asia/Yakutsk",
  "Asia/Yekaterinburg",
  "CET",
  "EET",
  "WET",
  "MET",
  "GB",
  "GB-Eire",
  "Eire",
  "Iceland",
  "Poland",
  "Portugal",
  "Turkey",
  "Asia/Istanbul",
  "W-SU",
])

export function isEuropeanTimezone(timezone: string): boolean {
  return timezone.startsWith(EUROPEAN_TIMEZONE_PREFIX) || EUROPEAN_TIMEZONES.has(timezone)
}

/** The machine's timezone, or undefined when the runtime cannot say. */
export function currentTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/** Whether this machine sits outside the region the service is offered in. An
 * unknown timezone is not treated as a violation. */
export function regionBlocked(): boolean {
  const timezone = currentTimezone()
  return !!timezone && isEuropeanTimezone(timezone)
}
