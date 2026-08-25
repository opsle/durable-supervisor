# Benchmark plan

## Rule zero: correctness gate

Efficiency results are comparable only when every candidate passes the same deterministic correctness and safety gates. Incorrect, indeterminate, and policy-violating runs remain visible but are excluded from superiority claims.

## Baselines

1. Current conventional mechanism without this project.
2. The narrowest deterministic alternative.
3. This project at an exact revision and configuration.

## Measurements

- correctness
- supervisor model turns
- inactive inference
- reconstruction latency
- lost/duplicate completion events
- child context size

## Repetition and reporting

Record model, provider, model version, reasoning effort, tool versions, fixture, prompt, environment/hardware, repetition count, observable tool activity, final result, correctness, cost/tokens when available, and known confounders. Report distributions and raw observations; never invent missing values.

## Adversarial cases

- Attempt to violate: The supervisor owns the objective and definition of done.
- Attempt to violate: The runner performs mechanical lifecycle only.
- Attempt to violate: Child assignments are bounded and self-contained.
- Attempt to violate: Durable results precede wake events.

## Result policy

Retain positive, negative, null, and failed experiments. Update maturity only when the actual stated hypothesis has reproducible evidence.
