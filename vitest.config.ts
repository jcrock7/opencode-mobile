import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist", ".opencode"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      // Report on every file in scope, not just the ones a test happened to
      // import -- otherwise adding an untested module silently raises the score.
      all: true,
      include: ["src/overlay/**/*.ts", "src/proxy/**/*.ts", "src/push/**/*.ts", "src/tunnel/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        // Type-only modules compile to nothing, so v8 reports them as 0/0.
        "**/types.ts",
        // Barrel files are re-exports with no logic of their own.
        "**/index.ts",
      ],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
});
