# Test strategy

Tests must map to named invariants in SPEC.md, include adversarial failure cases, and separate implementation correctness from evidence for the broader hypothesis.

`runtime-version.test.js` covers the immutable complete-artifact release
manifest, helper digests, compatibility preflight, byte-identical
`UPGRADE_REQUIRED`, distinct `CORRUPT` handling, release role/artifact/epoch and
PID/start fences, superseded wake-helper denial, and a deliberately executed
legacy invalid-classification mutant that the invariant harness rejects.

`invariant-harness.test.js` applies one reusable ownership-vector harness to
wake consumption, claim acquisition/release, delivery commitment, recovery
adoption, and session-binding adoption. It covers all five requirements
profiles, both bounded reducer sequences and the durable acquire-through-resume
state machine, policy-effect enforcement, dispatcher diagnostics, and explicit
test-only generation-only, stale-index, raw-requirement, and metadata-only
mutants. Historical replay covers stale claim release, drain/resubscribe loss,
stale session binding, unconsumed delivery, foreign inherited requirements, and
same-generation wrong-supervisor consumption without rewriting evidence.

`reconstruction.test.js` covers clean, active, paused, complete, terminal,
uncertain-wake, contradictory claim/fence, stale Herdr/session, bounded evidence,
size-ceiling, deterministic-output, no-history-ingestion, and traced fresh-process
packet-only reconstruction.

`wakeup.test.js` covers ephemeral frontend/session/rollout/pane replacement,
idempotent revisioning, immutable history, v2 migration, ambiguity, detached
contexts, dual tmux authority, discovery races and recovery, dispatcher
pre-delivery refresh, resume-packet invalidation, and fenced consumption.
`operator-controls.test.js` proves delivered terminal wakes must be consumed
before evaluation.

`opsled.test.js` covers canonical realpath-deduplicated host registration,
authority-free registry shape, atomic fail-closed schema handling, exact service
release/PID fencing, restart-safe repository wake scans, cross-repository Runner
fence rejection, per-repository fault isolation, and concise/verbose/JSON status
shape.

`portability.test.js` provides the deterministic initialization matrix A-M for
ordinary, unborn, gitfile, objective-driven, foreign requirement-driven,
self-host, malformed/partial, duplicate/replaced authority, historical policy,
and human/JSON CLI initialization. It also proves repository-independent version
output and explicit Context Firewall policy migration.
