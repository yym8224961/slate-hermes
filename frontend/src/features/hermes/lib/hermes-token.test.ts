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
      'SLATE_AGENT_TOKEN=<至少 32 字符的共享 Token>'
    );
    const token = 'f'.repeat(64);
    const template = buildHermesConfigTemplate('https://slate.example', token);
    expect(template).toContain('SLATE_AGENT_TOKEN=' + token);
    expect(template).not.toContain('HERMES_AGENT_TOKEN');
    expect(template.split(token)).toHaveLength(2);
  });
});
