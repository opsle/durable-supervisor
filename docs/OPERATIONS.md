# Operator Runbook

Run commands from the repository root. These commands are intentionally short
for narrow terminals. `.opsle/` is authoritative; tmux and conversation context
are not.

## Initialize once

`init` works in an ordinary Git repository. It creates repository-local `.opsle`
authority without copying Durable Supervisor source, changing tracked project
content, assuming sibling repositories, fabricating requirements, or injecting
the V0.1 self-host objective. Do not run it in an already initialized repository:
it fails closed when an authoritative supervisor exists.

```bash
./bin/opsle.js init
./bin/opsle.js validate
./bin/opsle.js status
```

The neutral bootstrap starts as `INITIALIZED` until an objective is supplied:

```bash
./bin/opsle.js init --objective "Ship the repository objective."
```

Repositories that already contain both `.opsle/specification.md` and
`.opsle/requirements.json` retain requirement-driven semantics. Supplying only
one fails closed because the authority would be ambiguous. `--json` selects the
machine-readable initialization result. `opsle --version` is repository-
independent and prints source/build provenance when available.

This repository is already initialized.

## Inspect status

One snapshot:

```bash
./bin/opsle.js status
```

The default is an attention-first human summary intended to fit one terminal
screen. It derives `INITIALIZED`, `ACTIVE`, `IDLE`, `PAUSED`, `COMPLETE`, and
`ATTENTION` from current objective, work, pause, unresolved, wake, and authority
facts. Contradictory or uncertain child authority is `ATTENTION`, never idle or
active. Times are relative and identifiers are safely abbreviated.

Expanded human diagnostics, including exact identifiers and timestamps:

```bash
./bin/opsle.js status --verbose
```

The full machine-readable snapshot remains uncontaminated JSON:

```bash
./bin/opsle.js status --json
```

Continuous deterministic watch, stopped with Ctrl-C:

```bash
./bin/opsle.js status --watch
```

Add `--verbose` or `--json` to select the corresponding watch format.

Bounded watch:

```bash
./bin/opsle.js status --watch \
  --iterations 10
```

Status and watch read durable process state. They do not invoke a model.

Activation telemetry reports terminal-event, human, and wait-induced automatic
counts. A value is `unknown` when complete trajectory evidence is absent. The
legacy polling-zero field is not accepted as evidence of zero inference.

## Select supervisor-local optional capabilities

The persistent supervisor has a pre-tool invariant separate from child routing.
Before it reads, loads, or invokes any optional skill or tool, it must perform
advertisement/metadata-only Discovery and persist an exact repository Gearbox
decision under `.opsle/supervisor-routing/`. Static platform category matching
for code, Codex, OpenAI, or documentation is non-authoritative. It cannot select
Graphify, OpenAI Docs, web, plugins, MCP, subagents, or any other optional route.

Create a small JSON input and select the route:

```bash
./bin/opsle.js supervisor route select \
  --input ROUTE_INPUT.json
```

The input records `work_description`, optional `task_id`, `work_class`,
`requested_route`, advertised capability metadata, why intelligence/tooling is
needed, and why cheaper direct inspection is insufficient. The decision also
captures the current objective and policy. For narrow repository or source
analysis, omit `requested_route` or set it to
`direct_deterministic_source_inspection`. This records advertised Graphify
availability while selecting `direct-source-inspection`, with no instruction
file read and every optional capability denied.

OpenAI Docs or web may be selected only with the exact
`current_external_documentation` route and an exact available
`requested_capability`. Other optional capabilities require
`explicit_optional_capability`. Both optional routes require nonempty
intelligence/tooling and direct-inspection-insufficiency rationales. Availability
alone, an advertised name, or a subject category grants nothing.

Inspect a persisted decision:

```bash
./bin/opsle.js supervisor route show DECISION_ID
```

A selected skill's instructions have one post-selection entry point:

```bash
./bin/opsle.js supervisor route load-skill DECISION_ID \
  --skill SKILL_ID
```

