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

Playwright Chromium is the default browser. Do not download another browser unless the user has set both `CLOAKBROWSER_DOWNLOAD_URL` (https) and `CLOAKBROWSER_SHA256`. This skill does not ship a mirror. Optional GeoIP is a separate pair, `CLOAKBROWSER_GEOIP_URL` and `CLOAKBROWSER_GEOIP_SHA256`, and only when the user is allowed to fetch that file. Files land in `~/.cloakbrowser`. `browser.engine: auto` uses a local Cloak binary when one is already installed. `UI_PILOT_BROWSER=chromium` forces Playwright Chromium. Do not read another application's browser profile.

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

If Cloak is not installed, stay on Playwright Chromium. Do not invent a download URL or another browser.

## Model setup

Do this before starting live `auto` / `generate --goal`. The CLI must call Jev (`systemone`) or an OpenAI-compatible `chat/completions` API itself. Do not treat the host Cursor/Codex session model as the decision model.

1. Check the environment (and the project `.env`, which the CLI loads automatically) for `TYPESAFE_API_KEY` (Jev) or `OPENAI_API_KEY`. Optional: `TYPESAFE_MODEL`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `TEXT_MODEL`.
2. If a decision key is present, run the command. Prefer Jev when `TYPESAFE_API_KEY` exists. Do not ask again.
3. `generate` writes the YAML after every successful step. Do not hand-author the case step by step while the run is walking the site.
4. If the key is missing and the user needs a live model: stop and ask once for the API key, and whether they use a non-official gateway. Write the answers into the current shell and/or the project `.env`. Never write the key into case YAML. Never commit `.env`.
5. If the user is using `--decisions`, or only `observe` / `run` / `explore`, do not ask for a key.

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
