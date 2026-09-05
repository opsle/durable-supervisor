# Durable Supervisor

Durable Supervisor V0.1 is an experimental, repository-local control plane for
bounded agent work. It asks a simple question: what if intelligence were used
for decisions, while ordinary software handled persistence, waiting, process
lifecycle, and evidence transport?

This repository contains a working, tested V0.1 vertical slice. It is not a
production service or a published installable package.

## Durable does not mean continuously inferring

The supervisor may remain available in its Herdr workspace, but an open
session does not imply a running model turn. `task run` now writes an immutable
repository-local Runner request. The command returns after durable
request publication; the host opsled validates that exact request and launches
the transient Runner. Once worker ownership is established, the supervisor is
logically `DORMANT`. The worker owns the child, heartbeat, timeout, evidence, verification,
Context Firewall packet, Acceptance, terminal event, claim release, and wake
queue. There is no foreground or repository-dispatcher execution path.

Task creation and launch require each deterministic and verification command to
be a nonempty argv array of strings. After the provider process closes, Runner
durably records its exact process result before verification or any other
fallible post-processing. A later Runner failure publishes intervention evidence
without publishing a false `CHILD_COMPLETION`. Runner outcome and child outcome
remain separate: an exact failed worker can coexist with an unknown child.

Only terminal completion, failure, timeout/stall, or intervention can enter the
wake queue. Heartbeats, wrapper yields, timeouts, and nonterminal returns remain
ineligible. One host-level `opsled` scans every registered repository's durable
queue independently of Runner and supervisor turns. Requests remain immutable
and receipt-free until confirmed delivery, so service restart or a request
arriving between scans cannot lose the wake.

Automatic delivery fails closed unless the ephemeral
`codex-session-binding/v3` current pointer proves the exact repository,
supervisor generation, Codex session/thread UUID, rollout `session_meta` and
inode, installed CLI, UID, authoritative Herdr frontend
process/workspace/pane/terminal.
Status, liveness, reconstruction, and dispatch refresh that pointer from two
consistent read-only Herdr snapshots, exact pane-process facts, and the unique
Codex rollout. Replacement is atomic and prior pointers remain immutable. An
unprovable refresh installs an `INVALID` pointer with no usable session,
rollout, or host values. The canonical transport is
plain `codex resume SESSION_ID MESSAGE` in a temporary process group. Opsled
submits immediately even while the bound session has an active turn; Codex owns
that short-term serialization. The PTY launcher keeps the frontend alive until the bound
rollout contains one exact accepted message and its matching turn-began record.
It then terminates the temporary group and proves no new matching frontend
remains. Normal dispatch never calls terminal input or a Herdr prompt primitive.

Before any supported native send, an opsled-owned activation lease fences the
supervisor generation, service/process, event, expiry, and monotonic token.
An atomic per-event activation decision is the exactly-once boundary. A busy
supervisor is not a delivery gate. Stale or rejected sessions fail closed, and
any outcome uncertain after spawn is durably `UNCERTAIN` and is never
automatically replayed. The transmitted
message contains only event ID, generation, and an instruction to read durable
state. A delivered terminal wake has separate immutable, delivery- and
generation-fenced consumption evidence, and task evaluation is blocked until
it is consumed. Historical wake request and delivery bytes are immutable. Stale-generation and
already-evaluated requests are classified obsolete rather than adopted.

Herdr is the authoritative host, but the Herdr adapter remains read-only: it
never submits prompt or terminal input. `codex resume` is a session transport,
separate from host input. The authoritative state
is the structured data under `.opsle/`. If SSH, the Codex process, or the
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
- Requirement-aware task creation, evaluation, recovery, status, reconstruction,
  cutover, and next-action derivation share one effective-requirements boundary.
  Bootstrap authority is only `matrix` or `none`: a matrix is validated and used
  generically, while `none` leaves any retained historical matrix inert.
- The Context Firewall keeps raw artifacts out of the normal return path and
  emits a bounded, provenance-linked packet. Raw evidence remains available
  for targeted escalation.
- Every completed model child adds one versioned receipt to its durable
  completion handoff. The receipt projects the actual Gearbox decision and
  rationale plus the already-produced Context Firewall raw, retained, and
  reduction measurements. `opsle status` renders the compact receipt directly,
  and `opsle evidence show ATTEMPT_ID` exposes the same durable projection and
  provenance locators without copying raw payloads into the operator view.
- Receipt values identify their evidence as `MEASURED`, `DERIVED`,
  `ESTIMATED`, or `UNAVAILABLE`. Current byte measurements are measured or
  derived; token counts remain null and unavailable rather than being inferred
  from bytes. Deterministic-command completions do not create model receipts.
  Retained bytes use the Context Firewall measurement projection; separately
  measured serialized-packet bytes remain distinct in the receipt.
- Context Firewall reduction is mandatory Runner behavior, not a policy option.
- Child exit, verification, Acceptance, and the supervisor's objective-level
  decision are separate states. A successful process exit is not correctness.
- Humans can inspect status without model inference, pause future progression,
  change the objective or prospective policy, and resume explicitly.

