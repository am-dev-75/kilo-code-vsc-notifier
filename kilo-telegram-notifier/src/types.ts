import type * as vscode from "vscode"

/** The exact VS Code extension identifier of Kilo Code (publisher.name). */
export const KILO_EXTENSION_ID = "kilocode.kilo-code"

/** The public Kilo API version this notifier requires. */
export const REQUIRED_API_VERSION = 1

/** SecretStorage key for the Telegram bot token. Never a settings key. */
export const SECRET_KEY = "kiloTelegramNotifier.telegramBotToken"

/** Dedicated output channel for diagnostics and delivery results. */
export const OUTPUT_CHANNEL_NAME = "Kilo Telegram Notifier"

export const CONFIG_NAMESPACE = "kiloTelegramNotifier"

/**
 * Public Kilo task states, mirroring the versioned API contract exposed by
 * Kilo Code's `activate()` (apiVersion 1). UI labels ("Running", "Done", ...)
 * are rendered from these; the notifier never reads UI text.
 */
export type KiloTaskState = "running" | "done" | "error" | "needsInput" | "cancelled"

/** Read-only task-state transition emitted by Kilo Code. */
export interface KiloTaskStateChangeEvent {
  /** The Kilo session the task runs in. */
  taskId: string
  state: KiloTaskState
  previousState?: KiloTaskState
  /** Session title, when known. Never a transcript. */
  title?: string
  /** Short, structural summary (permission or question label, error name). */
  message?: string
  /** ISO-8601 timestamp of the transition. */
  timestamp: string
}

/**
 * Structural, defensive view of the Kilo public API. The notifier validates
 * this shape at runtime before subscribing; unknown extra fields are ignored,
 * and future API versions are rejected rather than guessed at.
 */
export interface KiloExtensionApi {
  readonly apiVersion: number
  readonly onDidChangeTaskState: vscode.Event<KiloTaskStateChangeEvent>
  getCurrentTasks?(): Promise<KiloTaskStateChangeEvent[]>
}
