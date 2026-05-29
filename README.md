# mcp-tool-docs

[![npm](https://img.shields.io/npm/v/mcp-tool-docs)](https://www.npmjs.com/package/mcp-tool-docs)
[![CI](https://github.com/parkerroan/mcp-tool-docs/actions/workflows/ci.yml/badge.svg)](https://github.com/parkerroan/mcp-tool-docs/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Generate a clean HTML documentation page from any [MCP](https://modelcontextprotocol.io) server's `tools/list` endpoint — like Swagger UI, but for MCP.

## Installation

```bash
# Run without installing (recommended for one-off use)
npx mcp-tool-docs http://localhost:8080 -o docs.html

# Install globally
npm install -g mcp-tool-docs
mcp-tool-docs http://localhost:8080 -o docs.html
```

## Usage

```bash
# Single server — print HTML to stdout
npx mcp-tool-docs http://localhost:8080

# Single server — write to file
npx mcp-tool-docs http://localhost:8080 -o docs.html

# Multiple servers — vertical accordion sidebar, one page
npx mcp-tool-docs http://localhost:8080/v1.0 http://localhost:8080/v2.0 -o docs.html

# Generate example output (no server needed)
npx mcp-tool-docs --example -o example.html
```

When multiple URLs are provided, the output page renders a **left-side vertical accordion**. Each server section expands/collapses independently and shows its tool list nested beneath it. Tab labels are derived from the URL:

- If all servers share the same host, labels use the **pathname** only (e.g. `/v1.0`, `/v2.0`)
- If hosts differ, labels use **hostname + path** (e.g. `api.example.com/mcp`)

## What It Generates

For each tool, the page shows:

- **Name + title** — human-readable tool identity
- **`<usecase>` section** — when to use the tool (parsed from description)
- **`<instructions>` section** — critical usage notes (highlighted in amber)
- **Input parameters** — from `inputSchema.properties`: type, description, required status, examples
- **Annotations** — `readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint` as colored badges

The page includes a fixed sidebar for navigation and an anchor link per tool.

## Transport Support

This tool targets the **Streamable HTTP** transport ([2025-03-26 spec](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/#streamable-http)):

- Single POST endpoint
- Server responds with `application/json` or `text/event-stream`
- Session management via `Mcp-Session-Id` response header

**Legacy SSE transport** (separate `GET /sse` + `POST /messages` endpoints) is **not** supported. If your server uses the legacy transport, use [MCP Inspector](https://github.com/modelcontextprotocol/inspector) instead.

## URL Format

Pass the base MCP endpoint URL. Common patterns:

| Server | URL |
|--------|-----|
| Default Go server | `http://localhost:8080` |
| Explicit path | `http://localhost:8080/mcp` |
| With auth header | Use `--header` (not yet implemented — edit the source) |

The tool appends no path — it POSTs directly to the URL you provide.

## Tool Description Parsing

MCP tool descriptions often use XML-like tags to structure content. This tool parses and renders the following tags as distinct sections:

| Tag | Style |
|-----|-------|
| `<usecase>` | Default (gray border) |
| `<instructions>` | Amber/warning highlight |
| `<note>` | Blue info highlight |
| `<warning>` | Red warning highlight |
| `<error>` | Red error highlight |
| `<example>` | Green highlight |
| `<context>`, `<output>`, `<behavior>`, `<format>`, `<constraints>`, `<requirements>`, `<parameters>` | Default |

Text outside known tags is shown as a preformatted block.

## JSON Schema Support

Input parameters support:

- `type` — including arrays (`string[]`, `object[]`)
- `enum` — rendered as `"a" | "b" | "c"`
- `$ref` + `$defs` — local references resolved
- `allOf` — merged/flattened
- `oneOf` / `anyOf` — union type label
- `items` — array element type
- `format` — shown as badge
- `default` — shown in parameter table
- `examples` — shown as inline code chips

## Requirements

- Node.js 18+
- No external dependencies (stdlib only)

## Example

```bash
npx mcp-tool-docs --example -o example.html && open example.html
```

This renders a built-in example tool without requiring a live MCP server.
