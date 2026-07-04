import { JsonlCache, type JsonlEntry } from "./jsonlCache";

export interface TurnEntry extends JsonlEntry {
  type: "turn";
  sessionId?: string;
  ts: string;
  turn: number;
  role: string;
  content?: string | null;
  toolCalls?: Array<{ name: string; args: string; result?: string }>;
}

export interface MemoryEntry extends JsonlEntry {
  type: "mem";
  sessionId?: string;
  ts: string;
  tags: string[];
  content: string;
  step?: number;
}

export interface CheckpointEntry extends JsonlEntry {
  type: "checkpoint";
  sessionId?: string;
  ts: string;
  turn: number;
  summary: string;
  tags: string[];
}

const DEFAULT_WORKING_WINDOW = 12;

export class SessionLog {
  private jsonl: JsonlCache;
  private workingWindow: TurnEntry[] = [];
  private maxWindow: number;
  private turnCounter = 0;

  constructor(filePath: string, maxWindow = DEFAULT_WORKING_WINDOW) {
    this.jsonl = new JsonlCache(filePath);
    this.maxWindow = maxWindow;
    this.turnCounter = 0;
  }

  startTurn(entry: TurnEntry): void {
    this.turnCounter = entry.turn;
    this.workingWindow.push(entry);
    this.jsonl.append(entry as unknown as JsonlEntry);
    if (this.workingWindow.length > this.maxWindow) {
      this.workingWindow.shift();
    }
  }

  evictOldest(n: number): TurnEntry[] {
    const actual = Math.min(n, this.workingWindow.length);
    return this.workingWindow.splice(0, actual);
  }

  getWorkingWindow(): TurnEntry[] {
    return [...this.workingWindow];
  }

  replaceWorkingWindow(entries: TurnEntry[]): void {
    this.workingWindow = entries.slice(-this.maxWindow);
  }

  hydrateLastTurns(n: number): TurnEntry[] {
    const entries = this.jsonl.readTail(n) as TurnEntry[];
    this.workingWindow = entries.slice(-this.maxWindow);
    return [...this.workingWindow];
  }

  saveMemory(tags: string[], content: string, step?: number, sessionId?: string): void {
    const entry: MemoryEntry = {
      type: "mem",
      sessionId,
      ts: new Date().toISOString(),
      tags,
      content,
    };
    if (step !== undefined) entry.step = step;
    this.jsonl.append(entry);
  }

  saveCheckpoint(summary: string, tags: string[], turn: number, sessionId?: string): void {
    const entry: CheckpointEntry = {
      type: "checkpoint",
      sessionId,
      ts: new Date().toISOString(),
      turn,
      summary,
      tags,
    };
    this.jsonl.append(entry);
  }

  searchMemoriesByTags(tags: string[], maxResults: number = 5): MemoryEntry[] {
    return this.jsonl.searchByTags(tags, maxResults) as MemoryEntry[];
  }

  searchCheckpoints(sessionId: string, maxResults: number = 5): CheckpointEntry[] {
    const entries = this.jsonl.readTail(500) as CheckpointEntry[];
    const results: CheckpointEntry[] = [];
    for (let i = entries.length - 1; i >= 0 && results.length < maxResults; i--) {
      const e = entries[i];
      if (e.type === "checkpoint" && e.sessionId === sessionId) results.push(e);
    }
    return results;
  }

  searchMemoriesByContent(query: string, maxResults: number = 5): MemoryEntry[] {
    const results: MemoryEntry[] = [];
    const total = this.jsonl.totalLines();
    if (total === 0) return results;
    const entries = this.jsonl.readTail(Math.min(total, 500));
    const q = query.toLowerCase();
    for (let i = entries.length - 1; i >= 0 && results.length < maxResults; i--) {
      const e = entries[i] as MemoryEntry;
      if (e.type === "mem" && e.content && e.content.toLowerCase().includes(q)) {
        results.push(e);
      }
    }
    return results;
  }

  getTurnCount(): number {
    return this.turnCounter;
  }

  totalTurnsLogged(): number {
    return this.jsonl.totalLines();
  }

  compact(): void {
    this.jsonl.compact();
  }

  clear(): void {
    this.jsonl.clear();
    this.workingWindow = [];
    this.turnCounter = 0;
  }
}
