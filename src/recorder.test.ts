import { describe, it, expect } from 'vitest';
import { VividClient } from './client.js';
import { isVividOrigin } from './recorder.js';

const prod = new VividClient({ apiKey: 'vivid_test', apiUrl: 'https://vivid-api.vividoai.workers.dev' });
const local = new VividClient({ apiKey: 'vivid_test', apiUrl: 'http://localhost:8787' });

describe('record_ui login scope', () => {
  it('gives the VIVID session only to VIVID origins', () => {
    expect(isVividOrigin('https://vividai.tv', prod)).toBe(true);
    expect(isVividOrigin('https://stage.vividai.tv', prod)).toBe(true);
    expect(isVividOrigin('http://localhost:8787', local)).toBe(true);
  });

  it('never to other sites, look-alikes included', () => {
    expect(isVividOrigin('https://example.com', prod)).toBe(false);
    expect(isVividOrigin('https://vividai.tv.evil.com', prod)).toBe(false);
    expect(isVividOrigin('https://notvividai.tv', prod)).toBe(false);
    expect(isVividOrigin('http://localhost:8787', prod)).toBe(false);
    expect(isVividOrigin('not a url', prod)).toBe(false);
  });
});
