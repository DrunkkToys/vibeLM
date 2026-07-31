# CLAUDE.md

## Rules

### Authorization Boundary — Mandatory

- Treat requests to **inspect, check, diagnose, review, test, or report** as read-only. Do not infer permission to change anything.
- Make a change only after the user explicitly authorizes that exact class of change. If a proposed fix needs another action, explain it and obtain approval first.
- Without explicit authorization, never start, stop, restart, install, uninstall, enable, disable, move, or edit an LM Studio app, plugin, model, process, conversation, chat setting, server, or any file under `~/.lmstudio`.
- Without explicit authorization, never create branches, commits, tags, releases, pull requests, pushes, publishes, or change versioning/release configuration.
- Before every external or persistent mutation, state the target and effect. Never bundle unrelated changes into a fix.

1. **Always run tests before committing** — `npm test`
2. **Always run build before pushing** — `./build.sh`
3. **Never commit broken code** — fix errors first
4. **Always create tests for new features** — cascade tests preferred
5. **Always review changes** — check what you modified
6. **Always use meaningful commit messages** — `feat:`, `fix:`, `refactor:`
7. **Always check CI status** — wait for green before merging
8. **Always document changes** — update README if needed

## Pipeline

1. Pull latest: `git pull origin main`
2. Create branch: `git checkout -b feature/name`
3. Write tests: `tests/cascade.test.ts`
4. Implement: `src/`
5. Test: `npm test`
6. Build: `./build.sh`
7. Commit: `git add . && git commit -m "feat: ..."`
8. Push: `git push origin feature/name`
9. PR: `gh pr create`
10. Merge after CI green (`test.yml` runs on Node 20 & 22)

## Skills

Reusable workflows live in `.claude/skills/`. Prefer them over improvising:

- **add-setting** — add a `tools.*` plugin config setting end to end (config field → resolver in `toolsProvider.ts` → wire into behavior → cascade test → README + CHANGELOG). Use whenever a behavior should become user-configurable.
- **release** — cut a release. Preflight → version bump → CHANGELOG/README → PR → CI → merge → push a `vX.Y.Z` tag, which triggers `release.yml` (GitHub Release + npm publish). Use whenever the user wants to ship/publish/bump.

## Release & merge notes

- Publishing happens by pushing a `v*` tag, not by merging. `release.yml` handles GitHub Release + npm (`NPM_TOKEN`).
- `main` requires 1 approving review; on this solo repo that means an **admin merge** (`gh pr merge <#> --merge --admin`). An agent's `--admin` is blocked by the safety classifier — surface the command for the human rather than working around it.
- The **LM Studio Hub** publish step self-skips on hosted runners (no `lms` CLI). After a tagged release, use `npm run publish:hub` from the desktop app. Never call `lms push` directly: the wrapper verifies the version tag points to the exact clean commit.
