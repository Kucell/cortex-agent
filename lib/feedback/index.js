"use strict";

// Public barrel for the P-001 feedback domain. Keeps the public surface
// narrow so consumers (cli routing, templates, hooks) don't reach into
// internal helpers accidentally.

const schema = require("./event-schema");
const redact = require("./redact");
const inbox = require("./inbox");
const config = require("./config");
const commands = require("./commands");
const nudge = require("./nudge");

module.exports = {
  schema,
  redact,
  inbox,
  config,
  commands,
  nudge,
};