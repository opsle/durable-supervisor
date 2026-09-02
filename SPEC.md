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

Wake classification is owned by one detached repository-local provider-free
dispatcher fenced by exact PID/start/executable, dispatcher generation,
supervisor identity/generation, and request queue version. Receipt-free requests
have no expiry. Filesystem observation is registered before the queue scan.

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
delivery terminates and verifies the temporary process group. Live PTY output
detects busy rejection before frontend exit, while an already-observed exact
rollout confirmation remains authoritative. Busy remains queued for retry only
after the pre-registered exact-bound-rollout watcher observes an append;
uncertainty after spawn is never replayed.

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
its claim only for the explicit foreground path. Detached work requires a live
exact `OWNED` Runner worker matching the attempt, active claim, fence, supervisor,
launch generation, and worker PID. A live child without that worker is orphaned,
marked `UNKNOWN`, pauses progression, and requires reconciliation. Recovery does
not require a conversation summary and does not infer a retry. It never rewrites
or adopts wake requests: prior generations become obsolete. It supersedes a
stale dispatcher and ensures one current dispatcher. Session-binding generation
adoption is a separate explicit command after every other identity fact validates.
Claimed or uncertain activation decisions remain non-replayable; delivered and
consumed receipts are idempotent.

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
