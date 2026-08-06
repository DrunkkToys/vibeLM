import { WebSocket } from "ws";
import { spawn, type ChildProcess } from "child_process";
import { execSync, execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve, dirname } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TargetType = "web" | "desktop" | "mobile";
export type InteractionAction = "click" | "type" | "scroll" | "focus" | "key_combination";
export type PatchType = "js_eval" | "css_inject" | "dom_mutate" | "env_override";
export type PlatformOS = "darwin" | "win32" | "linux" | "android" | "ios";

export interface DebugTargetInfo {
  targetType: TargetType;
  identifier: string;
  pid?: number;
  platform: PlatformOS;
  attachedAt: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
  /** Web targets: the URL actually attached to, which may differ from `identifier`. */
  resolvedUrl?: string;
  /** Web targets: the page title actually attached to. */
  resolvedTitle?: string;
}

/** Shape of an entry from a CDP endpoint's /json listing. */
interface CDPTargetInfo {
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export interface CaptureOptions {
  includeDOM?: boolean;
  logTailLines?: number;
  /** Screenshots are opt-in: on a real app they are far too large by default. */
  includeScreenshot?: boolean;
  /** How deep to walk the DOM. -1 means the whole tree and is rarely usable. */
  domDepth?: number;
}

export interface DebugSnapshot {
  screenshot?: string;
  componentTree?: unknown[];
  /** Compact JSON description of the page: title, url, headings, controls, text. */
  summary?: string;
  /** Explains anything that was omitted for size, and what to do instead. */
  notes?: string[];
  logs: string[];
  networkErrors: string[];
  timestamp: string;
}

export interface InteractionParams {
  action: InteractionAction;
  selector?: string;
  coordinates?: { x: number; y: number };
  value?: string;
}

export interface HotfixPatch {
  patchType: PatchType;
  payload: string;
}

export interface AttachParams {
  targetType: TargetType;
  identifier: string;
  autoBreakOnCrash?: boolean;
  cdpPort?: number;
}

export interface SafetyBoundary {
  windowBounds?: { x: number; y: number; width: number; height: number };
  workspacePath?: string;
}

// ─── Debug Adapter Interface ─────────────────────────────────────────────────

interface DebugAdapter {
  attach(params: AttachParams): Promise<{ ok: boolean; error?: string }>;
  detach(): Promise<void>;
  captureState(options: CaptureOptions): Promise<{ ok: boolean; data?: DebugSnapshot; error?: string }>;
  executeInteraction(params: InteractionParams): Promise<{ ok: boolean; error?: string }>;
  applyHotfix(patch: HotfixPatch): Promise<{ ok: boolean; error?: string; result?: string }>;
  getInfo(): DebugTargetInfo | null;
  isAttached(): boolean;
}

// ─── CDP WebSocket Adapter (Web / Browser) ───────────────────────────────────

/** Upper bound on any single CDP round-trip, so a dead target cannot wedge a loop. */
const CDP_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Cap on retained console/exception lines. A chatty page left attached for a
 * long autonomous session would otherwise grow this buffer without limit.
 */
const MAX_LOG_BUFFER = 1000;

/**
 * Size ceilings for a capture. Measured against LM Studio's own renderer: a
 * full PNG screenshot was 691,500 base64 chars (~173k tokens) and the complete
 * DOM was 1,215,075 chars (~304k tokens), against a 17,318-token model context.
 * Returning either unbounded makes debug_capture_state unusable on any real
 * application, so both are capped and the tool explains what it dropped.
 */
const MAX_DOM_CHARS = 60_000;
const MAX_SCREENSHOT_CHARS = 120_000;
const DEFAULT_DOM_DEPTH = 4;
const SCREENSHOT_QUALITY = 40;
/** Tried largest-first; the first size that fits under the cap is returned. */
const SCREENSHOT_SCALES = [1, 0.6, 0.35, 0.2];

class WebDebugAdapter implements DebugAdapter {
  private ws: WebSocket | null = null;
  private info: DebugTargetInfo | null = null;
  private messageId = 0;
  private pendingResponses = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private logBuffer: string[] = [];

  async attach(params: AttachParams): Promise<{ ok: boolean; error?: string }> {
    const url = params.identifier;
    const port = params.cdpPort ?? 9222;
    let wsUrl: string;

    let resolved: CDPTargetInfo | undefined;
    if (url.startsWith("ws://") || url.startsWith("wss://")) {
      wsUrl = url;
    } else {
      const r = await this.resolveCDPTarget(url, port);
      if (!r.target) {
        return {
          ok: false,
          error: r.error ?? `Cannot discover CDP endpoint for ${url}. Ensure the app is running with --remote-debugging-port=${port}`,
        };
      }
      resolved = r.target;
      wsUrl = r.target.webSocketDebuggerUrl!;
    }

    try {
      // Never abandon a live socket by overwriting the reference.
      if (this.ws) this.cleanup();
      this.ws = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
        this.ws!.on("open", () => { clearTimeout(t); resolve(); });
        this.ws!.on("error", (e: Error) => { clearTimeout(t); reject(e); });
        this.ws!.on("message", (data: Buffer) => this.handleMessage(data.toString()));
      });

      // Once connected, a socket that drops must fail in-flight commands rather
      // than leaving them pending forever.
      this.ws.on("close", () => this.failPending("CDP connection closed by target"));
      this.ws.on("error", (e: Error) => this.failPending(`CDP connection error: ${e.message}`));

      const version = await this.cdpCommand("Browser.getVersion");
      this.info = {
        targetType: "web",
        identifier: url,
        // Report what we ACTUALLY attached to, so a mismatch is visible rather
        // than hidden behind the identifier the caller asked for.
        resolvedUrl: resolved?.url,
        resolvedTitle: resolved?.title,
        platform: process.platform as PlatformOS,
        attachedAt: new Date().toISOString(),
      };

      await this.cdpCommand("Page.enable");
      // Runtime must be enabled or Runtime.consoleAPICalled and
      // Runtime.exceptionThrown never arrive, leaving captureState blind to
      // every console message and uncaught error on the page.
      await this.cdpCommand("Runtime.enable");
      await this.cdpCommand("Console.enable");
      await this.cdpCommand("Debugger.enable");
      await this.cdpCommand("DOM.enable");
      await this.cdpCommand("Network.enable");
      if (params.autoBreakOnCrash) {
        await this.cdpCommand("Debugger.pauseOnExceptions", { state: "uncaught" });
      }

