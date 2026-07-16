# ADR-0004: Divergence freeze on kernel primitives

Status: accepted · Date: 2026-07-11

## Context

The value of a shared foundation decays one convenient duplicate at a time: a second
pagination envelope, a third HMAC comparison, a product-local error class that
shadows a kernel one. Each duplicate looks harmless in its PR; together they re-fork
the backend.

## Decision

From this date:

1. **No new duplicated primitive.** If a capability exists in a `@stll/*` kernel
   package (errors/result taxonomy, pagination envelope, id minting, webhook
   verification, storage protocol, tenancy access, job definitions, logging
   contract), new code must consume the kernel package. Introducing a parallel
   implementation requires an issue that names ADR-0004 and states why the kernel
   package cannot serve the case.
2. **Kernel gaps are fixed in the kernel.** If the kernel primitive is missing a
   capability, extend it (with conformance coverage) instead of forking around it.
3. **Version pins move in lockstep.** Shared dependencies listed in
   `PLATFORM_VERSIONS.md` (Better Auth, Drizzle, Zod) are bumped there first;
   catalogs follow by PR. Renovate keeps the matrix honest.
4. **Reconciliation review** happens quarterly (or per milestone): diff the package
   graph against the target inventory; every drift gets a task or an explicit,
   written exemption.

## Consequences

- Reviewers can reject duplication mechanically ("kernel has this — ADR-0004")
  instead of relitigating architecture per PR.
- The freeze applies to new code; existing app-local code migrates opportunistically
  as it is touched, not by big-bang rewrites.