That command fails closed unless the decision is current, policy-valid, selects
that exact skill, and the regular instruction file still has the metadata seen
during Discovery. Unselected tools have no invocation entry point in this
contract. Genuine platform safety mandates remain authoritative outside optional
routing. Runner-launched child exact routes and isolation are unchanged.

## Launch detached work and inspect wake delivery

Canonical task execution is detached:

```bash
./bin/opsle.js task run TASK_ID
```

To launch one task and atomically pause after its supervisor evaluation:

```bash
./bin/opsle.js task run TASK_ID \
  --pause-after-current
```

The pause is durable before successful detached Runner ownership returns. The
default launch output is one human notice confirming the child, Runner
monitoring ownership, supervisor dormancy, and `END_TURN_IMMEDIATELY`. Use
`task run TASK_ID --json` when automation needs the complete launch object. A
pause-after-current JSON result reports `pause_after_current.armed: true`
together with `action: END_TURN_IMMEDIATELY`; no follow-up pause command or
status check is required. Runner publishes the terminal child result as
`AWAITING_SUPERVISOR` while the pause remains pending. `task evaluate` records
`ACCEPTED` or `REJECTED` before applying `PAUSED`, so no next child can launch.

The command returns only after a repository-local worker has durably accepted
the exact attempt, claim fence, supervisor generation, nonce, and worker PID.
Its JSON result says `action: END_TURN_IMMEDIATELY`,
`monitoring_owner: RUNNER_ONLY`, and records the matching durable dormancy
contract. The initiating supervisor must end the current turn immediately.
Runner alone owns child, status, heartbeat, and watch monitoring. The supervisor
must not automatically check child state, status, heartbeat, filesystem watches,
timeouts, or waits while the attempt is running.

Manual operator inspection remains separate and provider-free:

```bash
./bin/opsle.js status
./bin/opsle.js status --watch
```

The old enclosing wait-cell path is compatibility-only and must be requested:

```bash
./bin/opsle.js task run TASK_ID \
  --foreground-wait
```

Do not use that flag for canonical supervision. Never treat a wrapper return,
tool timeout, heartbeat, or nonterminal progress as a wake event.

The next automatic supervisor activation is permitted only after Runner queues
an eligible durable child-completed, child-failed, child-timeout, child-stall, or
intervention-required event and the canonical dispatcher delivers it through
plain `codex resume`. DORMANT is a turn boundary, not an instruction to remain
active while inspecting durable state.

The detached Runner persists the terminal request and ensures one persistent
repository-local dispatcher. The dispatcher has no model/provider activity and
outlives the Runner and initiating supervisor turn. If it must be started after
a process loss without a supervisor recovery, use:

```bash
./bin/opsle.js wake start
```

Normal recovery starts the current dispatcher automatically. Dispatcher
ownership is fenced by exact PID/start/executable, dispatcher generation,
the loaded dispatcher implementation hash, supervisor identity/generation, and
request queue version. A newly launched Runner atomically supersedes an alive
dispatcher that loaded obsolete source. Duplicate starts are
idempotent. A stale owner cannot select transport after recovery supersedes it.

Each queued request has no expiry. The dispatcher registers filesystem
observation before it checks the receipt-free queue. If an event arrives at that
boundary, it is either found by the recheck or wakes the registered observation;
there is no polling window. When the queue is empty the dispatcher waits on the
notification. While receipt-free work exists but the exact Codex binding is
unbound or stale, it waits for a repository or bound-rollout filesystem change
before re-evaluating. There is no model polling.
No wait-induced model activation is used.

Inspect queued, delivered, uncertain, or consumed events without model use:

```bash
./bin/opsle.js wake status
```

The default reports the current actionable authoritative request, selected by
authority and timestamp rather than directory order. Uncertain delivery is an
attention condition. Use `wake status --verbose` for exact event/task/attempt
details or `wake status --json` for all records and the deterministic current
and latest event IDs.

`wake drain` performs one provider-free diagnostic classification pass:

```bash
./bin/opsle.js wake drain
```

