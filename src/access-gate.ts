// Real-name gate, ported from deveco-code
// packages/opencode/src/plugin/deveco/access.ts (the service-agreement half of
// that file is CLI-only and has no equivalent here).
//
// A signed-in account that has not completed HUAWEI real-name verification
// cannot use the built-in models, and the upstream failure is opaque. Checking
// here turns it into a readable instruction.
//
// Only consulted when the cached account status says "not verified": a verified
// account never pays for the extra round-trip. Verdicts are reused for 30s and
// concurrent turns share one in-flight check, so a burst of queued turns cannot
// fan out into a burst of auth requests.

export const REAL_NAME_REQUIRED_MESSAGE =
  "Complete HUAWEI real-name authentication and retry in 30 seconds."

export const REAL_NAME_UNVERIFIED_MESSAGE =
  "Unable to verify HUAWEI real-name status. Check your network and retry in 30 seconds."

const RECHECK_INTERVAL_MS = 30_000

interface CachedVerdict {
  key: string
  expires: number
  message: string
  pending?: Promise<boolean | null>
}

let cached: CachedVerdict | undefined

/** Reset for tests. */
export function resetRealNameCache(): void {
  cached = undefined
}

/**
 * Returns null when access may proceed, otherwise the message to refuse with.
 * `verify` is expected to hit the auth server and resolve to true (verified),
 * false (not verified) or null (could not tell).
 */
export async function checkRealNameGate(input: {
  userId: string
  accessToken: string
  verify: () => Promise<boolean | null>
}): Promise<string | null> {
  const key = JSON.stringify([input.userId, input.accessToken])
  const now = Date.now()
  const recent = cached?.key === key && cached.expires > now ? cached : undefined

  // A verdict already reached for this identity: reuse it until it expires.
  if (recent && !recent.pending) return recent.message

  const pending = recent?.pending ?? input.verify()
  if (!recent) {
    cached = { key, expires: now + RECHECK_INTERVAL_MS, message: REAL_NAME_UNVERIFIED_MESSAGE, pending }
  }

  const verified = await pending
  if (cached?.key === key) cached.pending = undefined

  if (verified === true) {
    cached = undefined
    return null
  }
  const message = verified === false ? REAL_NAME_REQUIRED_MESSAGE : REAL_NAME_UNVERIFIED_MESSAGE
  if (cached?.key === key) cached.message = message
  return message
}
