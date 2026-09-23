# How CodexQA Jev Browser works

[简体中文](HOW_IT_WORKS.zh-CN.md)

Agent entry: [`SKILL.md`](SKILL.md). Human overview: [`README.md`](README.md). Limits: [Known limitations](KNOWN_LIMITATIONS.md). The layer diagram is in the README [Architecture](README.md#architecture) section.

## Data flow

The CLI drives a real browser. The model may only choose an operation plus an observed index. Selectors, JavaScript, and shell written by the model are not executed.

1. `observe` builds an indexed snapshot of the page.
2. `run` replays YAML, Markdown, or API cases.
3. `auto` and `generate` walk a natural-language goal. `generate` writes YAML after each successful step.
4. `explore` crawls a site and skips logout, delete, and pay controls unless `--allow` lists them.
5. Every run writes `reports/<run-id>/report.html`, plus `report.json` and `report.md`.

`observe`, `run`, `explore`, and `--decisions` do not call a model. Live `auto` and `generate --goal` call Jev or an OpenAI-compatible `chat/completions` API. The host session model is not the decision model. Matching notes from `knowledge/<app>/` are attached to that call as reference.

## Known-good and expected failure

- Known-good replay: [`cases/examples/search-docs.yaml`](cases/examples/search-docs.yaml) against `examples/app/index.html`. It types into the search box, opens the first doc, and asserts the docs URL and title. [`cases/examples/login.yaml`](cases/examples/login.yaml) is the second replay.
- Expected failure: a step that misses its assertion fails the case, and teardown still runs. `npm test` covers that path. `DONE` from the model is not success.

Offline tests: `npm test` in this directory. Live model calls are not part of that run.
