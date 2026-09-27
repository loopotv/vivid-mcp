import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { VERSION } from './meta.js';

const read = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

describe('Claude Code plugin manifest', () => {
  const plugin = read('.claude-plugin/plugin.json');

  // Installed plugins only update when this field changes, so bump it with every release.
  it('carries the package version', () => {
    expect(plugin.version).toBe(read('package.json').version);
    expect(plugin.version).toBe(VERSION);
  });

  it('points at the remote OAuth server, never at a local API key', () => {
    expect(plugin.mcpServers.vivid).toEqual({ type: 'http', url: 'https://mcp.vividai.tv/mcp' });
  });
});
