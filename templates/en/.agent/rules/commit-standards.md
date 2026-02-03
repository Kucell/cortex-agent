# Git Commit Standards

## Guidelines
1. **Atomic Commits**: Each commit should contain only one logical change.
2. **Standardized Messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/) specification.
3. **Scoped**: Use `scope` to reflect the affected module or directory (e.g., `core`, `ui`, `api`).

## Message Format
Format: `<type>(<scope>): <subject>`

### Common Types
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code (white-space, formatting, etc)
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `perf`: A code change that improves performance
- `test`: Adding missing tests or correcting existing tests
- `chore`: Changes to the build process or auxiliary tools and libraries

### Language Convention
- `subject`: Provide a clear and concise description in **English**.
- `body`: For complex changes, provide a detailed summary of changes and motivation in the body.

## Pre-commit Checklist
- Has the code been formatted (e.g., Prettier)?
- Has type checking been performed (e.g., TypeScript)?
- Have unit tests been run and passed?
