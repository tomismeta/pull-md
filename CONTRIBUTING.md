# Contributing

Keep process light, but keep `main` safe.

## Branching

- Create short-lived branches from `main`.
- Branch naming: `codex/<feature-or-fix>`.
- Keep each branch focused on one concern.

## Pull Requests

- Open a PR for every change.
- Keep PRs small and reviewable.
- Prefer squash merge into `main`.
- Do not force-push `main`.

## Required Before Merge

- CI must pass.
- Run local syntax check:
  - `npm run check:syntax`
- Update docs when behavior/API changes.
- Redact secrets/signatures in logs, screenshots, and PR descriptions.

## Commit Hygiene

- One logical change per commit.
- Clear commit messages in imperative mood.
- Avoid mixed refactor + feature changes in a single commit.
