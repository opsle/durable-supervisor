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
| Gearbox | A local, inspectable routing adapter is the sole selector. It chooses a predeclared deterministic command when adequate, otherwise an enabled Codex route. `route_hint` is advisory only. Disabled providers are ineligible. The v3 decision contains an exact-route v2 contract with provider/model/effort, execution class, an explicit selected tool (`none` for tool-free Codex), tool and skill allowlists, and web/MCP/plugin/subagent/review/fallback permissions. Snapshot v3 requires this contract; immutable snapshot v1/v2 artifacts retain historical validation. |
| Supervisor-local routing | `src/supervisor-routing.js` performs metadata-only discovery and persists exact decisions under `.opsle/supervisor-routing/`. Category matches are non-authoritative. Direct source inspection is the default; optional skills/tools are denied until a current decision selects one exact capability and records both routing rationales. Instruction loading is post-selection and metadata-fenced. This does not alter child routing. |
| Claims/fencing | One active task claim with a monotonically increasing fence generation; conflicting acquisition fails closed. |
| Runner | `src/runner.js` defaults to a detached repository-local worker. A durable PID/nonce/fence handshake completes before the launcher returns; the worker enforces the exact snapshotted route, then owns child PID, heartbeat, timeout, evidence, verification, Context Firewall, Acceptance, claim release, pause-after-current, terminal event, and wake creation. |
| Event-driven wakeup | `src/wakeup.js` queues only terminal/intervention events and maintains one persistent detached provider-free dispatcher. Observation is registered before the receipt-free scan. Requests have no expiry and never bind a frontend. Stale/evaluated requests are obsolete without byte mutation. Session validation, activation leases, per-event decision CAS, receipts, consumption, and telemetry are durable and idempotent. Heartbeat and nonterminal progress remain ineligible. |
| Supervisor/session boundary | Durable supervisor identity is separate from `codex-session-binding/v2`, which binds repository, generation, Codex UUID, rollout metadata/inode, CLI version, UID, and exact authoritative Herdr process/workspace/pane/terminal facts. A live old tmux authority invalidates the binding. Normal dispatch uses only plain Codex resume; Herdr and tmux input APIs remain unused. |
| Context Firewall | A local reducer creates bounded child-result packets with completeness, measured bytes, changed-file scope, verification result, hashes, and raw references. |
| Authoritative reconstruction | `src/reconstruction.js` reduces current repository-local authority to canonical `resume-packet/v1` JSON. It validates objective, task, attempt, claim/fence, pause, terminal, session-binding, and wake relationships without reading append-only history. The packet is capped at 4,000 bytes/characters and 1,000 clearly estimated tokens; telemetry is separate. |
| Decision evidence | Completion handoff separates child claims from deterministic observations and unknowns. |
| Acceptance | Deterministic criteria gate the attempt before a separate supervisor accept/reject decision can advance requirements. |
| Human controls | Deterministic CLI status/watch, pause/resume, objective revisions, policy changes, evidence display, and tmux helpers. |
| Telemetry | `src/activation-telemetry.js` and the trajectory tool distinguish terminal-event, human, and wait-induced automatic activations. Missing trajectory evidence stays unknown; legacy polling zeros are untrusted. |

## State ownership

`.opsle/specification.md` and `.opsle/requirements.json` define the complete
contract. `.opsle/objective.json`, `policy.json`, `supervisor.json`, and
`state.json` hold current authority. Tasks, attempts, claims, events, decisions,
and evidence provide reconstructable history. `.opsle/resume-packet.json` is a
derived model-facing view, never an independent authority. Reconstruction
telemetry lives separately under `.opsle/evidence/reconstruction/telemetry.json`.

README prose and model context are not parsed to recover authority. Raw child
transcripts are evidence artifacts, not routine supervisor input.

