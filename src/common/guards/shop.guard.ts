import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ShopGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { shopId?: string }>();
    const [type, token] = req.headers.authorization?.split(' ') ?? [];

    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Pehle login karein');
    }

    let payload: { sub: string; role: string; sessionVersion?: number };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException(
        'Aap ka session khatam ho gaya, dobara login karein',
      );
    }

    if (payload.role !== 'shop') {
      throw new ForbiddenException('Yeh API sirf dukaandar ke liye hai');
    }

    const shop = await this.prisma.shop.findUnique({
      where: { id: payload.sub },
      select: {
        status: true,
        pendingDeletionAt: true,
        tokenVersion: true,
      },
    });
    if (!shop || shop.status !== 'active' || shop.pendingDeletionAt) {
      throw new UnauthorizedException(
        'Aap ka account active nahi hai. Admin se rabta karein.',
      );
    }
    if ((payload.sessionVersion ?? 0) !== shop.tokenVersion) {
      throw new UnauthorizedException(
        'Aap ka session khatam ho gaya, dobara login karein',
      );
    }

    req.shopId = payload.sub;
    return true;
  }
}