For a valid authoritative Herdr v3 binding, normal dispatch spawns plain
`codex resume SESSION_ID MESSAGE` under a repository-local PTY launcher. It
confirms one exact accepted-message record and its matching turn-began record in
the bound rollout and hashes their complete raw JSONL line bytes. Before spawn,
an unmatched `task_started` in that exact rollout is durably classified busy;
retry remains blocked until the registered watcher observes that rollout change.
Live PTY output
detects a busy rejection without waiting for the stdin keeper to exit; an exact
confirmation already present in the rollout remains authoritative. Before
delivery, the dispatcher registers a watcher for only that bound rollout and
checks its exact file-size baseline immediately. A busy retry occurs only after
that watcher observes an append to the same inode, so Opsle's wake-file writes
cannot trigger a retry. Because filesystem notifications may be coalesced before
both acceptance records are complete, the default 120-second confirmation
deadline makes one final exact rollout-state check before recording uncertainty.
The helper's 135-second process bound exceeds confirmation plus both bounded
5-second cleanup phases. The records, not either timeout or elapsed time, remain
the only positive proof. Each transport attempt is journaled under
`.opsle/wake/transport-attempts/`, including its complete fence/binding,
canonical argv and message hash, executable/version/environment/cwd evidence,
launcher and frontend identities, bounded output, exit state, timestamps,
confirmation or explicit absence, and cleanup proof. Exact confirmation is
atomically checkpointed there before cleanup begins. The helper then revalidates
the exact request, delivery, dispatcher, supervisor generation, activation
decision and lease, session binding, rollout device/inode, canonical message
hash, and both confirmation records. It atomically commits the fenced
`DELIVERED` receipt before the first temporary launcher or frontend signal.
Cleanup compares exact session UUID and wake-message frontend identities with
the pre-spawn baseline, then terminates the detached launcher group and every
newly discovered frontend group. The authoritative Herdr host group is excluded
explicitly. Cleanup CAS-updates that same receipt to `PROVEN` or
`INTERVENTION_REQUIRED`. A cleanup failure cannot erase confirmed delivery,
make the request replayable, or convert it to `UNCERTAIN`; the receipt retains
the exact remaining process evidence for intervention. The helper still accepts
the immediately prior invocation without `--evidence` and always emits one
complete JSON result, allowing an already-running dispatcher to finish across a
source cutover. It never calls tmux input or Herdr input.

### Refresh and inspect the exact Codex session

The current frontend binding is ephemeral and separate from the durable
supervisor identity. `status`, `session status`, `wake status`, supervisor
liveness, resume-packet generation/freshness checks, and delivery discover it
automatically. Discovery requires matching `CODEX_SESSION_ID` and
`CODEX_THREAD_ID` when present, two consistent `herdr api snapshot` reads,
exact `herdr pane process-info` facts, one repository workspace, one attached
Codex pane/frontend process, and one matching rollout. A fenced dispatcher may
ignore an obsolete inherited Codex environment and select the one exact live
Herdr frontend.

Replacement atomically advances only `binding_revision`; it does not change
the supervisor ID or generation. Prior pointers are retained under
`.opsle/wake/session-binding-history/`. Ambiguous, raced, detached,
repository-mismatched, incomplete, or dual-tmux discovery installs an
`INVALID` pointer with no usable session, rollout, or host facts and exposes
attention in every operator view. Repeating the same refresh is idempotent.

The explicit bind command remains a compatibility diagnostic. Do not use it
from a child task or to override failed live discovery:

```bash
./bin/opsle.js session bind \
  --session \
  01a05952-e1fa-71e2-adea-df7e3f7d99ce \
  --rollout ROLLOUT_JSONL \
  --sessions-root CODEX_SESSIONS_DIR \
  --host-pid HOST_PID \
  --workspace-id WORKSPACE_ID \
  --workspace-cwd REPOSITORY_PATH \
  --pane-id PANE_ID \
  --terminal-id TERMINAL_ID
```

