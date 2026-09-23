# Kilo Telegram Notifier

A small VS Code companion extension that sends you a **Telegram message when a
[Kilo Code](https://kilo.ai) task**:

- ✅ completes successfully (`done`),
- ❌ terminates with an error (`error`),
- ⚠️ needs your input (`needsInput`) — a permission decision or an answer.

It subscribes to Kilo Code's **versioned, read-only public task-state API**
(`apiVersion: 1`, exposed by Kilo's `activate()`), not to UI text, webview
content, or output channels.

## Requirements

| Requirement | Value |
| --- | --- |
| Kilo Code extension ID | `kilocode.kilo-code` |
| Kilo task-state API | `apiVersion: 1` (`onDidChangeTaskState`) |
| VS Code | 1.85 or newer |
| Runtime network | outbound HTTPS to `api.telegram.org` |

Kilo Code versions that do not export API version 1 are reported once in a
warning and in this extension's output channel; the notifier then stays dormant
until Kilo Code is updated. See [Kilo API integration](../kilo-integration)
for the exact API contract and the minimal Kilo Code patch that adds it.

## Supported Kilo task states

| Public state | Notifies | Origin (Kilo internal) |
| --- | --- | --- |
| `running` | no | session busy / retry / offline |
| `done` | yes (default) | root session turn closed with reason `completed` |
| `error` | yes (default) | failed turn close (observed `session.error`) |
| `needsInput` | yes (default) | `question.asked` / `permission.asked` (not auto-approved) |
| `cancelled` | no | turn closed with reason `interrupted` / `superseded` |

Repeated identical states never notify twice; `cancelled` never notifies.

## Setup

### 1. Create a Telegram bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, follow the prompts (name and username).
3. BotFather replies with a **bot token** shaped like
   `123456789:AAE5tXyFak3dcrhZ0rQ0...`. You will paste this into VS Code in
   step 3 — it is stored in VS Code **SecretStorage**, never in `settings.json`.

### 2. Get your chat ID

1. Send any message to your new bot in Telegram (press **Start**).
2. Find your numeric chat ID, either:
   - by messaging a chat-ID lookup bot such as @userinfobot, or
   - by opening `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a
     browser and reading `result[0].message.chat.id`.
3. Put the value into the setting `kiloTelegramNotifier.chatId` (or run the
   test notification below, which will tell you what is missing).

For group chats, invite the bot to the group; the group chat ID is negative.

### 3. Store the bot token

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **Kilo Telegram: Set Bot Token**.
3. Paste the token from BotFather. The input box is password-style; the token
   is validated, trimmed, and stored in VS Code SecretStorage under
   `kiloTelegramNotifier.telegramBotToken`.

The token never appears in logs, notifications, error messages, or settings
files.

### 4. Configure the chat ID

Add to your VS Code `settings.json` or use the Settings UI:

```json
{
  "kiloTelegramNotifier.chatId": "123456789"
}
```

### 5. Send a test notification

Run **Kilo Telegram: Send Test Notification** from the Command Palette. It
uses the exact same delivery path as real notifications and tells you whether
the bot token or chat ID is missing.

## Configuration

All settings live in the `kiloTelegramNotifier` namespace:

| Setting | Default | Description |
| --- | --- | --- |
| `kiloTelegramNotifier.enabled` | `true` | Master switch. |
| `kiloTelegramNotifier.chatId` | `""` | Telegram chat ID that receives notifications. |
| `kiloTelegramNotifier.notifyOnDone` | `true` | Notify on task completion. |
| `kiloTelegramNotifier.notifyOnError` | `true` | Notify on task failure. |
| `kiloTelegramNotifier.notifyOnNeedsInput` | `true` | Notify when a task needs input. |
| `kiloTelegramNotifier.includeWorkspaceName` | `true` | Include the workspace name in messages. |
| `kiloTelegramNotifier.minimumTransitionIntervalMs` | `2000` | Duplicate-suppression window per task and destination state. |

The bot token is deliberately **not** a setting; it lives in SecretStorage via
the **Set Bot Token** command.

## How notifications are filtered

A notification is sent only when a Kilo task **transitions into** `done`,
`error`, or `needsInput`:

- `running -> done` notifies; `needsInput -> running` does not.
- `done -> done` (or any repeated identical state) does not notify — verified
  against both the event's `previousState` field and a per-task state map.
- A short per-task suppression window (`minimumTransitionIntervalMs`) absorbs
  event replays; a legitimate later transition outside the window always
  notifies.
- `cancelled` never notifies by default.

Telegram delivery failures (network, timeout, Telegram API errors) are logged
to the output channel and never interfere with the Kilo task itself. There is
no retry loop.

## Building from source

```bash
cd kilo-telegram-notifier
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest (unit tests; no network access needed)
npm run build       # esbuild bundle -> dist/extension.js
```

## Packaging and installing a VSIX

```bash
cd kilo-telegram-notifier
npm run package     # runs vsce package -> kilo-telegram-notifier-<version>.vsix
```

Install it in VS Code:

```bash
code --install-extension kilo-telegram-notifier-0.1.0.vsix
```

or via the UI: Extensions view → `…` → **Install from VSIX…**.

## Troubleshooting

Open the Output panel (`Ctrl+Shift+P` → **Output: Show Output Channel**) and
select **Kilo Telegram Notifier**. Every connection attempt, transition
decision, and delivery result (success or failure) is logged there.

| Symptom | Likely cause |
| --- | --- |
| Warning: "Kilo Code is not installed" | Install `kilocode.kilo-code` and reload the window. |
| Warning: API version mismatch | Update Kilo Code to a version with task-state API v1 (see [kilo-integration](../kilo-integration)). |
| "Telegram API returned HTTP 401" | The bot token is wrong; re-run **Set Bot Token**. |
| "Telegram API error 400: chat not found" | The chat ID is wrong, or you never started a chat with the bot. |
| "request timed out" | `api.telegram.org` is unreachable (network/proxy). |
| Nothing after installing Kilo later | Reload the window; the notifier connects once at startup. |

## Security and privacy limitations

- The bot token is stored only in VS Code SecretStorage and is never logged,
  URL-encoded as a whole, or included in messages, errors, or tests.
- Notification bodies contain only structural fields: task state, task title
  (or task ID), workspace name, a short state summary, and a timestamp.
  **No prompts, transcripts, source code, command output, file contents,
  environment variables, secrets, or stack traces are ever sent.**
- Messages travel over HTTPS to `api.telegram.org` and are therefore stored
  by Telegram according to its privacy policy; keep task titles neutral if
  that matters to you.
- The extension is read-only towards Kilo Code: it subscribes to events and
  never sends data back to Kilo.
