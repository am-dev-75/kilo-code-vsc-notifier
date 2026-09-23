import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^vscode$/,
        replacement: path.resolve(__dirname, "src/test/vscode-stub.ts"),
      },
    ],
  },
  test: {
    include: ["src/test/**/*.test.ts"],
    environment: "node",
  },
})
