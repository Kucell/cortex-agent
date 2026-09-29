"use strict";

const { normalizeProjectDescriptor, ProjectDescriptorError } = require("./descriptor");

const PROJECT_ADAPTER_CAPABILITIES = Object.freeze([
  "project.discover",
  "project.validation.list",
  "project.validation.run",
  "project.artifact.list",
  "project.event.read",
]);

const METHOD_CAPABILITY = Object.freeze({
  discoverProject: "project.discover",
  listValidationProfiles: "project.validation.list",
  runValidation: "project.validation.run",
  listArtifacts: "project.artifact.list",
  readEvents: "project.event.read",
});

function createProjectAdapter(options = {}) {
  const descriptor = normalizeProjectDescriptor(options.descriptor || {});
  const operations = options.operations || {};
  const declared = new Set(descriptor.capabilities.provided);

  const adapter = { descriptor };
  for (const [method, capability] of Object.entries(METHOD_CAPABILITY)) {
    const implementation = operations[method];
    if (declared.has(capability) && typeof implementation !== "function") {
      throw new ProjectDescriptorError("ERR_PROJECT_OPERATION_MISSING", { method, capability });
    }
    adapter[method] = declared.has(capability)
      ? implementation
      : () => {
          throw new ProjectDescriptorError("ERR_PROJECT_CAPABILITY_UNSUPPORTED", {
            method,
            capability,
          });
        };
  }
  return Object.freeze(adapter);
}

function createDescriptorOnlyProjectAdapter(descriptorInput) {
  const descriptor = normalizeProjectDescriptor(descriptorInput);
  const capabilities = new Set(descriptor.capabilities.provided);
  const operations = {};

  if (capabilities.has("project.discover")) {
    operations.discoverProject = () => descriptor;
  }
  if (capabilities.has("project.validation.list")) {
    operations.listValidationProfiles = () => descriptor.validation.profiles;
  }
  if (capabilities.has("project.artifact.list")) {
    operations.listArtifacts = () => descriptor.artifacts;
  }

  // Pass the original closed-schema input into createProjectAdapter().
  // The normalized descriptor contains the computed project_ref field, which
  // intentionally is not accepted as external manifest input.
  return createProjectAdapter({ descriptor: descriptorInput, operations });
}

module.exports = {
  PROJECT_ADAPTER_CAPABILITIES,
  METHOD_CAPABILITY,
  createProjectAdapter,
  createDescriptorOnlyProjectAdapter,
};
