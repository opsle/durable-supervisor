# Durable Supervisor

> Experimental Opsle research. Claims are hypotheses until evidence supports them.

## Problem

Long-lived reasoning sessions often spend cognition on waiting, lifecycle mechanics, and reconstructing state after interruption.

## Hypothesis

A durable supervisor that becomes inactive between decisions can preserve correctness while consuming no model inference during bounded child execution.

## Mechanism

The supervisor owns objective and definition of done, reconstructs a durable ledger, delegates a self-contained assignment to a fresh child, becomes inactive, and resumes only from a durable completion event. A non-reasoning runner handles launch, capture, and notification.

## Why it matters

The Opsle thesis asks: **What if we stopped using intelligence for work that doesn’t require intelligence?** This project isolates one candidate boundary so it can be falsified and measured independently.

## Non-goals

A second reasoning supervisor in the runner, conversational memory as state, or perpetual autonomous activity.

## Current maturity

**THEORY** under the [Opsle maturity model](https://github.com/opsle/research/blob/main/MATURITY.md).

## Existing evidence

Durable task, job, execution, and event state in the predecessor system demonstrates feasibility, not general efficiency.

## Evidence still missing

Controlled long-horizon experiments, reconstruction fidelity thresholds, delegation policy, and failure-mode comparison with continuous sessions.

## Benchmark strategy

Correctness gates every comparison. Planned measures:

- correctness
- supervisor model turns
- inactive inference
- reconstruction latency
- lost/duplicate completion events
- child context size

See [BENCHMARK.md](BENCHMARK.md) for experiment rules. No benchmark numbers are claimed.

## Relationship to other Opsle research

This project is part of [Opsle Research](https://github.com/opsle/research). Opsle Tasks is the future public name of the integrated reference system from which several ideas emerged. Its active development migration to the Opsle organization is intentionally deferred.

## Relationship to future Opsle Tasks

Future Opsle Tasks may consume this project through an adapter only after evidence supports integration. The active predecessor, Taslos Tasks, remains unchanged and has no dependency on this repository.

## Installation status

No installable production package is justified yet. The repository is theory/specification-first.

## Known limitations

Controlled long-horizon experiments, reconstruction fidelity thresholds, delegation policy, and failure-mode comparison with continuous sessions.

## License

Apache-2.0. See [LICENSE](LICENSE).
