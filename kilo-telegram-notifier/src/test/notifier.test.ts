import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  formatTaskMessage,
  isValidBotToken,
  redact,
  sendTelegramMessage,
  TELEGRAM_API_BASE,
} from "../notifier"
import type { KiloTaskStateChangeEvent } from "../types"

const TOKEN = "123456789:AAE5tXyFak3dcrhZ0rQ0abcdefghijklmnopqrstuvwxyz"
const CHAT_ID = "987654321"

function event(extra: Partial<KiloTaskStateChangeEvent> = {}): KiloTaskStateChangeEvent {
  return { taskId: "session-1", state: "done", timestamp: "2026-09-23T14:35:00.000Z", ...extra }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  fetchMock.mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 42 } }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function send(overrides: Record<string, unknown> = {}) {
  return sendTelegramMessage({
    botToken: TOKEN,
    chatId: CHAT_ID,
    text: "hello",
    fetchFn: fetchMock as unknown as typeof fetch,
    ...overrides,
  })
}

describe("sendTelegramMessage", () => {
  it("delivers a successful message with the required JSON body", async () => {
    const result = await send()
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${TELEGRAM_API_BASE}/bot${TOKEN}/sendMessage`)
    expect(url.startsWith("https://")).toBe(true)
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: CHAT_ID,
      text: "hello",
      disable_web_page_preview: true,
    })
  })

  it("reports non-2xx HTTP responses", async () => {
    fetchMock.mockResolvedValue(new Response("Forbidden", { status: 404 }))
    const result = await send()
    expect(result.ok).toBe(false)
    expect(result.error).toBe("Telegram API returned HTTP 404")
    expect(result.error).not.toContain(TOKEN)
  })

  it("reports HTTP 200 with Telegram ok: false", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error_code: 400, description: "Bad Request: chat not found" }))
    const result = await send()
    expect(result.ok).toBe(false)
    expect(result.error).toContain("400")
    expect(result.error).toContain("chat not found")
  })

  it("reports network errors without leaking the token", async () => {
    fetchMock.mockRejectedValue(new TypeError(`fetch failed for ${TELEGRAM_API_BASE}/bot${TOKEN}/sendMessage`))
    const result = await send()
    expect(result.ok).toBe(false)
    expect(result.error).toContain("Telegram request failed")
    expect(result.error).not.toContain(TOKEN)
    expect(result.error).toContain("***")
  })

  it("times out after the requested interval", async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted")
            error.name = "AbortError"
            reject(error)
          })
        }),
    )
    const result = await send({ timeoutMs: 25 })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("Telegram request timed out after 25ms")
  })

  it("reports invalid JSON responses", async () => {
    fetchMock.mockResolvedValue(new Response("<html>not json</html>", { status: 200 }))
    const result = await send()
    expect(result.ok).toBe(false)
    expect(result.error).toBe("Telegram API returned an invalid JSON response")
  })

  it("fails safely when the bot token is missing", async () => {
    const result = await send({ botToken: "" })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("bot token is missing")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects malformed bot tokens", async () => {
    const result = await send({ botToken: "123 abc/def" })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("invalid")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails safely when the chat ID is missing", async () => {
    const result = await send({ chatId: "" })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("chat ID is missing")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("makes a single attempt and never retries indefinitely", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"))
    await send()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("token safety", () => {
  it("validates token shape without rejecting BotFather tokens", () => {
    expect(isValidBotToken(TOKEN)).toBe(true)
    expect(isValidBotToken("")).toBe(false)
    expect(isValidBotToken("no colon here")).toBe(false)
    expect(isValidBotToken("123:abc def")).toBe(false) // whitespace would break the URL
    expect(isValidBotToken("123:abc/def")).toBe(false) // path separators must not appear
    expect(isValidBotToken("123:abc?def")).toBe(false)
  })

  it("redacts the token from arbitrary text", () => {
    expect(redact(`boom at ${TELEGRAM_API_BASE}/bot${TOKEN}/sendMessage`, TOKEN)).not.toContain(TOKEN)
    expect(redact("no token present", TOKEN)).toBe("no token present")
  })
})

describe("formatTaskMessage", () => {
  it("renders completion notifications", () => {
    const text = formatTaskMessage(event({ title: "Refactor authentication service" }), "retriva", true)
    expect(text).toBe(
      [
        "✅ Kilo task completed",
        "Task: Refactor authentication service",
        "Workspace: retriva",
        "Time: 2026-09-23T14:35:00.000Z",
      ].join("\n"),
    )
  })

  it("renders failure notifications with safe details", () => {
    const text = formatTaskMessage(
      event({ state: "error", previousState: "running", message: "Integration test command returned a non-zero exit code." }),
      "retriva",
      true,
    )
    expect(text).toContain("❌ Kilo task failed")
    expect(text).toContain("Details: Integration test command returned a non-zero exit code.")
  })

  it("renders needs-input notifications", () => {
    const text = formatTaskMessage(
      event({ state: "needsInput", previousState: "running", message: "Kilo needs permission: bash" }),
      "retriva",
      true,
    )
    expect(text).toContain("⚠️ Kilo task needs input")
  })

  it("falls back to the task ID when no title exists", () => {
    const text = formatTaskMessage(event(), "retriva", true)
    expect(text).toContain("Task: session-1")
  })

  it("omits the workspace line when disabled or unknown", () => {
    expect(formatTaskMessage(event({ title: "T" }), "retriva", false)).not.toContain("Workspace:")
    expect(formatTaskMessage(event({ title: "T" }), undefined, true)).toContain("Workspace: unknown")
  })

  it("truncates long details to 1000 characters", () => {
    const text = formatTaskMessage(event({ message: "x".repeat(5_000) }), "retriva", true)
    const details = text.split("\n").find((line) => line.startsWith("Details:"))
    expect(details?.length).toBeLessThanOrEqual(1_010)
  })

  it("only uses structural event fields, never transcripts", () => {
    const text = formatTaskMessage(event({ title: "T", message: "Kilo needs input: Confirm" }), "w", true)
    for (const forbidden of ["prompt", "transcript", "apiKey", "Bearer "]) {
      expect(text).not.toContain(forbidden)
    }
  })
})
