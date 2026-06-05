#!/usr/bin/env node
// Fallback WebMCP runtime for when the Playwright MCP browser isn't available.
// Launches its own Chromium, then detects / lists / calls a page's WebMCP tools.
// It only ever contacts the URL you pass — no directory, telemetry, or third-party calls.

const SENSITIVE = /\b(authenticate|login|sign[- ]?in|checkout|pay|payment|purchase|buy|book|booking|submit|confirm|order|delete|cancel|return|review)\b/i;

function usage() {
  console.error(`WebMCP probe — detect and use a page's WebMCP tools.

Usage:
  node webmcp-probe.mjs detect <url>
  node webmcp-probe.mjs list   <url>
  node webmcp-probe.mjs call   <url> <tool> '<json-args>' [--allow-side-effects]

Options:
  --headed                Show the browser window (needed with an external flagged Chrome).
  --chrome <path>         Chrome/Chromium executable. Also reads WEBMCP_CHROME.
  --wait-ms <n>           Extra wait after load for late tool registration (default 2500).
  --timeout-ms <n>        Navigation/page timeout (default 15000).
  --allow-side-effects    Permit calling non-"read" or sensitive-named tools.
  --json                  Machine-readable output only.

If detect reports both APIs false on a site you know is WebMCP-enabled, the launched
Chromium lacks the flag — point at Canary/Beta:
  WEBMCP_CHROME="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \\
    node webmcp-probe.mjs detect https://render.com --headed`);
}

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    if (["--headed", "--allow-side-effects", "--json"].includes(a)) flags.set(a, true);
    else { flags.set(a, argv[i + 1]); i += 1; }
  }
  return { positional, flags };
}

function num(flags, name, fallback) {
  const v = flags.get(name);
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

async function importPlaywright() {
  try { return await import("playwright"); }
  catch (e) {
    throw new Error(`Playwright not installed. Run "npm i playwright && npx playwright install chromium". (${e.message})`);
  }
}

async function openPage(url, flags) {
  const { chromium } = await importPlaywright();
  const timeoutMs = num(flags, "--timeout-ms", 15000);
  const waitMs = num(flags, "--wait-ms", 2500);
  const executablePath = flags.get("--chrome") || process.env.WEBMCP_CHROME || undefined;

  const browser = await chromium.launch({
    headless: !flags.get("--headed"),
    executablePath,
    args: [
      "--enable-experimental-web-platform-features",
      "--enable-features=WebModelContext,WebMCPTesting",
    ],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 8000) }).catch(() => {});
  if (waitMs > 0) await page.waitForTimeout(waitMs);
  return { browser, page };
}

const consoleErrors = [];

// Runs in the page. Mirrors the detect snippet in SKILL.md.
async function detectInPage() {
  const mc = navigator.modelContext;
  const mct = navigator.modelContextTesting;
  const out = {
    href: location.href,
    secureContext: window.isSecureContext,
    hasModelContext: !!mc,
    hasModelContextTesting: !!mct,
  };
  try {
    let tools = [];
    if (mct && mct.listTools) tools = await mct.listTools();
    else if (mc && mc.getTools) tools = await mc.getTools();
    out.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      kind: t.kind,
      annotations: t.annotations,
      inputSchema: typeof t.inputSchema === "string" ? JSON.parse(t.inputSchema) : t.inputSchema,
    }));
  } catch (e) { out.listError = String(e); out.tools = []; }
  out.declarativeTools = [...document.querySelectorAll("[toolname]")].map((el) => ({
    name: el.getAttribute("toolname"),
    description: el.getAttribute("tooldescription"),
    tag: el.tagName.toLowerCase(),
    autosubmit: el.hasAttribute("toolautosubmit"),
  }));
  return out;
}

async function callInPage(page, name, args) {
  return page.evaluate(async ({ name, args }) => {
    const mct = navigator.modelContextTesting;
    const mc = navigator.modelContext;
    // Prefer the testing API, which requires arguments as a JSON string.
    const exec = mct?.executeTool ? mct.executeTool.bind(mct)
      : mc?.executeTool ? mc.executeTool.bind(mc) : null;
    if (!exec) throw new Error("No executeTool on navigator.modelContext(Testing).");
    const raw = await exec(name, JSON.stringify(args));
    try { return typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch { return raw; }
  }, { name, args });
}

// Decide whether a tool needs explicit user opt-in. Most real tools set neither `kind`
// nor `annotations`, so an unlabeled tool is treated as callable — the caller already
// chose it by name. We only block what is *positively* dangerous: a write/action kind,
// a readOnlyHint of false, or a name/description matching a side-effectful verb.
export function gateSideEffects(tool, name, flags) {
  if (flags.get("--allow-side-effects")) return;
  const kind = tool?.kind;
  const declaredMutating = kind === "write" || kind === "action"
    || tool?.annotations?.readOnlyHint === false;
  // Tool names are usually snake_case/kebab-case (book_table, add-to-cart), and "_" is a
  // word character, so a raw \b regex misses the verb. Split identifier separators into
  // spaces first so "book_table" -> "book table" and the boundary matches.
  const haystack = `${name} ${tool?.description ?? ""}`.replace(/[_\-.]+/g, " ");
  const sensitive = SENSITIVE.test(haystack);
  if (declaredMutating || sensitive) {
    const why = declaredMutating ? `kind="${kind ?? "non-read"}"` : "sensitive name/description";
    throw new Error(`Refusing to call "${name}" (${why}) without --allow-side-effects.`);
  }
}

function print(obj, flags) {
  console.log(JSON.stringify(obj, flags.get("--json") ? undefined : null, flags.get("--json") ? 0 : 2));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, url, tool, rawArgs] = positional;

  if (!command || command === "-h" || command === "--help") { usage(); process.exit(command ? 0 : 1); }
  if (!url || !/^https?:\/\//i.test(url)) { usage(); throw new Error("A full http(s) URL is required."); }

  const { browser, page } = await openPage(url, flags);
  try {
    const state = await page.evaluate(detectInPage);
    state.consoleErrors = consoleErrors;

    if (command === "detect" || command === "list") {
      print({ ok: !!(state.tools?.length || state.declarativeTools?.length), ...state }, flags);
      return;
    }

    if (command === "call") {
      if (!tool) { usage(); throw new Error("Tool name required for call."); }
      let args = {};
      if (rawArgs != null) {
        try { args = JSON.parse(rawArgs); }
        catch (e) { throw new Error(`Invalid JSON arguments: ${e.message}`); }
      }
      const def = (state.tools || []).find((t) => t.name === tool);
      if (!def && !(state.declarativeTools || []).some((t) => t.name === tool)) {
        throw new Error(`Page does not list a WebMCP tool named "${tool}". Available: ${
          (state.tools || []).map((t) => t.name).join(", ") || "(none)"}`);
      }
      gateSideEffects(def, tool, flags);
      const result = await callInPage(page, tool, args);
      print({ ok: true, tool, args, kind: def?.kind, result }, flags);
      return;
    }

    usage();
    throw new Error(`Unknown command: ${command}`);
  } finally {
    await browser.close();
  }
}

// Run only when invoked directly, so the module can be imported in tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
