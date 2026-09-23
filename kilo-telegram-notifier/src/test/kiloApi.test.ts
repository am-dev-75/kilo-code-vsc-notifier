import { beforeEach, describe, expect, it, vi } from "vitest"
import { connectToKilo, subscribeToKiloTaskState, validateKiloApi } from "../kiloApi"
import { EventEmitter, resetVscodeStub, stubExtension } from "./vscode-stub"
import { KILO_EXTENSION_ID, type KiloExtensionApi, type KiloTaskStateChangeEvent } from "../types"

function change(state: KiloTaskStateChangeEvent["state"], taskId = "session-1"): KiloTaskStateChangeEvent {
  return { taskId, state, timestamp: "2026-09-23T14:35:00.000Z" }
}

beforeEach(() => {
  resetVscodeStub()
})

describe("validateKiloApi", () => {
  it("rejects non-object exports", () => {
    expect(validateKiloApi(undefined).problem).toBe("not-an-object")
    expect(validateKiloApi(null).problem).toBe("not-an-object")
    expect(validateKiloApi("kilo").problem).toBe("not-an-object")
  })

  it("rejects a missing or non-numeric apiVersion", () => {
    expect(validateKiloApi({}).problem).toBe("missing-apiVersion")
    expect(validateKiloApi({ apiVersion: "1" }).problem).toBe("missing-apiVersion")
  })

  it("rejects unsupported api versions with the found version", () => {
    const validation = validateKiloApi({ apiVersion: 2, onDidChangeTaskState: () => ({ dispose: () => {} }) })
    expect(validation.problem).toBe("unsupported-apiVersion")
    expect(validation.foundVersion).toBe(2)
  })

  it("rejects apiVersion 1 without the event", () => {
    expect(validateKiloApi({ apiVersion: 1 }).problem).toBe("missing-event")
  })

  it("accepts apiVersion 1 with a valid event and keeps getCurrentTasks when present", () => {
    const emitter = new EventEmitter<KiloTaskStateChangeEvent>()
    const getCurrentTasks = async () => []
    const validation = validateKiloApi({
      apiVersion: 1,
      onDidChangeTaskState: emitter.event,
      getCurrentTasks,
      someFutureField: true,
    })
    expect(validation.api?.apiVersion).toBe(1)
    expect(validation.api?.getCurrentTasks).toBe(getCurrentTasks)
  })

  it("drops a non-function getCurrentTasks", () => {
    const emitter = new EventEmitter<KiloTaskStateChangeEvent>()
    const validation = validateKiloApi({ apiVersion: 1, onDidChangeTaskState: emitter.event, getCurrentTasks: 5 })
    expect(validation.api?.getCurrentTasks).toBeUndefined()
  })
})

describe("connectToKilo", () => {
  it("reports a missing Kilo Code installation", async () => {
    const connection = await connectToKilo()
    expect(connection).toMatchObject({ ok: false, code: "missing" })
  })

  it("reports Kilo activation failures without throwing", async () => {
    stubExtension(KILO_EXTENSION_ID, undefined, false, new Error("boom during activate"))
    const connection = await connectToKilo()
    expect(connection).toMatchObject({ ok: false, code: "activation-failed" })
  })

  it("reports incompatible exports with an actionable detail", async () => {
    stubExtension(KILO_EXTENSION_ID, { apiVersion: 2 })
    const connection = await connectToKilo()
    expect(connection).toMatchObject({ ok: false, code: "incompatible" })
    if (!connection.ok) expect(connection.detail).toContain("version 1")
  })

  it("connects to a valid Kilo Code API and subscribes to its event", async () => {
    const emitter = new EventEmitter<KiloTaskStateChangeEvent>()
    stubExtension(KILO_EXTENSION_ID, {
      apiVersion: 1,
      onDidChangeTaskState: emitter.event,
      getCurrentTasks: async () => [],
    } satisfies KiloExtensionApi)
    const connection = await connectToKilo()
    expect(connection.ok).toBe(true)

    const listener = vi.fn()
    if (connection.ok) {
      const subscription = subscribeToKiloTaskState(connection.api, listener)
      emitter.fire(change("done"))
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ state: "done" }))
      subscription.dispose()
      emitter.fire(change("running"))
      expect(listener).toHaveBeenCalledTimes(1)
    }
  })

  it("contains listener exceptions so they cannot disrupt Kilo's dispatch", async () => {
    const emitter = new EventEmitter<KiloTaskStateChangeEvent>()
    stubExtension(KILO_EXTENSION_ID, { apiVersion: 1, onDidChangeTaskState: emitter.event })
    const connection = await connectToKilo()
    if (!connection.ok) throw new Error("expected a connection")

    const errors: unknown[] = []
    const good = vi.fn()
    subscribeToKiloTaskState(
      connection.api,
      () => {
        throw new Error("listener bug")
      },
      (error) => errors.push(error),
    )
    emitter.event(good)
    expect(() => emitter.fire(change("error"))).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(good).toHaveBeenCalledWith(expect.objectContaining({ state: "error" }))
  })

  it("returns a inert disposable if the event API itself throws", async () => {
    stubExtension(KILO_EXTENSION_ID, {
      apiVersion: 1,
      onDidChangeTaskState: () => {
        throw new Error("broken event")
      },
    })
    const connection = await connectToKilo()
    const errors: unknown[] = []
    if (connection.ok) {
      const subscription = subscribeToKiloTaskState(connection.api, () => {}, (error) => errors.push(error))
      expect(() => subscription.dispose()).not.toThrow()
      expect(errors).toHaveLength(1)
    }
  })
})
