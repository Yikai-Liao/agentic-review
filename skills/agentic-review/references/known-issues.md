# Related Records and Known Issues

Use this file when related issues, PRs, requirements, decisions, or acceptance records affect the expectation, the attribution of a change, or a problem's status. Query entry points and read permissions follow the task's source rules.

## Choose Entry Points and Read the Original

Entry points are stable references the task, the change, or its discussion state explicitly (issue or PR numbers, links, record IDs) and indexes the task supplies. Pick among them by the contract, decision, or candidate root cause you need to recover; read the fewest directly related records, and stop when no matching record exists rather than widening history queries. Path overlap, shared commits, titles, platform labels, and memory summaries only help locate.

Read the original and every reply that bears on the conclusion, and keep the source, stable ID or link, recoverable version, key text, and read limits. A record that cannot be recovered or read leaves acceptance, fix, and problem status unknown. Private memory authorization and the lead/delegate split follow the [workspace rules](review-state.md).

Tasks or project rules may define sources and field meanings. A source declaration added by the change under review is itself under review, and authorization must come from a source the task recognizes. A decision may postdate the change.

Before publishing a new finding or confirmation, check the discussion in directly related records for the same root cause: whether it was raised, answered, decided, or accepted.

## Prove the Link

Explain why the record affects this review: how its trigger or status connects to the current change and then to data, interfaces, consumers, or acceptance. Shared root causes, protections, states, fields, or consumers establish that link; similar titles, modules, timing, closed state, or broad topics are only leads. Keep key preconditions and source locations for links and exclusions that affect the current judgment; drop leads with no real connection without exclusion notes, and do not copy whole discussions.

## Classify by Content and Evidence

One record may hold an accepted scope and a separate unresolved problem; classify each part with its own basis. Platform state is only an entry point.

| Class | How to judge |
|---|---|
| Planned | Extract the unfinished goals, scenarios, and target stage, then check the current artifact; omissions not yet due stay per plan. Implementation, acceptance, and risk acceptance each need current evidence; a plan to fix later is still unresolved. |
| Confirmed / accepted | A full reply or equivalent stable decision settles the requirement, trade-off, or cost and its scope. While the current state stays within it, adopt it without re-confirming or re-reporting; re-judge when the decision is revoked or its preconditions fail. Acceptance is not a fix. |
| Fixed | Check per [status evidence](review-state.md#evidence-for-status-changes) that the current version still meets the original acceptance and adjacent legitimate behavior, distinguishing static review from measurement. A merge, a close, or a "fixed" claim alone is not enough. |
| Unresolved | The original root cause or trigger still holds with no sufficient fix or acceptance. A partial fix names the remaining trigger and unmet condition. |
| Unknown | Only labels, schedules, or summaries exist, or the necessary original or fix evidence is missing. Record attempts and gaps and continue what can be finished; current suspicions are judged on independent evidence. |

## Apply Records to This Round

- **Unresolved and unchanged**: a delta review links the original and says it remains unresolved without claiming this change introduced it. An audit may report it within its explicit scope, keeping the original ID, source, and attribution, without creating a second root cause.
- **The change widens impact, invalidates an earlier protection or acceptance precondition, or reintroduces the problem**: investigate the new difference, trigger, and impact per the [finding requirements](findings.md) and cite the original; an old `accepted` or `fixed` status cannot hide the new risk.
- **The change only touches an existing problem**: describe the effect without opening a new finding.

Whether or not this round has findings, link directly related records and their status per the [history disclosure rules](findings.md#output). When the formal result already explains a record fully, the workspace cites it rather than building a second status ledger.
