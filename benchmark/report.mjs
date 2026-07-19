import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPTS } from "./prompts.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RESULTS_DIR = resolve(HERE, "results");

const PROMPT_ORDER = [...PROMPTS.map((p) => p.id), "agentic-file-roundtrip"];

function latestRunFile() {
  const files = readdirSync(RESULTS_DIR).filter((f) => /^run-.*\.jsonl$/.test(f)).sort();
  if (files.length === 0) throw new Error(`No run-*.jsonl files found in ${RESULTS_DIR}`);
  return resolve(RESULTS_DIR, files[files.length - 1]);
}

function loadResults(jsonlPath) {
  const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

function fmt(n, digits = 1) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "-";
}

export function buildTable(results) {
  const byModel = new Map();
  for (const r of results) {
    if (!byModel.has(r.label)) byModel.set(r.label, {});
    byModel.get(r.label)[r.promptId] = r;
  }

  // Deterministic ordering: alphabetical by label, fixed prompt column order.
  const labels = [...byModel.keys()].sort((a, b) => a.localeCompare(b));

  const header = ["Model", ...PROMPT_ORDER.map((id) => id), "Pass rate", "Avg tok/s", "Agentic rounds"];
  const rows = [header, header.map(() => "---")];

  for (const label of labels) {
    const perPrompt = byModel.get(label);
    const row = [label];
    let passed = 0;
    let total = 0;
    let tokSpeeds = [];
    for (const id of PROMPT_ORDER) {
      const r = perPrompt[id];
      if (!r || r.promptId === "__load__") {
        row.push("n/a");
        continue;
      }
      total += 1;
      if (r.passed) passed += 1;
      if (typeof r.tokensPerSecond === "number") tokSpeeds.push(r.tokensPerSecond);
      const mark = r.passed ? "PASS" : "FAIL";
      const latency = fmt(r.wallMs, 0);
      row.push(`${mark} (${latency}ms)`);
    }
    const passRate = total > 0 ? `${passed}/${total}` : "n/a";
    const avgTok = tokSpeeds.length > 0 ? fmt(tokSpeeds.reduce((a, b) => a + b, 0) / tokSpeeds.length, 1) : "-";
    const agentic = perPrompt["agentic-file-roundtrip"];
    const rounds = agentic && typeof agentic.rounds === "number" ? String(agentic.rounds) : "-";
    row.push(passRate, avgTok, rounds);
    rows.push(row);
  }

  return rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
}

function main() {
  const arg = process.argv[2];
  const jsonlPath = arg ? resolve(arg) : latestRunFile();
  const results = loadResults(jsonlPath);
  const table = buildTable(results);
  const out = `# Benchmark results\n\nSource: \`${jsonlPath}\`\n\n${table}\n`;
  writeFileSync(resolve(RESULTS_DIR, "latest-table.md"), out);
  console.log(out);
}

main();
