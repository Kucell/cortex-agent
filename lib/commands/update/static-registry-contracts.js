"use strict";

const fs = require("node:fs");
const path = require("node:path");

function exists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// Code projects omit the general-mode _base layer, but static Registry
// commands are mode-agnostic. Install only missing canonical contracts;
// neither owner policy nor profiles are part of this additive bootstrap.
function addRegistryContracts({ templateDir, agentDest, selectedAdditions, sink }) {
  const source = path.join(path.dirname(templateDir), "_base", ".agent", "agents");
  const directory = path.join(agentDest, "agents");
  if (exists(directory) && fs.lstatSync(directory).isSymbolicLink()) return;
  for (const name of ["agent.schema.json", "README.md"]) {
    const relative = `agents/${name}`;
    const destination = path.join(agentDest, relative);
    if (exists(destination) || selectedAdditions.has(relative)) continue;
    selectedAdditions.add(relative);
    sink.onMissingFile(relative, path.join(source, name), destination, fs.constants.COPYFILE_EXCL);
  }
}

module.exports = { addRegistryContracts };
