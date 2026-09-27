import { describe, it, expect } from "vitest"
import { supervise, type SupervisedChild } from "./daemon.js"

// Let the supervisor's promise chain run to the next launch.
const tick = () => new Promise((r) => setImmediate(r))

describe("supervise", () => {
  it("relaunches the proxy after each exit, backing off up to the cap", async () => {
    const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
    const delays: number[] = []
    let launches = 0
    let stop = false

    const running = supervise({
      launch: (): SupervisedChild => {
        launches++
        return { onExit: (cb) => exits.push(cb), kill: () => {} }
      },
      delay: async (ms) => {
        delays.push(ms)
        if (delays.length === 3) stop = true
      },
      shouldStop: () => stop,
      initialDelayMs: 1_000,
      maxDelayMs: 4_000,
    })

    expect(launches).toBe(1)
    // Three crashes: 1s → 2s → 4s (capped), then the loop returns.
    for (let i = 0; i < 3; i++) {
      exits[i](1, null)
      await tick()
    }

    await running
    expect(launches).toBe(3)
    expect(delays).toEqual([1_000, 2_000, 4_000])
  })

  it("returns without relaunching when the shutdown was intentional", async () => {
    let stop = false
    let launches = 0

    await supervise({
      launch: (): SupervisedChild => {
        launches++
        return {
          onExit: (cb) => {
            stop = true
            cb(0, "SIGTERM")
          },
          kill: () => {},
        }
      },
      shouldStop: () => stop,
      delay: async () => {
        throw new Error("must not back off while shutting down")
      },
    })

    expect(launches).toBe(1)
  })

  it("resets the backoff after a run that stayed up past the healthy window", async () => {
    const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
    const delays: number[] = []
    let launches = 0
    let clock = 0
    let stop = false

    const running = supervise({
      launch: (): SupervisedChild => {
        launches++
        return { onExit: (cb) => exits.push(cb), kill: () => {} }
      },
      delay: async (ms) => {
        delays.push(ms)
        if (delays.length === 3) stop = true
      },
      now: () => clock,
      shouldStop: () => stop,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      healthyAfterMs: 60_000,
    })

    // Crash immediately: backoff grows to 2s for the next attempt.
    exits[0](1, null)
    await tick()
    // The second run survives past the healthy window before crashing, so the
    // backoff starts over instead of inheriting the inflated delay.
    clock = 120_000
    exits[1](1, null)
    await tick()
    exits[2](1, null)
    await tick()

    await running
    expect(launches).toBe(3)
    expect(delays).toEqual([1_000, 1_000, 2_000])
  })
})