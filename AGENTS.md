# Durable Supervisor repository instructions

This repository uses Durable Supervisor V0.1.

- Runtime authority lives in `.opsle/`, not in README prose or model context.
- After `/clear` or compaction, run `./bin/opsle.js resume-packet generate` and
  use its bounded packet as the normal first and only model-facing state read.
  After restart, tmux loss, or process loss that is genuinely a new supervisor
  activation, use `./bin/opsle.js resume-packet generate --recover` instead.
  Do not paste `recover`, `status`, validation, broad `.opsle` files, or history
  into model context. Follow only exact `evidence.escalation` references when
  the packet requires it, using `resume-packet evidence --path PATH`.
- Never create a second supervisor identity when `.opsle/supervisor.json` has
  `authority_status: AUTHORITATIVE`. Reconcile claims and active attempts first.
- Use `./bin/opsle.js policy status` for provider/review policy. Claude and
  independent review are initially disabled.
- Keep `.opsle/wake/codex-session-binding.json` separate from supervisor
  identity. Use `./bin/opsle.js session status`; never infer a binding from
  tmux or conversation context.
- Codex 0.151.0 standalone embedded-writer wake is unsupported. Normal automatic
  dispatch must retain events without `codex resume` or terminal input.
- New bounded work after cutover must use task handoff, discovery, Gearbox,
  claims, Runner, Context Firewall, Acceptance, and supervisor evaluation.
- The persistent supervisor must run repository-local capability Discovery and
  persist an exact supervisor Gearbox decision before reading, loading, or
  invoking any optional skill or tool. Category matching for code, Codex, or
  OpenAI topics is non-authoritative: it never selects Graphify, OpenAI Docs,
  web, plugins, MCP, subagents, or another optional capability. Discovery may
  identify or stat an advertised capability, but must not read its instructions.
  Narrow repository/source analysis defaults to direct deterministic inspection;
  optional routes fail closed unless the current durable decision selects them
  exactly. Platform safety mandates remain authoritative and are not optional
  routes. This supervisor-local contract is separate from child route isolation.
- Do not modify sibling repositories, deploy, merge, or broaden child authority.
- Keep operator commands mobile-safe: use short invocations and never depend on
  visual line wrapping.
