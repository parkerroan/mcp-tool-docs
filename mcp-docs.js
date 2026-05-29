#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

// ─── HTTP utilities ──────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;

function httpPost(urlStr, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders,
      },
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Parse an SSE response body into an array of JSON-RPC message objects.
// The stream may contain notifications, progress events, etc. — collect all.
function parseSseEvents(body) {
  const events = [];
  let dataLines = [];

  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line === '' && dataLines.length > 0) {
      const data = dataLines.join('\n');
      if (data && data !== '[DONE]') {
        try { events.push(JSON.parse(data)); } catch { /* skip non-JSON SSE payloads */ }
      }
      dataLines = [];
    }
    // ignore comment/event/id/retry lines
  }
  if (dataLines.length > 0) {
    const data = dataLines.join('\n');
    if (data && data !== '[DONE]') {
      try { events.push(JSON.parse(data)); } catch {}
    }
  }
  return events;
}

// Find the JSON-RPC response matching the given id.
// Handles both single objects and batched arrays in the stream.
// IDs are compared as strings to handle servers that echo numeric IDs as strings.
function findRpcResponse(events, id) {
  const sid = String(id);
  for (const ev of events) {
    if (Array.isArray(ev)) {
      const match = ev.find(e => String(e.id) === sid);
      if (match) return match;
    } else if (String(ev.id) === sid) {
      return ev;
    }
  }
  return null;
}

// ─── MCP client ──────────────────────────────────────────────────────────────

let _reqId = 1;
const nextId = () => _reqId++;

