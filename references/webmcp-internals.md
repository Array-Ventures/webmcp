# WebMCP internals & troubleshooting

Read this when the basic detect/list/call flow in SKILL.md isn't enough — empty lists,
`executeTool` rejections, declarative-only sites, or setting up the fallback runtime.

## Contents
- [API surface](#api-surface)
- [Tool object shape](#tool-object-shape)
- [executeTool argument encoding](#executetool-argument-encoding)
- [Result shape](#result-shape)
- [Declarative tools](#declarative-tools)
- [Enabling WebMCP in Chrome](#enabling-webmcp-in-chrome)
- [Fallback script: flags & options](#fallback-script-flags--options)
- [Failure modes](#failure-modes)

## API surface

| Global | Audience | Key methods |
|---|---|---|
| `navigator.modelContext` | the page (and you, as fallback) | `registerTool(tool, opts?)`, `getTools()`, `executeTool(name, args)`, `ontoolchange` |
| `navigator.modelContextTesting` | external automation (needs the testing flag) | `listTools()`, `executeTool(name, jsonString)`, `getCrossDocumentScriptToolResult()`, `addEventListener('toolchange')` |

Both can list and execute. The practical differences observed in the field:
- `modelContextTesting.executeTool` requires arguments as a **JSON string**.
- `modelContext.getTools()` and `modelContextTesting.listTools()` both return the same tool
  objects; `inputSchema` may come back as a JSON string and need parsing.
- `ontoolchange` / the `toolchange` event fire when the page adds/removes tools at runtime —
  useful if tools register after an interaction.

## Tool object shape

```jsonc
{
  "name": "render.docs.search",
  "description": "Search Render documentation by keyword.",
  "kind": "read",                  // optional: "read" | "write" | "action"
  "annotations": { "readOnlyHint": true },  // optional
  "inputSchema": {                 // JSON Schema; may arrive as a string
    "type": "object",
    "properties": { "query": { "type": "string", "description": "Keywords." } },
    "required": ["query"],
    "additionalProperties": false
  }
}
```

`additionalProperties: false` is common — passing keys not in `properties` makes the call fail.

## executeTool argument encoding

The single most common execution error:

```js
// ❌ object -> "UnknownError: Failed to parse input arguments"
await navigator.modelContextTesting.executeTool('render.docs.search', { query: 'workers' });

// ✅ JSON string
await navigator.modelContextTesting.executeTool('render.docs.search', JSON.stringify({ query: 'workers' }));
```

If you see `Failed to parse input arguments`, you almost certainly passed an object instead of
a string. If you see a schema/validation error instead, re-read `required` and the property
types in `inputSchema`.

## Result shape

Standard MCP tool result, usually delivered as a JSON string:

```jsonc
{
  "content": [{ "type": "text", "text": "{...}" }],   // text is often itself JSON
  "structuredContent": { "query": "workers", "results": [ /* ... */ ] }
}
```

Prefer `structuredContent` (already parsed). Otherwise `JSON.parse(content[0].text)`.

## Declarative tools

Sites using the declarative API don't call `registerTool`; they annotate HTML, typically a
form:

```html
<form toolname="book_table" tooldescription="Create a dining reservation." toolautosubmit>
  <input name="name" required toolparamdescription="Full name (min 2 chars)" />
  <input type="date" name="date" required toolparamdescription="YYYY-MM-DD" />
</form>
```

The browser turns these into tools, so they usually still appear in `listTools()`. But if the
JS list is empty, scan the DOM for `[toolname]` (the detect snippet in SKILL.md does this) to
tell "no WebMCP at all" apart from "declarative tools the JS API didn't surface." Each
`[toolname]` element is one tool; its `[toolparamdescription]` inputs are the parameters;
`toolautosubmit` means it submits without a confirmation step — treat those as `action`.

## Enabling WebMCP in Chrome

1. Use Chrome Canary or Beta (most reliable while the API is experimental), or a recent Chromium.
2. Visit `chrome://flags/#enable-webmcp-testing`, set it to **Enabled**.
3. Relaunch Chrome.
4. Confirm on a known-good site (e.g. `https://render.com`): the detect snippet should report
   `hasModelContextTesting: true` and a non-empty `tools` array.

The page must be a secure context (HTTPS or `localhost`). Plain `http://` will not register tools.

## Fallback script: flags & options

`scripts/webmcp-probe.mjs` launches Chromium with:

```
--enable-experimental-web-platform-features
--enable-features=WebModelContext,WebMCPTesting
```

These may be insufficient for a given Chromium build. When `detect` comes back with both APIs
false on a site you know is WebMCP-enabled, point the script at Canary/Beta and run headed:

```bash
WEBMCP_CHROME="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
  node scripts/webmcp-probe.mjs detect https://render.com --headed
```

Options:
- `--headed` — show the window (needed when a flagged external Chrome is required).
- `--chrome <path>` — Chrome executable; same effect as `WEBMCP_CHROME`.
- `--wait-ms <n>` — extra wait after load for late tool registration (default 2500).
- `--timeout-ms <n>` — navigation/page timeout (default 15000).
- `--allow-side-effects` — permit calling non-`read` or sensitive-named tools.
- `--json` — machine-readable output only.

Requires `playwright` (`npm i playwright` / `npx playwright install chromium`). The script
contacts only the URL you pass — no analytics, no directory, no telemetry.

## Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| Both APIs false on a known WebMCP site | testing flag off / browser too old | enable flag, use Canary/Beta |
| APIs present, `tools` empty, console `SecurityError ... exposedTo` | site passed `http://` origins to `registerTool`; first throw aborts all registrations | report as a site bug; not fixable from the agent side |
| APIs present, `tools` empty, no console error | late registration, sub-route, or login-gated | re-probe after `--wait-ms`, navigate to the tool's page, or sign in |
| `tools` empty but `[toolname]` elements exist | declarative tools not surfaced by the JS list | use the declarative metadata; for the fallback, submit the form fields |
| `executeTool` → `Failed to parse input arguments` | passed an object | pass `JSON.stringify(args)` |
| `executeTool` → validation error | args don't match `inputSchema` | satisfy `required`, drop unknown keys |
| `isSecureContext` false | page served over plain HTTP | only HTTPS/localhost can register tools |
