# Maintainability: Judging Complexity by Real Tasks

Maintainability review covers the cost of use, change, and collaboration, for explicitly requested cost or simplification audits of architecture, plans, and code.

Unnecessary solution constraints in requirements use the [requirements method](../levels/requirements.md); code maintenance metrics do not apply to requirements.

## What to Keep and Which Cost to Reduce

Keep confirmed business behavior, permissions, state and recovery semantics, compatibility and deployment boundaries, realistic performance requirements, and costs explicitly accepted this round. Pick the complexity to reduce from real calls, real change tasks, or the user's stated concern.

Without a named design philosophy, judge direct task cost: to do the same thing, which independent decisions must be understood or coordinated, and which state must be kept in sync by hand. A design method the user names can supply grounds; the concrete architecture still follows the task goal and evidence, and other skills are dependencies only when actually available and adopted by the task.

Without change history, use calls the current real capabilities need or explicitly planned changes. Extensibility benefits are limited to these grounded tasks.

## Follow a Task to What Must Be Understood and Synced

The target may be several implementations of one business rule, a call sequence, a set of coordinated states, an intermediate mechanism, or a delivery dependency. First trace how the task gets done, then mark the code that causes real cost; "over-engineered" shapes are only leads.

A thin adapter may carry a real boundary; maintenance cost depends on independent decisions and manual sync points.

## Four Ways to Test the Current Design

### Walk a real change

List the places that must change together to stay correct, the independent decision each needs, and the consequence of missing one. Separate manual duplicated interpretation from generated copies or shared configuration; generated copies are not multiple sources.

### Walk a legitimate call

Have a real caller complete an operation and check which internal states it must know, which mutually constrained steps it must call in order, and what cleanup and recovery it performs. Separate knowledge inherent to the business from internal details forced onto the caller.

### Check whether a mechanism can be removed

Ask what necessary responsibility it carries, then check real consumers, permission isolation, lifecycle, caching or batching, migration, and compatibility uses. Only when it truly has no independent role, reason about behavior after removal or merging.

A removal proof must cover real consumers and the mechanism's responsibilities; record the limit when necessary consumers are unavailable. Test deletion uses the independent-detection and deletion proof in [test review](../levels/code/test-contracts.md).

### Compare with a feasible alternative

Propose a locally feasible alternative, walk the same task again, and say which required knowledge, manual sync points, authoritative states, or waits disappear. A conceptual sketch is enough; the alternative must use currently available platforms, change locally, and keep existing guarantees.

## Which Simplification Opportunities to Report

All four must hold:

1. **Real task**: from current requirements, real calls, or a clearly reasonable maintenance operation, not an imagined future.
2. **Concrete cost**: name the understanding, coordination, or change burden a mechanism causes; line counts, file counts, complexity metrics, or names are only leads.
3. **Feasible alternative**: at least one cheaper path that keeps the necessary guarantees, with directly related dependencies checked.
4. **Benefit exceeds new cost**: say where the benefit lands and what migration, new coupling, rollback, and learning cost; explain why it is worth considering this round. Without data, do not invent percentages, hours, or token savings.

If the alternative cannot be shown to keep the necessary guarantees, exclude the suspicion. When both styles are reasonable with no real cost difference, record no problem.

Usually an `improvement` that does not block by default; complexity violating an explicit agreement is proven as a `defect`.

## Look for Reasons the Current Structure Should Stay

Check first for generated or shared sources of truth, independent security or deployment boundaries, different lifecycles, genuinely different business rules, runtime cost optimizations, migration transitions, and accepted local duplication with an explicit deadline. Also check whether the alternative exposes more internal knowledge and whether the current design is already a reasonable choice under its constraints.

When complexity moves from a service to its callers, from code to operations, or from explicit state to implicit ordering, recompute total cost over the whole task. Alternatives must keep necessary validation, error branches, audit records, and idempotency state.

| Level | A concrete question to investigate | Reasonable explanation to check |
|---|---|---|
| Architecture | One entity has two manually maintained authoritative states that need two-way coordination on every change; would one owner plus derived reads be simpler? | Offline autonomy truly needs a copy, or one is only a read-only cache |
| Plan | The same capability is prepared and integrated twice; can reordering cut waits without losing acceptance? | Two different deployment environments truly need separate acceptance |
| Code | One business rule is hand-implemented in three places; would a shared implementation cut syncing and keep behavior? | Similar expressions belong to different business rules, or copies are generated |

## Delivery and Re-review

Report improvements by the four bars above. On re-review, check whether task cost fell and necessary guarantees held; accept any design meeting the condition, and report broken guarantees as specific violations.

The round ends when the delegated complexity has been walked through related tasks, checked for independent purpose, and counter-checked.
