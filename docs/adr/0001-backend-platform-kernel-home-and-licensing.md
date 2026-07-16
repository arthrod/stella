# ADR-0001: The backend platform kernel lives in this repo as `@stll/*`

Status: accepted · Date: 2026-07-11

## Context

Stella's backend infrastructure (error taxonomy, tenancy scoping, storage protocol,
webhook verification, pagination, ids, observability contract) is generic: none of it
is specific to the legal-workspace domain, and all of it is the hardened result of
adversarial testing (RLS probes, PII redaction, staging→finalize uploads). Downstream
products want to build on the same foundation without forking it.

## Decision

1. **Tier 1 foundation packages live in this repo**, under `packages/`, named
   `@stll/<directory>`, licensed Apache-2.0 like the rest of the repo, and published
   for external consumption. They form the "foundation kernel": errors/result,
   tenancy port, auth preset, storage port, jobs port, webhook kit, pagination, ids,
   observability contract, and the backend-conformance suite.
2. **Kernel packages are runtime-neutral (hard rule).** Only WinterTC-portable APIs:
   `fetch`, WebCrypto, streams. No `Bun.*`, no `cloudflare:workers`, no Node
   built-ins. Anything runtime-specific lives in a **driver** package selected by the
   consuming application. Enforced by lint (`no-restricted-imports` on kernel
   packages) and by running kernel tests in more than one runtime pool.
3. **Domain engines are not kernel.** Stella's domain packages (`docx-core`,
   `business-registries`, AI layer) may become portable engines over time, but they
   are a separate tier with separate versioning; the kernel never imports a domain
   engine.
4. **No third repo.** The kernel does not get its own repository or release train;
   two homes with clear tiers is enough for the current operator load. Revisit only
   if a third product appears.

## Consequences

- External consumers pin kernel packages via their dependency catalogs and upgrade by
  PR (changesets), never implicitly.
- `PLATFORM_VERSIONS.md` (repo root) is the source of truth for the shared dependency
  matrix (Better Auth, Drizzle, Zod ranges) that kernel packages declare compatible.
- The conformance package (`@stll/backend-conformance`) is the machine-checked
  definition of "derives from the same backend": consumers run it in CI.
- Anything commercially or privately sensitive must not land in kernel packages or
  their docs; this repo is public.
