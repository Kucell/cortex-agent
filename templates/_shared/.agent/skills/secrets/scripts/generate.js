"use strict";

// ─── secrets generate (cryptographic random secret generator) ──────────────────
// Minimal-invasive add-on for the existing `secrets` skill.
//
// Why this lives as its own module instead of folding into ACTIONS + 4 backends:
//   1. `generate` has a different semantic shape from store/get/rotate/delete:
//      it produces a NEW secret (no `ref` lookup, no backend resolve). It
//      does not consult or write to keychain / gpg / secret-service / env.
//   2. The output is a random token intended for callers to STORE themselves
//      via `secrets store --ref <r> --from-env <NAME>`. We do not auto-store.
//   3. Keeping it pure-Node (node:crypto only) means it has zero backend
//      coupling — no shell-out, no spawnSync, no spawn shenanigans.
//   4. The downstream consumer redacts via redact.js (imported), so accidental
//      shell-history or log leaks are scrubbed before they leave the process.
//
// Threat model:
//   - randomBytes() pulls from OpenSSL CSPRNG (getrandom / /dev/urandom / BCryptGenRandom).
//   - `encoding` defaults to `hex` (compact, URL-safe, no quoting).
//   - `length` is the BYTE count (not hex chars). hex doubles the output width.
//   - We never log the value at INFO/WARN/ERROR; DEBUG must opt-in.
//
// Usage:
//   node generate.js [--bytes N] [--encoding hex|base64|base64url] [--print]
//   node generate.js --bytes 32 --encoding base64url     # 32 random bytes, urlsafe
//
// Output (JSON):
//   {"ok":true, "action":"generate", "bytes":32, "encoding":"hex", "value":"<redacted>",
//    "length_chars": 64}
//   Use --print to receive the raw value on stdout (caller is responsible for
//   not echoing it back to a shared log).
//
// Exit codes:
//   0 — success
//   1 — invalid args (encoding / bytes)
//   2 — RNG failure (should never happen on a healthy CSPRNG)

const crypto = require("node:crypto");

const VALID_ENCODINGS = new Set(["hex", "base64", "base64url"]);
const DEFAULT_BYTES = 32;
const MAX_BYTES = 4096;

function flag(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function hasFlag(name, argv) {
  return argv.includes(name);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function parsePositiveInt(label, raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) {
    emit({ ok: false, error: "invalid_int", detail: `${label} must be a positive integer, got '${raw}'` });
    return null;
  }
  return n;
}

function generate({ bytes = DEFAULT_BYTES, encoding = "hex" } = {}) {
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_BYTES) {
    return { ok: false, error: "invalid_bytes", detail: `bytes must be 1..${MAX_BYTES}, got ${bytes}` };
  }
  if (!VALID_ENCODINGS.has(encoding)) {
    return { ok: false, error: "invalid_encoding", detail: `encoding must be one of: ${[...VALID_ENCODINGS].join(", ")}` };
  }
  let buf;
  try {
    buf = crypto.randomBytes(bytes);
  } catch (err) {
    return { ok: false, error: "rng_failure", detail: err && err.message };
  }
  const value = buf.toString(encoding);
  return { ok: true, action: "generate", bytes, encoding, value, length_chars: value.length };
}

function main(argv = process.argv.slice(2)) {
  const wantPrint = hasFlag("--print", argv);
  const bytesRaw = flag("--bytes", argv);
  const encodingRaw = flag("--encoding", argv);

  let bytes = DEFAULT_BYTES;
  if (bytesRaw !== null) {
    const parsed = parsePositiveInt("bytes", bytesRaw);
    if (parsed === null) {
      process.exit(1);
    }
    bytes = parsed;
  }

  const encoding = (encodingRaw || "hex").toLowerCase();
  const result = generate({ bytes, encoding });
  if (!result.ok) {
    emit(result);
    process.exit(1);
  }

  // Default: redact value in the JSON envelope. Caller can still use it via --print.
  if (!wantPrint) {
    const envelope = { ...result, value: `${REDACT_PLACEHOLDER}(len=${result.length_chars})` };
    emit(envelope);
  } else {
    emit(result);
  }
  process.exit(0);
}

const REDACT_PLACEHOLDER = "<cortex-redacted>";

module.exports = { generate, main, VALID_ENCODINGS, DEFAULT_BYTES, MAX_BYTES };

if (require.main === module) {
  main();
}
