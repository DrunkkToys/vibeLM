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
  workspace?: string;
  scope?: "session" | "workspace" | "research";
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

type MemoryScope = "session" | "workspace" | "research";

type MemoryFilter = {
  workspace?: string;
  sessionId?: string;
  scope?: MemoryScope | "all";
};

export type { MemoryFilter, MemoryScope };

function matchesMemoryFilter(entry: MemoryEntry, filter: MemoryFilter = {}): boolean {
  if (filter.workspace) {
    if (entry.workspace && entry.workspace !== filter.workspace) return false;
    if (!entry.workspace && !entry.tags.some((tag) => tag === `workspace:${filter.workspace}`)) return false;
  }
  if (filter.sessionId) {
    if (entry.sessionId && entry.sessionId !== filter.sessionId) return false;
    if (!entry.sessionId && !entry.tags.some((tag) => tag === `session:${filter.sessionId}`)) return false;
  }
  if (filter.scope && filter.scope !== "all") {
    const scopeTag = `scope:${filter.scope}`;
    if (entry.scope && entry.scope !== filter.scope) return false;
    if (!entry.scope && !entry.tags.includes(scopeTag)) return false;
  }
  return true;
}

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

  readRecentEntries(limit: number): JsonlEntry[] {
    return this.jsonl.readTail(limit);
  }

  readRecentTurns(limit: number, sessionId?: string): TurnEntry[] {
    return this.jsonl
      .readTail(limit)
      .filter((entry): entry is TurnEntry => entry.type === "turn" && (!sessionId || entry.sessionId === sessionId));
  }

  readRecentMemories(limit: number, sessionId?: string): MemoryEntry[] {
    return this.jsonl
      .readTail(limit)
      .filter((entry): entry is MemoryEntry => entry.type === "mem" && (!sessionId || entry.sessionId === sessionId));
  }

  readRecentCheckpoints(limit: number, sessionId?: string): CheckpointEntry[] {
    return this.jsonl
      .readTail(limit)
      .filter((entry): entry is CheckpointEntry => entry.type === "checkpoint" && (!sessionId || entry.sessionId === sessionId));
  }

  saveMemory(tags: string[], content: string, step?: number, sessionId?: string, workspace?: string, scope: MemoryScope = "workspace"): void {
    const entry: MemoryEntry = {
      type: "mem",
      sessionId,
      workspace,
      scope,
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

  searchMemoriesByTags(tags: string[], maxResults: number = 5, filter: MemoryFilter = {}): MemoryEntry[] {
    return this.jsonl
      .searchByTags(tags, maxResults)
      .filter((entry): entry is MemoryEntry => entry.type === "mem" && typeof entry.content === "string")
      .filter((entry) => matchesMemoryFilter(entry, filter));
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

  searchMemoriesByContent(query: string, maxResults: number = 5, filter: MemoryFilter = {}): MemoryEntry[] {
    const results: MemoryEntry[] = [];
    const total = this.jsonl.totalLines();
    if (total === 0) return results;
    const entries = this.jsonl.readTail(Math.min(total, 500));
    const q = query.toLowerCase();
    for (let i = entries.length - 1; i >= 0 && results.length < maxResults; i--) {
      const e = entries[i] as MemoryEntry;
      if (e.type === "mem" && e.content && e.content.toLowerCase().includes(q) && matchesMemoryFilter(e, filter)) {
        results.push(e);
      }
    }
    return results;
  }

  countMemories(filter: MemoryFilter = {}): number {
    const total = this.jsonl.totalLines();
    if (total === 0) return 0;
    return this.jsonl
      .readTail(total)
      .filter((entry): entry is MemoryEntry => entry.type === "mem" && typeof entry.content === "string")
      .filter((entry) => matchesMemoryFilter(entry, filter))
      .length;
  }

  getTurnCount(): number {
    return this.turnCounter;
  }

  totalTurnsLogged(): number {
    return this.jsonl.totalLines();
  }

  countEntriesByType(type: JsonlEntry["type"]): number {
    const total = this.jsonl.totalLines();
    if (total === 0) return 0;
    return this.jsonl.readTail(total).filter((entry) => entry.type === type).length;
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
