"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeProjectDescriptor,
} = require("../../packages/project-sdk/src/index.js");

function fail(message, details = {}) {
  const error = new Error(message);
  error.code = "ERR_CONNECTED_PROJECT_VALIDATION";
  error.details = details;
  throw error;
}

function parsePnpmScript(command) {
  const match = /^pnpm\s+([A-Za-z0-9:_-]+)$/.exec(command.trim());
  return match ? match[1] : null;
}

function validateConnectedProject(projectRoot, options = {}) {
  const descriptorPath = path.join(projectRoot, "cortex.project.json");
  const packagePath = path.join(projectRoot, "package.json");

  if (!fs.existsSync(descriptorPath)) fail("cortex.project.json missing", { descriptorPath });
  const rawDescriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
  const descriptor = normalizeProjectDescriptor(rawDescriptor);

  if (descriptor.integration_mode !== "connected") {
    fail("pilot project must use connected integration mode", {
      integration_mode: descriptor.integration_mode,
    });
  }
  if (options.expectProject && descriptor.project_id !== options.expectProject) {
    fail("unexpected project id", {
      expected: options.expectProject,
      actual: descriptor.project_id,
    });
  }
  if (options.expectRepository && descriptor.repository.slug !== options.expectRepository) {
    fail("unexpected repository slug", {
      expected: options.expectRepository,
      actual: descriptor.repository.slug,
    });
  }

  const packageJson = fs.existsSync(packagePath)
    ? JSON.parse(fs.readFileSync(packagePath, "utf8"))
    : null;
  const scripts = packageJson && packageJson.scripts ? packageJson.scripts : {};

  const validationProfiles = descriptor.validation.profiles.map((profile) => {
    const script = parsePnpmScript(profile.command);
    if (!script) {
      fail("pilot only accepts single pnpm script validation commands", {
        profile: profile.id,
        command: profile.command,
      });
    }
    if (!Object.prototype.hasOwnProperty.call(scripts, script)) {
      fail("declared pnpm validation script does not exist", {
        profile: profile.id,
        script,
      });
    }
    return {
      id: profile.id,
      script,
      blocking: profile.blocking,
      command: profile.command,
    };
  });

  const artifacts = descriptor.artifacts.map((artifact) => {
    const absolute = path.resolve(projectRoot, artifact.path);
    const relative = path.relative(projectRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail("artifact escaped project root", { artifact: artifact.id });
    }
    if (!fs.existsSync(absolute)) {
      fail("declared artifact does not exist", {
        artifact: artifact.id,
        path: artifact.path,
      });
    }
    return {
      id: artifact.id,
      path: artifact.path,
      kind: artifact.kind,
    };
  });

  return {
    ok: true,
    project_id: descriptor.project_id,
    project_ref: descriptor.project_ref,
    repository: descriptor.repository.slug,
    integration_mode: descriptor.integration_mode,
    cortex_role: descriptor.boundaries.cortex_role,
    authoritative_domain: descriptor.boundaries.authoritative_domain,
    authoritative_runtime: descriptor.boundaries.authoritative_runtime,
    protected_components: descriptor.boundaries.protected_components,
    validation_profiles: validationProfiles,
    artifacts,
    events: descriptor.events,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const root = args[0] ? path.resolve(args[0]) : process.cwd();
  const projectAt = args.indexOf("--expect-project");
  const repoAt = args.indexOf("--expect-repository");
  const result = validateConnectedProject(root, {
    expectProject: projectAt >= 0 ? args[projectAt + 1] : null,
    expectRepository: repoAt >= 0 ? args[repoAt + 1] : null,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

module.exports = {
  parsePnpmScript,
  validateConnectedProject,
};
