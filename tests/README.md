# Test strategy

Tests must map to named invariants in SPEC.md, include adversarial failure cases, and separate implementation correctness from evidence for the broader hypothesis.

`runtime-version.test.js` covers the immutable complete-artifact release
manifest, helper digests, distinct `CORRUPT` handling, release
role/root/artifact/epoch and PID/start/executable fences, and superseded
wake-helper denial. Inert state-version and migration claims are intentionally
absent.

`host-lock.test.js` uses concurrent subprocesses to prove atomic stale takeover,
exclusive critical-section ownership, bounded retry, deterministic cleanup, and
the shared registry/future-upgrade primitive.

`invariant-harness.test.js` applies one reusable ownership-vector harness to
wake consumption, claim acquisition/release, delivery commitment, recovery
adoption, and session-binding adoption. It covers all four requirements
profiles, both bounded reducer sequences and the durable acquire-through-resume
state machine, policy-effect enforcement, and explicit
test-only generation-only, stale-index, raw-requirement, and metadata-only
mutants. Historical replay covers stale claim release, queued-wake loss,
stale session binding, unconsumed delivery, foreign inherited requirements, and
same-generation wrong-supervisor consumption without rewriting evidence.

`reconstruction.test.js` covers clean, active, paused, complete, terminal,
uncertain-wake, contradictory claim/fence, stale Herdr/session, bounded evidence,
size-ceiling, deterministic-output, no-history-ingestion, and traced fresh-process
packet-only reconstruction.

`wakeup.test.js` covers ephemeral frontend/session/rollout/pane replacement,
idempotent revisioning, immutable history, v2 migration, ambiguity, detached
contexts, discovery races and recovery, wake-worker pre-delivery refresh,
resume-packet invalidation, and fenced consumption.
`operator-controls.test.js` proves delivered terminal wakes must be consumed
before evaluation.

`opsled.test.js` covers canonical realpath-deduplicated host registration,
authority-free registry shape, atomic fail-closed schema handling, exact service
release/PID fencing, restart-safe repository wake scans, cross-repository Runner
fence rejection, per-repository fault isolation, and concise/verbose/JSON status
shape.

`portability.test.js` provides the deterministic initialization matrix A-M for
ordinary, unborn, gitfile, objective-driven, foreign requirement-driven,
generic matrix, malformed/partial, duplicate/replaced authority, historical
evidence, and human/JSON CLI initialization. It also proves repository-independent
version output and the absence of a Context Firewall disable switch.
