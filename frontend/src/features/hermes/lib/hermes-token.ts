const HERMES_AGENT_TOKEN_BYTES = 32;

export function generateHermesAgentToken(): string {
  const bytes = new Uint8Array(HERMES_AGENT_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function buildHermesConfigTemplate(slateBackend: string, token?: string): string {
  const sharedToken = token ?? '<至少 32 字符的共享 Token>';
  return [
    '# Hermes Gateway（Slate 已自动保存同一个 Token）',
    `SLATE_BACKEND=${slateBackend}`,
    `SLATE_AGENT_TOKEN=${sharedToken}`,
  ].join('\n');
}
