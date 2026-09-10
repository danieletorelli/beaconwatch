export const targetJsonSchemaDocument = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: [
    "id",
    "name",
    "url",
    "method",
    "expectedStatus",
    "interval",
    "timeout",
    "slowThreshold",
    "enabled",
  ],
  properties: {
    id: { type: "string", pattern: "^target_[a-z0-9][a-z0-9_-]*$" },
    name: { type: "string", minLength: 1 },
    url: { type: "string" },
    method: { enum: ["GET", "POST", "HEAD"] },
    expectedStatus: {
      type: "array",
      minItems: 1,
      items: { type: "integer", minimum: 100, maximum: 599 },
    },
    enabled: { type: "boolean" },
  },
};
