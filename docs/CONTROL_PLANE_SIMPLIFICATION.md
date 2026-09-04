# PR 3 control-plane simplification

## Reachable architecture

Repository supervisors write immutable Runner intent. The single host opsled
claims that intent and launches a transient Runner. Terminal events are read by
opsled, which launches one transient wake worker. The worker resolves the
current Herdr/Codex session, submits plain `codex resume`, records confirmation,
and exits. Repository `.opsle` remains project authority and immutable history.

Historical dispatcher, host-adapter, binding, delivery, and consumption records
remain readable. None can become current execution or wake authority.

## Measured simplification

Counts use exact `origin/main` (`4dc2faa5590deba1456c31b6a7e42e9207f98a12`)
and this branch working tree after the change.

| Measure | Before | After |
| --- | ---: | ---: |
| `src/*.js` LOC | 13,669 | 12,227 |
| `tests/*.js` LOC | 10,577 | 9,799 |
| Long-lived Opsle process types | 2 | 1 |
| Current child execution authority paths | 2 | 1 |
| Current wake authority paths | 3 | 1 |
| Current lock/lease/fence mechanisms | 13 | 11 |
| Durable authority record types in current execution | 12 | 11 |
| Legacy-only branches deleted | 13 | 0 remaining |

The removed long-lived type is the per-repository dispatcher. The removed child
path is direct foreground execution. The removed wake paths are repository
dispatcher delivery and direct CLI draining. Current authority no longer uses a
dispatcher fence or a tmux-authority fence.

## Remaining mechanisms: concurrent-writer test

| Mechanism | A. Exact conflict | B. Still reachable | C. Failing invariant test |
| --- | --- | --- | --- |
| Host registry/lifecycle lock | Two operator processes can register, start, stop, or upgrade opsled concurrently. | Yes; host CLI calls are independent processes. | `host-lock.test.js` concurrent exclusion and stale-owner takeover. |
| Opsled service process and release fence | A stale service or prior-release process can overlap a replacement during start or upgrade. | Yes; crash recovery and release takeover are supported. | `opsled.test.js` duplicate start; `runtime-upgrade.test.js` managed takeover and stale-helper retirement. |
| Repository host-ownership pointer | A second host opsled can try to claim one repository. | Yes; registration can be invoked from another host root. | `opsled.test.js` rejects a second host owner. |
| Immutable Runner-request claim | Restarted/competing opsled cycles can observe the same request. | Yes; scans and crash recovery can overlap. | `opsled.test.js` executes intent once and rejects cross-repository claims. |
| Runner worker process/release handshake | A spawned worker can die or be replaced before durable ownership while a new service adopts the request. | Yes; spawn-before-record and service interruption remain possible. | `detached-runner.test.js` exact live-owner recovery and dead-worker rejection. |
| Task claim generation/index fence | Two attempts or a stale supervisor generation can claim or release one task. | Yes; retries and supervisor recovery remain supported. | `invariant-harness.test.js` acquisition/release ownership vector and duplicate release. |
| Session-binding revision and atomic pointer replacement | Status and transient wake workers can refresh the current Herdr session concurrently. | Yes; they are independent short-lived callers. | `wakeup.test.js` discovery race, failed refresh preservation, and binding-revision delivery fence. |
| Wake activation lease | Multiple transient wake workers can process queued terminal events for one repository. | Yes; opsled launches repository-scoped workers without making them a control plane. | `wakeup.test.js` serializes owners and proves expiry/takeover behavior. |
| Per-event activation decision | A retry after crash or uncertain transport can revisit one event. | Yes; transport may fail after submission. | `wakeup.test.js` uncertain delivery never crosses the decision boundary twice. |
| Delivery receipt fence | Repository/session/request authority can change while plain resume is in flight. | Yes; supervisor recovery and session rotation are asynchronous. | `wakeup.test.js` mid-transport authority-replacement matrix. |
| Consumption evidence fence | Duplicate resumes or callers can attempt consumption/evaluation twice. | Yes; delivery is at-least-observed while evaluation is exactly once. | `invariant-harness.test.js` consumption ownership vector and duplicate evaluation checks. |

No retained mechanism models an independent long-lived Runner, wake worker,
repository dispatcher, tmux host, or foreground supervisor execution owner.

## Complexity review

Another 20 percent of current control-plane code cannot be deleted without
removing at least one named invariant above. The largest remaining components
are the plain-resume confirmation/uncertainty boundary, crash-safe release
takeover, Runner evidence lifecycle, and current-session validation. Each has a
reachable concurrent writer or failure and an adversarial test.
