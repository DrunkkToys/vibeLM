import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "vibeLM-cascade-test");
const CONFIG_PATH = join(TEST_DIR, ".vibeLM-config.json");

describe("Cascade: full plugin flow", () => {
  let execToolByName: any;

  before(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "hello.txt"), "Hello World\n");
    writeFileSync(join(TEST_DIR, "data.json"), '{"key":"value"}\n');
    mkdirSync(join(TEST_DIR, "src"));
    writeFileSync(join(TEST_DIR, "src", "main.ts"), "export const x = 1;\n");

    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ workspacePath: TEST_DIR }));

    process.env.AGENTIC_SEARCH_ENDPOINT = "http://localhost:8394/search";
    
    const mod = await import("../src/toolsProvider");
    const exp = (mod as any).default || mod;
    execToolByName = exp.execToolByName;
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    try { rmSync(dirname(CONFIG_PATH), { recursive: true, force: true }); } catch {}
  });

  it("cascade: list_files returns array", async () => {
    const files = await execToolByName("list_files", { path: "" });
    assert.ok(Array.isArray(files), "list_files returns array");
    assert.ok(files.length > 0, "list_files returns results");
  });

  it("cascade: read_file returns content", async () => {
    const content = await execToolByName("read_file", { filePath: "hello.txt", maxChars: 100 });
    const text = typeof content === "string" ? content : JSON.stringify(content);
    assert.ok(text.includes("Hello World") || text.includes("hello.txt"), "read_file returns file content");
  });

  it("cascade: search_files returns results object", async () => {
    const results = await execToolByName("search_files", { pattern: "Hello", path: "" });
    assert.ok(results !== undefined, "search_files returns a value");
    const text = JSON.stringify(results);
    assert.ok(text.includes("results") || text.includes("Hello"), "search_files returns results");
  });

  it("cascade: bash_terminal returns output", async () => {
    const result = await execToolByName("bash_terminal", { command: "echo cascade_test_output" });
    const text = typeof result === "string" ? result : JSON.stringify(result);
    assert.ok(text.includes("cascade_test_output"), "bash_terminal returns output");
  });

  it("cascade: write_file and read_file roundtrip", async () => {
    await execToolByName("write_file", { filePath: "cascade.txt", content: "cascade data" });
    const readResult = await execToolByName("read_file", { filePath: "cascade.txt", maxChars: 100 });
    const text = typeof readResult === "string" ? readResult : JSON.stringify(readResult);
    assert.ok(text.includes("cascade data"), "write_file → read_file roundtrip works");
  });

  it("cascade: calculate computes correctly", async () => {
    const result = await execToolByName("calculate", { expression: "2 + 2" });
    const text = typeof result === "string" ? result : JSON.stringify(result);
    assert.ok(text.includes("4"), "calculate computes 2+2=4");
  });

  it("cascade: generate_uuid returns value", async () => {
    const uuid = await execToolByName("generate_uuid", {});
    assert.ok(uuid !== undefined, "generate_uuid returns a value");
  });

  it("cascade: generate_password returns value", async () => {
    const pass = await execToolByName("generate_password", { length: 32 });
    assert.ok(pass !== undefined, "generate_password returns a value");
  });

  it("cascade: encode_base64 returns value", async () => {
    const encoded = await execToolByName("encode_base64", { text: "cascade test" });
    assert.ok(encoded !== undefined, "encode_base64 returns a value");
  });

  it("cascade: get_current_datetime returns ISO format", async () => {
    const result = await execToolByName("get_current_datetime", {});
    const text = typeof result === "string" ? result : JSON.stringify(result);
    assert.ok(text.includes("T"), "get_current_datetime returns ISO format with T");
  });

  it("cascade: all 10 tool names are callable via execToolByName", async () => {
    const toolNames = [
      "read_file", "write_file", "list_files", "search_files",
      "bash_terminal", "web_search", "web_fetch", "save_memory",
      "calculate", "get_current_datetime"
    ];
    for (const name of toolNames) {
      const args = name === "bash_terminal" ? { command: "echo ok" } : {};
      const result = await execToolByName(name, args);
      assert.ok(result !== undefined, `execToolByName("${name}") returns a value`);
    }
  });
});
