#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const COMPUTER_USE_TOOLS = [
  "list_apps",
  "list_windows",
  "screenshot",
  "click",
  "double_click",
  "move_mouse",
  "drag",
  "scroll",
  "keypress",
  "type_text",
  "set_text",
  "wait",
  "arrange_window",
  "navigate_browser",
  "computer_actions",
];

const DEFAULT_MATRIX = [
  { id: "gpt-5.5:off", model: "openai/gpt-5.5", thinking: "off" },
  { id: "gpt-5.4-mini:off", model: "openai/gpt-5.4-mini", thinking: "off" },
  { id: "gpt-5.4-mini:minimal", model: "openai/gpt-5.4-mini", thinking: "minimal" },
  { id: "gpt-5.4-mini:low", model: "openai/gpt-5.4-mini", thinking: "low" },
  { id: "gpt-5.4-mini:medium", model: "openai/gpt-5.4-mini", thinking: "medium" },
  { id: "gpt-5.4-mini:high", model: "openai/gpt-5.4-mini", thinking: "high" },
  { id: "gpt-5-mini:off", model: "openai/gpt-5-mini", thinking: "off" },
  { id: "gpt-5-mini:minimal", model: "openai/gpt-5-mini", thinking: "minimal" },
  { id: "gpt-5-mini:low", model: "openai/gpt-5-mini", thinking: "low" },
  { id: "gpt-5-mini:medium", model: "openai/gpt-5-mini", thinking: "medium" },
  { id: "gpt-5-mini:high", model: "openai/gpt-5-mini", thinking: "high" },
  { id: "gpt-5.3-codex:off", model: "openai/gpt-5.3-codex", thinking: "off" },
  { id: "gpt-5.3-codex:low", model: "openai/gpt-5.3-codex", thinking: "low" },
];

function usage() {
  console.log(`Usage: node scripts/run-model-evals.mjs --evals <evals.json> [options]

Runs regular pi usage against a model/thinking matrix and aggregates pass rate, latency,
tool behavior, token usage, and model-reported cost.

Options:
  --evals <path>          JSON eval file (required unless benchmarks/model-evals.json exists)
  --output <path>         Write full JSON report
  --summary <path>        Write compact markdown summary
  --matrix <path>         JSON model matrix override
  --repetitions <n>       Runs per eval/model (default 1)
  --timeout-ms <n>        Per run timeout (default 180000)
  --pi <path>             pi executable (default pi)
  --extension <path>      computer-use extension (default ./extensions/computer-use.ts)
  --dry-run               Print planned runs without invoking pi
  --skip-setup            Do not run eval setup actions

Eval file shape:
{
  "evals": [
    {
      "id": "frontmost-screenshot",
      "prompt": "Use screenshot on the current controlled window...",
      "requiredTools": ["screenshot"],
      "maxToolErrors": 0,
      "finalRegex": "EVAL_PASS"
    }
  ]
}
`);
}

function argValue(name) {
  const exact = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(exact));
  if (inline) return inline.slice(exact.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name) {
  return process.argv.includes(name);
}

if (hasArg("--help") || hasArg("-h")) {
  usage();
  process.exit(0);
}

const cwd = process.cwd();
const evalsPath = path.resolve(cwd, argValue("--evals") ?? "benchmarks/model-evals.json");
const matrixPath = argValue("--matrix") ? path.resolve(cwd, argValue("--matrix")) : undefined;
const outputPath = argValue("--output") ? path.resolve(cwd, argValue("--output")) : undefined;
const summaryPath = argValue("--summary") ? path.resolve(cwd, argValue("--summary")) : undefined;
const piBin = argValue("--pi") ?? "pi";
const extensionPath = path.resolve(cwd, argValue("--extension") ?? "extensions/computer-use.ts");
const repetitions = Number(argValue("--repetitions") ?? "1");
const timeoutMs = Number(argValue("--timeout-ms") ?? "180000");
const dryRun = hasArg("--dry-run");
const skipSetup = hasArg("--skip-setup");

