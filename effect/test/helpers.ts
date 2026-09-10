import { Duration } from "effect"
import type { TargetConfig, TargetId } from "../src/domain/schema.js"

export const target = (id: string, extra: Partial<TargetConfig> = {}): TargetConfig => ({
  id: id as TargetId,
  name: id,
  url: `http://${id}.test/health`,
  method: "GET",
  expectedStatus: [200],
  interval: Duration.seconds(1),
  timeout: Duration.seconds(1),
  slowThreshold: Duration.millis(500),
  ...extra
} as TargetConfig)