The model-child receipt addresses the DS-V0.1-01 operator-visibility boundary.
It does not close DS-V0.1-02 and makes no token, cost, retry, first-pass,
avoidable-intelligence, or total-savings claim.

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
installer. When the CLI is available, `opsle init` initializes an ordinary Git
repository without changing tracked project content or copying this repository.
It records neutral `none` requirements authority and does not invent a
requirement matrix or objective. Use `opsle init --objective TEXT` to record an
initial objective explicitly. Pre-seeded specification/matrix repositories keep
generic `matrix` semantics. Initialization
fails closed if an authoritative supervisor already exists.

`opsle --version` works outside initialized repositories. It reports the short
package version, immutable runtime release ID, complete normalized package
artifact SHA-256, and source/build revision when known. Every CLI and detached
helper verifies `release-manifest.json`, the complete declared package payload,
and every helper entrypoint digest before acting.

## Runtime identity boundary

Process identity is exactly PID plus process start ticks plus executable path;
PID alone never proves a live owner. Content and release identity use the
immutable complete packaged-artifact SHA-256 rather than a mutable path, version
label, generation, nonce, lease, or fencing token. New host coordination must
reuse the race-safe host lock and may add another ownership identifier only when
a named concurrent writer and a proof that these identities are insufficient
exist.

Registry, service lifecycle, and the bounded future-upgrade primitive use one
host lock. Its owner record contains exact process identity, stale takeover is
an atomic rename, retries are bounded, and cleanup verifies the owner before
removal. `opsled upgrade --release PATH` verifies and installs the complete
artifact under its digest, stops the exact current service, inventories
transient processes per repository, runs the target release's real repository
migrations, switches the managed pointer, and starts that installed release.
When a managed service conflicts with an invoking release, `UPGRADE_REQUIRED`
reports distinct managed/current and invoking roots and artifact digests,
including conflicts between builds with the same semantic version.

Detached Runner and wake helpers carry a release fence over release ID,
complete artifact digest, runtime epoch, helper role, and exact helper
PID/start/executable identity. The wake fence retains the prior implementation
hash as an additional historical and transition check. A superseded or
mismatched helper retires before ownership, child launch, delivery, or durable
mutation.

## Operate and recover

The [mobile-safe operator runbook](docs/OPERATIONS.md) covers initialization,
status/watch, pause/resume, objective and policy changes, recovery, and
evidence inspection. After `/clear` or compaction, `resume-packet generate`
emits the canonical bounded model-facing reconstruction. A genuine new
activation uses `resume-packet generate --recover`, reconciling first without
exposing broad recovery output. The path does not replay chat history, ingest
append-only logs or raw evidence, or silently retry uncertain work.
Complete packets carry a semantic freshness fence over decision-relevant
objective, task, decision, pause, unresolved/wake, policy, generation, and
session authority. A stale cache is replaced and returned from the fresh packet
already computed by that validation pass; telemetry-only timestamps are ignored.

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
Codex resume delivery, activation leases, and activation telemetry. Herdr
prompt APIs remain unused. Capability
Discovery records the presence and revision of
related Opsle sibling repositories, but this repository does not import their
implementations.

Affected Verification is `advisory_only` and did not authorize reduced testing.
Semantic Edit, continuous trajectory ingestion, distributed locking, a scheduler, a
web UI, and production deployment are deferred. Codex and Claude configured
availability, model, reasoning effort, and review mode remain repository-local.
Gearbox reads that configuration and executable discovery directly without
persisting derived eligibility or rejection layers.

`opsled` is a repository-shipped implementation of a single host service. Its
atomic host registry has exactly one mapping per repository realpath and stores
only operational paths and identifiers. Registration writes the repository's
single host-ownership pointer, including its Herdr workspace/pane and current
session-binding pointer. The service and helpers fence release
ID, complete artifact digest, runtime epoch, role, and PID/start/executable
before repository state access. A stopped or upgraded service leaves each
repository's queued requests intact for restart-safe replay. Repository
supervisors and Runner workers enqueue terminal requests but never keep wake
infrastructure alive. Blocking wake transports are transient opsled workers, so
one repository cannot block another. Historical dispatcher records remain
readable but cannot become current authority.
Delivery commitment and consumption recheck the complete ownership vector:
repository, event, delivery and activation fence, supervisor identity and
generation, current session/host binding, queue version, opsled owner, and wake
worker content digest. Rejected consumption leaves all durable bytes unchanged.

The repository-local transport is deterministically covered for binding refresh,
rollout confirmation, cleanup, busy-session queueing, uncertainty, fencing, idempotency, and
pause-after-current ordering. Legacy v2 bindings migrate deterministically on
the first exact refresh; frontend replacement does not create a supervisor
identity or advance its generation.

Host setup remains explicit and local; no permanent service is installed:

```sh
./bin/opsled.js register /path/to/repository
./bin/opsled.js start
./bin/opsled.js status
./bin/opsled.js status --verbose
./bin/opsled.js status --json
```

## License

Apache-2.0. See [LICENSE](LICENSE).
