import { Injectable, OnModuleInit } from '@nestjs/common';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { AppConfig } from '../../infra/config/app.config';

const HERMES_AGENT_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,256}$/;

@Injectable()
export class HermesTokenStore implements OnModuleInit {
  private token: string | undefined;

  constructor(private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    try {
      const raw = await readFile(this.config.hermesAgentTokenFile, 'utf8');
      const token = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
      if (!isValidHermesAgentToken(token) || (raw !== token && raw !== `${token}\n`)) {
        throw new Error('Hermes Agent Token file is invalid');
      }
      this.token = token;
    } catch (err: unknown) {
      if (isNotFound(err)) {
        this.token = this.config.hermesAgentToken;
        return;
      }
      throw err;
    }
  }

  get(): string | undefined {
    return this.token;
  }

  async set(token: string): Promise<void> {
    if (!isValidHermesAgentToken(token)) {
      throw new Error('Hermes Agent Token is invalid');
    }

    const target = this.config.hermesAgentTokenFile;
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(target), { recursive: true });

    try {
      await writeFile(temporary, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      this.token = token;
    } catch (err: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw err;
    }
  }
}

export function isValidHermesAgentToken(value: string): boolean {
  return HERMES_AGENT_TOKEN_PATTERN.test(value);
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}
