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

export interface SearchMemoryResult extends MemoryEntry {
  matchScore: number;
  matchedTags: string[];
  matchedContent: boolean;
  matchMode: "tags" | "query";
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

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9:_./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMemoryEntry(entry: MemoryEntry, tags: string[] = [], query?: string): number {
  let score = 0;
  const normalizedContent = normalizeSearchText(entry.content);
  const normalizedQuery = normalizeSearchText(query || "");
  if (normalizedQuery) {
    if (normalizedContent === normalizedQuery) score += 100;
    if (normalizedContent.includes(normalizedQuery)) score += 60;
    for (const part of normalizedQuery.split(" ")) {
      if (!part) continue;
      if (normalizedContent.includes(part)) score += 8;
    }
    for (const tag of entry.tags) {
      const normalizedTag = normalizeSearchText(tag);
      if (normalizedTag === normalizedQuery) score += 90;
      if (normalizedTag.includes(normalizedQuery) || normalizedQuery.includes(normalizedTag)) score += 45;
    }
  }
  for (const tag of tags) {
    const normalizedTag = normalizeSearchText(tag);
    for (const entryTag of entry.tags) {
      const normalizedEntryTag = normalizeSearchText(entryTag);
      if (normalizedEntryTag === normalizedTag) score += 30;
      else if (normalizedEntryTag.includes(normalizedTag) || normalizedTag.includes(normalizedEntryTag)) score += 15;
    }
  }
  if (entry.scope === "research") score += 2;
  return score;
}

function explainMemoryMatch(entry: MemoryEntry, tags: string[] = [], query?: string): { matchedTags: string[]; matchedContent: boolean; score: number } {
  const matchedTags: string[] = [];
  const normalizedQuery = normalizeSearchText(query || "");
  const normalizedContent = normalizeSearchText(entry.content);
  let matchedContent = false;

  if (normalizedQuery) {
    matchedContent = normalizedContent.includes(normalizedQuery);
    if (matchedContent) {
      matchedTags.push(`content:${query}`);
    }
    for (const tag of entry.tags) {
      const normalizedTag = normalizeSearchText(tag);
      if (normalizedTag === normalizedQuery || normalizedTag.includes(normalizedQuery) || normalizedQuery.includes(normalizedTag)) {
        matchedTags.push(`tag:${tag}`);
      }
    }
  }

  for (const tag of tags) {
    for (const entryTag of entry.tags) {
      if (entryTag === tag || entryTag.includes(tag) || tag.includes(entryTag)) {
        matchedTags.push(`tag:${entryTag}`);
      }
    }
  }

  return { matchedTags: Array.from(new Set(matchedTags)), matchedContent, score: scoreMemoryEntry(entry, tags, query) };
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

  searchMemoriesByTags(tags: string[], maxResults: number = 5, filter: MemoryFilter = {}): SearchMemoryResult[] {
    const total = this.jsonl.totalLines();
    if (total === 0) return [];
    const limit = Math.min(total, 200);
    const entries = this.jsonl.readTail(limit);
    return entries
      .filter((entry): entry is MemoryEntry => entry.type === "mem" && typeof entry.content === "string")
      .filter((entry) => matchesMemoryFilter(entry, filter))
      .filter((entry) => tags.some((tag) => entry.tags.some((entryTag) => entryTag === tag || entryTag.includes(tag) || tag.includes(entryTag))))
      .map((entry) => ({ entry, ...explainMemoryMatch(entry, tags), matchMode: "tags" as const }))
      .sort((a, b) => b.score - a.score || (b.entry.ts || "").localeCompare(a.entry.ts || ""))
      .slice(0, maxResults)
      .map(({ entry, score, matchedTags, matchedContent, matchMode }) => ({ ...entry, matchScore: score, matchedTags, matchedContent, matchMode }));
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

  searchMemoriesByContent(query: string, maxResults: number = 5, filter: MemoryFilter = {}): SearchMemoryResult[] {
    const total = this.jsonl.totalLines();
    if (total === 0) return [];
    const limit = Math.min(total, 200);
    const entries = this.jsonl.readTail(limit);
    const normalizedQuery = normalizeSearchText(query);
    return entries
      .filter((entry): entry is MemoryEntry => entry.type === "mem" && typeof entry.content === "string")
      .filter((entry) => matchesMemoryFilter(entry, filter))
      .map((entry) => ({ entry, ...explainMemoryMatch(entry, [], normalizedQuery), matchMode: "query" as const }))
      .filter(({ matchedContent, matchedTags }) => matchedContent || matchedTags.length > 0)
      .sort((a, b) => b.score - a.score || (b.entry.ts || "").localeCompare(a.entry.ts || ""))
      .slice(0, maxResults)
      .map(({ entry, score, matchedTags, matchedContent, matchMode }) => ({ ...entry, matchScore: score, matchedTags, matchedContent, matchMode }));
  }

  countMemories(filter: MemoryFilter = {}): number {
    const total = this.jsonl.totalLines();
    if (total === 0) return 0;
    const limit = Math.min(total, 200);
    return this.jsonl
      .readTail(limit)
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
    const limit = Math.min(total, 200);
    return this.jsonl.readTail(limit).filter((entry) => entry.type === type).length;
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
