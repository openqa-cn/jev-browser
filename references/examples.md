# Examples

## Replay

```bash
npx codexqa-jev-browser run cases/examples/search-docs.yaml cases/examples/login.yaml
npx codexqa-jev-browser run cases/examples/search-docs.md
```

## API cases

Serve or mock a list of CanonicalCase objects, then:

```bash
npx codexqa-jev-browser run --from-api https://qa.example.com/cases?suite=smoke
```

## Live auto (needs OPENAI_API_KEY)

```bash
npx codexqa-jev-browser auto --url https://example.com --goal '搜索北京天气' --model gpt-4o-mini
```

The CLI loads `.env` automatically. Use `--base-url` only for a compatible gateway.

## Auto without a live model

```bash
npx codexqa-jev-browser auto \
  --url examples/app/index.html \
  --goal '搜索 Pilot 并打开文档' \
  --decisions cases/scripts/decisions-search.yaml
```

## Generate and verify

```bash
npx codexqa-jev-browser generate \
  --url examples/app/index.html \
  --goal '搜索 Pilot 并打开文档' \
  --decisions cases/scripts/decisions-search.yaml \
  --out generated/search.yaml \
  --md --verify
```

## Explore

```bash
npx codexqa-jev-browser explore --url examples/app/index.html --out generated/explore
```

Dangerous names (logout / delete / pay) are skipped unless `--allow` lists them.

## Install the skill

This directory is the published skill. Install it, then run the CLI from that directory:

```bash
npx skills add openqa-cn/codexqa --skill codexqa-jev-browser
npm install
```

Playwright Chromium runs without a further download. Optional Cloak needs `CLOAKBROWSER_DOWNLOAD_URL` and `CLOAKBROWSER_SHA256` before `npx codexqa-jev-browser install-browser`.
