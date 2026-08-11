import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../../infra/config/app.config';
import { HermesTokenStore, isValidHermesAgentToken } from './hermes-token.store';

const envToken = `env-${'a'.repeat(60)}`;
const fileToken = 'f'.repeat(64);
const tempRoots: string[] = [];

describe('HermesTokenStore', () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('falls back to the environment Token when the persistent file is absent', async () => {
    const root = await makeTempRoot();
    const store = new HermesTokenStore(config(root, envToken));

    await store.onModuleInit();

    expect(store.get()).toBe(envToken);
  });

  it('writes a valid Token atomically with owner-only permissions and reloads it', async () => {
    const root = await makeTempRoot();
    const store = new HermesTokenStore(config(root, undefined));

    await store.onModuleInit();
    await store.set(fileToken);

    const tokenPath = join(root, 'hermes-agent-token');
    expect(store.get()).toBe(fileToken);
    expect(await readFile(tokenPath, 'utf8')).toBe(`${fileToken}\n`);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects short, whitespace, and punctuation outside the allowlist', async () => {
    const root = await makeTempRoot();
    const store = new HermesTokenStore(config(root, undefined));

    expect(isValidHermesAgentToken(fileToken)).toBe(true);
    await expect(store.set('too-short')).rejects.toThrow();
    await expect(store.set(`${fileToken} `)).rejects.toThrow();
    await expect(store.set(`${fileToken}!`)).rejects.toThrow();
  });

  it('fails closed when an existing persistent file is invalid', async () => {
    const root = await makeTempRoot();
    const tokenPath = join(root, 'hermes-agent-token');
    await writeFile(tokenPath, 'bad-token\n');

    await expect(new HermesTokenStore(config(root, envToken)).onModuleInit()).rejects.toThrow();
  });

  it('rejects an existing file with surrounding whitespace', async () => {
    const root = await makeTempRoot();
    const tokenPath = join(root, 'hermes-agent-token');
    await writeFile(tokenPath, ` ${fileToken}\n`);

    await expect(new HermesTokenStore(config(root, envToken)).onModuleInit()).rejects.toThrow();
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'slate-hermes-token-'));
  tempRoots.push(root);
  return root;
}

function config(root: string, hermesAgentToken: string | undefined): AppConfig {
  return {
    blobDir: join(root, 'blobs'),
    hermesAgentToken,
    hermesAgentTokenFile: join(root, 'hermes-agent-token'),
  } as AppConfig;
}