For a tool-none Codex child, Runner creates an attempt-local home containing only
an `auth.json` symbolic link to the existing authentication file, sets it as
`CODEX_HOME`, and deletes the link and directory after process termination.
The CLI launch uses `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, and
`--strict-config`; empty allowlists and disabled feature/config overrides remove
global skills, skill/app/collaboration instructions, web, MCP, plugins,
subagents, and workspace network access. The
exact model and effort are command-line overrides, review stays off, and the
route records `selected_tool: none` and contains no fallback provider. The
durable launch contract records argv, non-secret environment identity, all
denials, and old-versus-isolated prompt bytes. Authentication bytes never enter
that contract.

Supervisor and child lifecycles are independent:

- Supervisor: `ACTIVE`, `DORMANT`, or `PAUSED`.
- Child: `QUEUED`, `LAUNCHING`, `RUNNING`, a terminal state, or `UNKNOWN`.

The default `task run` path persists its wait and detached-worker launch record,
sets the supervisor `DORMANT`, spawns an independent Node worker, and returns
after that worker durably acknowledges exact claim, fence, supervisor, nonce,
and PID ownership. No child process or wait remains attached to the initiating
supervisor turn. `--foreground-wait` deliberately selects the prior blocking
compatibility path.

The detached worker owns the full lifecycle. After process close it persists
the provider process result first, then verification, raw evidence, the compact
packet, completion handoff, Acceptance, claim release, terminal event, the
pending pause-after-current request, and a durable wake request before ensuring one
persistent detached host dispatcher exists. If any post-processing phase fails,
the worker durably records Runner failure, moves an unresolved attempt to
`UNKNOWN`, and publishes an eligible intervention wake without a false child
completion. The supervisor remains `DORMANT` while delivery is queued.
Pause-after-current is applied only after supervisor evaluation and terminal
task state (`ACCEPTED` or `REJECTED`). The dispatcher is independent of the Runner and any supervisor tool
turn. Before deciding that the queue is empty, it registers filesystem
observation and then rechecks receipt-free requests. An event created on either
side of that boundary is therefore observed without polling. With an empty
queue it blocks on that notification; with queued
receipt-free work it blocks on repository notification before re-evaluation,
without expiry or model polling. A busy delivery is narrower: a watcher for the
exact bound rollout is registered before transport, checked immediately against
its file-size baseline, and only an append to that same inode permits retry.

Native delivery is conservative and one-shot after possible acceptance. A
separate authoritative Herdr session binding must revalidate every exact identity
fact and the absence of old tmux authority.
The provider-free activation lease serializes events and fences generation,
dispatcher process, expiry, and monotonic token. An atomic per-event activation
decision is created before transport and is never replayed after uncertainty.
Only event ID, generation, and the durable-state instruction enter the message.
Plain `codex resume` runs in a temporary process group. Exact accepted-message
and matching turn-began rollout records confirm delivery, with hashes over the
complete raw JSONL line bytes; only then is that group terminated and checked
for duplicate frontends. Busy text is classified from live PTY stdout/stderr,
but an already-durable exact rollout confirmation wins. Busy-before-acceptance
is retryable only after an observed exact-bound-rollout append; uncertainty is
not. Legacy tmux
requests remain readable and byte-identical.

## Recovery and duplicate prevention

Fresh activation invokes the deterministic reducer and exposes only its compact
packet to the model. The reducer reads current authority and exact active-work
records, not the specification, event or decision logs, raw evidence, or broad
history. A normal packet is `complete_for_resume`; stale or uncertain facts name
only exact bounded escalation references. Genuine process recovery is performed
before reduction by `resume-packet generate --recover`, so reconciliation output
does not become a separate broad model input. Recovery increments the existing
supervisor generation; it does not create another identity.

For a durable active attempt, recovery does not relaunch a known terminal child.
For detached work, only a live worker whose durable `OWNED` record exactly
matches the attempt, active claim, fence, supervisor identity, launch generation,
and worker PID preserves the claim. A merely live child with a dead or mismatched
worker is an orphan: the attempt becomes `UNKNOWN`, automatic progression pauses,
and reconciliation is required. The explicit foreground compatibility path has
no worker record and retains its direct live-child ownership rule. Recovery
increments the supervisor generation, leaves queued request bytes and targets
unchanged, classifies old requests obsolete, supersedes stale dispatcher
ownership, and starts the current dispatcher. Generation or session drift
requires a fresh authoritative Herdr binding; adoption cannot rewrite the old
record.

The explicit failed-worker reconciler is narrower than ordinary recovery. It
requires a rejected task, an exact `UNKNOWN` attempt with no child terminal
evidence, an exact terminal `FAILED` worker, the matching active or already
failed claim and fence, current supervisor generation, and proof that both
recorded processes are dead. It durably commits `runner_outcome=FAILED` and
`child_outcome=UNKNOWN` before releasing the exact claim as `FAILED`. Repeated
execution preserves the original commit and claim completion time.

tmux provides a predictable interactive session name and attach/start helpers.
It is not an ownership lock or a state store.

## Adapter and deferred boundaries

The V0.1 adapters preserve the conceptual seams of the broader Opsle research,
but do not pretend to import every sibling prototype:

- sibling Gearbox, Context Firewall, wakeup, decision-evidence, handoff,
  Affected Verification, and profiler repositories are only discovered and
  revision-recorded;
- wakeup is a local durable queue and capability-gated native-session boundary driven only by
  terminal/intervention events, not an external notification service;
- Context Firewall and Gearbox are narrow local implementations intended to be
  replaceable;
- Affected Verification remains advisory and cannot waive established tests;
- Semantic Edit and continuous trajectory-profiler ingestion are deferred;
- provider policy represents Claude, but current policy disables it and review
  is off;
- multi-host, multi-repository, distributed, web, scheduler, deployment, and
  automatic merge concerns are outside V0.1.

Herdr 0.8.2 is operationally useful for structured workspace, pane, terminal,
process, agent-status, event, persistence, and multi-client observations. It
does not provide an atomic prompt-idle, human-draft-empty, concurrent-input
exclusion, generation fence, request-deduplication, and Opsle-receipt-coupling
transaction. The Herdr adapter is authoritative but read-only: discovery rejects
any missing, duplicate, or mismatched binding fact, and commit performs no prompt
or pane send call. Session delivery is delegated exclusively to the separately
fenced plain Codex resume transport. The tmux host implementation remains
explicit compatibility code, not the normal automatic dispatcher transport.

This architecture is an experimental single-host vertical slice, not a
production-readiness claim.
