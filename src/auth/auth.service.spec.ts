import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { jest } from '@jest/globals';
import { createHash, createHmac } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { AuthService } from './auth.service';

const SECRET = 'mobile-auth-unit-test-secret-that-is-long-enough';
const REFRESH_TOKEN = 'initial-refresh-token';
const TOKEN_HASH = (token: string) =>
  createHash('sha256').update(token).digest('hex');
const ROTATION_KEY = createHmac('sha256', SECRET)
  .update('installment-pro/mobile-refresh-token/v1')
  .digest();
const ROTATE_TOKEN = (token: string, fromId: string, toId: string) =>
  createHmac('sha256', ROTATION_KEY)
    .update(`${fromId}:${toId}:${token}`)
    .digest('base64url');

describe('AuthService mobile sessions', () => {
  const shop = {
    id: 'shop-1',
    shopName: 'Test Shop',
    ownerName: 'Test Owner',
    mobile: '03001234567',
    passwordHash: '',
    profilePic: null,
    status: 'active',
    pendingDeletionAt: null,
    tokenVersion: 3,
  };
  const tx = {
    shopRefreshToken: {
      findUnique: jest.fn(async (): Promise<unknown> => null),
      count: jest.fn(async (): Promise<number> => 1),
      updateMany: jest.fn(async (): Promise<unknown> => ({ count: 1 })),
      create: jest.fn(
        async (_args: {
          data: Record<string, unknown>;
        }): Promise<unknown> => ({}),
      ),
    },
  };
  const transaction = jest.fn(
    async <T>(operation: (client: typeof tx) => Promise<T>) => operation(tx),
  );
  const prisma = {
    shop: { findUnique: jest.fn(async (): Promise<unknown> => shop) },
    shopRefreshToken: {
      create: jest.fn(
        async (_args: {
          data: Record<string, unknown>;
        }): Promise<unknown> => ({}),
      ),
    },
    $transaction: transaction,
  };
  const jwt = new JwtService({ secret: SECRET });
  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt,
    {} as StorageService,
    { getOrThrow: () => SECRET } as ConfigService,
  );

  beforeAll(async () => {
    shop.passwordHash = await bcrypt.hash('test-password', 4);
  });

  beforeEach(() => {
    prisma.shop.findUnique.mockReset().mockResolvedValue(shop);
    prisma.shopRefreshToken.create.mockReset().mockResolvedValue({});
    tx.shopRefreshToken.findUnique.mockReset().mockResolvedValue(null);
    tx.shopRefreshToken.count.mockReset().mockResolvedValue(1);
    tx.shopRefreshToken.updateMany.mockReset().mockResolvedValue({ count: 1 });
    tx.shopRefreshToken.create.mockReset().mockResolvedValue({});
    transaction.mockClear();
  });

  it('creates a hashed refresh token with 30-day idle and 90-day absolute expiry', async () => {
    const startedAt = Date.now();
    const response = await service.mobileShopLogin({
      mobile: '0300-1234567',
      password: 'test-password',
      deviceName: 'Test phone',
    });
    const finishedAt = Date.now();
    const created = prisma.shopRefreshToken.create.mock.calls[0][0].data as {
      tokenHash: string;
      deviceName: string | null;
      tokenVersion: number;
      expiresAt: Date;
      sessionExpiresAt: Date;
    };

    expect(response.status).toBe('success');
    expect(response.data.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.tokenHash).toBe(TOKEN_HASH(response.data.refresh_token));
    expect(created.tokenHash).not.toBe(response.data.refresh_token);
    expect(created.deviceName).toBe('Test phone');
    expect(created.tokenVersion).toBe(shop.tokenVersion);
    expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(
      startedAt + 30 * 24 * 60 * 60 * 1000,
    );
    expect(created.expiresAt.getTime()).toBeLessThanOrEqual(
      finishedAt + 30 * 24 * 60 * 60 * 1000,
    );
    expect(created.sessionExpiresAt.getTime()).toBeGreaterThanOrEqual(
      startedAt + 90 * 24 * 60 * 60 * 1000,
    );
    expect(response.data.expires_in).toBe(900);
  });

  it('rotates a refresh token and returns the same next token for a grace-window retry', async () => {
    const now = new Date();
    const session = {
      id: 'previous-id',
      shopId: shop.id,
      tokenHash: TOKEN_HASH(REFRESH_TOKEN),
      familyId: 'family-1',
      tokenVersion: shop.tokenVersion,
      expiresAt: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000),
      sessionExpiresAt: new Date(now.getTime() + 80 * 24 * 60 * 60 * 1000),
      revokedAt: null,
      replacedById: null,
      refreshRetryUntil: null,
      deviceName: 'Test phone',
      lastUsedAt: null,
      shop,
    };

    tx.shopRefreshToken.findUnique.mockResolvedValueOnce(session);
    const first = await service.refreshShopSession(REFRESH_TOKEN);
    const successorId = tx.shopRefreshToken.create.mock.calls[0][0].data
      .id as string;
    const nextToken = first.data.refresh_token;
    expect(nextToken).toBe(
      ROTATE_TOKEN(REFRESH_TOKEN, 'previous-id', successorId),
    );

    tx.shopRefreshToken.findUnique
      .mockResolvedValueOnce({
        ...session,
        replacedById: successorId,
        refreshRetryUntil: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce({
        id: successorId,
        tokenHash: TOKEN_HASH(nextToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        sessionExpiresAt: session.sessionExpiresAt,
        revokedAt: null,
        replacedById: null,
      });

    const retry = await service.refreshShopSession(REFRESH_TOKEN);

    expect(retry.data.refresh_token).toBe(nextToken);
    expect(first.data.access_token).toBeTruthy();
    expect(retry.data.access_token).toBeTruthy();
    expect(tx.shopRefreshToken.create).toHaveBeenCalledTimes(1);
  });

  it('returns the latest active token when a grace retry follows another rotation', async () => {
    const sessionExpiresAt = new Date(Date.now() + 80 * 24 * 60 * 60 * 1000);
    const firstToken = ROTATE_TOKEN(REFRESH_TOKEN, 'first-id', 'second-id');
    const newestToken = ROTATE_TOKEN(firstToken, 'second-id', 'third-id');
    const previous = {
      id: 'first-id',
      shopId: shop.id,
      tokenHash: TOKEN_HASH(REFRESH_TOKEN),
      familyId: 'family-chain',
      tokenVersion: shop.tokenVersion,
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      sessionExpiresAt,
      revokedAt: new Date(),
      replacedById: 'second-id',
      refreshRetryUntil: new Date(Date.now() + 60_000),
      deviceName: null,
      lastUsedAt: new Date(),
      shop,
    };
    tx.shopRefreshToken.findUnique
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce({
        id: 'second-id',
        replacedById: 'third-id',
        revokedAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: 'third-id',
        replacedById: null,
        revokedAt: null,
        tokenHash: TOKEN_HASH(newestToken),
        expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        sessionExpiresAt,
      });

    const response = await service.refreshShopSession(REFRESH_TOKEN);

    expect(response.data.refresh_token).toBe(newestToken);
  });

  it('revokes the whole token family if a rotated token is replayed after grace', async () => {
    const session = {
      id: 'previous-id',
      shopId: shop.id,
      tokenHash: TOKEN_HASH(REFRESH_TOKEN),
      familyId: 'family-1',
      tokenVersion: shop.tokenVersion,
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      sessionExpiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
      revokedAt: new Date(),
      replacedById: 'next-id',
      refreshRetryUntil: new Date(Date.now() - 1),
      deviceName: null,
      lastUsedAt: new Date(),
      shop,
    };
    tx.shopRefreshToken.findUnique
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce({
        id: 'next-id',
        tokenHash: TOKEN_HASH('next-token'),
        expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        sessionExpiresAt: session.sessionExpiresAt,
        revokedAt: null,
        replacedById: null,
      });

    await expect(service.refreshShopSession(REFRESH_TOKEN)).rejects.toThrow(
      'Aap ka mobile session khatam ho gaya, dobara login karein',
    );
    expect(tx.shopRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('revokes mobile sessions when a shop is no longer active', async () => {
    const session = {
      id: 'current-id',
      shopId: shop.id,
      tokenHash: TOKEN_HASH(REFRESH_TOKEN),
      familyId: 'family-2',
      tokenVersion: shop.tokenVersion,
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      sessionExpiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
      revokedAt: null,
      replacedById: null,
      refreshRetryUntil: null,
      deviceName: null,
      lastUsedAt: null,
      shop: { ...shop, status: 'inactive' },
    };
    tx.shopRefreshToken.findUnique.mockResolvedValueOnce(session);

    await expect(service.refreshShopSession(REFRESH_TOKEN)).rejects.toThrow(
      'Aap ka mobile session khatam ho gaya, dobara login karein',
    );
    expect(tx.shopRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-2', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('revokes mobile sessions when the shop token version changes', async () => {
    const session = {
      id: 'current-id',
      shopId: shop.id,
      tokenHash: TOKEN_HASH(REFRESH_TOKEN),
      familyId: 'family-version',
      tokenVersion: shop.tokenVersion,
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      sessionExpiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
      revokedAt: null,
      replacedById: null,
      refreshRetryUntil: null,
      deviceName: null,
      lastUsedAt: null,
      shop: { ...shop, tokenVersion: shop.tokenVersion + 1 },
    };
    tx.shopRefreshToken.findUnique.mockResolvedValueOnce(session);

    await expect(service.refreshShopSession(REFRESH_TOKEN)).rejects.toThrow(
      'Aap ka mobile session khatam ho gaya, dobara login karein',
    );
    expect(tx.shopRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-version', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('revokes every token in the session family on logout', async () => {
    tx.shopRefreshToken.findUnique.mockResolvedValueOnce({
      familyId: 'family-logout',
    });

    await expect(service.logoutShopSession(REFRESH_TOKEN)).resolves.toEqual({
      status: 'success',
      data: { ok: true },
    });
    expect(tx.shopRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-logout', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('derives retry tokens with a keyed hash rather than storing their plaintext', () => {
    const key = createHmac('sha256', SECRET)
      .update('installment-pro/mobile-refresh-token/v1')
      .digest();
    const derived = createHmac('sha256', key)
      .update('previous-id:next-id:old-token')
      .digest('base64url');

    expect(derived).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
