"use strict";

// Test fixture: either ignore HELLO or disconnect while remaining alive.
if (process.argv.includes("--disconnect")) {
  process.once("message", () => { process.disconnect(); });
  setInterval(() => {}, 1000);
} else {
  process.on("message", () => {});
}
