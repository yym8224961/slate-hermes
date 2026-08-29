import { describe, expect, it } from 'bun:test';
import { formatScriptError, readScriptErrorBody, redactScriptLogText } from './script-logger';

describe('script log redaction', () => {
  it('redacts bearer tokens, Renewlet tokens, Slate capability paths, and token fields', async () => {
    const secret =
      'Bearer secret-value rlh_exampleSecret /api/v1/contents/capability-secret/data token=another-secret';
    const redacted = redactScriptLogText(secret);

    expect(redacted).not.toContain('secret-value');
    expect(redacted).not.toContain('rlh_exampleSecret');
    expect(redacted).not.toContain('capability-secret');
    expect(redacted).not.toContain('another-secret');
    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).toContain('/api/v1/contents/[REDACTED]/data');

    const body = await readScriptErrorBody(new Response(secret, { status: 500 }));
    const formatted = formatScriptError(new Error(secret));
    expect(body).toBe(redacted);
    expect(formatted).toBe(redacted);
  });
});
