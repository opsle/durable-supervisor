# Test strategy

Tests must map to named invariants in SPEC.md, include adversarial failure cases, and separate implementation correctness from evidence for the broader hypothesis.

`reconstruction.test.js` covers clean, active, paused, complete, terminal,
uncertain-wake, contradictory claim/fence, stale Herdr/session, bounded evidence,
size-ceiling, deterministic-output, no-history-ingestion, and traced fresh-process
packet-only reconstruction.
