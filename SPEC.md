# V0.1 Public Contract

This file explains the checked-in implementation. The complete normative
contract is [`.opsle/specification.md`](.opsle/specification.md), and runtime
truth is the validated machine-readable state under `.opsle/`. README and this
summary are not recovery inputs.

## Scope

V0.1 supervises one Git repository with one authoritative supervisor identity.
It uses ordinary local processes, repository files, an optional tmux session,
and an enabled provider CLI. It does not provide production deployment,
distributed coordination, multi-repository orchestration, a scheduler, or a web
application.

## Durable inputs

A bounded task handoff records:

- task and parent objective identity;
- objective, scope, and explicit authorization;
- required inputs and relevant context;
- expected deliverable and evidence;
- acceptance criteria and prohibited actions;
- requirement IDs, operator constraints, advisory route hint, and optional deterministic
  and verification commands.

At attempt creation, current discovery, provider/review policy, the exact
Gearbox-selected route, authorization, claim/fence, evidence requirements, and
acceptance criteria are copied into an immutable historical policy snapshot.
The exact route includes provider, model, effort, execution class, an explicit
selected tool (`none` when no tool is authorized), tool/skill allowlists, and
web/MCP/plugin/subagent/review/fallback permissions. Later policy
changes are prospective. Newly created artifacts use exact-route v2, Gearbox
decision v3, and policy snapshot v3 and fail closed without a valid
`selected_tool`; immutable v1/v2 snapshots validate against their historical
contracts.

The persistent supervisor uses a distinct exact-supervisor-route contract before
optional capability use. Its durable decision records the task/objective,
selected execution route and tool, selected skill or null, metadata-only
discovery, intelligence/tooling rationale, and the reason direct inspection is
insufficient (or, for the direct route, why it is sufficient). Static category
matching is explicitly non-authoritative. Narrow repository/source analysis
defaults to direct deterministic inspection. Graphify, OpenAI Docs, web, plugins,
MCP, subagents, and other optional capabilities fail closed unless selected
exactly; OpenAI Docs and web additionally require the exact
`current_external_documentation` route. Platform safety mandates remain outside
this optional-routing contract and retain authority. Child route isolation is
unchanged.

## Execution contract

1. Capability Discovery records available commands and sibling revisions.
2. Operator policy makes disabled providers ineligible.
3. Gearbox alone selects an adequate permitted deterministic route or Codex;
   `route_hint` may be recorded for classification but cannot force selection.
4. Claim acquisition fails if the task already has an active claim.
5. The Runner durably registers an explicit bounded wait, establishes detached
   worker ownership, and makes the supervisor logically `DORMANT` before the
   initiating command returns. Foreground waiting requires an explicit
   compatibility flag.
6. The detached worker's OS process wait, not a supervisor turn or model loop,
   detects completion, failure, or timeout and publishes a terminal event.
   A tool-none Codex launch must use an attempt-local `CODEX_HOME` containing
   only an `auth.json` symbolic link to the existing authentication file,
   ignored user config/rules, strict config, empty allowlists, disabled web/MCP/
   plugins/subagents/network/review/fallback, suppressed skill/app/collaboration
   instructions, and the exact selected model and effort. Only route-scoped task
   fields enter the child prompt.
7. Raw stdout, stderr, the final child message, execution metadata, and
   verification output are retained as applicable.
8. Changed paths are compared with the task's `may_modify` envelope.
9. Context Firewall emits a packet with a completeness state, deterministic
   facts, provenance, measured bytes, and raw evidence references.
10. A structured completion handoff separates child claims, observations, and
    unknowns.
11. Acceptance evaluates exit, verification, authorization, expected-change,
    and packet-completeness gates.
12. A separate supervisor evaluation accepts or rejects objective advancement
    and persists the decision.

Normal model-level polling and wait-induced automatic reasoning are prohibited.
Healthy heartbeat, host-wrapper yield/timeout, and any other nonterminal return
cannot enter the wake queue. Only terminal completion/failure/timeout/stall or
an intervention-required event can.

