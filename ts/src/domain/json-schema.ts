import { Schema } from "effect";
import { TargetConfigSchema } from "./schema.js";

// Derived from the shared boundary schema, so the JSON Schema artifact and
// the decoder can never disagree (module 11).
export const targetJsonSchemaDocument = Schema.toJsonSchemaDocument(TargetConfigSchema);
