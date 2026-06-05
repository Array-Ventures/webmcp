---
name: webmcp
description: >-
  Detect whether a website exposes WebMCP browser tools and call them correctly.
  Use this whenever the user wants to check, probe, test, or interact with WebMCP
  (Web Model Context / navigator.modelContext) on a live site — e.g. "does render.com
  have webmcp tools", "list the webmcp tools on this page", "call the search tool on
  this site via webmcp", "try out webmcp on <url>", or any request to discover or
  invoke a page's agent-facing tools instead of clicking the DOM. Trigger even when
  the user just says "webmcp" and a URL, or asks why a site's tools aren't showing up.
---

# WebMCP

WebMCP lets a website register typed tools that an AI agent can call directly —
`navigator.modelContext.registerTool({ name, description, inputSchema, execute })` —
instead of the agent scraping the DOM and guessing which buttons do what. This skill
detects whether a given page exposes such tools and invokes them safely.

The whole value is: **the site hands you a schema and an execute function.** You don't
infer the UI, you call the tool. So the job here is small and mechanical — confirm the
tools exist, read their schemas, call the right one.

## The two browser APIs (know the difference)

A page that supports WebMCP exposes one or both of these globals:

- **`navigator.modelContext`** — the *page-facing* API. Sites use it to `registerTool` /
  `getTools` / `executeTool`. Always present when WebMCP is on.
- **`navigator.modelContextTesting`** — the *automation/testing* API, present when the
  user has enabled `chrome://flags/#enable-webmcp-testing`. Exposes `listTools()` and
  `executeTool(name, jsonString)`. This is the surface external agents drive.

Prefer `modelContextTesting` for listing/executing when it's available, and fall back to
`modelContext` otherwise. The detect snippet below handles both.

## Preconditions

WebMCP only works when **all** of these hold — check them first, because a "no tools"
result is almost always one of these rather than a bug:

- A **WebMCP-capable Chrome**: Chrome Canary/Beta (or recent Chromium) with
  `chrome://flags/#enable-webmcp-testing` enabled and relaunched.
- A **secure context**: the page is HTTPS or localhost. `window.isSecureContext` must be true.
- Tools may register **asynchronously** after load, or only on a specific route / after
  login. If the first probe is empty, wait a couple seconds and re-probe before concluding.

## Runtime: use the Playwright MCP if it's connected

When the Playwright MCP browser tools (`mcp__*__browser_navigate`, `browser_evaluate`,
`browser_console_messages`) are available and pointed at a WebMCP-capable Chrome, drive
the page directly — no separate process needed. That is the primary path.

If the MCP browser is not available, use the bundled fallback script (see
**Fallback runtime** below), which launches its own Chromium.

## Workflow

### 1. Navigate

Open the target URL with `browser_navigate`. Some demo pages hide their manual buttons
when WebMCP is supported (they expect an agent to drive them) — that's fine, you're not
using the buttons.

### 2. Detect + list (one shot)

Run this with `browser_evaluate`. It reports capability, lists imperative tools, and also
catches *declarative* tools (HTML form attributes) that don't show through the JS API:

```js
async () => {
  const mc  = navigator.modelContext;
  const mct = navigator.modelContextTesting;
  const out = {
    secureContext: window.isSecureContext,
    hasModelContext: !!mc,
    hasModelContextTesting: !!mct,
  };
  try {
    let tools = [];
    if (mct?.listTools)      tools = await mct.listTools();
    else if (mc?.getTools)   tools = await mc.getTools();
    out.tools = tools.map(t => ({
      name: t.name,
      description: t.description,
      kind: t.kind,                 // "read" | "write" | "action" when the site sets it
      annotations: t.annotations,   // e.g. { readOnlyHint: true }
      inputSchema: typeof t.inputSchema === 'string'
        ? JSON.parse(t.inputSchema) : t.inputSchema,
    }));
  } catch (e) { out.listError = String(e); }
  // Declarative tools register via HTML attributes — surface them even if JS list is empty
  out.declarativeTools = [...document.querySelectorAll('[toolname]')].map(el => ({
    name: el.getAttribute('toolname'),
    description: el.getAttribute('tooldescription'),
    tag: el.tagName.toLowerCase(),
    autosubmit: el.hasAttribute('toolautosubmit'),
  }));
  return out;
}
```