Wake delivery is owned by the single host-level opsled service, fenced by exact
release, PID/start/executable, service generation, supervisor identity/generation,
and request queue version. Receipt-free requests have no expiry. Runner and the
repository supervisor MUST NOT create a persistent dispatcher.

New requests bind only durable supervisor identity/generation, not a frontend.
A separate `codex-session-binding/v2` records repository realpath, Codex UUID,
rollout `session_meta` hashes and inode, installed CLI version, UID, and exact
authoritative Herdr process/workspace/pane/terminal identity. It also fences the
old tmux authority. Every fact is revalidated before transport selection.
Missing, replaced, duplicated, dead/reused, superseded, mismatched, or stale
facts fail closed.

The canonical transport is plain `codex resume SESSION_ID MESSAGE` in its own
temporary process group; normal dispatch calls neither tmux input nor Herdr
prompt APIs. Before selection crosses the transport boundary, an activation lease
CAS fences generation, owner, process, event, expiry, and monotonic token; a
per-event decision record provides the non-replayable exactly-once boundary.
The message contains only event ID, generation, and a durable-state instruction.
Delivery requires one exact accepted-message rollout record and its matching
turn-began record, hashed from their complete raw JSONL line bytes. Confirmed
delivery terminates and verifies the temporary process group. An active turn or
busy output MUST NOT gate submission: Codex serializes the submitted message and
the frontend remains alive until the authoritative rollout proves the original
Herdr TUI began that turn. Stale-session rejection fails closed; uncertainty
after spawn is never replayed.

Legacy tmux request bytes remain readable and immutable. Prior-generation and
already-evaluated requests are obsolete, not adopted. `SupervisorHostAdapter`,
the tmux commit implementation, Herdr read-only discovery, and foreground
terminal wait remain explicit compatibility boundaries and are never called by
normal automatic dispatch.

Herdr is the authoritative read-only host. Deterministic discovery requires one
exact socket, repository/workspace, pane, terminal, Codex session, process
identity, and current supervisor generation. Structured workspace, pane,
process, agent-status, attached-client, and event facts may be reported without
terminal scraping. None authorize input. Because Herdr 0.8.2 cannot prove an
empty human draft or exclusive input transaction, its commit result is always
`submitted: false` and no prompt/send primitive is called.

## Return values and evidence

The compact packet reports `complete_for_decision` only when process exit,
verification when requested, and changed-file authorization are satisfied.
Otherwise it reports `requires_escalation`. The completion handoff includes the
attempt status, actual artifacts, verification receipt, findings, unresolved
issues, warnings, provenance, raw and compact references, policy snapshot, and
claim/fence identity.

For a model-routed completion, that same durable completion handoff MUST contain
exactly one versioned model-child receipt. The receipt MUST project the actual
`policy_snapshot.gearbox_decision` route and rationale and the already-produced
Context Firewall packet; it MUST NOT reconstruct either source after completion.
It reports child identity, provider model and reasoning effort, execution class
and selected tool, raw-to-retained bytes, reduction bytes and ratio, evidence
classes, and compact source locators. Raw and retained byte counts are
`MEASURED`; reduction amount and ratio are `DERIVED`. Unsupported values are
null and `UNAVAILABLE`, never zero, and bytes MUST NOT be converted into measured
token counts. `ESTIMATED` is a permitted evidence class only when an estimator
and its basis are explicitly recorded. Deterministic-command executions MUST
NOT fabricate a model-child receipt.

Retained bytes use the packet's
`canonical-json-utf8-with-derived-measurement-fields-null` basis. Serialized
packet bytes are a separate `MEASURED` value and MUST NOT replace retained bytes.

Normal status rendering MUST show the model-child receipt without requiring raw
artifact inspection. Exact receipt data remains inspectable through
`evidence show`. Repeated construction and rendering over identical source
artifacts MUST be deterministic. This contract evaluates DS-V0.1-01 only;
DS-V0.1-02 and savings claims remain outside this boundary.

