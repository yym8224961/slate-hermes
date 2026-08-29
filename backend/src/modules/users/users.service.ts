import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { ConflictError, ForbiddenError, ValidationError } from '../../common/errors';
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

  async isAdmin(id: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { isAdmin: true },
    });
    return user?.isAdmin === true;
  }

  /**
   * Public registration is only the one-time bootstrap path.  The serializable
   * transaction prevents two concurrent requests from creating two admins.
   */
  async createInitialAdmin(
    email: string,
    username: string,
    password: string
  ): Promise<{ id: string; email: string; username: string | null }> {
    const hash = await bcrypt.hash(password, PASSWORD_HASH_COST);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.user.findFirst({ select: { id: true } });
          if (existing) {
            throw new ForbiddenError('管理员账号已创建，公开注册已关闭', {
              code: 'registration_closed',
            });
          }
          return tx.user.create({
            data: { email, username, password: hash, isAdmin: true },
            select: { id: true, email: true, username: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (err) {
      if (err instanceof ForbiddenError) throw err;
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2034') {
          throw new ForbiddenError('管理员账号已创建，公开注册已关闭', {
            code: 'registration_closed',
          });
        }
        this.mapUniqueConflict(err);
      }
      throw err;
    }
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
        this.mapUniqueConflict(err);
      }
      throw err;
    }
  }

  private mapUniqueConflict(err: Prisma.PrismaClientKnownRequestError): never | void {
    if (prismaUniqueTargetIncludes(err, 'email')) {
      throw new ConflictError('该邮箱已被注册', { code: 'email_already_registered' });
    }
    if (prismaUniqueTargetIncludes(err, 'username')) {
      throw new ConflictError('该用户名已被占用', { code: 'username_already_taken' });
    }
  }
}
