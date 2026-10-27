import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
// import { PrismaService } from '../prisma/prisma.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { ShopLoginDto } from './dto/shop-login.dto';
import { ShopSignupDto } from './dto/shop-signup.dto';
import { PrismaService } from '../prisma/prisma.service';

import { StorageService } from '../common/storage/storage.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly storage: StorageService,
  ) {}

  // "0300-1234567" aur "03001234567" ko ek jaisa banata hai
  private digits(value: string) {
    return value.replace(/\D/g, '');
  }

  private token(sub: string, role: 'shop' | 'admin', rememberMe?: boolean) {
    return this.jwt.signAsync({ sub, role }, { expiresIn: rememberMe ? '7d' : '1d' });
  }

  /* ---------------- SHOP SIGNUP ---------------- */
  async shopSignup(dto: ShopSignupDto) {
    const mobile = this.digits(dto.mobile);

    const exists = await this.prisma.shop.findUnique({ where: { mobile } });
    if (exists) throw new ConflictException('Yeh mobile number pehle se registered hai');

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const [profilePic, docPhoto, docCnicFront, docCnicBack, docShopDocument] =
      await Promise.all([
        this.storage.saveBase64(dto.profilePic, 'shops'),
        this.storage.saveBase64(dto.documents?.photo, 'documents'),
        this.storage.saveBase64(dto.documents?.cnicFront, 'documents'),
        this.storage.saveBase64(dto.documents?.cnicBack, 'documents'),
        this.storage.saveBase64(dto.documents?.shopDocument, 'documents'),
      ]);

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
          docPhoto,
          docCnicFront,
          docCnicBack,
          docShopDocument,
          // status default: pending (admin approve karega)
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('Yeh mobile number pehle se registered hai');
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
      throw new UnauthorizedException('Mobile number ya password sahi nahi hai');
    }

    if (shop.status === 'pending') {
      throw new ForbiddenException(
        'Aap ki registration abhi pending hai. Admin approve karega to login ho jayega.',
      );
    }
    if (shop.status === 'archived') {
      throw new ForbiddenException('Aap ka account archive ho chuka hai. Admin se rabta karein.');
    }
    if (shop.status === 'inactive') {
      throw new ForbiddenException('Aap ka account band hai. Admin se rabta karein.');
    }

    return {
      status: 'success',
      data: {
        access_token: await this.token(shop.id, 'shop', dto.rememberMe),
        user: {
          id: shop.id,
          shopName: shop.shopName,
          ownerName: shop.ownerName,
          mobile: shop.mobile,
        },
      },
    };
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