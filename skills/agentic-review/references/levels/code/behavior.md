# Code Behavior: From Input to Real Impact

Behavior review judges whether the implementation meets business, interface, data, and operational requirements, and supplies the code evidence for security, reliability, performance, and test findings.

## Establish the Expectation, Then Trace the Actual Path

Read the whole delegated change, necessary context, and direct dependencies; establish the expected behavior first, then follow the actual code:

```text
entry → validation or conversion → decision → state, side effects, or resource use
      → return, error, retry, or cleanup → actual consumer
```

Check the grounds of production code separately from tests, test data, snapshots, mocks, and helpers written alongside it; shared constants or documents from the same batch cannot vouch for each other.

Follow fields to the value and structure finally used, and state to its observation and recovery paths. A successful write, a passing schema check, or a helper each prove only their local result; final behavior must still reach the actual consumer.

The investigation boundary is set by the affected behavior contracts and their dependencies. Identify which preconditions the change alters, then follow real dependencies to the affected paths, including unchanged code; also work back from the expected result to find missing connections. Use a complete operation scenario to check whether the pieces together honor one contract, until the relevant preconditions still hold or the point of failure and its consequence are established.

Removed or relaxed validation, permissions, defaults, filters, error handling, transactions, retries, cleanup, pagination, and caching need investigation too. For new, changed, or relied-upon protections, choose relevant boundaries and trace how raw input is converted, which branch it takes, and how it is finally used. Successful parsing only shows syntax or structure is acceptable; meaning and permission are checked against their own contracts.

When a later operation relies on a property an earlier check established, state what the check proved and what the use requires, and trace from check to use for helper calls, same-thread mutation, waits, callbacks, or concurrency that invalidate it. Holding a lock does not rule out the current thread's own mutation, and an object being alive does not prove its permissions or state are still valid.

Recovery and retries must remain the same logical operation. Without valid authorization, never silently change tenant, business date, scope, identity, idempotency key, order, or payload to make it succeed. Equivalence must preserve each of these; eventual success or tests changed alongside show only their local result.

## Proving the Real Impact of a Code Difference

Production findings meet the [shared finding bar](../../findings.md) with code evidence:

1. **Realistically reachable**: repository code and related contracts support a real entry point and minimal trigger.
2. **Violates a requirement**: the outcome breaks an independently grounded product, API, data, security, reliability, or operational requirement; performance problems prove cost per [Performance](../../focuses/performance.md) and need no explicit SLA.
3. **Changes a material outcome**: the observable difference changes the consumer's result, judgment, next action, or failure recovery.

When a candidate depends on a combination of configurations, principals, objects, or states, or on concurrent interleaving, reason from source and contracts to a legal execution trace satisfying every necessary precondition. Each precondition must hold when its event occurs, not all at once; concurrency candidates name the actual mutator, the allowed interleaving window, and why existing synchronization does not rule out the order. If a precondition or trace cannot be confirmed, keep the specific evidence gap; unknown frequency does not refute a defect proven reachable. Simple local errors use the minimal proof.

A delta review confirms differences this change introduced, widened, or re-triggered; an audit notes existing mechanisms. Locate the smallest modifiable root cause in the reviewed version and the requirement to restore, allowing different fixes.

Production impact includes returned content, state, persistence, side effects, latency, resources, and error classes, failing objects and reasons, repair guidance, and retry signals.

For wrong diagnostics, say what wrong action, useless retry, duplicate submission, or extra investigation a reasonable consumer would take; machine-read signals also need a real consumption path. "Users might be confused" is not enough. Reworded output that keeps the object, class, constraint, and fix direction equivalent is not reported.

Unchanged HTTP status, rejection, and write behavior only rule out differences in those aspects; returned content and diagnostics are checked against their own contracts.

## Observations That Stay in the Notes

These are only leads on their own:

- formatting, compile, type, or test errors CI reliably catches — independent production risks in the same change that CI cannot catch are still investigated;
- missing tests, coverage, comments, documentation, or benchmarks;
- naming, layout, design preferences, anti-patterns, or dangerous-looking function shapes;
- performance guesses without a real path, scale, and cost difference;
- problems that current material cannot support and that need runtime results not yet obtained.

Explicitly requested improvement or verification audits use their own evidence bars; production findings keep this bar.

## Explanations That Could Refute the Suspicion

Check upstream validation, downstream protection, legitimate exceptions, pagination, caching, or batching helpers already do, and whether exact values, order, or call counts are actually contracted. Then check scale limits, old versions, accepted decisions, and related history.

Suggested alternatives keep permissions, ordering, transactions, errors, and return meaning. Keep tracing a direct path while it is readable; when consumer material is unavailable, state the limit and do not assume compatibility. Performance and test methods trigger from code entry points and share the same evidence without rescanning the whole diff.

## Record and Finish

For each retained suspicion record expected, actual, trigger, observer, substantive delta, relation to this change, and the strongest counter-evidence and its outcome.

Judge severity with the [code labels](../code.md#labels-for-proven-impact) only after the finding is proven. Every affected outcome has a contract, implementation or missing path, consumer evidence, and protection analysis, or an explicit investigation limit; deliver per the shared rules.
