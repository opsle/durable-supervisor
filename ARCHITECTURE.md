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
| Claims/fencing | One active task claim with a monotonically increasing fence generation. Acquisition requires the canonical task and supervisor identity; release and recovery require exact task, attempt, claim, owner, fence, and claim-index agreement. |
| Runner | `src/runner.js` defaults to a detached repository-local worker. A durable PID/nonce/fence handshake completes before the launcher returns; the worker enforces the exact snapshotted route, then owns child PID, heartbeat, timeout, evidence, verification, Context Firewall, Acceptance, claim release, pause-after-current, terminal event, and wake creation. |
| Event-driven wakeup | `src/wakeup.js` queues only terminal/intervention events. One host-level `opsled` drains all registered repository queues; Runner and repository supervisors never own persistent wake infrastructure. Requests have no expiry and never bind a frontend. Stale/evaluated requests are obsolete without byte mutation. Final delivery and consumption revalidate repository, event, delivery/activation fence, supervisor, session/host binding, queue, and implementation identity before mutation. Heartbeat and nonterminal progress remain ineligible. |
| Supervisor/session boundary | Durable supervisor identity is separate from `codex-session-binding/v3`, which binds repository, generation, Codex UUID, rollout metadata/inode, CLI version, UID, and exact authoritative Herdr process/workspace/pane/terminal facts. A live old tmux authority invalidates the binding. Normal dispatch uses only plain Codex resume; Herdr and tmux input APIs remain unused. |
| Context Firewall | A mandatory local reducer creates bounded child-result packets with completeness, measured bytes, changed-file scope, verification result, hashes, and raw references. Disabled policy and disabled launch snapshots fail closed before Runner execution. |
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
and lifecycle consumers obtain current requirements only through the effective
requirements boundary in `src/state.js`; objective-driven repositories ignore
proven foreign historical DS matrices, while malformed or contradictory
authority fails closed.
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

The default `task run` path creates the task attempt and claim, then persists one
immutable Runner request under `.opsle/runner/requests/`. It does not launch a
child. The host opsled validates the registered repository and the exact
supervisor/task/attempt/claim decision, launches the independent Node Runner,
records its PID/start/executable identity, and supervises it. No child process
or wait remains attached to the initiating supervisor turn.
`--foreground-wait` deliberately selects the prior blocking compatibility path.

The detached worker owns the full lifecycle. After process close it persists
the provider process result first, then verification, raw evidence, the compact
packet, completion handoff, Acceptance, claim release, terminal event, the
pending pause-after-current request, and a durable wake request. The host-level
opsled discovers that request from its registry; Runner starts no dispatcher. If any post-processing phase fails,
the worker durably records Runner failure, moves an unresolved attempt to
`UNKNOWN`, and publishes an eligible intervention wake without a false child
completion. The supervisor remains `DORMANT` while delivery is queued.
Pause-after-current is applied only after supervisor evaluation and terminal
task state (`ACCEPTED` or `REJECTED`). Opsled is independent of the Runner and
any supervisor tool turn. It scans immutable receipt-free requests on a bounded
host-service interval; this is process polling, never model polling. Requests
persist across empty scans, service absence, and restart. An already-active
supervisor turn never delays submission: opsled resolves the current binding,
runs plain `codex resume`, and Codex queues the message behind that turn.

Native delivery is conservative and one-shot after possible acceptance. A
separate authoritative Herdr session binding must revalidate every exact identity
fact and the absence of old tmux authority.
The opsled-owned activation lease serializes events and fences generation,
service process, expiry, and monotonic token. An atomic per-event activation
decision is created before transport and is never replayed after uncertainty.
Only event ID, generation, and the durable-state instruction enter the message.
Plain `codex resume` runs in a temporary process group. Exact accepted-message
and matching turn-began rollout records confirm delivery, with hashes over the
complete raw JSONL line bytes; only then is that group terminated and checked
for duplicate frontends. Busy output cannot suppress submission or confirmation,
and the temporary frontend is not terminated while its message remains queued.
Stale-session rejection fails closed; uncertainty after transport start is not
automatically replayed. Legacy tmux
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
unchanged and classifies old requests obsolete. It does not start wake
infrastructure. Generation or session drift
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

