# Example MCP Test Server

A minimal, zero-dependency MCP server for testing `mcp-docs` locally.

## Usage

```bash
node test-server/server.js
# → MCP test server running at http://localhost:3001

npx mcp-docs http://localhost:3001 -o docs.html && open docs.html
```

Custom port:

```bash
node test-server/server.js 4000
# or
PORT=4000 node test-server/server.js
```

## What It Serves

Six example tools covering the domains used in a typical marketplace MCP server:

| Tool | Domain |
|------|--------|
| `SearchProductsInStore` | Search |
| `GetStores` | Retailer |
| `AddItemToCart` | Cart |
| `UpdateCartItem` | Cart |
| `GetCart` | Cart |
| `GetCustomerProfile` | Customer |

## Endpoints

- **POST `/`** — JSON-RPC 2.0 endpoint (handles `tools/list` and `initialize`)
- **OPTIONS `/`** — CORS preflight (allows all origins)

This server is for development and testing only. It does not implement authentication, rate limiting, or actual business logic.
