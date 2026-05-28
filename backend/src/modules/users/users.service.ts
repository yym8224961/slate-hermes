import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { ConflictError } from '../../common/errors';
import { PrismaService } from '../../infra/prisma/prisma.service';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface UserRecord {
  id: string;
  email: string;
  username: string | null;
  password: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, username: true, password: true },
    });
  }

  /** 支持邮箱或用户名登录 */
  async findByIdentifier(identifier: string): Promise<UserRecord | null> {
    if (EMAIL_RE.test(identifier)) {
      return (
        (await this.findByEmail(identifier)) ??
        (await this.prisma.user.findUnique({
          where: { username: identifier },
          select: { id: true, email: true, username: true, password: true },
        }))
      );
    }
    return this.prisma.user.findUnique({
      where: { username: identifier },
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
    const hash = await bcrypt.hash(password, 10);
    try {
      return await this.prisma.user.create({
        data: { email, username, password: hash },
        select: { id: true, email: true, username: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        if (uniqueTargetIncludes(err, 'email')) {
          throw new ConflictError('该邮箱已被注册', { code: 'email_already_registered' });
        }
        if (uniqueTargetIncludes(err, 'username')) {
          throw new ConflictError('该用户名已被占用', { code: 'username_already_taken' });
        }
      }
      throw err;
    }
  }
}

function uniqueTargetIncludes(err: Prisma.PrismaClientKnownRequestError, field: string): boolean {
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === 'string' && target.includes(field);
}
