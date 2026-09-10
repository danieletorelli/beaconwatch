import { Schema } from "effect"
import { Target } from "./schema.js"

export const targetJsonSchemaDocument = Schema.toJsonSchemaDocument(Target)
