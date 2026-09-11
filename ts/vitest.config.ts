import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli/**", "src/http/openapi.ts", "src/smoke.ts", "src/main.ts", "src/bin.ts"],
      // Measured, not assumed: keep the migration coverage measurable.
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60
      }
    }
  }
})
