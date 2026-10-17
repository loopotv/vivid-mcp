import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VividClient } from './client.js';
import { registerTools } from './tools.js';
import { runCli } from './cli.js';

const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { id: 'u1', email: 'a@b.c', plan: 'pro', credits: 12 } }), {
  status: 200, headers: { 'content-type': 'application/json' },
})) as unknown as typeof fetch;

const makeServer = () => {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerTools(server, new VividClient({ apiKey: 'vivid_test', apiUrl: 'https://api.test', fetchImpl: fetchMock }));
  return server;
};

const out: string[] = [];
const err: string[] = [];
vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); });
vi.spyOn(console, 'error').mockImplementation((m: unknown) => { err.push(String(m)); });
afterEach(() => { out.length = 0; err.length = 0; });

describe('vivid-mcp CLI', () => {
  it('lists the tools', async () => {
    expect(await runCli(['tools'], makeServer)).toBe(0);
    expect(out.some((l) => l.startsWith('vivid_generate_image'))).toBe(true);
  });

  it('calls a tool with the vivid_ prefix optional', async () => {
    expect(await runCli(['call', 'whoami', '{}'], makeServer)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ email: 'a@b.c', credits: 12 });
  });

  it('prints the schema of a tool', async () => {
    expect(await runCli(['schema', 'vivid_list_assets'], makeServer)).toBe(0);
    expect(out[0]).toContain('"properties"');
  });

  it('fails on an unknown tool and on invalid arguments', async () => {
    expect(await runCli(['call', 'nope'], makeServer)).toBe(1);
    expect(err[0]).toContain('Unknown tool');
    expect(await runCli(['call', 'list_assets', '{"limit":"x"}'], makeServer)).toBe(1);
  });

  it('rejects arguments that are not a JSON object', async () => {
    await expect(runCli(['call', 'whoami', '[1]'], makeServer)).rejects.toThrow('JSON object');
  });
});
