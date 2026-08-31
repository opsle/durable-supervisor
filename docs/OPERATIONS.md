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

## Wait for a child without model reactivation

The supervisor host must call the terminal adapter from one enclosing tool
cell. That cell starts the CLI process and mechanically resumes the same
terminal session until it receives an exit code. Its deadline must be later
than the task's declared execution and verification windows, but must remain
finite.

Do not return a session ID to the model and ask it to wait again. Do not treat a
30-second wrapper return, tool timeout, or fresh heartbeat as a wake event. If
the adapter deadline arrives without a durable terminal event, fail closed and
record an intervention requirement.

The reusable deterministic contract is `consumeTerminalSession()` in
`src/host-terminal.js`. Host integration supplies its terminal `start` and
`resume` functions. This repository cannot enforce the rule in an external
host that does not bind the adapter.

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

Pause does not cancel a running child. Resolve any `UNKNOWN` attempt or other
reported issue before resuming:

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
or retry work. A known terminal attempt is not relaunched. A live PID keeps its
claim. An absent PID without terminal evidence becomes `UNKNOWN` and pauses
automatic progression. Reconcile that state before `resume`.

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
