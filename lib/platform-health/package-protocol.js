"use strict";

const path = require("node:path");
const protocol = require("../../packages/protocol/src/index.js");

const PACKAGE_CANDIDATES = Object.freeze([
  "@cortex-agent/protocol",
  "@cortex-agent/sdk",
  "@cortex-agent/runtime-port",
  "@cortex-agent/project-sdk",
  "@cortex-agent/extension-sdk",
  "@cortex-agent/runtime-paseo",
]);

function packageComponent(pkg, now) {
  const isPrivate = pkg.private === true;
  const version = typeof pkg.version === "string" ? pkg.version : "unknown";
  const exportRoot = pkg.exports && Object.prototype.hasOwnProperty.call(pkg.exports, ".");
  const status = !exportRoot
    ? "unhealthy"
    : (isPrivate || version === "0.0.0" ? "degraded" : "healthy");

  return {
    id: `package:${pkg.name}`,
    kind: "package",
    status,
    observed_at: now,
    checks: [
      {
        id: "exports.root",
        status: exportRoot ? "healthy" : "unhealthy",
        message: exportRoot ? "root export is declared" : "root export missing",
        details: { declared: Boolean(exportRoot) },
      },
      {
        id: "publication.readiness",
        status: isPrivate || version === "0.0.0" ? "degraded" : "healthy",
        message: isPrivate || version === "0.0.0"
          ? "package contract exists but publication is not yet enabled"
          : "package is eligible for publication review",
        details: {
          private: isPrivate,
          version,
        },
      },
    ],
    evidence_refs: [],
    redacted: true,
  };
}

function createPackageProtocolHealthProducer(options = {}) {
  const readPackage = options.readPackage;
  if (typeof readPackage !== "function") {
    const error = new Error("package/protocol health producer requires readPackage(name)");
    error.code = "ERR_PACKAGE_HEALTH_READER_REQUIRED";
    throw error;
  }

  return protocol.createHealthProducer({
    id: "cortex.package-protocol",
    kind: "package-protocol",
    version: protocol.PROTOCOL_VERSION,
    async produce(context = {}) {
      const now = context.now || new Date().toISOString();
      const packages = [];
      for (const name of PACKAGE_CANDIDATES) {
        const pkg = await readPackage(name);
        if (!pkg) continue;
        packages.push(packageComponent(pkg, now));
      }

      packages.push({
        id: "protocol:cortex",
        kind: "protocol",
        status: "healthy",
        observed_at: now,
        checks: [
          {
            id: "protocol.current",
            status: "healthy",
            message: "canonical Cortex protocol is available",
            details: {
              protocol: protocol.PROTOCOL_NAME,
              version: protocol.PROTOCOL_VERSION,
            },
          },
        ],
        evidence_refs: [],
        redacted: true,
      });

      return packages;
    },
  });
}

module.exports = {
  PACKAGE_CANDIDATES,
  packageComponent,
  createPackageProtocolHealthProducer,
};
