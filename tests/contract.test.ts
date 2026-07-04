import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "vibeLM-contract-test");
const CONFIG_PATH = join(TEST_DIR, ".vibeLM-config.json");

describe("Contract: tool exports and signatures", () => {
  let execToolByName: any;
  let webSearch: any;
  let binaryExtCheck: any;
  let callLLM: any;

  before(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ workspacePath: TEST_DIR }));
    process.env.AGENTIC_SEARCH_ENDPOINT = "http://localhost:8394/search";
    
    const mod = await import("../src/toolsProvider");
    const exp = (mod as any).default || mod;
    execToolByName = exp.execToolByName;
    webSearch = exp.webSearch;
    binaryExtCheck = exp.binaryExtCheck;
    callLLM = exp.callLLM;
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    try { rmSync(dirname(CONFIG_PATH), { recursive: true, force: true }); } catch {}
  });

  it("contract: execToolByName is exported and callable", () => {
    assert.equal(typeof execToolByName, "function", "execToolByName is a function");
  });

  it("contract: webSearch is exported and callable", () => {
    assert.equal(typeof webSearch, "function", "webSearch is a function");
  });

  it("contract: binaryExtCheck is exported and callable", () => {
    assert.equal(typeof binaryExtCheck, "function", "binaryExtCheck is a function");
  });

  it("contract: callLLM is exported and callable", () => {
    assert.equal(typeof callLLM, "function", "callLLM is a function");
  });

  it("contract: execToolByName returns results for all tool names", async () => {
    const toolNames = [
      "read_file", "write_file", "list_files", "search_files",
      "bash_terminal", "calculate", "get_current_datetime",
      "generate_uuid", "generate_password",
      "encode_base64", "decode_base64"
    ];
    for (const name of toolNames) {
      const args = name === "bash_terminal" ? { command: "echo ok" } : {};
      const result = await execToolByName(name, args);
      assert.ok(result !== undefined, `execToolByName("${name}") returns a value`);
    }
  });

  it("contract: binaryExtCheck correctly identifies extensions", () => {
    assert.equal(binaryExtCheck("image.png"), true, ".png is binary");
    assert.equal(binaryExtCheck("file.jpg"), true, ".jpg is binary");
    assert.equal(binaryExtCheck("file.exe"), true, ".exe is binary");
    assert.equal(binaryExtCheck("file.txt"), false, ".txt is not binary");
    assert.equal(binaryExtCheck("file.ts"), false, ".ts is not binary");
    assert.equal(binaryExtCheck("file.js"), false, ".js is not binary");
  });

  it("contract: calculate returns numeric result", async () => {
    const result = await execToolByName("calculate", { expression: "2 + 2" });
    const text = typeof result === "string" ? result : JSON.stringify(result);
    assert.ok(text.includes("4"), "calculate computes correctly");
  });

  it("contract: generate_uuid returns value", async () => {
    const result = await execToolByName("generate_uuid", {});
    assert.ok(result !== undefined, "generate_uuid returns a value");
  });

  it("contract: generate_password returns value", async () => {
    const result = await execToolByName("generate_password", { length: 16 });
    assert.ok(result !== undefined, "generate_password returns a value");
  });

  it("contract: encode_base64 returns value", async () => {
    const encoded = await execToolByName("encode_base64", { text: "contract test" });
    assert.ok(encoded !== undefined, "encode_base64 returns a value");
  });

  it("contract: get_current_datetime returns ISO format", async () => {
    const result = await execToolByName("get_current_datetime", {});
    const text = typeof result === "string" ? result : JSON.stringify(result);
    assert.ok(text.includes("T"), "returns ISO format");
  });
});
