import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { ConflictError, ValidationError } from '../../common/errors';
import { prismaUniqueTargetIncludes } from '../../common/db/prisma-utils';
import { PrismaService } from '../../infra/prisma/prisma.service';

const PASSWORD_HASH_COST = 12;

export interface UserRecord {
  id: string;
  email: string;
  username: string | null;
}

export interface UserRecordWithPassword extends UserRecord {
  password: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<UserRecordWithPassword | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, username: true, password: true },
    });
  }

  /** 支持邮箱或用户名登录 */
  async findByIdentifier(identifier: string): Promise<UserRecordWithPassword | null> {
    const normalized = identifier.trim();
    if (!normalized) {
      throw new ValidationError('账号不能为空', { code: 'identifier_empty' });
    }
    if (normalized.includes('@')) {
      return this.findByEmail(normalized);
    }
    return this.prisma.user.findUnique({
      where: { username: normalized },
      select: { id: true, email: true, username: true, password: true },
    });
  }

  async findById(
    id: string
  ): Promise<{ id: string; email: string; username: string | null } | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, username: true },
    });
  }

  async create(
    email: string,
    username: string,
    password: string
  ): Promise<{ id: string; email: string; username: string | null }> {
    const hash = await bcrypt.hash(password, PASSWORD_HASH_COST);
    try {
      return await this.prisma.user.create({
        data: { email, username, password: hash },
        select: { id: true, email: true, username: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        if (prismaUniqueTargetIncludes(err, 'email')) {
          throw new ConflictError('该邮箱已被注册', { code: 'email_already_registered' });
        }
        if (prismaUniqueTargetIncludes(err, 'username')) {
          throw new ConflictError('该用户名已被占用', { code: 'username_already_taken' });
        }
      }
      throw err;
    }
  }
}
