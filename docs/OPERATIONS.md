# Durable Supervisor operations

`.opsle/` is repository authority. The host has one long-lived execution
authority: `opsled`. Repository supervisors publish intent; transient Runner
and wake workers execute that intent and exit.

## Read current state

```sh
./bin/opsle.js status
```

Use `--verbose` for diagnostics and `--json` for machine-readable state.

```sh
./bin/opsled.js status
```

Default status is operator-oriented: the current opsled release followed by
the registered repositories and their lifecycle state.

## Reconstruct after context loss

After `/clear` or compaction:

```sh
./bin/opsle.js resume-packet generate
```

After a genuine new supervisor activation caused by process or host loss:

```sh
./bin/opsle.js resume-packet generate \
  --recover
```

Use only the returned packet as normal model context. If it names an exact
evidence escalation path, read that one path:

```sh
./bin/opsle.js resume-packet evidence \
  --path PATH
```

## Submit bounded work

Create and route the task through the repository control plane, then publish
its immutable Runner request:

```sh
./bin/opsle.js task run TASK_ID
```

This command never launches a child. Opsled claims the request and launches a
transient Runner. There is no foreground fallback and no repository dispatcher.

## Pause and resume

```sh
./bin/opsle.js pause \
  --reason "operator pause"
```

```sh
./bin/opsle.js resume \
  --reason "operator resume"
```

To let current work finish without admitting a next launch:

```sh
./bin/opsle.js pause \
  --after-current \
  --reason "finish current only"
```

## Session authority

```sh
./bin/opsle.js session status
```

The current binding is derived from Herdr workspace, pane, process, and Codex
rollout facts. It is separate from supervisor identity. Wake delivery uses only
plain `codex resume SESSION_ID MESSAGE`; it never sends terminal input.

## Wake delivery

```sh
./bin/opsle.js wake status
```

Terminal event → opsled → transient wake worker → plain Codex resume → exact
rollout confirmation → consumption → evaluation.

Transport that did not start may be reconciled explicitly:

```sh
./bin/opsle.js wake \
  reconcile-transport-not-started \
  EVENT_ID
```

An outcome uncertain after transport start is durable `UNCERTAIN` and is not
automatically replayed. Duplicate delivery cannot duplicate consumption or
evaluation.

## Host registration

```sh
./bin/opsled.js register \
  /path/to/repository
```

Registration is one canonical realpath mapping per repository and one Herdr
space per repository. A corrupt repository is quarantined without stopping
healthy repositories.

## Runtime lifecycle

```sh
./bin/opsled.js start
```

```sh
./bin/opsled.js stop
```

```sh
./bin/opsled.js upgrade \
  --release /exact/release/path
```

Upgrade verifies the immutable artifact, migrates repository state, replaces
the managed release, and retires exact stale managed helpers. Never substitute
a source checkout for an installed release.

## Validation

```sh
npm run verify
```

```sh
./bin/opsle.js validate
```

Historical dispatcher and legacy binding records remain immutable and readable.
They cannot become current execution or wake authority.
