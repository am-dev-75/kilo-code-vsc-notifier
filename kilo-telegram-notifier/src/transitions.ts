import type { KiloTaskState, KiloTaskStateChangeEvent } from "./types"

export const DEFAULT_MINIMUM_TRANSITION_INTERVAL_MS = 2000

/** States that produce a notification; running and cancelled stay silent. */
export const NOTIFIABLE_STATES: ReadonlySet<KiloTaskState> = new Set(["done", "error", "needsInput"])

/** Upper bound for per-task bookkeeping; oldest entries are evicted first. */
const MAX_TRACKED_TASKS = 500

export interface NotifierSettings {
  enabled: boolean
  notifyOnDone: boolean
  notifyOnError: boolean
  notifyOnNeedsInput: boolean
  /** The chat ID is validated during delivery, not here. */
  minimumTransitionIntervalMs: number
}

export interface NotifyDecision {
  notify: boolean
  reason: string
}

function stateFlag(settings: NotifierSettings, state: KiloTaskState): boolean {
  switch (state) {
    case "done":
      return settings.notifyOnDone
    case "error":
      return settings.notifyOnError
    case "needsInput":
      return settings.notifyOnNeedsInput
    default:
      return false
  }
}

/**
 * Transition logic for the notifier:
 *
 *   running -> done/error/needsInput : notify (once)
 *   needsInput -> running            : silent
 *   any -> cancelled                 : silent
 *   repeated identical states        : silent
 *
 * A notification requires a real state change, verified with both the event's
 * own `previousState` field and the gate's per-task state map, plus a
 * per-task duplicate-suppression window for the same destination state. A
 * legitimate later transition outside the window is never suppressed.
 */
export class TransitionGate {
  private readonly lastState = new Map<string, KiloTaskState>()
  private readonly lastNotifiedAt = new Map<string, number>()
  private readonly clock: () => number

  constructor(clock: () => number = Date.now) {
    this.clock = clock
  }

  shouldNotify(event: KiloTaskStateChangeEvent, settings: NotifierSettings, now?: number): NotifyDecision {
    const trackedPrevious = this.lastState.get(event.taskId)
    // Track every state, notifiable or not, so later transitions are judged
    // against the real state history (e.g. needsInput -> running stays silent).
    this.remember(event.taskId, event.state)

    if (!settings.enabled) {
      return { notify: false, reason: "notifications disabled" }
    }
    if (!NOTIFIABLE_STATES.has(event.state)) {
      return { notify: false, reason: `state ${event.state} is not notifiable` }
    }
    if (!stateFlag(settings, event.state)) {
      return { notify: false, reason: `notifications for ${event.state} are disabled` }
    }
    if (event.previousState === event.state) {
      return { notify: false, reason: `repeated state ${event.state} (per event)` }
    }
    if (trackedPrevious === event.state) {
      return { notify: false, reason: `repeated state ${event.state} (per task history)` }
    }
    const at = now ?? this.clock()
    const suppressionKey = `${event.taskId}\u0000${event.state}`
    const lastNotified = this.lastNotifiedAt.get(suppressionKey)
    if (lastNotified !== undefined && at - lastNotified < settings.minimumTransitionIntervalMs) {
      return {
        notify: false,
        reason: `suppressed duplicate ${event.state} within ${settings.minimumTransitionIntervalMs}ms`,
      }
    }
    this.lastNotifiedAt.set(suppressionKey, at)
    return { notify: true, reason: `${trackedPrevious ?? event.previousState ?? "unknown"} -> ${event.state}` }
  }

  private remember(taskId: string, state: KiloTaskState): void {
    if (this.lastState.get(taskId) === state) return
    this.lastState.delete(taskId)
    this.lastState.set(taskId, state)
    this.prune()
  }

  /** Bounded cleanup of the per-task and duplicate-suppression caches. */
  private prune(): void {
    while (this.lastState.size > MAX_TRACKED_TASKS) {
      const oldest = this.lastState.keys().next()
      if (oldest.done) break
      this.lastState.delete(oldest.value)
    }
    const limit = MAX_TRACKED_TASKS * 3
    while (this.lastNotifiedAt.size > limit) {
      const oldest = this.lastNotifiedAt.keys().next()
      if (oldest.done) break
      this.lastNotifiedAt.delete(oldest.value)
    }
  }
}