if (!fs.existsSync(evalsPath)) {
  console.error(`Eval file not found: ${evalsPath}`);
  console.error("Pass --evals <path> or create benchmarks/model-evals.json.");
  process.exit(2);
}

if (!fs.existsSync(extensionPath)) {
  console.error(`Extension not found: ${extensionPath}`);
  process.exit(2);
}

const evalFile = JSON.parse(fs.readFileSync(evalsPath, "utf8"));
const evals = Array.isArray(evalFile) ? evalFile : evalFile.evals;
if (!Array.isArray(evals) || evals.length === 0) {
  console.error(`No evals found in ${evalsPath}. Expected an array or { "evals": [...] }.`);
  process.exit(2);
}

const matrix = matrixPath ? JSON.parse(fs.readFileSync(matrixPath, "utf8")) : DEFAULT_MATRIX;
if (!Array.isArray(matrix) || matrix.length === 0) {
  console.error("Model matrix must be a non-empty JSON array.");
  process.exit(2);
}


function runAppleScript(lines) {
  execFileSync("osascript", lines.flatMap((line) => ["-e", line]), { stdio: "ignore" });
}

function prepareEval(evalCase) {
  if (skipSetup || !evalCase.setup) return;
  const setup = evalCase.setup;
  if (setup.openApp) {
    runAppleScript([`tell application "${setup.openApp}" to activate`]);
  }
  if (setup.newTextEditDocument) {
    runAppleScript([
      'tell application "TextEdit" to activate',
      'tell application "TextEdit" to make new document',
      'delay 0.2',
    ]);
  }
  if (setup.openBrowser) {
    runAppleScript([`tell application "${setup.openBrowser}" to activate`]);
  }
  if (setup.delayMs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, setup.delayMs);
  }
}

function toolResultTextAndJson(events) {
  const chunks = [];
  for (const event of events) {
    if (event.type !== "tool_execution_end" && !(event.type === "message_end" && event.message?.role === "toolResult")) continue;
    const payload = event.type === "tool_execution_end" ? event.result : event.message;
    chunks.push(JSON.stringify(payload));
    const content = payload?.content;
    if (Array.isArray(content)) {
      for (const part of content) if (part?.type === "text") chunks.push(part.text ?? "");
    }
  }
  return chunks.join("\n");
}

function toolDetails(events) {
  const details = [];
  for (const event of events) {
    if (event.type === "tool_execution_end" && event.result?.details) details.push(event.result.details);
    if (event.type === "message_end" && event.message?.role === "toolResult" && event.message.details) details.push(event.message.details);
  }
  return details;
}

function isSubsequence(required, actual) {
  let index = 0;
  for (const value of actual) {
    if (value === required[index]) index++;
    if (index === required.length) return true;
  }
  return required.length === 0;
}

function evaluateAssertions(evalCase, events, toolCalls, finalText) {
  const failures = [];
  const combinedToolOutput = toolResultTextAndJson(events);
  const details = toolDetails(events);
  if (evalCase.requiredToolOrder && !isSubsequence(evalCase.requiredToolOrder, toolCalls)) {
    failures.push(`required tool order not observed: ${evalCase.requiredToolOrder.join(" -> ")}`);
  }
  for (const tool of evalCase.forbiddenTools ?? []) {
    if (toolCalls.includes(tool)) failures.push(`forbidden tool called: ${tool}`);
  }
  if (evalCase.maxToolCalls !== undefined && toolCalls.length > evalCase.maxToolCalls) {
    failures.push(`too many tool calls: ${toolCalls.length} > ${evalCase.maxToolCalls}`);
  }
  if (evalCase.minAxTargets !== undefined) {
    const maxTargets = Math.max(0, ...details.map((d) => Array.isArray(d.axTargets) ? d.axTargets.length : 0));
    if (maxTargets < evalCase.minAxTargets) failures.push(`max AX targets ${maxTargets} < ${evalCase.minAxTargets}`);
  }
  if (evalCase.expectTargetApp) {
    const found = details.some((d) => d.target?.app === evalCase.expectTargetApp || d.target?.appName === evalCase.expectTargetApp);
    if (!found) failures.push(`expected target app not observed: ${evalCase.expectTargetApp}`);
  }
  if (evalCase.expectToolResultRegex && !(new RegExp(evalCase.expectToolResultRegex, "is").test(combinedToolOutput))) {
    failures.push(`tool results did not match /${evalCase.expectToolResultRegex}/`);
  }
  if (evalCase.expectFinalRegex && !(new RegExp(evalCase.expectFinalRegex, "is").test(finalText))) {
    failures.push(`final text did not match /${evalCase.expectFinalRegex}/`);
  }
  return failures;
}

