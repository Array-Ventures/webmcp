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

A WebMCP site advertises typed, callable tools to an agent through the browser —
`navigator.modelContext.registerTool({ name, description, inputSchema, execute })`. Instead of
reading the page and guessing which button submits a search, you ask the page for its tools and
call the one you want. This skill is the consumer side of that: find the tools on a page, read
their schemas, invoke the right one.

Because the page does the hard part, your job is short and mechanical — **one probe to see
what's there, one call to use it.** Most of the judgment is in reading the result correctly,
which is what the rest of this file is about.

## Two globals, two roles

WebMCP shows up as up to two objects on a supported page:

- `navigator.modelContext` — the **page's** API. Sites register tools through it; you can also
  read (`getTools`) and run (`executeTool`) through it.
- `navigator.modelContextTesting` — the **automation** API, present once
  `chrome://flags/#enable-webmcp-testing` is on. It exposes `listTools()` and
  `executeTool(name, jsonString)` and is the surface external agents drive.

When both exist, read and execute through `modelContextTesting`; fall back to `modelContext`
otherwise. The probe below does exactly that.

## Probe the page (this is the whole detection)

With a Playwright/MCP browser connected to a WebMCP-capable Chrome, run this once via
`browser_evaluate`. It reports capability, the registered tools with parsed schemas, and any
declarative tools — in a single round trip:

```js
async () => {
  const mc  = navigator.modelContext;
  const mct = navigator.modelContextTesting;
  const list = mct?.listTools ? mct.listTools.bind(mct)
             : mc?.getTools  ? mc.getTools.bind(mc) : null;
  const r = {
    secureContext: window.isSecureContext,
    apis: { modelContext: !!mc, modelContextTesting: !!mct },
    tools: [],
    declarative: [],
  };
  if (list) {
    try {
      for (const t of await list()) r.tools.push({
        name: t.name,
        description: t.description,
        kind: t.kind,                 // "read" | "write" | "action" when the site sets it
        annotations: t.annotations,   // e.g. { readOnlyHint: true }
        inputSchema: typeof t.inputSchema === 'string' ? JSON.parse(t.inputSchema) : t.inputSchema,
      });
    } catch (e) { r.listError = String(e); }
  }
  // Declarative tools are HTML attributes, not JS registrations — catch them too.
  for (const el of document.querySelectorAll('[toolname]')) r.declarative.push({
    name: el.getAttribute('toolname'),
    description: el.getAttribute('tooldescription'),
  });
  return r;
}
```

If no MCP browser is wired in, the bundled `scripts/webmcp-probe.mjs` does the same thing from
its own Chromium (see the last section).

## Read the result before you answer

| What the probe shows | What it means |
|---|---|
| both `apis` false | This Chrome isn't WebMCP-capable (flag off / too old) **or** the site truly has none. Re-check on a site you know is enabled, e.g. `render.com`, to tell which. |
| APIs present, `tools` non-empty | You have your answer — pick the tool that fits and call it. |
| APIs present, everything empty | Don't conclude "no tools" yet — see **An empty list is a clue, not an answer**. |
| `tools` empty but `declarative` non-empty | The page uses the HTML/form API; its tools are real, just not JS-registered. |

A common wrong turn: calling only `navigator.modelContext.getTools()` and treating an empty
return as proof the site has nothing. The testing API often lists tools the page-facing call
won't — that's why the probe prefers `listTools()`.

## Call a tool

Read the chosen tool's `inputSchema` (plain JSON Schema) and build arguments that satisfy
`required`; don't add keys outside `properties`, since `additionalProperties` is usually false.

```js
async () => {
  const api = navigator.modelContextTesting ?? navigator.modelContext;
  // The arguments go in as a JSON STRING, not a live object — this trips up almost everyone.
  const out = await api.executeTool('TOOL_NAME', JSON.stringify({ /* args */ }));
  return typeof out === 'string' ? JSON.parse(out) : out;
}
```

Results come back in MCP shape: `{ content: [{ type: 'text', text }], structuredContent }`. Use
`structuredContent` when it's there (already parsed); otherwise parse `content[0].text`. If you
get `Failed to parse input arguments`, you passed an object instead of a string.

## An empty list is a clue, not an answer

A WebMCP page that returns zero tools is the case most worth getting right, because the honest
answers ("the site has none", "the site's registration crashed", "your flag is off") are wildly
different. Work through these:

1. **Read the console** (`browser_console_messages`, level `error`). The signature failure is a
   site that calls `registerTool(tool, { exposedTo: ["http://localhost:8080", …] })`. WebMCP
   rejects any non-HTTPS `exposedTo` origin with `SecurityError: Only HTTPS origins are allowed
   in exposedTo list`, and since the site's registration loop usually has no try/catch, that
   first throw skips **every** remaining tool. The page looks WebMCP-aware and lists nothing —
   and it's the *site's* bug, not your setup.
2. **Give it a beat, or change route.** Re-probe after a couple seconds; tools can register late,
   or only on a specific page, or only once signed in. Go to where the tool would live.
3. **Confirm the context.** `secureContext` false means plain HTTP — tools can't register at all.
4. **Confirm the flag.** If `navigator.modelContext` itself is missing, the testing flag is off
   or the browser is too old; nothing the site does will surface tools.

Name which one it was. That precision is the actual deliverable.

## Acting on the user's behalf

Reading a page's data through a `read` tool is free to do — that's discovery. But a tool can also
*act*: change app state, submit a form, place a booking, move money, sign in. Before running
anything in that category, lay out what you're about to do and the exact arguments, and let the
user approve it.

Lean on two signals the site provides — `kind` (`read` vs `write`/`action`) and
`annotations.readOnlyHint` — but don't trust them blindly. Sites mislabel, and an unwanted
checkout isn't undone by an apology, so when a tool's name or description points at something
irreversible or money-moving, confirm even if it's tagged `read`. Default to asking whenever
you're unsure; the cost of a needless confirm is a sentence, the cost of a wrong action isn't.

## No MCP browser? Use the bundled script

`scripts/webmcp-probe.mjs` launches its own Chromium and prints one JSON report. It never
contacts anything but the URL you give it.

```bash
node scripts/webmcp-probe.mjs https://render.com
node scripts/webmcp-probe.mjs https://render.com --call render.docs.search --args '{"query":"background worker"}'
```

It runs read and unlabeled tools as-is and requires `--write` only for tools the site itself
labels `write`/`action` — the side-effect judgment for unlabeled-but-sensitive tools stays with
you, per the section above. When the bundled Chromium doesn't expose WebMCP, point at
Canary/Beta: `WEBMCP_CHROME=/path/to/canary node scripts/webmcp-probe.mjs <url> --headed`.

For the full API shapes, schema details, and a failure-mode table, read
`references/webmcp-internals.md`.
