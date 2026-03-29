# Agents

Context for AI agents working on this codebase.

## Architecture

- **`src/git.ts`** — Git operations. Uses `child_process.execFile` (no Bun APIs). All async. Key functions: `getChangedFiles`, `getFileDiff`, `getAllFileDiffs`, `discoverGitRepos`, `getMultiRepoDiffs`.
- **`src/cli.ts`** — HTTP server + CLI entry point. Uses `node:http` (no Bun APIs). Serves pre-built frontend from `dist/public/`. SSE keepalive at `/api/keepalive` for auto-shutdown.
- **`src/ui/app.tsx`** — React frontend (single component tree). All state in `App()`. No routing library.
- **`src/ui/styles.css`** — CSS with CSS variables for theming. Two themes: `[data-theme="dark"]` (default) and `[data-theme="light"]`.
- **`scripts/build.ts`** — Build script using Bun's bundler. Outputs to `dist/`.

## Build

```bash
bun run build    # builds dist/cli.mjs + dist/public/
```

The build uses Bun but the output is Node-compatible. The CLI shebang is `#!/usr/bin/env node`.

## Key Patterns

- **Multi-repo**: If target dir isn't a git repo, scans immediate subdirectories for `.git`. Each `FileDiff` has an optional `repo` field. Frontend uses `makeFileKey(diff)` → `"repo:path"` for unique identification.
- **Base ref diffing**: `--base main` uses `git merge-base` to find the fork point, then diffs everything (committed + dirty) against it.
- **Inline comments**: No modal — click `+` on a line, textarea appears inline, `Cmd+Enter` saves. Comments stored in React state as `Comment[]` with `fileKey` for cross-repo uniqueness.
- **SSE shutdown**: Frontend opens `EventSource("/api/keepalive")`. Server tracks connections and exits 500ms after last client disconnects.

## Gotchas

- `isGitRepo()` checks `git rev-parse --show-toplevel` matches the target directory exactly — prevents false positives from parent repos.
- `realpath()` is used on CLI input to resolve symlinks (macOS `/tmp` → `/private/tmp`).
- `getBranches()` must escape the git format string to avoid Bun shell interpolation issues — the `%(refname:short)` format is stored in a variable first.
- Frontend uses `position: fixed` for the multi-repo tooltip because the sidebar has overflow constraints.
- The `file-item` ref callback only auto-focuses when the file list already contains the active element — prevents stealing focus from the inline comment textarea.
