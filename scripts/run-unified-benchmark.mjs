#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
  console.log(`Usage: node scripts/run-unified-benchmark.mjs [options]

Runs the existing direct tool/helper QA benchmark and the model-driven eval matrix,
then writes one combined report.

Options:
  --output-dir <dir>       Directory for artifacts (default benchmarks/results/unified-<timestamp>)
  --model-matrix <path>    Optional model matrix JSON for scripts/run-model-evals.mjs
  --evals <path>           Model eval JSON (default benchmarks/model-evals.json)
  --repetitions <n>        Model eval repetitions (default 1)
  --timeout-ms <n>         Per model eval timeout (default 180000)
  --skip-qa               Skip direct tool/helper QA
  --skip-model-evals      Skip model-driven evals
  --allow-screen-takeover Pass --allow-screen-takeover to direct QA
`);
  process.exit(0);
}

const cwd = process.cwd();
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.resolve(cwd, argValue("--output-dir") ?? `benchmarks/results/unified-${timestamp}`);
const evalsPath = path.resolve(cwd, argValue("--evals") ?? "benchmarks/model-evals.json");
const matrixPath = argValue("--model-matrix") ? path.resolve(cwd, argValue("--model-matrix")) : undefined;
const repetitions = argValue("--repetitions") ?? "1";
const timeoutMs = argValue("--timeout-ms") ?? "180000";
fs.mkdirSync(outputDir, { recursive: true });

function run(name, command, args) {
  console.log(`\n==> ${name}`);
  console.log([command, ...args].join(" "));
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const artifacts = { date: new Date().toISOString(), outputDir, qa: null, modelEvals: null };
let failed = false;

if (!hasArg("--skip-qa")) {
  const qaOutput = path.join(outputDir, "qa.json");
  const qaArgs = ["-y", "tsx", "benchmarks/qa.ts", "--allow-foreground-qa", "--output", qaOutput];
  if (hasArg("--allow-screen-takeover")) qaArgs.push("--allow-screen-takeover");
  const status = run("direct tool/helper QA", "npx", qaArgs);
  artifacts.qa = { path: qaOutput, status };
  failed ||= status !== 0;
}

if (!hasArg("--skip-model-evals")) {
  const modelOutput = path.join(outputDir, "model-evals.json");
  const modelSummary = path.join(outputDir, "model-evals.md");
  const args = [
    "scripts/run-model-evals.mjs",
    "--evals", evalsPath,
    "--output", modelOutput,
    "--summary", modelSummary,
    "--repetitions", repetitions,
    "--timeout-ms", timeoutMs,
  ];
  if (matrixPath) args.push("--matrix", matrixPath);
  const status = run("model-driven computer-use evals", "node", args);
  artifacts.modelEvals = { path: modelOutput, summaryPath: modelSummary, status };
  failed ||= status !== 0;
}

function readJsonIfExists(file) {
  return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
}

const qa = readJsonIfExists(artifacts.qa?.path);
const model = readJsonIfExists(artifacts.modelEvals?.path);
const report = {
  ...artifacts,
  qaMetrics: qa?.metrics,
  qaGoals: qa?.goals,
  modelOverall: model?.overall,
  modelSummary: model?.summary,
  status: failed ? "FAIL" : "PASS",
};

const combinedPath = path.join(outputDir, "combined.json");
const combinedMdPath = path.join(outputDir, "combined.md");
fs.writeFileSync(combinedPath, JSON.stringify(report, null, 2));

const md = [
  "# Unified pi-computer-use benchmark",
  "",
  `Date: ${report.date}`,
  `Status: **${report.status}**`,
  "",
  "## Direct tool/helper QA",
  qa ? `- core AX-only ratio: ${qa.metrics?.coreAxOnlyRatio}` : "- skipped or unavailable",
  qa ? `- avg latency: ${qa.metrics?.avgLatencyMs}ms` : "",
  qa ? `- goals: ${qa.goals?.status ?? "n/a"}` : "",
  "",
  "## Model-driven evals",
  model ? `- pass rate: ${(model.overall.passRate * 100).toFixed(1)}% (${model.overall.passes}/${model.overall.runs})` : "- skipped or unavailable",
  model ? `- overall cost: $${model.overall.usage.cost.toFixed(6)}` : "",
  "",
  model ? "| model | pass | avg latency | total cost | avg cost |" : "",
  model ? "|---|---:|---:|---:|---:|" : "",
  ...(model?.summary ?? []).map((row) => `| ${row.modelId} | ${(row.passRate * 100).toFixed(1)}% (${row.passes}/${row.runs}) | ${row.avgLatencyMs}ms | $${row.usage.cost.toFixed(6)} | $${row.avgCostPerRun.toFixed(6)} |`),
  "",
  `Artifacts: ${outputDir}`,
].filter((line) => line !== "").join("\n");
fs.writeFileSync(combinedMdPath, md + "\n");
console.log(`\nWrote ${combinedPath}`);
console.log(`Wrote ${combinedMdPath}`);
process.exit(failed ? 1 : 0);
