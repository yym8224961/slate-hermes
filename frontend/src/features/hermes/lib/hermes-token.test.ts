import { describe, expect, it } from 'bun:test';
import { buildHermesConfigTemplate, generateHermesAgentToken } from './hermes-token';

describe('Hermes Token helpers', () => {
  it('generates 32 random bytes as a 64-character lowercase hex Token', () => {
    expect(generateHermesAgentToken()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('generates a fresh value for successive calls', () => {
    expect(generateHermesAgentToken()).not.toBe(generateHermesAgentToken());
  });

  it('builds a placeholder or filled Hermes configuration template', () => {
    expect(buildHermesConfigTemplate('https://slate.example')).toContain(
      'HERMES_AGENT_TOKEN=<至少 32 字符的共享 Token>'
    );
    expect(buildHermesConfigTemplate('https://slate.example', 'f'.repeat(64))).toContain(
      'SLATE_AGENT_TOKEN=' + 'f'.repeat(64)
    );
  });
});
