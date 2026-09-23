#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Agent, loadScript } from "./agent.js";
import { BrowserSession } from "./browser.js";
import { loadCases, readPlanTitle } from "./cases.js";
import { applyCliOverrides, loadConfig, loadEnv } from "./config.js";
import { explore } from "./explore.js";
import { compileCase, writeCase } from "./generate.js";
import { decisionModelLabel } from "./jev.js";
import { pageTable } from "./observe/snapshot.js";
import { emptyReport, failedCount, passRate, ReportWriter } from "./report.js";
import { CaseRunner } from "./runner.js";
import type { CaseResult, PilotConfig, SuiteReport } from "./types.js";
import { ensureCloakBrowser, cloakStatus } from "./cloak-install.js";
import { isoformat, runId, utcNow } from "./util.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  loadEnv();
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      headed: { type: "boolean", default: false },
      "no-screenshots": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      model: { type: "string" },
      "base-url": { type: "string" },
    },
    strict: false,
  });
  const command = positionals[0];
  if (values.help) {
    printHelp();
    return 0;
  }
  if (!command) {
    printHelp();
    return 2;
  }
  const config = applyCliOverrides(loadConfig(values.config as string | undefined), {
    model: typeof values.model === "string" ? values.model : undefined,
    baseUrl: typeof values["base-url"] === "string" ? values["base-url"] : undefined,
  });
  const screenshots = !values["no-screenshots"];
  const headed = Boolean(values.headed);
  const rest = positionals.slice(1);
  if (command === "install-browser") return cmdInstallBrowser(argv);
  if (command === "observe") return cmdObserve(rest[0], config, headed);
  if (command === "run") return cmdRun(fileArgs(argv, "run"), argv, config, screenshots, headed);
  if (command === "auto") return cmdAuto(argv, config, screenshots, headed);
  if (command === "generate") return cmdGenerate(argv, config, screenshots, headed);
  if (command === "explore") return cmdExplore(argv, config, screenshots, headed);
  console.error(`Unknown command: ${command}`);
  printHelp();
  return 2;
}

function printHelp(): void {
  console.log(`codexqa-jev-browser <command>

Commands:
  install-browser               Download Cloak when CLOAKBROWSER_DOWNLOAD_URL and CLOAKBROWSER_SHA256 are set
  observe <url>                 Print the indexed element table
  run [files...]                Replay YAML / Markdown / API cases
  auto --url --goal             Goal-driven automation
  generate --url --goal         Compile YAML (and optional MD) from a run
  explore --url                 Coverage-oriented crawl

Global flags:
  --headed                      Show the browser window (already the default)
  --no-screenshots              Skip step screenshots
  --config <file>               Config YAML
  --model <name>                Override OPENAI_MODEL (not the API key)
  --base-url <url>              Override OPENAI_BASE_URL
  browser.engine auto|cloak     Prefer a local Cloak browser when installed

Model (live auto / generate --goal only):
  CLI loads cwd/.env, then the repo-root .env, without overriding existing env.
  Decision prefers TYPESAFE_API_KEY + TYPESAFE_MODEL=jev-latest when set.
  Otherwise OPENAI_API_KEY, optional OPENAI_BASE_URL / OPENAI_MODEL / TEXT_MODEL.
  observe / run / explore / --decisions do not need a key.

Browser:
  Playwright Chromium is the default. install-browser downloads Cloak only from
  CLOAKBROWSER_DOWNLOAD_URL (https) after CLOAKBROWSER_SHA256 matches.
  There is no built-in mirror. Optional GeoIP uses CLOAKBROWSER_GEOIP_URL and
  CLOAKBROWSER_GEOIP_SHA256. Model traffic uses HTTPS_PROXY only when you set it.
`);
}

async function cmdInstallBrowser(argv: string[]): Promise<number> {
  const force = hasFlag(argv, "--force");
  const before = cloakStatus();
  const geoReady = !before.geoipUrl || existsSync(before.geoipPath);
  if (before.installed && geoReady && !force) {
    console.log(`Cloak 浏览器已就绪 ${before.executablePath}`);
    if (before.geoipUrl) console.log(`geoip ${before.geoipPath}`);
    return 0;
  }
  if (!before.archiveUrl) {
    console.error(
      "设置 CLOAKBROWSER_DOWNLOAD_URL（https）和 CLOAKBROWSER_SHA256 后再执行 install-browser。本技能不附带默认下载地址。",
    );
    return 1;
  }
  console.log(`下载 Cloak 浏览器 ${before.archiveUrl}`);
  if (before.geoipUrl) console.log(`下载 GeoIP ${before.geoipUrl}`);
  const info = await ensureCloakBrowser({ force });
  console.log(`Cloak 浏览器已就绪 ${info.executablePath}`);
  if (info.geoipUrl) console.log(`geoip ${info.geoipPath}`);
  return 0;
}

