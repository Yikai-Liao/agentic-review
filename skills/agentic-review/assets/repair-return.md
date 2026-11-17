# Returning a Fix for Re-review

After revising the artifact, the author hands the new version back with the information below. It is a hand-off for the fix task and does not authorize the reviewer to modify the target.

```text
Basis for this fix: old target version, original review, related valid decisions.
New target version:

F1:
- Which mechanism changed?
- Why is the original completion condition now met?
- Which adjacent legitimate behavior should still hold?
- Which verification actually ran? Where are the version, environment, and raw results?
- Which verification did not run, and which conclusions remain unproven?

Other changes beyond the fix:
Did any higher-level requirement or accepted cost change:
Which problems remain unresolved, or which risks should be explicitly accepted:
```

Change only authorized scope. Fixes must keep the original goal, legitimate inputs, and necessary verification; a fix different from the suggestion is acceptable if it truly meets the requirement.

"Passed independent review" is marked by the reviewer after re-checking the new version and evidence.
