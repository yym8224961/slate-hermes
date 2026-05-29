import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { AppConfig } from '../config/app.config';

function makeAdapter(databaseUrl: string, allowPublicKeyRetrieval: boolean): PrismaMariaDb {
  const url = new URL(databaseUrl);
  const hasPublicKeyRetrieval = [...url.searchParams.keys()].some(
    (key) => key.toLowerCase() === 'allowpublickeyretrieval'
  );
  if (allowPublicKeyRetrieval && !hasPublicKeyRetrieval) {
    url.searchParams.set('allowPublicKeyRetrieval', 'true');
  }
  return new PrismaMariaDb(url.toString());
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: AppConfig) {
    super({
      adapter: makeAdapter(config.databaseUrl, config.dbAllowPublicKeyRetrieval),
      log: config.isProd ? ['error'] : ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
