/**
 * Live CDP target harness.
 *
 * Serves tests/fixtures/buggy-app.html over a real HTTP server and launches a
 * throwaway Playwright Chromium with --remote-debugging-port so vibeLM's
 * WebDebugAdapter can attach to it exactly as it would to a user's browser.
 *
 * Playwright is the TARGET and the ORACLE here — never the code under test.
 * Every vibeLM action is verified by querying the same page through Playwright,
 * so `ok: true` from vibeLM cannot pass as success unless the page really moved.
 *
 * The project compiles as CommonJS (tsconfig `module: CommonJS`), so this file
 * uses __dirname rather than import.meta.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const FIXTURE = resolve(__dirname, "../fixtures/buggy-app.html");

/** Deliberately not 9222, so a real Chrome the user is running is never touched. */
export const CDP_PORT = 19222;

export interface CdpTarget {
  /** Playwright handle to the same page vibeLM attaches to — the oracle. */
  page: Page;
  browser: Browser;
  /** URL vibeLM should attach to. */
  url: string;
  close(): Promise<void>;
}

/** Wait until the CDP HTTP endpoint lists at least one page target. */
async function waitForCdp(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://localhost:${port}/json`);
      if (resp.ok) {
        const targets = (await resp.json()) as Array<{ type: string }>;
        if (targets.some((t) => t.type === "page")) return;
        lastErr = `no page targets yet (${targets.length} targets)`;
      } else {
        lastErr = `HTTP ${resp.status}`;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`CDP endpoint on :${port} not ready: ${lastErr}`);
}

export async function startCdpTarget(port: number = CDP_PORT): Promise<CdpTarget> {
  const html = readFileSync(FIXTURE, "utf8");
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind fixture server");
  const url = `http://127.0.0.1:${addr.port}/`;

  const browser = await chromium.launch({
    args: [`--remote-debugging-port=${port}`],
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "load" });
  // The fixture's failing fetch resolves asynchronously; give it a beat so the
  // console error is present before any capture.
  await page.waitForTimeout(300);

  await waitForCdp(port);

  return {
    page,
    browser,
    url,
    async close() {
      await browser.close().catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
