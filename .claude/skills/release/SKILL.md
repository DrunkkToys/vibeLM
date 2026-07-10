---
name: release
description: Cut a release of the vibeLM LM Studio plugin. Use this whenever the user wants to release, publish, ship, cut a version, bump the version, or push a new version of vibeLM to npm / GitHub / the LM Studio Hub — even if they don't say "release" explicitly (e.g. "ship this", "put out a patch", "publish 0.2.x"). Covers preflight checks, version bump, CHANGELOG, PR, CI, merge, and the tag that triggers the Release workflow.
---

# Release vibeLM

vibeLM is published by pushing a `v*` git tag to `main`. The tag triggers `.github/workflows/release.yml`, which re-runs typecheck/test/build, creates a GitHub Release, and publishes to npm. Your job is to get a clean, version-bumped commit onto `main` and then tag it.

Follow the steps in order. Do not skip preflight, and never commit directly to `main` (branch protection forbids it and the pipeline expects a PR).

## 1. Preflight — prove it's green before touching versions

```bash
npm test          # all suites must pass
./build.sh        # tsc + install must succeed
npx tsc --noEmit  # typecheck clean
```

If any fail, stop and fix first. Releasing broken code violates the project rules.

## 2. Bump the version

Pick the SemVer level from the change: `patch` (fixes/settings), `minor` (new tools/features), `major` (breaking). Then:

```bash
npm version <patch|minor|major> --no-git-tag-version   # updates package.json + package-lock.json, no tag/commit
node -p "require('./package.json').version"             # confirm new version, e.g. 0.2.2
```

Leave `manifest.json`'s `revision` alone unless the user asks — historically release commits only touch `package.json` + `package-lock.json`.

## 3. Update the docs

- **CHANGELOG.md** — add a `## [X.Y.Z] - YYYY-MM-DD` section under `## [Unreleased]`, using today's date. Group entries under `### Added` / `### Changed` / `### Fixed`. Write what changed and *why* it mattered (the CHANGELOG is read by humans deciding whether to upgrade).
- **README.md** — make sure any new settings/tools are in the settings table and the "How It Works" prose.

## 4. Branch, commit, PR

```bash
git checkout -b <feat|fix>/<short-description>   # off up-to-date main
git add <the changed source/test/doc files> package.json package-lock.json
git commit -m "feat: <summary> (vX.Y.Z)"          # use feat:/fix:/refactor:/docs: per the change
git push -u origin <branch>
gh pr create --base main --head <branch> --title "<same summary>" --body "<what + why + testing>"
```

Stage files explicitly. If `.github/workflows/release.yml` has local edits, include them **only if** they are part of the release plumbing; otherwise leave unrelated working-tree changes out of the commit.

## 5. Wait for CI to go green

`test.yml` runs on every PR to `main` across Node 20 and 22.

```bash
gh pr checks <PR#> --watch --interval 15
```

Do not merge until both jobs pass (project rule: green before merge).

## 6. Merge

`main` requires **1 approving review** (`required_approving_review_count: 1`) and `enforce_admins` is **off**. On a solo repo there's no second reviewer, so the only path is an admin override:

```bash
gh pr merge <PR#> --merge --admin --delete-branch
```

**Important:** an agent running this skill will have `--admin` blocked by the auto-approval classifier (bypassing required human review is the maintainer's call). When that happens, do **not** try to route around it — surface the exact command above and let the human run it, or have them temporarily set `required_approving_review_count` to 0. Then continue.

## 7. Tag → this is what actually publishes

Once `main` contains the version bump:

```bash
git checkout main && git pull origin main
node -p "require('./package.json').version"     # confirm main is at X.Y.Z
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing the tag triggers `release.yml`:
- typecheck → test → build → package zip
- **GitHub Release** (auto-generated notes)
- **npm publish** — runs only if the `NPM_TOKEN` repo secret is set (uses `NODE_AUTH_TOKEN`)
- **LM Studio Hub publish** — gated on `LMSTUDIO_TOKEN`, **and self-skips on GitHub-hosted runners** because the `lms` CLI ships only with the LM Studio desktop app, not npm. So a tag push does **not** actually publish to the LM Studio community hub.

Watch it: `gh run watch $(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')`

## 8. LM Studio Hub (manual, if wanted)

To actually land on the LM Studio community hub, either:
- run a self-hosted runner that has `lms` installed and a verified `lms login --token` flow, or
- publish manually from a machine with the LM Studio desktop app: `lms login` then `lms push` (the repo's `npm run push` = `lms push`). Note `lms` is often not on PATH — it lives inside the LM Studio app bundle.

Tell the user this explicitly so "published to LM Studio" isn't assumed when the CI step skipped.

## Report

State plainly what happened: version, PR link, CI result, whether the merge succeeded or is waiting on the human, the tag, and — critically — whether npm/GitHub/LM Studio each actually published or were skipped.
