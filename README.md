# Durable Supervisor

Durable Supervisor V0.1 is an experimental, repository-local control plane for
bounded agent work. It asks a simple question: what if intelligence were used
for decisions, while ordinary software handled persistence, waiting, process
lifecycle, and evidence transport?

This repository contains a working, tested V0.1 vertical slice. It is not a
production service or a published installable package.

## Durable does not mean continuously inferring

The supervisor may remain available in a terminal or tmux session, but an open
session does not imply a running model turn. While a child or deterministic
tool runs, the supervisor is logically `DORMANT`. The Runner blocks on the OS
child process, captures its output, and emits a durable completion event. There
is no model status-polling loop.

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
  be used. Gearbox selects the simplest adequate permitted route.
- Every task has bounded authorization, required evidence, acceptance criteria,
  and prohibited actions.
- Claims and monotonically increasing fence generations prevent an obvious
  duplicate attempt from acquiring the same task concurrently.
- The Runner owns launch, heartbeat, capture, timeout, blocking wait, and the
  durable completion event.
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
evidence inspection. The recovery path reads durable files and reconciles the
active attempt; it does not replay chat history or silently retry uncertain
work.

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
handoffs, Context Firewall reduction, decision evidence, completion events,
and telemetry. Capability Discovery records the presence and revision of
related Opsle sibling repositories, but this repository does not import their
implementations.

Affected Verification is `advisory_only` and did not authorize reduced testing.
Semantic Edit, a dedicated wakeup service, full trajectory profiling,
multi-repository supervision, distributed locking, a scheduler, a web UI, and
production deployment are deferred. Codex is enabled in the recorded policy;
Claude and independent review remained disabled.

## License

Apache-2.0. See [LICENSE](LICENSE).
