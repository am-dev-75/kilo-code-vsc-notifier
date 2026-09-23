import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { activate } from "../extension"
import {
  createStubExtensionContext,
  EventEmitter,
  outputLines,
  resetVscodeStub,
  setConfiguration,
  stubExtension,
  stubbedCommands,
  stubbedMessages,
  stubState,
} from "./vscode-stub"
import type * as vscode from "vscode"
import { KILO_EXTENSION_ID, OUTPUT_CHANNEL_NAME, SECRET_KEY, type KiloTaskStateChangeEvent } from "../types"

const TOKEN = "123456789:AAE5tXyFak3dcrhZ0rQ0abcdefghijklmnopqrstuvwxyz"
const CHAT_ID = "987654321"

function change(
  state: KiloTaskStateChangeEvent["state"],
  extra: Partial<KiloTaskStateChangeEvent> = {},
): KiloTaskStateChangeEvent {
  return { taskId: "session-1", state, timestamp: "2026-09-23T14:35:00.000Z", ...extra }
}

let fetchMock: ReturnType<typeof vi.fn>
let kiloEmitter: EventEmitter<KiloTaskStateChangeEvent>

function configureHappyPath() {
  kiloEmitter = new EventEmitter<KiloTaskStateChangeEvent>()
  stubExtension(KILO_EXTENSION_ID, {
    apiVersion: 1,
    onDidChangeTaskState: kiloEmitter.event,
    getCurrentTasks: async () => [],
  })
  setConfiguration("kiloTelegramNotifier", "chatId", CHAT_ID)
  stubState().secrets.set(SECRET_KEY, TOKEN)
}