`complete_for_decision` means the packet is sufficient for the predeclared
Acceptance decision. It is not a claim of general correctness. Child completion
also does not equal task acceptance or objective completion.

## Failure and recovery behavior

Missing authority, invalid paths, disabled routes, conflicting claims,
unauthorized changes, failed verification, and incomplete packets fail closed.
Pause blocks new automatic launches and does not implicitly cancel a running
child.

`deterministic_command` and `verification_command`, when present, are nonempty
argv arrays whose entries are strings. Validation occurs before routing, claim
acquisition, attempt creation, or Runner launch. Runner writes provider process
termination evidence before verification, Context Firewall reduction,
Acceptance, or terminal publication.

Recovery preserves the existing supervisor identity and reconstructs from
repository files. Known terminal work is not relaunched. A live PID preserves
its claim only when the canonical task, attempt, active claim, owner, fence, and
claim-index record agree; detached work additionally requires a live exact
`OWNED` Runner worker matching the supervisor, launch generation, and worker PID.
A live child without that complete ownership vector is orphaned,
marked `UNKNOWN`, pauses progression, and requires reconciliation. Recovery does
not require a conversation summary and does not infer a retry. It never rewrites
or adopts wake requests: prior generations become obsolete. It leaves
persistent wake ownership to the host opsled. Session-binding generation
adoption is a separate explicit command after every other identity fact validates.
Claimed or uncertain activation decisions remain non-replayable; delivered and
consumed receipts are idempotent.

Wake delivery commitment and consumption are fenced by repository, event ID,
queue version, delivery ID and activation fence, current supervisor identity and
generation, current session/host binding, and dispatcher implementation hash.
Any one-dimensional or multi-stale mismatch rejects before consumption evidence
or other durable bytes change.

Task creation, evaluation, recovery, status, reconstruction, cutover, and
next-action derivation use the single effective-requirements derivation. Its
profiles are objective/no-matrix, inert foreign historical DS matrix, explicit
requirement-driven, completed requirements, and malformed or contradictory
authority. The last profile fails closed; completed requirements never select a
nonexistent next requirement slice.

Context Firewall reduction is mandatory in V0.1. Disabling it is rejected
without policy mutation, and a disabled attempt snapshot cannot enter Runner
execution. Dispatcher machine and verbose diagnostics expose the expected and
observed implementation hashes plus their currentness.

A terminal `FAILED` worker record is Runner evidence, not child success or
failure evidence. The explicit reconciliation path requires exact task, attempt,
worker, claim, fence, supervisor generation, absent process, rejected-task, and
unknown-child facts. It first commits a durable `FAILED` Runner / `UNKNOWN` child
record and only then idempotently releases that exact claim as `FAILED`. Recovery
recognizes the committed result and never retries it.

## Policy boundaries

The initial and recorded self-hosting policy enables Codex, disables Claude,
sets independent review to `off`, makes Affected Verification advisory only,
and prohibits model polling. Deterministic verification remains independent of
AI review. Runtime policy commands can change provider and review settings, but
historical attempt snapshots remain unchanged.

## Compatibility and versioning

Local V0.1 Gearbox, Context Firewall, handoff, decision-evidence, wakeup,
host-terminal, and activation-telemetry adapters preserve replacement
boundaries. Discovery of an Opsle
sibling repository is not an import or integration claim.

Breaking schema or lifecycle semantics require a new protocol version. Optional
fields must preserve fail-closed behavior and truthful unknowns.

The runtime release manifest MUST be canonical and immutable for a release. It
MUST contain the runtime release ID, semantic version, source revision,
complete packaged-artifact digest, supported reader versions, supported writer
versions, migration versions, runtime epoch, and every helper entrypoint with
its digest. The complete artifact digest MUST include every declared package
file. Any manifest self-reference normalization MUST be explicit and
reproducible; an excluded or undisclosed byte set is not a complete artifact
digest.

