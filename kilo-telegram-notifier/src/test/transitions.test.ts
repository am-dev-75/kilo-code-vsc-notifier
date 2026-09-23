import { describe, expect, it } from "vitest"
import {
  DEFAULT_MINIMUM_TRANSITION_INTERVAL_MS,
  TransitionGate,
  type NotifierSettings,
} from "../transitions"
import type { KiloTaskState, KiloTaskStateChangeEvent } from "../types"

function settings(overrides: Partial<NotifierSettings> = {}): NotifierSettings {
  return {
    enabled: true,
    notifyOnDone: true,
    notifyOnError: true,
    notifyOnNeedsInput: true,
    minimumTransitionIntervalMs: DEFAULT_MINIMUM_TRANSITION_INTERVAL_MS,
    ...overrides,
  }
}

function event(
  taskId: string,
  state: KiloTaskState,
  previousState?: KiloTaskState,
  extra: Partial<KiloTaskStateChangeEvent> = {},
): KiloTaskStateChangeEvent {
  return {
    taskId,
    state,
    ...(previousState !== undefined ? { previousState } : {}),
    timestamp: "2026-09-23T14:35:00.000Z",
    ...extra,
  }
}

describe("TransitionGate filtering", () => {
  it("notifies once for running -> done", () => {
    const gate = new TransitionGate(() => 0)
    expect(gate.shouldNotify(event("t1", "done", "running"), settings())).toEqual({
      notify: true,
      reason: "running -> done",
    })
    expect(gate.shouldNotify(event("t1", "done", "running"), settings())).toMatchObject({ notify: false })
  })

  it("notifies once for running -> error", () => {
    const gate = new TransitionGate(() => 0)
    expect(gate.shouldNotify(event("t1", "error", "running"), settings())).toMatchObject({ notify: true })
  })

  it("notifies once for running -> needsInput", () => {
    const gate = new TransitionGate(() => 0)
    expect(gate.shouldNotify(event("t1", "needsInput", "running"), settings())).toMatchObject({ notify: true })
  })

  it("stays silent for needsInput -> running", () => {
    const gate = new TransitionGate(() => 0)
    gate.shouldNotify(event("t1", "needsInput", "running"), settings())
    expect(gate.shouldNotify(event("t1", "running", "needsInput"), settings())).toMatchObject({
      notify: false,
      reason: expect.stringContaining("not notifiable"),
    })
  })

  it("stays silent for done -> done (per event payload)", () => {
    const gate = new TransitionGate(() => 0)
    expect(gate.shouldNotify(event("t1", "done", "done"), settings())).toMatchObject({
      notify: false,
      reason: expect.stringContaining("repeated state done (per event)"),
    })
  })

  it("stays silent for repeated identical states even with a forged previousState", () => {
    const gate = new TransitionGate(() => 0)
    gate.shouldNotify(event("t1", "done", "running"), settings())
    // The event claims needsInput -> done, but the gate remembers the task is
    // already done; the repeat is not a new transition.
    expect(gate.shouldNotify(event("t1", "done", "needsInput"), settings())).toMatchObject({
      notify: false,
      reason: expect.stringContaining("repeated state done (per task history)"),
    })
  })

  it("stays silent for cancelled by default", () => {
    const gate = new TransitionGate(() => 0)
    gate.shouldNotify(event("t1", "running"), settings())
    expect(gate.shouldNotify(event("t1", "cancelled", "running"), settings())).toMatchObject({
      notify: false,
    })
  })

  it("respects per-state configuration flags", () => {
    const gate = new TransitionGate(() => 0)
    expect(gate.shouldNotify(event("t1", "done", "running"), settings({ notifyOnDone: false }))).toMatchObject({
      notify: false,
      reason: expect.stringContaining("notifications for done are disabled"),
    })
    expect(gate.shouldNotify(event("t2", "error", "running"), settings({ notifyOnError: false }))).toMatchObject({
      notify: false,
    })
    expect(
      gate.shouldNotify(event("t3", "needsInput", "running"), settings({ notifyOnNeedsInput: false })),
    ).toMatchObject({ notify: false })
  })

  it("respects the global enabled setting", () => {
    const gate = new TransitionGate(() => 0)
    expect(gate.shouldNotify(event("t1", "done", "running"), settings({ enabled: false }))).toMatchObject({
      notify: false,
      reason: "notifications disabled",
    })
  })

  it("handles unknown states safely", () => {
    const gate = new TransitionGate(() => 0)
    const unknown = event("t1", "running")
    ;(unknown as { state: string }).state = "paused"
    const decision = gate.shouldNotify(unknown, settings())
    expect(decision.notify).toBe(false)
    expect(decision.reason).toContain("not notifiable")
  })
})

describe("TransitionGate duplicate suppression", () => {
  it("suppresses the same destination state within the interval", () => {
    const gate = new TransitionGate(() => 0)
    const s = settings()
    expect(gate.shouldNotify(event("t1", "done", "running"), s, 0).notify).toBe(true)
    expect(gate.shouldNotify(event("t1", "running", "done"), s, 500).notify).toBe(false) // silent anyway
    expect(gate.shouldNotify(event("t1", "done", "running"), s, 1_000).notify).toBe(false) // duplicate window
  })

  it("does not suppress a legitimate later transition outside the window", () => {
    const gate = new TransitionGate(() => 0)
    const s = settings({ minimumTransitionIntervalMs: 2_000 })
    expect(gate.shouldNotify(event("t1", "done", "running"), s, 0).notify).toBe(true)
    gate.shouldNotify(event("t1", "running", "done"), s, 10_000)
    expect(gate.shouldNotify(event("t1", "done", "running"), s, 12_000).notify).toBe(true)
  })

  it("keys suppression per task and destination state", () => {
    const gate = new TransitionGate(() => 0)
    const s = settings()
    expect(gate.shouldNotify(event("t1", "done", "running"), s, 0).notify).toBe(true)
    // Different task: not suppressed.
    expect(gate.shouldNotify(event("t2", "done", "running"), s, 100).notify).toBe(true)
    // Different destination state on the same task: not suppressed.
    expect(gate.shouldNotify(event("t1", "error", "running"), s, 200).notify).toBe(true)
  })

  it("keeps its caches bounded", () => {
    const gate = new TransitionGate(() => 0)
    const s = settings()
    // Far more distinct tasks than the tracking bound; none may throw.
    for (let i = 0; i < 2_000; i++) {
      const decision = gate.shouldNotify(event(`task-${i}`, "done", "running"), s, i)
      expect(decision.notify).toBe(true)
    }
    // A task whose history was evicted is judged fresh, not silently dropped.
    expect(gate.shouldNotify(event("task-0", "running"), s, 100_000)).toMatchObject({ notify: false })
    expect(gate.shouldNotify(event("task-0", "done", "running"), s, 100_001).notify).toBe(true)
  })
})
