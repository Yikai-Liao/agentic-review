# Maintaining or Extending the Method

Before supporting a new review target or focus, confirm it has real use cases and a judgment method of its own. Add files only for real branches; shared evidence, finding, state, and permission rules are reused.

## Adding a Level: Explain Why It Differs

Levels separate review targets, such as requirements, architecture, plans, and code. A new level answers:

- Which artifact is reviewed, how coverage units are split, and how omissions are found from the goal?
- Where independent grounds come from, what must be settled at this stage, and what may wait?
- Which methods are default, which trigger on related changes, and which need an explicit request? How are narrow reviews chosen?
- Which methods reuse focuses directly, and which level-specific differences need local explanation?
- Which problems the level's author handles, and which need someone else to decide?

Add only the level entry, genuinely different methods, and necessary links; stopping conditions and the workspace follow the shared rules.

## Adding a Focus: Explain How It Judges Good and Bad

Focuses separate angles of inspection, such as intent alignment, reliability, and maintainability. A new focus answers:

- What it evaluates, when it triggers, which levels it applies to, and which similar requests are out of scope?
- Which mechanism to follow, and which concrete scenarios and evidence distinguish good from bad?
- Which shared finding kind it uses, and what domain evidence it adds?
- Which protections, legitimate exceptions, independent purposes, or alternative costs can refute a suspicion?
- How evidence is gathered at each level, and where specialized methods should be cited?
- How the original completion condition is met while allowing different implementations that reach it?

Shared methods live in the focus file; levels add only their own examples and differences. If a new finding kind is genuinely needed, first explain why the four [shared kinds](../references/findings.md#the-four-kinds) cannot express it, then change the shared requirements once; all focuses use the same reporting bar.

## Permissions and Regression Evidence

Execution permission comes from the task and the [evidence access rules](../references/evidence-access.md); new focuses keep those execution and publication boundaries. State, re-review, and stopping are defined by the [shared workspace rules](../references/review-state.md); specialized methods only add how this domain proves a fix.

Prepare cases with inputs separated from expectations, covering holds, does not hold, inherited evidence, reinvestigation after a premise change, alternative fixes, and narrow scope. Cross-level methods check at least one real goal relationship; identical examples per level are not required.

Mark verification cases not actually run as `not_run`. Keep case run records separate from review coverage; coverage still uses `pending`, `complete`, and `blocked`. Model behavior is proven by case results matching the method's requirements; file, link, and keyword checks only verify static wiring.
