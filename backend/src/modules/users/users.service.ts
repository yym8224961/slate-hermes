import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { ConflictError } from '../../common/errors';
import { PrismaService } from '../../infra/prisma/prisma.service';

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
    // 包含 @ 优先当邮箱处理，否则当用户名
    if (identifier.includes('@')) {
      return this.findByEmail(identifier);
    }
    return this.prisma.user.findUnique({
      where: { username: identifier },
      select: { id: true, email: true, username: true, password: true },
    });
  }

  async findById(id: string): Promise<{ id: string; email: string; username: string | null } | null> {
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
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new ConflictError('email already registered');
    const existingUsername = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (existingUsername) throw new ConflictError('username already taken');
    const hash = await bcrypt.hash(password, 10);
    return this.prisma.user.create({
      data: { email, username, password: hash },
      select: { id: true, email: true, username: true },
    });
  }
}
