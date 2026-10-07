---
setup:
  - bun install --frozen-lockfile
---

The only dependencies are dev tools from `bun.lock` (Biome, `@types/bun`, TypeScript); the
extension itself has no runtime dependencies, since prifly's host imports `index.ts` with Bun.
After the install, `bun test`, `bun run typecheck` and `bun run check` work.

Relies on outside the worktree: `bun` on the PATH. `auth.json` and `config.json` are untracked
and only needed to run the extension against Sentry, not for tests.
