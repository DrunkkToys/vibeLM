import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";

const TEST_DIR = join(tmpdir(), "agentic-tools-test-" + Date.now());

function setup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, "hello.txt"), "Hello World\n");
  mkdirSync(join(TEST_DIR, "sub"));
  writeFileSync(join(TEST_DIR, "sub", "nested.js"), "const x = 1;\nconsole.log(x);\n");
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

// --- Sandbox utils ---

function sandboxPath(workspace: string, requestedPath: string): string {
  const { resolve, relative } = require("path");
  const resolved = resolve(workspace, requestedPath);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`Path "${requestedPath}" is outside the workspace "${workspace}"`);
  }
  return resolved;
}

// --- Memory helpers ---

interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  created: string;
  updated: string;
}

// --- Tests ---

describe("agentic-tools", () => {
  describe("sandboxPath", () => {
    it("resolves within workspace", () => {
      const result = sandboxPath(TEST_DIR, "hello.txt");
      assert.equal(result, join(TEST_DIR, "hello.txt"));
    });

    it("resolves subdirectory", () => {
      const result = sandboxPath(TEST_DIR, "sub/nested.js");
      assert.equal(result, join(TEST_DIR, "sub", "nested.js"));
    });

    it("resolves dot to workspace", () => {
      const result = sandboxPath(TEST_DIR, ".");
      assert.equal(result, TEST_DIR);
    });

    it("rejects path outside workspace", () => {
      assert.throws(() => sandboxPath(TEST_DIR, ".."), /outside the workspace/);
    });

    it("rejects absolute path outside workspace", () => {
      assert.throws(() => sandboxPath(TEST_DIR, "/etc"), /outside the workspace/);
    });

    it("rejects traversal via subdirectory", () => {
      assert.throws(() => sandboxPath(TEST_DIR, "sub/../../etc"), /outside the workspace/);
    });
  });

  describe("file operations", () => {
    setup();
    teardown();

    it("existsSync detects files", () => {
      assert.equal(existsSync(join(TEST_DIR, "hello.txt")), true);
      assert.equal(existsSync(join(TEST_DIR, "nonexistent.txt")), false);
    });

    it("readFileSync reads content", () => {
      const content = readFileSync(join(TEST_DIR, "hello.txt"), "utf-8");
      assert.equal(content, "Hello World\n");
    });

    it("writeFileSync creates new file", () => {
      writeFileSync(join(TEST_DIR, "new.txt"), "new content", "utf-8");
      assert.equal(readFileSync(join(TEST_DIR, "new.txt"), "utf-8"), "new content");
    });

    it("writeFileSync overwrites existing file", () => {
      writeFileSync(join(TEST_DIR, "hello.txt"), "overwritten", "utf-8");
      assert.equal(readFileSync(join(TEST_DIR, "hello.txt"), "utf-8"), "overwritten");
    });

    it("readFileSync nested file", () => {
      const content = readFileSync(join(TEST_DIR, "sub", "nested.js"), "utf-8");
      assert.ok(content.includes("const x"));
    });
  });

  describe("directory operations", () => {
    setup();
    teardown();

    it("readdirSync lists entries", () => {
      const { readdirSync } = require("fs");
      const entries = readdirSync(TEST_DIR).sort();
      assert.ok(entries.includes("hello.txt"));
      assert.ok(entries.includes("sub"));
    });

    it("readdirSync withFileTypes shows types", () => {
      const { readdirSync } = require("fs");
      const entries = readdirSync(TEST_DIR, { withFileTypes: true });
      const names = entries.map((e: { name: string; isFile: () => boolean }) => `${e.name}:${e.isFile() ? "file" : "dir"}`).sort();
      assert.ok(names.includes("hello.txt:file"));
      assert.ok(names.includes("sub:dir"));
    });
  });

  describe("memory operations", () => {
    it("creates memory entry with correct shape", () => {
      const entry: MemoryEntry = {
        id: "mem-123",
        content: "test content",
        tags: ["test"],
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
      };
      assert.equal(entry.id, "mem-123");
      assert.equal(entry.content, "test content");
      assert.deepEqual(entry.tags, ["test"]);
    });

    it("tag filtering logic", () => {
      const entries: MemoryEntry[] = [
        { id: "1", content: "a", tags: ["x", "y"], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" },
        { id: "2", content: "b", tags: ["y", "z"], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" },
        { id: "3", content: "c", tags: ["x"], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" },
      ];
      const filtered = entries.filter((e) => ["x"].some((t) => e.tags.includes(t)));
      assert.equal(filtered.length, 2);
      assert.equal(filtered[0].id, "1");
      assert.equal(filtered[1].id, "3");
    });

    it("keyword search logic", () => {
      const entries: MemoryEntry[] = [
        { id: "1", content: "Hello World", tags: [], created: "", updated: "" },
        { id: "2", content: "Goodbye World", tags: [], created: "", updated: "" },
        { id: "3", content: "Hello Everyone", tags: [], created: "", updated: "" },
      ];
      const q = "hello".toLowerCase();
      const filtered = entries.filter((e) => e.content.toLowerCase().includes(q));
      assert.equal(filtered.length, 2);
    });

    it("sort by created descending", () => {
      const entries: MemoryEntry[] = [
        { id: "1", content: "old", tags: [], created: "2026-01-01T00:00:00.000Z", updated: "" },
        { id: "2", content: "new", tags: [], created: "2026-06-01T00:00:00.000Z", updated: "" },
        { id: "3", content: "middle", tags: [], created: "2026-03-01T00:00:00.000Z", updated: "" },
      ];
      entries.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
      assert.equal(entries[0].id, "2");
      assert.equal(entries[1].id, "3");
      assert.equal(entries[2].id, "1");
    });

    it("delete by id", () => {
      const entries: MemoryEntry[] = [
        { id: "1", content: "a", tags: [], created: "", updated: "" },
        { id: "2", content: "b", tags: [], created: "", updated: "" },
      ];
      const idx = entries.findIndex((e) => e.id === "1");
      assert.equal(idx, 0);
      entries.splice(idx, 1);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].id, "2");
    });

    it("update preserves untouched fields", () => {
      const entry: MemoryEntry = { id: "1", content: "old", tags: ["a"], created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" };
      const newContent = "new";
      const newTags = ["a", "b"];
      if (newContent !== undefined) entry.content = newContent;
      if (newTags !== undefined) entry.tags = newTags;
      assert.equal(entry.content, "new");
      assert.equal(entry.id, "1");
      assert.deepEqual(entry.tags, ["a", "b"]);
      assert.equal(entry.created, "2026-01-01T00:00:00.000Z");
    });
  });

  describe("config operations", () => {
    const configPath = join(tmpdir(), "test-config-" + Date.now() + ".json");

    it("reads config returns defaults when file missing", () => {
      assert.equal(existsSync(configPath), false);
    });

    it("writes and reads config", () => {
      const config = { workspacePath: "/tmp" };
      writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      assert.equal(raw.workspacePath, "/tmp");
    });

    it("merges with defaults", () => {
      const defaults = { workspacePath: "/home" };
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const merged = { ...defaults, ...raw };
      assert.equal(merged.workspacePath, "/tmp");
    });
  });

  describe("binary extension detection", () => {
    const binaryTypes = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".exe", ".dll", ".pyc", ".mp4", ".wasm"];
    const textTypes = [".txt", ".js", ".ts", ".py", ".md", ".html", ".css", ".json", ".yaml", ".xml", ".csv", ".log"];

    const BINARY_EXTS = new Set([
      ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
      ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
      ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
      ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac",
      ".exe", ".dll", ".so", ".dylib", ".wasm",
      ".o", ".obj", ".pyc", ".class",
      ".ttf", ".otf", ".woff", ".woff2",
    ]);

    for (const ext of binaryTypes) {
      it(`detects ${ext} as binary`, () => {
        assert.equal(BINARY_EXTS.has(ext), true);
      });
    }
    for (const ext of textTypes) {
      it(`detects ${ext} as non-binary`, () => {
        assert.equal(BINARY_EXTS.has(ext), false);
      });
    }
  });

  describe("calculate safety (mathjs)", () => {
    it("adds two numbers", () => {
      const result = require("mathjs").evaluate("2 + 2");
      assert.equal(result, 4);
    });

    it("handles trig", () => {
      const result = require("mathjs").evaluate("sin(pi / 2)");
      assert.ok(Math.abs(result - 1) < 0.0001);
    });

    it("rejects unsafe code", () => {
      assert.throws(() => require("mathjs").evaluate("String.fromCharCode(65)"), /Unexpected/);
    });

    it("rejects code execution", () => {
      assert.throws(() => require("mathjs").evaluate("process.exit()"), /Unexpected/);
    });
  });

  describe("password generation", () => {
    it("generates correct length", () => {
      const { randomInt } = require("crypto");
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
      const length = 24;
      let pw = "";
      for (let i = 0; i < length; i++) pw += chars[randomInt(0, chars.length)];
      assert.equal(pw.length, 24);
    });

    it("uses only allowed characters", () => {
      const { randomInt } = require("crypto");
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
      const length = 100;
      let pw = "";
      for (let i = 0; i < length; i++) pw += chars[randomInt(0, chars.length)];
      for (const c of pw) {
        assert.ok(chars.includes(c), `Char "${c}" not in charset`);
      }
    });

    it("generates unique passwords", () => {
      const { randomInt } = require("crypto");
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
      const pws = new Set<string>();
      for (let i = 0; i < 10; i++) {
        let pw = "";
        for (let j = 0; j < 24; j++) pw += chars[randomInt(0, chars.length)];
        pws.add(pw);
      }
      assert.equal(pws.size, 10, "All 10 passwords should be unique");
    });
  });

  describe("uuid generation", () => {
    it("generates valid UUID v4 format", () => {
      const { randomUUID } = require("crypto");
      const uuid = randomUUID();
      assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("generates unique UUIDs", () => {
      const { randomUUID } = require("crypto");
      const uuids = new Set<string>();
      for (let i = 0; i < 100; i++) uuids.add(randomUUID());
      assert.equal(uuids.size, 100);
    });
  });

  describe("base64 operations", () => {
    it("encodes and decodes", () => {
      const original = "Hello World! 123";
      const encoded = Buffer.from(original).toString("base64");
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      assert.equal(decoded, original);
    });

    it("handles unicode", () => {
      const original = "héllo 🎉 world";
      const encoded = Buffer.from(original).toString("base64");
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      assert.equal(decoded, original);
    });

    it("handles empty string", () => {
      const encoded = Buffer.from("").toString("base64");
      assert.equal(encoded, "");
    });
  });

  describe("datetime", () => {
    it("returns ISO format", () => {
      const now = new Date();
      const iso = now.toISOString();
      assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("unix timestamp is within reasonable range", () => {
      const ts = Math.floor(Date.now() / 1000);
      assert.ok(ts > 1700000000, "Should be after 2023");
      assert.ok(ts < 2000000000, "Should be before 2033");
    });
  });
});
