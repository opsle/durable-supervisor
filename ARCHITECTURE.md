# Architecture

Durable Supervisor separates reasoning from mechanical lifecycle work. One
repository has one authoritative supervisor identity. The supervisor decides
what should happen and evaluates evidence; deterministic code persists state,
routes bounded work, waits for processes, and transports results.

## Control and evidence flow

```text
                     human
                       |
          objective / policy / pause
                       v
              durable supervisor
                       |
                 authorization
                       |
              structured handoff
                       |
       discovery -> policy -> Gearbox
                       |
                  claim/fence
                       |
                     Runner
                /                 \
      deterministic tool       Codex child
                \                 /
                 raw durable evidence
                       |
                  verification
                       |
                Context Firewall
                       |
              completion handoff
                       |
                   Acceptance
                       |
              supervisor decision
                       |
                   .opsle ledger
```

The outbound path controls authority and intelligence expenditure. The inbound
path controls how much execution detail enters the next decision.

## Implemented components

| Boundary | V0.1 implementation |
| --- | --- |
| Durable supervisor | One identity and generation in `.opsle/supervisor.json`; objective, policy, and lifecycle state are separate durable files. |
| Agent State Ledger | Repository-local JSON plus append-only event and decision JSONL logs. |
| Authorization | `may`, `may_modify`, and `may_not` fields in every durable task handoff and attempt policy snapshot. |
| Verifiable handoff | Task JSON is authoritative input; completion JSON distinguishes claim, deterministic observations, unknowns, provenance, and evidence references. |
| Capability Discovery | Deterministic executable and sibling-revision discovery in `src/pipeline.js`. Presence does not imply permission or integration. |
| Gearbox | A local, inspectable routing adapter chooses a predeclared deterministic command when adequate, otherwise an enabled Codex route. Disabled providers are ineligible. |
| Claims/fencing | One active task claim with a monotonically increasing fence generation; conflicting acquisition fails closed. |
| Runner | `src/runner.js` launches the process, records PID and heartbeat, captures raw artifacts, enforces timeout, blocks until process close, and writes the completion event. |
| Context Firewall | A local reducer creates a bounded packet with completeness, measured bytes, changed-file scope, verification result, hashes, and raw references. |
| Decision evidence | Completion handoff separates child claims from deterministic observations and unknowns. |
| Acceptance | Deterministic criteria gate the attempt before a separate supervisor accept/reject decision can advance requirements. |
| Human controls | Deterministic CLI status/watch, pause/resume, objective revisions, policy changes, evidence display, and tmux helpers. |
| Telemetry | Durable route, wait, duration, byte, heartbeat, and polling fields; unavailable token and cost values remain unknown. |

## State ownership

`.opsle/specification.md` and `.opsle/requirements.json` define the complete
contract. `.opsle/objective.json`, `policy.json`, `supervisor.json`, and
`state.json` hold current authority. Tasks, attempts, claims, events, decisions,
and evidence provide reconstructable history.

README prose and model context are not parsed to recover authority. Raw child
transcripts are evidence artifacts, not routine supervisor input.

Supervisor and child lifecycles are independent:

- Supervisor: `ACTIVE`, `DORMANT`, or `PAUSED`.
- Child: `QUEUED`, `LAUNCHING`, `RUNNING`, a terminal state, or `UNKNOWN`.

The Runner sets the supervisor to `DORMANT` before the bounded process runs.
After process close it persists raw evidence, verification, the compact packet,
completion handoff, Acceptance result, and completion event before returning the
supervisor to `ACTIVE` or applying a requested pause.

## Recovery and duplicate prevention

Fresh activation reconstructs status from the durable identity, objective,
policy, requirements, task, attempt, decisions, and state. The `recover`
command itself reconciles the existing identity, state, and active attempt. It
increments the existing supervisor generation; it does not create another
identity.

For a durable active attempt, recovery does not relaunch a known terminal child.
If its PID is alive, the claim is preserved and no duplicate is launched. If
the PID is absent without terminal evidence, the attempt becomes `UNKNOWN`,
automatic progression pauses, and reconciliation is required. No retry is
inferred from process absence.

tmux provides a predictable interactive session name and attach/start helpers.
It is not an ownership lock or a state store.

## Adapter and deferred boundaries

The V0.1 adapters preserve the conceptual seams of the broader Opsle research,
but do not pretend to import every sibling prototype:

- sibling Gearbox, Context Firewall, wakeup, decision-evidence, handoff,
  Affected Verification, and profiler repositories are only discovered and
  revision-recorded;
- wakeup is currently the local blocking OS close event plus durable completion
  event, not an external notification service;
- Context Firewall and Gearbox are narrow local implementations intended to be
  replaceable;
- Affected Verification remains advisory and cannot waive established tests;
- Semantic Edit and full trajectory-profiler integration are deferred;
- provider policy represents Claude, but current policy disables it and review
  is off;
- multi-host, multi-repository, distributed, web, scheduler, deployment, and
  automatic merge concerns are outside V0.1.

This architecture is an experimental single-host vertical slice, not a
production-readiness claim.
