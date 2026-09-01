# Operator Runbook

Run commands from the repository root. These commands are intentionally short
for narrow terminals. `.opsle/` is authoritative; tmux and conversation context
are not.

## Initialize once

`init` requires a prepared repository containing `.opsle/specification.md` and
`.opsle/requirements.json`. Do not run it in an already initialized repository:
it fails closed when an authoritative supervisor exists.

```bash
./bin/opsle.js init
./bin/opsle.js validate
./bin/opsle.js status
```

This repository is already initialized.

## Inspect status

One snapshot:

```bash
./bin/opsle.js status
```

Machine-readable snapshot:

```bash
./bin/opsle.js status --json
```

Continuous deterministic watch, stopped with Ctrl-C:

```bash
./bin/opsle.js status --watch
```

Bounded watch:

```bash
./bin/opsle.js status --watch \
  --iterations 10
```

Status and watch read durable process state. They do not invoke a model.

Activation telemetry reports terminal-event, human, and wait-induced automatic
counts. A value is `unknown` when complete trajectory evidence is absent. The
legacy polling-zero field is not accepted as evidence of zero inference.

## Launch detached work and inspect wake delivery

Canonical task execution is detached:

```bash
./bin/opsle.js task run TASK_ID
```

The command returns only after a repository-local worker has durably accepted
the exact attempt, claim fence, supervisor generation, nonce, and worker PID.
It does not wait for the child. Use deterministic status while the worker owns
the lifecycle:

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

The detached Runner persists the terminal request and ensures one persistent
repository-local dispatcher. The dispatcher has no model/provider activity and
outlives the Runner and initiating supervisor turn. If it must be started after
a process loss without a supervisor recovery, use:

```bash
./bin/opsle.js wake start
```

Normal recovery starts the current dispatcher automatically. Dispatcher
ownership is fenced by exact PID/start/executable, dispatcher generation,
supervisor identity/generation, and request queue version. Duplicate starts are
idempotent. A stale owner cannot select transport after recovery supersedes it.

Each queued request has no expiry. The dispatcher registers filesystem
observation before it checks the receipt-free queue. If an event arrives at that
boundary, it is either found by the recheck or wakes the registered observation;
there is no polling window. When the queue is empty the dispatcher waits on the
notification. While receipt-free work exists but the exact Codex binding is
unbound, stale, or unsupported, it re-evaluates durable state with bounded
provider-free backoff.
No wait-induced model activation is used.

Inspect queued, delivered, uncertain, or consumed events without model use:

```bash
./bin/opsle.js wake status
```

`wake drain` performs one provider-free diagnostic classification pass:

```bash
./bin/opsle.js wake drain
```

Installed Codex 0.151.0 standalone resume starts another embedded app-server and
loses the thread writer lock while the persistent standalone TUI is open. This
topology is unsupported. Normal dispatch does not spawn `codex resume`, call
tmux `paste-buffer`/`send-keys`, or call Herdr input. The event remains
receipt-free and queued. The operator Desktop result is positive evidence only
for its observed shared-app-server condition.

### Bind and inspect the exact Codex session

Binding is separate from the durable supervisor identity. Obtain the exact
current host/writer PIDs and tmux pane from read-only inspection, then run this
reviewed command with those literal values. Do not run it from this child task:

```bash
./bin/opsle.js session bind \
  --session \
  01a05952-e1fa-71e2-adea-df7e3f7d99ce \
  --rollout ROLLOUT_JSONL \
  --sessions-root CODEX_SESSIONS_DIR \
  --host-pid HOST_PID \
  --writer-pid WRITER_PID \
  --tmux-session TMUX_SESSION \
  --tmux-pane TMUX_PANE \
  --topology standalone-embedded-writer
```

Every token above is explicit; replace the uppercase placeholders before one
copy/paste. The command sends no input and does not resume Codex. It records and
validates repository realpath, supervisor identity/generation, Codex UUID,
rollout `session_meta` hashes and file device/inode, installed CLI version,
UID, exact process start/executable/TTY/command hash, tmux session/pane/TTY,
unique rollout candidate, and writer topology.

Inspect without model use:

```bash
./bin/opsle.js session status
./bin/opsle.js wake status
```

After an authorized recovery changes only the supervisor generation, explicitly
adopt the binding only if every other fact still validates:

```bash
./bin/opsle.js session adopt
```

Missing/replaced rollout, duplicate candidate, metadata mismatch, dead/reused
process, CLI/UID/repository/tmux mismatch, or writer-topology change fails closed.
For the current standalone topology, valid status is `bound-unsupported`.

Only a separately authorized controlled migration to one shared app-server may
bind `shared-app-server`, and it additionally requires a reviewed proof hash and
native transport adapter. Before any future supported send, the activation lease
CAS fences generation, owner/process, event, expiry, and monotonic token. The
per-event decision record is the exactly-once boundary; uncertainty is never
replayed. The tiny message contains only event ID, generation, and an instruction
to read durable state.

### Compatibility hosts and Herdr

`src/host-terminal.js` retains the tmux host and its guarded commit method as
explicit compatibility code, but normal automatic dispatch never selects it.
Herdr remains candidate-only. Its read-only adapter can report exact socket,
repository/workspace, pane, terminal, process, Codex-session, agent-status,
attached-client, and event facts when all identities match. Missing, duplicate,
or mismatched facts reject discovery. Herdr 0.8.2 cannot prove an empty human
composer or exclusive input transaction, so Opsle never calls input primitives.

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

Let the current child finish, then stay paused:

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

```bash
./bin/opsle.js policy status
./bin/opsle.js models status
```

Provider changes are prospective:

```bash
./bin/opsle.js policy enable claude
./bin/opsle.js policy disable claude
```

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

First inspect and validate the files:

```bash
./bin/opsle.js status
./bin/opsle.js validate
```

If this is genuinely a new supervisor activation, run recovery once:

```bash
./bin/opsle.js recover
```

Then inspect the reconciliation result:

```bash
./bin/opsle.js status
./bin/opsle.js validate
```

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

`is-alive` exits nonzero when no session exists; that result is expected before
`start`. Never start a second live session for the same repository.

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
