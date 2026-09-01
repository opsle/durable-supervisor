# Durable Supervisor repository instructions

This repository uses Durable Supervisor V0.1.

- Runtime authority lives in `.opsle/`, not in README prose or model context.
- Before acting after `/clear`, restart, tmux loss, or process loss, run
  `./bin/opsle.js status`, `./bin/opsle.js validate`, and then
  `./bin/opsle.js recover` if this is a genuinely new supervisor activation.
- Read `.opsle/specification.md`, `.opsle/requirements.json`,
  `.opsle/objective.json`, `.opsle/policy.json`, `.opsle/supervisor.json`, and
  `.opsle/state.json` before selecting work.
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
- Do not modify sibling repositories, deploy, merge, or broaden child authority.
- Keep operator commands mobile-safe: use short invocations and never depend on
  visual line wrapping.