async function cmdObserve(url: string | undefined, config: PilotConfig, headed: boolean): Promise<number> {
  if (!url) {
    console.error("observe needs a url");
    return 2;
  }
  const session = new BrowserSession(config, { headed });
  try {
    const page = await session.start(url);
    if (!page) return 1;
    console.log(`URL  ${page.url}`);
    console.log(`TITLE  ${page.title}`);
    console.log(pageTable(page));
    return 0;
  } finally {
    await session.close();
  }
}

function fileArgs(argv: string[], command: string): string[] {
  const files: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === command) continue;
    if (item.startsWith("-")) {
      if (!item.includes("=") && argv[i + 1] && !argv[i + 1].startsWith("-")) i += 1;
      continue;
    }
    files.push(item);
  }
  return files;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const prefixed = argv.find((item) => item.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function cmdRun(
  paths: string[],
  argv: string[],
  config: PilotConfig,
  screenshots: boolean,
  headed: boolean,
): Promise<number> {
  const fromApi = flag(argv, "--from-api");
  const plan = paths.length === 1 ? readPlanTitle(paths[0]) : undefined;
  const name = flag(argv, "--name") ?? plan ?? "CodexQA Jev Browser suite";
  const cases = await loadCases(paths, { fromApi, config });
  const started = utcNow();
  const id = runId(started);
  const writer = new ReportWriter(config.reportsDir, id, screenshots);
  const report = emptyReport({
    runId: id,
    mode: "run",
    name,
    startedAt: isoformat(started),
    viewport: `${config.viewportWidth}x${config.viewportHeight}`,
    startUrl: cases[0]?.start.url,
    plan,
  });
  const session = openSession(config, writer, {
    headed,
    storageState: cases[0]?.start.storageState,
    headers: cases[0]?.start.headers,
  });
  try {
    await session.start(cases[0]?.start.url ?? "about:blank");
    report.browser = session.engine;
    const runner = new CaseRunner(session, writer);
    for (const item of cases) report.cases.push(await runner.runCase(item));
  } finally {
    await keepRecording(session, writer, report);
  }
  return finish(writer, report);
}

async function cmdAuto(argv: string[], config: PilotConfig, screenshots: boolean, headed: boolean): Promise<number> {
  const url = flag(argv, "--url");
  const goal = flag(argv, "--goal");
  if (!url || !goal) {
    console.error("auto needs --url and --goal");
    return 2;
  }
  const maxSteps = flag(argv, "--max-steps");
  if (maxSteps) config.maxSteps = Number(maxSteps);
  const started = utcNow();
  const id = runId(started);
  const writer = new ReportWriter(config.reportsDir, id, screenshots);
  const report = emptyReport({
    runId: id,
    mode: "auto",
    name: goal,
    startedAt: isoformat(started),
    startUrl: url,
    model: decisionModelLabel(config),
  });
  const session = openSession(config, writer, { headed });
  const decisions = flag(argv, "--decisions");
  const agent = new Agent(session, writer, config, { script: decisions ? loadScript(decisions) : undefined });
  try {
    if (!decisions) await agent.plan(url, goal);
    await session.start(url);
    report.browser = session.engine;
    const { result } = await agent.run(url, goal);
    report.cases.push(result);
  } finally {
    await keepRecording(session, writer, report);
  }
  return finish(writer, report);
}

async function cmdGenerate(argv: string[], config: PilotConfig, screenshots: boolean, headed: boolean): Promise<number> {
  const out = flag(argv, "--out") ?? "generated/case.yaml";
  const markdown = hasFlag(argv, "--md");
  const verify = hasFlag(argv, "--verify");
  const trace = flag(argv, "--trace");
  if (trace) {
    const data = JSON.parse(readFileSync(trace, "utf8")) as { cases?: CaseResult[]; startUrl?: string; start_url?: string };
    const result = data.cases?.[0] ?? (data as unknown as CaseResult);
    const startUrl = data.startUrl ?? data.start_url ?? flag(argv, "--url") ?? result.steps[0]?.url ?? "";
    const compiled = compileCase(result, startUrl, flag(argv, "--goal") ?? result.goal);
    const paths = writeCase(compiled, out, markdown);
    console.log("wrote", paths.join(", "));
    if (verify) return cmdRun([paths[0]], ["run", paths[0]], config, screenshots, false);
    return 0;
  }
  const url = flag(argv, "--url");
  const goal = flag(argv, "--goal");
  if (!url || !goal) {
    console.error("generate needs --url and --goal, or --trace");
    return 2;
  }
  const maxSteps = flag(argv, "--max-steps");
  if (maxSteps) config.maxSteps = Number(maxSteps);
  const started = utcNow();
  const id = runId(started);
  const writer = new ReportWriter(config.reportsDir, id, screenshots);
  const report = emptyReport({
    runId: id,
    mode: "generate",
    name: goal,
    startedAt: isoformat(started),
    startUrl: url,
    model: decisionModelLabel(config),
  });
  const session = openSession(config, writer, { headed });
  const decisions = flag(argv, "--decisions");
  const agent = new Agent(session, writer, config, { script: decisions ? loadScript(decisions) : undefined });
  let result: CaseResult;
  const persist = (current: CaseResult) => {
    const compiled = compileCase(current, url, goal);
    if (current.status !== "pass") compiled.tags.push("needs_review");
    const paths = writeCase(compiled, out, markdown);
    console.log(`updated ${paths[0]} steps=${compiled.steps.length}`);
  };
  try {
    if (!decisions) await agent.plan(url, goal);
    await session.start(url);
    report.browser = session.engine;
    ({ result } = await agent.run(url, goal, "auto", { onStep: persist }));
    report.cases.push(result);
  } finally {
    await keepRecording(session, writer, report);
  }
  finish(writer, report);
  persist(result);
  console.log("wrote", out);
  if (verify && result.status === "pass") return cmdRun([out], ["run", out], config, screenshots, false);
  return result.status === "pass" ? 0 : 1;
}

async function cmdExplore(argv: string[], config: PilotConfig, screenshots: boolean, headed: boolean): Promise<number> {
  const url = flag(argv, "--url");
  if (!url) {
    console.error("explore needs --url");
    return 2;
  }
  const out = flag(argv, "--out") ?? "generated/explore";
  const started = utcNow();
  const id = runId(started);
  const writer = new ReportWriter(config.reportsDir, id, screenshots);
  const report = emptyReport({
    runId: id,
    mode: "explore",
    name: `Explore ${url}`,
    startedAt: isoformat(started),
    startUrl: url,
  });
  mkdirSync(out, { recursive: true });
  const session = openSession(config, writer, { headed });
  try {
    await session.start(url);
    report.browser = session.engine;
    const { graph, result, compiled } = await explore(session, writer, url, {
      maxStates: Number(flag(argv, "--max-states") ?? 12),
      maxSteps: Number(flag(argv, "--max-steps") ?? 30),
      maxMinutes: Number(flag(argv, "--max-minutes") ?? 3),
      deny: collectRepeat(argv, "--deny"),
      allow: collectRepeat(argv, "--allow"),
    });
    report.cases.push(result);
    writeFileSync(
      path.join(out, "explore-graph.json"),
      JSON.stringify({ nodes: Object.values(graph.nodes), edges: graph.edges }, null, 2),
    );
    for (const item of compiled) {
      const dest = path.join(out, `${item.id}.yaml`);
      writeCase(item, dest, true);
      console.log("wrote", dest);
    }
  } finally {
    await keepRecording(session, writer, report);
  }
  return finish(writer, report);
}

function openSession(
  config: PilotConfig,
  writer: ReportWriter,
  options: { headed?: boolean; storageState?: string; headers?: Record<string, string> },
): BrowserSession {
  return new BrowserSession(config, {
    ...options,
    recordVideoDir: path.join(writer.root, "video"),
  });
}

async function keepRecording(session: BrowserSession, writer: ReportWriter, report: SuiteReport): Promise<void> {
  const files = await session.close();
  report.recordings = files.map((file, index) => writer.saveRecording(file, index, files.length));
  rmSync(path.join(writer.root, "video"), { recursive: true, force: true });
}

function collectRepeat(argv: string[], name: string): string[] {
  const values: string[] = [];
  argv.forEach((item, index) => {
    if (item === name && argv[index + 1]) values.push(argv[index + 1]);
  });
  return values;
}

function finish(writer: ReportWriter, report: SuiteReport): number {
  const paths = writer.write(report);
  console.log(`report ${path.resolve(paths.html)}`);
  console.log(
    `summary pass=${report.cases.filter((item) => item.status === "pass").length} fail=${failedCount(report)} total=${report.cases.length} rate=${passRate(report).toFixed(1)}%`,
  );
  return failedCount(report) === 0 && report.cases.length ? 0 : 1;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
