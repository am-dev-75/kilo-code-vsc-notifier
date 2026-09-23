/**
 * Test stub for the `vscode` module. Vitest aliases `vscode` to this file
 * (see vitest.config.ts). Tests configure the stub through `stub` /
 * `resetVscodeStub` before importing the modules under test.
 */

export interface StubEventEmitter<T> {
  event(handler: (data: T) => void): { dispose(): void }
  fire(data: T): void
  dispose(): void
}

export class EventEmitter<T> implements StubEventEmitter<T> {
  private readonly handlers = new Set<(data: T) => void>()
  disposed = false
  event = (handler: (data: T) => void) => {
    this.handlers.add(handler)
    return {
      dispose: () => {
        this.handlers.delete(handler)
      },
    }
  }
  fire = (data: T) => {
    for (const handler of this.handlers) handler(data)
  }
  dispose = () => {
    this.disposed = true
    this.handlers.clear()
  }
}

export class Disposable {
  constructor(private readonly callback: () => void = () => {}) {}
  static from(...items: { dispose(): void }[]): Disposable {
    return new Disposable(() => {
      for (const item of items) item.dispose()
    })
  }
  dispose(): void {
    this.callback()
  }
}

interface StubState {
  configuration: Record<string, Record<string, unknown>>
  secrets: Map<string, string>
  extensions: Record<string, { isActive: boolean; exports?: unknown; activationError?: Error } | undefined>
  outputChannels: { name: string; lines: string[] }[]
  commands: Map<string, (...args: unknown[]) => unknown>
  messages: { kind: string; text: string }[]
  inputBoxResult: string | undefined
  inputBoxOptions: unknown
  workspaceName: string | undefined
}

const state: StubState = {
  configuration: {},
  secrets: new Map(),
  extensions: {},
  outputChannels: [],
  commands: new Map(),
  messages: [],
  inputBoxResult: undefined,
  inputBoxOptions: undefined,
  workspaceName: undefined,
}

export function resetVscodeStub(overrides: Partial<StubState> = {}): void {
  state.configuration = {}
  state.secrets = new Map()
  state.extensions = {}
  state.outputChannels = []
  state.commands = new Map()
  state.messages = []
  state.inputBoxResult = undefined
  state.inputBoxOptions = undefined
  state.workspaceName = undefined
  Object.assign(state, overrides)
}

/** Sets a configuration value: setConfiguration("kiloTelegramNotifier", "enabled", false). */
export function setConfiguration(section: string, key: string, value: unknown): void {
  state.configuration[section] = { ...(state.configuration[section] ?? {}), [key]: value }
}

export function stubExtension(
  id: string,
  exports?: unknown,
  isActive = true,
  activationError?: Error,
): void {
  state.extensions[id] = { isActive, exports, activationError }
}

export function stubbedMessages(): { kind: string; text: string }[] {
  return [...state.messages]
}

export function outputLines(name: string): string[] {
  const channel = state.outputChannels.find((item) => item.name === name)
  return channel ? [...channel.lines] : []
}

export function stubbedCommands(): Map<string, (...args: unknown[]) => unknown> {
  return state.commands
}

export function stubState(): StubState {
  return state
}

type ConfigurationLike = {
  get<T>(key: string, fallback: T): T
}

export const workspace = {
  get name(): string | undefined {
    return state.workspaceName
  },
  workspaceFolders: [{ name: "folder" }] as { name: string }[] | undefined,
  getConfiguration: (section: string): ConfigurationLike => ({
    get: <T>(key: string, fallback: T): T => {
      const values = state.configuration[section] ?? {}
      const value = values[key]
      return (value === undefined ? fallback : value) as T
    },
  }),
}

export const window = {
  createOutputChannel: (name: string) => {
    const channel = { name, lines: [] as string[], disposed: false }
    state.outputChannels.push(channel)
    return {
      name,
      appendLine: (line: string) => {
        channel.lines.push(line)
      },
      append: (line: string) => {
        channel.lines.push(line)
      },
      show: () => {},
      hide: () => {},
      clear: () => {
        channel.lines.length = 0
      },
      dispose: () => {
        channel.disposed = true
      },
    }
  },
  showInputBox: async (options: unknown) => {
    state.inputBoxOptions = options
    return state.inputBoxResult
  },
  showInformationMessage: async (text: string) => {
    state.messages.push({ kind: "info", text })
    return undefined
  },
  showWarningMessage: async (text: string) => {
    state.messages.push({ kind: "warning", text })
    return undefined
  },
  showErrorMessage: async (text: string) => {
    state.messages.push({ kind: "error", text })
    return undefined
  },
}

export const commands = {
  registerCommand: (command: string, handler: (...args: unknown[]) => unknown) => {
    state.commands.set(command, handler)
    return new Disposable(() => {
      state.commands.delete(command)
    })
  },
}

export const extensions = {
  getExtension: (id: string) => {
    const entry = state.extensions[id]
    if (!entry) return undefined
    return {
      get isActive() {
        return entry.isActive
      },
      get exports() {
        return entry.exports
      },
      activate: async () => {
        if (entry.activationError) throw entry.activationError
        entry.isActive = true
        return entry.exports
      },
    }
  },
}

/** Minimal ExtensionContext for tests. */
export function createStubExtensionContext() {
  return {
    subscriptions: [] as { dispose(): void }[],
    secrets: {
      get: (key: string) => Promise.resolve(state.secrets.get(key)),
      store: (key: string, value: string) => {
        state.secrets.set(key, value)
        return Promise.resolve()
      },
      delete: (key: string) => {
        state.secrets.delete(key)
        return Promise.resolve()
      },
    },
  }
}

export default { EventEmitter, Disposable, workspace, window, commands, extensions }
