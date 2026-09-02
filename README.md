# Durable Supervisor

Durable Supervisor V0.1 is an experimental, repository-local control plane for
bounded agent work. It asks a simple question: what if intelligence were used
for decisions, while ordinary software handled persistence, waiting, process
lifecycle, and evidence transport?

This repository contains a working, tested V0.1 vertical slice. It is not a
production service or a published installable package.

## Durable does not mean continuously inferring

The supervisor may remain available in a terminal or tmux session, but an open
session does not imply a running model turn. `task run` now defaults to a
detached repository-local Runner worker. The command returns after durable
worker ownership is established, while the supervisor remains logically
`DORMANT`. The worker owns the child, heartbeat, timeout, evidence, verification,
Context Firewall packet, Acceptance, terminal event, claim release, and wake
queue. `--foreground-wait` is an explicit compatibility fallback.

Task creation and launch require each deterministic and verification command to
be a nonempty argv array of strings. After the provider process closes, Runner
durably records its exact process result before verification or any other
fallible post-processing. A later Runner failure publishes intervention evidence
without publishing a false `CHILD_COMPLETION`. Runner outcome and child outcome
remain separate: an exact failed worker can coexist with an unknown child.

Only terminal completion, failure, timeout/stall, or intervention can enter the
wake queue. Heartbeats, wrapper yields, timeouts, and nonterminal returns remain
ineligible. A persistent detached provider-free dispatcher watches the durable
queue independently of Runner and supervisor turns. It registers filesystem
observation before every receipt-free queue check, so an event cannot be lost
between the empty decision and watcher registration.

Automatic delivery fails closed unless `codex-session-binding/v2` proves the
exact repository, supervisor generation, Codex UUID, rollout `session_meta` and
inode, installed CLI, UID, authoritative Herdr process/workspace/pane/terminal,
and absence of the old authoritative tmux session. The canonical transport is
plain `codex resume SESSION_ID MESSAGE` in a temporary process group. A
repository-local PTY launcher keeps that frontend alive only until the bound
rollout contains one exact accepted message and its matching turn-began record.
It then terminates the temporary group and proves no new matching frontend
remains. Normal dispatch never calls tmux input or a Herdr prompt primitive.

Before any supported native send, a provider-free activation lease fences the
supervisor generation, dispatcher/process, event, expiry, and monotonic token.
An atomic per-event activation decision is the exactly-once boundary. Live PTY
stdout and stderr classify a resume rejected before rollout acceptance as busy;
it remains queued and may be reclaimed only after the already-registered watcher
observes an append to that exact bound rollout. Any outcome uncertain after
spawn is durably `UNCERTAIN` and is never automatically replayed. The transmitted
message contains only event ID, generation, and an instruction to read durable
state. Historical wake request bytes are immutable. Stale-generation and
already-evaluated requests are classified obsolete rather than adopted.

Herdr is the authoritative host, but the Herdr adapter remains read-only: it
never submits prompt or terminal input. `codex resume` is a session transport,
separate from host input. The tmux host and foreground mechanical wait remain
explicit fallbacks and are not selected by the normal automatic dispatcher.

tmux is only a convenience for interactive attachment. The authoritative state
is the structured data under `.opsle/`. If tmux, SSH, the Codex process, or the
conversation is lost, a fresh context reconstructs from those files. No pasted
conversation summary is required.

## Lifecycle

```text
Human objective or correction
          |
          v
Durable supervisor and authorization
          |
          v
Structured task handoff
          |
          v
Discovery -> policy filter -> Gearbox
          |
          v
Claim/fence -> Runner -> bounded child/tool
                         |
                    OS-level wait
                         |
                         v
Raw evidence -> verification -> Context Firewall
                         |
                         v
Structured completion handoff -> Acceptance
                         |
                         v
Supervisor decision -> durable next action
```

The boundaries are deliberate:

- Conversational context is a disposable reasoning cache; `.opsle` is runtime
  authority.
- Capability Discovery records what exists. Operator policy records what may
  be used. Gearbox alone selects the simplest adequate permitted route. A task
  `route_hint` is advisory classification input and cannot force selection.
- Each Gearbox decision and attempt snapshot preserve one exact child route:
  provider, model, effort, execution class, tool and skill allowlists, and
  web/MCP/plugin/subagent/review/fallback permissions. New artifacts use exact
  route v2, Gearbox decision v3, and policy snapshot v3; historical snapshots
  retain validation under their immutable schema contract.
