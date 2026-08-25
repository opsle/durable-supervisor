# Theory

## Observation

Long-lived reasoning sessions often spend cognition on waiting, lifecycle mechanics, and reconstructing state after interruption.

## Hypothesis

A durable supervisor that becomes inactive between decisions can preserve correctness while consuming no model inference during bounded child execution.

## Proposed mechanism

The supervisor owns objective and definition of done, reconstructs a durable ledger, delegates a self-contained assignment to a fresh child, becomes inactive, and resumes only from a durable completion event. A non-reasoning runner handles launch, capture, and notification.

## Falsifiable requirements

1. The supervisor owns the objective and definition of done.
2. The runner performs mechanical lifecycle only.
3. Child assignments are bounded and self-contained.
4. Durable results precede wake events.

## Disconfirming results

The hypothesis should be weakened or rejected if a comparable baseline passes the same correctness gate and this mechanism provides no repeatable benefit, or if the mechanism introduces safety/correctness failures that bounded revisions do not resolve. Negative results remain in `experiments/`.

## Uncertainty

Controlled long-horizon experiments, reconstruction fidelity thresholds, delegation policy, and failure-mode comparison with continuous sessions.
