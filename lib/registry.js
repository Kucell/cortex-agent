"use strict";

// 平台描述用对象存储双语，消费方通过 ctx.lang 取值
const PLATFORM_REGISTRY = {
  cursor: {
    name: "Cursor",
    desc: {
      zh: "Cursor IDE，原生斜杠命令 + 规则符号链接",
      en: "Cursor IDE with native slash commands and rules symlinks",
    },
    files: [{ src: "cursor/.cursorrules", dest: ".cursorrules" }],
    links: [
      { target: "../.agent/workflows", link: ".cursor/commands" },
      { target: "../.agent/rules", link: ".cursor/rules" },
      { target: "../.agent/skills", link: ".cursor/skills" },
    ],
    cleanupPaths: [".cursorrules", ".cursor"],
  },
  claude: {
    name: "Claude Code",
    desc: {
      zh: "Claude Code，命令 + 代理 + Hooks 符号链接",
      en: "Claude Code with commands, agents, hooks symlinks",
    },
    files: [{ src: "claude/.clauderules", dest: ".clauderules" }],
    links: [
      { target: "../.agent/workflows", link: ".claude/commands" },
      { target: "../.agent/sub-agents", link: ".claude/agents" },
      { target: "../.agent/plugins", link: ".claude/plugins" },
      { target: "../.agent/hooks", link: ".claude/hooks" },
      { target: ".agent/rules/core-principles.md", link: "CLAUDE.md" },
    ],
    cleanupPaths: [".clauderules", "CLAUDE.md", ".claude"],
    postSetup: "claude-settings",
  },
  windsurf: {
    name: "Windsurf",
    desc: {
      zh: "Windsurf IDE，工作流 + 规则符号链接",
      en: "Windsurf IDE with workflows and rules symlinks",
    },
    files: [{ src: "windsurf/.windsurfrules", dest: ".windsurfrules" }],
    links: [
      { target: "../.agent/workflows", link: ".windsurf/workflows" },
      { target: "../.agent/rules", link: ".windsurf/rules" },
    ],
    cleanupPaths: [".windsurfrules", ".windsurf"],
  },
  aider: {
    name: "Aider",
    desc: {
      zh: "Aider CLI 结对编程工具",
      en: "Aider CLI pair programming tool",
    },
    files: [{ src: "aider/.aider.instructions.md", dest: ".aider.instructions.md" }],
    links: [],
    cleanupPaths: [".aider.instructions.md"],
  },
  copilot: {
    name: "GitHub Copilot",
    desc: {
      zh: "GitHub Copilot 指令文件",
      en: "GitHub Copilot instructions file",
    },
    files: [
      {
        src: "copilot/.github/copilot-instructions.md",
        dest: ".github/copilot-instructions.md",
      },
    ],
    links: [],
    cleanupPaths: [".github/copilot-instructions.md"],
  },
  continue: {
    name: "Continue",
    desc: {
      zh: "Continue VS Code 扩展",
      en: "Continue VS Code extension",
    },
    files: [{ src: "continue/.continuerules", dest: ".continuerules" }],
    links: [],
    cleanupPaths: [".continuerules"],
  },
  cline: {
    name: "Cline",
    desc: {
      zh: "Cline VS Code 扩展（极流行）",
      en: "Cline VS Code extension (very popular)",
    },
    files: [{ src: "cline/.clinerules", dest: ".clinerules" }],
    links: [],
    cleanupPaths: [".clinerules"],
  },
  "roo-code": {
    name: "Roo Code",
    desc: {
      zh: "Roo Code，多模式（Architect/Code/Debug）",
      en: "Roo Code with multi-mode (Architect/Code/Debug)",
    },
    files: [{ src: "roo-code/.roorules", dest: ".roorules" }],
    links: [{ target: "../.agent/rules", link: ".roo/rules" }],
    cleanupPaths: [".roorules", ".roo"],
  },
  "amazon-q": {
    name: "Amazon Q Developer",
    desc: {
      zh: "AWS 官方 AI 编程助手",
      en: "AWS official AI developer assistant",
    },
    files: [
      {
        src: "amazon-q/.amazonq/rules/cortex.md",
        dest: ".amazonq/rules/cortex.md",
      },
    ],
    links: [],
    cleanupPaths: [".amazonq"],
  },
};

const DEFAULT_PLATFORMS = ["cursor", "claude", "windsurf", "cline"];
const BASE_PATHS = [".agent", "AGENTS.md", "GEMINI.md"];
const PLATFORMS_STATE_FILE = ".agent/.platforms";

// 迁移时检测的旧配置文件
const LEGACY_CONFIG_FILES = [
  ".cursorrules",
  ".clauderules",
  "CLAUDE.md",
  ".windsurfrules",
  ".aider.instructions.md",
  ".continuerules",
  ".github/copilot-instructions.md",
  ".clinerules",
  ".roorules",
];

module.exports = {
  PLATFORM_REGISTRY,
  DEFAULT_PLATFORMS,
  BASE_PATHS,
  PLATFORMS_STATE_FILE,
  LEGACY_CONFIG_FILES,
};
