import * as vscode from "vscode"
import {
  KILO_EXTENSION_ID,
  REQUIRED_API_VERSION,
  type KiloExtensionApi,
  type KiloTaskStateChangeEvent,
} from "./types"

export type KiloConnectionFailureCode = "missing" | "activation-failed" | "incompatible"

export type KiloConnection =
  | { ok: true; api: KiloExtensionApi }
  | { ok: false; code: KiloConnectionFailureCode; detail: string }

export interface KiloApiValidation {
  api?: KiloExtensionApi
  problem?: "not-an-object" | "missing-apiVersion" | "unsupported-apiVersion" | "missing-event"
  foundVersion?: number
}

/**
 * Validates the shape of the value exported by Kilo Code's `activate()`.
 * The notifier never guesses: a version or field it does not recognize is an
 * error, not a best-effort subscription.
 */
export function validateKiloApi(exports: unknown): KiloApiValidation {
  if (typeof exports !== "object" || exports === null) {
    return { problem: "not-an-object" }
  }
  const candidate = exports as Record<string, unknown>
  const version = candidate["apiVersion"]
  if (typeof version !== "number") {
    return { problem: "missing-apiVersion" }
  }
  if (!Number.isInteger(version) || version !== REQUIRED_API_VERSION) {
    return { problem: "unsupported-apiVersion", foundVersion: version }
  }
  const event = candidate["onDidChangeTaskState"]
  if (typeof event !== "function") {
    return { problem: "missing-event", foundVersion: version }
  }
  return {
    api: {
      apiVersion: version,
      onDidChangeTaskState: event as KiloExtensionApi["onDidChangeTaskState"],
      ...(typeof candidate["getCurrentTasks"] === "function"
        ? { getCurrentTasks: candidate["getCurrentTasks"] as KiloExtensionApi["getCurrentTasks"] }
        : {}),
    },
  }
}

/**
 * Locates and activates Kilo Code, then validates its exported API.
 * Never throws; every failure is returned as a diagnostic.
 */
export async function connectToKilo(): Promise<KiloConnection> {
  const extension = vscode.extensions.getExtension<KiloExtensionApi>(KILO_EXTENSION_ID)
  if (!extension) {
    return {
      ok: false,
      code: "missing",
      detail: `Kilo Code (${KILO_EXTENSION_ID}) is not installed. Install Kilo Code, then reload the window.`,
    }
  }
  let exports: unknown
  try {
    exports = await extension.activate()
  } catch (error) {
    return {
      ok: false,
      code: "activation-failed",
      detail: `Kilo Code failed to activate: ${error instanceof Error ? error.name : "unknown error"}`,
    }
  }
  const validation = validateKiloApi(exports)
  if (validation.api) return { ok: true, api: validation.api }
  switch (validation.problem) {
    case "not-an-object":
      return {
        ok: false,
        code: "incompatible",
        detail: `Kilo Code did not export a public API. This notifier requires Kilo Code with task-state API version ${REQUIRED_API_VERSION}.`,
      }
    case "missing-apiVersion":
      return {
        ok: false,
        code: "incompatible",
        detail: `Kilo Code's public API has no apiVersion field. This notifier requires Kilo Code with task-state API version ${REQUIRED_API_VERSION}.`,
      }
    case "unsupported-apiVersion":
      return {
        ok: false,
        code: "incompatible",
        detail: `Kilo Code exports task-state API version ${validation.foundVersion}, but this notifier requires version ${REQUIRED_API_VERSION}. Update Kilo Code or this notifier.`,
      }
    case "missing-event":
    default:
      return {
        ok: false,
        code: "incompatible",
        detail: `Kilo Code's public API is missing the onDidChangeTaskState event (apiVersion ${REQUIRED_API_VERSION} required). Update Kilo Code.`,
      }
  }
}

/**
 * Subscribes to Kilo's task-state event. Listener errors are contained so a
 * notifier bug can never disrupt Kilo's event dispatch to other consumers.
 */
export function subscribeToKiloTaskState(
  api: KiloExtensionApi,
  listener: (event: KiloTaskStateChangeEvent) => void,
  onError?: (error: unknown) => void,
): vscode.Disposable {
  let subscription: vscode.Disposable | undefined
  try {
    subscription = api.onDidChangeTaskState((event) => {
      try {
        listener(event)
      } catch (error) {
        onError?.(error)
      }
    })
  } catch (error) {
    onError?.(error)
  }
  return subscription ?? new vscode.Disposable(() => {})
}
