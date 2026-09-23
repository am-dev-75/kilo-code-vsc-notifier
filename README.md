# kilo-code-vsc-notifier

Telegram notifications for [Kilo Code](https://kilo.ai) tasks in VS Code.

- [`kilo-telegram-notifier/`](./kilo-telegram-notifier) — the companion VS Code
  extension. It subscribes to Kilo Code's versioned public task-state API and
  sends a Telegram message when a task completes, fails, or needs input.
- [`kilo-integration/`](./kilo-integration) — the exact, verified patch for the
  Kilo Code repository that adds the minimal read-only public task-state API
  (`apiVersion: 1`) the notifier consumes, plus full documentation of the
  authoritative event flow found in Kilo Code 7.7.x.

Status: the notifier is complete, tested, and packaged (see its
[README](./kilo-telegram-notifier/README.md) for setup, build, VSIX packaging,
and troubleshooting). The Kilo Code patch in `kilo-integration/` is verified
against Kilo Code `bed1358` but must be applied upstream (and shipped in a
Kilo Code release) before the two work end-to-end; until then the notifier
degrades gracefully with a logged diagnostic and a single warning.

## Quick start

```bash
cd kilo-telegram-notifier
npm install
npm test && npm run build
npm run package   # -> kilo-telegram-notifier-0.1.0.vsix
code --install-extension kilo-telegram-notifier-0.1.0.vsix
```

Then run **Kilo Telegram: Set Bot Token** and set
`kiloTelegramNotifier.chatId`. See the extension README for BotFather setup
and obtaining a chat ID.

License: Apache-2.0
