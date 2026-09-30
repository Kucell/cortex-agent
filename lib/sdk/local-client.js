"use strict";

const { createCortexClient } = require("../../packages/sdk/src/index.js");
const { createLocalTransport } = require("./local-transport.js");

function createLocalCortexClient(ctx) {
  return createCortexClient({
    transport: createLocalTransport(ctx),
  });
}

module.exports = {
  createLocalCortexClient,
};
