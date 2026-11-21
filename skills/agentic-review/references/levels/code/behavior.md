# Code Behavior: From Input to Real Impact

Behavior review judges whether the implementation meets business, interface, data, and operational requirements, and supplies the code evidence for security, reliability, performance, and test findings.

## Establish the Expectation, Then Trace the Actual Path

Read the whole delegated change, necessary context, and direct dependencies; establish the expected behavior first, then follow the actual code:

```text
entry → validation or conversion → decision → state, side effects, or resource use
      → return, error, retry, or cleanup → actual consumer
```

Check the grounds of production code separately from tests, test data, snapshots, mocks, and helpers written alongside it; shared constants or documents from the same batch cannot vouch for each other.

Follow fields to the value and structure finally used, and state to its observation and recovery paths. A successful write, a passing schema check, or a helper each prove only their local result; final behavior must reach the actual consumer.

The affected behavior contracts and their dependencies set the investigation boundary. Identify which preconditions the change alters, follow real dependencies to the affected paths, including unchanged code, and work back from the expected result to find missing connections. Use a complete operation scenario to check whether the pieces together honor one contract, until the preconditions still hold or the point of failure and its consequence are established.

Removed or relaxed validation, permissions, defaults, filters, error handling, transactions, retries, cleanup, pagination, and caching need investigation too. For new, changed, or relied-upon protections, trace how raw input is converted, which branch it takes, and how it is finally used. Successful parsing only shows syntax or structure is acceptable; meaning and permission are checked against their own contracts.

When a later operation relies on a property an earlier check established, state what the check proved and what the use requires, and trace from check to use for helper calls, same-thread mutation, waits, callbacks, or concurrency that invalidate it. Holding a lock does not rule out the current thread's own mutation, and an object being alive does not prove its permissions or state are still valid.

Recovery and retries must remain the same logical operation. Without valid authorization, never silently change tenant, business date, scope, identity, idempotency key, order, or payload to make it succeed.

## Proving the Real Impact of a Code Difference

Production findings meet the [shared finding bar](../../findings.md) with code evidence:

1. **Realistically reachable**: repository code and related contracts support a real entry point and minimal trigger.
2. **Violates a requirement**: the outcome breaks an independently grounded product, API, data, security, reliability, or operational requirement; performance problems prove cost per [Performance](../../focuses/performance.md) and need no explicit SLA.
3. **Changes a material outcome**: the observable difference changes the consumer's result, judgment, next action, or failure recovery.

When a candidate depends on a combination of configurations, principals, objects, or states, or on concurrent interleaving, reason from source and contracts to a legal execution trace in which each precondition holds when its event occurs. Concurrency candidates name the actual mutator, the allowed interleaving window, and why existing synchronization does not rule out the order. If a precondition or trace cannot be confirmed, keep the specific evidence gap; unknown frequency does not refute a defect proven reachable. Simple local errors use the minimal proof.

Production impact includes returned content, state, persistence, side effects, latency, resources, and error classes, failing objects and reasons, repair guidance, and retry signals. For wrong diagnostics, say what wrong action, useless retry, duplicate submission, or extra investigation a reasonable consumer would take; machine-read signals also need a real consumption path. "Users might be confused" is not enough, and reworded output that keeps the object, class, constraint, and fix direction equivalent is not reported. Unchanged HTTP status, rejection, and write behavior only rule out differences in those aspects.

## Observations That Stay in the Notes

These are only leads on their own, unless the request or project rules state them as a [review criterion](../../findings.md#what-every-finding-must-answer):

- formatting, compile, type, or test errors CI reliably catches — independent production risks in the same change that CI cannot catch are still investigated;
- missing tests, coverage, comments, documentation, or benchmarks;
- naming, layout, design preferences, anti-patterns, or dangerous-looking function shapes;
- performance guesses without a real path, scale, and cost difference;
- problems current material cannot support that need runtime results not yet obtained.

Explicitly requested improvement or verification audits use their own evidence bars.

## Explanations That Could Refute the Suspicion

Check whether upstream validation, downstream protection, legitimate exceptions, pagination, caching, or batching helpers already handle it, and whether exact values, order, or call counts are actually contracted; then scale limits, old versions, accepted decisions, and related history. Suggested alternatives keep permissions, ordering, transactions, errors, and return meaning. When consumer material is unavailable, state the limit and do not assume compatibility.

For each retained suspicion record expected, actual, trigger, observer, substantive delta, relation to this change, and the strongest counter-evidence and its outcome. Judge severity with the [code labels](../code.md#labels-for-proven-impact) only after the finding is proven.
