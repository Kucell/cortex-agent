"use strict";

const { createLocalCortexClient } = require("../sdk/local-client.js");
const {
  createConnectedProjectHealthProducer,
} = require("../project-registry");
const {
  createProjectPlatformReadModel,
} = require("./project-read-model.js");

function createLocalProjectPlatformReadModel(ctx) {
  const client = createLocalCortexClient(ctx);
  const project = client.project.resolve();
  if (!project || !project.root) {
    const error = new Error("Unable to resolve local Cortex project root");
    error.code = "ERR_PROJECT_READ_MODEL_ROOT";
    throw error;
  }
  return createProjectPlatformReadModel({
    client,
    healthProvider: createConnectedProjectHealthProducer(project.root),
  });
}

module.exports = {
  createLocalProjectPlatformReadModel,
};
