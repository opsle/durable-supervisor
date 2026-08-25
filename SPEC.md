# Specification

Status: experimental theory contract.

## Compatibility boundary

The primitive accepts generic structured input and emits generic structured output. It must not require a Taslos Tasks database, worker, scheduler, package, runtime path, or private service.

## Inputs

- `protocol_version`: explicit version.
- `operation_id`: stable idempotency identity.
- `policy_revision`: the exact policy/configuration revision.
- `subject`: vendor-neutral request data required by this concept.
- `evidence`: observable artifacts with provenance.

## Outputs

- `status`: accepted, rejected, deferred, or indeterminate.
- `reason`: durable structured reason.
- `changed_entities`: bounded identities, never ambient state.
- `evidence`: provenance-linked receipts.
- `uncertainty`: explicit unknowns.

## Invariants

- The supervisor owns the objective and definition of done.
- The runner performs mechanical lifecycle only.
- Child assignments are bounded and self-contained.
- Durable results precede wake events.

## Failure behavior

Missing required authority or evidence fails closed. Unsupported optional data remains explicit and does not silently widen behavior. Implementations must document idempotency, crash consistency, and raw-evidence escalation.

## Versioning

Breaking semantic changes require a new protocol version. New optional fields require evidence that they affect a real decision.
