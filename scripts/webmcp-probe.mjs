#!/usr/bin/env node
// webmcp-probe — point it at a URL, get one JSON report of the page's WebMCP surface.
// Optionally invoke a single tool with --call. Contacts only the URL you pass: no
// directory lookups, no telemetry. Fallback for when no Playwright/MCP browser is wired in.
//
//   node webmcp-probe.mjs <url>
//   node webmcp-probe.mjs <url> --call render.docs.search --args '{"query":"workers"}'
//
// Run `node webmcp-probe.mjs --help` for the flag list.

import { parseArgs } from "node:util";

const HELP = `webmcp-probe — inspect a page's WebMCP tools, and optionally call one.

  node webmcp-probe.mjs <url>                                  inspect only
  node webmcp-probe.mjs <url> --call <tool> --args '<json>'    inspect, then run <tool>

Flags
  --call <name>     Tool to invoke after inspecting.
  --args <json>     JSON object for --call (default "{}").
  --write           Permit --call on a tool the site labels write/action.
  --chrome <path>   Browser binary (or env WEBMCP_CHROME). Use Canary/Beta when the
                    bundled Chromium doesn't expose WebMCP.
  --headed          Show the window.
  --wait <ms>       Settle time after load for late registration (default 2500).
  --timeout <ms>    Navigation timeout (default 15000).
  -h, --help

Output is a single JSON object on stdout. The site's own \`kind\`/\`readOnlyHint\` labels
gate writes; judging unlabeled-but-sensitive tools is the caller's job.`;

const die = (m) => { console.error(m); process.exit(1); };

// Classify a tool purely by what the SITE declares — no name guessing here.
export function toolSideEffects(tool) {
  const k = tool?.kind;
  const writes = k === "write" || k === "action" || tool?.annotations?.readOnlyHint === false;
  const reads = k === "read" || tool?.annotations?.readOnlyHint === true;
  return writes ? "writes" : reads ? "reads" : "unlabeled";
}

// --- everything below runs only when executed directly (keeps the module importable for tests) ---
if (import.meta.url === `file://${process.argv[1]}`) await main();

async function main() {
  let opt, rest;
  try {
    ({ values: opt, positionals: rest } = parseArgs({
      allowPositionals: true,
      options: {
        call:    { type: "string" },
        args:    { type: "string", default: "{}" },
        write:   { type: "boolean", default: false },
        chrome:  { type: "string" },
        headed:  { type: "boolean", default: false },
        wait:    { type: "string", default: "2500" },
        timeout: { type: "string", default: "15000" },
        help:    { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) { die(`${e.message}\n\n${HELP}`); }

  const url = rest[0];
  if (opt.help || !url) { console.log(HELP); process.exit(opt.help ? 0 : 1); }
  if (!/^https?:\/\//i.test(url)) die("First argument must be a full http(s) URL.");

  let callArgs = {};
  if (opt.call !== undefined) {
    try { callArgs = JSON.parse(opt.args); }
    catch (e) { die(`--args is not valid JSON: ${e.message}`); }
  }

  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { die('Playwright not found. Install it: npm i playwright && npx playwright install chromium'); }

  const browser = await chromium.launch({
    headless: !opt.headed,
    executablePath: opt.chrome ?? process.env.WEBMCP_CHROME ?? undefined,
    // The pair of switches that light up the experimental WebMCP surface in Chromium.
    args: ["--enable-experimental-web-platform-features", "--enable-features=WebModelContext,WebMCPTesting"],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(Number(opt.timeout));
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: Number(opt.timeout) });
    await page.waitForLoadState("networkidle", { timeout: Math.min(Number(opt.timeout), 8000) }).catch(() => {});
    if (Number(opt.wait) > 0) await page.waitForTimeout(Number(opt.wait));

    const report = await page.evaluate(pageInspect);
    report.url = page.url();
    report.consoleErrors = consoleErrors;

    if (opt.call !== undefined) {
      report.call = await invoke(page, opt.call, callArgs, opt.write, report);
    }
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } finally {
    await browser.close();
  }
}

async function invoke(page, name, args, allowWrite, report) {
  const known = [...report.tools, ...report.declarativeTools].find((t) => t.name === name);
  if (!known) {
    die(`Page lists no WebMCP tool named "${name}". Present: ${
      report.tools.map((t) => t.name).join(", ") || "(none)"}`);
  }
  const effect = toolSideEffects(known);
  if (effect === "writes" && !allowWrite) {
    die(`"${name}" is labeled ${known.kind ?? "write/action"} by the site. Pass --write to run it.`);
  }
  if (effect === "unlabeled") {
    console.error(`note: "${name}" carries no read-only guarantee from the site — make sure it isn't a side-effectful action before trusting it.`);
  }
  const result = await page.evaluate(async ({ name, args }) => {
    const api = navigator.modelContextTesting ?? navigator.modelContext;
    if (!api?.executeTool) throw new Error("executeTool is not available on this page.");
    // executeTool wants the arguments serialized, not as a live object.
    const raw = await api.executeTool(name, JSON.stringify(args));
    try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return raw; }
  }, { name, args });
  return { tool: name, declared: effect, args, result };
}

// Runs in the page context. Returns capability + registered tools + declarative tools.
async function pageInspect() {
  const mc = navigator.modelContext;
  const mct = navigator.modelContextTesting;
  const lister = mct?.listTools ? mct.listTools.bind(mct)
    : mc?.getTools ? mc.getTools.bind(mc) : null;

  const report = {
    secureContext: window.isSecureContext,
    apis: { modelContext: !!mc, modelContextTesting: !!mct },
    tools: [],
    declarativeTools: [],
  };

  if (lister) {
    try {
      for (const t of await lister()) {
        report.tools.push({
          name: t.name,
          description: t.description,
          kind: t.kind,
          annotations: t.annotations,
          inputSchema: typeof t.inputSchema === "string" ? JSON.parse(t.inputSchema) : t.inputSchema,
        });
      }
    } catch (e) { report.listError = String(e); }
  }

  // Declarative tools live as HTML attributes; surface them so an empty JS list
  // can be told apart from "this site has no WebMCP at all".
  for (const el of document.querySelectorAll("[toolname]")) {
    report.declarativeTools.push({
      name: el.getAttribute("toolname"),
      description: el.getAttribute("tooldescription"),
      element: el.tagName.toLowerCase(),
      autosubmit: el.hasAttribute("toolautosubmit"),
    });
  }
  return report;
}