Interpreting the result:
- `hasModelContext` / `hasModelContextTesting` both false → this browser isn't WebMCP-capable
  (flag off, or not Canary/Beta), **or** the site genuinely has no WebMCP. Distinguish by
  checking the flag — if even render.com (a known WebMCP site) shows false, it's the browser.
- APIs present but `tools` empty and `declarativeTools` empty → see **When the list is empty**.
- Tools present → pick the one that answers the user and continue.

### 3. Inspect the schema before calling

Read the chosen tool's `inputSchema` (a JSON Schema). Build arguments that satisfy
`required` and `properties`. Don't invent fields — `additionalProperties` is often false and
the call will reject unknown keys.

### 4. Execute

```js
async () => {
  const mct = navigator.modelContextTesting;
  // IMPORTANT: the testing API wants arguments as a JSON STRING, not an object.
  const res = await mct.executeTool('TOOL_NAME', JSON.stringify({ /* args */ }));
  return typeof res === 'string' ? JSON.parse(res) : res;
}
```

A successful result is the standard MCP shape: `{ content: [{ type: "text", text }], structuredContent }`.
Read `structuredContent` when present (already parsed); otherwise parse `content[0].text`.

Report the result and any visible page change. If you drove a write/action tool, snapshot the
page so the user can see what changed.

## Safety: read first, ask before side effects

These tools can do real things — submit forms, add to cart, book, pay, authenticate. The
site labels intent two ways; treat both as signals:

- `kind`: `read` (safe to call freely), `write` (mutates page/app state), `action`
  (navigates, submits, purchases, authenticates).
- `annotations.readOnlyHint`: when true, safe.

Run **read / read-only tools freely** — that's discovery. For anything that looks like it
changes state, **confirm with the user before calling**, even if the site marks it `read`.
A name or description matching payment, checkout, purchase, buy, book, authenticate, login,
submit, confirm, order, delete, cancel, return, or review deserves a confirm regardless of
`kind` — sites mislabel, and an unwanted purchase is not recoverable with an apology. When in
doubt, list what you're about to do and the exact arguments, and let the user say go.

## When the list is empty

A WebMCP-enabled page that lists zero tools is the most common situation worth diagnosing.
Check, in order:

1. **Console errors** — `browser_console_messages` (level: error). The classic failure is the
   site calling `registerTool(tool, { exposedTo: ["http://localhost:8080", ...] })`. WebMCP
   requires every `exposedTo` origin to be HTTPS; one `http://` entry throws
   `SecurityError: Only HTTPS origins are allowed in exposedTo list`, and because the site's
   registration loop usually isn't wrapped in try/catch, that first throw aborts **all**
   registrations. That's a bug in the *site*, not your setup — report it as such.
2. **Timing / route** — re-probe after ~2s; tools may register late, or only on a sub-route,
   or only after login. Navigate to the specific page the tool lives on.
3. **Secure context** — `isSecureContext` false (plain HTTP) means tools can't register.
4. **Flag** — if `navigator.modelContext` itself is absent, the testing flag is off or the
   browser is too old; nothing the site does will help.

State *which* of these it was. "The site has no WebMCP" and "the site's registration crashed"
and "your flag is off" are very different answers.

## Fallback runtime (no MCP browser)

`scripts/webmcp-probe.mjs` launches its own Chromium and does the same detect/list/call. It
has no third-party dependencies and never contacts a directory service — it only ever talks to
the URL you give it.

```bash
node scripts/webmcp-probe.mjs detect <url>
node scripts/webmcp-probe.mjs list   <url>
node scripts/webmcp-probe.mjs call   <url> <tool> '{"query":"..."}'
node scripts/webmcp-probe.mjs call   <url> <tool> '{...}' --allow-side-effects
```

`call` runs unlabeled and read-only tools directly, and refuses only tools the site marks
`write`/`action` (or `readOnlyHint: false`) or whose name/description matches a side-effectful
verb, unless `--allow-side-effects` is passed — the same read-first posture as the MCP path. Bundled Chromium often lacks the WebMCP
flag; point at Canary/Beta with `WEBMCP_CHROME=/path/to/chrome --headed` when detection comes
back empty. See `references/webmcp-internals.md` for flags, the exact result shapes, and more
troubleshooting.
