import { appendFileSync, readFileSync, readSync, openSync, closeSync, existsSync, mkdirSync, statSync, renameSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";

export type JsonlEntry = Record<string, unknown>;

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

export class JsonlCache {
  private path: string;
  private maxBytes: number;
  private byteOffsets: number[] = [];
  private count = 0;

  constructor(filePath: string, maxBytes = DEFAULT_MAX_BYTES) {
    this.path = resolve(filePath);
    this.maxBytes = maxBytes;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(this.path)) appendFileSync(this.path, "", "utf-8");
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.byteOffsets = [];
    this.count = 0;
    try {
      const size = statSync(this.path).size;
      if (size === 0) return;
      const fd = openSync(this.path, "r");
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      closeSync(fd);
      const content = buf.toString("utf-8");
      let pos = 0;
      while (pos < content.length) {
        const nl = content.indexOf("\n", pos);
        if (nl === -1) break;
        this.byteOffsets.push(pos);
        this.count++;
        pos = nl + 1;
      }
    } catch {}
  }

  private readLineByIndex(idx: number): string | null {
    if (idx < 0 || idx >= this.count) return null;
    try {
      const fd = openSync(this.path, "r");
      const start = this.byteOffsets[idx];
      const end = idx + 1 < this.count ? this.byteOffsets[idx + 1] : statSync(this.path).size;
      const len = end - start;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      closeSync(fd);
      return buf.toString("utf-8").trim();
    } catch {
      return null;
    }
  }

  private readLineRange(startIdx: number, endIdx: number): string[] {
    const lines: string[] = [];
    if (startIdx >= endIdx || startIdx >= this.count) return lines;
    try {
      const fd = openSync(this.path, "r");
      const fileStart = this.byteOffsets[Math.max(0, startIdx)];
      const fileEnd = endIdx < this.count ? this.byteOffsets[endIdx] : statSync(this.path).size;
      const len = fileEnd - fileStart;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, fileStart);
      closeSync(fd);
      const content = buf.toString("utf-8");
      for (const line of content.split("\n")) {
        if (line.trim()) lines.push(line.trim());
      }
    } catch {}
    return lines;
  }

  append(obj: JsonlEntry): void {
    const line = JSON.stringify(obj) + "\n";
    const size = statSync(this.path).size;
    if (size + Buffer.byteLength(line, "utf-8") > this.maxBytes) {
      this.compact();
    }
    appendFileSync(this.path, line, "utf-8");
    this.byteOffsets.push(size);
    this.count++;
  }

  appendBatch(objs: JsonlEntry[]): void {
    const lines = objs.map(o => JSON.stringify(o)).join("\n") + "\n";
    const size = statSync(this.path).size;
    if (size + Buffer.byteLength(lines, "utf-8") > this.maxBytes) {
      this.compact();
    }
    appendFileSync(this.path, lines, "utf-8");
    this.byteOffsets.push(size);
    this.count += objs.length;
  }

  readTail(n: number): JsonlEntry[] {
    if (n <= 0 || this.count === 0) return [];
    const start = Math.max(0, this.count - n);
    const lines = this.readLineRange(start, this.count);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as JsonlEntry[];
  }

  readRange(startLine: number, endLine: number): JsonlEntry[] {
    const lines = this.readLineRange(startLine, Math.min(endLine, this.count));
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as JsonlEntry[];
  }

  searchByField(field: string, value: unknown, maxResults: number = 10): JsonlEntry[] {
    const results: JsonlEntry[] = [];
    for (let i = this.count - 1; i >= 0 && results.length < maxResults; i--) {
      const line = this.readLineByIndex(i);
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry[field] !== undefined && entry[field] === value) {
          results.push(entry);
        }
      } catch {}
    }
    return results;
  }

  searchByTag(tag: string, maxResults: number = 10): JsonlEntry[] {
    const results: JsonlEntry[] = [];
    for (let i = this.count - 1; i >= 0 && results.length < maxResults; i--) {
      const line = this.readLineByIndex(i);
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        const tags = entry.tags as string[] | undefined;
        if (tags && tags.some(t => t.includes(tag) || tag.includes(t))) {
          results.push(entry);
        }
      } catch {}
    }
    return results;
  }

  searchByTags(tags: string[], maxResults: number = 10): JsonlEntry[] {
    const results: JsonlEntry[] = [];
    for (let i = this.count - 1; i >= 0 && results.length < maxResults; i--) {
      const line = this.readLineByIndex(i);
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        const entryTags = entry.tags as string[] | undefined;
        if (entryTags && tags.some(t => entryTags.some(et => et.includes(t) || t.includes(et)))) {
          results.push(entry);
        }
      } catch {}
    }
    return results;
  }

  totalLines(): number {
    return this.count;
  }

  fileSize(): number {
    return statSync(this.path).size;
  }

  compact(): void {
    const lines = this.readLineRange(0, this.count);
    const kept: string[] = [];
    let memCount = 0;
    let summaryCount = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const type = entry.type as string;
        if (type === "mem" || type === "summary") {
          kept.push(line);
          if (type === "mem") memCount++;
          if (type === "summary") summaryCount++;
        }
      } catch {
        kept.push(line);
      }
    }

    let turnCount = 0;
    for (let i = lines.length - 1; i >= 0 && turnCount < 100; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "turn" && !kept.includes(lines[i])) {
          kept.splice(0, 0, lines[i]);
          turnCount++;
        }
      } catch {}
    }

    const tmp = this.path + ".tmp";
    appendFileSync(tmp, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf-8");
    renameSync(tmp, this.path);
    this.rebuildIndex();
  }

  clear(): void {
    writeFileSync(this.path, "", "utf-8");
    this.byteOffsets = [];
    this.count = 0;
  }

  getPath(): string {
    return this.path;
  }
}
