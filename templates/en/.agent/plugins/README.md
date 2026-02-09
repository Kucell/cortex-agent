# Internal Plugins

## 🎯 Positioning

This directory is used to store **internal** "pluggable" modules that extend the core capabilities of the Agent within the project.

These modules are not intended for cross-project distribution but serve as core capability extensions exclusive to the current project.

## 🔎 Difference from "Distributable Plugins"

It is important to distinguish the purpose of this directory from the concept of "Distributable Plugins" on platforms like Claude Code:

- **Internal Plugins (This directory)**:
  - **Scope**: Limited to the current project.
  - **Integration**: Exist directly as source code within the project structure, loaded and used by the Agent via the `.agent/` directory.
  - **Purpose**: Integrate project-specific tools, connect to internal databases or APIs (e.g., implementing an MCP service), or define complex or shared logic not suitable for `skills`.

- **Distributable Plugins (defined by Claude Code)**:
  - **Scope**: Sharable and reusable across projects and teams.
  - **Integration**: Discovered, installed, and version-managed via a "Marketplace". These are independent packages containing a `plugin.json` manifest file.
  - **Purpose**: Publish general-purpose, standardized capability packages (e.g., a complete set of skills and commands for Git operations).

## 📝 Structure

An internal plugin can be a subdirectory containing configuration files and related scripts. Its structure is flexible and intended to be called by other `skills` or `workflows` within the project.
