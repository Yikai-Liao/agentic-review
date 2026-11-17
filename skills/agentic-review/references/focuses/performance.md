# Performance: Proving Significant, Avoidable Cost at Realistic Scale

Performance review checks runtime and resource cost at realistic scale and the decisions and evidence this stage needs. Cost includes CPU, memory, transfer, remote round trips, lock and transaction holding, queues, latency, and external service fees; the understanding cost of change and collaboration uses [Maintainability](maintainability.md).

## What Each Level Must Answer

| Level | Main judgment |
|---|---|
| Requirements | Are current performance targets and acceptance grounded and sufficient for the next step? |
| Architecture | Can mechanisms and capacity support the goal at realistic scale, and is the cost significant and avoidable? |
| Plan | Does performance evidence precede decisions depending on it; are capacity verification, migration, and rollout protection owned? |
| Code | Operation counts, complexity, memory, and remote round trips on the real path relative to before the change or a feasible alternative |

A proven order-of-magnitude regression or resource exhaustion can be reported on real cost without an explicit SLA. Performance conclusions still need an independent goal, realistic scale, and a cost difference; without them, stay unknown.

A delta code review compares base and head; a code audit compares the current path with a behavior-preserving alternative. Other levels also name their baseline: an existing contract, the current proposal, or a feasible approach that keeps the goal.

## Build a Checkable Cost Model

Establish what each operation costs and how often it repeats. Combine along the real path, without predicting milliseconds:

```text
frequency × per-operation cost × page or collection size × amplifiers such as retries and compensation
```

The model must state:

- what N, M, pages, batch size, payload, concurrency, or retry count mean;
- whether scale comes from real scenarios, callers, data-structure limits, API limits, pagination config, tenant data, or existing code;
- current and baseline operation counts, complexity, peak memory, or remote round trips;
- which requirement scenario, design path, or code call path incurs the cost.

Example: a real request reads ten thousand IDs and the existing API reads them equivalently in batches of a thousand. Going from ten batch calls to ten thousand single calls is a concrete difference; "calling an API in a loop might be slow" is not.

## Proportionate Evidence per Level

### Requirements: set targets without prescribing implementation

Confirm from real user scenarios and external constraints why scale, waiting time, capacity, or resource cost affects the outcome. An unknown needs deciding now only when the next step already depends on a target or trade-off; batch sizes, caches, or concurrency are chosen at architecture.

Acceptance must separate meeting and missing the target, with precision matching the real decision. Existing limits, orders of magnitude, interaction deadlines, or external quotas may be used when they suffice; ungrounded numbers stay unknown.

### Architecture: check capacity mechanisms along the design path

Pick realistic scenarios and build a cost model along entry points, data movement, remote boundaries, shared resources, and critical waits. Check that batching, pagination, backpressure, caching, indexes, concurrency limits, or offline processing actually exist and are owned; technology names only locate mechanisms.

Before code exists, known bounds can prove mechanism contradictions or unbounded resources; when a measurement not yet available is required, state the hypothesis to verify and its due stage. Architecture compares against design alternatives and uses the shared kinds; benchmark gaps follow current dependencies and due stages.

### Plan: get evidence before the decisions that depend on it

When architecture choices, migrations, releases, or capacity commitments depend on unconfirmed performance facts, check that the plan schedules a discriminating analysis or experiment before the related investment and names who adjusts later actions from the result. Local implementation tests prove local behavior; integrated capacity needs evidence covering real scale and boundaries.

Load tests are triggered by current performance guarantees or later dependencies. Verification sufficiency uses [Verification](verification.md); this focus only names the mechanism, scale, and cost difference to verify.

### Code: find cost amplification along the real path

These changes warrant investigation but do not decide a finding on their own:

- nested linear scans, or repeated sorting, aggregation, parsing, compiling, serialization, decompression, or copying in loops;
- per-element database, GraphQL, REST, object storage, Redis, or RPC calls;
- fetching everything before filtering, deduplicating, or paginating client-side;
- streaming replaced by loading everything into memory, or repeatedly copying a growing buffer;
- bounded batching replaced by unbounded concurrency such as `Promise.all`, goroutines, or threads;
- external I/O moved inside transactions, global locks, tenant locks, or critical request threads;
- per-item retry becoming whole-batch redo, or retries multiplying across layers;
- repeated queries, conversions, or large-object reads on the same path;
- lost caching, deduplication, pagination, short-circuiting, index selectivity, or source-side filtering;
- asynchronous, offline, or on-demand work moved onto a synchronous hot path.

Code problems also prove the real entry point, scale, and impact with [code behavior](../levels/code/behavior.md).

## Reaching the Reporting Bar

With an independent performance guarantee, prove trigger, violation, and real impact per the shared defect bar. Without one, an architecture or code problem rooted in "significant, avoidable cost" must prove all three: real cost meets a threshold below, a cheaper behavior-preserving alternative exists, and the cost causes concrete impact.

### Real cost meets at least one

1. Input is not a small static constant and complexity worsens by an order relative to the baseline, such as `O(N)` to `O(N²)`.
2. Database or remote round trips go from constant or batched to per-item, multiplied across two collections, or nested pagination.
3. At project-supported realistic limits or common scale, a static lower bound proves CPU, calls, transfer, allocation, or peak memory grow about tenfold.
4. One request or operation can trigger unbounded concurrency, full in-memory expansion, queue growth, or resource exhaustion.
5. External waits significantly extend transaction or lock holding, causing a clear connection-pool, lock-contention, or throughput limit.
6. Retries, timeouts, or partial success replay the same batch of work or external side effects multiple times.

### A cheaper behavior-preserving alternative exists

Name a currently feasible cheaper path, such as the old mechanism, a standard data structure, or a capability of current dependencies, and show permissions, ordering, transactions, errors, returns, and recovery hold.

### Real impact and root cause

From the verified trigger scale, state consequences for request counts, latency lower bounds, rate limits, memory, connections, queues, or bills, and locate the earliest decision or mechanism to change. Code findings also give the smallest root-cause line range in the reviewed version.

"Might be slow with large data" lacks this proof. A missing performance target or trade-off that must be settled now is a `decision`; missing performance evidence due now is a `verification-gap`; an actual cost regression needs runtime or static lower-bound evidence.

## Reasonable Explanations for the Cost

Before reporting, check:

- whether goals, types, schema validation, or callers bound the input to a small constant;
- whether the path is a one-off migration, offline maintenance, or very rare admin operation;
- whether the design, helpers, or SDK already batch, reuse connections, cache, paginate, apply backpressure, or limit concurrency;
- whether batching or async changes authorization, atomicity, ordering, quotas, failure, or recovery;
- whether sequential execution comes from rate limits, idempotency, locks, or external protocol constraints;
- whether bounded concurrency is deliberately traded for lower latency;
- whether the baseline already has the same order of cost;
- whether the alternative changes output stability or other confirmed boundaries.

Any one that refutes "significant and avoidable" excludes the suspicion. For explicitly accepted costs, check that the accepted scope and its preconditions still hold.

## Delivery and Re-review

Code performance problems use the [code P0/P1/P2 labels](../levels/code.md#labels-for-proven-impact). Complexity notation does not set severity; realistic scale, frequency, per-step cost, concurrency, and real impact do. Other levels use the shared kinds, not code labels.

Each delegated performance unit has current and baseline cost models, scale grounds, an alternative, and a counter-evidence conclusion, or a reason it does not apply at this stage. Re-review confirms with evidence that the original cost difference is resolved and behavior kept; when a needed measurement is still missing, mark it unverified.