Every token above is explicit; replace the uppercase placeholders before one
copy/paste. The command sends no input and does not resume Codex. It records and
validates repository realpath, supervisor identity/generation, Codex UUID,
rollout `session_meta` hashes and file device/inode, installed CLI version,
UID, exact process start/executable/TTY/command hash, Herdr workspace/pane/
terminal identity and a unique rollout candidate. No tmux fallback is required
or fabricated. If `--legacy-tmux-session NAME` is explicitly supplied, binding
and every status/delivery check fail closed while that exact tmux authority is
live.

Inspect without model use:

```bash
./bin/opsle.js session status
./bin/opsle.js wake status
```

Existing v2 records load safely and migrate once when exact live facts are
proven. Missing/replaced rollout, duplicate frontend or rollout candidates,
metadata mismatch, dead/reused process, CLI/UID/repository/host mismatch,
detached child context, discovery races, supersession, or live tmux authority
fails closed. Valid status is `bound-authoritative-herdr`.

After terminal delivery, consume the exact fenced receipt before evaluation:

```bash
./bin/opsle.js events consume EVENT_ID \
  --delivery DELIVERY_ID \
  --generation SUPERVISOR_GENERATION
```

Consumption is idempotent and immutable under `.opsle/wake/consumptions/`; it
does not rewrite the delivery receipt. A task with a delivered but unconsumed
terminal wake cannot be evaluated.

Before a send, the 180-second activation lease safely exceeds the bounded
135-second plain-resume helper lifecycle. Its CAS fences generation,
owner/process, event, expiry, and monotonic token, and expiry at or before a
decision fence is stale. The
per-event decision record is the exactly-once boundary. Busy rejection before
acceptance remains queued until an observed state change. Uncertainty after
spawn is never replayed. The dispatcher retains its already-registered bound-
rollout watcher so a late exact message plus matching turn-began append can
reconcile the original uncertain decision and transport attempt idempotently.
Late reconciliation requires the original cleanup proof and current exact
request, session, rollout, supervisor, and dispatcher fences; it emits at most
one delivery/activation and never launches another resume. After confirmed transport cleanup, the exact request,
queue version, supervisor, dispatcher process/generation, activation lease,
session binding, and exact rollout confirmation are revalidated before the
pre-cleanup delivery receipt is committed; any drift records a non-replayable
uncertain decision and no delivered receipt. Parent observation after the helper
is reconciliation only: an already committed matching receipt remains delivered
even if helper output is lost or cleanup requires intervention. The tiny message
contains only event ID, generation, and an instruction to read durable state.

### Compatibility hosts and Herdr

`src/host-terminal.js` retains the tmux host and its guarded commit method as
explicit compatibility code, but normal automatic dispatch never selects it.
Herdr is authoritative. Its read-only adapter can report exact socket,
repository/workspace, pane, terminal, process, Codex-session, agent-status,
attached-client, and event facts when all identities match. Missing, duplicate,
or mismatched facts reject discovery. Opsle never calls Herdr input primitives;
plain Codex resume is the separate canonical session transport.

```bash
./bin/opsle.js wake status
```

`consumeTerminalSession()` and directory-based atomic-replace waiting remain
solely for the explicit foreground compatibility path. Directory observation
plus the immediate post-registration state check cannot miss an atomic rename.

For a read-only trajectory audit, use
`tools/profile-codex-activations.mjs` with a trajectory path and exact child
start/end timestamps. The tool invokes no provider and writes no runtime state.
When task and attempt identity are included, the reviewed profile can be
imported with `telemetry import-activation-profile --input FILE`. Import checks
the durable attempt interval and trajectory hash, emits classified durable
activation events, and is idempotent for an identical canonical profile.

## Pause and resume

Stop new automatic launches now:

```bash
./bin/opsle.js pause
```

For compatibility, an operator may still arm the pause after a detached launch:

```bash
./bin/opsle.js pause --after-current
```

Pause does not cancel a running child. `--after-current` remains pending when
Runner publishes completion: the task stays `AWAITING_SUPERVISOR` and the
supervisor remains evaluable. After `task evaluate` records `ACCEPTED` or
`REJECTED`, Opsle applies `PAUSED` and blocks the next launch. Resolve any
`UNKNOWN` attempt or other reported issue before resuming:

