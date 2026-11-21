# Security: Who May Do What to Which Resource

Security review starts from real permissions and trust boundaries and checks whether identities, data, or operations cross agreed boundaries. Dangerous function names only locate paths to trace.

Use it for explicit security reviews of architecture or code, and in full reviews for changes that add, relax, or rely on security boundaries. Requirements-level security promises are checked with that level's scenario, scope, and consistency methods; implementation security is proven along real design or code mechanisms.

## Map the Real Permission Relationships

Establish the acting principal, where its identity comes from, who owns the resource or tenant, what is allowed, where trust boundaries lie, and which sensitive data is involved. Grounds come from real consumers, permission contracts, and valid decisions; do not invent attacker capabilities or require one security design everywhere.

A trust boundary is where information passes or operations execute between parties of different trust. The key question is why the receiver believes the information; a function named "validate" is only an entry point.

## Follow Identity and Data to the Real Outcome

At architecture level, check whether — with every party following the given rules — the design still adopts identities or permissions from a low-trust party directly, or lets sensitive results cross a boundary nobody owns.

At code level, follow real entry points:

```text
obtain identity and input → convert → authorize, filter, or execute → actual return or side effect
```

Show how, under realistic attacker capability, an unauthorized principal obtains data or performs an operation, meeting the [code behavior proof](../levels/code/behavior.md). Trace only paths causally linked to the chosen boundary.

Example: a tenant ID comes from a user-editable request field, resource reads are not bound to the authenticated identity, and the real return path hands another tenant's data to the caller — this can prove a boundary breach. If the field is only a query hint and the service still checks ownership with the trusted identity, the presence of `tenant_id` alone does not prove cross-tenant access.

## Test the Boundary Along Relevant Paths

Starting from the resources or operations involved, choose checks by actual mechanism; one path shares its evidence.

| Mechanism | Investigation |
|---|---|
| Several entry points produce the same effect | Compare authorization objects and conditions across direct, bulk, import, and background paths; follow the weaker one to its outcome |
| Data has copies or other exits | Follow sensitive content into caches, search, exports, backups, logs, and error responses; check who can read it and how permission or deletion contracts take effect |
| Converted values drive decisions | Compare the identity, resource identifier, and scope the validator and the consumer actually use; check whether parsing, normalization, or field overriding changes meaning |
| Permissions or state change | After revocation, credential refresh, migration, or recovery, check whether old credentials, queued jobs, and recovered data still allow revoked access |

Example: the contract stops access after revocation, but search still returns content by the ACL captured at indexing. "Index → revoke → search" checks whether a former member can still read it. If results are re-authorized against the current ACL before returning, the path is protected.

This judges access; delivery guarantees after interruption reuse [Reliability](reliability.md).

## Mechanisms That Block the Breach

Check upstream authentication, downstream resource authorization, data conversion, deployment limits, redaction, and real consumer paths. A `defect` needs a grounded security requirement, realistically reachable capability, breach mechanism, and impact; a proven breach is never downgraded to "please confirm".

When a change genuinely alters a security guarantee but lacks a necessary authorization or decision now, raise a `decision` with the smallest question. Business decisions, run or release permissions, and higher-priority security constraints each take effect from their own sources.

Verification coverage enters [Verification](verification.md) per the delegated scope; leak conclusions still need a reachable breach mechanism and impact.

A fix restores the boundary so the original breach scenario fails while legitimate access succeeds, by any mechanism. When necessary permission material is unavailable, state the limit; there is no security sign-off without it.
