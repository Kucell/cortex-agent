# Flows

## Happy Path

```mermaid
sequenceDiagram
    actor User
    participant App
    User->>App: Start workflow
    App-->>User: Show result
```

## State Flow

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Review
    Review --> Approved
```

