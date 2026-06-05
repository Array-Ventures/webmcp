# webmcp — agent skill

Detect whether a website exposes **WebMCP** (Web Model Context / `navigator.modelContext`)
browser tools, and call them correctly — instead of scraping the DOM and guessing which
button does what.

WebMCP lets a site register typed, agent-callable tools
(`navigator.modelContext.registerTool({ name, description, inputSchema, execute })`). This
skill teaches your coding agent to find those tools on any page, read their schemas, and
invoke them safely.

## Install

```bash
npx skills add Array-Ventures/webmcp
```

This installs the skill into your agent's config (Claude Code, Cursor, and other
`SKILL.md`-compatible agents). List or remove it later with `npx skills ls` / `npx skills rm webmcp`.

Prefer to install by hand? Copy `SKILL.md`, `references/`, and `scripts/` into
`~/.claude/skills/webmcp/` (global) or `.claude/skills/webmcp/` (per project).

## What it does

- **Detect** — one probe reports whether `navigator.modelContext` /
  `navigator.modelContextTesting` are present, whether the page is a secure context, and the
  full list of registered tools with their JSON-Schema inputs. It also catches *declarative*
  tools defined via HTML `toolname` attributes that the JS API can miss.
- **Call** — invokes a tool with the correct argument encoding (the testing API wants a JSON
  **string**, the single most common mistake), and reads back the structured result.
- **Diagnose** — when a WebMCP page lists *zero* tools, it tells you which of the real causes
  it is: the testing flag is off, the page isn't a secure context, tools register late or
  behind a route/login, or the site's own registration crashed (e.g. a non-HTTPS origin in an
  `exposedTo` list throwing a `SecurityError` that aborts every registration).
- **Stay safe** — runs read-only tools freely, but pauses for confirmation before anything
  that looks like it writes, submits, books, pays, or authenticates.

## Requirements

WebMCP is experimental and only works in a WebMCP-capable browser:

1. Chrome Canary/Beta (or recent Chromium).
2. Enable `chrome://flags/#enable-webmcp-testing` and relaunch.
3. The target page must be HTTPS or `localhost`.

The skill drives the browser through your agent's Playwright/MCP browser when one is connected.
If not, the bundled `scripts/webmcp-probe.mjs` launches its own Chromium:

```bash
# Inspect the page's WebMCP surface (prints one JSON report)
node scripts/webmcp-probe.mjs https://render.com

# Inspect, then invoke one tool
node scripts/webmcp-probe.mjs https://render.com --call render.docs.search --args '{"query":"background worker"}'
```

When the bundled Chromium lacks the flag, point at Canary/Beta:

```bash
WEBMCP_CHROME="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
  node scripts/webmcp-probe.mjs https://render.com --headed
```

## Try it

`https://render.com` ships real WebMCP tools (docs search, docs-by-slug, blog/articles
indexes). Ask your agent: *"does render.com have webmcp tools? list them, then search the docs
for 'background worker'."*

## Layout

```
SKILL.md                       # the skill: detect → list → inspect → execute, safety, diagnosis
references/webmcp-internals.md  # API surface, schemas, gotchas, troubleshooting tables
scripts/webmcp-probe.mjs        # standalone fallback runtime (own Chromium; no third-party calls)
evals/evals.json                # test prompts used to validate the skill
```

## Privacy

The skill and script only ever contact the URL you give them. No directory service, telemetry,
or analytics. (Installing via `npx skills` reports anonymous install counts to skills.sh — that
is the CLI's behavior, not this skill's.)

## License

MIT © Array Ventures
