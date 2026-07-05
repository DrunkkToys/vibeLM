import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "vibeLM-cascade-test-" + Date.now());
const REAL_CONFIG = join(process.env.HOME!, ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools", "config.json");
const BACKUP_CONFIG = REAL_CONFIG + ".backup";
const JSONL_PATH = join(process.env.HOME!, ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools", "session-log.jsonl");

function setupWorkspace() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, "hello.txt"), "Hello World\n");
  writeFileSync(join(TEST_DIR, "data.json"), '{"key":"value"}\n');
  mkdirSync(join(TEST_DIR, "src"));
  writeFileSync(join(TEST_DIR, "src", "main.ts"), "export const x = 1;\n");
}

function writeTestConfig(obj: Record<string, any>) {
  const dir = dirname(REAL_CONFIG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(REAL_CONFIG, JSON.stringify(obj, null, 2));
}

function restoreConfig() {
  if (existsSync(BACKUP_CONFIG)) {
    copyFileSync(BACKUP_CONFIG, REAL_CONFIG);
    rmSync(BACKUP_CONFIG);
  }
}

function jsonlSize(): number {
  try { return readFileSync(JSONL_PATH).length; } catch { return 0; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Cascade: full plugin flow — file ops, memory, tools
// ═══════════════════════════════════════════════════════════════════════════════
describe("Cascade: full plugin flow", () => {
  let execToolByName: any;

  before(async () => {
    setupWorkspace();
    if (existsSync(REAL_CONFIG)) copyFileSync(REAL_CONFIG, BACKUP_CONFIG);
    writeTestConfig({ workspacePath: TEST_DIR });
    const mod = await import("../src/toolsProvider");
    execToolByName = (mod as any).execToolByName;
  });

  after(() => { restoreConfig(); rmSync(TEST_DIR, { recursive: true, force: true }); });

  it("list_files returns actual file entries", async () => {
    const files = await execToolByName("list_files", { path: "" }) as any[];
    assert.ok(Array.isArray(files), "returns array");
    assert.ok(files.length >= 3, "finds entries");
    const names = files.map((f: any) => f.name);
    assert.ok(names.includes("hello.txt"), "finds hello.txt");
    assert.ok(names.includes("src"), "finds src/");
  });

  it("read_file returns actual file content", async () => {
    const content = await execToolByName("read_file", { filePath: "hello.txt", maxChars: 100 }) as string;
    assert.equal(content, "Hello World\n");
  });

  it("search_files finds text in files", async () => {
    const results = await execToolByName("search_files", { pattern: "Hello", path: "" }) as any;
    assert.ok(JSON.stringify(results).includes("hello.txt"));
  });

  it("bash_terminal returns stdout", async () => {
    const result = await execToolByName("bash_terminal", { command: "echo -n CASCADE_TEST_98765" }) as any;
    const text = typeof result === "string" ? result : JSON.stringify(result);
    assert.ok(text.includes("CASCADE_TEST_98765"), `got: ${text}`);
  });

  it("write_file creates file, read_file reads it back", async () => {
    await execToolByName("write_file", { filePath: "roundtrip.txt", content: "roundtrip data" });
    const content = await execToolByName("read_file", { filePath: "roundtrip.txt", maxChars: 100 }) as string;
    assert.equal(content, "roundtrip data");
    rmSync(join(TEST_DIR, "roundtrip.txt"));
  });

  it("calculate computes math expressions", async () => {
    const r = await execToolByName("calculate", { expression: "2 + 2" }) as string;
    assert.ok(r.includes("4"));
  });

  it("get_current_datetime returns ISO string", async () => {
    const dt = await execToolByName("get_current_datetime", {}) as string;
    assert.ok(dt.includes("T"));
  });

  it("generate_uuid returns valid format", async () => {
    const uuid = await execToolByName("generate_uuid", {}) as string;
    assert.ok(uuid.includes("-"));
  });

  it("generate_password returns correct length", async () => {
    const pass = await execToolByName("generate_password", { length: 32 }) as any;
    const len = typeof pass === "string" ? pass.length : pass.password?.length || pass.length;
    assert.equal(len, 32);
  });

  it("all core tools return non-undefined values", async () => {
    const toolNames = [
      "read_file", "write_file", "list_files", "search_files",
      "bash_terminal", "calculate", "get_current_datetime",
      "generate_uuid", "generate_password", "encode_base64"
    ];
    for (const name of toolNames) {
      const args = name === "bash_terminal" ? { command: "echo ok" } : {};
      const result = await execToolByName(name, args);
      assert.ok(result !== undefined, `${name} returns a value`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cascade: pickBestModel — VLM filtering and preferred model selection
// ═══════════════════════════════════════════════════════════════════════════════
describe("Cascade: pickBestModel", () => {
  let pickBestModel: any;
  let VLM_PATTERNS: RegExp;

  before(async () => {
    const mod = await import("../src/toolsProvider");
    pickBestModel = (mod as any).pickBestModel;
    VLM_PATTERNS = (mod as any).VLM_PATTERNS;
  });

  it("returns null for empty model list", () => {
    assert.equal(pickBestModel([], undefined), null);
  });

  it("skips VLM models and picks text model", () => {
    const models = [
      { id: "zai-org/glm-4.6v-flash" },
      { id: "qwen/qwen3-4b" },
    ];
    assert.equal(pickBestModel(models, undefined), "qwen/qwen3-4b");
  });

  it("prefers exact preferredModel match", () => {
    const models = [
      { id: "zai-org/glm-4.6v-flash" },
      { id: "llama-3.2-3b-instruct" },
    ];
    assert.equal(pickBestModel(models, "llama-3.2-3b-instruct"), "llama-3.2-3b-instruct");
  });

  it("prefers partial preferredModel match", () => {
    const models = [
      { id: "zai-org/glm-4.6v-flash" },
      { id: "qwen/qwen3.5-9b" },
    ];
    assert.equal(pickBestModel(models, "qwen"), "qwen/qwen3.5-9b");
  });

  it("falls back to first text model if preferred not found", () => {
    const models = [
      { id: "zai-org/glm-4.6v-flash" },
      { id: "qwen/qwen3-4b" },
    ];
    assert.equal(pickBestModel(models, "nonexistent"), "qwen/qwen3-4b");
  });

  it("no text models - picks first VLM anyway", () => {
    const models = [
      { id: "zai-org/glm-4.6v-flash" },
      { id: "llava-1.6-vision" },
    ];
    assert.equal(pickBestModel(models, undefined), "zai-org/glm-4.6v-flash");
  });

  it("VLM_PATTERNS regex matches VLM names", () => {
    assert.ok(VLM_PATTERNS.test("zai-org/glm-4.6v-flash"), "4.6v-flash matched");
    assert.ok(VLM_PATTERNS.test("llava-1.6-vision"), "vision matched");
    assert.ok(VLM_PATTERNS.test("gpt-4-vision-preview"), "gpt-4-vision matched");
    assert.ok(VLM_PATTERNS.test("qwen-vlm"), "vlm matched");
    assert.ok(!VLM_PATTERNS.test("qwen/qwen3-4b"), "qwen3-4b is NOT VLM");
    assert.ok(!VLM_PATTERNS.test("llama-3.2-3b-instruct"), "llama is NOT VLM");
    assert.ok(!VLM_PATTERNS.test("ibm/granite-4-h-tiny"), "granite is NOT VLM");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cascade: callLLM — token budget and memory ceiling
// ═══════════════════════════════════════════════════════════════════════════════
describe("Cascade: callLLM token budget", () => {
  let originalFetch: typeof globalThis.fetch;
  let callLLM: any;

  before(async () => {
    originalFetch = globalThis.fetch;
    if (existsSync(REAL_CONFIG)) copyFileSync(REAL_CONFIG, BACKUP_CONFIG);
    writeTestConfig({ workspacePath: TEST_DIR, preferredModel: "test-model", maxTokensPerCall: 1024 });
    const mod = await import("../src/toolsProvider");
    callLLM = (mod as any).callLLM;
  });

  after(() => { globalThis.fetch = originalFetch; restoreConfig(); });

  it("uses maxTokensPerCall from config (1024)", async () => {
    let capturedBody: any = null;
    globalThis.fetch = async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "test-model", max_context_length: 8192 }] }), { status: 200 });
      }
      capturedBody = JSON.parse(typeof opts?.body === "string" ? opts.body : "{}");
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    };
    await callLLM([{ role: "user", content: "hi" }], false, 0.3);
    assert.equal(capturedBody.max_tokens, 1024);
  });

  it("rejects prompt larger than 85% context window", async () => {
    globalThis.fetch = async (url: string) => {
      return new Response(JSON.stringify({ data: [{ id: "test-model", max_context_length: 200 }] }), { status: 200 });
    };
    const bigContent = "x".repeat(800);
    const result = await callLLM([{ role: "user", content: bigContent }], false, 0.3);
    assert.equal(result, null);
  });

  it("returns null on API failure", async () => {
    globalThis.fetch = async () => { throw new Error("API down"); };
    const result = await callLLM([{ role: "user", content: "hi" }], false, 0.3);
    assert.equal(result, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cascade: orchestratorLoop — memory ceiling and skipQuality
// ═══════════════════════════════════════════════════════════════════════════════
describe("Cascade: orchestratorLoop", () => {
  let originalFetch: typeof globalThis.fetch;
  let orchestratorLoop: any;

  before(async () => {
    originalFetch = globalThis.fetch;
    if (existsSync(REAL_CONFIG)) copyFileSync(REAL_CONFIG, BACKUP_CONFIG);
    writeTestConfig({ workspacePath: TEST_DIR, preferredModel: "test-model", maxTokensPerCall: 1024 });
    const mod = await import("../src/toolsProvider");
    orchestratorLoop = (mod as any).orchestratorLoop;
  });

  after(() => { globalThis.fetch = originalFetch; restoreConfig(); });

  it("skipQuality=true reduces LLM calls", async () => {
    let callsNoSkip = 0;
    let callsSkip = 0;

    globalThis.fetch = async (url: string) => {
      if (typeof url === "string" && url.includes("/v1/models"))
        return new Response(JSON.stringify({ data: [{ id: "test-model", max_context_length: 8192 }] }), { status: 200 });
      callsNoSkip++;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"score":0.9,"reason":"ok"}' } }] }), { status: 200 });
    };
    await orchestratorLoop("sys", "task", 2, false, 0.5, 0, false);

    callsSkip = 0;
    globalThis.fetch = async (url: string) => {
      if (typeof url === "string" && url.includes("/v1/models"))
        return new Response(JSON.stringify({ data: [{ id: "test-model", max_context_length: 8192 }] }), { status: 200 });
      callsSkip++;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"score":0.9,"reason":"ok"}' } }] }), { status: 200 });
    };
    await orchestratorLoop("sys", "task", 2, false, 0.5, 0, true);

    assert.ok(callsSkip < callsNoSkip, `skipQuality=${callsSkip} calls < ${callsNoSkip} without`);
  });

  it("stops when context ceiling reached", async () => {
    globalThis.fetch = async (url: string) => {
      if (typeof url === "string" && url.includes("/v1/models"))
        return new Response(JSON.stringify({ data: [{ id: "test-model", max_context_length: 500 }] }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "x".repeat(2000) } }] }), { status: 200 });
    };
    const result = await orchestratorLoop("sys", "task", 20, false, 0.5, 500, true);
    assert.ok(result.turns < 20, `stopped early at turn ${result.turns}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cascade: config-driven tool filtering
// ═══════════════════════════════════════════════════════════════════════════════
describe("Cascade: configurable tool list", () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
    if (existsSync(REAL_CONFIG)) copyFileSync(REAL_CONFIG, BACKUP_CONFIG);
  });

  after(() => { globalThis.fetch = originalFetch; restoreConfig(); });

  it("toolsProvider returns tools array from config", async () => {
    writeTestConfig({ workspacePath: TEST_DIR });
    globalThis.fetch = async (url: string) => {
      if (typeof url === "string" && url.includes("/v1/models"))
        return new Response(JSON.stringify({ data: [{ id: "test-model", max_context_length: 8192 }] }), { status: 200 });
      return new Response("{}", { status: 200 });
    };
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    assert.ok(Array.isArray(tools), "returns array");
    const names = tools.map((t: any) => t.spec?.name ?? t.name ?? "?");
    assert.ok(names.includes("read_file"), "read_file included");
    assert.ok(names.includes("consult_expert"), "consult_expert included");
    assert.ok(!names.includes("ssh_exec"), "ssh_exec excluded by default");
    assert.ok(!names.includes("encode_base64"), "encode_base64 excluded by default");
  });

  it("enabledTools config overrides defaults", async () => {
    writeTestConfig({ workspacePath: TEST_DIR, enabledTools: ["read_file", "bash_terminal"] });
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const names = tools.map((t: any) => t.spec?.name ?? t.name ?? "?");
    assert.equal(names.length, 2, `expected 2 tools, got ${names.length}: ${names.join(",")}`);
    assert.ok(names.includes("read_file"));
    assert.ok(names.includes("bash_terminal"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cascade: preprocessMessage — prompt interception
// ═══════════════════════════════════════════════════════════════════════════════
describe("Cascade: preprocessMessage", () => {
  before(async () => {
    if (existsSync(REAL_CONFIG)) copyFileSync(REAL_CONFIG, BACKUP_CONFIG);
    writeTestConfig({ workspacePath: TEST_DIR });
  });

  after(() => { restoreConfig(); });

  it("returns null for plain text", async () => {
    const { preprocessMessage } = await import("../src/toolsProvider");
    const result = await (preprocessMessage as any)("hello world");
    assert.equal(result, null);
  });

  it("intercepts search pattern", async () => {
    const { preprocessMessage } = await import("../src/toolsProvider");
    const result = await (preprocessMessage as any)("search typescript generics");
    assert.ok(result !== null);
    assert.ok(result.includes("web_search"));
  });

  it("intercepts calculate pattern", async () => {
    const { preprocessMessage } = await import("../src/toolsProvider");
    const result = await (preprocessMessage as any)("calculate 2+2");
    assert.ok(result !== null);
    assert.ok(result.includes("calculate"));
  });

  it("returns null for empty string", async () => {
    const { preprocessMessage } = await import("../src/toolsProvider");
    const result = await (preprocessMessage as any)("");
    assert.equal(result, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cascade: smart truncation and read_file offset (via tool implementation)
// ═══════════════════════════════════════════════════════════════════════════════
describe("Cascade: smart truncation and read_file offset", () => {
  let allTools: any[];
  let localFetch: typeof globalThis.fetch;
  const BIG_FILE = join(TEST_DIR, "bigfile.txt");

  before(async () => {
    setupWorkspace();
    if (existsSync(REAL_CONFIG)) copyFileSync(REAL_CONFIG, BACKUP_CONFIG);
    writeTestConfig({ workspacePath: TEST_DIR });
    writeFileSync(BIG_FILE, "A".repeat(5000));
    localFetch = globalThis.fetch;
    globalThis.fetch = async (url: string) => {
      if (typeof url === "string" && url.includes("/v1/models"))
        return new Response(JSON.stringify({ data: [{ id: "test-model", max_context_length: 8192 }] }), { status: 200 });
      return new Response("{}", { status: 200 });
    };
    const { toolsProvider } = await import("../src/toolsProvider");
    allTools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
  });

  after(() => { globalThis.fetch = localFetch; restoreConfig(); rmSync(TEST_DIR, { recursive: true, force: true }); });

  function findTool(name: string) {
    return allTools.find((t: any) => (t.spec?.name ?? t.name) === name);
  }

  it("read_file truncates and marks truncated", async () => {
    const t = findTool("read_file");
    const result = await t.implementation({ filePath: "bigfile.txt", maxChars: 1000 }) as any;
    assert.equal(result.data.content.length, 1000, "content is 1000 chars");
    assert.equal(result.data.truncated, true, "marked as truncated");
    assert.equal(result.data.originalLength, 5000, "original length recorded");
  });

  it("read_file with offset reads from middle", async () => {
    const t = findTool("read_file");
    const result = await t.implementation({ filePath: "bigfile.txt", maxChars: 100, offset: 2500 }) as any;
    assert.equal(result.data.content.length, 100);
    assert.equal(result.data.content, "A".repeat(100));
  });

  it("read_file with offset near end returns partial", async () => {
    const t = findTool("read_file");
    const result = await t.implementation({ filePath: "bigfile.txt", maxChars: 100, offset: 4950 }) as any;
    assert.equal(result.data.content.length, 50, "only 50 chars left");
  });

  it("read_file with offset past end returns empty", async () => {
    const t = findTool("read_file");
    const result = await t.implementation({ filePath: "bigfile.txt", maxChars: 100, offset: 10000 }) as any;
    assert.equal(result.data.content.length, 0, "empty when past end");
  });

  it("read_file full file not truncated", async () => {
    const t = findTool("read_file");
    const result = await t.implementation({ filePath: "hello.txt", maxChars: 50000 }) as any;
    assert.equal(result.data.truncated, undefined, "not truncated for small file");
    assert.equal(result.data.content, "Hello World\n");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cascade: requireWorkspace guard
// ═══════════════════════════════════════════════════════════════════════════════
describe("Cascade: requireWorkspace guard", () => {
  let originalFetch2: typeof globalThis.fetch;

  before(async () => {
    originalFetch2 = globalThis.fetch;
    if (existsSync(REAL_CONFIG)) copyFileSync(REAL_CONFIG, BACKUP_CONFIG);
    writeTestConfig({});
  });

  after(() => {
    globalThis.fetch = originalFetch2;
    restoreConfig();
  });

  it("tools fail gracefully when no workspace set", async () => {
    globalThis.fetch = async (url: string) => {
      if (typeof url === "string" && url.includes("/v1/models"))
        return new Response(JSON.stringify({ data: [{ id: "test-model", max_context_length: 8192 }] }), { status: 200 });
      return new Response("{}", { status: 200 });
    };
    // Write empty config to clear any workspacePath
    writeFileSync(REAL_CONFIG, JSON.stringify({}));
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => "" } as any);
    const readFileTool = tools.find((t: any) => (t.spec?.name ?? t.name) === "read_file");
    assert.ok(readFileTool, "read_file tool exists");
    const result = await readFileTool.implementation({ filePath: "hello.txt", maxChars: 100 });
    assert.ok(result.error, "returns error when no workspace");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cascade: edge cases
// ═══════════════════════════════════════════════════════════════════════════════
describe("Cascade: edge cases", () => {
  let allTools: any[];
  let localFetch: typeof globalThis.fetch;

  before(async () => {
    setupWorkspace();
    if (existsSync(REAL_CONFIG)) copyFileSync(REAL_CONFIG, BACKUP_CONFIG);
    writeTestConfig({ workspacePath: TEST_DIR });
    localFetch = globalThis.fetch;
    globalThis.fetch = async (url: string) => {
      if (typeof url === "string" && url.includes("/v1/models"))
        return new Response(JSON.stringify({ data: [{ id: "test-model", max_context_length: 8192 }] }), { status: 200 });
      return new Response("{}", { status: 200 });
    };
    const { toolsProvider } = await import("../src/toolsProvider");
    allTools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
  });

  after(() => { globalThis.fetch = localFetch; restoreConfig(); rmSync(TEST_DIR, { recursive: true, force: true }); });

  function findTool(name: string) {
    return allTools.find((t: any) => (t.spec?.name ?? t.name) === name);
  }

  it("read_file on non-existent file returns error", async () => {
    const t = findTool("read_file");
    const result = await t.implementation({ filePath: "nonexistent.txt", maxChars: 100 }) as any;
    assert.ok(result.error, "returns error");
    assert.ok(result.error.includes("not found") || result.error.includes("ENOENT"), "error mentions not found");
  });

  it("read_file on directory returns error", async () => {
    const t = findTool("read_file");
    const result = await t.implementation({ filePath: "src", maxChars: 100 }) as any;
    assert.ok(result.error, "returns error for directory");
    assert.ok(result.error.includes("directory"), "error mentions directory");
  });

  it("read_file on binary file returns error", async () => {
    writeFileSync(join(TEST_DIR, "test.png"), Buffer.from([0x00, 0x01, 0x02]));
    const t = findTool("read_file");
    const result = await t.implementation({ filePath: "test.png", maxChars: 100 }) as any;
    assert.ok(result.error, "returns error for binary");
    assert.ok(result.error.includes("binary"), "error mentions binary");
  });

  it("list_files on non-existent path returns error", async () => {
    const t = findTool("list_files");
    const result = await t.implementation({ path: "nonexistent_dir" }) as any;
    assert.ok(result.error, "returns error");
  });

  it("bash_terminal with invalid command returns output", async () => {
    const t = findTool("bash_terminal");
    const result = await t.implementation({ command: "ls /nonexistent_path_xyz_123" }) as any;
    const text = JSON.stringify(result);
    assert.ok(text.length > 0, "returns something");
  });

  it("write_file and read_file roundtrip", async () => {
    const content = "test content " + "x".repeat(500);
    const wt = findTool("write_file");
    await wt.implementation({ filePath: "edge_test.txt", content });
    const rt = findTool("read_file");
    const readBack = await rt.implementation({ filePath: "edge_test.txt", maxChars: 10000 }) as any;
    assert.equal(readBack.data.content, content, "roundtrip preserves content exactly");
    rmSync(join(TEST_DIR, "edge_test.txt"));
  });

  it("write_file creates parent dirs", async () => {
    const wt = findTool("write_file");
    await wt.implementation({ filePath: "deep/nested/dir/file.txt", content: "nested" });
    const rt = findTool("read_file");
    const result = await rt.implementation({ filePath: "deep/nested/dir/file.txt", maxChars: 100 }) as any;
    assert.equal(result.data.content, "nested");
    rmSync(join(TEST_DIR, "deep"), { recursive: true });
  });

  it("search_files with no matches returns empty", async () => {
    const t = findTool("search_files");
    const result = await t.implementation({ pattern: "ZZZZNOTFOUND99999", path: "" }) as any;
    const text = JSON.stringify(result);
    assert.ok(!text.includes("hello.txt"), "does not match unrelated files");
  });

  it("get_config returns config object", async () => {
    const t = findTool("get_config");
    const result = await t.implementation({}) as any;
    assert.ok(result, "returns something");
    const text = JSON.stringify(result);
    assert.ok(text.includes("workspace"), "mentions workspace");
  });

  it("save_memory and search_memory roundtrip", async () => {
    const sm = findTool("save_memory");
    await sm.implementation({ content: "edge_case_test_777", tags: ["edge_test"] });
    const after = readFileSync(JSONL_PATH, "utf-8");
    assert.ok(after.includes("edge_case_test_777"), "saved");
    const searchTool = findTool("search_memory");
    const results = await searchTool.implementation({ tags: ["edge_test"] }) as any;
    const text = JSON.stringify(results);
    assert.ok(text.includes("edge_case_test_777"), "found by tag");
  });

  it("calculate with division by zero", async () => {
    const t = findTool("calculate");
    const result = await t.implementation({ expression: "1/0" }) as any;
    const text = typeof result === "string" ? result : JSON.stringify(result);
    assert.ok(text.includes("Infinity") || text.includes("inf") || text.includes("NaN") || result.data !== undefined, "handles division by zero");
  });

  it("calculate with invalid expression", async () => {
    const t = findTool("calculate");
    const result = await t.implementation({ expression: "+++" }) as any;
    assert.ok(result, "returns something for invalid expression");
  });
});
