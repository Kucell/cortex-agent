"use strict";

function ok(data, meta = {}) {
  return Object.freeze({ ok: true, data, ...meta });
}

function fail(code, message, details = {}, meta = {}) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code, message, details }),
    ...meta,
  });
}

module.exports = { ok, fail };
