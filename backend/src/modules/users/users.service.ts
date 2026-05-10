import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { ConflictError } from '../../common/errors';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface UserRecord {
  id: string;
  email: string;
  password: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, password: true },
    });
  }

  async findById(id: string): Promise<{ id: string; email: string } | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true },
    });
  }

  async create(email: string, password: string): Promise<{ id: string; email: string }> {
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw new ConflictError('email already registered');
    const hash = await bcrypt.hash(password, 10);
    return this.prisma.user.create({
      data: { email, password: hash },
      select: { id: true, email: true },
    });
  }
}
