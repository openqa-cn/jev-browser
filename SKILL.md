---
name: codexqa-jev-browser
description: Jev browser automation with indexed actions. Replay YAML/Markdown/API cases, run goal-driven flows, generate cases, and explore sites in a real browser. Use when the user mentions Jev, browser automation, UI automation, E2E replay, test case generation, exploratory crawl, or YAML/MD/API test cases. Not a fork of browser-use/jev-ultrafast.
---

# CodexQA Jev Browser

Drive a real browser through the `codexqa-jev-browser` CLI (TypeScript). Do not invent CSS/XPath/coordinates or replace the engine with a host browser tool.

## Choose a mode

1. Existing YAML, Markdown, or API cases → `run`
2. Only a natural-language goal → `auto` or `generate`
3. Unknown site / coverage → `explore`

Install once, from this skill directory (the directory that contains `package.json` and `SKILL.md`):

```bash
npm install
```

Playwright Chromium is the browser. Do not read another application's browser profile.

## Commands

```bash
npx codexqa-jev-browser observe <url-or-local-html>
npx codexqa-jev-browser run cases/examples/search-docs.yaml
npx codexqa-jev-browser run cases/examples/search-docs.md
npx codexqa-jev-browser run --from-api https://qa.example.com/cases?suite=smoke
npx codexqa-jev-browser auto --url <url> --goal '<goal>'
npx codexqa-jev-browser generate --url <url> --goal '<goal>' --out generated/case.yaml --md --verify
npx codexqa-jev-browser explore --url <url> --out generated/explore
```

The browser window is shown by default. Set `browser.headless: true` to hide it. `--headed` forces a visible window. `--no-screenshots` skips images.

## Model setup

Do this before live `auto` / `generate --goal`. The CLI calls Jev or an OpenAI-compatible API itself. The host Cursor/Codex session model is not the decision model. `observe`, `run`, `explore`, and `--decisions` do not need a key. Do not stop those commands to ask for one.

Keys live in a `.env` file, not in the chat. The CLI loads the `.env` next to this `SKILL.md` first, then a repo-root `.env`, and does not override variables already set in the shell.

1. Read that `.env` (or `.env.example` if `.env` is missing). If `TYPESAFE_API_KEY` or `OPENAI_API_KEY` is already set, run the command. Do not ask again.
2. If neither key is set, copy `.env.example` to `.env` in the skill directory and tell the user to fill that file. Do not ask them to paste a key into the chat. Show this shape:

```bash
# Each step: which control, which goal phrase to type, whether the step worked, whether the task is done.
TYPESAFE_API_KEY=
TYPESAFE_MODEL=jev-latest
TYPESAFE_BASE_URL=https://api.typesafe.ai/v1

# Task plan before the browser opens. Also the decision and the done check when TYPESAFE_API_KEY is empty.
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
TEXT_MODEL=gpt-4o-mini
```

3. Prefer Jev when `TYPESAFE_API_KEY` is set. `OPENAI_MODEL` is only the planner unless Jev is unset. A third-party gateway is `OPENAI_BASE_URL` or `TYPESAFE_BASE_URL`, not a separate product. Set `HTTPS_PROXY` in the same `.env` only when that gateway needs a proxy.
4. `generate` writes the YAML after every successful step. Do not hand-author the case step by step while the run is walking the site.
5. Never write a key into case YAML. Never commit `.env`.

Optional CLI overrides (never `--api-key`): `--model`, `--base-url`, `--config`. Model name and gateway may also live in `codexqa-jev-browser.config.yaml` as `${OPENAI_API_KEY}`-style placeholders.

## After every run

Open or summarize `reports/<run-id>/report.html` before concluding. It contains suite totals, every step, and screenshots. Exit code is non-zero on failure. `report.json` is the machine-readable copy; `report.md` is the short summary.

## Hard rules

- Model output may only choose an operation plus an observed index. Never execute model-written selectors, JS, or shell.
- `DONE` is not success. Assertions or visible evidence decide the result.
- Secrets stay in environment variables (`${PASSWORD}`), never in case files.
- Confirm before explore/auto on logout, delete, pay, or other destructive controls.
- Prefer semantic targets: `{role, name, nth, within}`.

## Business knowledge

Per-app notes live in `knowledge/<app>/*.md`. On live `auto` / `generate --goal`, the CLI matches the start URL and the goal against each note's `hosts` and `keywords`, then appends the hits to the planner, the decision goal, and the field-text prompt. A note with `general: true` is included on every run.

Notes are reference for what to type and which visible control to prefer. They do not add operations. Do not copy them into case YAML. Add a new app by adding a note. Do not put that app's fill rules back into `src/policy.ts`.

## Case sources

- YAML is the source of truth. Markdown uses numbered Click/Type/Select/Scroll/Wait/Assert/HTTP lines.
- `--from-api` pulls cases; steps may also use `op: http` for setup or backend checks.

Schema and verbs: [references/schema.md](references/schema.md). Examples: [references/examples.md](references/examples.md).
