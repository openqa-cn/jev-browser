# Case schema

## Canonical YAML

```yaml
id: search-docs
name: 搜索并打开文档
start:
  url: examples/app/index.html   # http(s), file, or local path
  storage_state: optional.json
  headers: {}
goal: optional natural-language goal
tags: [smoke]
steps:
  - op: type
    target: {role: searchbox, name: 搜索, nth: 1, within: optional}
    value: Pilot
  - op: click
    target: {role: link, name: Pilot 入门}
  - op: select
    target: {role: combobox, name: Ticket}
    value: One way
  - op: scroll_down
  - op: wait
    wait_ms: 100
  - op: http
    method: POST
    url: ${API}/login
    json: {user: demo, password: ${PASSWORD}}
    expect_status: 200
    save: {token: $.data.token}
  - op: assert
    url_includes: docs.html
    title_includes: Pilot
    visible_text: 入门
    hidden_text: 错误
    expect_status: 200
    jsonpath: $.ok
    jsonpath_equals: true
teardown: []
```

`${NAME}` expands from the environment, then from values saved by `http` steps.

## Markdown verbs

```
1. Type "Pilot" into searchbox "搜索"
2. Click link "Pilot 入门"
3. Select "One way" in combobox "Ticket"
4. Scroll down
5. Wait 200 ms
6. POST https://example.com/login expect 200
7. Assert url contains `docs.html` and text "入门"
```

## API source

`GET` a JSON document. Default: a list, or `{ "data": [ case, ... ] }` where each case already looks like Canonical YAML.

Override mapping in `codexqa_jev_browser.config.yaml`:

```yaml
sources:
  api:
    headers:
      Authorization: Bearer ${TOKEN}
    map:
      items: $.data
      id: $.id
      steps: $.steps
```

## Decision JSON (auto)

```json
{
  "operation": "CLICK",
  "click_target": "7",
  "type_target": "3",
  "select_target": null,
  "confidence": 0.8
}
```

Only the target that matches `operation` is consumed. Scripted offline decisions may use a semantic `target` plus `text`.
