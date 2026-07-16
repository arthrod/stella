# ADR-0003: Kernel seams speak Standard Schema (authored in Zod 4); product edges keep their own validators

Status: accepted · Date: 2026-07-11

## Context

Stella validates with Valibot plus Elysia `t` at the HTTP boundary (exactMirror);
other consumers of the kernel validate with Zod 4. Both libraries implement the
[Standard Schema](https://standardschema.dev) spec, and both ecosystems' routers
accept Standard Schema inputs. Duplicating each shared operation's schema per
validator library is hand-synced drift waiting to happen.

## Decision

1. **Kernel and engine packages define each operation's input contract once, as a
   Standard Schema** — authored in Zod 4 (the shared engine layer already uses it).
2. **Product edges do not change.** Stella keeps Elysia `t` for HTTP route contracts
   and Valibot for web/runtime validation exactly as `AGENTS.md` prescribes. Where a
   Stella handler fronts a kernel/engine service, it validates with the service's
   schema inside the handler (or passes it to the router directly); Stella-native
   slices are untouched.
3. Zod stays pinned in the catalog within the range declared in
   `PLATFORM_VERSIONS.md`.

## Consequences

- Exactly one schema per shared domain operation; identical rejection behavior for
  the same bad input everywhere that operation is exposed.
- The schema doubles as the replayable contract in the conformance suite.
- Revisit only if Standard Schema interop bites in practice (tracked as a risk, not
  expected).