- Persistent-supervisor optional routing is a separate durable boundary in
  `src/supervisor-routing.js`. Discovery records advertised availability using
  metadata only. A current exact decision is required before any optional skill
  instruction read or capability invocation; static subject/category matches
  are non-authoritative. Narrow source analysis selects direct deterministic
  inspection by default, while OpenAI Docs and web require an exact current-
  external-documentation route. Unselected optional capabilities fail closed.
- Every task has bounded authorization, required evidence, acceptance criteria,
  and prohibited actions.
- Claims and monotonically increasing fence generations prevent an obvious
  duplicate attempt from acquiring the same task concurrently.
- The detached Runner owns launch, heartbeat, capture, timeout, verification,
  terminal publication, wake creation, and the durable wait transition.
- A tool-none Codex route runs with an auth-only per-attempt `CODEX_HOME`, ignores
  user config and rules, uses strict explicit overrides, denies workspace
  network access, suppresses skill, app, and collaboration instructions, and
  disables unselected skills, web, MCP, plugins, subagents, review, and provider
  fallback. Its child prompt omits discovery inventory and
  carries only the bounded task, authorization, exact route, required context,
  acceptance criteria, and selected tool instructions.
- Exact failed-worker reconciliation is generation- and fence-gated, commits the
  Runner failure while preserving an unknown child outcome, then idempotently
  releases the claim as `FAILED`; it never relaunches the rejected task.
- The Context Firewall keeps raw artifacts out of the normal return path and
  emits a bounded, provenance-linked packet. Raw evidence remains available
  for targeted escalation.
- Child exit, verification, Acceptance, and the supervisor's objective-level
  decision are separate states. A successful process exit is not correctness.
- Humans can inspect status without model inference, pause future progression,
  change the objective or prospective policy, and resume explicitly.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the implemented component mapping and
[SPEC.md](SPEC.md) for the public contract summary. Runtime authority remains
the complete [`.opsle/specification.md`](.opsle/specification.md) and its
machine-readable state.

## Local verification

Node.js 20 or newer is required. From the repository root:

```bash
npm test
./bin/opsle.js validate
./bin/opsle.js status
```

The package is currently private and has no supported cross-repository
installer. `opsle init` is for a prepared repository that already contains the
V0.1 specification and requirements matrix; it fails closed if an authoritative
supervisor already exists.

## Operate and recover

The [mobile-safe operator runbook](docs/OPERATIONS.md) covers initialization,
status/watch, pause/resume, objective and policy changes, tmux, recovery, and
evidence inspection. After `/clear` or compaction, `resume-packet generate`
emits the canonical bounded model-facing reconstruction. A genuine new
activation uses `resume-packet generate --recover`, reconciling first without
exposing broad recovery output. The path does not replay chat history, ingest
append-only logs or raw evidence, or silently retry uncertain work.

## Self-hosting evidence

Bootstrap cutover and two meaningful post-cutover Codex tasks are recorded in
the repository. Both post-cutover packets were `complete_for_decision`, passed
their predeclared `npm test` verification, changed no unauthorized files, and
were separately accepted by the supervisor. Their compact packets retained raw
evidence references while omitting hundreds of kilobytes from the normal
decision packet.

The exact task IDs, event IDs, paths, and measured byte counts are in the
[V0.1 self-hosting proof](docs/SELF_HOSTING_PROOF.md). Those measurements are
byte-level evidence reduction only; no token, cost, generalized correctness,
or production-readiness saving is claimed.

## Integration status and limits

V0.1 implements narrow local adapters for Gearbox routing, structured
handoffs, Context Firewall reduction, decision evidence, detached execution,
generation-fenced queued wakeups, authoritative Herdr session binding, plain
Codex resume delivery, activation leases, and activation telemetry. Tmux is an
interactive/compatibility host; Herdr prompt APIs remain unused. Capability
Discovery records the presence and revision of
related Opsle sibling repositories, but this repository does not import their
implementations.

Affected Verification is `advisory_only` and did not authorize reduced testing.
Semantic Edit, an external wakeup service, continuous trajectory
ingestion, multi-repository supervision, distributed locking, a scheduler, a
web UI, and production deployment are deferred. Codex is enabled in the
recorded policy; Claude and independent review remained disabled.

The dispatcher is repository-local and single-host. Its durable record fences
dispatcher ID/generation, supervisor ID/generation, exact PID/start/executable,
and each request queue version. Recovery supersedes stale ownership, starts one
current dispatcher, and leaves prior-generation requests immutable and obsolete.

The repository-local transport is deterministically covered for binding,
rollout confirmation, cleanup, busy, uncertainty, fencing, idempotency, and
pause-after-current ordering. A live binding must still be created explicitly;
the intentionally stale v1 record is not adopted or rewritten automatically.

## License

Apache-2.0. See [LICENSE](LICENSE).
