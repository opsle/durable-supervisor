# V0.1 Public Contract

This file explains the checked-in implementation. The complete normative
contract is [`.opsle/specification.md`](.opsle/specification.md), and runtime
truth is the validated machine-readable state under `.opsle/`. README and this
summary are not recovery inputs.

## Scope

V0.1 supervises one Git repository with one authoritative supervisor identity.
It uses ordinary local processes, repository files, an optional tmux session,
and an enabled provider CLI. It does not provide production deployment,
distributed coordination, multi-repository orchestration, a scheduler, or a web
application.

## Durable inputs

A bounded task handoff records:

- task and parent objective identity;
- objective, scope, and explicit authorization;
- required inputs and relevant context;
- expected deliverable and evidence;
- acceptance criteria and prohibited actions;
- requirement IDs, operator constraints, route hint, and optional deterministic
  and verification commands.

At attempt creation, current discovery, provider/review policy, model settings,
authorization, Gearbox decision, claim/fence, evidence requirements, and
acceptance criteria are copied into an immutable historical policy snapshot.
Later policy changes are prospective.

## Execution contract

1. Capability Discovery records available commands and sibling revisions.
2. Operator policy makes disabled providers ineligible.
3. Gearbox selects an adequate permitted deterministic route or Codex.
4. Claim acquisition fails if the task already has an active claim.
5. The Runner durably registers an explicit bounded wait before launch and
   before making the supervisor `DORMANT`.
6. The OS process wait, not a model loop, detects completion, failure, or
   timeout and publishes a terminal event.
7. Raw stdout, stderr, the final child message, execution metadata, and
   verification output are retained as applicable.
8. Changed paths are compared with the task's `may_modify` envelope.
9. Context Firewall emits a packet with a completeness state, deterministic
   facts, provenance, measured bytes, and raw evidence references.
10. A structured completion handoff separates child claims, observations, and
    unknowns.
11. Acceptance evaluates exit, verification, authorization, expected-change,
    and packet-completeness gates.
12. A separate supervisor evaluation accepts or rejects objective advancement
    and persists the decision.

Normal model-level polling and wait-induced automatic reasoning are prohibited.
Healthy heartbeat, host-wrapper yield/timeout, and any other nonterminal return
cannot make a wait model-ready. Terminal completion/failure/timeout/stall or an
intervention-required event may wake automatic supervision. Explicit human
interaction is separately eligible and classified as human.

The Codex host must bind the terminal adapter so wrapper yields are consumed
inside one deterministic call. Without that host binding, the repository can
detect and report trajectory activations but cannot prevent the external host
from initiating them.

## Return values and evidence

The compact packet reports `complete_for_decision` only when process exit,
verification when requested, and changed-file authorization are satisfied.
Otherwise it reports `requires_escalation`. The completion handoff includes the
attempt status, actual artifacts, verification receipt, findings, unresolved
issues, warnings, provenance, raw and compact references, policy snapshot, and
claim/fence identity.

`complete_for_decision` means the packet is sufficient for the predeclared
Acceptance decision. It is not a claim of general correctness. Child completion
also does not equal task acceptance or objective completion.

## Failure and recovery behavior

Missing authority, invalid paths, disabled routes, conflicting claims,
unauthorized changes, failed verification, and incomplete packets fail closed.
Pause blocks new automatic launches and does not implicitly cancel a running
child.

Recovery preserves the existing supervisor identity and reconstructs from
repository files. Known terminal work is not relaunched. A live PID preserves
its claim. An absent PID without terminal evidence is marked `UNKNOWN`, pauses
progression, and requires reconciliation. Recovery does not require a
conversation summary and does not infer a retry.

## Policy boundaries

The initial and recorded self-hosting policy enables Codex, disables Claude,
sets independent review to `off`, makes Affected Verification advisory only,
and prohibits model polling. Deterministic verification remains independent of
AI review. Runtime policy commands can change provider and review settings, but
historical attempt snapshots remain unchanged.

## Compatibility and versioning

Local V0.1 Gearbox, Context Firewall, handoff, decision-evidence, wakeup,
host-terminal, and activation-telemetry adapters preserve replacement
boundaries. Discovery of an Opsle
sibling repository is not an import or integration claim.

Breaking schema or lifecycle semantics require a new protocol version. Optional
fields must preserve fail-closed behavior and truthful unknowns.
