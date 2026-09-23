# 已知限制

[English](KNOWN_LIMITATIONS.md)

## 本 skill 不能证明什么

- `npm test` 通过只说明离线引擎与夹具一致。它不能说明真实站点或现场模型会成功。
- 决策模型返回的 `DONE` 不是通过。断言或可见证据决定结果。
- 宿主 Agent 会话不是决策模型。现场 `auto` 和 `generate --goal` 需要 `TYPESAFE_API_KEY` 或 `OPENAI_API_KEY`。

## 环境

| 组件 | 状态 | 说明 |
| --- | --- | --- |
| Agent | 实验性 | 任何能跑 shell 的宿主。没有厂商专用浏览器工具。 |
| 运行时 | 实验性 | Node.js >= 20 和 Playwright Chromium。 |
| 模型 | 可选 | 仅现场 `auto` / `generate --goal` 需要。 |

## 边界

- 不要把密钥写进用例文件。用 `${PASSWORD}` 这类环境变量。
- 在退出、删除、支付或其他破坏性控件上做 explore 或 auto 之前先确认。
- 密码以及名称类似的字段不会发给模型。代理只使用你设置的 `HTTPS_PROXY`，CLI 不会探测本机代理端口。