async function mcpRequest(serverUrl, method, params, sessionId) {
  const id = nextId();
  const body = { jsonrpc: '2.0', method, id, params: params ?? {} };
  const headers = sessionId ? { 'Mcp-Session-Id': sessionId } : {};

  const { status, headers: resHeaders, body: resBody } = await httpPost(serverUrl, body, headers);

  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status} for ${method}: ${resBody.slice(0, 300)}`);
  }

  const ct = resHeaders['content-type'] || '';
  let rpc;

  if (ct.includes('text/event-stream')) {
    const events = parseSseEvents(resBody);
    rpc = findRpcResponse(events, id);
    if (!rpc) throw new Error(`No JSON-RPC response matching id=${id} found in SSE stream`);
  } else {
    try {
      rpc = JSON.parse(resBody);
    } catch {
      throw new Error(
        `Server returned non-JSON response (Content-Type: ${ct || 'unknown'}):\n${resBody.slice(0, 300)}`
      );
    }
  }

  if (rpc.error) {
    throw new Error(`RPC error ${rpc.error.code}: ${rpc.error.message}`);
  }

  return {
    result: rpc.result,
    sessionId: resHeaders['mcp-session-id'] || sessionId || null,
  };
}

// Send a JSON-RPC notification (no id, no response expected).
async function mcpNotify(serverUrl, method, params, sessionId) {
  const body = { jsonrpc: '2.0', method, params: params ?? {} };
  const headers = sessionId ? { 'Mcp-Session-Id': sessionId } : {};
  try { await httpPost(serverUrl, body, headers); } catch { /* best effort */ }
}

async function fetchTools(serverUrl) {
  process.stderr.write(`Connecting to ${serverUrl}...\n`);

  // Step 1: initialize
  let sessionId = null;
  let initialized = false;

  try {
    const { result, sessionId: sid } = await mcpRequest(serverUrl, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'mcp-docs', version: '1.0.0' },
    }, null);
    sessionId = sid;
    initialized = true;
    const name = result?.serverInfo?.name || 'unknown';
    const version = result?.serverInfo?.version || '';
    process.stderr.write(`Server: ${name}${version ? ` v${version}` : ''} (session=${sessionId || 'stateless'})\n`);
  } catch (err) {
    process.stderr.write(`Warning: initialize failed (${err.message}), attempting tools/list directly\n`);
  }

  // Step 2: notifications/initialized — only if init succeeded
  if (initialized) {
    await mcpNotify(serverUrl, 'notifications/initialized', {}, sessionId);
  }

  // Step 3: paginated tools/list
  const allTools = [];
  let cursor;
  const MAX_PAGES = 50;
  let page = 0;

  do {
    const params = cursor ? { cursor } : {};
    const { result } = await mcpRequest(serverUrl, 'tools/list', params, sessionId);
    const tools = result.tools || [];
    allTools.push(...tools);
    cursor = result.nextCursor || null;
    page++;
    if (page >= MAX_PAGES && cursor) {
      process.stderr.write('Warning: reached pagination limit, truncating tool list\n');
      break;
    }
  } while (cursor);

  process.stderr.write(`Found ${allTools.length} tool${allTools.length !== 1 ? 's' : ''}\n`);
  return allTools;
}

// ─── JSON Schema utilities ───────────────────────────────────────────────────

// Resolve a local $ref (e.g. "#/$defs/Foo") against the root schema.
function derefSchema(schema, rootSchema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (!schema.$ref) return schema;

  const ref = schema.$ref;
  if (!ref.startsWith('#/')) return schema; // skip external refs

  const parts = ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let target = rootSchema;
  for (const p of parts) {
    if (target == null || typeof target !== 'object') return schema;
    target = target[p];
  }
  if (!target) return schema;

  const overrides = Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$ref'));
  return derefSchema({ ...target, ...overrides }, rootSchema);
}

// Merge allOf sub-schemas into a single schema object.
function flattenAllOf(schema, rootSchema) {
  if (!schema.allOf) return schema;
  const merged = { ...schema };
  delete merged.allOf;
  for (const sub of schema.allOf) {
    const resolved = derefSchema(sub, rootSchema);
    for (const [k, v] of Object.entries(resolved)) {
      if (k === 'properties') {
        merged.properties = { ...(merged.properties || {}), ...v };
      } else if (k === 'required') {
        const s = new Set([...(merged.required || []), ...v]);
        merged.required = [...s];
      } else {
        merged[k] = v;
      }
    }
  }
  return merged;
}

function resolveSchema(schema, rootSchema) {
  if (!schema) return {};
  let s = derefSchema(schema, rootSchema);
  if (s.allOf) s = flattenAllOf(s, rootSchema);
  return s;
}

function schemaTypeLabel(schema, rootSchema) {
  const s = resolveSchema(schema, rootSchema);
  if (!s || typeof s !== 'object') return 'any';

  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map(v => JSON.stringify(v)).join(' | ');

  if (s.type === 'array') {
    if (s.items) return schemaTypeLabel(s.items, rootSchema) + '[]';
    return 'array';
  }
  if (Array.isArray(s.type)) return s.type.join(' | ');
  if (s.type) return s.type;
  if (s.oneOf) return s.oneOf.map(sub => schemaTypeLabel(sub, rootSchema)).join(' | ');
  if (s.anyOf) return s.anyOf.map(sub => schemaTypeLabel(sub, rootSchema)).join(' | ');
  if (s.properties) return 'object';
  return 'any';
}

// ─── Description parser ──────────────────────────────────────────────────────

// Only parse these known semantic tags from descriptions.
// A narrow allowlist prevents false matches on generic XML (<T>, <br>, etc.).
const KNOWN_TAGS = new Set([
  'usecase', 'instructions', 'note', 'warning', 'example',
  'context', 'output', 'behavior', 'format', 'constraints',
  'requirements', 'error', 'parameters',
]);

function parseDescription(desc) {
  if (!desc) return { sections: [], raw: '' };

  const pattern = new RegExp(
    `<(${[...KNOWN_TAGS].join('|')})>([\\s\\S]*?)<\\/\\1>`,
    'gi',
  );

  const sections = [];
  let remaining = desc;
  let match;

  while ((match = pattern.exec(desc)) !== null) {
    sections.push({ tag: match[1].toLowerCase(), content: match[2].trim() });
    remaining = remaining.replace(match[0], '');
  }

  return {
    sections,
    raw: remaining.replace(/\n{3,}/g, '\n\n').trim(),
  };
}

// ─── HTML helpers ────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ANNOTATION_DEFS = {
  readOnlyHint:    { trueLabel: 'Read-Only',    trueClass: 'badge-blue',   falseLabel: 'Writes Data',  falseClass: 'badge-orange' },
  idempotentHint:  { trueLabel: 'Idempotent',   trueClass: 'badge-green',  falseLabel: null,           falseClass: null },
  destructiveHint: { trueLabel: 'Destructive',  trueClass: 'badge-red',    falseLabel: null,           falseClass: null },
  openWorldHint:   { trueLabel: 'Open World',   trueClass: 'badge-purple', falseLabel: null,           falseClass: null },
};

function renderBadges(annotations) {
  if (!annotations) return '';
  const badges = [];
  for (const [key, value] of Object.entries(annotations)) {
    if (key === 'title') continue;
    const def = ANNOTATION_DEFS[key];
    if (def) {
      const label = value ? def.trueLabel : def.falseLabel;
      const cls = value ? def.trueClass : def.falseClass;
      if (label && cls) badges.push(`<span class="badge ${cls}">${esc(label)}</span>`);
    } else {
      // Unknown annotation: render as generic badge
      badges.push(`<span class="badge badge-gray">${esc(key)}: ${esc(String(value))}</span>`);
    }
  }
  return badges.join('');
}

function renderExamples(rawSchema, rootSchema) {
  const s = resolveSchema(rawSchema, rootSchema);
  const examples = Array.isArray(s.examples) ? s.examples : [];
  const enums = Array.isArray(s.enum) ? s.enum : [];
  const items = examples.length ? examples : enums.slice(0, 4);
  if (!items.length) return '<span class="nd">—</span>';
  return items.map(e => `<code class="ex">${esc(JSON.stringify(e))}</code>`).join(' ');
}

function renderParam(name, rawSchema, isRequired, rootSchema) {
  const schema = resolveSchema(rawSchema, rootSchema);
  const typeLabel = schemaTypeLabel(rawSchema, rootSchema);
  const fmt = schema.format ? ` <span class="nd">(${esc(schema.format)})</span>` : '';
  const defVal = schema.default !== undefined
    ? `<div class="p-default">Default: <code>${esc(JSON.stringify(schema.default))}</code></div>`
    : '';
  const desc = schema.description
    ? esc(schema.description)
    : (schema.title ? `<span class="nd">${esc(schema.title)}</span>` : '<span class="nd">—</span>');

  return `<tr${isRequired ? ' class="rr"' : ''}>
        <td class="cn"><code class="pn">${esc(name)}</code>${isRequired ? ' <span class="rm" title="Required">*</span>' : ''}</td>
        <td class="ct"><code class="pt">${esc(typeLabel)}</code>${fmt}</td>
        <td class="cd">${desc}${defVal}</td>
        <td class="ce">${renderExamples(rawSchema, rootSchema)}</td>
      </tr>`;
}

const SECTION_META = {
  usecase:      { label: 'Use Case',         cls: '' },
  instructions: { label: 'Instructions',     cls: 'si' },
  warning:      { label: 'Warning',          cls: 'sw' },
  note:         { label: 'Note',             cls: 'sn' },
  example:      { label: 'Example',          cls: 'se' },
  context:      { label: 'Context',          cls: '' },
  output:       { label: 'Output',           cls: '' },
  behavior:     { label: 'Behavior',         cls: '' },
  format:       { label: 'Format',           cls: '' },
  constraints:  { label: 'Constraints',      cls: '' },
  requirements: { label: 'Requirements',     cls: '' },
  error:        { label: 'Error Handling',   cls: 'sw' },
  parameters:   { label: 'Parameter Notes',  cls: '' },
};

function toolId(tool, prefix, idx) {
  const base = 'tool-' + tool.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const disambig = idx != null ? `-${idx}` : '';
  return prefix ? `${prefix}-${base}${disambig}` : `${base}${disambig}`;
}

function renderTool(tool, prefix, idx) {
  const id = toolId(tool, prefix, idx);
  const { sections, raw } = parseDescription(tool.description);
  const schema = tool.inputSchema || {};
  const rootSchema = schema;
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const annotations = tool.annotations || {};

  const paramNames = Object.keys(props).sort((a, b) => {
    if (required.has(a) !== required.has(b)) return required.has(a) ? -1 : 1;
    return a.localeCompare(b);
  });

  const badges = renderBadges(annotations);
  const displayTitle = annotations.title || tool.title;

  let html = `<section class="tc" id="${esc(id)}">
  <div class="th">
    <div class="nr">
      <h2 class="tn"><a class="ta" href="#${esc(id)}">${esc(tool.name)}</a></h2>
      ${badges ? `<div class="bl">${badges}</div>` : ''}
    </div>
    ${displayTitle ? `<p class="tt">${esc(displayTitle)}</p>` : ''}
  </div>`;

  for (const { tag, content } of sections) {
    const meta = SECTION_META[tag] || { label: tag, cls: '' };
    html += `
  <div class="ts ${meta.cls}">
    <div class="sl">${esc(meta.label)}</div>
    <div class="sb">${esc(content)}</div>
  </div>`;
  }

  if (raw) {
    html += `
  <div class="ts">
    <div class="sb">${esc(raw)}</div>
  </div>`;
  }

  // Parameters table
  html += `
  <div class="ts ps">
    <div class="sl">Parameters</div>`;

  if (paramNames.length === 0) {
    html += `\n    <p class="np">No parameters</p>`;
  } else {
    html += `
    <table class="pt">
      <thead><tr>
        <th class="cn">Name</th>
        <th class="ct">Type</th>
        <th class="cd">Description</th>
        <th class="ce">Examples / Values</th>
      </tr></thead>
      <tbody>
        ${paramNames.map(n => renderParam(n, props[n], required.has(n), rootSchema)).join('\n        ')}
      </tbody>
    </table>`;
  }
  html += `\n  </div>`;

  // Annotations
  const annEntries = Object.entries(annotations);
  if (annEntries.length > 0) {
    html += `
  <div class="ts as">
    <div class="sl">Annotations</div>
    <dl class="ag">
      ${annEntries.map(([k, v]) => `<div class="ai"><dt>${esc(k)}</dt><dd><code>${esc(String(v))}</code></dd></div>`).join('\n      ')}
    </dl>
  </div>`;
  }

  html += `\n</section>`;
  return html;
}

// ─── HTML page ───────────────────────────────────────────────────────────────

// Derive a short readable label from a URL.
// If all URLs share the same host, use just the pathname; otherwise host+path.
function serverLabel(url, allUrls) {
  try {
    const u = new URL(url);
    const allHosts = allUrls.map(s => { try { return new URL(s).hostname; } catch { return ''; } });
    const hostsDiffer = new Set(allHosts).size > 1;
    const path = u.pathname.replace(/\/$/, '');
    return hostsDiffer ? u.hostname + (path || '/') : (path || u.hostname);
  } catch {
    return url;
  }
}

// generateHtml accepts an array of server objects: [{url, label, tools}]
function generateHtml(servers) {
  const multi = servers.length > 1;
  const firstSrv = servers[0] || { url: '', label: '', tools: [] };
  const totalTools = servers.reduce((s, srv) => s + srv.tools.length, 0);
  const generatedAt = new Date().toUTCString();

  let pageHostname;
  try { pageHostname = new URL(firstSrv.url).hostname; } catch { pageHostname = firstSrv.url; }
  const pageTitle = multi
    ? `MCP Docs — ${servers.length} servers`
    : `MCP Docs — ${pageHostname}`;

  // ── sidebar: accordion sections (multi) or plain list (single) ──
  const sidebarHtml = multi
    ? servers.map(({ label, url, tools }, idx) => {
        const prefix = `s${idx}`;
        const links = tools.map((t, i) => {
          const id = toolId(t, prefix, i);
          return `<li><a class="nl" href="#${esc(id)}">${esc(t.name)}</a></li>`;
        }).join('\n            ');
        return `
        <div class="srv-acc">
          <button class="srv-hdr" data-idx="${idx}" title="${esc(url)}">
            <span class="srv-lbl">${esc(label)}</span>
            <span class="srv-tog">&#9660;</span>
          </button>
          <hr class="srv-div">
          <div class="stl" data-idx="${idx}">
            <ul>
              ${links || '<li class="nl-empty">No tools</li>'}
            </ul>
          </div>
        </div>`;
      }).join('')
    : (() => {
        const links = servers[0].tools.map((t, i) => {
          const id = toolId(t, '', i);
          return `<li><a class="nl" href="#${esc(id)}">${esc(t.name)}</a></li>`;
        }).join('\n            ');
        return `
        <div class="stl" data-idx="0">
          <p class="sb-h">Tools</p>
          <ul>
            ${links || '<li class="nl-empty">No tools</li>'}
          </ul>
        </div>`;
      })();

  // ── main content per-server sections ──
  const serverSections = servers.map(({ url, label, tools }, idx) => {
    const prefix = multi ? `s${idx}` : '';
    const cards = tools.length
      ? tools.map((t, i) => renderTool(t, prefix, i)).join('\n')
      : '<p style="padding:2rem;color:#6b7280">No tools returned by this server.</p>';

    const headerHtml = multi ? `
    <div class="svh">
      <span class="svh-label">${esc(label)}</span>
      <span class="svh-url">${esc(url)}</span>
      <span class="svh-count">${tools.length} tool${tools.length !== 1 ? 's' : ''}</span>
    </div>` : '';

    return `
  <div class="svs" data-idx="${idx}">
    ${headerHtml}
    ${cards}
  </div>`;
  }).join('');

  // ── header ──
  const headerUrlHtml = multi
    ? `<span class="hu">${servers.length} servers</span>`
    : `<span class="hu" title="${esc(firstSrv.url)}">${esc(firstSrv.url)}</span>`;
  const headerCountHtml = `<span class="hc">${totalTools} tool${totalTools !== 1 ? 's' : ''}</span>`;

  // Escape </script so the JSON can't break out of the <script> block.
  const serverDataJson = JSON.stringify(
    servers.map(s => ({ url: s.url, label: s.label, count: s.tools.length }))
  ).replace(/<\/script/gi, '<\\/script');

  const footerHtml = multi
    ? `${servers.length} servers &middot; ${totalTools} tools &middot; ${esc(generatedAt)}`
    : `${esc(firstSrv.url)} &middot; ${esc(generatedAt)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(pageTitle)}</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#f5f6fa;--surface:#fff;--border:#e5e7eb;--text:#111827;--muted:#6b7280;
      --accent:#4f46e5;--accent-bg:#eef2ff;--code-bg:#f3f4f6;
      --amber:#d97706;--amber-bg:#fffbeb;--amber-bd:#fde68a;
      --red-bg:#fff1f2;--red-bd:#fecdd3;
      --blue-bg:#eff6ff;--blue-bd:#bfdbfe;
      --green-bg:#f0fdf4;--green-bd:#bbf7d0;
      --hh:56px;--sw:240px
    }
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
    a{color:var(--accent)}

    /* ── header ── */
    .sh{position:fixed;top:0;left:0;right:0;height:var(--hh);background:var(--accent);color:#fff;display:flex;align-items:center;padding:0 1.25rem;gap:.6rem;z-index:200;box-shadow:0 2px 6px rgba(0,0,0,.2)}
    .hl{font-weight:700;font-size:.95rem;display:flex;align-items:center;gap:6px;white-space:nowrap}
    .hs{opacity:.4}
    .hu{font-size:.75rem;font-family:monospace;opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px}
    .hc{margin-left:auto;background:rgba(255,255,255,.2);padding:2px 10px;border-radius:99px;font-size:.75rem;white-space:nowrap;flex-shrink:0}

    /* ── layout ── */
    .ly{display:flex;min-height:100vh;padding-top:var(--hh)}

    /* ── sidebar ── */
    .sb-wrap{width:var(--sw);flex-shrink:0;position:fixed;top:var(--hh);bottom:0;overflow-y:auto;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column}
    .sb-h{padding:.45rem 1rem .3rem;font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--muted)}
    .sb-wrap ul{list-style:none;padding-bottom:.5rem}
    .nl{display:block;padding:.28rem 1rem;color:var(--text);text-decoration:none;font-size:.8rem;border-left:3px solid transparent;transition:background .12s,color .12s,border-color .12s;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .nl:hover{background:var(--accent-bg);color:var(--accent);border-left-color:var(--accent)}
    .nl.active{background:var(--accent-bg);color:var(--accent);border-left-color:var(--accent);font-weight:500}
    .nl-empty{padding:.3rem 1rem;font-size:.78rem;color:var(--muted);font-style:italic}

    /* ── server accordion ── */
    .srv-acc{border-bottom:1px solid var(--border)}
    .srv-hdr{display:flex;align-items:center;justify-content:space-between;width:100%;padding:.55rem 1rem;background:none;border:none;cursor:pointer;font-size:.78rem;font-weight:600;color:var(--text);text-align:left;transition:background .12s}
    .srv-hdr:hover{background:var(--accent-bg)}
    .srv-lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-family:'SFMono-Regular',Consolas,monospace}
    .srv-tog{flex-shrink:0;font-size:.65rem;color:var(--muted);margin-left:.5rem}
    .srv-div{border:none;border-top:1px solid var(--border);margin:0}

    /* ── server tool lists ── */
    .stl{padding:.25rem 0}

    /* ── main ── */
    .mn{flex:1;margin-left:var(--sw);padding:1.5rem 2rem 4rem;min-width:0;max-width:1000px}

    /* ── server section header ── */
    .svh{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;padding:.65rem 1rem;background:var(--accent-bg);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:6px;margin-bottom:1.5rem}
    .svh-label{font-weight:700;color:var(--accent);font-size:.88rem;white-space:nowrap}
    .svh-url{font-size:.73rem;font-family:monospace;color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    .svh-count{font-size:.72rem;background:var(--accent);color:#fff;padding:1px 8px;border-radius:99px;white-space:nowrap;flex-shrink:0}

    /* ── tool card ── */
    .tc{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:2rem;overflow:hidden;scroll-margin-top:calc(var(--hh) + 12px)}
    .th{padding:1rem 1.5rem;background:#fafafa;border-bottom:1px solid var(--border)}
    .nr{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
    .tn{font-size:1rem;font-weight:700;font-family:'SFMono-Regular',Consolas,monospace}
    .tn a{color:var(--accent);text-decoration:none}
    .tn a:hover{text-decoration:underline}
    .tt{margin-top:.25rem;font-size:.85rem;color:var(--muted)}

    /* ── badges ── */
    .bl{display:flex;gap:.3rem;flex-wrap:wrap}
    .badge{padding:1px 8px;border-radius:99px;font-size:.68rem;font-weight:600;white-space:nowrap}
    .badge-blue{background:#dbeafe;color:#1d4ed8}
    .badge-green{background:#dcfce7;color:#15803d}
    .badge-red{background:#fee2e2;color:#b91c1c}
    .badge-orange{background:#ffedd5;color:#c2410c}
    .badge-purple{background:#f3e8ff;color:#7e22ce}
    .badge-gray{background:#f3f4f6;color:#374151}

    /* ── sections ── */
    .ts{padding:.9rem 1.5rem;border-bottom:1px solid var(--border)}
    .ts:last-child{border-bottom:none}
    .sl{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin-bottom:.35rem}
    .sb{font-size:.875rem;white-space:pre-wrap;line-height:1.65}
    .si{background:var(--amber-bg);border-left:3px solid var(--amber-bd)}
    .sw{background:var(--red-bg);border-left:3px solid var(--red-bd)}
    .sn{background:var(--blue-bg);border-left:3px solid var(--blue-bd)}
    .se{background:var(--green-bg);border-left:3px solid var(--green-bd)}

    /* ── params table ── */
    .ps{padding-bottom:0}
    .np{font-size:.85rem;color:var(--muted);font-style:italic;padding-bottom:.9rem}
    .pt{width:100%;border-collapse:collapse;margin-top:.35rem;font-size:.845rem}
    .pt th{text-align:left;padding:.3rem .6rem;font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);border-bottom:2px solid var(--border);white-space:nowrap}
    .pt td{padding:.45rem .6rem;border-bottom:1px solid var(--border);vertical-align:top}
    .pt tr:last-child td{border-bottom:none}
    .rr{background:#fafafe}
    .cn{width:18%;white-space:nowrap}
    .ct{width:18%;white-space:nowrap}
    .cd{width:46%;white-space:pre-wrap}
    .ce{width:18%}
    .pn{font-weight:700;font-family:'SFMono-Regular',Consolas,monospace;font-size:.85em}
    .pt code,.pn,.pt code.pt{font-family:'SFMono-Regular',Consolas,monospace;font-size:.85em}
    .pt code.pt{background:#e0f2fe;color:#0369a1;padding:1px 5px;border-radius:3px}
    code.ex{background:var(--code-bg);padding:1px 5px;border-radius:3px;display:inline-block;margin:1px 2px 1px 0;font-size:.82em;font-family:'SFMono-Regular',Consolas,monospace}
    .rm{color:#ef4444;font-weight:700;margin-left:1px;font-size:.75em;vertical-align:super}
    .nd{color:var(--muted)}
    .p-default{font-size:.78em;color:var(--muted);margin-top:.18rem}

    /* ── annotations ── */
    .as{background:#fafafa}
    .ag{display:flex;gap:1.5rem;flex-wrap:wrap}
    .ai dt{font-size:.7rem;color:var(--muted);font-family:monospace}
    .ai dd code{font-size:.78rem;font-family:'SFMono-Regular',Consolas,monospace}

    /* ── footer ── */
    .pf{margin-left:var(--sw);padding:.75rem 2rem;font-size:.72rem;color:var(--muted);border-top:1px solid var(--border)}

    @media(max-width:700px){
      .sb-wrap{display:none}
      .mn{margin-left:0;padding:1rem}
      .pf{margin-left:0}
    }
  </style>
</head>
<body>
<header class="sh">
  <div class="hl">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
      <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
    </svg>
    MCP Docs
  </div>
  <span class="hs">/</span>
  ${headerUrlHtml}
  ${headerCountHtml}
</header>

<div class="ly">
  <nav class="sb-wrap" aria-label="Tools">
    ${sidebarHtml}
  </nav>

  <main class="mn">
    ${serverSections}
  </main>
</div>

<footer class="pf">
  Generated by <strong>mcp-docs</strong> &middot; ${footerHtml}
</footer>

<script id="sd" type="application/json">${serverDataJson}</script>
<script>
(function(){
  var multi = ${multi};

  if (multi) {
    // Accordion toggle: click server header to expand/collapse its tool list
    document.querySelectorAll('.srv-hdr').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var idx = this.dataset.idx;
        var list = document.querySelector('.stl[data-idx="' + idx + '"]');
        var divider = this.nextElementSibling;
        var tog = this.querySelector('.srv-tog');
        var open = list.style.display !== 'none';
        list.style.display = open ? 'none' : '';
        if (divider && divider.classList.contains('srv-div')) {
          divider.style.display = open ? 'none' : '';
        }
        tog.innerHTML = open ? '&#9658;' : '&#9660;';
      });
    });
  }

  // Scroll-spy: highlight the nav link for the card nearest the top
  var OFFSET = 72;
  var allLinks = Array.from(document.querySelectorAll('.nl'));

  function activeCard() {
    var cards = Array.from(document.querySelectorAll('.tc[id]'));
    var y = window.scrollY + OFFSET;
    var cur = cards[0];
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].offsetTop <= y) cur = cards[i]; else break;
    }
    return cur ? cur.id : null;
  }

  function update() {
    var id = activeCard();
    allLinks.forEach(function(l){
      l.classList.toggle('active', l.getAttribute('href') === '#' + id);
    });
  }

  window.addEventListener('scroll', update, {passive: true});
  update();
})();
</script>
</body>
</html>`;
}

// ─── Shared: build server data from URLs ─────────────────────────────────────

async function buildServerList(serverUrls) {
  const allHosts = serverUrls.map(u => { try { return new URL(u).hostname; } catch { return ''; } });
  const hostsDiffer = new Set(allHosts).size > 1;

  const results = await Promise.allSettled(serverUrls.map(url => fetchTools(url)));

  return results.map((result, idx) => {
    const url = serverUrls[idx];
    let label;
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/\/$/, '');
      label = hostsDiffer ? u.hostname + (path || '/') : (path || u.hostname);
    } catch {
      label = url;
    }

    if (result.status === 'fulfilled') {
      return { url, label, tools: result.value };
    } else {
      process.stderr.write(`Warning: failed to fetch ${url}: ${result.reason?.message || result.reason}\n`);
      return { url, label, tools: [] };
    }
  });
}

// ─── Server mode ─────────────────────────────────────────────────────────────

function serveMode(args) {
  let port = 3000;
  const serverUrls = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (!args[i].startsWith('-')) {
      serverUrls.push(args[i]);
    }
  }

  if (serverUrls.length === 0) {
    console.error('Error: serve mode requires at least one server URL');
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }

    const start = Date.now();
    try {
      const servers = await buildServerList(serverUrls);
      const html = generateHtml(servers);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : html);

      process.stderr.write(`${new Date().toISOString()} GET / 200 (${Date.now() - start}ms)\n`);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error generating docs: ${err.message}`);
      process.stderr.write(`${new Date().toISOString()} GET / 500 — ${err.message}\n`);
    }
  });

  server.listen(port, () => {
    process.stderr.write(`mcp-docs server running at http://localhost:${port}\n`);
    process.stderr.write(`Documenting:\n${serverUrls.map(u => `  - ${u}`).join('\n')}\n`);
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  return `mcp-docs — Generate HTML documentation from one or more MCP servers

Usage:
  mcp-docs <server-url> [<server-url>...] [--output|-o <file>]
  mcp-docs serve [--port|-p <port>] <server-url> [<server-url>...]

CLI mode:
  Fetches tool definitions and writes an HTML page to stdout or a file.

Server mode:
  Starts an HTTP server that regenerates docs live on every request.
  Useful when the MCP server URL changes between environments.

Options (CLI):
  --output, -o <file>   Write HTML to a file (default: stdout)
  --help, -h            Show this message

Options (serve):
  --port, -p <port>     Port to listen on (default: 3000)
  --help, -h            Show this message

Examples:
  # CLI — generate a static HTML file
  mcp-docs http://localhost:8080/mcp > docs.html
  mcp-docs http://localhost:8080/v1.0 http://localhost:8080/v2.0 -o docs.html

  # Server — serve live docs on http://localhost:3000
  mcp-docs serve http://localhost:8080/mcp
  mcp-docs serve --port 8000 http://localhost:8080/v1.0 http://localhost:8080/v2.0`;
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    process.exit(args.length ? 0 : 1);
  }

  // Server mode
  if (args[0] === 'serve') {
    return serveMode(args.slice(1));
  }

  // CLI mode
  const serverUrls = [];
  let outputFile = null;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--output' || args[i] === '-o') && args[i + 1]) {
      outputFile = args[++i];
    } else if (!args[i].startsWith('-')) {
      serverUrls.push(args[i]);
    }
  }

  if (serverUrls.length === 0) {
    console.error('Error: provide one or more server URLs');
    process.exit(1);
  }

  try {
    const servers = await buildServerList(serverUrls);
    const html = generateHtml(servers);

    if (outputFile) {
      fs.writeFileSync(outputFile, html, 'utf8');
      process.stderr.write(`Wrote ${html.length.toLocaleString()} bytes to ${outputFile}\n`);
    } else {
      process.stdout.write(html);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
