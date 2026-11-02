"use strict";

// Holds the executor's actual IPC fd 3, without an IPC endpoint or fd 4 secret.
// OS holder enumeration, rather than a fabricated fact source, detects it.
require("node:fs").fstatSync(3);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
process.stdout.write("holding\n");
setTimeout(() => process.exit(2), 20000);
