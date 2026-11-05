import { describe, it, expect } from 'vitest';
import { isDiscoveryOnly } from './discovery.js';

const rpc = (method: string, id: number | undefined = 1) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method });

describe('isDiscoveryOnly', () => {
  it('lets an anonymous client see what the server does', () => {
    expect(isDiscoveryOnly(rpc('initialize'))).toBe(true);
    expect(isDiscoveryOnly(rpc('notifications/initialized', undefined))).toBe(true);
    expect(isDiscoveryOnly(rpc('tools/list'))).toBe(true);
    expect(isDiscoveryOnly(rpc('ping'))).toBe(true);
  });

  it('keeps tool calls behind sign-in', () => {
    expect(isDiscoveryOnly(rpc('tools/call'))).toBe(false);
    expect(isDiscoveryOnly(rpc('resources/read'))).toBe(false);
    expect(isDiscoveryOnly(rpc('prompts/get'))).toBe(false);
  });

  it('refuses a batch that mixes discovery with anything else', () => {
    expect(isDiscoveryOnly([rpc('tools/list'), rpc('tools/call', 2)])).toBe(false);
    expect(isDiscoveryOnly([rpc('initialize'), rpc('tools/list', 2)])).toBe(true);
  });

  it('refuses what is not a JSON-RPC request', () => {
    expect(isDiscoveryOnly(null)).toBe(false);
    expect(isDiscoveryOnly([])).toBe(false);
    expect(isDiscoveryOnly('tools/list')).toBe(false);
    expect(isDiscoveryOnly({ jsonrpc: '2.0', id: 1 })).toBe(false);
  });
});
