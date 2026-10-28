# cortex-agent init

Usage: cortex-agent init [options]

Initialize or refresh the Cortex Agent governance framework in a project
(Code mode, default), or lay down the shared data layer (General mode).

## Usage

    cortex-agent init [options]

## Modes

  --mode <name>, -m <name>   Choose the init profile. When omitted, the CLI
                             auto-detects the best fit from the project:
                             • AGENTS.md present               → general
                             • .cursorrules / copilot-* /      → code
                               package.json present
                             • otherwise                        → general

                             Recognised values:
                             • general   shared data layer only
                             • code      default code-project knowledge
                                        base (templates/{lang}/.agent)

## Language

  --lang <zh|en>, -l <lang>  Template language (default: en).

## Scope

  --global, -g               Install into the user's home directory
                             (~/.agent/) instead of the current project.

## Platforms

  --platforms <list>, -p     Comma-separated list of AI platform
                             integrations to install (claude, cursor,
                             windsurf, gemini, codex, antigravity,
                             cline, roo, qoder, …). Use "all" for every
                             registered platform. When omitted, an
                             interactive picker is shown.

  --update-scripts           Refresh managed L1 scripts in place.

  --force-scripts            Overwrite local L1 script overrides.

## Git tracking

  --track                    Track the generated .agent/ directory in Git
                             (default: untrack and add to .gitignore).

## Diagnostics & repair

  --fix                      Auto-repair common setup issues during init.

  --dry-run                  Report what init would change without writing
                             any files.

  --verify                   Run post-init verification checks.

  --verify-full              Run the full verification suite.

  --report <path>            Write a structured report to <path>.

  --project <name>           Override the project identifier used in the
                             generated manifest.

## Notes

  • `init --help` (and `-h`) prints this contract and exits; it does not
    modify the project. The help dispatcher resolves to .help/init.md
    before any argument validation runs, so missing required flags do not
    block help.

  • Running `init` more than once is safe: it overlays missing templates
    onto the existing .agent/ directory and prints a warning when
    files were already present.

  • Re-running with `--mode code` after a previous general init will
    overlay the code-project knowledge base on top of the data layer.

## Example

    cortex-agent init --mode code --lang zh --track

