import {
  BadRequestException,
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
import { DeletionCleanupService } from '../common/deletion-cleanup.service';
import { AdminService } from '../admin/admin.service';
import { currentMonth, nextMonth } from '../admin/admin.utils';
import { StorageModule } from '../common/storage/storage.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { ShopService } from './shop.service';

describe('Shop Data Isolation & Authorization Guards (PostgreSQL Integration)', () => {
  let module: TestingModule;
  let shopService: ShopService;
  let adminService: AdminService;
  let deletionCleanup: DeletionCleanupService;
  let prisma: PrismaService;
  let jwt: JwtService;
  let shopGuard: ShopGuard;
  let adminGuard: AdminGuard;

  let shopAId: string;
  let shopBId: string;
  let customerAId: string;
  let completedCustomerId: string;
  let deletableShopId: string;
  let deletableShopCustomerId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.register({
          secret: 'test-jwt-secret-key-12345678901234567890',
        }),
        PrismaModule,
        AuditModule,
        StorageModule,
      ],
      providers: [
        ShopService,
        AdminService,
        ShopGuard,
        AdminGuard,
        DeletionCleanupService,
      ],
    }).compile();

    shopService = module.get<ShopService>(ShopService);
    adminService = module.get<AdminService>(AdminService);
    deletionCleanup = module.get<DeletionCleanupService>(
      DeletionCleanupService,
    );
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

    const deletableShop = await prisma.shop.create({
      data: {
        shopName: 'Shop Gamma',
        ownerName: 'Gamma Owner',
        mobile: `0388${Math.floor(1000000 + Math.random() * 9000000)}`,
        cnic: '35202-3333333-3',
        city: 'Karachi',
        address: 'Gamma St',
        passwordHash: 'hash',
        status: 'active',
      },
    });
    deletableShopId = deletableShop.id;
    const deletableShopCustomer = await prisma.customer.create({
      data: {
        shopId: deletableShopId,
        customerNo: 1,
        name: 'Gamma Customer',
        phone: '03001234567',
        downPayment: 0,
        initialMonthlyPayment: 1000,
        monthlyPayment: 1000,
        firstDueDate: '2026-01-01',
      },
    });
    deletableShopCustomerId = deletableShopCustomer.id;
    await prisma.feeRecord.create({
      data: { shopId: deletableShopId, month: '2026-01' },
    });

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

    const completedCustomer = await prisma.customer.create({
      data: {
        shopId: shopAId,
        customerNo: 102,
        name: 'Completed Customer',
        fatherName: 'Customer Father',
        phone: '03002223344',
        cnic: '35202-4444444-5',
        downPayment: 4000,
        initialMonthlyPayment: 1000,
        monthlyPayment: 1000,
        firstDueDate: '2026-11-01',
        items: {
          create: [{ name: 'Paid item', price: 5000, boughtOn: '2026-10-27' }],
        },
        rateChanges: {
          create: [{ fromInstallmentNo: 1, monthlyPayment: 1000 }],
        },
        payments: {
          create: [{ amount: 1000, paidOn: new Date() }],
        },
        purchases: {
          create: [
            {
              downPayment: 2000,
              initialMonthlyPayment: 500,
              monthlyPayment: 500,
              firstDueDate: '2026-11-01',
              allocationStartInstallmentNo: 1,
              rateChanges: {
                create: [{ fromInstallmentNo: 1, monthlyPayment: 500 }],
              },
              items: {
                create: [
                  {
                    name: 'Paid purchase',
                    price: 2000,
                    boughtOn: '2026-10-28',
                  },
                ],
              },
            },
          ],
        },
      },
    });
    completedCustomerId = completedCustomer.id;
  });

  afterAll(async () => {
    if (shopAId)
      await prisma.shop.delete({ where: { id: shopAId } }).catch(() => {});
    if (shopBId)
      await prisma.shop.delete({ where: { id: shopBId } }).catch(() => {});
    if (deletableShopId)
      await prisma.shop
        .delete({ where: { id: deletableShopId } })
        .catch(() => {});
    if (module) await module.close();
  });

  describe('Per-shop monthly fee configuration', () => {
    it('sets fees for every shop status and applies later changes next month', async () => {
      for (const status of [
        'pending',
        'active',
        'inactive',
        'archived',
      ] as const) {
        const shop = await prisma.shop.create({
          data: {
            shopName: `Fee ${status} shop`,
            ownerName: 'Fee Test Owner',
            mobile: `0377${Math.floor(1000000 + Math.random() * 9000000)}`,
            cnic: `35202-${Math.floor(1000000 + Math.random() * 9000000)}-1`,
            city: 'Lahore',
            address: 'Fee Test Street',
            passwordHash: 'hash',
            status,
          },
        });

        try {
          const firstSet = await adminService.setMonthlyFee(
            shop.id,
            4000,
            'test-admin',
          );
          expect(firstSet.data.monthlyFee).toBe(4000);
          await expect(
            prisma.shopFeeRate.findUnique({
              where: {
                shopId_effectiveFromMonth: {
                  shopId: shop.id,
                  effectiveFromMonth: currentMonth(),
                },
              },
            }),
          ).resolves.toMatchObject({ amount: 4000 });

          const changed = await adminService.setMonthlyFee(
            shop.id,
            6000,
            'test-admin',
          );
          expect(changed.data.monthlyFee).toBe(4000);
          expect(changed.data.nextMonthlyFee).toBe(6000);
          expect(changed.data.feeChangeEffectiveMonth).toBe(
            nextMonth(currentMonth()),
          );
          expect(changed.data.status).toBe(status);
        } finally {
          await prisma.shop.delete({ where: { id: shop.id } });
        }
      }
    });
  });

  describe('1. Cross-Shop Data Isolation', () => {
    it('Shop B cannot view Customer A details', async () => {
      await expect(
        shopService.getCustomer(shopBId, customerAId),
      ).rejects.toThrow(NotFoundException);
    });

    describe('2. Admin shop deletion recovery window', () => {
      it('archives and hides a shop while preserving related data for Undo', async () => {
        await adminService.deleteShop(deletableShopId, 'test-admin');

        const shop = await prisma.shop.findUniqueOrThrow({
          where: { id: deletableShopId },
        });
        expect(shop.status).toBe('archived');
        expect(shop.pendingDeletionAt).not.toBeNull();
        expect(shop.deletionPreviousStatus).toBe('active');
        await expect(
          prisma.customer.count({ where: { id: deletableShopCustomerId } }),
        ).resolves.toBe(1);
        await expect(
          prisma.feeRecord.count({ where: { shopId: deletableShopId } }),
        ).resolves.toBe(1);
        const pending = await adminService.listPendingDeletion();
        expect(pending.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: deletableShopId }),
          ]),
        );
      });

      it('restores the original shop status within seven days', async () => {
        await adminService.undoDeleteShop(deletableShopId, 'test-admin');
        const restored = await prisma.shop.findUniqueOrThrow({
          where: { id: deletableShopId },
        });
        expect(restored.status).toBe('active');
        expect(restored.pendingDeletionAt).toBeNull();
        expect(restored.deletionPreviousStatus).toBeNull();
      });

      it('rejects restore and permanently deletes the shop after seven days', async () => {
        await adminService.deleteShop(deletableShopId, 'test-admin');
        await prisma.shop.update({
          where: { id: deletableShopId },
          data: {
            pendingDeletionAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
          },
        });
        await expect(
          adminService.undoDeleteShop(deletableShopId, 'test-admin'),
        ).rejects.toThrow(BadRequestException);
        const pending = await adminService.listPendingDeletion();
        expect(pending.data).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: deletableShopId }),
          ]),
        );
        await deletionCleanup.runCleanupNow();

        await expect(
          prisma.shop.findUnique({ where: { id: deletableShopId } }),
        ).resolves.toBeNull();
        await expect(
          prisma.customer.findUnique({
            where: { id: deletableShopCustomerId },
          }),
        ).resolves.toBeNull();
        await expect(
          prisma.feeRecord.count({ where: { shopId: deletableShopId } }),
        ).resolves.toBe(0);
        await expect(
          prisma.auditLog.findFirst({
            where: {
              entityType: 'Shop',
              entityId: deletableShopId,
              action: { not: 'SHOP_PERMANENTLY_DELETED' },
            },
          }),
        ).resolves.not.toBeNull();
        await expect(
          prisma.auditLog.findFirst({
            where: {
              entityType: 'Shop',
              entityId: deletableShopId,
              action: 'SHOP_PERMANENTLY_DELETED',
            },
          }),
        ).resolves.not.toBeNull();
      });
    });

    describe('1a. Customer deletion recovery window', () => {
      it('deletes any customer with an audit snapshot and hides it during the undo window', async () => {
        const customer = await prisma.customer.findUniqueOrThrow({
          where: { id: completedCustomerId },
          include: { payments: true },
        });
        const paymentId = customer.payments[0].id;

        await prisma.auditLog.createMany({
          data: [
            {
              actorType: 'shop',
              actorId: shopAId,
              action: 'PAYMENT_RECEIVED',
              entityType: 'Payment',
              entityId: paymentId,
              details: {
                customerId: completedCustomerId,
                customerName: customer.name,
              },
            },
            {
              actorType: 'shop',
              actorId: shopAId,
              action: 'CUSTOMER_UPDATED',
              entityType: 'Customer',
              entityId: completedCustomerId,
              details: { customerName: customer.name },
            },
          ],
        });

        await shopService.deleteCustomer(shopAId, completedCustomerId, {
          ip: '192.0.2.10',
        });

        const pending = await prisma.customer.findUniqueOrThrow({
          where: { id: completedCustomerId },
        });
        expect(pending.deletedAt).not.toBeNull();
        expect(pending.deletionRequestedAt).not.toBeNull();
        const deletionLog = await prisma.auditLog.findFirstOrThrow({
          where: {
            entityType: 'Customer',
            entityId: completedCustomerId,
            action: 'CUSTOMER_DELETED',
          },
        });
        expect(deletionLog.ipAddress).toBe('192.0.2.10');
        expect(deletionLog.details).toEqual(
          expect.objectContaining({
            snapshot: expect.objectContaining({
              code: 'C-0102',
              name: 'Completed Customer',
              fatherName: 'Customer Father',
              phone: '03002223344',
              cnicLast4: '4445',
              totalPrice: 7000,
              remaining: 0,
              totalPaid: 7000,
              paymentsCount: 1,
              itemNames: ['Paid item', 'Paid purchase'],
              archived: false,
              actor: { type: 'shop', id: shopAId },
              ip: '192.0.2.10',
            }),
          }),
        );
        await expect(
          prisma.customerItem.count({
            where: { customerId: completedCustomerId },
          }),
        ).resolves.toBeGreaterThan(0);
        await expect(
          prisma.payment.count({ where: { customerId: completedCustomerId } }),
        ).resolves.toBeGreaterThan(0);
        const pendingList = await shopService.listPendingDeletion(shopAId);
        expect(pendingList.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: completedCustomerId }),
          ]),
        );
        await expect(
          shopService.undoDeleteCustomer(shopBId, completedCustomerId),
        ).rejects.toThrow(NotFoundException);
        const otherShopPending = await shopService.listPendingDeletion(shopBId);
        expect(otherShopPending.data).not.toContainEqual(
          expect.objectContaining({ id: completedCustomerId }),
        );
      });

      it('restores a customer when Undo is requested before expiry', async () => {
        await shopService.undoDeleteCustomer(shopAId, completedCustomerId);
        const restored = await prisma.customer.findUniqueOrThrow({
          where: { id: completedCustomerId },
        });
        expect(restored.deletedAt).toBeNull();
        expect(restored.deletionRequestedAt).toBeNull();
      });

      it('purges files but retains customers with payments and all audit history', async () => {
        const customer = await prisma.customer.findUniqueOrThrow({
          where: { id: completedCustomerId },
          include: { payments: true },
        });
        const paymentId = customer.payments[0].id;
        await shopService.deleteCustomer(shopAId, completedCustomerId);
        await prisma.customer.update({
          where: { id: completedCustomerId },
          data: {
            deletionRequestedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
          },
        });
        await expect(
          shopService.undoDeleteCustomer(shopAId, completedCustomerId),
        ).rejects.toThrow(BadRequestException);
        const auditCountBefore = await prisma.auditLog.count({
          where: {
            OR: [
              { entityType: 'Payment', entityId: paymentId },
              { entityType: 'Customer', entityId: completedCustomerId },
            ],
          },
        });
        await deletionCleanup.runCleanupNow();

        const retained = await prisma.customer.findUniqueOrThrow({
          where: { id: completedCustomerId },
        });
        expect(retained.filesPurgedAt).not.toBeNull();
        expect(retained.photo).toBeNull();
        expect(retained.docCnicFront).toBeNull();
        expect(retained.docCnicBack).toBeNull();
        expect(retained.docOther).toBeNull();
        await expect(
          prisma.payment.count({ where: { customerId: completedCustomerId } }),
        ).resolves.toBeGreaterThan(0);
        await expect(
          prisma.customerPurchase.count({
            where: { customerId: completedCustomerId },
          }),
        ).resolves.toBeGreaterThan(0);
        await expect(
          prisma.auditLog.count({
            where: {
              OR: [
                { entityType: 'Payment', entityId: paymentId },
                { entityType: 'Customer', entityId: completedCustomerId },
              ],
            },
          }),
        ).resolves.toBe(auditCountBefore);
      });

      it('allows deletion of active and archived customers', async () => {
        const activeCustomer = await prisma.customer.create({
          data: {
            shopId: shopAId,
            customerNo: 112,
            name: 'Active Customer',
            phone: '03005556666',
            downPayment: 0,
            initialMonthlyPayment: 1000,
            monthlyPayment: 1000,
            firstDueDate: '2026-11-01',
            items: {
              create: [{ name: 'Tablet', price: 5000, boughtOn: '2026-11-01' }],
            },
          },
        });
        await shopService.deleteCustomer(shopAId, activeCustomer.id);
        await expect(
          prisma.customer.findUniqueOrThrow({
            where: { id: activeCustomer.id },
          }),
        ).resolves.toMatchObject({ deletedAt: expect.any(Date) });
        const visible = await shopService.listCustomers(shopAId, {});
        expect(visible.data).not.toContainEqual(
          expect.objectContaining({ id: activeCustomer.id }),
        );

        const archivedCustomer = await prisma.customer.create({
          data: {
            shopId: shopAId,
            customerNo: 113,
            name: 'Archived Customer',
            phone: '03006667777',
            downPayment: 1000,
            initialMonthlyPayment: 1000,
            monthlyPayment: 1000,
            firstDueDate: '2026-11-01',
            completedAt: new Date(),
            items: {
              create: [{ name: 'Camera', price: 1000, boughtOn: '2026-11-01' }],
            },
          },
        });
        await shopService.archiveCustomer(shopAId, archivedCustomer.id);
        await shopService.deleteCustomer(shopAId, archivedCustomer.id);
        const archivedDeletionLog = await prisma.auditLog.findFirstOrThrow({
          where: {
            entityType: 'Customer',
            entityId: archivedCustomer.id,
            action: 'CUSTOMER_DELETED',
          },
        });
        expect(archivedDeletionLog.details).toEqual(
          expect.objectContaining({
            snapshot: expect.objectContaining({ archived: true }),
          }),
        );
      });

      it('automatically archives completed customers after seven days and restores them', async () => {
        const completedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        const customer = await prisma.customer.create({
          data: {
            shopId: shopAId,
            customerNo: 114,
            name: 'Auto Archive Customer',
            phone: '03007778888',
            downPayment: 1000,
            initialMonthlyPayment: 1000,
            monthlyPayment: 1000,
            firstDueDate: '2026-11-01',
            completedAt,
            payments: { create: [{ amount: 1000, paidOn: new Date() }] },
            items: {
              create: [
                { name: 'Headphones', price: 2000, boughtOn: '2026-11-01' },
              ],
            },
          },
        });
        await shopService.archiveCompletedCustomersBefore(
          new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        );

        const archived = await prisma.customer.findUniqueOrThrow({
          where: { id: customer.id },
        });
        expect(archived.archivedAt).not.toBeNull();
        const archivedList = await shopService.listArchivedCustomers(shopAId);
        expect(archivedList.data).toContainEqual(
          expect.objectContaining({ id: customer.id, status: 'archived' }),
        );
        const activeList = await shopService.listCustomers(shopAId, {});
        expect(activeList.data).not.toContainEqual(
          expect.objectContaining({ id: customer.id }),
        );
        const currentReport = await shopService.status(shopAId);
        expect(currentReport.data.customers).toContainEqual(
          expect.objectContaining({ customerId: customer.id }),
        );
        await expect(
          shopService.restoreArchivedCustomer(shopBId, customer.id),
        ).rejects.toThrow(NotFoundException);
        await shopService.restoreArchivedCustomer(shopAId, customer.id);
        const restored = await prisma.customer.findUniqueOrThrow({
          where: { id: customer.id },
        });
        expect(restored.archivedAt).toBeNull();
      });

      it('hard-deletes only expired customers with no payment rows and keeps their audit', async () => {
        const customer = await prisma.customer.create({
          data: {
            shopId: shopAId,
            customerNo: 110,
            name: 'No Payment Customer',
            phone: '03003334444',
            downPayment: 0,
            initialMonthlyPayment: 1000,
            monthlyPayment: 1000,
            firstDueDate: '2026-11-01',
            items: {
              create: [{ name: 'Phone', price: 5000, boughtOn: '2026-11-01' }],
            },
          },
        });
        await shopService.deleteCustomer(shopAId, customer.id);
        await prisma.customer.update({
          where: { id: customer.id },
          data: {
            deletionRequestedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
          },
        });

        await deletionCleanup.runCleanupNow();

        await expect(
          prisma.customer.findUnique({ where: { id: customer.id } }),
        ).resolves.toBeNull();
        await expect(
          prisma.auditLog.count({
            where: { entityType: 'Customer', entityId: customer.id },
          }),
        ).resolves.toBe(2);
      });

      it('keeps a closed month snapshot unchanged after a customer is deleted', async () => {
        const customer = await prisma.customer.create({
          data: {
            shopId: shopAId,
            customerNo: 111,
            name: 'Snapshot Customer',
            phone: '03004445555',
            downPayment: 0,
            initialMonthlyPayment: 1000,
            monthlyPayment: 1000,
            firstDueDate: '2026-10-01',
            items: {
              create: [{ name: 'Laptop', price: 5000, boughtOn: '2026-10-01' }],
            },
          },
        });
        const before = await shopService.status(shopAId, '2026-10');
        await shopService.deleteCustomer(shopAId, customer.id);
        const after = await shopService.status(shopAId, '2026-10');

        expect(after).toEqual(before);
        await expect(
          prisma.monthlyReportSnapshot.count({
            where: { shopId: shopAId, month: '2026-10' },
          }),
        ).resolves.toBe(1);
        await expect(
          prisma.monthlyReportSnapshot.count({
            where: { shopId: shopBId, month: '2026-10' },
          }),
        ).resolves.toBe(0);
      });
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
        shopService.updateCustomer(shopBId, customerAId, {
          name: 'Hacked Name',
        }),
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
    const makeContext = (token?: string) =>
      ({
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
      const adminToken = await jwt.signAsync({
        sub: 'admin-id',
        role: 'admin',
      });
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

      await expect(shopGuard.canActivate(makeContext(token))).rejects.toThrow(
        'Aap ka account active nahi hai. Admin se rabta karein.',
      );

      await prisma.shop.delete({ where: { id: inactiveShop.id } });
    });

    it('allows active shopkeeper', async () => {
      const token = await jwt.signAsync({ sub: shopAId, role: 'shop' });
      const can = await shopGuard.canActivate(makeContext(token));
      expect(can).toBe(true);
    });
  });

  describe('3. AdminGuard Database Existence & Role Enforcement', () => {
    const makeContext = (token?: string) =>
      ({
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
