Opsle Durable Supervisor V0.1

Bootstrap, Self-Hosting, Pipeline Integration, and Operational Proof

You are implementing the first operational version of Opsle Durable Supervisor in the opsle/durable-supervisor repository.

This prompt is intentionally comprehensive. Every material requirement matters.

The objective is not merely to design Durable Supervisor.

The objective is to create the smallest genuinely operational system that eliminates the recurring human workflow:

Human
  ↓
Codex
  ↓ copy result
ChatGPT
  ↓ copy next prompt
Codex
  ↓ copy result
ChatGPT
  ↓ ...

and replaces it with one repository-level AI supervisor that owns an objective from beginning to end, delegates bounded work through Opsle’s pipeline, receives compact evidence, evaluates results, persists durable state, and continues without requiring the human to manually transport summaries and prompts between AI sessions.

The human must no longer serve as:

* message bus
* state store
* child completion monitor
* wakeup mechanism
* prompt transporter
* routine task decomposer
* routine reviewer of every child result
* continuity mechanism between model contexts

The human remains the operator and must retain the ability to inspect, question, pause, redirect, change policy, enable or disable models, request reviews, and change objectives at arbitrary times.

⸻

DS-000: Preserve this entire specification before substantial work

This requirement is fundamental.

Do NOT rely on the active Codex conversation as the authoritative copy of this specification.

Before substantial implementation:

1. Persist this complete task specification, or an exact requirement-preserving structured representation of it, inside .opsle/.
2. Create a durable requirements matrix with stable identifiers for every material requirement in this prompt.
3. Every requirement must eventually have one of these states:

UNSTARTED
IN_PROGRESS
IMPLEMENTED
VERIFIED
DEFERRED_WITH_JUSTIFICATION
BLOCKED
NOT_APPLICABLE_WITH_JUSTIFICATION

4. A requirement marked VERIFIED must include durable evidence or references to tests/artifacts proving it.
5. Do not silently collapse or omit requirements because they appear duplicative.
6. Re-read the durable specification and requirement matrix after:

/clear
context compaction
Codex restart
tmux/session reconstruction
supervisor crash
machine restart
explicit recovery

7. Before declaring PASS, reconcile the actual implementation against the complete requirements matrix.
8. No material requirement may remain accidentally unaccounted for.

The operating principle is:

Model context is disposable. The persisted specification is authoritative.

⸻

DS-001: Establish repository reality before changing it

Before modifying anything:

1. Verify that the current repository is actually opsle/durable-supervisor.
2. Inspect:

git status
git history
branches
README
docs
AGENTS.md
existing .opsle state if present
source code
tests
package/runtime choices
CI configuration
prior architectural decisions

3. Preserve valid existing work.
4. Do not overwrite, stash, reset, normalize, commit, or otherwise absorb unrelated local changes.
5. Determine the canonical Opsle repository checkout root.
6. Inspect opsle/research or the authoritative Opsle registry if locally available to identify all relevant pipeline/component repositories and their canonical names.
7. Read relevant sibling Opsle repositories read-only before inventing overlapping interfaces.

Likely relevant concepts include, where present:

agent-gearbox
context-firewall
agent-state-ledger
event-driven-agent-wakeup
decision-evidence-protocol
verifiable-agent-handoff
semantic-edit-protocol
agent-trajectory-profiler
affected-verification
authorization-related components
claim/fencing-related components
acceptance-related components
capability/discovery-related components
runner/execution-related components

Do not assume every conceptual component necessarily has exactly the repository name shown above.

Use the authoritative Opsle registry/repository contents to determine actual names.

Do not modify sibling repositories during this task unless the operator explicitly authorizes it.

If a sibling component has a stable usable interface, integrate it.

If it does not yet expose an integration-ready interface, create the narrowest explicit adapter/contract required inside Durable Supervisor while keeping the architectural boundary replaceable.

Do not duplicate an entire sibling project’s responsibility inside Durable Supervisor.

⸻

DS-002: Preserve conceptual component boundaries

Durable Supervisor composes Opsle components.

It must not erase them into an inseparable monolith.

The conceptual responsibilities are:

Durable Supervisor
    owns the objective
    determines what needs to happen next
    evaluates evidence
    accepts/rejects results
    persists decisions
    controls progression
Agent Gearbox
    controls outbound intelligence expenditure
    chooses the least-expensive adequate execution mechanism
    subject to operator policy and authorization
Capability Discovery
    determines what execution capabilities actually exist
Operator Policy
    determines which discovered capabilities may be used
Authorization
    determines what a delegated task is permitted to do
Verifiable Agent Handoff
    carries bounded task intent and completion evidence across agent boundaries
Claims / Fencing
    prevents duplicate or stale execution ownership
Runner
    launches and manages bounded execution
    handles process lifecycle and waiting outside model reasoning
Event-Driven Agent Wakeup
    transports completion or state-change events without model polling
Context Firewall
    controls inbound context expenditure
    suppresses operational noise
    retains decision-relevant evidence and provenance
Decision Evidence Protocol
    distinguishes claims from sufficient decision evidence
Acceptance
    determines whether completed execution satisfies the delegated task
Agent State Ledger
    makes supervisory state durable and reconstructable
Semantic Edit Protocol
    describes intended versus actual semantic changes when relevant
Affected Verification
    may reduce verification scope when proven safe
    but is advisory initially
Agent Trajectory Profiler
    measures model usage, context suppression, waits, handoffs, routing, and efficiency

The intended composition is approximately:

Human
  │
  │ objective / correction / policy
  ▼
Durable Supervisor
  │
  ▼
Authorization
  │
  ▼
Verifiable Task Handoff
  │
  ▼
Capability Discovery
  │
  ▼
Operator Policy Filter
  │
  ▼
Agent Gearbox
  │
  ▼
Claim / Fence
  │
  ▼
Runner
  │
  ├───────────────┐
  ▼               ▼
Deterministic     AI Child
Tool/Software     Codex / enabled provider
  │               │
  └───────┬───────┘
          ▼
    Raw Artifacts
          │
          ▼
   Verification
          │
          ▼
  Context Firewall
          │
          ▼
Verifiable Completion Handoff
          │
          ▼
      Acceptance
          │
          ▼
 Durable Supervisor
          │
          ▼
 Agent State Ledger
Runner completion/state events
          │
          ▼
Event-Driven Wakeup
          │
          ▼
 Durable Supervisor
All major lifecycle events
          │
          ▼
Trajectory-compatible telemetry

Do not force every component to be fully mature before V0.1 can work.

Do preserve each boundary sufficiently that dedicated components can replace bootstrap implementations later.

⸻

DS-003: Canonical supervisor architecture

There is one repository-level supervisor associated with one repository.

The preferred operating model is a persistent interactive Codex session, normally kept open inside tmux.

The supervisor does NOT intentionally terminate merely because a delegated child is working.

Instead it has logical states:

ACTIVE
The supervisor is currently reasoning or responding.
DORMANT
The supervisor session remains available.
No model turn is running.
Runner/OS work may continue.
No polling occurs.
No model inference is consumed merely because the terminal/session remains open.
PAUSED
The supervisor remains interactive and inspectable.
Automatic progression is prohibited until explicit resume.

The central principle is:

The supervisor yields. It does not need to exit.

However:

tmux is not the durable-state mechanism.

The stronger invariant is:

Persistent when possible. Reconstructable always.

If tmux dies, Codex exits, SSH disconnects, the machine reboots, conversational context disappears, or /clear is used, repository-local durable state must remain sufficient to reconstruct supervision.

⸻

DS-004: One authoritative supervisor per repository

Exactly one authoritative supervisor identity may own automatic progression for a repository at a time.

