import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli/**", "src/http/openapi.ts", "src/smoke.ts", "src/main.ts", "src/bin.ts", "src/stm/**"],
      // Measured, not assumed: keep the migration coverage measurable.
      // src/stm (StatusBoard) is excluded: it is the intentionally unfixed
      // "before" fixture for the module-16 checkpoint exercise.
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 70
      }
    }
  }
})