function buildPrompt(evalCase) {
  const finalInstruction = `\n\nWhen finished, respond with one final line starting with EVAL_RESULT: followed by compact JSON: {"status":"pass"|"fail","reason":"..."}. Do not claim pass unless the requested UI state was achieved.`;
  return `${evalCase.prompt}${finalInstruction}`;
}

function extractText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("");
}

function addUsage(total, usage) {
  if (!usage) return;
  total.input += usage.input || 0;
  total.output += usage.output || 0;
  total.cacheRead += usage.cacheRead || 0;
  total.cacheWrite += usage.cacheWrite || 0;
  total.totalTokens += usage.totalTokens || 0;
  total.cost += typeof usage.cost === "number" ? usage.cost : (usage.cost?.total || 0);
}

function runPi({ modelCase, evalCase, runIndex }) {
  prepareEval(evalCase);
  return new Promise((resolve) => {
    const args = [
      "--mode", "json",
      "--print",
      "--no-session",
      "--model", modelCase.model,
      "--thinking", modelCase.thinking ?? "off",
      "--no-extensions",
      "--no-builtin-tools",
      "--tools", COMPUTER_USE_TOOLS.join(","),
      "--extension", extensionPath,
      buildPrompt(evalCase),
    ];

    const started = performance.now();
    const child = spawn(piBin, args, {
      cwd,
      env: { ...process.env, PI_OFFLINE: process.env.PI_OFFLINE ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const latencyMs = Math.round(performance.now() - started);
      const events = [];
      const parseErrors = [];
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch (error) {
          parseErrors.push({ line, error: error.message });
        }
      }

      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
      const toolCalls = [];
      const toolErrors = [];
      let finalText = "";
      let turns = 0;

      for (const event of events) {
        if (event.type === "turn_end") turns++;
        if (event.type === "tool_execution_end") {
          toolCalls.push(event.toolName);
          if (event.isError) toolErrors.push({ toolName: event.toolName, result: event.result });
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          addUsage(usage, event.message.usage);
          finalText = extractText(event.message) || finalText;
        }
      }

      const requiredTools = evalCase.requiredTools ?? [];
      const missingTools = requiredTools.filter((tool) => !toolCalls.includes(tool));
      const maxToolErrors = evalCase.maxToolErrors ?? 0;
      const finalRegexOk = evalCase.finalRegex ? new RegExp(evalCase.finalRegex, "s").test(finalText) : true;
      const modelSelfPass = /EVAL_RESULT:\s*\{[^\n]*"status"\s*:\s*"pass"/i.test(finalText);
      const assertionFailures = evaluateAssertions(evalCase, events, toolCalls, finalText);
      const pass = !timedOut && code === 0 && missingTools.length === 0 && toolErrors.length <= maxToolErrors && finalRegexOk && assertionFailures.length === 0 && (evalCase.requireSelfPass === false || modelSelfPass);

      resolve({
        id: `${modelCase.id ?? `${modelCase.model}:${modelCase.thinking ?? "off"}`}::${evalCase.id}::${runIndex + 1}`,
        modelId: modelCase.id ?? `${modelCase.model}:${modelCase.thinking ?? "off"}`,
        model: modelCase.model,
        thinking: modelCase.thinking ?? "off",
        evalId: evalCase.id,
        runIndex,
        status: pass ? "PASS" : "FAIL",
        exitCode: code,
        signal,
        timedOut,
        latencyMs,
        turns,
        usage,
        toolCalls,
        toolErrors,
        missingTools,
        finalRegexOk,
        modelSelfPass,
        assertionFailures,
        finalText,
        parseErrors,
        stderr: stderr.trim(),
      });
    });
  });
}

function aggregate(results) {
  const byModel = new Map();
  for (const result of results) {
    const current = byModel.get(result.modelId) ?? {
      modelId: result.modelId,
      model: result.model,
      thinking: result.thinking,
      runs: 0,
      passes: 0,
      failures: 0,
      avgLatencyMs: 0,
      totalLatencyMs: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
      toolErrors: 0,
    };
    current.runs++;
    if (result.status === "PASS") current.passes++;
    else current.failures++;
    current.totalLatencyMs += result.latencyMs;
    current.avgLatencyMs = Math.round(current.totalLatencyMs / current.runs);
    current.toolErrors += result.toolErrors.length;
    addUsage(current.usage, result.usage);
    byModel.set(result.modelId, current);
  }
  return [...byModel.values()].map((entry) => ({
    ...entry,
    passRate: entry.runs ? entry.passes / entry.runs : 0,
    avgCostPerRun: entry.runs ? entry.usage.cost / entry.runs : 0,
  })).sort((a, b) => (b.passRate - a.passRate) || (a.avgLatencyMs - b.avgLatencyMs) || (a.usage.cost - b.usage.cost));
}

function markdownSummary(report) {
  const lines = [
    "# pi-computer-use model eval matrix",
    "",
    `Date: ${report.date}`,
    `Eval file: \`${report.evalsPath}\``,
    `Runs: ${report.results.length}`,
    "",
    "| model | pass | avg latency | total cost | avg cost | tokens in/out | tool errors |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of report.summary) {
    lines.push(`| ${row.modelId} | ${(row.passRate * 100).toFixed(1)}% (${row.passes}/${row.runs}) | ${row.avgLatencyMs}ms | $${row.usage.cost.toFixed(6)} | $${row.avgCostPerRun.toFixed(6)} | ${row.usage.input}/${row.usage.output} | ${row.toolErrors} |`);
  }
  lines.push("");
  lines.push(`Overall cost: $${report.overall.usage.cost.toFixed(6)}`);
  return lines.join("\n");
}

const plannedRuns = matrix.length * evals.length * repetitions;
console.log(`Planning ${plannedRuns} runs (${matrix.length} model configs x ${evals.length} evals x ${repetitions} reps).`);
if (dryRun) {
  console.log(JSON.stringify({ matrix, evals: evals.map((e) => e.id), plannedRuns }, null, 2));
  process.exit(0);
}

const results = [];
for (const modelCase of matrix) {
  for (const evalCase of evals) {
    for (let runIndex = 0; runIndex < repetitions; runIndex++) {
      const label = `${modelCase.id ?? modelCase.model}:${evalCase.id}#${runIndex + 1}`;
      process.stdout.write(`Running ${label} ... `);
      const result = await runPi({ modelCase, evalCase, runIndex });
      results.push(result);
      console.log(`${result.status} ${result.latencyMs}ms $${result.usage.cost.toFixed(6)}`);
    }
  }
}

const summary = aggregate(results);
const overall = {
  runs: results.length,
  passes: results.filter((r) => r.status === "PASS").length,
  failures: results.filter((r) => r.status !== "PASS").length,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
};
for (const result of results) addUsage(overall.usage, result.usage);
overall.passRate = overall.runs ? overall.passes / overall.runs : 0;

const report = {
  date: new Date().toISOString(),
  cwd,
  evalsPath,
  extensionPath,
  matrix,
  repetitions,
  timeoutMs,
  overall,
  summary,
  results,
};

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
}

const md = markdownSummary(report);
if (summaryPath) {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, md + "\n");
}

console.log("\n" + md);
