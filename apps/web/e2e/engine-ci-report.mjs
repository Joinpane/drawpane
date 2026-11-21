import { appendFileSync, readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

// Run the whole shard, then keep only known spec failures non-blocking.
const [reportPath, outcome] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const allowed = JSON.parse(readFileSync(new URL("./engine-ci-allowed.json", import.meta.url)));
const failures = new Map();
function visit(suite) {
  for (const spec of suite.specs) {
    for (const test of spec.tests) {
      if (test.status !== "unexpected") continue;
      const errors = test.results.at(-1)?.errors ?? [];
      const found = failures.get(spec.file) ?? [];
      found.push({ title: spec.title, errors: errors.map((error) => error.message) });
      failures.set(spec.file, found);
    }
  }
  for (const child of suite.suites ?? []) visit(child);
}
for (const suite of report.suites) visit(suite);

const lines = ["## Engine-on failures", ""];
let unexpected = report.errors.length > 0 || (outcome === "failure" && failures.size === 0);
for (const [file, tests] of failures) {
  const reason = Object.hasOwn(allowed, file) ? allowed[file] : null;
  unexpected ||= !reason;
  lines.push(`- ${file} (${reason ?? "unexpected"})`);
  for (const { title, errors } of tests) {
    const firstLine = stripVTControlCharacters(errors[0] ?? "")
      .split("\n")
      .find(Boolean);
    lines.push(`  - ${title}${firstLine ? ` (${firstLine})` : ""}`);
  }
}
if (failures.size === 0) lines.push("No unexpected test results.");
if (report.errors.length) lines.push("", "Playwright also reported an infrastructure error.");
const summary = `${lines.join("\n")}\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (unexpected) process.exitCode = 1;
