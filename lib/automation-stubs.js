"use strict";

const cliContract = require("./cli-contract");

const PHASE_ZERO_AUTOMATION_COMMANDS = new Set(["dispatch", "daemon", "trigger"]);

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function helpPayload(command, contract) {
  return {
    ok: true,
    command,
    phase: 0,
    status: "stub",
    implemented: false,
    side_effects: false,
    contract,
  };
}

function executionPayload(command) {
  return {
    ok: false,
    command,
    phase: 0,
    status: "not_implemented",
    implemented: false,
    side_effects: false,
    error: {
      code: "PHASE_ZERO_STUB",
      message: `${command} is reserved by the Phase 0 contract and is not implemented.`,
    },
    next_step: `cortex-agent help ${command} --json`,
  };
}

function phaseZeroAutomation(ctx) {
  const { args, command, lang } = ctx;
  if (!PHASE_ZERO_AUTOMATION_COMMANDS.has(command)) {
    throw new Error(`Unsupported Phase 0 automation command: ${command}`);
  }

  const contract = cliContract.commands.find((entry) => entry.name === command);
  const json = args.includes("--json");
  if (args.includes("--help") || args.includes("-h")) {
    if (json) printJson(helpPayload(command, contract));
    else {
      console.log(`Usage: cortex-agent ${contract.usage}`);
      console.log(lang === "zh"
        ? "Phase 0 契约 stub：仅供发现，尚未实现执行，也不会写入运行态。"
        : "Phase 0 contract stub: discovery only; execution and runtime writes are not implemented.");
    }
    return;
  }

  if (json) printJson(executionPayload(command));
  else console.error(lang === "zh"
    ? `cortex-agent ${command}: Phase 0 契约 stub，尚未实现；未写入任何运行态。`
    : `cortex-agent ${command}: Phase 0 contract stub; not implemented and no runtime state was written.`);
  process.exitCode = 2;
}

module.exports = { phaseZeroAutomation };
