export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

function clean(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export async function webSearch(query: string, maxResults: number = 5): Promise<SearchResult[]> {
  const endpoint = process.env.AGENTIC_SEARCH_ENDPOINT || "http://localhost:8394/search";
  try {
    const resp = await fetch(`${endpoint}?q=${encodeURIComponent(query)}&format=json`, {
      headers: { "User-Agent": "AgenticTools/2.0" },
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { results?: Array<{ title: string; url: string; snippet: string }> };
    return (data.results || []).slice(0, maxResults).map(r => ({
      title: clean(r.title),
      url: r.url,
      snippet: clean(r.snippet),
      engine: "searxng",
    }));
  } catch {
    return [];
  }
}
