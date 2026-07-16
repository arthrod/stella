# Platform version matrix

Source of truth for the dependency ranges that `@stll/*` kernel packages declare
compatible. Consumers (this repo's apps and any external consumer of the kernel)
pin these in their dependency catalogs; bumps land here first, catalogs follow by
PR (see `docs/adr/0004-divergence-freeze.md`).

| Dependency | Kernel-compatible range | This repo pins | Notes |
| --- | --- | --- | --- |
| better-auth | `1.6.x` (>= 1.6.10) | `1.6.20` | `organization` plugin config is part of the auth-kit preset contract; do not skew majors/minors across consumers. |
| drizzle-orm | declared per driver package | `1.0.0-rc.1` | Dialects differ per driver (`pg` vs `libsql`/`d1`); the tenancy port is version-agnostic, drivers pin their own dialect range. |
| zod | `^4.1` | `4.4.3` | Kernel/engine seam schemas (ADR-0003). Standard Schema v1 is the interop contract. |
| better-result | `2.9.x` | `2.9.2` | Kernel error/result convention (`Result<T, TaggedError>`); the error-contract table lives in `@stll/errors`. |

Known consumer skew (to be closed by catalog PRs, tracked at adoption):

- better-auth `1.6.10` and drizzle-orm `^0.45.1` are in circulation downstream;
  both are older than this repo's pins. The auth-kit preset targets the `1.6.x`
  line — consumers should move to >= this repo's pin before adopting the preset.

Update procedure: bump here in the same PR that bumps this repo's catalog; open the
consumer catalog PR immediately after; Renovate flags any matrix entry that drifts.