function sentBodies(): unknown[] {
  return fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)))
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetVscodeStub({ workspaceName: "retriva" })
  fetchMock = vi.fn()
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("activation and Kilo integration", () => {
  it("logs a diagnostic and shows one warning when Kilo Code is missing", async () => {
    activate(stubbedContext())
    await settle()
    const lines = outputLines(OUTPUT_CHANNEL_NAME)
    expect(lines.some((line) => line.includes("not installed"))).toBe(true)
    const warnings = stubbedMessages().filter((message) => message.kind === "warning")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.text).toContain(KILO_EXTENSION_ID)
  })

  it("shows one warning when Kilo exposes an incompatible API", async () => {
    stubExtension(KILO_EXTENSION_ID, { apiVersion: 2 })
    activate(stubbedContext())
    await settle()
    expect(outputLines(OUTPUT_CHANNEL_NAME).some((line) => line.includes("incompatible") || line.includes("version 1"))).toBe(true)
    expect(stubbedMessages().filter((message) => message.kind === "warning")).toHaveLength(1)
  })

  it("subscribes to real Kilo task-state events and delivers a done notification", async () => {
    configureHappyPath()
    activate(stubbedContext())
    await settle()
    expect(outputLines(OUTPUT_CHANNEL_NAME).some((line) => line.includes("connected to Kilo Code"))).toBe(true)

    kiloEmitter.fire(change("running"))
    kiloEmitter.fire(change("done", { previousState: "running", title: "Refactor authentication service" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`)
    const body = sentBodies()[0] as { chat_id: string; text: string; disable_web_page_preview: boolean }
    expect(body.chat_id).toBe(CHAT_ID)
    expect(body.disable_web_page_preview).toBe(true)
    expect(body.text).toContain("✅ Kilo task completed")
    expect(body.text).toContain("Task: Refactor authentication service")
    expect(body.text).toContain("Workspace: retriva")
    expect(body.text).toContain("Time: 2026-09-23T14:35:00.000Z")
  })

  it("delivers error and needsInput notifications through the same path", async () => {
    configureHappyPath()
    activate(stubbedContext())
    await settle()

    kiloEmitter.fire(change("running"))
    kiloEmitter.fire(change("error", { previousState: "running", message: "ApiError" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect((sentBodies()[0] as { text: string }).text).toContain("❌ Kilo task failed")

    kiloEmitter.fire(change("running", { previousState: "error" }))
    kiloEmitter.fire(change("needsInput", { previousState: "running", message: "Kilo needs permission: bash" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect((sentBodies()[1] as { text: string }).text).toContain("⚠️ Kilo task needs input")
  })

  it("does not send duplicate notifications for repeated identical states", async () => {
    configureHappyPath()
    activate(stubbedContext())
    await settle()

    kiloEmitter.fire(change("running"))
    kiloEmitter.fire(change("done", { previousState: "running" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // Replay with a forged previousState: still not a new transition.
    kiloEmitter.fire(change("done", { previousState: "needsInput" }))
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(outputLines(OUTPUT_CHANNEL_NAME).some((line) => line.includes("repeated state"))).toBe(true)
  })

  it("stays silent for cancelled and for needsInput -> running", async () => {
    configureHappyPath()
    activate(stubbedContext())
    await settle()

    kiloEmitter.fire(change("running"))
    kiloEmitter.fire(change("cancelled", { previousState: "running" }))
    kiloEmitter.fire(change("running", { previousState: "cancelled" }))
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("respects the enabled setting and per-state flags", async () => {
    configureHappyPath()
    setConfiguration("kiloTelegramNotifier", "enabled", false)
    activate(stubbedContext())
    await settle()

    kiloEmitter.fire(change("running"))
    kiloEmitter.fire(change("done", { previousState: "running" }))
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()

    setConfiguration("kiloTelegramNotifier", "enabled", true)
    setConfiguration("kiloTelegramNotifier", "notifyOnDone", false)
    kiloEmitter.fire(change("running"))
    kiloEmitter.fire(change("done", { previousState: "running" }))
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("logs Telegram failures without crashing or blocking the task", async () => {
    configureHappyPath()
    fetchMock.mockRejectedValue(new TypeError("fetch failed"))
    activate(stubbedContext())
    await settle()

    expect(() => kiloEmitter.fire(change("done", { previousState: "running" }))).not.toThrow()
    await vi.waitFor(() =>
      expect(outputLines(OUTPUT_CHANNEL_NAME).some((line) => line.includes("failed to deliver"))).toBe(true),
    )
  })
})

describe("bot token secret handling", () => {
  it("stores the token from the password prompt in SecretStorage only", async () => {
    stubExtension(KILO_EXTENSION_ID, { apiVersion: 1, onDidChangeTaskState: new EventEmitter<KiloTaskStateChangeEvent>().event })
    stubState().inputBoxResult = TOKEN
    activate(stubbedContext())
    await settle()

    await stubbedCommands().get("kiloTelegramNotifier.setBotToken")?.()
    expect(stubState().secrets.get(SECRET_KEY)).toBe(TOKEN)
    expect((stubState().inputBoxOptions as { password?: boolean }).password).toBe(true)
    expect(stubbedMessages().some((message) => message.text.includes("SecretStorage"))).toBe(true)
    // The token must never appear in diagnostics or UI messages.
    for (const line of outputLines(OUTPUT_CHANNEL_NAME)) expect(line).not.toContain(TOKEN)
    for (const message of stubbedMessages()) expect(message.text).not.toContain(TOKEN)
  })

  it("rejects an empty or malformed token without storing anything", async () => {
    stubExtension(KILO_EXTENSION_ID, { apiVersion: 1, onDidChangeTaskState: new EventEmitter<KiloTaskStateChangeEvent>().event })
    activate(stubbedContext())
    await settle()

    stubState().inputBoxResult = "   "
    await stubbedCommands().get("kiloTelegramNotifier.setBotToken")?.()
    stubState().inputBoxResult = "not a token"
    await stubbedCommands().get("kiloTelegramNotifier.setBotToken")?.()
    expect(stubState().secrets.has(SECRET_KEY)).toBe(false)
    expect(stubbedMessages().filter((message) => message.kind === "error")).toHaveLength(2)
  })

  it("never includes the bot token in notification bodies", async () => {
    configureHappyPath()
    activate(stubbedContext())
    await settle()

    kiloEmitter.fire(change("running"))
    kiloEmitter.fire(change("done", { previousState: "running" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.stringify(sentBodies()[0])
    expect(body).not.toContain(TOKEN)
    for (const line of outputLines(OUTPUT_CHANNEL_NAME)) expect(line).not.toContain(TOKEN)
  })
})

describe("test notification command", () => {
  it("explains that the bot token is missing", async () => {
    stubExtension(KILO_EXTENSION_ID, { apiVersion: 1, onDidChangeTaskState: new EventEmitter<KiloTaskStateChangeEvent>().event })
    setConfiguration("kiloTelegramNotifier", "chatId", CHAT_ID)
    activate(stubbedContext())
    await settle()

    await stubbedCommands().get("kiloTelegramNotifier.sendTestNotification")?.()
    const warnings = stubbedMessages().filter((message) => message.kind === "warning")
    expect(warnings.some((message) => message.text.includes("bot token is missing"))).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("explains that the chat ID is missing", async () => {
    stubExtension(KILO_EXTENSION_ID, { apiVersion: 1, onDidChangeTaskState: new EventEmitter<KiloTaskStateChangeEvent>().event })
    stubState().secrets.set(SECRET_KEY, TOKEN)
    activate(stubbedContext())
    await settle()

    await stubbedCommands().get("kiloTelegramNotifier.sendTestNotification")?.()
    const warnings = stubbedMessages().filter((message) => message.kind === "warning")
    expect(warnings.some((message) => message.text.includes("chat ID is missing"))).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends a test notification through the real delivery path", async () => {
    configureHappyPath()
    activate(stubbedContext())
    await settle()

    await stubbedCommands().get("kiloTelegramNotifier.sendTestNotification")?.()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = sentBodies()[0] as { text: string }
    expect(body.text).toContain("Test notification from Kilo Telegram Notifier")
    expect(stubbedMessages().some((message) => message.text.includes("test notification sent"))).toBe(true)
  })
})

function stubbedContext(): vscode.ExtensionContext {
  return createStubExtensionContext() as unknown as vscode.ExtensionContext
}
