#!/usr/bin/env node
/**
 * example/server.js — Lightweight MCP test server for mcp-docs development
 *
 * Implements the tools/list JSON-RPC endpoint only.
 * No external dependencies. Run with: node example/server.js
 *
 * Default port: 3001
 * Usage:  node example/server.js [port]
 *         PORT=4000 node example/server.js
 */

const http = require('http');

const PORT = parseInt(process.env.PORT || process.argv[2] || '3001', 10);

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'SearchProductsInStore',
    title: 'Search for Products in a Store',
    description: `
\t\t<usecase>
\t\t\tUse this to search for products in a specific store. Returns matching products
\t\t\twith prices and availability.
\t\t</usecase>

\t\t<instructions>
\t\t\tCRITICAL: DO NOT call this tool more than 3 times in a single conversation turn.
\t\t\tAlways provide both metro_id and store_id from a prior GetStores call.
\t\t\tPrefer specific queries over vague terms — "2% milk" outperforms "milk".
\t\t</instructions>
\t\t`,
    inputSchema: {
      type: 'object',
      required: ['metro_id', 'store_id', 'query'],
      properties: {
        metro_id: {
          type: 'string',
          title: 'Metro ID',
          description: 'The metro area identifier',
          examples: ['chicago', 'nyc', 'seattle'],
        },
        store_id: {
          type: 'string',
          title: 'Store ID',
          description: 'The store to search within',
          examples: ['14523', '99102'],
        },
        query: {
          type: 'string',
          title: 'Search Query',
          description: 'The search query to find products',
          examples: ['milk', 'cookies', 'organic apples'],
        },
        limit: {
          type: 'integer',
          title: 'Result Limit',
          description: 'Maximum number of results to return',
          default: 20,
        },
        sort_by: {
          type: 'string',
          title: 'Sort By',
          description: 'Field to sort results by',
          enum: ['relevance', 'price_asc', 'price_desc', 'popularity'],
          default: 'relevance',
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    meta: {
      'openai/toolInvocation/invoking': 'Searching for items',
      'openai/toolInvocation/invoked': 'Items found',
    },
  },
  {
    name: 'GetStores',
    title: 'Get Available Stores',
    description: `<usecase>
Returns a list of stores available in a given metro area.
Use this before SearchProductsInStore to obtain valid store_id values.
</usecase>

<instructions>
Call this once per conversation to populate available stores.
Cache the results — do not call repeatedly for the same metro_id.
</instructions>`,
    inputSchema: {
      type: 'object',
      required: ['metro_id'],
      properties: {
        metro_id: {
          type: 'string',
          title: 'Metro ID',
          description: 'The metro area to retrieve stores for',
          examples: ['chicago', 'nyc'],
        },
        retailer_id: {
          type: 'string',
          title: 'Retailer ID',
          description: 'Optional: filter stores by retailer',
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'AddItemToCart',
    title: 'Add Item to Cart',
    description: `<usecase>
Adds a product to the customer's active cart. Creates a cart if none exists.
</usecase>

<instructions>
Use the product_id returned by SearchProductsInStore. Quantity must be a positive integer.
Do not call this multiple times for the same item — use UpdateCartItem to adjust quantity instead.
</instructions>`,
    inputSchema: {
      type: 'object',
      required: ['product_id', 'quantity'],
      properties: {
        product_id: {
          type: 'string',
          title: 'Product ID',
          description: 'Product identifier from SearchProductsInStore results',
        },
        quantity: {
          type: 'integer',
          title: 'Quantity',
          description: 'Number of units to add',
          default: 1,
        },
        note: {
          type: 'string',
          title: 'Shopper Note',
          description: 'Optional substitution or special instructions for the shopper',
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
  },
  {
    name: 'UpdateCartItem',
    title: 'Update Cart Item Quantity',
    description: `<usecase>
Updates the quantity of an existing item in the cart.
Use this instead of removing and re-adding an item.
</usecase>

<instructions>
Set quantity to 0 to effectively remove the item.
The cart_item_id is returned by AddItemToCart or GetCart.
</instructions>`,
    inputSchema: {
      type: 'object',
      required: ['cart_item_id', 'quantity'],
      properties: {
        cart_item_id: {
          type: 'string',
          title: 'Cart Item ID',
          description: 'The identifier of the cart line item to update',
        },
        quantity: {
          type: 'integer',
          title: 'New Quantity',
          description: 'Updated quantity (0 to remove the item)',
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
  },
  {
    name: 'GetCart',
    title: 'Get Current Cart',
    description: `<usecase>
Retrieves the customer's current cart contents, including items, quantities, and estimated total.
</usecase>

<note>
The estimated_total is pre-tax and may differ from the final checkout total.
</note>`,
    inputSchema: {
      type: 'object',
      required: [],
      properties: {
        include_out_of_stock: {
          type: 'boolean',
          title: 'Include Out of Stock',
          description: 'Whether to include items that are no longer available',
          default: false,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'GetCustomerProfile',
    title: 'Get Customer Profile',
    description: `<usecase>
Returns the authenticated customer's profile information including name, email,
default address, and membership status.
</usecase>

<warning>
This tool returns PII. Do not log or display raw output to end users.
Only use fields that are explicitly needed for the task.
</warning>`,
    inputSchema: {
      type: 'object',
      required: [],
      properties: {
        fields: {
          type: 'array',
          title: 'Fields',
          description: 'Specific fields to return (returns all if omitted)',
          items: { type: 'string', enum: ['name', 'email', 'address', 'membership', 'preferences'] },
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
];

// ─── JSON-RPC handler ─────────────────────────────────────────────────────────

function handleRPC(body) {
  let req;
  try {
    req = JSON.parse(body);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }

  if (req.method === 'tools/list' || req.method === 'mcp/listTools') {
    return { jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } };
  }

  // initialize — some clients send this first
  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-docs-example', version: '1.0.0' },
      },
    };
  }

  return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32601, message: 'Method not found' } };
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS headers so a browser-side client can reach this during local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed — POST only' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const rpcResponse = handleRPC(body);
    const json = JSON.stringify(rpcResponse);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(json);
  });
});

server.listen(PORT, () => {
  console.log(`MCP test server running at http://localhost:${PORT}`);
  console.log(`Generate docs:  npx mcp-docs http://localhost:${PORT} -o docs.html`);
});
