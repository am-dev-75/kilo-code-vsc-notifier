import * as vscode from "vscode"
import { connectToKilo, subscribeToKiloTaskState } from "./kiloApi"
import {
  formatTaskMessage,
  isValidBotToken,
  sendTelegramMessage,
  type TelegramDeliveryResult,
} from "./notifier"
import { DEFAULT_MINIMUM_TRANSITION_INTERVAL_MS, TransitionGate, type NotifierSettings } from "./transitions"
import { CONFIG_NAMESPACE, OUTPUT_CHANNEL_NAME, SECRET_KEY, type KiloTaskStateChangeEvent } from "./types"

const CMD_SET_BOT_TOKEN = "kiloTelegramNotifier.setBotToken"
const CMD_SEND_TEST_NOTIFICATION = "kiloTelegramNotifier.sendTestNotification"

interface NotifierRuntimeSettings extends NotifierSettings {
  chatId: string
  includeWorkspaceName: boolean
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)
  context.subscriptions.push(channel)
  const log = (line: string) => channel.appendLine(`[${new Date().toISOString()}] ${line}`)
  const logError = (value: unknown) =>
    log(`error: ${value instanceof Error ? value.message : String(value)}`)

  const gate = new TransitionGate()

  const readSettings = (): NotifierRuntimeSettings => {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE)
    const get = <T>(key: string, fallback: T): T => {
      const value = config.get<T>(key, fallback)
      return value === undefined || value === null ? fallback : value
    }
    return {
      enabled: get("enabled", true),
      chatId: String(get("chatId", "")).trim(),
      notifyOnDone: get("notifyOnDone", true),
      notifyOnError: get("notifyOnError", true),
      notifyOnNeedsInput: get("notifyOnNeedsInput", true),
      includeWorkspaceName: get("includeWorkspaceName", true),
      minimumTransitionIntervalMs: Math.max(
        0,
        get("minimumTransitionIntervalMs", DEFAULT_MINIMUM_TRANSITION_INTERVAL_MS),
      ),
    }
  }

  const workspaceName = (): string =>
    vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name ?? "unknown"

  /**
   * The single delivery path for real and test notifications. Fire-and-forget
   * safe: a Telegram failure is logged and returned, never thrown, and can
   * never block or disrupt the Kilo task that triggered it.
   */
  const deliver = async (
    event: KiloTaskStateChangeEvent,
    settings: NotifierRuntimeSettings,
  ): Promise<TelegramDeliveryResult> => {
    const botToken = (await context.secrets.get(SECRET_KEY)) ?? ""
    const text = formatTaskMessage(event, workspaceName(), settings.includeWorkspaceName)
    const result = await sendTelegramMessage({ botToken, chatId: settings.chatId, text })
    if (result.ok) {
      log(`delivered ${event.state} notification for task ${event.taskId}`)
    } else {
      log(`failed to deliver ${event.state} notification for task ${event.taskId}: ${result.error}`)
    }
    return result
  }

  const onTaskStateChange = (event: KiloTaskStateChangeEvent): void => {
    try {
      const settings = readSettings()
      const decision = gate.shouldNotify(event, settings)
      if (!decision.notify) {
        log(`skip task ${event.taskId}: ${decision.reason}`)
        return
      }
      log(`notify task ${event.taskId}: ${decision.reason}`)
      void deliver(event, settings).catch(logError)
    } catch (error) {
      logError(error)
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_SET_BOT_TOKEN, async () => {
      const input = await vscode.window.showInputBox({
        password: true,
        prompt: "Enter the Telegram bot token you created with @BotFather",
        placeHolder: "123456789:AA...",
        ignoreFocusOut: true,
      })
      if (input === undefined) return
      const token = input.trim()
      if (!token) {
        void vscode.window.showErrorMessage("Kilo Telegram Notifier: the bot token must not be empty.")
        return
      }
      if (!isValidBotToken(token)) {
        void vscode.window.showErrorMessage(
          "Kilo Telegram Notifier: that does not look like a Telegram bot token. Expected the <numbers>:<characters> value from @BotFather.",
        )
        return
      }
      await context.secrets.store(SECRET_KEY, token)
      log("bot token stored in VS Code SecretStorage")
      void vscode.window.showInformationMessage(
        "Kilo Telegram Notifier: bot token stored in VS Code SecretStorage.",
      )
    }),
    vscode.commands.registerCommand(CMD_SEND_TEST_NOTIFICATION, async () => {
      const settings = readSettings()
      const botToken = await context.secrets.get(SECRET_KEY)
      if (!botToken) {
        void vscode.window.showWarningMessage(
          "Kilo Telegram Notifier: the bot token is missing. Run 'Kilo Telegram: Set Bot Token' first.",
        )
        return
      }
      if (!settings.chatId) {
        void vscode.window.showWarningMessage(
          "Kilo Telegram Notifier: the chat ID is missing. Set kiloTelegramNotifier.chatId in your settings.",
        )
        return
      }
      const event: KiloTaskStateChangeEvent = {
        taskId: "test",
        state: "done",
        title: "Test notification from Kilo Telegram Notifier",
        timestamp: new Date().toISOString(),
      }
      const result = await deliver(event, settings)
      if (result.ok) {
        void vscode.window.showInformationMessage("Kilo Telegram Notifier: test notification sent.")
      } else {
        void vscode.window.showWarningMessage(`Kilo Telegram Notifier: ${result.error}`)
      }
    }),
  )

  // Connect once after startup. Failures never crash the extension host:
  // they are logged to the output channel and surfaced with a single warning.
  let warned = false
  void connectToKilo().then(
    (connection) => {
      if (connection.ok) {
        log(`connected to Kilo Code task-state API version ${connection.api.apiVersion}`)
        const subscription = subscribeToKiloTaskState(connection.api, onTaskStateChange, logError)
        context.subscriptions.push(subscription)
        return
      }
      log(`Kilo connection failed (${connection.code}): ${connection.detail}`)
      if (!warned) {
        warned = true
        void vscode.window.showWarningMessage(`Kilo Telegram Notifier: ${connection.detail}`)
      }
    },
    (error) => logError(error),
  )
}

export function deactivate(): void {}