Do not accidentally create:

bootstrap Codex
+
tmux supervisor Codex
+
recovered supervisor Codex

with all three believing they independently own the repository.

Persist sufficient information such as:

repository identity
supervisor identity
supervisor generation
session identity if relevant
authority status
creation/recovery time
last durable event

The bootstrap process must use one of two patterns:

A. Become the authoritative repo supervisor itself
or
B. Perform an explicit controlled handoff to the persistent supervisor
   and relinquish authority

Never allow two unfenced supervisors to independently launch work against the same repository.

Recovery must detect stale supervisor ownership.

If ownership is uncertain, reconcile before launching new work.

⸻

DS-005: Bootstrap cutover is mandatory

This is one of the most important requirements in the entire task.

You are NOT merely building software that a future Codex session could someday use as a supervisor.

The current effort must become the actual Durable Supervisor for opsle/durable-supervisor as soon as the minimum safe substrate exists.

There are two phases.

PHASE A: BOOTSTRAP

Perform directly only the work required to establish the minimum self-hosting substrate.

This includes enough of the following to operate safely:

durable specification
requirements matrix
repository supervisor identity
.opsle objective/state/policy storage
decision/state ledger
operator policy
provider availability state
review policy
capability discovery
authorization envelope
verifiable handoff format
Agent Gearbox decision boundary
Runner
child identity
attempt identity
claims/fencing
child lifecycle state
deterministic status
raw result persistence
Context Firewall result reduction
completion event
acceptance state
recovery/bootstrap mechanism

Do NOT continue implementing the entire V0.1 monolithically merely because direct implementation seems easier.

PHASE B: SELF-HOSTED SUPERVISION

As soon as the minimum substrate can safely support real delegation, cut over.

The current repository-level effort must then behave as the actual Durable Supervisor.

From that point:

1. Treat this entire persisted specification as the durable objective.
2. Read the requirements matrix.
3. Identify the next unsatisfied requirement or coherent bounded work unit.
4. Pass that work through authorization.
5. Create a verifiable task handoff.
6. Run capability discovery.
7. Apply operator availability policy.
8. Pass the candidate work through Agent Gearbox.
9. Establish a valid claim/fence.
10. Route execution through Runner.
11. Launch a real bounded Codex child when Gearbox selects Codex.
12. Do not invoke Claude under the initial policy.
13. While the child runs:

do not model-poll
do not repeatedly inspect status using model turns
remain logically DORMANT
allow Runner/OS lifecycle handling
allow deterministic non-model status inspection

14. On completion:

persist raw evidence
apply verification
pass output through Context Firewall
construct completion handoff
apply Acceptance
wake/reactivate supervisor
evaluate result
persist decision
update requirement matrix
select next action

15. Repeat until V0.1’s requirements are satisfied or a genuine blocker requires safe stop.

This is deliberate dogfooding:

Durable Supervisor
        ↓
builds Durable Supervisor

A V0.1 implementation completed entirely by the original monolithic Codex context without a real self-hosted:

Supervisor
→ Gearbox
→ Runner
→ Codex child
→ Context Firewall
→ Acceptance
→ Supervisor

cycle does NOT qualify as PASS.

At least one real Codex child must perform meaningful work on this repository after the self-hosting cutover.

Prefer multiple meaningful child cycles when practical.

Do not create meaningless child work merely to satisfy the test.

⸻

DS-006: Durable repository-local state

Model context must not be authoritative.

The repository should contain durable Opsle state.

Conceptually:

/project
├── AGENTS.md
└── .opsle/
    ├── specification.*
    ├── requirements.*
    ├── objective.*
    ├── state.*
    ├── policy.*
    ├── decisions.*
    ├── supervisor.*
    ├── claims/
    ├── tasks/
    ├── children/
    ├── events/
    └── evidence/

Do not treat this exact filename layout as mandatory if the existing project has a better established structure.

The required semantics are:

current objective is durable
current supervisor identity/generation is durable
supervisor state is durable
operator policy is durable
provider availability is durable
review policy is durable
material human corrections are durable
material decisions are durable
task handoffs are durable
child attempts are durable
claim/fence state is durable
policy snapshots are durable
evidence references are durable
acceptance decisions are durable
lifecycle events are reconstructable

Prefer machine-readable structures.

Use append-only or event-style history where it provides clear correctness benefits.

Do not create a database merely because persistence exists.

Repository-local files are preferable for V0.1 unless evidence demonstrates they are inadequate.

⸻

DS-007: Conversational context is disposable cache

Design explicitly for /clear.

The active conversation can contain:

architecture discussion
debugging
child summaries
status questions
operator corrections
temporary hypotheses
old implementation details
stale reasoning

None of that may be the only copy of authoritative state.

Treat model context as:

temporary
replaceable
garbage-collectable
optimized for immediate reasoning

Treat durable repository state as:

authoritative
structured
persistent
recoverable
sufficient to resume

After /clear, a fresh supervisor context must be able to reconstruct:

which repository it owns
supervisor identity
objective
current phase
completed requirements
pending requirements
active/uncertain child work
important decisions and rationale
operator policy
available providers
review mode
claims
latest relevant evidence
unresolved failures
next likely action

Create an explicit bootstrap/recovery command or mechanism.

Do not require the human to paste the previous conversation summary back into the model.

Document the human operating procedure for /clear.

⸻

DS-008: /clear reconstruction acceptance test

Create an automated or deterministic equivalent of:

1. Initialize supervisor state.
2. Persist objective.
3. Persist operator policy.
4. Delegate child A.
5. Complete child A.
6. Record result/evidence.
7. Record material decision B.
8. Record pending next action.
9. Destroy all in-memory conversational/process state.
10. Instantiate fresh recovery state using only durable repo data.
11. Reconstruct:
    - repository
    - supervisor identity
    - objective
    - phase
    - child history
    - latest result
    - decision B
    - policy
    - claim state
    - acceptance state
    - pending next action
12. Continue correctly.

The invariant to prove is:

Complete loss of conversational context does not lose supervisory state.

Do not claim this test proves the literal Codex UI /clear command if it only tests the underlying state mechanism.

Document precisely what is proven and what is operational procedure.

⸻

DS-009: Crash/restart reconstruction

Also prove recovery after simulated supervisor process/session loss.

Recovered supervision must not:

duplicate a completed child
forget a running or uncertain child
relaunch work without reconciling its prior claim
invent child success
invent review
lose pause state
lose provider availability
lose review mode
forget the objective
lose unresolved failures
silently discard evidence

Loss of tmux or Codex process must not destroy repository authority.

⸻

DS-010: Agent Gearbox is mandatory

Do NOT omit Agent Gearbox.

Every bounded work unit must conceptually pass through Gearbox unless the work is itself part of the minimal pre-Gearbox bootstrap required to establish that path.

Gearbox is the outbound intelligence control plane.

Its core question is:

What is the least expensive and simplest permitted mechanism capable of completing this work correctly?

Potential routes may include:

deterministic software
existing CLI/tool
static parser
test runner
cheap bounded helper
Codex child
another enabled provider
supervisor-local reasoning

V0.1 does not need globally optimal economic routing.

It does require an explicit, inspectable routing decision.

Record enough information to answer:

What work was classified?
What capabilities were discovered?
Which capabilities were permitted?
Which routes were considered?
Which route was selected?
Why?
What operator policy constrained the choice?
Why was model intelligence required, if used?

Do not collapse Gearbox into an invisible if statement buried inside unrelated supervisor code.

If opsle/agent-gearbox provides an operational contract, integrate it.

Otherwise build a narrow adapter with deterministic V0.1 policy and preserve replacement compatibility.

