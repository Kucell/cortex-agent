"use strict";

// ─── Secret / sensitive-info scanner (shared by team publish + PostToolUse) ──
// Pure, side-effect-free scan rules. Fail-closed: each rule returns a structured
// finding with rule id, location (line + column), and a short excerpt; the
// matched value is NEVER returned in the excerpt (side-channel safe).
//
// Consuming layers:
//   - lib/commands.js → team publish / team verify gate
//   - .agent/hooks/pre-commit-check.sh → PostToolUse defense
//
// Adding a rule: append to RULES with id + regex + description. Keep regex
// anchored or use find-all (no global flag mutation across rules).

const RULES = [
  {
    id: "private_key_header",
    description: "PEM / OpenSSH private key header",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    id: "aws_access_key",
    description: "AWS access key id (AKIA prefix)",
    regex: /AKIA[0-9A-Z]{16}/,
  },
  {
    id: "github_pat",
    description: "GitHub personal access token (ghp_)",
    regex: /ghp_[A-Za-z0-9]{20,}/,
  },
  {
    id: "github_oauth",
    description: "GitHub OAuth token (gho_)",
    regex: /gho_[A-Za-z0-9]{20,}/,
  },
  {
    id: "openai_project_key",
    description: "OpenAI project-scoped key (sk-proj-)",
    regex: /sk-proj-[A-Za-z0-9_-]{20,}/,
  },
  {
    id: "openai_secret_key",
    description: "OpenAI secret key (sk-) older format",
    regex: /sk-[A-Za-z0-9]{20,}/,
  },
  {
    id: "slack_token",
    description: "Slack token (xoxb-/xoxp-/xoxa-)",
    regex: /xox[abprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    id: "anthropic_key",
    description: "Anthropic API key (sk-ant-)",
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/,
  },
  {
    id: "url_userinfo",
    description: "URL with embedded username:password",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  },
  {
    id: "env_assignment_token",
    description: "Inline api_key/secret_key/password/token assignment",
    regex: /(api[_-]?key|secret[_-]?key|password|access[_-]?token|auth[_-]?token|private[_-]?token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
  {
    id: "absolute_machine_path",
    description: "Local user absolute path leaked into shared file",
    regex: /(^|[^A-Za-z0-9_])(\/(?:Users|home)\/[A-Za-z0-9._-]+)/,
  },
];

// .env-style body: any line "KEY=VALUE" where VALUE looks non-empty and is not
// quoted/commented. Returned as a single finding per file when present.
const ENV_BODY = {
  id: "env_body",
  description: ".env file with non-empty KEY=VALUE assignment",
  // Matches at start of line: KEY=value where value is non-empty and not a comment.
  regex: /^[ \t]*(?:export\s+)?[A-Z_][A-Z0-9_]*=[^\s#][^\n#]*$/m,
};

function redact(value) {
  if (typeof value !== "string") return "";
  if (value.length <= 16) return "***";
  return `${value.slice(0, 4)}…${value.slice(-2)}(len=${value.length})`;
}

function scanLine(line) {
  const findings = [];
  for (const rule of RULES) {
    if (rule.regex.test(line)) {
      findings.push({ rule_id: rule.id, description: rule.description, excerpt: redact(line) });
    }
  }
  return findings;
}

function scanContent(content, { filePath } = {}) {
  const findings = [];
  if (typeof content !== "string" || content.length === 0) return findings;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const f of scanLine(line)) {
      findings.push({ ...f, file: filePath || null, line: i + 1 });
    }
  }
  if (filePath && /\/\.env$|\.env$|\.env\.[a-z]+$/i.test(filePath) && ENV_BODY.regex.test(content)) {
    findings.push({
      rule_id: ENV_BODY.id,
      description: ENV_BODY.description,
      excerpt: "***",
      file: filePath,
      line: 1,
    });
  }
  return findings;
}

// Wrap fs.readFileSync so callers can scan a real file in one call.
function scanFile(absPath) {
  const fs = require("fs");
  let content;
  try {
    content = fs.readFileSync(absPath, "utf8");
  } catch (error) {
    return [{ rule_id: "read_error", description: error.message, excerpt: "", file: absPath, line: 0 }];
  }
  return scanContent(content, { filePath: absPath });
}

// Severity suggestion for human reports. Never used to bypass fail-closed.
function isHighSeverity(ruleId) {
  return [
    "private_key_header",
    "aws_access_key",
    "github_pat",
    "github_oauth",
    "openai_project_key",
    "openai_secret_key",
    "anthropic_key",
    "slack_token",
    "env_body",
  ].includes(ruleId);
}

module.exports = {
  RULES,
  ENV_BODY,
  scanLine,
  scanContent,
  scanFile,
  isHighSeverity,
  redact,
};