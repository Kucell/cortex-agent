"use strict";
// Fixed synthetic v2 entry: argv supplies smaller local limits, never a profile.
const { acceptBoundedSession } = require("../../../lib/coordination/permit-witness-bounded-session");
const maxPayloadBytes = Number(process.argv[2]), maxFrames = Number(process.argv[3]);
const mode = process.argv[4] || "echo";
void (async () => {
  const session = await acceptBoundedSession({ profile: "v2", maxPayloadBytes, maxFrames, allowedOperations: [1],
    handler: (_operation, bytes) => mode === "late"
      ? new Promise(resolve => setTimeout(() => resolve(bytes), 1000)) : bytes });
  await session.ready;
  await session.closed;
})().catch(() => { process.exitCode = 1; });
