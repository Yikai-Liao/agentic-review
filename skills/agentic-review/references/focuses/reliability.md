# Reliability: Do Guarantees Survive Failure?

Reliability review asks whether agreed outcomes hold after interruption, failure, concurrency, or retry, and who detects and recovers unfinished work.

Use it for chosen reliability investigations in architecture, plans, and code; ordinary semantic review still catches clear violations. Pick failure scenarios by the objects involved and existing guarantees. At requirements level, first check that guarantees and exceptions are clear; recovery mechanisms belong to design.

## State the Guarantee, Then Choose Failures

Establish where the guarantee comes from, in which environments it holds, what this stage must achieve, and who or what mechanism carries it. Goals such as exactly-once, zero downtime, unlimited retries, or cross-region recovery need real grounds. When a known platform lacks the capability a guarantee needs, treat it as a contradiction between guarantee and capability.

| Level | What to trace | How a problem is proven |
|---|---|---|
| Architecture | Responsibilities, persistent records, state changes, external side effects, and acknowledgements | After an allowed interruption, no participant can honor the guarantee |
| Plan | Independently deliverable phases, parallel order, pause and rollback ownership | The final design is right but an intermediate state the plan allows violates a requirement |
| Code | Validation, calls, writes, errors, retries, cancellation, and cleanup | A reachable input or ordering gives a real consumer the wrong result |

## Walk One Operation Through Interruption and Recovery

Consider a pause or failure before and after each relevant acceptance, commit, side effect, acknowledgement, cancellation, or hand-off; also check concurrency, retries, and completion orders the system allows.

Keep tracing: who detects the unfinished work, which fact recovery relies on, whether a redo is still the same logical operation, and what was acknowledged to whom. Recovery must never quietly change tenant, business date, identity, idempotency key, order, or payload to succeed. Directly related normal operations must also hold.

Example: the system promises "acknowledged tasks survive restart" but acknowledges right after writing to an in-memory queue. A crash then may lose the task forever. If a persistent record and an explicit scanning owner recover it within an accepted time, the task is still recovered and a lost notification only affects the notification path.

Loss, duplication, resource exhaustion, and wrong recovery hints may be distinct consequences; merge by the root cause that can actually be fixed, not by scenario count.

## Confirm the Failure Is Reachable

A `defect` needs the guarantee's source, an allowed trigger, the mechanism, and a concrete consequence; code problems also meet the [code behavior proof](../levels/code/behavior.md).

When an external capability is unclear and the next step already depends on it, investigate as a `decision` what fact is needed; the capability stays unknown. Contradictions written into a design can be proven statically; internal details legitimately left to a later owner follow the stage plan.

Look for upstream input limits, persistent recovery, idempotency or transaction protection, deployment limits, rollback scope, real timeouts, and accepted costs. A plan's atomic delivery is checked as a whole; failure scope comes from the system's existing guarantees.

Whether verification can catch the error is a separate question; use [Verification](verification.md) only when delegated or due now. Gather implementation behavior and verification status separately: the former along the mechanism, the latter from actual tests or analysis.

A fix restores the guarantee in the original failure scenario and keeps directly related normal behavior; accepted recovery times remain valid within their scope.
