"use strict";
// JSON.parse silently accepts repeated object keys, losing provenance. Validate
// the token structure first; never turn ambiguous historical data into a plan.
function parse(text) {
  JSON.parse(text); // Built-in grammar validation before the duplicate-key scan.
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || [];
  let at = 0;
  function value(depth) {
    if (depth > 80) throw new Error("JSON_DEPTH_LIMIT");
    const token = tokens[at++];
    if (token === "{") {
      const keys = new Set();
      if (tokens[at] === "}") { at++; return; }
      do {
        const key = JSON.parse(tokens[at++]);
        if (keys.has(key)) throw new Error("DUPLICATE_JSON_KEY");
        keys.add(key); at++; value(depth + 1);
      } while (tokens[at++] === ",");
    } else if (token === "[") {
      if (tokens[at] === "]") { at++; return; }
      do { value(depth + 1); } while (tokens[at++] === ",");
    }
  }
  value(0);
  return JSON.parse(text);
}
module.exports = { parse };
