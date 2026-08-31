# V0.1 Self-Hosting Proof

## Claim bounded by the evidence

This repository durably records a local, single-repository V0.1 cutover followed
by meaningful Codex child tasks executed through the implemented handoff,
discovery, policy, Gearbox, claim/fence, Runner, Context Firewall, Acceptance,
and supervisor-decision path.

This is a bounded dogfooding result. It is not a production-readiness,
general-correctness, token-saving, cost-saving, or cross-repository claim.

## Cutover

The bootstrap-to-self-hosted transition is
[event-9fca1322-bbe0-464f-8043-2324a10c775e](../.opsle/events/event-9fca1322-bbe0-464f-8043-2324a10c775e.json),
recorded at `2026-08-31T18:17:48.565Z`.

It records supervisor identity
`supervisor-1005d601-4da1-4f6b-a7fa-f0b71dedabbe`, generation 1, the minimum
substrate present at cutover, the requirements still open, and
`task-self-host-recovery-policy-tests` as the first post-cutover task.

Before cutover, `task-bootstrap-validate` exercised the deterministic Runner
path and was accepted under decision
`decision-185d8740-14fc-4372-9231-79acca713a9c`. Its compact packet reports
exit 0, no changed files, no unexpected files, and
`complete_for_decision` in its
[compact packet](../.opsle/evidence/compact/task-bootstrap-validate-attempt-001.json).

The tiny bootstrap output was smaller than its metadata packet, so it is not
presented as reduction evidence.

## Meaningful post-cutover children

### Recovery and policy tests

- Task: `task-self-host-recovery-policy-tests`
- Attempt: `task-self-host-recovery-policy-tests-attempt-001`
- Recorded route/provider: Codex; Claude disabled; independent review off
- Result: execution exit 0, `npm test` exit 0, seven authorized files changed,
  zero unexpected files, packet `complete_for_decision`
- Supervisor decision:
  `decision-14e836b8-c36b-410a-a2bc-dd1a396896bd` (`ACCEPT`)
- [Compact packet](../.opsle/evidence/compact/task-self-host-recovery-policy-tests-attempt-001.json)
- [Completion handoff](../.opsle/evidence/compact/task-self-host-recovery-policy-tests-attempt-001.completion.json)

The deterministic tests cover fresh-process reconstruction from repository
files, durable pause, prospective policy changes, immutable historical policy
snapshots, distinct retry attempts, duplicate-event idempotency, and fencing an
absent nonterminal child as `UNKNOWN` without retry.

### Operator controls

- Task: `task-self-host-operator-controls`
- Attempt: `task-self-host-operator-controls-attempt-001`
- Recorded route/provider: Codex; Claude disabled; independent review off
- Result: execution exit 0, `npm test` exit 0, four authorized files changed,
  zero unexpected files, packet `complete_for_decision`
- Supervisor decision:
  `decision-be3f3ab6-eb89-47c4-b60d-97658a17de83` (`ACCEPT`)
- [Compact packet](../.opsle/evidence/compact/task-self-host-operator-controls-attempt-001.json)
- [Completion handoff](../.opsle/evidence/compact/task-self-host-operator-controls-attempt-001.completion.json)

The deterministic tests cover immutable objective revisions, fail-safe objective
redirects, pause-after-current behavior, bounded read-only status watch, and
telemetry that reports measured facts or explicit unknowns.

## No-model-polling evidence

The Runner uses a blocking OS child process and its `close` event. During the
wait it records PID/heartbeat while the supervisor is logically `DORMANT`.
Completion events for both post-cutover tasks record
`model_turns_used_for_polling: 0` and
`wait_mechanism: blocking OS child process + close event`:

- [Recovery/policy completion event](../.opsle/events/event-e3fbd05d-1950-4db4-8f55-4cbe5dda2b12.json)
- [Operator-controls completion event](../.opsle/events/event-1c1c312b-06e5-44ca-b631-990c1a4fa0c1.json)

This proves what the local recorded path did. It does not estimate avoided model
turns or claim a universal efficiency result.

## Measured Context Firewall bytes

| Attempt | Raw evidence | Compact packet | Bytes omitted from packet | Compact/raw |
| --- | ---: | ---: | ---: | ---: |
| Recovery/policy | 276,077 | 2,591 | 273,486 | 0.9385% |
| Operator controls | 249,693 | 2,584 | 247,109 | 1.0349% |

The packet files record the raw, compact, and suppressed byte counts and retain
path, size, and SHA-256 references for the raw artifacts. Expressed as byte
suppression, the two packets omitted 99.0615% and 98.9651% respectively from the
normal decision packet.

These values measure serialized evidence size, not model tokens, cost, latency,
or correctness. Raw evidence remains available for bounded escalation and was
not ingested to prepare this report.

## Evidence and decision boundary

For both post-cutover tasks, the child claim was not accepted by itself. The
Runner captured artifacts, verification exited 0, changed-file scope matched the
authorization envelope, Context Firewall marked the packet
`complete_for_decision`, Acceptance reported `SATISFIED`, and the supervisor
then persisted a separate `ACCEPT` decision. The packet state means sufficient
for that predeclared decision; it is not proof of all possible correctness.

## Explicit limits

- The proof covers one local repository and single-host process claims.
- tmux was not required for authority; `.opsle` was.
- The local completion event is not a dedicated external wakeup service.
- Sibling Opsle repositories were discovered and revision-recorded, not imported.
- Affected Verification remained advisory and did not reduce required tests.
- Claude remained disabled and no independent AI review occurred.
- Output-token and cost telemetry are unknown.
- Many requirements remained open at cutover, and final V0.1 PASS reconciliation
  is outside this proof report.
- No deployment, merge, push, or production operation is evidenced or claimed.
