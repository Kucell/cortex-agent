"use strict";

function hasPiSettledSignal(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) return false;

  return stdout.split(/\r?\n/).some((line) => {
    try {
      const event = JSON.parse(line);
      return event && event.type === "agent_settled";
    } catch (_) {
      return false;
    }
  });
}

module.exports = { hasPiSettledSignal };
