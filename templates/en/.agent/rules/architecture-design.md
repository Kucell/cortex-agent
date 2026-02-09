# Architectural Design Principles (Template)

Please define core principles according to the project's actual architectural patterns (e.g., MVC, MVVM, Clean Architecture, Hexagonal, etc.).

## Core Design Philosophy

### 1. Separation of Concerns

- **[Rule Description]**: For example, UI separation from business logic, data access separation from service logic.

### 2. [Architectural Pattern Name] (e.g., Hexagonal Architecture)

- **[Rule Description]**: Explain responsibilities of core domain, ports, and adapters.

### 3. [Modularity Principles]

- **[Rule Description]**: Explain how to divide modules and their dependencies (e.g., prohibiting circular dependencies).

### 4. [Interfaces and Contracts]

- **[Rule Description]**: Emphasize programming to interfaces rather than implementations.

## Directory and File Standards

- `src/core/`: Core business logic/domain models.
- `src/api/`: External API calls.
- `src/components/`: Shared UI components.
- `src/utils/`: Utility functions.

## Architecture Review Checklist

- [ ] Does the code follow the predefined hierarchical structure?
- [ ] Is the coupling between modules at a reasonable level?
- [ ] Is there logical overreach (e.g., complex database queries in the UI layer)?
- [ ] Does the new feature follow existing extension patterns?
- [ ] Is there appropriate error handling and logging?
