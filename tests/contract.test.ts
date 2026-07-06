import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "vibeLM-contract-test");
const CONFIG_PATH = join(TEST_DIR, ".vibeLM-config.json");

describe("Contract: tool exports and signatures", () => {
  let webSearch: any;
  let binaryExtCheck: any;

  before(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ workspacePath: TEST_DIR }));
    process.env.AGENTIC_SEARCH_ENDPOINT = "http://localhost:8394/search";
    
    const mod = await import("../src/toolsProvider");
    const exp = (mod as any).default || mod;
    webSearch = exp.webSearch;
    binaryExtCheck = exp.binaryExtCheck;
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    try { rmSync(dirname(CONFIG_PATH), { recursive: true, force: true }); } catch {}
  });

  it("contract: webSearch is exported and callable", () => {
    assert.equal(typeof webSearch, "function", "webSearch is a function");
  });

  it("contract: binaryExtCheck is exported and callable", () => {
    assert.equal(typeof binaryExtCheck, "function", "binaryExtCheck is a function");
  });

  it("contract: binaryExtCheck correctly identifies extensions", () => {
    assert.equal(binaryExtCheck("image.png"), true, ".png is binary");
    assert.equal(binaryExtCheck("file.jpg"), true, ".jpg is binary");
    assert.equal(binaryExtCheck("file.exe"), true, ".exe is binary");
    assert.equal(binaryExtCheck("file.txt"), false, ".txt is not binary");
    assert.equal(binaryExtCheck("file.ts"), false, ".ts is not binary");
    assert.equal(binaryExtCheck("file.js"), false, ".js is not binary");
  });
});