Before compatibility succeeds, a runtime MAY read only the bounded
compatibility header. It MUST NOT semantically read or mutate other operational
state. A well-formed newer state version unsupported by the active reader or
writer MUST produce `UPGRADE_REQUIRED` before validation, recovery,
replacement, launch, wake delivery, mutation, or authority transition, and all
operational bytes MUST remain identical. Malformed state within a supported
version and malformed or unknown compatibility metadata MUST produce `CORRUPT`,
not `UPGRADE_REQUIRED`.

Every executable helper MUST verify its release from packaged bytes and MUST
carry a release fence containing runtime release ID, complete artifact digest,
runtime epoch, helper role, and exact PID/start/executable identity. A wrong,
old, superseded, wrong-role, wrong-artifact, wrong-epoch, or stale-process helper
MUST fail before side effects. Existing implementation hashes remain an
additional fence until all historical records are beyond replay.
A historical dispatcher record that predates the release-fence field MAY be
read through the exact-current implementation-hash transition path, but no
helper may acquire ownership and no new record may omit the complete release
fence.

## Host opsled requirements

One host-level opsled MUST own process infrastructure for all explicitly
registered repositories. Its registry MUST be canonical, atomic, fail closed,
and contain exactly one mapping per repository realpath. Registry and host
status records MUST contain operational identifiers and references only; each
repository's objective, requirements, policy, decisions, tasks, reasoning
history, Gearbox route, Context Firewall packet, Acceptance, and evidence MUST
remain in that repository's `.opsle`.

Before registry or repository state access, every opsled process MUST verify the
exact runtime release ID, complete artifact digest, runtime epoch, helper role,
and PID/start/executable identity. A live incompatible service or a supported
repository state newer than the active reader MUST be classified
`UPGRADE_REQUIRED`; malformed supported state MUST be `CORRUPT`.

Opsled wake dispatch MUST be repository-scoped and restart-safe. It MUST refresh
the current authoritative Herdr/Codex session immediately before transport,
reject stale session or repository fences, use canonical plain `codex resume`,
require rollout acceptance and turn-began confirmation, durably commit a
receipt, and permit consumption only after that receipt. Queued requests MUST
survive opsled absence or restart. Runner and repository supervisors MUST NOT
start or maintain persistent wake infrastructure. Existing repository
dispatcher code MAY remain as an explicit compatibility path.

Opsled Runner supervision MUST bind repository ID and realpath, task, attempt,
claim and generation fence, exact worker PID/start/executable, and runtime
release. It MUST retain raw result references, heartbeat and deadline state, and
terminal publication. It MUST reject cross-repository or stale PID/fence
confusion. A failure, pause, or upgrade requirement in one repository MUST NOT
block another registered repository.

The default identity primitives for new architecture are exact process identity
(PID, process start ticks, executable) and immutable content or release digest.
No new generation, nonce, lease, fencing token, or ownership ID may be added
unless the implementation and review name the specific concurrent writer it
orders and prove why those two primitives are insufficient. Existing live
legacy fences are not removed by this rule.

Registration MUST create one repository-local host ownership pointer from the
repository realpath to the canonical opsled registry, its Herdr
workspace/pane/terminal, and the current Codex session-binding pointer. Normal
callers MUST NOT choose the opsled root through `OPSLED_HOME`, `XDG_STATE_HOME`,
cwd, tmux, inherited Codex variables, or a caller Herdr pane.

The repository supervisor MUST express execution as an immutable request under
`.opsle/runner/requests/`. Opsled MUST validate the registered repository,
supervisor, task, attempt, claim, and existing claim fence before launching the
request. Opsled MUST NOT derive execution intent by scanning project objectives
or tasks. Wake transports that may block MUST execute as transient supervised
workers so one repository cannot block another.

Runtime upgrade MUST verify the complete target artifact, install it under its
immutable digest, stop the exact current opsled process, reject live transient
workers, run the target release's real migrations, and switch the current
runtime pointer only after every migration succeeds. Upgrade inventory MUST
retain per-repository failures rather than allowing one repository to hide the
state of another.
