import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopGuard } from './shop.guard';

describe('ShopGuard session version', () => {
  const shopId = 'shop-session-test';
  const jwt = new JwtService({ secret: 'shop-guard-unit-test-secret' });
  const findUnique = jest.fn();
  const guard = new ShopGuard(
    jwt,
    { shop: { findUnique } } as unknown as PrismaService,
  );

  const context = (token: string) => {
    const request = {
      headers: { authorization: `Bearer ${token}` },
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    findUnique.mockReset();
    findUnique.mockResolvedValue({
      status: 'active',
      pendingDeletionAt: null,
      tokenVersion: 2,
    });
  });

  it('rejects a token issued before the shop token version changed', async () => {
    const token = await jwt.signAsync({
      sub: shopId,
      role: 'shop',
      sessionVersion: 1,
    });

    await expect(guard.canActivate(context(token))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('allows a token with the current shop token version', async () => {
    const token = await jwt.signAsync({
      sub: shopId,
      role: 'shop',
      sessionVersion: 2,
    });

    await expect(guard.canActivate(context(token))).resolves.toBe(true);
  });
});
