# cortex-agent task create

Create a coordination task by publishing a task.created event.

## Usage

    cortex-agent task create --project <path> --event-json <json>

## Required

  --project <path>        Project root directory (default: current working directory).
  --event-json <json>     Coordination event JSON describing the created task.

## Event schema (task.created)

    {
      "eventId": "string",
      "projectId": "string",
      "taskId": "string",
      "correlationId": "string",
      "producer": { "actorId": "string", "kind": "coordinator|agent|system" },
      "targets": [],
      "eventType": "task.created",
      "previousState": null,
      "currentState": "CREATED",
      "timestamp": "ISO-8601",
      "repository": { "repositoryId": "string" },
      "notification": { "policy": "journal_only|notify_parent", "dedupeKey": "string" }
    }

## Options

  --json                  Emit machine-readable JSON.

## Notes

  State is written through the Coordination Application Service; there is no
  arbitrary set_state capability.
  During the legacy-layout compatibility window, task events and ownership
  leases resolve to the same runtime namespace so a task is never split from
  its lease.

## Example

    cortex-agent task create --project . \
      --event-json '{"eventId":"CE-1","projectId":"cortex-agent","eventType":"task.created"}'
