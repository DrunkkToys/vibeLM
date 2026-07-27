import { WebSocket } from "ws";
import { spawn, type ChildProcess } from "child_process";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TargetType = "web" | "desktop" | "mobile";
export type InteractionAction = "click" | "type" | "scroll" | "focus" | "key_combination";
export type PatchType = "js_eval" | "css_inject" | "dom_mutate" | "env_override";
export type PlatformOS = "darwin" | "win32" | "linux" | "android";

export interface DebugTargetInfo {
  targetType: TargetType;
  identifier: string;
  pid?: number;
  platform: PlatformOS;
  attachedAt: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
}

export interface CaptureOptions {
  includeDOM?: boolean;
  logTailLines?: number;
}

export interface DebugSnapshot {
  screenshot?: string;
  componentTree?: unknown[];
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

    if (url.startsWith("ws://") || url.startsWith("wss://")) {
      wsUrl = url;
    } else {
      const devtoolsUrl = await this.discoverCDPUrl(url, port);
      if (!devtoolsUrl) {
        return { ok: false, error: `Cannot discover CDP endpoint for ${url}. Ensure Chrome is running with --remote-debugging-port=${port}` };
      }
      wsUrl = devtoolsUrl;
    }

    try {
      this.ws = new WebSocket(wsUrl);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
        this.ws!.on("open", () => { clearTimeout(t); resolve(); });
        this.ws!.on("error", (e: Error) => { clearTimeout(t); reject(e); });
        this.ws!.on("message", (data: Buffer) => this.handleMessage(data.toString()));
      });

      const version = await this.cdpCommand("Browser.getVersion");
      this.info = {
        targetType: "web",
        identifier: url,
        platform: process.platform as PlatformOS,
        attachedAt: new Date().toISOString(),
      };

      await this.cdpCommand("Page.enable");
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

      let componentTree: unknown[] | undefined;
      if (options.includeDOM !== false) {
        const doc = await this.cdpCommand("DOM.getDocument", { depth: -1 });
        componentTree = [doc];
      }

      let networkErrors: string[] = [];
      try {
        const perf = await this.cdpCommand("Network.getPerformanceMetrics");
        networkErrors = extractNetworkErrors(perf);
      } catch {}

      let screenshotBase64: string | undefined;
      try {
        const shot = await this.cdpCommand("Page.captureScreenshot", { format: "png" });
        screenshotBase64 = (shot as any)?.data;
      } catch {}

      return {
        ok: true,
        data: {
          screenshot: screenshotBase64,
          componentTree,
          logs,
          networkErrors,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (e) {
      return { ok: false, error: `State capture failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async executeInteraction(params: InteractionParams): Promise<{ ok: boolean; error?: string }> {
    if (!this.ws) return { ok: false, error: "No target attached" };

    try {
      switch (params.action) {
        case "click": {
          if (params.selector) {
            await this.cdpCommand("Runtime.evaluate", {
              expression: `document.querySelector(${JSON.stringify(params.selector)})?.click()`,
            });
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
            await this.cdpCommand("Runtime.evaluate", {
              expression: `(() => { const el = document.querySelector(${JSON.stringify(params.selector)}); if (el) { el.value = ${JSON.stringify(params.value ?? "")}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } })()`,
            });
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
            await this.cdpCommand("Runtime.evaluate", {
              expression: `document.querySelector(${JSON.stringify(params.selector)})?.focus()`,
            });
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
          const result = await this.cdpCommand("Runtime.evaluate", {
            expression: patch.payload,
            returnByValue: true,
          });
          return { ok: true, result: JSON.stringify((result as any)?.result?.value ?? "(void)") };
        }
        case "css_inject": {
          const escaped = patch.payload.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
          await this.cdpCommand("Runtime.evaluate", {
            expression: `(function() { var s = document.createElement('style'); s.textContent = \`${escaped}\`; document.head.appendChild(s); })()`,
          });
          return { ok: true };
        }
        case "dom_mutate": {
          const result = await this.cdpCommand("Runtime.evaluate", {
            expression: `(function() { ${patch.payload} })()`,
            returnByValue: true,
          });
          return { ok: true, result: JSON.stringify((result as any)?.result?.value ?? "(void)") };
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

  private async discoverCDPUrl(pageUrl: string, port: number = 9222): Promise<string | null> {
    try {
      const resp = await fetch(`http://localhost:${port}/json`);
      if (!resp.ok) return null;
      const targets: Array<{ webSocketDebuggerUrl: string; url: string }> = await resp.json();
      const match = targets.find((t) => t.url.includes(pageUrl)) || targets[0];
      return match?.webSocketDebuggerUrl || null;
    } catch {
      return null;
    }
  }

  private cdpCommand(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("No WebSocket connection"));
      const id = ++this.messageId;
      this.pendingResponses.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
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
      if (msg.method === "Runtime.exceptionThrown") {
        this.logBuffer.push(`[exception] ${JSON.stringify(msg.params?.exceptionDetails ?? msg)}`);
      }
    } catch {}
  }

  private cleanup() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.pendingResponses.clear();
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
      });

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

  async detach(): Promise<void> {
    if (this.process) {
      this.process.kill("SIGTERM");
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
    try {
      if (os === "darwin") {
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

// ─── Mobile ADB Adapter (Android) ─────────────────────────────────────────────

class MobileDebugAdapter implements DebugAdapter {
  private info: DebugTargetInfo | null = null;
  private logBuffer: string[] = [];

  async attach(params: AttachParams): Promise<{ ok: boolean; error?: string }> {
    try {
      execSync("adb devices", { timeout: 5000, encoding: "utf-8" });
    } catch {
      return { ok: false, error: "adb not found or no device connected. Install Android platform tools and connect a device." };
    }

    const bundleId = params.identifier;

    try {
      execSync(`adb shell pm path ${bundleId}`, { timeout: 5000, encoding: "utf-8" });
    } catch {
      return { ok: false, error: `No device connected or package ${bundleId} not found. Check adb devices.` };
    }

    this.info = {
      targetType: "mobile",
      identifier: bundleId,
      platform: "android",
      attachedAt: new Date().toISOString(),
    };

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

      const logcatOutput = execSync(`adb logcat -d -t ${tail} *:E`, {
        timeout: 5000,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });
      const logs = logcatOutput.split("\n").slice(-tail);

      let componentTree: unknown[] | undefined;
      if (options.includeDOM !== false) {
        try {
          const uixml = execSync("adb shell uiautomator dump /dev/tmp/ui.xml && adb shell cat /dev/tmp/ui.xml", {
            timeout: 10000,
            encoding: "utf-8",
            maxBuffer: 1024 * 1024,
          });
          componentTree = [{ uiautomatorXml: uixml.slice(0, 5000) }];
        } catch {
          componentTree = [{ uiautomator: "unavailable" }];
        }
      }

      return {
        ok: true,
        data: {
          componentTree,
          logs,
          networkErrors: [],
          timestamp: new Date().toISOString(),
        },
      };
    } catch (e) {
      return { ok: false, error: `Mobile state capture failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async executeInteraction(params: InteractionParams): Promise<{ ok: boolean; error?: string }> {
    if (!this.info) return { ok: false, error: "No target attached" };

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

    switch (patch.patchType) {
      case "env_override": {
        try {
          const targetPkg = this.info.identifier;
          const key = patch.payload.split("=")[0];
          const value = patch.payload.split("=").slice(1).join("=");
          execSync(
            `adb shell am broadcast -a debug.setProperty --es key "${key}" --es value "${value}" -p ${targetPkg}`,
            { timeout: 5000 }
          );
          return { ok: true, result: `Environment override attempted: ${patch.payload}` };
        } catch (e) {
          return { ok: false, error: `env_override failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      default:
        return { ok: false, error: `Patch type ${patch.patchType} not supported for mobile targets` };
    }
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
  if (patch.patchType === "dom_mutate") {
    const dangerousPatterns = [
      /document\.cookie/i,
      /fetch\s*\(/i,
      /XMLHttpRequest/i,
      /localStorage\.clear/i,
      /indexedDB\.deleteDatabase/i,
    ];
    for (const p of dangerousPatterns) {
      if (p.test(patch.payload)) {
        return `Hotfix payload contains potentially dangerous operation: ${p.source}`;
      }
    }
  }
  if (patch.patchType === "env_override" && patch.payload.includes("=")) {
    const key = patch.payload.split("=")[0].trim();
    const sensitive = ["API_KEY", "SECRET", "PASSWORD", "TOKEN", "CREDENTIAL"];
    if (sensitive.some((s) => key.toUpperCase().includes(s))) {
      return `Refusing to override sensitive environment variable: ${key}`;
    }
  }
  return null;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

export class DebugProvider {
  private adapters: Map<TargetType, DebugAdapter>;
  private currentAdapter: DebugAdapter | null = null;
  private safetyBoundary: SafetyBoundary = {};

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

  async attachTarget(params: AttachParams): Promise<{ ok: boolean; error?: string }> {
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
