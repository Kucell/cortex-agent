# Hook: Pre-Commit Check

## Trigger
This hook fires automatically before a `git commit` completes.

## Purpose
Enforce code quality and prevent common errors from entering the codebase.

## Steps
1. **Identify staged files**: Get the list of all staged files pending commit.
2. **Run linters**: Run the project's configured linting tools (e.g. ESLint, Ruff) against each staged file and check for errors.
3. **Scan for secrets**: Check staged files for hardcoded API keys, tokens, or other sensitive information.
4. **Verify test coverage** (optional): Run a quick coverage check to ensure new code is adequately tested.

## Outcome
- If any step fails, the commit is aborted and an error message explaining the failure is shown to the user.
- If all steps pass, the commit proceeds normally.
