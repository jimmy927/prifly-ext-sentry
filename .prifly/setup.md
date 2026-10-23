---
setup:
  - bun install --frozen-lockfile
---

The only dependencies are dev tools from `bun.lock` (Biome, `@types/bun`, TypeScript); the
extension itself has no runtime dependencies, since prifly's host imports `index.ts` with Bun.
After the install, `bun test`, `bun run typecheck` and `bun run check` work.

Relies on outside the worktree: `bun` on the PATH. Nothing else: the tests use a fake prifly
(`test/fake-prifly.ts`), and the Sentry login lives in prifly's vault, not in a file.
