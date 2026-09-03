# Test strategy

Tests must map to named invariants in SPEC.md, include adversarial failure cases, and separate implementation correctness from evidence for the broader hypothesis.

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

`portability.test.js` provides the deterministic initialization matrix A-M for
ordinary, unborn, gitfile, objective-driven, foreign requirement-driven,
self-host, malformed/partial, duplicate/replaced authority, historical policy,
and human/JSON CLI initialization. It also proves repository-independent version
output and explicit Context Firewall policy migration.
