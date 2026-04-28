#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const pattern = /^(feat|chore|refactor|fix)\([^)\s:]+\):\s?\S.+$/;
const ignoredPrefixes = ["Merge ", "Revert "];

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function defaultRange() {
	const eventName = process.env.GITHUB_EVENT_NAME;
	const baseSha = process.env.GITHUB_BASE_SHA;
	const headSha = process.env.GITHUB_SHA || "HEAD";
	if (eventName === "pull_request" && baseSha) return `${baseSha}..${headSha}`;
	return "HEAD~1..HEAD";
}

const range = process.argv[2] ?? process.env.COMMIT_RANGE ?? defaultRange();
let subjects;
try {
	subjects = git(["log", "--format=%s", range]).split("\n").filter(Boolean);
} catch (error) {
	console.error(`Unable to read commits for range '${range}'.`);
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const invalid = subjects.filter((subject) => !ignoredPrefixes.some((prefix) => subject.startsWith(prefix)) && !pattern.test(subject));

if (invalid.length > 0) {
	console.error("Invalid commit message(s):");
	for (const subject of invalid) console.error(`- ${subject}`);
	console.error("\nExpected format: feat|chore|refactor|fix(<scope>): <summary>");
	console.error("Example: fix(browser): stabilize window targeting");
	process.exit(1);
}

console.log(`Checked ${subjects.length} commit message(s) in ${range}.`);