      this.logBuffer.push(`[CDP] Attached to ${url} (${JSON.stringify(version)})`);
      return { ok: true };
    } catch (e) {
      this.cleanup();
      return { ok: false, error: `CDP attach failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async detach(): Promise<void> {
    this.cleanup();
    this.info = null;
  }

  async captureState(options: CaptureOptions): Promise<{ ok: boolean; data?: DebugSnapshot; error?: string }> {
    if (!this.ws || !this.info) return { ok: false, error: "No target attached" };

    try {
      const logs = this.logBuffer.slice(-(options.logTailLines ?? 50));

      // Everything below is size-bounded on purpose. A capture of a real
      // application is enormous — measured against LM Studio's own window, a
      // full-page PNG is ~691k base64 chars (~173k tokens) and the full DOM is
      // ~1.2M chars (~304k tokens). Either one alone dwarfs a typical local
      // model's context, so an unbounded capture does not merely waste tokens,
      // it makes the tool unusable.
      const notes: string[] = [];

      let componentTree: unknown[] | undefined;
      if (options.includeDOM !== false) {
        // Try the requested depth, then progressively shallower. On a real app
        // the full tree measured ~303k chars at depth 4, so a fixed depth means
        // the DOM is simply never returned; stepping down yields a usable tree.
        const requested = options.domDepth ?? DEFAULT_DOM_DEPTH;
        const depths = [requested, 3, 2, 1].filter((d, i, a) => d <= requested && a.indexOf(d) === i);
        let lastSize = 0;
        for (const depth of depths) {
          const doc = await this.cdpCommand("DOM.getDocument", { depth });
          const json = JSON.stringify(doc);
          lastSize = json.length;
          if (json.length <= MAX_DOM_CHARS) {
            componentTree = [doc];
            if (depth < requested) notes.push(`DOM returned at depth ${depth} instead of ${requested} to fit the size limit.`);
            break;
          }
        }
        if (!componentTree) {
          notes.push(
            `DOM omitted: ${lastSize} chars even at depth 1, over the ${MAX_DOM_CHARS} limit. ` +
            `Use the summary below, or debug_execute_interaction with a CSS selector, instead of reading the whole tree.`
          );
        }
      }

      let networkErrors: string[] = [];
      try {
        const perf = await this.cdpCommand("Network.getPerformanceMetrics");
        networkErrors = extractNetworkErrors(perf);
      } catch {}

      // A compact, always-cheap description of the page. This is what makes the
      // tool useful when the screenshot and DOM are too big to return.
      let summary: string | undefined;
      try {
        const r = await this.cdpCommand("Runtime.evaluate", {
          expression: `JSON.stringify({
            title: document.title,
            url: location.href,
            elements: document.querySelectorAll('*').length,
            headings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0,10).map(function(e){return e.textContent.trim().slice(0,80)}),
            buttons: Array.from(document.querySelectorAll('button,[role=button]')).slice(0,20).map(function(e){return (e.textContent||e.getAttribute('aria-label')||'').trim().slice(0,40)}).filter(Boolean),
            inputs: Array.from(document.querySelectorAll('input,textarea,select')).slice(0,20).map(function(e){return e.tagName.toLowerCase()+(e.id?'#'+e.id:'')}),
            text: document.body ? document.body.innerText.slice(0,1500) : ''
          })`,
          returnByValue: true,
        });
        summary = (r as any)?.result?.value;
      } catch {}

      // Screenshots are opt-in. When asked for, downscale and JPEG-compress so
      // the result stays within a size a model can actually receive.
      let screenshotBase64: string | undefined;
      if (options.includeScreenshot === true) {
        try {
          // Compression alone is not enough: a real app window at JPEG quality
          // 40 measured ~229k chars, still far past the cap. Downscale via the
          // capture clip so a usable image is actually returned, and step the
          // scale down rather than silently giving back nothing.
          const metrics = await this.cdpCommand("Page.getLayoutMetrics").catch(() => null);
          const css = (metrics as any)?.cssVisualViewport ?? (metrics as any)?.layoutViewport ?? {};
          const width = Math.max(1, Math.round(css.clientWidth ?? css.width ?? 1280));
          const height = Math.max(1, Math.round(css.clientHeight ?? css.height ?? 800));

          for (const scale of SCREENSHOT_SCALES) {
            const shot = await this.cdpCommand("Page.captureScreenshot", {
              format: "jpeg",
              quality: SCREENSHOT_QUALITY,
              captureBeyondViewport: false,
              clip: { x: 0, y: 0, width, height, scale },
            });
            const data = (shot as any)?.data as string | undefined;
            if (!data) break;
            if (data.length <= MAX_SCREENSHOT_CHARS) {
              screenshotBase64 = data;
              if (scale < 1) notes.push(`Screenshot downscaled to ${Math.round(scale * 100)}% to fit the size limit.`);
              break;
            }
            if (scale === SCREENSHOT_SCALES[SCREENSHOT_SCALES.length - 1]) {
              notes.push(
                `Screenshot omitted: still ${data.length} chars at ${Math.round(scale * 100)}% scale, over the ${MAX_SCREENSHOT_CHARS} limit. ` +
                `The page summary below describes the state instead.`
              );
            }
          }
        } catch {}
      }

      return {
        ok: true,
        data: {
          screenshot: screenshotBase64,
          componentTree,
          summary,
          notes: notes.length ? notes : undefined,
          logs,
          networkErrors,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (e) {
      return { ok: false, error: `State capture failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /**
   * Runs `body` against the element matched by `selector`, and reports failure
   * when nothing matches.
   *
   * The previous implementation used `document.querySelector(sel)?.click()` and
   * always returned ok, so an interaction against a selector that does not
   * exist looked identical to one that worked. A model then proceeds as if the
   * button were pressed. A no-op must be reported as a no-op.
   */
  private async selectorAction(
    selector: string,
    body: string
  ): Promise<{ ok: boolean; error?: string }> {
    const r = await this.cdpCommand("Runtime.evaluate", {
      expression: `(function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return "__NOT_FOUND__";
        ${body}
      })()`,
      returnByValue: true,
    });
    const value = (r as any)?.result?.value;
    const thrown = (r as any)?.exceptionDetails;
    if (thrown) {
      const msg = thrown?.exception?.description ?? thrown?.text ?? "unknown error";
      return { ok: false, error: `Interaction on "${selector}" threw: ${String(msg).slice(0, 200)}` };
    }
    if (value === "__NOT_FOUND__") {
      return { ok: false, error: `No element matches selector "${selector}" on the attached page.` };
    }
    return { ok: true };
  }

  async executeInteraction(params: InteractionParams): Promise<{ ok: boolean; error?: string }> {
    if (!this.ws) return { ok: false, error: "No target attached" };

    try {
      switch (params.action) {
        case "click": {
          if (params.selector) {
            const found = await this.selectorAction(
              params.selector,
              `el.click(); return true;`
            );
            if (!found.ok) return found;
          } else if (params.coordinates) {
            await this.cdpCommand("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: params.coordinates.x,
              y: params.coordinates.y,
              button: "left",
              clickCount: 1,
            });
            await this.cdpCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: params.coordinates.x,
              y: params.coordinates.y,
              button: "left",
              clickCount: 1,
            });
          }
          break;
        }
        case "type": {
          if (params.selector) {
            const r = await this.selectorAction(
              params.selector,
              `el.value = ${JSON.stringify(params.value ?? "")};
               el.dispatchEvent(new Event('input', { bubbles: true }));
               el.dispatchEvent(new Event('change', { bubbles: true }));
               return true;`
            );
            if (!r.ok) return r;
          }
          break;
        }
        case "scroll": {
          if (params.coordinates) {
            await this.cdpCommand("Runtime.evaluate", {
              expression: `window.scrollTo(${params.coordinates.x}, ${params.coordinates.y})`,
            });
          }
          break;
        }
        case "focus": {
          if (params.selector) {
            const r = await this.selectorAction(params.selector, `el.focus(); return true;`);
            if (!r.ok) return r;
          }
          break;
        }
        case "key_combination": {
          if (params.value) {
            const mods = params.value.split("+").map((s) => s.trim().toLowerCase());
            await this.cdpCommand("Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              windowsVirtualKeyCode: mods.includes("enter") ? 13 : mods.includes("tab") ? 9 : 32,
              modifiers: computeModifierBits(mods),
            });
          }
          break;
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Interaction failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async applyHotfix(patch: HotfixPatch): Promise<{ ok: boolean; error?: string; result?: string }> {
    if (!this.ws) return { ok: false, error: "No target attached" };

    try {
      switch (patch.patchType) {
        case "js_eval": {
          return { ok: false, error: "js_eval is not supported: arbitrary JavaScript is not a safe debug hotfix boundary." };
        }
        case "css_inject": {
          const escaped = patch.payload.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
          // Key the injected <style> by its content so re-applying the same
          // hotfix updates that element in place instead of appending another
          // node every time. Re-capturing state and re-applying is the normal
          // debugging rhythm, so the naive append grew the DOM without bound.
          // Distinct payloads still get their own element and still compose.
          const key = createHash("sha1").update(patch.payload).digest("hex").slice(0, 16);
          await this.cdpCommand("Runtime.evaluate", {
            expression: `(function() {
              var k = ${JSON.stringify(key)};
              var s = document.querySelector('style[data-vibelm-hotfix="' + k + '"]');
              if (!s) {
                s = document.createElement('style');
                s.setAttribute('data-vibelm-hotfix', k);
                document.head.appendChild(s);
              }
              s.textContent = \`${escaped}\`;
            })()`,
          });
          return { ok: true };
        }
        case "dom_mutate": {
          return { ok: false, error: "dom_mutate is not supported: use a source change or a CSS-only hotfix." };
        }
        case "env_override": {
          return { ok: false, error: "env_override not supported for web targets" };
        }
      }
      return { ok: false, error: `Unknown patch type: ${patch.patchType}` };
    } catch (e) {
      return { ok: false, error: `Hotfix failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  getInfo(): DebugTargetInfo | null {
    return this.info;
  }

  isAttached(): boolean {
    return this.ws !== null && this.info !== null;
  }

  // ── Private helpers ──

  /**
   * Resolves which CDP target to attach to.
   *
   * There is deliberately no "just take the first one" fallback. Silently
   * attaching to an arbitrary target means a later hotfix or click lands in a
   * different application than the user named, with getTargetInfo() still
   * reporting the requested identifier — a wrong-target mutation with no
   * visible symptom. If nothing matches, this fails and says what IS available.
   */
  private async resolveCDPTarget(
    identifier: string,
    port: number = 9222
  ): Promise<{ target?: CDPTargetInfo; error?: string }> {
    let targets: CDPTargetInfo[];
    try {
      const resp = await fetch(`http://localhost:${port}/json`);
      if (!resp.ok) return { error: `CDP endpoint on port ${port} returned HTTP ${resp.status}` };
      targets = (await resp.json()) as CDPTargetInfo[];
    } catch (e) {
      return { error: `Cannot reach CDP endpoint on port ${port}: ${e instanceof Error ? e.message : String(e)}` };
    }

    const pages = (targets ?? []).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!pages.length) return { error: `No debuggable page targets on port ${port}.` };

    const needle = identifier.trim().toLowerCase();
    const describe = () =>
      pages.map((p) => `  - "${p.title ?? "(untitled)"}"  ${p.url ?? ""}`).join("\n");

    // An empty identifier is only unambiguous when there is exactly one page.
    if (!needle) {
      if (pages.length === 1) return { target: pages[0] };
      return { error: `Multiple page targets on port ${port}; name one:\n${describe()}` };
    }

    const matches = pages.filter((p) => {
      const url = (p.url ?? "").toLowerCase();
      const decoded = safeDecode(url);
      const title = (p.title ?? "").toLowerCase();
      return url.includes(needle) || decoded.includes(needle) || title.includes(needle);
    });

    if (matches.length === 1) return { target: matches[0] };
    if (matches.length === 0) {
      return { error: `No CDP target matches "${identifier}" on port ${port}. Available targets:\n${describe()}` };
    }

    // Several matched. Ambiguity only matters when the candidates are actually
    // different pages — an app with two identical windows is not a wrong-target
    // risk, and refusing there would block a legitimate attach the caller has
    // no way to disambiguate.
    const distinct = new Set(matches.map((m) => `${m.title ?? ""}|${m.url ?? ""}`));
    if (distinct.size === 1) return { target: matches[0] };

    return { error: `"${identifier}" matches ${matches.length} different targets on port ${port}; be more specific:\n${describe()}` };
  }

  private cdpCommand(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("No WebSocket connection"));
      const id = ++this.messageId;

      // Without a deadline a command against a target that died mid-session
      // never settles, which would wedge an unattended debugging loop forever.
      const timer = setTimeout(() => {
        this.pendingResponses.delete(id);
        reject(new Error(`CDP command ${method} timed out after ${CDP_COMMAND_TIMEOUT_MS}ms`));
      }, CDP_COMMAND_TIMEOUT_MS);

      this.pendingResponses.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      try {
        this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      } catch (e) {
        clearTimeout(timer);
        this.pendingResponses.delete(id);
        reject(new Error(`CDP send failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  /** Reject every in-flight command; used when the socket dies or we detach. */
  private failPending(reason: string) {
    for (const [, p] of this.pendingResponses) {
      try { p.reject(new Error(reason)); } catch {}
    }
    this.pendingResponses.clear();
  }

  private handleMessage(data: string) {
    try {
      const msg = JSON.parse(data);
      if (msg.id && this.pendingResponses.has(msg.id)) {
        const p = this.pendingResponses.get(msg.id)!;
        this.pendingResponses.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      }
      if (msg.method === "Console.messageAdded") {
        this.logBuffer.push(`[console] ${JSON.stringify(msg.params?.message?.text ?? msg)}`);
      }
      // Console.messageAdded is deprecated and Chrome no longer emits it for
      // ordinary console.* calls; Runtime.consoleAPICalled is the live channel.
      if (msg.method === "Runtime.consoleAPICalled") {
        const level = msg.params?.type ?? "log";
        const text = (msg.params?.args ?? [])
          .map((a: any) => a?.value ?? a?.description ?? a?.unserializableValue ?? "")
          .filter((s: string) => s !== "")
          .join(" ");
        this.logBuffer.push(`[console:${level}] ${text || JSON.stringify(msg.params ?? {})}`);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        const text = d?.exception?.description ?? d?.text ?? JSON.stringify(d ?? msg);
        this.logBuffer.push(`[exception] ${text}`);
      }
      if (this.logBuffer.length > MAX_LOG_BUFFER) {
        this.logBuffer.splice(0, this.logBuffer.length - MAX_LOG_BUFFER);
      }
    } catch {}
  }

  private cleanup() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.failPending("CDP connection closed");
  }
}

// ─── Desktop Process Supervisor (Desktop Apps) ────────────────────────────────

class DesktopDebugAdapter implements DebugAdapter {
  private process: ChildProcess | null = null;
  private info: DebugTargetInfo | null = null;
  private logBuffer: string[] = [];
  private crashed = false;

  async attach(params: AttachParams): Promise<{ ok: boolean; error?: string }> {
    const pid = parseInt(params.identifier, 10);
    if (isNaN(pid)) {
      return this.spawnTarget(params.identifier);
    }
    return this.attachToProcess(pid);
  }

  async attachDebugger(): Promise<{ ok: boolean; error?: string; output?: string }> {
    if (!this.info?.pid) return { ok: false, error: "No process attached" };
    const os = process.platform;
    try {
      if (os === "darwin") {
        const output = execSync(
          `lldb -p ${this.info.pid} -o "bt" -o "quit"`,
          { timeout: 10000, encoding: "utf-8", maxBuffer: 1024 * 1024 }
        );
        this.logBuffer.push(`[lldb] Backtrace captured for PID ${this.info.pid}`);
        return { ok: true, output };
      } else {
        const output = execSync(
          `gdb -batch -ex "thread apply all bt" -p ${this.info.pid}`,
          { timeout: 10000, encoding: "utf-8", maxBuffer: 1024 * 1024 }
        );
        this.logBuffer.push(`[gdb] Backtrace captured for PID ${this.info.pid}`);
        return { ok: true, output };
      }
    } catch (e) {
      return { ok: false, error: `Debugger attach failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async captureCrashInfo(): Promise<{ ok: boolean; output?: string; error?: string }> {
    if (!this.info?.pid) return { ok: false, error: "No process attached" };
    try {
      if (process.platform === "darwin") {
        const output = execSync(
          `log show --predicate 'processID == ${this.info.pid}' --style compact --last 1m 2>/dev/null | tail -50`,
          { timeout: 5000, encoding: "utf-8", maxBuffer: 1024 * 1024 }
        );
        return { ok: true, output };
      } else {
        const output = execSync(
          `dmesg | tail -50`,
          { timeout: 5000, encoding: "utf-8", maxBuffer: 1024 * 1024 }
        );
        return { ok: true, output };
      }
    } catch (e) {
      return { ok: false, error: `Crash info unavailable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async spawnTarget(binaryPath: string): Promise<{ ok: boolean; error?: string }> {
    if (!existsSync(binaryPath)) {
      return { ok: false, error: `Binary not found: ${binaryPath}` };
    }

    try {
      this.process = spawn(binaryPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      this.process.stdout?.on("data", (data: Buffer) => {
        this.logBuffer.push(`[stdout] ${data.toString().trim()}`);
      });
      this.process.stderr?.on("data", (data: Buffer) => {
        this.logBuffer.push(`[stderr] ${data.toString().trim()}`);
      });
      this.process.on("exit", (code) => {
        this.logBuffer.push(`[process] Exited with code ${code}`);
        if (code !== 0) this.crashed = true;
        // Release the stdio pipes. Without this a short-lived target leaves its
        // streams referenced by the event loop, so the host process (the plugin
        // inside LM Studio, or the test runner) never becomes idle and hangs
        // even after all work is finished.
        this.releaseProcessHandles();
      });

      // The debug target must never keep its host alive.
      this.process.unref();

      this.info = {
        targetType: "desktop",
        identifier: binaryPath,
        pid: this.process.pid,
        platform: process.platform as PlatformOS,
        attachedAt: new Date().toISOString(),
      };

      return { ok: true };
    } catch (e) {
      return { ok: false, error: `Failed to spawn ${binaryPath}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async attachToProcess(pid: number): Promise<{ ok: boolean; error?: string }> {
    try {
      process.kill(pid, 0);
    } catch {
      return { ok: false, error: `Process ${pid} not found` };
    }

    this.info = {
      targetType: "desktop",
      identifier: String(pid),
      pid,
      platform: process.platform as PlatformOS,
      attachedAt: new Date().toISOString(),
    };

    this.logBuffer.push(`[process] Attached to PID ${pid}`);
    return { ok: true };
  }

  /** Detach stdio and remove listeners so nothing keeps the event loop alive. */
  private releaseProcessHandles(): void {
    const p = this.process;
    if (!p) return;
    try { p.stdout?.removeAllListeners(); p.stdout?.destroy(); } catch {}
    try { p.stderr?.removeAllListeners(); p.stderr?.destroy(); } catch {}
    try { p.stdin?.end(); p.stdin?.destroy(); } catch {}
    try { p.unref(); } catch {}
  }

  async detach(): Promise<void> {
    if (this.process) {
      this.releaseProcessHandles();
      try { this.process.kill("SIGTERM"); } catch {}
      this.process = null;
    }
    this.info = null;
    this.crashed = false;
  }

  async captureState(options: CaptureOptions): Promise<{ ok: boolean; data?: DebugSnapshot; error?: string }> {
    if (!this.info) return { ok: false, error: "No target attached" };

    try {
      const tail = options.logTailLines ?? 50;
      const logs = this.logBuffer.slice(-tail);

      let componentTree: unknown[] | undefined;
      if (options.includeDOM !== false) {
        componentTree = await this.readAccessibilityTree();
      }

      return {
        ok: true,
        data: {
          componentTree,
          logs,
          networkErrors: this.crashed ? ["Process terminated with non-zero exit code"] : [],
          timestamp: new Date().toISOString(),
        },
      };
    } catch (e) {
      return { ok: false, error: `State capture failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async readAccessibilityTree(): Promise<unknown[]> {
    const os = process.platform;
    const pid = this.info?.pid;
    try {
      if (os === "darwin" && pid) {
        const swiftScript = `
import AppKit

func traverse(element: AXUIElement, depth: Int) -> [String: Any] {
    var attrs: [String: Any] = ["role": "", "title": "", "value": "", "children": []]
    var role: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
    attrs["role"] = (role as? String) ?? ""

    var title: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &title)
    attrs["title"] = (title as? String) ?? ""

    var desc: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &desc)
    attrs["description"] = (desc as? String) ?? ""

    var value: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
    if let v = value { attrs["value"] = "\\(v)" }

    var pos: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &pos)
    if let p = pos {
        var pt = CGPoint.zero
        AXValueGetValue(p as! AXValue, .cgPoint, &pt)
        attrs["position"] = ["x": Int(pt.x), "y": Int(pt.y)]
    }

    var size: CFTypeRef?
    AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size)
    if let s = size {
        var sz = CGSize.zero
        AXValueGetValue(s as! AXValue, .cgSize, &sz)
        attrs["size"] = ["width": Int(sz.width), "height": Int(sz.height)]
    }

    if depth < 10 {
        var children: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children)
        if let childArray = children as? [AXUIElement] {
            attrs["children"] = childArray.map { traverse(element: $0, depth: depth + 1) }
        }
    }
    return attrs
}

let app = NSRunningApplication(processIdentifier: ${pid})
let appElement = AXUIElementCreateApplication(${pid})
let tree = traverse(element: appElement, depth: 0)

let jsonData = try! JSONSerialization.data(withJSONObject: tree)
print(String(data: jsonData, encoding: .utf8)!)
`;
        const output = execFileSync("swift", ["-"], {
          input: swiftScript,
          timeout: 10000,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
        });
        try {
          return [JSON.parse(output.trim())];
        } catch {
          return [{ platform: "macOS", raw: output.trim().slice(0, 5000) }];
        }
      } else if (os === "darwin") {
        const output = execSync(
          `osascript -e 'tell application "System Events" to get name of every process'`,
          { timeout: 5000, encoding: "utf-8" }
        );
        return [{ platform: "macOS", processes: output.trim().split(", ") }];
      } else if (os === "win32") {
        return [{ platform: "windows", note: "UIAutomation tree requires native module" }];
      } else {
        return [{ platform: "linux", note: "AT-SPI tree requires dbus" }];
      }
    } catch (e) {
      return [{ error: `Accessibility tree unavailable: ${e instanceof Error ? e.message : String(e)}` }];
    }
  }

  async executeInteraction(params: InteractionParams): Promise<{ ok: boolean; error?: string }> {
    if (!this.info) return { ok: false, error: "No target attached" };

    try {
      const os = process.platform;
      if (os === "darwin") {
        return this.executeMacOSAction(params);
      } else if (os === "win32") {
        return this.executeWindowsAction(params);
      } else {
        return this.executeLinuxAction(params);
      }
    } catch (e) {
      return { ok: false, error: `Desktop interaction failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async executeMacOSAction(params: InteractionParams): Promise<{ ok: boolean; error?: string }> {
    const escaped = (s: string) => s.replace(/"/g, '\\"');
    switch (params.action) {
      case "click": {
        if (params.selector) {
          const script = `
            tell application "System Events"
              tell process "${escaped(this.info!.identifier)}"
                try
                  click UI element "${escaped(params.selector)}"
                end try
              end tell
            end tell
          `;
          execSync(`osascript -e '${script.replace(/\n/g, " ")}'`, { timeout: 5000 });
        } else if (params.coordinates) {
          execSync(
            `osascript -e 'tell application "System Events" to click at {${params.coordinates.x}, ${params.coordinates.y}}'`,
            { timeout: 5000 }
          );
        }
        return { ok: true };
      }
      case "type": {
        if (params.value) {
          execSync(
            `osascript -e 'tell application "System Events" to keystroke "${escaped(params.value)}"'`,
            { timeout: 5000 }
          );
        }
        return { ok: true };
      }
      case "key_combination": {
        if (params.value) {
          const keys = params.value.split("+").map((k) => k.trim());
          const osaKeys = keys.map((k) => {
            const map: Record<string, string> = { cmd: "command", ctrl: "control", alt: "option", shift: "shift", enter: "return", tab: "tab", esc: "escape", space: "space" };
            return map[k.toLowerCase()] || k;
          });
          const hold = osaKeys.slice(0, -1);
          const press = osaKeys[osaKeys.length - 1];
          execSync(
            `osascript -e 'tell application "System Events" to key code ${pressCode(press)} using {${hold.map((k) => `${k} down`).join(", ")}}'`,
            { timeout: 5000 }
          );
        }
        return { ok: true };
      }
      default:
        return { ok: false, error: `Action ${params.action} not supported on macOS` };
    }
  }

  private async executeWindowsAction(_params: InteractionParams): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "Windows interaction not implemented in this version" };
  }

  private async executeLinuxAction(_params: InteractionParams): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "Linux interaction not implemented in this version" };
  }

  async applyHotfix(patch: HotfixPatch): Promise<{ ok: boolean; error?: string; result?: string }> {
    return { ok: false, error: "Desktop hotfix not supported; write fix to workspace files instead" };
  }

  getInfo(): DebugTargetInfo | null {
    return this.info;
  }

  isAttached(): boolean {
    return this.info !== null;
  }
}

function pressCode(key: string): string {
  const map: Record<string, string> = { return: "36", tab: "48", space: "49", escape: "53", enter: "36", delete: "51" };
  return map[key.toLowerCase()] || "0";
}

// ─── Mobile Adapter (Android ADB + iOS simctl) ─────────────────────────────

class MobileDebugAdapter implements DebugAdapter {
  private info: DebugTargetInfo | null = null;
  private logBuffer: string[] = [];
  private platform: "android" | "ios" | null = null;
  private udid: string | null = null;

  async attach(params: AttachParams): Promise<{ ok: boolean; error?: string }> {
    const bundleId = params.identifier;
    if (!/^[A-Za-z0-9._-]+$/.test(bundleId)) {
      return { ok: false, error: "Invalid mobile bundle identifier" };
    }

    // Try iOS first (if simctl is available)
    if (process.platform === "darwin") {
      try {
        const devices = execSync("xcrun simctl list devices booted -j", {
          timeout: 5000,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024,
        });
        const parsed = JSON.parse(devices);
        const bootedDevices = Object.values(parsed.devices || {}).flat().filter((d: any) => d.state === "Booted");
        if (bootedDevices.length > 0) {
          this.udid = (bootedDevices[0] as any).udid;
          try {
            execSync(`xcrun simctl get_app_container ${this.udid} ${bundleId}`, { timeout: 5000, encoding: "utf-8" });
            this.platform = "ios";
            this.info = { targetType: "mobile", identifier: bundleId, platform: "ios", attachedAt: new Date().toISOString() };
            this.logBuffer.push(`[iOS] Attached to ${bundleId} on simulator ${this.udid}`);
            return { ok: true };
          } catch {}
        }
      } catch {}
    }

    // Fall back to Android ADB
    try {
      execSync("adb devices", { timeout: 5000, encoding: "utf-8" });
    } catch {
      return { ok: false, error: "No mobile runtime available. Install Xcode CLI tools (iOS) or Android platform-tools (ADB)." };
    }

    try {
      execSync(`adb shell pm path ${bundleId}`, { timeout: 5000, encoding: "utf-8" });
    } catch {
      return { ok: false, error: `Package ${bundleId} not found. Check adb devices and bundle ID.` };
    }

    this.platform = "android";
    this.info = { targetType: "mobile", identifier: bundleId, platform: "android", attachedAt: new Date().toISOString() };
    this.logBuffer.push(`[ADB] Attached to ${bundleId}`);
    return { ok: true };
  }

  async detach(): Promise<void> {
    this.info = null;
  }

  async captureState(options: CaptureOptions): Promise<{ ok: boolean; data?: DebugSnapshot; error?: string }> {
    if (!this.info) return { ok: false, error: "No target attached" };

    try {
      const tail = options.logTailLines ?? 50;

      if (this.platform === "ios") {
        let logs: string[] = [];
        try {
          const logOutput = execSync(
            `log show --predicate 'processImagePath CONTAINS "${this.info.identifier}"' --style compact --last 30s 2>/dev/null | tail -${tail}`,
            { timeout: 5000, encoding: "utf-8", maxBuffer: 1024 * 1024 }
          );
          logs = logOutput.split("\n").filter(Boolean);
        } catch { logs = this.logBuffer.slice(-tail); }

        let componentTree: unknown[] | undefined;
        if (options.includeDOM !== false && this.udid) {
          try {
            const xml = execSync(`xcrun simctl accessibility ${this.udid} snapshot 2>/dev/null`, {
              timeout: 10000, encoding: "utf-8", maxBuffer: 1024 * 1024,
            });
            componentTree = [{ iosAccessibility: xml.slice(0, 5000) }];
          } catch { componentTree = [{ iosAccessibility: "unavailable" }]; }
        }

        return { ok: true, data: { componentTree, logs, networkErrors: [], timestamp: new Date().toISOString() } };
      }

      // Android
      const logcatOutput = execSync(`adb logcat -d -t ${tail} *:E`, {
        timeout: 5000, encoding: "utf-8", maxBuffer: 1024 * 1024,
      });
      const logs = logcatOutput.split("\n").slice(-tail);

      let componentTree: unknown[] | undefined;
      if (options.includeDOM !== false) {
        try {
          const uixml = execSync("adb shell uiautomator dump /dev/tmp/ui.xml && adb shell cat /dev/tmp/ui.xml", {
            timeout: 10000, encoding: "utf-8", maxBuffer: 1024 * 1024,
          });
          componentTree = [{ uiautomatorXml: uixml.slice(0, 5000) }];
        } catch { componentTree = [{ uiautomator: "unavailable" }]; }
      }

      return { ok: true, data: { componentTree, logs, networkErrors: [], timestamp: new Date().toISOString() } };
    } catch (e) {
      return { ok: false, error: `Mobile state capture failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async executeInteraction(params: InteractionParams): Promise<{ ok: boolean; error?: string }> {
    if (!this.info) return { ok: false, error: "No target attached" };

    try {
      if (this.platform === "ios") {
        return this.executeIOSInteraction(params);
      }
      return this.executeAndroidInteraction(params);
    } catch (e) {
      return { ok: false, error: `Mobile interaction failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private async executeIOSInteraction(params: InteractionParams): Promise<{ ok: boolean; error?: string }> {
    if (!this.udid) return { ok: false, error: "No simulator UDID" };

    switch (params.action) {
      case "click": {
        if (params.coordinates) {
          execSync(`xcrun simctl tap ${this.udid} ${params.coordinates.x} ${params.coordinates.y}`, { timeout: 5000 });
        }
        return { ok: true };
      }
      case "type": {
        if (params.value) {
          const escaped = params.value.replace(/'/g, "'\\''");
          execSync(`xcrun simctl spawn ${this.udid} input text '${escaped}'`, { timeout: 5000 });
        }
        return { ok: true };
      }
      case "key_combination": {
        if (params.value) {
          const key = params.value.split("+").pop()?.trim().toLowerCase();
          if (key === "home") {
            execSync(`xcrun simctl spawn ${this.udid} input keyevent 3`, { timeout: 5000 });
          } else if (key === "lock" || key === "power") {
            execSync(`xcrun simctl spawn ${this.udid} input keyevent 26`, { timeout: 5000 });
          } else if (key === "volumeup") {
            execSync(`xcrun simctl spawn ${this.udid} input keyevent 24`, { timeout: 5000 });
          } else if (key === "volumedown") {
            execSync(`xcrun simctl spawn ${this.udid} input keyevent 25`, { timeout: 5000 });
          }
        }
        return { ok: true };
      }
      default:
        return { ok: false, error: `Action ${params.action} not supported on iOS` };
    }
  }

  private async executeAndroidInteraction(params: InteractionParams): Promise<{ ok: boolean; error?: string }> {
    try {
      switch (params.action) {
        case "click": {
          if (params.coordinates) {
            execSync(`adb shell input tap ${params.coordinates.x} ${params.coordinates.y}`, { timeout: 5000 });
          } else if (params.selector) {
            try {
              const uixml = execSync("adb shell uiautomator dump /dev/stdout", {
                timeout: 5000,
                encoding: "utf-8",
                maxBuffer: 1024 * 1024,
              });
              const boundsMatch = uixml.match(new RegExp(`resource-id="${params.selector}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
              if (boundsMatch) {
                const x = Math.round((parseInt(boundsMatch[1]) + parseInt(boundsMatch[3])) / 2);
                const y = Math.round((parseInt(boundsMatch[2]) + parseInt(boundsMatch[4])) / 2);
                execSync(`adb shell input tap ${x} ${y}`, { timeout: 5000 });
              } else {
                return { ok: false, error: `Element not found for selector: ${params.selector}` };
              }
            } catch (e) {
              return { ok: false, error: `Selector tap failed: ${e instanceof Error ? e.message : String(e)}` };
            }
          }
          return { ok: true };
        }
        case "type": {
          if (params.value) {
            const escaped = params.value
              .replace(/\\/g, "\\\\")
              .replace(/'/g, "'\\''")
              .replace(/[[\]]/g, "\\$&")
              .replace(/[(){}|;&<>$`!]/g, "\\$&");
            execSync(`adb shell input text '${escaped}'`, { timeout: 5000 });
          }
          return { ok: true };
        }
        case "scroll": {
          if (params.coordinates) {
            const { x, y } = params.coordinates;
            execSync(`adb shell input swipe ${x} ${y} ${x} ${Math.max(0, y - 500)} 300`, { timeout: 5000 });
          }
          return { ok: true };
        }
        case "key_combination": {
          if (params.value) {
            const keyMap: Record<string, string> = {
              enter: "66", back: "4", home: "3", menu: "82", power: "26",
              delete: "67", tab: "61", space: "62", escape: "111",
              up: "19", down: "20", left: "21", right: "22",
              pageup: "92", pagedown: "93",
            };
            const keys = params.value.split("+").map((k) => k.trim().toLowerCase());
            for (const key of keys) {
              const code = keyMap[key];
              if (code) {
                execSync(`adb shell input keyevent ${code}`, { timeout: 5000 });
              } else {
                return { ok: false, error: `Unknown key: ${key}. Supported: ${Object.keys(keyMap).join(", ")}` };
              }
            }
          }
          return { ok: true };
        }
        default:
          return { ok: false, error: `Action ${params.action} not supported on mobile` };
      }
    } catch (e) {
      return { ok: false, error: `Mobile interaction failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async applyHotfix(patch: HotfixPatch): Promise<{ ok: boolean; error?: string; result?: string }> {
    if (!this.info) return { ok: false, error: "No target attached" };
    return { ok: false, error: `Patch type ${patch.patchType} is not supported for mobile targets; use a source change instead.` };
  }

  getInfo(): DebugTargetInfo | null {
    return this.info;
  }

  isAttached(): boolean {
    return this.info !== null;
  }
}

// ─── Safety & Sandboxing ──────────────────────────────────────────────────────

function extractNetworkErrors(_perf: unknown): string[] {
  return [];
}

function computeModifierBits(mods: string[]): number {
  let bits = 0;
  if (mods.includes("ctrl") || mods.includes("control")) bits |= 1;
  if (mods.includes("alt") || mods.includes("option")) bits |= 2;
  if (mods.includes("shift")) bits |= 4;
  if (mods.includes("cmd") || mods.includes("command") || mods.includes("meta")) bits |= 8;
  return bits;
}

export interface SizeInfo {
  bytes: number;
}

export async function readFileSize(path: string): Promise<SizeInfo> {
  const { stat } = await import("fs/promises");
  const s = await stat(path);
  return { bytes: s.size };
}

export function checkIsInWorkspace(targetPath: string, workspacePath: string): boolean {
  const resolved = resolve(targetPath);
  const ws = resolve(workspacePath);
  return resolved.startsWith(ws);
}

export function checkIsDangerousCommand(command: string): string | null {
  const dangerous = [
    { pattern: /rm\s+-rf\s+\/\s*$/i, msg: "Refusing: rm -rf /" },
    { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, msg: "Refusing: fork bomb" },
    { pattern: /mkfs\./i, msg: "Refusing: filesystem format" },
    { pattern: /dd\s+if=.+\s+of=\/dev/i, msg: "Refusing: raw device write" },
    { pattern: /chmod\s+-R\s+0+\s+\//i, msg: "Refusing: permission wipe" },
  ];
  for (const { pattern, msg } of dangerous) {
    if (pattern.test(command)) return msg;
  }
  return null;
}

export function validateInteractionSafety(
  params: InteractionParams,
  bounds?: { x: number; y: number; width: number; height: number }
): string | null {
  if (params.coordinates && bounds) {
    const { x, y } = params.coordinates;
    if (
      x < bounds.x ||
      x > bounds.x + bounds.width ||
      y < bounds.y ||
      y > bounds.y + bounds.height
    ) {
      return `Interaction target (${x},${y}) is outside application bounds (${bounds.x},${bounds.y} ${bounds.width}x${bounds.height})`;
    }
  }
  return null;
}

export function validateHotfixSafety(
  patch: HotfixPatch,
  workspacePath?: string
): string | null {
  if (patch.patchType === "js_eval" || patch.patchType === "dom_mutate") {
    return `${patch.patchType} is not supported: arbitrary JavaScript is not a safe debug hotfix boundary.`;
  }
  if (patch.patchType === "env_override") {
    return "env_override is not supported: use an explicit, user-managed runtime configuration change instead.";
  }
  return null;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

export class DebugProvider {
  private adapters: Map<TargetType, DebugAdapter>;
  private currentAdapter: DebugAdapter | null = null;
  private safetyBoundary: SafetyBoundary = {};
  /** Serializes attachTarget so overlapping calls cannot race on the socket. */
  private attachChain: Promise<void> = Promise.resolve();

  constructor() {
    this.adapters = new Map<TargetType, DebugAdapter>([
      ["web", new WebDebugAdapter()],
      ["desktop", new DesktopDebugAdapter()],
      ["mobile", new MobileDebugAdapter()],
    ]);
  }

  get adapter(): DebugAdapter | null {
    return this.currentAdapter;
  }

  setSafetyBoundary(boundary: SafetyBoundary): void {
    this.safetyBoundary = boundary;
  }

  /**
   * Attaches run one at a time. Two overlapping attachTarget calls used to race
   * on the adapter's socket and both fail, leaving nothing attached — easy to
   * hit when a model emits two tool calls in the same round.
   */
  async attachTarget(params: AttachParams): Promise<{ ok: boolean; error?: string }> {
    const run = this.attachChain
      .catch(() => {})
      .then(() => this.attachTargetSerialized(params));
    this.attachChain = run.then(() => {}, () => {});
    return run;
  }

  private async attachTargetSerialized(params: AttachParams): Promise<{ ok: boolean; error?: string }> {
    if (this.currentAdapter?.isAttached()) {
      await this.currentAdapter.detach();
    }

    const adapter = this.adapters.get(params.targetType);
    if (!adapter) {
      return { ok: false, error: `Unknown target type: ${params.targetType}` };
    }

    const result = await adapter.attach(params);
    if (result.ok) {
      this.currentAdapter = adapter;
    }
    return result;
  }

  async detachTarget(): Promise<void> {
    if (this.currentAdapter) {
      await this.currentAdapter.detach();
      this.currentAdapter = null;
    }
  }

  async captureState(options: CaptureOptions = {}): Promise<{ ok: boolean; data?: DebugSnapshot; error?: string }> {
    if (!this.currentAdapter?.isAttached()) {
      return { ok: false, error: "No debug target attached. Call debug_attach_target first." };
    }
    return this.currentAdapter.captureState(options);
  }

  async executeInteraction(params: InteractionParams): Promise<{ ok: boolean; error?: string }> {
    if (!this.currentAdapter?.isAttached()) {
      return { ok: false, error: "No debug target attached. Call debug_attach_target first." };
    }

    const info = this.currentAdapter.getInfo();
    const safetyError = validateInteractionSafety(params, info?.windowBounds ?? this.safetyBoundary.windowBounds);
    if (safetyError) {
      return { ok: false, error: `[SAFETY] ${safetyError}` };
    }

    return this.currentAdapter.executeInteraction(params);
  }

  async applyHotfix(patch: HotfixPatch): Promise<{ ok: boolean; error?: string; result?: string }> {
    if (!this.currentAdapter?.isAttached()) {
      return { ok: false, error: "No debug target attached. Call debug_attach_target first." };
    }

    const safetyError = validateHotfixSafety(patch, this.safetyBoundary.workspacePath);
    if (safetyError) {
      return { ok: false, error: `[SAFETY] ${safetyError}` };
    }

    return this.currentAdapter.applyHotfix(patch);
  }

  getTargetInfo(): DebugTargetInfo | null {
    return this.currentAdapter?.getInfo() ?? null;
  }

  isAttached(): boolean {
    return this.currentAdapter?.isAttached() ?? false;
  }

  async verifyWorkspaceBeforeWrite(workspacePath: string): Promise<{ ok: boolean; error?: string; output?: string }> {
    if (!existsSync(workspacePath)) {
      return { ok: false, error: `Workspace path does not exist: ${workspacePath}` };
    }

    let testCommand: string | null = null;

    const packageJsonPath = resolve(workspacePath, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        if (pkg.scripts?.test && !pkg.scripts.test.includes('echo "Error: no test specified"')) {
          testCommand = "npm test";
        }
      } catch {}
    }

    if (!testCommand && existsSync(resolve(workspacePath, "Cargo.toml"))) {
      testCommand = "cargo test -- --quiet";
    }

    if (!testCommand && existsSync(resolve(workspacePath, "go.mod"))) {
      testCommand = "go test ./...";
    }

    if (!testCommand) {
      return { ok: true, output: "No test runner detected — skipping verification" };
    }

    try {
      const output = execSync(testCommand, {
        cwd: workspacePath,
        timeout: 60000,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });
      return { ok: true, output };
    } catch (e) {
      return { ok: false, error: `Tests failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────────

let _debugProvider: DebugProvider | null = null;

export function getDebugProvider(): DebugProvider {
  if (!_debugProvider) {
    _debugProvider = new DebugProvider();
  }
  return _debugProvider;
}

export function resetDebugProviderForTest(): void {
  _debugProvider = null;
}
