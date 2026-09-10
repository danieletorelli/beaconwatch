export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "BeaconWatch", version: "0.1.0" },
  paths: {
    "/targets": { get: {} },
    "/status": { get: {} },
    "/incidents/{id}": {
      get: {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: {
              type: "string",
              pattern: "^incident_[a-z0-9][a-z0-9_-]*$",
            },
          },
        ],
      },
    },
    "/checks": { get: {} },
  },
};
