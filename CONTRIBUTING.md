# Contributing to mcp-docs

Thanks for your interest in contributing! This is a small, focused tool — keep that spirit in mind.

## Development

No build step, no dependencies. Clone and run:

```bash
git clone https://github.com/parkerroan/mcp-docs.git
cd mcp-docs
node mcp-docs.js --example -o test.html
open test.html
```

## Running Tests

The smoke test used in CI:

```bash
node mcp-docs.js --example -o /tmp/test.html
```

Check that `test.html` renders correctly in a browser.

## Submitting a PR

1. Fork the repo and create a branch from `main`
2. Make your change in `mcp-docs.js`
3. Test with `--example` and against a real MCP server if possible
4. Submit a PR with a clear description of what changed and why

## Reporting Bugs

Open a [GitHub issue](https://github.com/parkerroan/mcp-docs/issues) with:
- The MCP server URL (or a minimal reproduction)
- The command you ran
- What you expected vs what happened

## Scope

This tool intentionally stays small and dependency-free. PRs that add npm dependencies will not be merged.
