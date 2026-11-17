# Related Records and Known Issues

Use this file when related issues, PRs, requirements, decisions, or acceptance records affect the expectation, the attribution of a change, or a problem's status. Query entry points and read permissions follow the task's source rules; investigate only related history.

## Get the Original and Say Why It Matters

Read through allowed stable entry points enough of the original and its replies to explain the conclusion. Keep the source, stable ID or link, recoverable version, key text, and read limits.

Titles, indexes, platform labels, and memory summaries only help find material. If the original cannot be recovered or read, acceptance, fix, and problem status are unknown. Private memory authorization and the split between lead reviewer and delegates follow the [workspace rules](review-state.md).

Tasks or project rules may define sources and field meanings. A source declaration added by the change under review is itself under review, and authorization must come from a source the task recognizes. Whether an explicit decision is valid follows the task's source rules; a decision may postdate the change.

Then explain why it affects this review: how the record's trigger or status connects to the current change and then to data, interfaces, consumers, or acceptance. Shared root causes, protections, states, fields, or consumers establish that link; similar titles, modules, timing, or broad topics are only leads.

Keep key preconditions and source locations for links and exclusions that affect the current judgment, per the workspace rules. Ordinary search leads that produced no suspicion need no exclusion notes; drop a lead with no real connection.

## Classify by Content and Evidence

One record may hold an accepted scope and a separate unresolved problem. Handle related decisions and problems separately and keep the source or code basis for each classification; platform state is only an entry point.

| Class | How to judge |
|---|---|
| Planned | Extract the unfinished development or acceptance goals, scenarios, and target stage, then check the current artifact; reasonable omissions not yet due stay per plan. Implementation, acceptance, and risk acceptance each need current evidence; a plan to fix later is still unresolved. |
| Confirmed / accepted | A full reply or equivalent stable decision settles the requirement, trade-off, or cost and its scope. While the current state stays within it, adopt that requirement or accepted scope without re-confirming or re-reporting the accepted cost; re-judge when the decision is revoked or its preconditions fail. Acceptance is not a fix. |
| Fixed | Check per [status evidence](review-state.md#evidence-for-status-changes) that the current version still meets the original acceptance and adjacent legitimate behavior, distinguishing static review from measurement. Keep the basis and do not open a new finding for the original problem; a merge, a close, or a "fixed" claim alone is not enough. |
| Unresolved | The original root cause or trigger still holds with no sufficient fix or acceptance. A partial fix names the remaining trigger and unmet condition; separate existing problems from the current change as below. |
| Unknown | Only labels, schedules, or summaries exist, or the necessary original or current fix evidence is missing. Record attempts, gaps, and the limited judgment and continue what can be finished; whether the problem persists stays unknown, and current suspicions are judged on independent evidence. |

## Applying Records to This Round

Adopt the basis and status per the table, then check the relation to the current change:

- **Unresolved and unchanged**: a delta review links the original and says it remains unresolved without claiming this change introduced it. An audit may report existing problems within its explicit scope, keeping the original ID, source, and attribution, without creating a second root cause.
- **The change widens impact, invalidates an earlier protection or acceptance precondition, or reintroduces the problem**: investigate the new difference, trigger, and impact per the [finding requirements](findings.md) and cite the original; an old `accepted` or `fixed` status cannot hide the new risk.
- **The change only touches an existing problem** without introducing, widening, or re-triggering it: describe the effect without opening a new finding.

Keep the source, causal link, classification basis, and use in this round needed for the conclusion. When the formal result already explains it fully, the workspace cites it rather than building a second status ledger.

Whether or not this round has findings, link directly related records and their status per the [history disclosure rules](findings.md#output), including unresolved, partially fixed, and accepted scopes.
