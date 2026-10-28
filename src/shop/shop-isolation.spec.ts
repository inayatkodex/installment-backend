import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminGuard } from '../common/guards/admin.guard';
import { ShopGuard } from '../common/guards/shop.guard';
import { AuditModule } from '../common/audit/audit.module';
import { StorageModule } from '../common/storage/storage.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { ShopService } from './shop.service';

describe('Shop Data Isolation & Authorization Guards (PostgreSQL Integration)', () => {
  let module: TestingModule;
  let shopService: ShopService;
  let prisma: PrismaService;
  let jwt: JwtService;
  let shopGuard: ShopGuard;
  let adminGuard: AdminGuard;

  let shopAId: string;
  let shopBId: string;
  let customerAId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.register({ secret: 'test-jwt-secret-key-12345678901234567890' }),
        PrismaModule,
        AuditModule,
        StorageModule,
      ],
      providers: [ShopService, ShopGuard, AdminGuard],
    }).compile();

    shopService = module.get<ShopService>(ShopService);
    prisma = module.get<PrismaService>(PrismaService);
    jwt = module.get<JwtService>(JwtService);
    shopGuard = module.get<ShopGuard>(ShopGuard);
    adminGuard = module.get<AdminGuard>(AdminGuard);

    // Create Shop A (active)
    const shopA = await prisma.shop.create({
      data: {
        shopName: 'Shop Alpha',
        ownerName: 'Alpha Owner',
        mobile: `0388${Math.floor(1000000 + Math.random() * 9000000)}`,
        cnic: '35202-1111111-1',
        city: 'Lahore',
        address: 'Alpha St',
        passwordHash: 'hash',
        status: 'active',
      },
    });
    shopAId = shopA.id;

    // Create Shop B (active)
    const shopB = await prisma.shop.create({
      data: {
        shopName: 'Shop Beta',
        ownerName: 'Beta Owner',
        mobile: `0388${Math.floor(1000000 + Math.random() * 9000000)}`,
        cnic: '35202-2222222-2',
        city: 'Rawalpindi',
        address: 'Beta St',
        passwordHash: 'hash',
        status: 'active',
      },
    });
    shopBId = shopB.id;

    // Create Customer belonging to Shop A
    const custA = await prisma.customer.create({
      data: {
        shopId: shopAId,
        customerNo: 101,
        name: 'Alpha Customer',
        phone: '03001112233',
        downPayment: 2000,
        initialMonthlyPayment: 1334,
        monthlyPayment: 1334,
        firstDueDate: '2026-11-01',
        items: {
          create: [{ name: 'LED TV', price: 10000, boughtOn: '2026-10-27' }],
        },
      },
    });
    customerAId = custA.id;
  });

  afterAll(async () => {
    if (shopAId) await prisma.shop.delete({ where: { id: shopAId } }).catch(() => {});
    if (shopBId) await prisma.shop.delete({ where: { id: shopBId } }).catch(() => {});
    if (module) await module.close();
  });

  describe('1. Cross-Shop Data Isolation', () => {
    it('Shop B cannot view Customer A details', async () => {
      await expect(
        shopService.getCustomer(shopBId, customerAId),
      ).rejects.toThrow(NotFoundException);
    });

    it('Shop B cannot receive payment for Customer A', async () => {
      await expect(
        shopService.receivePayment(shopBId, {
          customerId: customerAId,
          amount: 1000,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('Shop B cannot update Customer A', async () => {
      await expect(
        shopService.updateCustomer(shopBId, customerAId, { name: 'Hacked Name' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('Shop B cannot delete Customer A', async () => {
      await expect(
        shopService.deleteCustomer(shopBId, customerAId),
      ).rejects.toThrow(NotFoundException);
    });

    it('Shop B customer list does not include Shop A customers', async () => {
      const res = await shopService.listCustomers(shopBId, {});
      expect(res.data.some((c) => c.id === customerAId)).toBe(false);
    });
  });

  describe('2. ShopGuard Active/Inactive Status Enforcement', () => {
    const makeContext = (token?: string) => ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {
            authorization: token ? `Bearer ${token}` : undefined,
          },
        }),
      }),
    }) as any;

    it('rejects request with no token', async () => {
      await expect(shopGuard.canActivate(makeContext())).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects admin token attempting to access shop endpoint', async () => {
      const adminToken = await jwt.signAsync({ sub: 'admin-id', role: 'admin' });
      await expect(
        shopGuard.canActivate(makeContext(adminToken)),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects shopkeeper if shop status is inactive', async () => {
      const inactiveShop = await prisma.shop.create({
        data: {
          shopName: 'Inactive Shop',
          ownerName: 'Owner',
          mobile: `0388${Math.floor(1000000 + Math.random() * 9000000)}`,
          cnic: '35202-3333333-3',
          city: 'Lahore',
          address: 'St 3',
          passwordHash: 'hash',
          status: 'inactive',
        },
      });

      const token = await jwt.signAsync({ sub: inactiveShop.id, role: 'shop' });

      await expect(
        shopGuard.canActivate(makeContext(token)),
      ).rejects.toThrow('Aap ka account active nahi hai. Admin se rabta karein.');

      await prisma.shop.delete({ where: { id: inactiveShop.id } });
    });

    it('allows active shopkeeper', async () => {
      const token = await jwt.signAsync({ sub: shopAId, role: 'shop' });
      const can = await shopGuard.canActivate(makeContext(token));
      expect(can).toBe(true);
    });
  });

  describe('3. AdminGuard Database Existence & Role Enforcement', () => {
    const makeContext = (token?: string) => ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {
            authorization: token ? `Bearer ${token}` : undefined,
          },
        }),
      }),
    }) as any;

    it('rejects shop token on admin endpoint', async () => {
      const shopToken = await jwt.signAsync({ sub: shopAId, role: 'shop' });
      await expect(
        adminGuard.canActivate(makeContext(shopToken)),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects token of an admin that does not exist in database', async () => {
      const nonExistentAdminToken = await jwt.signAsync({
        sub: '00000000-0000-0000-0000-000000000000',
        role: 'admin',
      });
      await expect(
        adminGuard.canActivate(makeContext(nonExistentAdminToken)),
      ).rejects.toThrow('Admin account not found');
    });

    it('allows verified admin present in database and attaches adminId', async () => {
      const admin = await prisma.admin.create({
        data: {
          name: 'Super Admin',
          email: `admin_${Date.now()}@installmentpro.pk`,
          passwordHash: 'hash',
        },
      });

      const token = await jwt.signAsync({ sub: admin.id, role: 'admin' });
      const req: any = { headers: { authorization: `Bearer ${token}` } };
      const ctx = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as any;

      const can = await adminGuard.canActivate(ctx);
      expect(can).toBe(true);
      expect(req.adminId).toBe(admin.id);

      await prisma.admin.delete({ where: { id: admin.id } });
    });
  });
});