```bash
./bin/opsle.js resume
```

## Inspect or change policy

Before launching a model child, inspect the task and then the created attempt.
The Gearbox decision's `selected_route_config` and the policy snapshot's
`selected_route` must be byte-equivalent exact routes. `classification_inputs`
may record `route_hint`, but its authority is `advisory_only`.

A tool-none Codex exact route records `selected_tool: none`. Its attempt records
`launch_contract` with the reviewed argv,
attempt-local `CODEX_HOME` path (never auth contents), empty skill/MCP/plugin/
fallback allowlists, web and subagents disabled, review off, denied workspace
network, and prompt byte measurement. The temporary home contains only an
`auth.json` symbolic link, never copied credential bytes; Runner removes that
link and directory after the Codex process terminates. Any route/snapshot mismatch, missing
auth material, unknown CLI config, requested unselected capability, or disabled
provider stops launch.

New selections are exact-route v2 inside Gearbox decision v3 and policy snapshot
v3. The launch explicitly sets `skills.bundled.enabled=false`,
`include_apps_instructions=false`, `agents.enabled=false`, and
`include_collaboration_mode_instructions=false`. Validation continues to accept
immutable snapshot v1/v2 artifacts under their historical contracts.

Run the deterministic route fixture without invoking a provider:

```bash
npm run test:route-isolation
```

Run the supervisor-local routing fixture:

```bash
npm run test:supervisor-routing
```

```bash
./bin/opsle.js policy status
./bin/opsle.js models status
```

Both commands default to concise human output. Add `--verbose` for expanded
provider diagnostics or `--json` for the complete policy/provider objects.

Provider changes are prospective:

```bash
./bin/opsle.js policy enable claude
./bin/opsle.js policy disable claude
```

Context Firewall reduction is mandatory Runner behavior. It has no enable or
disable policy command and every completed Runner path emits its bounded packet.

Set risk-based review only after its reviewer is enabled:

```bash
./bin/opsle.js policy review risk_based \
  --reviewer claude
```

Turn independent review off:

```bash
./bin/opsle.js policy review off
```

The recorded V0.1 self-hosting policy is Codex enabled, Claude disabled, review
off, Affected Verification advisory, and model polling prohibited. Do not infer
that a discovered provider is enabled.

## Inspect or redirect the objective

```bash
./bin/opsle.js objective show
```

```bash
./bin/opsle.js objective set \
  --text "New bounded objective"
```

Prior revisions remain durable. Changing the objective during active work
pauses future progression and reports a reconciliation requirement.

## Use the tmux convenience layer

Derive the repository session name and inspect liveness:

```bash
./bin/opsle.js supervisor session-name
./bin/opsle.js supervisor is-alive
```

`is-alive` treats a current authoritative Herdr binding as canonical. Missing
tmux is not an error in that case. A live tmux session is reported only as a
compatibility fallback; its details are shown by `--verbose`. Use `--json` for
the full Herdr and fallback evidence.

Start only when no session is alive:

```bash
./bin/opsle.js supervisor start
```

Attach:

```bash
./bin/opsle.js supervisor attach
```

Starting tmux reuses the durable supervisor identity. It does not initialize a
second supervisor. Loss of tmux does not lose the objective or ledger.

## Recover after context or process loss

Use this procedure after `/clear`, Codex restart, tmux loss, SSH loss, or process
loss. It does not need a pasted conversation summary.

After `/clear` or model compaction with the same live supervisor activation,
generate the canonical packet. This command is the normal first model-facing
read:

```bash
./bin/opsle.js resume-packet generate
```

If process, tmux, or host loss means this is genuinely a new supervisor
activation, reconcile once and emit only the resulting packet:

```bash
./bin/opsle.js resume-packet generate --recover
```

