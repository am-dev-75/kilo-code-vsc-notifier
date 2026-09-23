import type { KiloTaskStateChangeEvent } from "./types"

export const TELEGRAM_API_BASE = "https://api.telegram.org"
export const REQUEST_TIMEOUT_MS = 10_000
export const MAX_DETAILS_LENGTH = 1000

export interface TelegramDeliveryResult {
  ok: boolean
  error?: string
}

export interface SendMessageOptions {
  botToken: string
  chatId: string
  text: string
  /** Injectable for tests; defaults to the Node.js 18+ global fetch. */
  fetchFn?: typeof fetch
  timeoutMs?: number
}

/**
 * BotFather tokens look like `123456789:AAEhV...`. The validation is
 * deliberately light: it must be non-empty, contain exactly one colon,
 * and use only characters that are safe unencoded in a URL path segment.
 */
export function isValidBotToken(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]+$/.test(token)
}

/** Replaces every occurrence of the token with a placeholder. */
export function redact(text: string, token: string | undefined): string {
  if (!token) return text
  return text.split(token).join("***")
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

const HEADERS: Record<string, string> = { "content-type": "application/json" }

/**
 * Sends one message via the Telegram Bot API.
 *
 * Hard requirements honored here:
 *   - HTTPS only; the token appears only in the URL path as `bot<token>`,
 *     never URL-encoded, in a header, a query parameter, or a log line.
 *   - AbortController timeout (~10s), single attempt, no retry loop.
 *   - Both the HTTP status and Telegram's JSON `ok` field are checked.
 *   - Every failure message is redacted, so the token can never leak through
 *     errors, stack traces, or diagnostics.
 *   - Never throws: failures are returned as values.
 */
export async function sendTelegramMessage(options: SendMessageOptions): Promise<TelegramDeliveryResult> {
  const botToken = options.botToken.trim()
  const chatId = options.chatId.trim()
  if (!botToken) return { ok: false, error: "Telegram bot token is missing. Run 'Kilo Telegram: Set Bot Token'." }
  if (!isValidBotToken(botToken)) {
    return { ok: false, error: "Telegram bot token is invalid. Re-run 'Kilo Telegram: Set Bot Token'." }
  }
  if (!chatId) {
    return {
      ok: false,
      error: "Telegram chat ID is missing. Set kiloTelegramNotifier.chatId in your settings.",
    }
  }

  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`
  const body = JSON.stringify({
    chat_id: chatId,
    text: options.text,
    disable_web_page_preview: true,
  })
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (options.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: HEADERS,
      body,
      signal: controller.signal,
    })
    if (!response.ok) {
      return { ok: false, error: `Telegram API returned HTTP ${response.status}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(await response.text())
    } catch {
      return { ok: false, error: "Telegram API returned an invalid JSON response" }
    }
    const payload = parsed as { ok?: unknown; error_code?: unknown; description?: unknown }
    if (payload.ok !== true) {
      const code = typeof payload.error_code === "number" ? ` ${payload.error_code}` : ""
      const description = typeof payload.description === "string" ? `: ${payload.description}` : ""
      return { ok: false, error: `Telegram API error${code}${description}` }
    }
    return { ok: true }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `Telegram request timed out after ${timeoutMs}ms` }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: redact(`Telegram request failed: ${message}`, botToken) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Formats a concise plain-text notification. Only structural, safe fields
 * from the public event are used; no transcripts, prompts, source code,
 * command output, file contents, environment variables, secrets, or stack
 * traces are ever included.
 */
export function formatTaskMessage(
  event: KiloTaskStateChangeEvent,
  workspaceName: string | undefined,
  includeWorkspaceName: boolean,
): string {
  const header =
    event.state === "done"
      ? "✅ Kilo task completed"
      : event.state === "error"
        ? "❌ Kilo task failed"
        : event.state === "needsInput"
          ? "⚠️ Kilo task needs input"
          : `ℹ️ Kilo task ${event.state}`
  const lines = [header, `Task: ${event.title ?? event.taskId}`]
  if (includeWorkspaceName) {
    lines.push(`Workspace: ${workspaceName ?? "unknown"}`)
  }
  if (event.message) {
    lines.push(`Details: ${truncate(event.message, MAX_DETAILS_LENGTH)}`)
  }
  lines.push(`Time: ${event.timestamp}`)
  return lines.join("\n")
}
