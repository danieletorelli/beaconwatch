import { it } from "@effect/vitest"
import { Effect } from "effect"
import { targetJsonSchemaDocument } from "../../src/domain/json-schema.js"

it.effect("derives a JSON Schema document for the existing Target domain schema", () =>
  Effect.sync(() => {
    if (targetJsonSchemaDocument.dialect !== "draft-2020-12") throw new Error("unexpected dialect")
    const root = targetJsonSchemaDocument.schema as { readonly $ref?: string }
    const definitionName = root.$ref?.replace("#/$defs/", "")
    if (!definitionName) throw new Error("Target schema should reference its encoded definition")
    const schema = targetJsonSchemaDocument.definitions[definitionName] as { readonly type?: unknown; readonly required?: ReadonlyArray<string>; readonly properties?: Record<string, unknown> } | undefined
    if (!schema) throw new Error("Target encoded definition is missing")
    if (schema.type !== "object") throw new Error("Target schema should be an object")
    if (!schema.properties?.id || !schema.properties.url || !schema.properties.enabled) throw new Error("missing expected Target properties")
    if (!schema.required?.includes("id") || !schema.required.includes("url")) throw new Error("missing expected required keys")
  })
)