The packet is canonical `resume-packet/v1` JSON and answers current repository,
supervisor/generation, authority and Herdr binding, objective, phase, policy,
pause, active task/attempt/claim/fence, wake attention, latest relevant decision,
unresolved state, and next action. Its hard ceilings are 4,000 UTF-8 bytes and
4,000 Unicode code points. Those exact measurements are recorded; no token count
is claimed without a tokenizer. Generation time and reconstruction telemetry are
written separately to `.opsle/evidence/reconstruction/telemetry.json` and never
enter the packet.

Every complete packet includes a semantic freshness fence. Packet consumption
re-derives that fence and replaces a stale cached packet with the fresh packet
already computed in that same pass for changed objective, task, decision,
pause/resume, unresolved/wake, policy, supervisor-generation, or session authority.
Telemetry-only timestamp changes are excluded from the fence.

For a `complete_for_resume` packet, do not read broader durable files. For
`incomplete`, `contradictory`, or `requires_escalation`, load only a path named
in `evidence.escalation`:

```bash
./bin/opsle.js resume-packet evidence --path PATH
```

That command verifies the referenced file hash and emits only its selected JSON
slice, capped at 16 KiB. It rejects unselected paths, changed evidence, symlinks,
repository escapes, unsupported selectors, and oversized selected output.
`resume-packet show` verifies the freshness fence before emitting a complete
packet. Append-only events and decisions, raw evidence, the specification, and
objective history remain durable but are not normal model inputs or output.

`status` and `validate` remain useful operator diagnostics and release checks.
Do not paste their output into the normal activation context. Direct `recover`
also remains available for deterministic operator diagnosis; use the combined
packet command for a model activation so broad reconciliation output is not
exposed.

Recovery increments the existing generation. It does not create a new identity
or retry work. A known terminal attempt is not relaunched. Detached ownership
requires a live exact `OWNED` Runner worker record matching the attempt, active
claim, fence, supervisor, launch generation, and worker PID. A live child with a
dead or mismatched worker is orphaned, becomes `UNKNOWN`, and pauses automatic
progression. Only the explicit foreground compatibility path uses direct child
PID ownership. Recovery never adopts or rewrites wake requests. Prior-generation
requests are immutable and obsolete. Recovery supersedes stale dispatcher
ownership and starts exactly one current dispatcher; uncertain activation
decisions are never replayed. Reconcile
unknown state before `resume`.

For the narrow case where a rejected task has an exact terminal `FAILED`
detached-worker record but no trustworthy child terminal evidence, use the
explicit reconciler. Read current status first and supply every identity and the
current supervisor generation:

```bash
./bin/opsle.js reconcile runner-failure \
  --task "$TASK_ID" \
  --attempt "$ATTEMPT_ID" \
  --claim "$CLAIM_ID" \
  --fence "$FENCE" \
  --generation "$GENERATION"
```

The command fails closed unless the task is already rejected, the attempt is
exactly `UNKNOWN`, no execution/completion/Acceptance evidence exists, the worker
and claim identities and fence match, and both recorded processes are dead. It
commits Runner `FAILED` with child outcome `UNKNOWN` before releasing the exact
claim `FAILED`. Repeating the same reconciliation is idempotent. Do not use it to
infer child success or failure, retry work, or release an ambiguous claim.

If the tmux session was lost, check before recreating it:

```bash
./bin/opsle.js supervisor is-alive
./bin/opsle.js supervisor start
./bin/opsle.js supervisor attach
```

`is-alive` exits nonzero with `UNKNOWN` when neither a current Herdr binding nor
a live compatibility fallback proves process authority. That result can be
expected before `start`. Never start a second live session for the same
repository.

## Inspect tasks, requirements, and evidence

```bash
./bin/opsle.js requirements
./bin/opsle.js task show TASK_ID
./bin/opsle.js evidence show ATTEMPT_ID
```

`evidence show` returns the durable attempt, compact Context Firewall packet,
and completion handoff. Follow a raw evidence reference only when the compact
packet is incomplete, contradictory, suspicious, or the smallest relevant raw
slice is needed. Do not routinely paste raw transcripts into model context.

## Verify the checkout

```bash
npm test
npm run check
./bin/opsle.js validate
```

Affected Verification may advise, but it does not authorize omitting established
verification in V0.1.