## Runtime release and version-skew boundary

`release-manifest.json` is canonical release authority for the local runtime.
It identifies the semantic version, exact source revision, release/runtime
epoch, supported reader/writer/migration versions, every helper and helper
digest, and the complete package file inventory. Its artifact SHA-256 covers
path, mode, length, and bytes for every package file. The manifest participates
in that digest with only its own `packaged_artifact_sha256` value replaced by 64
ASCII zeroes; this normalization is declared in the manifest and avoids a false
self-referential archive claim.

The only state read allowed before compatibility succeeds is the bounded
`.opsle/runtime-compatibility.json` header. A missing header denotes historical
state version 1. A canonical recognized header selects the state version;
unsupported well-formed versions stop as `UPGRADE_REQUIRED`, while parse,
shape, or supported-state failures stop as `CORRUPT`. Core operational I/O and
the CLI/Runner/wake/resume entrypoints enforce the preflight, so rejection
dominates validation, recovery, helper ownership, launch, delivery, mutation,
and authority transitions.

Long-lived helpers are fenced by the verified release ID, complete artifact
digest, runtime epoch, exact helper role, and PID/start/executable identity.
Runner and opsled launch records establish that fence before helper
ownership. Resume transport evidence records the corresponding helper fence
before transport. Wake receipts carry the dispatcher release fence, while the
existing implementation hash remains independently checked for transition and
historical replay. A historical dispatcher record with no release-fence field
is accepted only through the exact-current implementation-hash transition path;
helper ownership itself and every newly launched record require the full
release fence.

## Host-level opsled

`src/opsled.js` is the single host process abstraction. `src/opsled-registry.js`
maintains a canonical, atomically replaced registry under the operating-system
account's fixed state directory. Repository aliases resolve to one realpath-derived ID.
Mappings contain only the repository realpath, host-state path, enabled bit,
and timestamps; objective, policy, task, decision, history, and evidence remain
under that repository's `.opsle` authority.

The service record is established by a PID/start/executable and exact
release/artifact/epoch/role handshake before the worker reads the registry or a
repository. Each repository is processed as an isolated outcome, so corruption,
pause, stale session state, or upgrade requirements in one repository do not
prevent the others from progressing. Queued wakes remain in `.opsle/wake` and
therefore survive opsled restart. Every delivery refreshes the current Herdr
binding, invokes canonical plain `codex resume`, requires exact rollout
acceptance and turn-began evidence, commits the receipt, and leaves consumption
to the resumed repository supervisor.

`src/opsled-runner.js` adds host operational ownership around the existing
detached Runner protocol. It binds repository ID/realpath, task, attempt, claim,
fence generation, worker PID/start/executable, and runtime release. Raw outputs,
Context Firewall evidence, Acceptance, and terminal authority remain in the
repository. Cross-repository host records and stale worker identities fail
closed.

Repository registration also writes `.opsle/host-ownership.json`. This small
pointer binds the repository realpath to one host opsled registry, one Herdr
workspace/pane/terminal, and the repository's current Codex session-binding
pointer. Callers do not select that authority with environment variables,
their current directory, or their current terminal. The repository supervisor
writes immutable requests under `.opsle/runner/requests/`; opsled validates and
executes only those explicit intents. It never selects work from objectives or
tasks.

Blocking wake delivery runs in one transient opsled-owned process per request.
This keeps plain `codex resume` confirmation waits from blocking another
repository's Runner or wake transport.

Runtime releases are verified and installed beneath the canonical host state
directory by immutable artifact digest. Upgrade uses the same host lock,
stops the exact current opsled process before its final inventory, reports
repository inventory failures independently, invokes the target release's
re-runnable durable migrations, switches one current-release pointer, and then
starts the installed target. It does not accept a caller-selected host root.

## Identity constraint

New process ownership uses PID, process start ticks, and executable. New
content or release ownership uses an immutable digest. A new generation,
nonce, lease, fencing token, or ownership ID is prohibited unless its design
names the specific concurrent writer it orders and proves that process identity
and content identity cannot order that writer. Existing live legacy fences are
retained until single-writer opsled ownership makes their removal a separately
proved change.

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