The architectural principle is:

Do not use intelligence for work that does not require intelligence.

⸻

DS-011: Capability Discovery precedes Gearbox selection

Gearbox should not be responsible for magically knowing what exists.

Establish a discovery layer that can determine available capabilities.

Potential examples:

git
pytest
npm test
ripgrep
formatters
linters
AST tooling
repository scripts
Codex CLI
Claude CLI
Opsle Context Firewall
Affected Verification
Semantic Edit Protocol
other registered Opsle capabilities

Then apply operator policy.

The sequence is:

Discovery
   ↓
what exists
Operator Policy
   ↓
what may be used
Gearbox
   ↓
what should be used

A disabled capability must not remain eligible merely because it exists on the host.

Capability discovery should be deterministic where possible.

⸻

DS-012: Provider and model availability is operator authority

Provider availability must be user-configurable and durable.

It must not be hard-coded into prompts.

Initial operator policy:

providers:
  codex:
    enabled: true
  claude:
    enabled: false
review:
  mode: off

If other providers are discovered, do not automatically enable them.

The operator must be able to inspect and change provider availability at runtime.

Provide a deterministic operator-facing interface such as:

opsle models status
opsle models enable <provider>
opsle models disable <provider>

Exact syntax may differ.

The supervisor should also be able to interpret conversational operator commands such as:

enable Claude
disable Claude
show available models
do not use Claude

and persist the resulting policy.

The deterministic CLI/config and conversational supervisor interface must modify the same underlying policy state.

Gearbox may choose only among capabilities currently permitted by policy.

⸻

DS-013: Review is separately configurable

Independent AI review is optional.

Do not conflate:

execution
verification
supervisor evaluation
independent AI review

Support an architecture capable of at least:

off
manual
risk_based
always

Initial setting:

review = off
Claude = disabled

This means:

no Claude review
no independent AI reviewer
supervisor evaluates child evidence
deterministic verification still occurs when required
child claims are not blindly trusted

The invariant is:

Supervisor evaluation       ALWAYS
Deterministic verification  POLICY/TASK DEPENDENT
Independent AI review       OPTIONAL

At runtime, the operator must later be able to change to something like:

enable Claude
review risk_based
reviewer Claude

without redesigning Durable Supervisor.

The operator must also be able to request a one-off manual independent review subject to provider availability.

Do not invoke Claude during this initial V0.1 implementation unless the human explicitly changes current policy.

⸻

DS-014: Snapshot delegation policy

Every child/attempt must durably record the policy under which it was created.

At minimum capture:

task ID
attempt ID
parent objective ID
parent decision ID
supervisor identity/generation
provider
model if relevant
reasoning/effort if available
Gearbox decision
discovered capability snapshot or reference
allowed provider set
review mode
authorization envelope
policy version/hash
claim/fence identity
expected evidence
acceptance criteria
launch time

If review was OFF today and enabled tomorrow, historical work must truthfully remain:

independent_review: none
review_policy_at_launch: off

Never retroactively imply review, provider availability, verification, or authority that did not exist at the time.

⸻

DS-015: Authorization is explicit and bounded

Delegation does not convey unlimited authority.

Before execution, establish an authorization envelope describing what the work unit may and may not do.

Example:

task:
  fix parser defect
