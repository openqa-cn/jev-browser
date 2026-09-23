# Known limitations

[简体中文](KNOWN_LIMITATIONS.zh-CN.md)

## What this skill does not prove

- A passing `npm test` shows the offline engine matches its fixtures. It does not show that a live site or a live model will succeed.
- `DONE` from the decision model is not a pass. Assertions or visible evidence decide the result.
- The host agent session is not the decision model. Live `auto` and `generate --goal` need `TYPESAFE_API_KEY` or `OPENAI_API_KEY`.

## Environment

| Component | Status | Notes |
| --- | --- | --- |
| Agent | Experimental | Any host that can run a shell. No vendor browser tools. |
| Runtime | Experimental | Node.js >= 20 and Playwright Chromium. |
| Model | Optional | Required only for live `auto` / `generate --goal`. |

## Boundaries

- Do not put secrets in case files. Use environment variables such as `${PASSWORD}`.
- Confirm before explore or auto on logout, delete, pay, or other destructive controls.
- Password and similarly named fields are omitted from model requests. Set `HTTPS_PROXY` yourself; the CLI does not probe local proxy ports.
