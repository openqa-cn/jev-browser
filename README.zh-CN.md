# CodexQA Jev Browser

[English](README.md) · [工作原理](HOW_IT_WORKS.zh-CN.md) · [已知限制](KNOWN_LIMITATIONS.zh-CN.md)

**Jev Browser** 的独立仓库是 [openqa-cn/jev-browser](https://github.com/openqa-cn/jev-browser)。同一技能也在 [CodexQA](https://github.com/openqa-cn/codexqa) 目录里。

用 GUI 模型做浏览器自动化时，每一步都要把截图送给视觉模型找控件。识别要付视觉 token，回路要等模型看图，点选落在坐标上。

CodexQA Jev Browser 把找控件从视觉模型换成页面内编好的索引，把通过与否交给页面上看得见的证据。回放、按目标执行、用例生成和站点探索共用这一套索引。浏览器是 Playwright Chromium。本仓库没有和视觉 GUI 模型的对照基准，下面是结构上避开这些成本的做法。

按 TypeSafe 公布的 System One 对比，同一种决策上 Jev 比前沿大模型快 **40–200 倍**（70–500 毫秒，对方是数秒到数百秒）。他们的工作流演示是快 **193.6 倍**、便宜 **444.6 倍**：0.114 秒、0.000081 美元，对比 8.566 秒、0.013880 美元。TypeSafe 把这一组称为实际收益里偏高的一端。Jev 的输入价是 **每百万 token 0.042 美元**，比 Claude Fable 5.1 低 **238 倍**，输出 token 不计费。这些数字只覆盖决策调用，不包括打开页面和写报告。来源：[TypeSafe](https://typesafe.ai/) 与[发布说明](https://typesafe.ai/blog/introducing-system-one-models-and-jev)。

## 传统自动化的痛点

| 痛点 | 这里的做法 |
| --- | --- |
| GUI 模型按截图找控件，每步都消耗视觉 token | 决策只接收页面里已经编好的索引：角色、名称、当前值和允许的操作。模型做的是选择题。截图留在报告里，用来标出点过的控件。 |
| 每步都要等视觉模型看完图，回路慢 | 观测在页面里完成。`run`、`explore` 和 `--decisions` 不调用决策模型。`generate` 写出 YAML 之后，`--verify` 用同一套索引回放。 |
| 坐标和视觉定位容易点偏，布局一变就失效 | 动作打在 `data-codexqa-jev-browser-id` 上。用例用 `role` / `name` / `nth` / `within` 对当前索引解析，iframe 里的控件走同一条定位。执行前索引必须仍在动作空间里，执行后再核对页面是否变化。 |
| 跑哪一个浏览器要由配置决定 | 运行时使用 Playwright Chromium。 |

## 亮点

- **动作空间是封闭的。** 观测给每个可见控件一个索引、角色、名称，以及它实际支持的操作。运行时只接受这个集合里的操作和索引。模型回复里像选择器、JavaScript 或 shell 的内容会在执行前被拒绝。
- **Jev 做的是结构化选择题。** 配置了 `TYPESAFE_API_KEY` 时，每一步都是一次 `/systemone` 提问：选哪个操作、选哪个已观测目标。同一次通道还判断这一步有没有在下一页上显现。没有 Jev 时，决策退到兼容 OpenAI 的 `chat/completions`。`--decisions` 两者都不调用。
- **浏览器是 Playwright Chromium。** 密码框的值不会发给模型。
- **生成的用例可以不再叫决策模型。** YAML、Markdown 和 API 用例用 `{role, name, nth, within}` 描述目标，再对着当前索引解析，iframe 里的控件也走同一条定位。`generate` 在每一步成功后把这份 YAML 写盘。`--verify` 再用 `run` 回放该文件。
- **结果由页面上看得见的证据决定。** 规划器把完成条件写成页面上必须出现的 `done_when`。模型返回 `DONE` 时，只有该证据可见才算通过。断言失败后 teardown 仍会执行。HTML 报告保留带标记的截图、步骤耗时、token 用量和当次录像。

## 架构

`observe`、`run`、`explore` 和 `--decisions` 停在索引和执行器。现场的 `auto` 和 `generate --goal` 才加上规划器和决策来源。`generate` 把通过的轨迹编译回执行器可以单独回放的用例。

要输入的文字由同一次 Jev 决策从目标里已经写出的短语中选定。点哪一个控件仍由索引上的节点 id 决定。`knowledge/<app>/` 里命中的笔记仍附在这次决策上。

## 安装

```bash
npm install
cp .env.example .env   # 现场 auto / generate --goal 才需要
```

模型请求只走你自己设置的 `HTTPS_PROXY`。

需要 Node.js 20 或更高版本。

## 模型

CLI 自己调用 Jev 或兼容 OpenAI 的接口。宿主里的 Cursor / Codex 会话不是决策模型。

| 调用 | 时机 | 密钥 |
| --- | --- | --- |
| Jev `/systemone` | 每步的操作与目标、这一步是否生效，以及任务是否已经结束 | `TYPESAFE_API_KEY`。可选：`TYPESAFE_MODEL`（`jev-latest`）、`TYPESAFE_BASE_URL` |
| Chat completions | 任务规划。未配置 Jev 时也负责整步决策和结束确认 | `OPENAI_API_KEY`。可选：`OPENAI_BASE_URL`、`OPENAI_MODEL`、`TEXT_MODEL` |
| 不调用 | `observe`、`run`、`explore`、`auto --decisions`、`generate --decisions` | — |

决策来源的优先级：`--decisions` 脚本，然后是已设置 `TYPESAFE_API_KEY` 时的 Jev，最后是 chat completions。`--model` 和 `--base-url` 覆盖对话模型与网关。`codexqa-jev-browser.config.yaml` 可以用 `${OPENAI_API_KEY}` 这种占位符。CLI 先加载当前目录的 `.env`，再在需要时加载仓库根目录的 `.env`，且不覆盖 shell 里已经存在的变量。不要传 `--api-key`，也不要把原始密钥写进用例文件。

即使每一步点击由 Jev 选择，现场 `auto` / `generate --goal` 的规划器仍然需要 `OPENAI_API_KEY`。

## 命令

```bash
npx codexqa-jev-browser observe examples/app/index.html
npx codexqa-jev-browser run cases/examples/search-docs.yaml cases/examples/login.yaml
npx codexqa-jev-browser run cases/examples/search-docs.md
npx codexqa-jev-browser run --from-api https://qa.example.com/cases
npx codexqa-jev-browser auto --url examples/app/index.html --goal '搜索 Pilot 并打开文档' \
  --decisions cases/scripts/decisions-search.yaml
npx codexqa-jev-browser generate --url examples/app/index.html --goal '搜索 Pilot 并打开文档' \
  --decisions cases/scripts/decisions-search.yaml --out generated/search.yaml --md --verify
npx codexqa-jev-browser explore --url examples/app/index.html --out generated/explore
```

默认显示浏览器窗口。`browser.headless: true` 会隐藏窗口。`--headed` 强制显示。`--no-screenshots` 跳过截图。

报告写在 `reports/<run-id>/report.html`。`report.json` 是机器可读副本，`report.md` 是短摘要。用例失败时进程以非零状态退出。

## 目录

```text
SKILL.md            给 Agent 的入口：什么时候用这个技能、跑哪条命令
bin/                命令行启动器
src/                运行时。observe/ 给页面控件编号，report/ 写 HTML 报告
knowledge/          决策时参考的笔记。general/ 每次都带上，其他目录按站点分开
cases/              可回放的示例；cases/scripts 是写死的决策，用来不调模型地走通流程
examples/app/       本地小页面，给上面的命令和测试用
references/         步骤格式和示例
tests/              离线检查，不访问真实网站，也不调用线上模型
agents/openai.yaml  在 Agents 界面上显示的名称和短说明
reports/            每次运行一个目录。已被 git 忽略
```

## 可移植 skill

本目录就是 skill。`SKILL.md` 和 CLI 放在一起。

```bash
npx skills add openqa-cn/jev-browser
# 或从 CodexQA 目录安装：
npx skills add openqa-cn/codexqa --skill codexqa-jev-browser
```

任何能跑 shell 的 Agent 都使用同一套 CLI。这个 skill 不调用厂商专用的浏览器工具。

步骤和动词见 [references/schema.md](references/schema.md)。示例见 [references/examples.md](references/examples.md)。

## 测试

```bash
npm test
```

测试是离线的。通过只说明引擎与夹具一致，不能说明真实站点或现场模型会成功。
