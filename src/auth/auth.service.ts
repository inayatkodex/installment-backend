import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { AdminLoginDto } from './dto/admin-login.dto';
import { MobileShopLoginDto } from './dto/mobile-shop-login.dto';
import { ShopLoginDto } from './dto/shop-login.dto';
import { ShopSignupDto } from './dto/shop-signup.dto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';

const MOBILE_ACCESS_TOKEN_TTL = '15m';
const MOBILE_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MOBILE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_RETRY_GRACE_MS = 60 * 1000;

@Injectable()
export class AuthService {
  private readonly refreshSigningKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.refreshSigningKey = createHmac(
      'sha256',
      config.getOrThrow<string>('JWT_SECRET'),
    )
      .update('installment-pro/mobile-refresh-token/v1')
      .digest();
  }

  // "0300-1234567" aur "03001234567" ko ek jaisa banata hai
  private digits(value: string) {
    return value.replace(/\D/g, '');
  }

  private token(
    sub: string,
    role: 'shop' | 'admin',
    rememberMe?: boolean,
    sessionVersion = 0,
  ) {
    return this.jwt.signAsync(
      { sub, role, ...(role === 'shop' && { sessionVersion }) },
      { expiresIn: rememberMe ? '7d' : '1d' },
    );
  }

  /* ---------------- SHOP SIGNUP ---------------- */
  async shopSignup(dto: ShopSignupDto) {
    const mobile = this.digits(dto.mobile);

    const exists = await this.prisma.shop.findUnique({ where: { mobile } });
    if (exists)
      throw new ConflictException('Yeh mobile number pehle se registered hai');

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const profilePic = await this.storage.saveBase64(dto.profilePic, 'shops');

    try {
      await this.prisma.shop.create({
        data: {
          shopName: dto.shopName.trim(),
          ownerName: dto.ownerName.trim(),
          mobile,
          email: dto.email?.trim().toLowerCase() || null,
          cnic: dto.cnic.trim(),
          city: dto.city.trim(),
          address: dto.address.trim(),
          passwordHash,
          profilePic,
          // status default: pending (admin approve karega)
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException(
          'Yeh mobile number pehle se registered hai',
        );
      }
      throw e;
    }

    return {
      status: 'success',
      message: 'Registration ho gayi. Admin approve karega to login ho jayega.',
      data: null,
    };
  }

  // Dummy hash used for constant-time comparison when an account is not found
  private readonly DUMMY_HASH =
    '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';

  /* ---------------- SHOP LOGIN ---------------- */
  async shopLogin(dto: ShopLoginDto) {
    const shop = await this.prisma.shop.findUnique({
      where: { mobile: this.digits(dto.mobile) },
    });

    const hashToCompare = shop?.passwordHash || this.DUMMY_HASH;
    const passwordOk = await bcrypt.compare(dto.password, hashToCompare);
    if (!shop || !passwordOk) {
      throw new UnauthorizedException(
        'Mobile number ya password sahi nahi hai',
      );
    }

    if (shop.status === 'pending') {
      throw new ForbiddenException(
        'Aap ki registration abhi pending hai. Admin approve karega to login ho jayega.',
      );
    }
    if (shop.status === 'archived') {
      throw new ForbiddenException(
        'Aap ka account archive ho chuka hai. Admin se rabta karein.',
      );
    }
    if (shop.status === 'inactive') {
      throw new ForbiddenException(
        'Aap ka account band hai. Admin se rabta karein.',
      );
    }

    return {
      status: 'success',
      data: {
        access_token: await this.token(
          shop.id,
          'shop',
          dto.rememberMe,
          shop.tokenVersion,
        ),
        user: {
          id: shop.id,
          shopName: shop.shopName,
          ownerName: shop.ownerName,
          mobile: shop.mobile,
          profilePic: shop.profilePic,
        },
      },
    };
  }

  async mobileShopLogin(dto: MobileShopLoginDto) {
    const shop = await this.prisma.shop.findUnique({
      where: { mobile: this.digits(dto.mobile) },
    });

    const hashToCompare = shop?.passwordHash || this.DUMMY_HASH;
    const passwordOk = await bcrypt.compare(dto.password, hashToCompare);
    if (!shop || !passwordOk) {
      throw new UnauthorizedException(
        'Mobile number ya password sahi nahi hai',
      );
    }

    if (shop.status !== 'active' || shop.pendingDeletionAt) {
      throw new ForbiddenException(
        'Aap ka account active nahi hai. Admin se rabta karein.',
      );
    }

    const now = new Date();
    const sessionExpiresAt = new Date(now.getTime() + MOBILE_SESSION_TTL_MS);
    const refreshExpiresAt = new Date(
      Math.min(
        now.getTime() + MOBILE_REFRESH_TOKEN_TTL_MS,
        sessionExpiresAt.getTime(),
      ),
    );
    const refreshToken = randomBytes(32).toString('base64url');

    await this.prisma.shopRefreshToken.create({
      data: {
        shopId: shop.id,
        tokenHash: this.hashRefreshToken(refreshToken),
        familyId: randomUUID(),
        tokenVersion: shop.tokenVersion,
        expiresAt: refreshExpiresAt,
        sessionExpiresAt,
        deviceName: dto.deviceName?.trim() || null,
      },
    });

    return this.mobileSessionResponse(
      shop,
      refreshToken,
      refreshExpiresAt,
      sessionExpiresAt,
    );
  }

  async refreshShopSession(refreshToken: string) {
    const tokenHash = this.hashRefreshToken(refreshToken);
    const result = await this.prisma.$transaction(async (tx) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const session = await tx.shopRefreshToken.findUnique({
          where: { tokenHash },
          include: {
            shop: {
              select: {
                id: true,
                shopName: true,
                ownerName: true,
                mobile: true,
                profilePic: true,
                status: true,
                pendingDeletionAt: true,
                tokenVersion: true,
              },
            },
          },
        });

        if (!session) return { kind: 'invalid' as const };

        const now = new Date();
        if (session.sessionExpiresAt <= now) {
          return { kind: 'invalid' as const };
        }

        if (
          !this.isMobileSessionShopUsable(session.shop, session.tokenVersion)
        ) {
          await tx.shopRefreshToken.updateMany({
            where: { familyId: session.familyId, revokedAt: null },
            data: { revokedAt: now },
          });
          return { kind: 'invalid' as const };
        }

        if (session.replacedById) {
          let successor = await tx.shopRefreshToken.findUnique({
            where: { id: session.replacedById },
          });
          let retryToken = this.deriveRotatedRefreshToken(
            refreshToken,
            session.id,
            session.replacedById,
          );
          while (successor?.replacedById) {
            const next = await tx.shopRefreshToken.findUnique({
              where: { id: successor.replacedById },
            });
            if (!next) {
              successor = null;
              break;
            }
            retryToken = this.deriveRotatedRefreshToken(
              retryToken,
              successor.id,
              next.id,
            );
            successor = next;
          }
          const familyHasActiveToken =
            (await tx.shopRefreshToken.count({
              where: { familyId: session.familyId, revokedAt: null },
            })) > 0;
          const retryIsSafe =
            session.refreshRetryUntil !== null &&
            now <= session.refreshRetryUntil &&
            successor !== null &&
            familyHasActiveToken &&
            successor.tokenHash === this.hashRefreshToken(retryToken) &&
            successor.expiresAt > now &&
            successor.sessionExpiresAt > now &&
            successor.revokedAt === null &&
            successor.replacedById === null;

          if (retryIsSafe && successor !== null) {
            return {
              kind: 'success' as const,
              shop: session.shop,
              refreshToken: retryToken,
              expiresAt: successor.expiresAt,
              sessionExpiresAt: successor.sessionExpiresAt,
            };
          }

          await tx.shopRefreshToken.updateMany({
            where: { familyId: session.familyId, revokedAt: null },
            data: { revokedAt: now },
          });
          return { kind: 'invalid' as const };
        }

        if (session.revokedAt || session.expiresAt <= now) {
          return { kind: 'invalid' as const };
        }

        const nextId = randomUUID();
        const nextToken = this.deriveRotatedRefreshToken(
          refreshToken,
          session.id,
          nextId,
        );
        const claimed = await tx.shopRefreshToken.updateMany({
          where: {
            id: session.id,
            revokedAt: null,
            replacedById: null,
            expiresAt: { gt: now },
            sessionExpiresAt: { gt: now },
          },
          data: {
            revokedAt: now,
            replacedById: nextId,
            refreshRetryUntil: new Date(now.getTime() + REFRESH_RETRY_GRACE_MS),
            lastUsedAt: now,
          },
        });

        if (claimed.count !== 1) continue;

        const expiresAt = new Date(
          Math.min(
            now.getTime() + MOBILE_REFRESH_TOKEN_TTL_MS,
            session.sessionExpiresAt.getTime(),
          ),
        );
        await tx.shopRefreshToken.create({
          data: {
            id: nextId,
            shopId: session.shopId,
            tokenHash: this.hashRefreshToken(nextToken),
            familyId: session.familyId,
            tokenVersion: session.tokenVersion,
            expiresAt,
            sessionExpiresAt: session.sessionExpiresAt,
            deviceName: session.deviceName,
          },
        });

        return {
          kind: 'success' as const,
          shop: session.shop,
          refreshToken: nextToken,
          expiresAt,
          sessionExpiresAt: session.sessionExpiresAt,
        };
      }

      return { kind: 'invalid' as const };
    });

    if (result.kind !== 'success') {
      throw new UnauthorizedException(
        'Aap ka mobile session khatam ho gaya, dobara login karein',
      );
    }

    return this.mobileSessionResponse(
      result.shop,
      result.refreshToken,
      result.expiresAt,
      result.sessionExpiresAt,
    );
  }

  async logoutShopSession(refreshToken: string) {
    await this.prisma.$transaction(async (tx) => {
      const session = await tx.shopRefreshToken.findUnique({
        where: { tokenHash: this.hashRefreshToken(refreshToken) },
        select: { familyId: true },
      });
      if (!session) return;
      await tx.shopRefreshToken.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    return { status: 'success', data: { ok: true } };
  }

  private hashRefreshToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private deriveRotatedRefreshToken(
    currentToken: string,
    currentId: string,
    nextId: string,
  ) {
    return createHmac('sha256', this.refreshSigningKey)
      .update(`${currentId}:${nextId}:${currentToken}`)
      .digest('base64url');
  }

  private isMobileSessionShopUsable(
    shop: {
      status: string;
      pendingDeletionAt: Date | null;
      tokenVersion: number;
    },
    sessionTokenVersion: number,
  ) {
    return (
      shop.status === 'active' &&
      shop.pendingDeletionAt === null &&
      shop.tokenVersion === sessionTokenVersion
    );
  }

  private mobileSessionResponse(
    shop: {
      id: string;
      shopName: string;
      ownerName: string;
      mobile: string;
      profilePic: string | null;
      tokenVersion: number;
    },
    refreshToken: string,
    refreshExpiresAt: Date,
    sessionExpiresAt: Date,
  ) {
    return this.jwt
      .signAsync(
        {
          sub: shop.id,
          role: 'shop',
          sessionVersion: shop.tokenVersion,
        },
        { expiresIn: MOBILE_ACCESS_TOKEN_TTL },
      )
      .then((accessToken) => ({
        status: 'success',
        data: {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: 15 * 60,
          refresh_expires_at: refreshExpiresAt.toISOString(),
          session_expires_at: sessionExpiresAt.toISOString(),
          user: {
            id: shop.id,
            shopName: shop.shopName,
            ownerName: shop.ownerName,
            mobile: shop.mobile,
            profilePic: shop.profilePic,
          },
        },
      }));
  }

  /* ---------------- ADMIN LOGIN ---------------- */
  async adminLogin(dto: AdminLoginDto) {
    const admin = await this.prisma.admin.findUnique({
      where: { email: dto.email.trim().toLowerCase() },
    });

    const hashToCompare = admin?.passwordHash || this.DUMMY_HASH;
    const passwordOk = await bcrypt.compare(dto.password, hashToCompare);
    if (!admin || !passwordOk) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return {
      status: 'success',
      data: {
        access_token: await this.token(admin.id, 'admin', dto.rememberMe),
        user: { id: admin.id, name: admin.name, email: admin.email },
      },
    };
  }
}
