import { it } from "@effect/vitest"
import { Duration, Equal } from "effect"
import { cloneDuration } from "../../src/domain/clone.js"

it("reconstructs every Duration ADT variant", () => {
  const variants = [Duration.millis(3), Duration.nanos(4n), Duration.infinity, Duration.negativeInfinity]
  const expected = [Duration.millis(3), Duration.nanos(4n), Duration.infinity, Duration.negativeInfinity]
  for (const [index, original] of variants.entries()) {
    const cloned = cloneDuration(original)
    if (!Equal.equals(cloned, expected[index])) throw new Error(`duration variant ${index} changed value`)
  }
})