may:
  inspect repository
  modify src/parser/**
  modify directly relevant tests
  run relevant local verification
may_not:
  deploy
  merge
  modify infrastructure
  change unrelated application areas
  modify sibling repositories
  change provider policy

Do not build an elaborate enterprise security system.

V0.1 authorization can be lightweight and file/policy based.

The important invariant is:

Every delegated child receives bounded task authority, not general repository authority.

Authorization must be represented in the task handoff and policy snapshot.

⸻

DS-016: Verifiable task handoff is mandatory

Do not delegate via vague natural-language prompt alone.

A supervisor-to-child task must have a durable structured handoff.

At minimum it should identify:

task ID
attempt ID
objective
bounded scope
authorization
required inputs
relevant context
expected deliverable
expected evidence
acceptance criteria
prohibited actions
operator policy constraints
parent decision
claim/fence identity

Human-readable child prompts may be generated from this structured handoff.

The structured handoff is authoritative.

If a dedicated Opsle Verifiable Agent Handoff implementation exists, integrate its concepts/contracts where practical.

Otherwise create the narrowest compatible bootstrap representation.

⸻

DS-017: Verifiable completion handoff is mandatory

Child output should not return as an unstructured blob.

After execution and Context Firewall reduction, construct a structured completion handoff containing at least:

task ID
attempt ID
execution status
claimed outcome
actual changed artifacts
verification performed
verification result
decision-relevant findings
unresolved issues
warnings
provenance
raw evidence references
compact evidence references
policy snapshot
claim/fence identity

Distinguish:

what the child claims
what deterministic evidence demonstrates
what remains unknown

The supervisor consumes this bounded completion handoff rather than the entire raw execution transcript.

⸻

DS-018: Claims and fencing prevent duplicate work

Durability creates a duplicate-execution risk.

Example:

Supervisor launches child-17
        ↓
supervisor/session appears lost
        ↓
recovery occurs
        ↓
recovered supervisor assumes task unfinished
        ↓
launches child-18
        ↓
child-17 was actually still running

Prevent this.

V0.1 should implement lightweight single-host claim/fencing semantics sufficient to detect and reconcile execution ownership.

Potential state includes:

work unit ID
attempt ID
claim ID
execution generation
PID
provider run ID if available
claim owner
claim status
started time
heartbeat
completion time
fence generation

Recovery rule:

Before relaunching uncertain work, reconcile whether a previous execution still owns a valid claim.

Do not build distributed consensus.

Do not build a complex lease-management platform.

Do establish the semantic invariant now.

Stale attempts must not be able to supersede newer accepted work.

⸻

DS-019: Child lifecycle is separate from supervisor lifecycle

Represent child execution independently.

Possible child states:

NONE
QUEUED
LAUNCHING
RUNNING
COMPLETED
FAILED
STALLED
CANCELLED
UNKNOWN

Supervisor state remains separately:

ACTIVE
DORMANT
PAUSED

Do not overload one state machine to represent both.

⸻

DS-020: Runner owns execution lifecycle and waiting

The supervisor must not spend model turns polling child work.

Runner/OS owns:

launch
process identity
provider run identity where available
stdout/stderr capture
raw artifact storage
heartbeat/liveness
elapsed runtime
completion detection
exit status
failure detection
timeout/stall detection
durable lifecycle events

The model must not repeatedly ask:

done yet?
done yet?
done yet?

For synchronous execution, use a blocking OS/CLI invocation that returns only on completion.

For detached/asynchronous execution, use event-driven completion/wakeup.

No model-level polling loops.

⸻

DS-021: Event-driven wakeup

When a child completes or materially changes state, the Runner/event layer must create a durable completion/state event.

The event should be capable of triggering or informing supervisor reactivation without requiring periodic model reasoning.

Integrate event-driven-agent-wakeup concepts/interfaces if available.

Otherwise implement the narrowest local mechanism necessary to prove:

child runs
supervisor does not poll
OS waits
child exits
completion event is emitted
supervisor can consume the completion

Do not use a model turn merely to wait.

⸻

DS-022: Deterministic zero-model status visibility

The human must be able to inspect what is happening without invoking model inference.

Provide deterministic status output including relevant data such as:

SUPERVISOR
repository
supervisor identity
generation
state
tmux/session liveness
objective
current phase
pause state
ACTIVE WORK
task ID
attempt ID
description
selected Gearbox route
provider/tool
PID/provider run ID
claim ID
state
elapsed time
last heartbeat
start time
completion/failure information
POLICY
enabled providers
review mode
reviewer
Gearbox status
pause status
PROGRESS
requirements verified
requirements pending
latest accepted task
latest unresolved issue

Provide a one-shot status command.

A watch-style terminal display is desirable if straightforward but must not delay the core vertical slice.

Status must come from deterministic process/durable state, not from asking the model to summarize itself.

⸻

DS-023: Human interaction remains first-class

The goal is not to remove the human.

The operator should be able to attach to the persistent repository supervisor at arbitrary times and issue interactions such as:

status?
what are you doing?
why did Gearbox choose Codex?
what evidence supports that?
show me pending requirements
pause
pause after current child
resume
change the objective
do not implement X
use Y instead
disable Claude
enable Claude
turn reviews off
enable risk-based reviews
review this task manually
clear your context and reconstruct

Material operator commands must become durable state when appropriate.

Human events and machine events are both legitimate inputs to supervision.

The conceptual model is:

                 HUMAN
                   │
       question / redirect / policy
                   │
                   ▼
            REPO SUPERVISOR
              ▲          │
              │          │
        result packet     │ intended work
              │          ▼
       CONTEXT FIREWALL  AUTHORIZATION
              ▲          │
              │          ▼
              │       HANDOFF
              │          │
              │          ▼
              │       DISCOVERY
              │          │
              │          ▼
              │       GEARBOX
              │          │
              │          ▼
              │        RUNNER
              │          │
              └──────── CHILD

Interactive questions that do not alter durable policy/objective need not mutate durable state unnecessarily.

Material redirects must.

⸻

DS-024: Pause semantics

Implement explicit pause semantics.

PAUSED means:

supervisor remains interactive
deterministic status remains available
no new automatic child work launches
existing work follows explicit safe semantics
automatic continuation stops
resume is explicit

Distinguish:

pause automatic progression

from:

cancel current child

Do not kill a running child simply because supervision is paused unless cancellation is explicitly requested or required by established safety policy.

Persist pause state across reconstruction.

⸻

DS-025: Context Firewall is mandatory on the return path

Raw child execution must NOT automatically enter expensive supervisor context.

The return path is:

Execution
   ↓
Raw artifacts
   ↓
Verification
   ↓
Context Firewall
   ↓
Bounded evidence/result packet
   ↓
Completion handoff
   ↓
Acceptance
   ↓
Supervisor

Context Firewall should suppress operational noise while preserving decision-relevant evidence and provenance.

Examples of information the supervisor generally should NOT need to ingest:

thousands of passing test lines
routine git output
package installation chatter
progress bars
repetitive logs
full stdout
full stderr when not relevant
routine command noise

Instead provide compact facts such as:

17/17 relevant checks passed
3 expected files changed
0 unexpected files changed
exit code 0
raw evidence reference: ...
source/provenance hash: ...

When something fails, preserve enough failure evidence for supervisor diagnosis.

Raw evidence must remain accessible outside the model context.

Use the actual opsle/context-firewall implementation where appropriate.

If an adapter is required, keep it narrow and replaceable.

⸻

DS-026: Decision Evidence Protocol

The supervisor must make consequential decisions from evidence rather than child confidence.

Distinguish:

child claim
deterministic observation
verification receipt
source-backed evidence
raw evidence reference
supervisor inference
acceptance decision

Example:

Child says:
"all tests pass"
Evidence says:
command exited 0
17 expected test nodes executed
17 passed
receipt hash ...

The second is decision evidence.

Integrate decision-evidence-protocol concepts/interfaces where practical.

Do not require the supervisor to reread raw logs when a sufficient bounded receipt exists.

Escalate to raw evidence when compact evidence is insufficient, contradictory, or suspicious.

⸻

DS-027: Acceptance is a distinct gate

Execution completion does not equal task acceptance.

The following are distinct:

CHILD EXITED
TASK EXECUTION COMPLETED
TASK ACCEPTED
OBJECTIVE COMPLETED

Example:

Child:
implementation done
Runner:
exit 0
Verification:
17 tests passed
Acceptance:
required test X was never run
Result:
NOT ACCEPTED

Acceptance must evaluate the delegated task’s explicit criteria and evidence.

Persist acceptance state and rationale.

An unaccepted task cannot silently advance the objective as if successful.

The supervisor decides what happens after rejection:

corrective child
additional verification
different Gearbox route
operator escalation
safe stop

⸻

DS-028: Verification remains mandatory where appropriate

Turning independent review OFF does not mean trusting children blindly.

Use deterministic verification wherever suitable.

Potential verification sources include:

test runner receipts
lint/static analysis
git/diff inspection
expected/actual file scope
schema validation
artifact hashes
exit status
repository-specific checks

Verification policy should be task-sensitive.

A child summary is not itself verification.

⸻

DS-029: Affected Verification is advisory initially

Affected Verification is conceptually relevant:

code changes
   ↓
Affected Verification
   ↓
candidate minimum verification set
   ↓
verification

However, do NOT treat Affected Verification as authoritative for reducing required verification in Durable Supervisor V0.1 unless subsequent evidence proves it safe.

The current research has demonstrated an important blind spot involving runtime/subprocess imports that static dependency evidence and testmon did not capture.

Therefore initially:

Affected Verification = advisory/experimental

It may:

suggest affected checks
produce telemetry
provide experimental evidence

It must NOT independently authorize skipping verification required by established repository policy.

Preserve an adapter/integration boundary for future use.

Record clearly if AV influenced any test selection.

Do not overstate its safety.

⸻

DS-030: Semantic Edit Protocol integration boundary

For coding work, distinguish:

intended semantic change
actual textual diff
actual semantic effect
unexpected scope

If semantic-edit-protocol provides usable interfaces, integrate them where practical.

Do not make full Semantic Edit support a blocker for V0.1.

At minimum preserve metadata such as:

intended change
expected scope
actual changed files
unexpected file indicator
semantic-edit receipt/reference if available

The architecture must allow the dedicated protocol to replace/bootstrap this later.

⸻

DS-031: Trajectory Profiler compatible telemetry

Durable Supervisor exists partly to reduce wasted model intelligence, context, polling, and human transport.

Emit durable structured events sufficient for later Agent Trajectory Profiler analysis.

At minimum attempt to capture:

supervisor activation count
supervisor reasoning turns if observable
child count
child provider/model
Gearbox route selections
deterministic route count
model route count
human intervention count
manual transport handoffs
dormant duration
OS wait duration
child execution duration
raw output bytes/tokens where measurable
compact packet bytes/tokens where measurable
retained evidence amount
suppressed evidence amount
Context Firewall reduction ratio
review count
verification count
retry count
recovery count
/clear reconstruction count
policy changes
pause duration
failed/stalled child count

Do not invent token numbers that cannot actually be measured.

Use unknown or omit metrics when instrumentation does not exist.

Make events structured enough that agent-trajectory-profiler can consume them later.

Do not require full Profiler integration to complete V0.1.

⸻

DS-032: Visible proof of value

The operator should be able to see that the architecture is doing useful work.

Where practical, status/final reports should show evidence such as:

work routed deterministically instead of to model
model children launched
supervisor dormant time
model polling avoided
raw evidence generated
evidence retained
evidence suppressed
reviews performed or skipped by policy
provider policy
recovery success

Do not claim cost savings without evidence.

Expose measured facts, not marketing estimates.

⸻

DS-033: Persistent tmux integration

Make a persistent tmux-hosted repository supervisor practical.

Provide clean deterministic mechanisms to:

derive supervisor tmux session name
start supervisor
attach to supervisor
inspect supervisor liveness
identify repository ownership
recreate session after loss
bootstrap fresh Codex context from .opsle

Prefer one predictable tmux session per repository.

Example conceptual naming:

opsle-durable-supervisor
opsle-context-firewall
opsle-agent-gearbox

Do not make tmux identity authoritative.

Durable repo state remains authoritative.

A tmux session can disappear without losing the objective.

⸻

DS-034: Recovery must reconcile running work

On reconstruction, inspect durable execution/claim state before launching anything new.

Classify uncertain work explicitly.

For example:

known completed
known failed
known cancelled
known running
stale process
unknown/unreconciled

Do not interpret process disappearance automatically as either success or failure without evidence.

Do not duplicate work when the prior execution may still exist.

⸻

DS-035: Operator policy changes are live

Changing provider/review policy should not require architectural reconstruction.

Examples:

Today:
Codex enabled
Claude disabled
review off
Tomorrow:
Codex enabled
Claude enabled
review risk_based

The supervisor should use the new policy for subsequent delegations.

Already-running child attempts retain their launch-time policy snapshot.

Historical tasks retain historical truth.

Policy changes should be durable and preferably evented.

⸻

DS-036: Gearbox must respect authorization and policy

Gearbox selection is constrained by both:

authorization
operator capability policy

A theoretically suitable route cannot be selected if:

provider is disabled
task lacks authorization
required capability is unavailable
route violates prohibited action

Persist rejected route reasons where useful.

⸻

DS-037: Gearbox may choose supervisor-local reasoning, but carefully

Not every thought requires a child.

Gearbox may determine that the persistent supervisor itself should perform a small reasoning task.

However, do not use that as an escape hatch to avoid self-hosting.

After bootstrap cutover, meaningful implementation work should normally be delegated when bounded child execution is appropriate.

The supervisor’s primary responsibilities are:

objective ownership
planning
task decomposition
routing decisions
evidence evaluation
acceptance
correction
operator interaction

not manually performing every implementation step.

⸻

DS-038: Deterministic work should avoid model delegation

Examples that often should not require AI:

git status
hash calculation
test invocation
formatting
linting
schema validation
file existence checks
process liveness
heartbeat
elapsed time
simple receipt generation
known deterministic transformations

Gearbox should prefer deterministic mechanisms for such work when adequate.

⸻

DS-039: Raw evidence must remain available

Context Firewall suppression must not destroy auditability.

For every compact packet, preserve references to relevant raw evidence.

The supervisor should be able to escalate if:

evidence conflicts
acceptance fails
child result is suspicious
compact packet lacks required detail
operator asks for supporting evidence

Escalation should be bounded.

Do not reflexively ingest every raw artifact.

⸻

DS-040: Child prompts are fresh and bounded

Child agents should receive only the context required to complete the delegated work.

They should not inherit the entire supervisor conversation.

A child prompt should be generated from:

structured task handoff
relevant repository context
authorization
acceptance criteria
policy snapshot
necessary evidence requirements

Children should report completion through structured artifacts/result packets.

Avoid open-ended prompts that effectively create another persistent supervisor.

⸻

DS-041: No model-level waiting or polling

This is absolute for normal operation.

While delegated work runs:

no repeated status prompts
no model sleep/check loops
no "wait 60 seconds and check again"
no conversational heartbeat polling

Waiting belongs to the OS/Runner.

The supervisor may remain open in tmux and logically DORMANT.

The human may manually attach and ask questions, but automatic operation must not burn model turns for waiting.

⸻

DS-042: The human may interrupt dormant supervision

The persistent session exists partly so the operator can intervene.

The human may attach while a child is running and ask:

what is running?
why was it selected?
what is the current objective?
pause after this finishes
change future review policy
show requirements remaining

Routine telemetry questions should preferably be answerable from deterministic status without requiring a model response.

Strategic questions may use the supervisor.

⸻

DS-043: Do not overbuild security

Do NOT turn Durable Supervisor V0.1 into another giant security/orchestration platform.

Avoid unless concrete evidence requires otherwise:

Kubernetes
Bubblewrap
nested sandboxes
containerization solely for purity
complex RBAC
distributed databases
distributed locks
service meshes
elaborate policy engines
multi-host orchestration
automatic production deployment
complex guest-worker infrastructure

Use ordinary OS process boundaries and existing provider behavior for V0.1.

Authorization, claims, and fencing should be semantically correct but minimal.

Security controls must be proportional to the actual threat model.

The purpose is to prove the supervisory architecture.

⸻

DS-044: No production deployment

Do not deploy Durable Supervisor to a production service during this task.

Do not modify production infrastructure.

Do not modify unrelated repositories.

Do not enable autonomous deploy/merge machinery as part of V0.1.

⸻

DS-045: Avoid premature global/multi-repo supervision

V0.1 is:

one repository
one authoritative repo supervisor

Do not implement a global Opsle program supervisor yet.

Future architecture may become:

Opsle Program Supervisor
         │
   ┌─────┼─────┐
   ▼     ▼     ▼
 Repo   Repo   Repo
 Sup.   Sup.   Sup.

but repository supervisors must remain independently bounded.

Global orchestration is out of scope for this V0.1.

⸻

DS-046: Scheduler is deferred

A scheduler may later support:

retry tomorrow
periodic checks
scheduled maintenance
time-based wakeups

Do not add scheduling merely to support child completion.

Child completion belongs to Event-Driven Wakeup.

Scheduler integration is deferred unless existing code makes it trivial and clearly relevant.

⸻

DS-047: Ephemeral workers are deferred

Disposable isolated workers may later become an execution backend.

Do not require them for V0.1.

Runner should have a replaceable execution boundary so future isolated workers can be added.

Use straightforward bounded local execution now.

⸻

DS-048: Requirements-driven task decomposition

After self-hosting cutover, use the persisted requirements matrix as a primary planning input.

The supervisor should identify coherent remaining slices such as:

durable state implementation
claims/fencing implementation
Runner lifecycle
Context Firewall adapter
status CLI
recovery
provider policy
review policy
telemetry
acceptance
tests
documentation

Do not hand the entire remaining V0.1 specification to one child.

Use bounded tasks with explicit acceptance criteria.

⸻

DS-049: Self-hosting child work must be meaningful

At least one real post-cutover Codex child must make a meaningful contribution.

Examples:

implement a bounded missing subsystem
add a substantial test suite
fix a defect discovered by supervisor acceptance
implement a CLI slice
implement recovery logic
implement policy state

A child that only changes a comment, creates a marker file, or prints “hello” does not satisfy the self-hosting proof.

Record evidence showing which child work was genuinely used in V0.1.

⸻

DS-050: Initial model/review policy

For this run, the operator policy is:

Supervisor:
  model: GPT-5.6 Sol
  reasoning effort: high
Provider availability:
  Codex: ENABLED
  Claude: DISABLED
Independent AI review:
  OFF
Supervisor evaluation:
  REQUIRED
Agent Gearbox:
  REQUIRED
Context Firewall:
  REQUIRED
Verifiable Handoff:
  REQUIRED
Authorization:
  REQUIRED
Acceptance:
  REQUIRED
Claims/Fencing:
  REQUIRED
Model polling:
  PROHIBITED
Affected Verification:
  ADVISORY ONLY

Do not independently decide that Claude review would be safer and invoke Claude anyway.

Operator provider policy is authoritative.

⸻

DS-051: Review can later be enabled without redesign

Design and test enough policy behavior to demonstrate that review mode can change durably.

For example, a test or fixture should demonstrate transition from:

Claude disabled
review off

to:

Claude enabled
review risk_based

without rewriting supervisor architecture.

Do not make an actual Claude provider call during this task.

Provider adapters may be exercised using deterministic fixtures/mocks where needed.

⸻

DS-052: Child policy history is immutable evidence

When policy changes, historical attempts retain launch-time truth.

Do not mutate old records to match current configuration.

Examples:

attempt-001
review = off
Claude = disabled
attempt-010
review = risk_based
Claude = enabled

Both remain true simultaneously.

⸻

DS-053: Acceptance criteria travel with the task

Each task must define what success means before the child runs.

Avoid supervisor acceptance rules invented only after seeing the result unless the new criterion is explicitly justified and persisted as a correction.

Expected evidence should be known where practical before execution.

⸻

DS-054: Failure is first-class

Represent failures honestly.

Potential failure categories may include:

child execution failure
verification failure
acceptance failure
provider unavailable
authorization denied
claim conflict
stale execution
Context Firewall incomplete packet
recovery ambiguity
invalid durable state
requirements contradiction

Do not collapse all failures into “child failed.”

Persist enough evidence for supervisor correction.

⸻

DS-055: Retry is a new attempt

A retry must not overwrite the prior attempt.

Use:

task ID
attempt 1
attempt 2
attempt 3

Each attempt receives:

its own claim
policy snapshot
provider selection
result
evidence
acceptance state

This is necessary for auditability and fencing.

⸻

DS-056: Corrective work follows the same pipeline

If supervisor evaluation identifies a defect, correction does not bypass the architecture.

Use:

supervisor decision
   ↓
new bounded task
   ↓
authorization
   ↓
handoff
   ↓
discovery
   ↓
Gearbox
   ↓
Runner
   ↓
child/tool

Dogfood the actual system.

⸻

DS-057: Deterministic status should survive /clear

After context clearing, the operator must still be able to run status and see current objective/policy/work without requiring historical conversation reconstruction first.

⸻

DS-058: Persistent state validation

Create deterministic validation for .opsle/ state where practical.

Examples:

schema validation
required identifiers
valid state transitions
known policy values
claim uniqueness
task/attempt parent relationships
evidence reference integrity

A malformed ledger should fail visibly, not silently degrade into guessed state.

⸻

DS-059: Durable writes should be crash-conscious

Use safe enough local file-write semantics to avoid obvious partial-state corruption.

For important machine-readable state, consider:

write temporary
fsync where appropriate
atomic rename
append-only event record

Do not overengineer a transactional database.

Do prevent trivial corruption from a process dying mid-write.

⸻

DS-060: Idempotent event handling

Completion and wakeup events may be replayed.

Handle duplicate/replayed events safely.

A replayed child completion must not:

re-accept the same attempt twice
launch duplicate next work
duplicate durable decisions
corrupt claim state

Test this.

⸻

DS-061: Reconciliation beats guessing

When durable state, process state, and provider state conflict, do not guess.

Represent uncertainty and reconcile using available deterministic evidence.

If uncertainty cannot be safely resolved automatically, pause progression and surface the exact ambiguity.

⸻

DS-062: State and event provenance

Durable records should include enough provenance to identify:

who/what created the record
time
related task/attempt
policy version
supervisor generation
source artifact/hash where relevant

Do not require cryptographic complexity everywhere.

Use hashes where they materially help evidence integrity.

⸻

DS-063: Testing strategy

Create meaningful automated tests for core invariants.

At minimum cover:

repository initialization
supervisor identity
single-supervisor ownership
supervisor generation/recovery
durable objective
durable specification
requirements matrix persistence
durable operator policy
provider enable/disable
review mode changes
Gearbox cannot select disabled provider
Discovery feeds Gearbox
authorization envelope persistence
task handoff validation
policy snapshot at delegation
claim acquisition
claim conflict
stale claim/recovery behavior
retry creates new attempt
supervisor state transitions
child state transitions
pause/resume
pause survives recovery
Runner result persistence
Context Firewall boundary
raw evidence retained outside compact packet
completion handoff
Acceptance rejects insufficient evidence
Decision Evidence distinction
duplicate event idempotency
reconstruction from disk
simulated supervisor process loss
/clear-equivalent context destruction
no retroactive review claim
deterministic status
trajectory-compatible event output
Affected Verification remains non-authoritative
self-hosted real Codex child cycle where safely testable

Prefer deterministic tests over live-provider tests.

Do not make every test require Codex API/CLI invocation.

The live self-hosting proof and deterministic unit/integration coverage serve different purposes.

⸻

DS-064: Live Codex child proof

A real Codex child is mandatory for PASS.

Use the actual Runner path after self-hosting cutover.

The child must receive a bounded handoff and perform meaningful repository work.

Capture:

task handoff
Gearbox decision
authorization
policy snapshot
claim
Runner launch
PID/provider identity where available
completion event
raw artifacts
Context Firewall result
verification
Acceptance result
supervisor decision

Do not provide the child the entire bootstrap conversation.

Do not permit the child to act as another persistent supervisor.

⸻

DS-065: Live waiting proof

During the live child run, prove that the supervisor did not perform model-level polling.

Capture deterministic evidence showing:

child started
Runner/OS handled waiting
heartbeat/status existed outside model
child completed
completion event emitted
supervisor resumed/evaluated afterward

Do not claim zero model usage if it cannot actually be measured.

The required claim is narrower:

No supervisor model turns were intentionally consumed solely to poll/wait for child completion.

⸻

DS-066: Context Firewall proof

For at least one meaningful child run, capture:

raw output size
bounded packet size
important retained facts
suppressed operational noise
raw artifact location/reference

Where measurable, calculate retained/suppressed ratios.

Do not manually dump raw output into supervisor context merely to calculate the measurement.

⸻

DS-067: Gearbox proof

For at least one meaningful action, record the Gearbox routing decision.

Prefer showing both categories during V0.1 if practical:

one deterministic operation routed without AI
one meaningful implementation task routed to Codex

This demonstrates that Gearbox is not simply “always use Codex.”

⸻

DS-068: Recovery proof

Demonstrate actual reconstruction after discarding active in-memory supervisor state.

Ideally include:

objective preserved
policy preserved
requirements preserved
latest accepted work preserved
claim state preserved
next work identifiable
review history preserved

Document exact recovery command/procedure.

⸻

DS-069: Human operating commands

Provide a concise operator interface.

Exact implementation is up to the repository design, but the operator should have practical equivalents for:

initialize supervisor
start supervisor
attach supervisor
resume/reconstruct supervisor
show status
watch status
pause
resume
show policy
enable provider
disable provider
set review mode
show current task
show requirements
show evidence reference

Avoid requiring manual edits to JSON for normal operation.

Config files may remain available for advanced use.

⸻

DS-070: Public project quality

This repository is intended to be public.

Produce understandable code and documentation.

README/docs should explain, accurately and without overclaiming:

why persistent supervisor != continuous model consumption
why tmux is convenience, not state
why model context is disposable
how .opsle state reconstructs supervision
how Gearbox controls outbound intelligence
how Context Firewall controls inbound information
how Runner waits without model polling
how operator policy controls available providers
how review can be off today and enabled tomorrow
how authorization bounds delegation
how handoffs carry verifiable task/result state
how claims/fencing avoid duplicate work
how Acceptance differs from child completion
how human intervention works
how self-hosting was demonstrated

Preserve the broader Opsle question:

What if we stopped using intelligence for work that doesn’t require intelligence?

Do not claim measured savings not supported by evidence.

⸻

DS-071: Keep README distinct from implementation authority

README is explanatory documentation.

.opsle/ durable state and validated machine-readable records are runtime authority.

Do not require parsing prose README to recover supervisor state.

⸻

DS-072: AGENTS.md behavior

If AGENTS.md is part of the repository’s established Codex workflow, update it carefully so a fresh supervisor context knows:

this repo uses Durable Supervisor
where authoritative state lives
how to reconstruct
how to inspect policy
how to avoid creating a duplicate supervisor
how to resume safely

Do not overload AGENTS.md with the entire ledger.

⸻

DS-073: Repository modifications remain bounded

Do not modify sibling Opsle repositories.

Do not rewrite existing architecture gratuitously.

Do not normalize unrelated code.

Do not change infrastructure outside what Durable Supervisor V0.1 requires locally.

⸻

DS-074: Delivery behavior

Work autonomously through implementation instead of stopping after every small design decision.

Use repository conventions.

Make bounded understandable changes.

Run relevant verification.

If normal Opsle practice uses feature branches and PRs, leave the implementation in a reviewable branch/commit and create a PR when safe and configured.

Do not merge solely to declare success unless existing repository policy clearly authorizes autonomous merge.

Do not deploy.

If an unexpected external condition makes continuation unsafe, preserve completed work and report the exact blocker.

⸻

DS-075: Do not ask the human to become the message bus again

Once self-hosting cutover has occurred, do not routinely stop with instructions such as:

copy this into another Codex
bring me its result
start Claude manually
paste this back

Use Runner and the configured providers.

The human may voluntarily intervene, but the architecture must not require human transport for normal child execution.

⸻

DS-076: No Claude review initially

This is explicit.

Current operator policy:

Claude = disabled
review = off

Do not launch Claude.

Do not ask the human to launch Claude.

Do not silently substitute another independent AI reviewer.

The persistent supervisor evaluates child result packets itself.

⸻

DS-077: Supervisor evaluation is mandatory

Even when deterministic verification passes, supervisor evaluation decides whether the task should be accepted and what happens next.

The supervisor should reason over bounded decision evidence, not blindly mirror child conclusions.

⸻

DS-078: Supervisor should not consume all raw verification output

Examples:

If 1,500 tests pass and 2 fail, the default supervisor packet should emphasize:

1498 passed
2 failed
failure identities
relevant failure evidence
verification command/provenance
raw receipt location

not all 1,500 success lines.

This is a central Context Firewall use case.

⸻

DS-079: Git noise should be reduced

Supervisor generally needs facts such as:

clean/dirty
expected changed files
unexpected changed files
branch
HEAD
ahead/behind
commit/PR identifiers

not every raw git command’s stdout.

Preserve raw evidence separately when needed.

⸻

DS-080: Decision log should be durable and concise

Persist material decisions, not every model thought.

A durable decision should capture:

decision ID
question
decision
rationale/evidence references
time
supervisor generation
related task/objective

Do not persist private chain-of-thought.

Persist conclusions and supporting evidence.

⸻

DS-081: Objective changes require durable history

If the operator changes the objective:

preserve prior objective history
record new objective/revision
record who/what changed it
record effective time
reconcile pending child work against the new objective

Do not silently rewrite history.

⸻

DS-082: Mid-child policy changes apply prospectively unless explicitly required otherwise

If provider/review policy changes while a child is running:

existing attempt retains launch policy
future attempts use new policy

If the operator explicitly cancels or changes the current task, handle that as a separate intervention event.

⸻

DS-083: Human pause and redirect precedence

Operator commands override autonomous progression subject to safe reconciliation.

If the operator says:

pause

do not launch the next child.

If the operator says:

do not implement X

persist that constraint before future delegation.

If a child is already implementing X, surface the conflict and apply the explicit child cancellation/pause semantics rather than pretending it did not happen.

⸻

DS-084: No hidden provider fallback

If Codex is enabled and Claude disabled, a Codex failure must not silently route to Claude.

Any provider fallback must be:

permitted by policy
visible
durably recorded
Gearbox-selected

⸻

DS-085: Capability unavailability must be explicit

If an expected provider/tool is not actually usable:

mark it unavailable
record discovery evidence
remove it from eligible Gearbox routes

Do not repeatedly retry a known unavailable capability without a meaningful state change.

⸻

DS-086: Child completion is not proof of correctness

Never interpret:

process exit 0

as equivalent to:

objective satisfied

Use the full chain:

completion
→ evidence
→ verification
→ Context Firewall
→ completion handoff
→ Acceptance
→ supervisor decision

⸻

DS-087: Verification evidence should be source-bound

Where practical, record:

command
working directory
relevant environment/version
exit status
timestamp
artifact hash
test identifiers/counts

Do not rely solely on prose statements.

⸻

DS-088: Compact result packets should have completeness state

Context Firewall output should indicate whether it is:

complete_for_decision
incomplete
requires_escalation
contradictory

The supervisor should not make a consequential acceptance decision from an explicitly incomplete packet without escalation or documented justification.

⸻

DS-089: Evidence escalation is bounded

If the supervisor needs more detail:

request the smallest relevant raw slice

not:

ingest every log file

Preserve the Context Firewall principle even during debugging.

⸻

DS-090: Self-hosting cutover must be durably recorded

Create a durable event marking the moment the bootstrap phase ended and self-hosted supervision began.

Capture:

cutover time
supervisor identity/generation
minimum substrate status
requirements remaining
first post-cutover task

This provides evidence that V0.1 was actually dogfooded.

⸻

DS-091: Bootstrap work is allowed before cutover, but must be minimized

Do not force unsafe self-hosting before enough substrate exists.

The bootstrap session may directly implement what is required to establish:

state
identity
policy
Gearbox route
Runner
claims
handoff
Context Firewall
event
acceptance
recovery

But it must actively seek the earliest practical safe cutover.

Record why the cutover point was chosen.

⸻

DS-092: Cutover failure must be visible

If self-hosting cannot safely occur, V0.1 cannot be PASS.

Report PARTIAL with:

what substrate works
why self-hosting was not safe
what exact missing capability blocks it
what evidence supports the blocker

Do not declare architectural completion while omitting real delegation.

⸻

DS-093: Minimal operational vertical slice

The final system must demonstrate something equivalent to:

1. Repository supervisor initialized.
2. Full specification persisted.
3. Requirements matrix created.
4. Objective persisted.
5. Operator policy persisted.
6. Supervisor identity established.
7. Remaining work unit identified.
8. Authorization created.
9. Verifiable task handoff created.
10. Capability discovery performed.
11. Operator policy filtered capabilities.
12. Gearbox selected a route.
13. Claim/fence acquired.
14. Runner launched bounded work.
15. Supervisor became logically DORMANT.
16. No model polling occurred.
17. Runner maintained deterministic status/heartbeat.
18. Child/tool completed.
19. Raw output persisted.
20. Verification occurred.
21. Context Firewall created bounded evidence packet.
22. Verifiable completion handoff created.
23. Acceptance evaluated criteria.
24. Supervisor consumed bounded result.
25. Supervisor accepted/rejected result.
26. Decision persisted.
27. Requirements matrix updated.
28. Supervisor selected next action.
29. Human could inspect deterministic status.
30. Human could pause/resume.
31. Provider/review policy could change durably.
32. Fresh context reconstructed state.
33. Simulated supervisor loss reconstructed state.
34. Historical policy snapshots remained truthful.
35. At least one meaningful real Codex child participated after cutover.

⸻

DS-094: Do not let V0.1 become a web application

No web UI is required.

tmux + CLI + durable repo state is sufficient.

Focus on the control architecture.

⸻

DS-095: Do not optimize prematurely for all AI providers

Implement clean provider boundaries.

Only Codex needs to be operationally enabled for this V0.1.

Claude should be represented in policy and future review routing but disabled.

Do not spend the project implementing every provider SDK.

⸻

DS-096: Use existing subscriptions/CLI where appropriate

The intended execution model is compatible with subscription-backed CLIs such as Codex and, later, Claude.

Do not introduce unrelated paid API dependencies if the existing CLI environment can satisfy the use case.

⸻

DS-097: Final requirement reconciliation

Before PASS:

1. Re-read the persisted complete specification.
2. Re-read the requirements matrix.
3. Check every requirement.
4. Run applicable full verification.
5. Verify self-hosting evidence.
6. Verify recovery evidence.
7. Verify no hidden Claude review occurred.
8. Verify operator policy is currently:

Codex enabled
Claude disabled
review off

unless the human explicitly changed it during the run.

9. Verify all deferred requirements have explicit V0.1 justification.
10. Verify no unresolved requirement is accidentally labeled complete.

⸻

DS-098: Definition of PASS

PASS requires a working, tested, dogfooded vertical slice demonstrating:

ONE REPOSITORY
      ↓
ONE AUTHORITATIVE DURABLE SUPERVISOR
      ↓
PERSISTENT / INTERACTIVELY ATTACHABLE SESSION
      ↓
DURABLE OBJECTIVE + SPEC + POLICY
      ↓
AUTHORIZATION
      ↓
VERIFIABLE TASK HANDOFF
      ↓
CAPABILITY DISCOVERY
      ↓
OPERATOR POLICY
      ↓
AGENT GEARBOX
      ↓
CLAIM / FENCE
      ↓
RUNNER
      ↓
BOUNDED CODEX CHILD OR DETERMINISTIC TOOL
      ↓
EVENT-DRIVEN NON-MODEL WAIT
      ↓
RAW DURABLE EVIDENCE
      ↓
VERIFICATION
      ↓
CONTEXT FIREWALL
      ↓
VERIFIABLE COMPLETION HANDOFF
      ↓
ACCEPTANCE
      ↓
SUPERVISOR EVALUATION
      ↓
DURABLE DECISION
      ↓
NEXT ACTION OR OBJECTIVE COMPLETE

AND all of these are true:

Agent Gearbox is actually in the path
Context Firewall is actually in the path
a meaningful real Codex child is used after self-hosting cutover
the supervisor does not model-poll the child
Codex can be enabled independently
Claude can be disabled independently
review can be OFF
review policy can change at runtime
provider availability can change at runtime
disabled providers cannot be selected
authorization is bounded
task and completion handoffs are structured
claims/fencing prevent obvious duplicate execution
Acceptance is distinct from completion
policy is snapshotted per attempt
status requires no model inference
pause/resume works
fresh context reconstructs state
simulated session/process loss reconstructs state
historical review claims remain truthful
raw evidence remains accessible
requirements are durably tracked
trajectory-compatible telemetry exists
Affected Verification is not incorrectly trusted as authoritative

⸻

DS-099: What is explicitly NOT required for V0.1

Do not delay PASS to implement:

global Opsle program supervisor
web UI
Kubernetes
Bubblewrap
ephemeral isolated workers
production deployment
automatic merge/deploy
complex distributed locks
distributed database
scheduler
full Semantic Edit integration
full Agent Trajectory Profiler integration
authoritative Affected Verification reduction
every possible AI provider
complex risk-scoring engine
perfect model economics
enterprise RBAC

Preserve extension points.

Do not build them now unless unexpectedly trivial and necessary.

⸻

DS-100: Final report

When work is complete or safely blocked, return a compact evidence-based report.

Do not flood the human with raw logs.

Use this structure:

VERDICT: PASS / PARTIAL / FAIL
REPOSITORY:
BRANCH:
COMMIT:
PR:
SELF-HOSTING:
- bootstrap cutover occurred: yes/no
- cutover evidence:
- authoritative supervisor identity:
- meaningful post-cutover child task(s):
- number of real post-cutover Codex child executions:
WHAT NOW WORKS:
- ...
OPSLE PIPELINE:
- Authorization:
- Verifiable Handoff:
- Discovery:
- Gearbox:
- Claims/Fencing:
- Runner:
- Event-Driven Wakeup:
- Context Firewall:
- Decision Evidence:
- Acceptance:
- State Ledger:
- Semantic Edit boundary:
- Affected Verification boundary:
- Trajectory telemetry:
GEARBOX:
- actual routing behavior:
- deterministic route proof:
- Codex route proof:
- integration status with agent-gearbox:
DURABILITY:
- specification location:
- requirements matrix:
- objective/state mechanism:
- decision mechanism:
- policy persistence:
- /clear-equivalent reconstruction evidence:
- process/session-loss reconstruction evidence:
SUPERVISOR:
- tmux/session model:
- start command:
- attach command:
- recover command:
- singleton/fencing behavior:
RUNNER / WAKEUP:
- execution model:
- heartbeat/status mechanism:
- proof of non-model waiting:
- completion event mechanism:
CONTEXT FIREWALL:
- raw evidence retained:
- compact packet:
- retained/suppressed measurements:
- escalation mechanism:
AUTHORIZATION / HANDOFF:
- example authorization envelope:
- example task handoff:
- example completion handoff:
CLAIMS / FENCING:
- claim model:
- duplicate-work protection:
- recovery reconciliation:
ACCEPTANCE / VERIFICATION:
- acceptance behavior:
- deterministic verification:
- distinction from child claims:
- Affected Verification status:
POLICY:
- Codex availability:
- Claude availability:
- review mode:
- runtime policy-change command:
- policy snapshot evidence:
- historical policy immutability:
STATUS / OPERATOR CONTROL:
- one-shot status:
- watch status:
- pause:
- resume:
- provider controls:
- review controls:
RECOVERY:
- /clear procedure:
- tmux/Codex loss procedure:
- duplicate supervisor protection:
MEASUREMENT:
- supervisor activations:
- children:
- dormant/wait evidence:
- raw vs retained evidence:
- Gearbox route counts:
- model polling avoided:
- human transport handoffs:
- metrics unavailable or not yet measurable:
VERIFY:
- focused tests:
- full tests:
- live Codex child proof:
- recovery tests:
- duplicate-event tests:
- policy tests:
REQUIREMENTS:
- verified:
- deferred with justification:
- blocked:
- unaccounted requirements: MUST BE ZERO FOR PASS
FILES / MAJOR COMPONENTS:
- ...
DEPENDENCIES / DEFERRED INTEGRATIONS:
- ...
RESIDUAL RISKS:
- ...
EXACT NEXT STEP:
- ...

If PASS is claimed, explicitly state:

The repository successfully used Durable Supervisor to perform meaningful
remaining work on Durable Supervisor itself after bootstrap cutover.

If that statement is not true, the verdict cannot be PASS.

⸻

Final operating principle

This system should make the following workflow obsolete:

Codex
  ↓
Michael copies result
  ↓
ChatGPT decides next action
  ↓
Michael copies prompt
  ↓
Codex

The target is:

Michael
   │
   │ objective / correction / policy
   ▼
Persistent Repo Supervisor
   │
   ▼
Opsle Pipeline
   │
   ├─ Authorization
   ├─ Verifiable Handoff
   ├─ Discovery
   ├─ Gearbox
   ├─ Claims/Fencing
   ├─ Runner
   ├─ Event-Driven Wakeup
   ├─ Verification
   ├─ Context Firewall
   ├─ Decision Evidence
   └─ Acceptance
   │
   ▼
Bounded Work
   │
   ▼
Persistent Repo Supervisor
   │
   ├─ continue
   ├─ correct
   ├─ verify
   ├─ pause
   └─ complete

while the human remains free to attach at any time to:

observe
ask
redirect
pause
resume
change model availability
change review policy
clear model context

without becoming the transport layer again.

Build the smallest real system that proves this architecture, then use that system to finish building itself.
