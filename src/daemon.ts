// Supervise the proxy so a crash doesn't end the service.
//
// `npm start` (or `node dist/daemon.js`) runs the proxy as a child process and
// relaunches it whenever it exits, with capped exponential backoff. The proxy
// itself already survives the failures we know about (see proxy.ts), so this is
// the last line of defence: an OOM kill, a `process.exit` path, or a stray
// native crash still costs at most a couple of seconds of downtime.
//
// Signals are forwarded, so Ctrl+C stops both processes. The daemon writes its
// pid to `proxy-daemon.pid` in the package root — a stop script must kill the
// supervisor first, because killing only the child would bring it right back.

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { log } from "./config.js"

/** The bits of a child process the supervisor needs (injectable for tests). */
export interface SupervisedChild {
  onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void
  kill: (signal?: NodeJS.Signals) => void
}

export interface SupervisorOptions {
  /** Start (or restart) the proxy. */
  launch: () => SupervisedChild
  /** Set by the signal handlers; the loop exits once the child is gone. */
  shouldStop?: () => boolean
  /** Injected in tests to keep the loop synchronous. */
  delay?: (ms: number) => Promise<void>
  now?: () => number
  initialDelayMs?: number
  maxDelayMs?: number
  /** A run that lasted at least this long counts as healthy and resets the backoff. */
  healthyAfterMs?: number
  onRestart?: (info: {
    attempt: number
    code: number | null
    signal: NodeJS.Signals | null
    uptimeMs: number
    nextDelayMs: number
  }) => void
}

/**
 * Run `launch()` forever, back off between restarts, and return once the child
 * has exited and `shouldStop()` says the shutdown was intentional.
 */
export async function supervise(opts: SupervisorOptions): Promise<void> {
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? (() => Date.now())
  const initialDelayMs = opts.initialDelayMs ?? 1_000
  const maxDelayMs = opts.maxDelayMs ?? 30_000
  const healthyAfterMs = opts.healthyAfterMs ?? 60_000
  const shouldStop = opts.shouldStop ?? (() => false)

  let backoffMs = initialDelayMs
  let attempt = 0

  for (;;) {
    const startedAt = now()
    const child = opts.launch()
    const { code, signal } = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolve) => child.onExit((c, s) => resolve({ code: c, signal: s })))

    // Intentional shutdown: the child is gone, so we are done.
    if (shouldStop()) return

    const uptimeMs = now() - startedAt
    // A long run was healthy — start the backoff over instead of letting a
    // single crash late in the day inherit an inflated delay.
    if (uptimeMs >= healthyAfterMs) backoffMs = initialDelayMs
    attempt++

    opts.onRestart?.({ attempt, code, signal, uptimeMs, nextDelayMs: backoffMs })
    await delay(backoffMs)
    if (shouldStop()) return
    backoffMs = Math.min(backoffMs * 2, maxDelayMs)
  }
}

/** Where the supervisor records its pid (package root, not the caller's cwd). */
export function daemonPidFilePath(): string {
  return path.join(fileURLToPath(new URL("..", import.meta.url)), "proxy-daemon.pid")
}

function proxyEntryPath(): string {
  return fileURLToPath(new URL("./proxy.js", import.meta.url))
}

// ---------------------------------------------------------------------------
// Standalone CLI entry: `node dist/daemon.js` supervises `dist/proxy.js`.
// ---------------------------------------------------------------------------

const isDirectRun = (() => {
  try {
    return process.argv[1] && /daemon\.js$/.test(process.argv[1])
  } catch {
    return false
  }
})()

if (isDirectRun) {
  let current: ChildProcess | null = null
  let stopping = false

  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    log.info(`supervisor: ${signal} received, stopping the proxy`)
    // On Windows this terminates the child outright; elsewhere the proxy runs
    // its own graceful shutdown (close the listener, drain in-flight requests).
    current?.kill(signal)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  const pidFile = daemonPidFilePath()
  try {
    fs.writeFileSync(pidFile, String(process.pid))
  } catch (err) {
    log.warn("supervisor: could not write the pid file", { path: pidFile, error: String(err) })
  }

  // Everything after this program name belongs to the proxy (e.g. --port=…).
  const passthrough = process.argv.slice(2)
  log.info(
    `supervisor: watching the proxy (pid ${process.pid}${passthrough.length ? `, args ${passthrough.join(" ")}` : ""})`,
  )

  supervise({
    launch: () => {
      // stdio is inherited so proxy logs land wherever the supervisor's do.
      const child = spawn(process.execPath, [proxyEntryPath(), ...passthrough], {
        stdio: "inherit",
      })
      current = child
      return {
        onExit: (cb) => {
          child.on("exit", (code, signal) => cb(code, signal))
          // A spawn failure (missing dist, no permission) must not look like a
          // silent death: report it as an exit so the supervisor backs off.
          child.on("error", (err) => {
            log.error("supervisor: could not start the proxy", { error: String(err) })
            cb(null, null)
          })
        },
        kill: (signal?: NodeJS.Signals) => {
          child.kill(signal)
        },
      }
    },
    shouldStop: () => stopping,
    onRestart: ({ attempt, code, signal, uptimeMs, nextDelayMs }) => {
      log.warn("supervisor: proxy exited, restarting", {
        attempt,
        code,
        signal,
        uptimeMs,
        nextDelayMs,
      })
    },
  })
    .then(() => {
      try {
        fs.rmSync(pidFile, { force: true })
      } catch {
        /* best effort */
      }
      log.info("supervisor: proxy stopped")
      process.exit(0)
    })
    .catch((err) => {
      log.error("supervisor failed", { error: String(err) })
      process.exit(1)
    })
}