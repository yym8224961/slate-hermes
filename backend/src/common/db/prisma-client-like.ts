import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../infra/prisma/prisma.service';

export type PrismaClientLike = Prisma.TransactionClient | PrismaService;
