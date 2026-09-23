# CodexQA Jev Browser 的工作原理

[English](HOW_IT_WORKS.md)

Agent 入口：[`SKILL.md`](SKILL.md)。给人看的说明：[简体中文 README](README.zh-CN.md)。边界：[已知限制](KNOWN_LIMITATIONS.zh-CN.md)。架构图在 README 的「架构」一节。

## 数据流

CLI 驱动真实浏览器。模型只能选择一个操作加上观测到的索引。模型写出的选择器、JavaScript 和 shell 不会执行。

1. `observe` 生成页面的索引快照。
2. `run` 回放 YAML、Markdown 或 API 用例。
3. `auto` 和 `generate` 按自然语言目标走页面。`generate` 在每一步成功后写入 YAML。
4. `explore` 爬站点，并跳过退出、删除、支付控件，除非 `--allow` 点名允许。
5. 每次运行写入 `reports/<run-id>/report.html`，以及 `report.json` 和 `report.md`。

`observe`、`run`、`explore` 和 `--decisions` 不调用模型。现场的 `auto` 和 `generate --goal` 调用 Jev 或兼容 OpenAI 的 `chat/completions` 接口。宿主会话里的模型不是决策模型。`knowledge/<app>/` 里命中的笔记会作为参考附在这次调用上。

## 已知成功与预期失败

- 已知成功回放：[`cases/examples/search-docs.yaml`](cases/examples/search-docs.yaml) 对 `examples/app/index.html`。它在搜索框输入、打开第一篇文档，并断言文档 URL 和标题。[`cases/examples/login.yaml`](cases/examples/login.yaml) 是第二条回放。
- 预期失败：断言未命中的步骤会让用例失败，teardown 仍然执行。`npm test` 覆盖这条路径。模型返回的 `DONE` 不算成功。

离线测试：在本目录运行 `npm test`。现场模型调用不在这次运行里。
