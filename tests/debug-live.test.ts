/**
 * Live debug-loop tests against a REAL Chrome DevTools Protocol target.
 *
 * tests/debug-smoke.test.ts covers safety refusals and error paths; every one of
 * its web-adapter cases asserts *failure* against a port with no CDP server.
 * This suite is the opposite: it stands up an actual browser via Playwright and
 * drives vibeLM's WebDebugAdapter through the documented debugging loop
 * (capture -> interact -> hotfix -> re-capture), verifying each step against the
 * page through Playwright rather than trusting vibeLM's own `ok` flag.
 *
 * Skipped unless VIBE_LM_LIVE_DEBUG=1 so CI (no Chromium) stays green:
 *   VIBE_LM_LIVE_DEBUG=1 npm test
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

process.env.VIBE_LM_DATA_DIR = resolve(tmpdir(), `vibelm-debug-live-${Date.now()}`);

import { getDebugProvider, resetDebugProviderForTest } from "../src/debugProvider";
import { startCdpTarget, CDP_PORT, type CdpTarget } from "./helpers/cdp-target";

const LIVE = process.env.VIBE_LM_LIVE_DEBUG === "1";

describe("debug loop against a live CDP target", { skip: LIVE ? false : "set VIBE_LM_LIVE_DEBUG=1 to run" }, () => {
  let target: CdpTarget;

  before(async () => {
    target = await startCdpTarget();
    resetDebugProviderForTest();
  });

  after(async () => {
    await getDebugProvider().detachTarget().catch(() => {});
    if (target) await target.close();
  });

  it("A1: attaches to a real browser over CDP", async () => {
    const dp = getDebugProvider();
    const res = await dp.attachTarget({
      targetType: "web",
      identifier: target.url,
      cdpPort: CDP_PORT,
    });
    assert.equal(res.ok, true, `attach must succeed: ${res.error}`);
    assert.equal(dp.isAttached(), true, "isAttached must be true after a successful attach");

    const info = dp.getTargetInfo();
    assert(info, "must expose target info");
    assert.equal(info!.targetType, "web");
    assert.equal(info!.identifier, target.url);
  });

  it("A2: captures a real DOM tree from the live page", async () => {
    const dp = getDebugProvider();
    const res = await dp.captureState({ includeDOM: true, logTailLines: 100 });
    assert.equal(res.ok, true, `capture must succeed: ${res.error}`);

    const snap = res.data!;
    assert(Array.isArray(snap.componentTree), "componentTree must be present when includeDOM is true");
    assert(snap.timestamp, "snapshot must carry a timestamp");

    // The tree has to describe the actual fixture markup.
    const tree = JSON.stringify(snap.componentTree);
    assert.match(tree, /submit-btn/, "captured DOM must contain the fixture's #submit-btn");
    assert.match(tree, /username/, "captured DOM must contain the fixture's #username input");
  });

  it("A2b: captures a screenshot of the live page", async () => {
    const dp = getDebugProvider();
    const res = await dp.captureState({ includeDOM: false });
    assert.equal(res.ok, true, `capture must succeed: ${res.error}`);
    assert(res.data!.screenshot, "a live page must yield a screenshot");
    // Must decode to real PNG bytes.
    const png = Buffer.from(res.data!.screenshot!, "base64");
    assert(png.length > 1000, `screenshot must be non-trivial, got ${png.length} bytes`);
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", "must decode to a PNG");
  });

  it("A3: types into a real input (verified by Playwright)", async () => {
    const dp = getDebugProvider();
    assert.equal(await target.page.inputValue("#username"), "", "precondition: input starts empty");

    const res = await dp.executeInteraction({
      action: "type",
      selector: "#username",
      value: "tester",
    });
    assert.equal(res.ok, true, `type must succeed: ${res.error}`);

    // ORACLE: Playwright reads the same page independently.
    assert.equal(
      await target.page.inputValue("#username"),
      "tester",
      "the live page must actually show the typed value"
    );
  });

  it("A4: clicks a real button (verified by Playwright)", async () => {
    const dp = getDebugProvider();
    const before = Number(await target.page.textContent("#clicks"));

    const res = await dp.executeInteraction({ action: "click", selector: "#safe-btn" });
    assert.equal(res.ok, true, `click must succeed: ${res.error}`);

    await target.page.waitForTimeout(150);
    const after = Number(await target.page.textContent("#clicks"));
    assert.equal(after, before + 1, "the click must have a real effect on the page");
  });

  it("A4b: clicking the faulty button surfaces the page's exception in the capture", async () => {
    const dp = getDebugProvider();
    await dp.executeInteraction({ action: "click", selector: "#submit-btn" });
    await target.page.waitForTimeout(300);

    const res = await dp.captureState({ includeDOM: false, logTailLines: 200 });
    assert.equal(res.ok, true, `capture must succeed: ${res.error}`);

    const logs = res.data!.logs.join("\n");
    assert.match(
      logs,
      /VIBELM_FIXTURE_SUBMIT_FAILURE/,
      "the debugger must surface the exception thrown by the click it just performed"
    );
  });

  it("A5: css_inject hotfix changes the live page (verified by Playwright)", async () => {
    const dp = getDebugProvider();
    assert.equal(await target.page.isVisible("#result"), false, "precondition: #result is hidden");

    const res = await dp.applyHotfix({
      patchType: "css_inject",
      payload: "#result { display: block !important; }",
    });
    assert.equal(res.ok, true, `css_inject must succeed: ${res.error}`);

    await target.page.waitForTimeout(150);
    // ORACLE
    assert.equal(
      await target.page.isVisible("#result"),
      true,
      "the hotfix must actually reveal #result on the live page"
    );
  });

  it("A6: re-capture after the hotfix reflects the new state", async () => {
    const dp = getDebugProvider();
    const res = await dp.captureState({ includeDOM: true });
    assert.equal(res.ok, true, `re-capture must succeed: ${res.error}`);
    const tree = JSON.stringify(res.data!.componentTree);
    assert.match(tree, /result/, "post-hotfix capture must still describe the page");
  });

  it("A7: js_eval / dom_mutate / env_override are refused with actionable errors", async () => {
    const dp = getDebugProvider();
    for (const patchType of ["js_eval", "dom_mutate", "env_override"] as const) {
      const res = await dp.applyHotfix({ patchType, payload: "1+1" });
      assert.equal(res.ok, false, `${patchType} must be refused even on a live target`);
      assert(res.error, `${patchType} refusal must carry an error message`);
      assert.match(
        res.error!,
        /not supported/i,
        `${patchType} refusal must say it is unsupported, so the model stops retrying`
      );
    }
  });

  it("A8: detaches cleanly", async () => {
    const dp = getDebugProvider();
    await dp.detachTarget();
    assert.equal(dp.isAttached(), false, "must not be attached after detach");

    const after = await dp.captureState();
    assert.equal(after.ok, false, "capture after detach must fail rather than hang");
    assert.match(after.error!, /no.*target/i);
  });

  it("A9: commands against a dead target fail fast instead of hanging", async () => {
    resetDebugProviderForTest();
    const dp2 = getDebugProvider();

    const attached = await dp2.attachTarget({
      targetType: "web",
      identifier: target.url,
      cdpPort: CDP_PORT,
    });
    assert.equal(attached.ok, true, `attach must succeed: ${attached.error}`);

    // Kill the browser out from under the debugger.
    await target.browser.close();

    const started = Date.now();
    const res = await Promise.race([
      dp2.captureState({ includeDOM: true }),
      new Promise<{ ok: boolean; error?: string }>((r) =>
        setTimeout(() => r({ ok: false, error: "__TEST_TIMEOUT__" }), 12_000)
      ),
    ]);
    const elapsed = Date.now() - started;

    assert.notEqual(
      res.error,
      "__TEST_TIMEOUT__",
      `captureState hung for ${elapsed}ms against a dead CDP target — it must reject, not hang forever`
    );
    assert.equal(res.ok, false, "capture against a dead target must report failure");
  });
});
