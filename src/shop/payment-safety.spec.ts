import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuditModule } from '../common/audit/audit.module';
import { StorageModule } from '../common/storage/storage.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { ShopService } from './shop.service';
import crypto from 'crypto';

describe('Payment Safety & Concurrency (PostgreSQL Integration)', () => {
  let module: TestingModule;
  let shopService: ShopService;
  let prisma: PrismaService;

  let testShopId: string;
  let testCustomerId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuditModule,
        StorageModule,
      ],
      providers: [ShopService],
    }).compile();

    shopService = module.get<ShopService>(ShopService);
    prisma = module.get<PrismaService>(PrismaService);

    // Create isolated test shop in PostgreSQL
    const shop = await prisma.shop.create({
      data: {
        shopName: 'Safety Test Electronics',
        ownerName: 'Test Owner',
        mobile: `0399${Math.floor(1000000 + Math.random() * 9000000)}`,
        cnic: '35202-9999999-1',
        city: 'Lahore',
        address: 'Test Street 1',
        passwordHash: '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456',
        status: 'active',
      },
    });
    testShopId = shop.id;

    // Create test customer: Item price 15,000, downPayment 5,000 => Remaining 10,000
    const customer = await prisma.customer.create({
      data: {
        shopId: testShopId,
        customerNo: 9901,
        name: 'Rashid Khan',
        phone: '03001239999',
        downPayment: 5000,
        initialMonthlyPayment: 1000,
        monthlyPayment: 1000,
        firstDueDate: '2026-11-01',
        items: {
          create: [{ name: 'Microwave', price: 15000, boughtOn: '2026-10-27' }],
        },
      },
    });
    testCustomerId = customer.id;
  });

  afterAll(async () => {
    // Cleanup created records from PostgreSQL
    if (testShopId && prisma) {
      await prisma.shop.delete({ where: { id: testShopId } }).catch(() => {});
    }
    if (module) {
      await module.close();
    }
  });

  describe('1. Overpayment Prevention', () => {
    it('should reject payment exceeding remaining balance', async () => {
      // Remaining is 10,000, attempting to pay 10,001
      await expect(
        shopService.receivePayment(testShopId, {
          customerId: testCustomerId,
          amount: 10001,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should record valid payment and reduce balance', async () => {
      // Pay 3,000 of remaining 10,000 => New remaining 7,000
      const res = await shopService.receivePayment(testShopId, {
        customerId: testCustomerId,
        amount: 3000,
        note: 'First installment',
      });
      expect(res.status).toBe('success');

      // Now attempting to pay 7,001 should be rejected
      await expect(
        shopService.receivePayment(testShopId, {
          customerId: testCustomerId,
          amount: 7001,
        }),
      ).rejects.toThrow('Raqam baaki hisaab se zyada hai');
    });
  });

  describe('2. Idempotency Key Handling', () => {
    it('should not record a duplicate payment when same idempotencyKey is retried', async () => {
      const idempotencyKey = crypto.randomUUID();

      // First submission
      const res1 = await shopService.receivePayment(testShopId, {
        customerId: testCustomerId,
        amount: 1000,
        idempotencyKey,
      });
      expect(res1.status).toBe('success');

      // Count payments in DB with this key
      const count1 = await prisma.payment.count({ where: { idempotencyKey } });
      expect(count1).toBe(1);

      // Retry submission with the EXACT SAME idempotencyKey
      const res2 = await shopService.receivePayment(testShopId, {
        customerId: testCustomerId,
        amount: 1000,
        idempotencyKey,
      });
      expect(res2.status).toBe('success');

      // Assert only 1 payment was created in database
      const count2 = await prisma.payment.count({ where: { idempotencyKey } });
      expect(count2).toBe(1);
    });
  });

  describe('3. Concurrency & Row Locking (Simultaneous Payments Against PostgreSQL)', () => {
    it('should serialize concurrent payment requests and prevent overpayment under parallel load', async () => {
      // Create a fresh customer with exactly 4,000 remaining
      const freshCustomer = await prisma.customer.create({
        data: {
          shopId: testShopId,
          customerNo: 9902,
          name: 'Concurrent Customer',
          phone: '03009998888',
          downPayment: 1000,
          initialMonthlyPayment: 1000,
          monthlyPayment: 1000,
          firstDueDate: '2026-11-01',
          items: {
            create: [{ name: 'Toaster', price: 5000, boughtOn: '2026-10-27' }],
          },
        },
      });

      // Exactly Rs. 4,000 is owed.
      // We fire 5 concurrent requests, each attempting to pay Rs. 4,000 simultaneously!
      const requests = Array.from({ length: 5 }, (_, i) =>
        shopService
          .receivePayment(testShopId, {
            customerId: freshCustomer.id,
            amount: 4000,
            idempotencyKey: `concurrent-${i}-${crypto.randomUUID()}`,
          })
          .then(() => ({ success: true }))
          .catch((err) => ({ success: false, error: err.message })),
      );

      const results = await Promise.all(requests);

      // Exactly 1 must succeed, and 4 must fail because the balance became 0 after the first lock committed!
      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(4);

      // Verify database records: total payments amount must equal exactly 4000
      const customerPayments = await prisma.payment.findMany({
        where: { customerId: freshCustomer.id },
      });
      expect(customerPayments.length).toBe(1);
      expect(customerPayments[0].amount).toBe(4000);
    });
  });

  describe('4. Payment Reversal Safety', () => {
    it('should reverse a payment made today and reject double reversal', async () => {
      // Record a 500 payment
      const p = await prisma.payment.create({
        data: {
          customerId: testCustomerId,
          amount: 500,
          paidOn: new Date(),
        },
      });

      // Reverse it
      const rev1 = await shopService.reversePayment(testShopId, p.id);
      expect(rev1.status).toBe('success');

      // Verify reversedAt is set
      const updated = await prisma.payment.findUnique({ where: { id: p.id } });
      expect(updated?.reversedAt).not.toBeNull();

      // Attempting to reverse again must throw BadRequestException
      await expect(
        shopService.reversePayment(testShopId, p.id),
      ).rejects.toThrow('Payment pehle hi wapas ho chuki hai');
    });

    it('should reject reversing a payment from another shop', async () => {
      const otherShop = await prisma.shop.create({
        data: {
          shopName: 'Other Shop',
          ownerName: 'Other',
          mobile: `0399${Math.floor(1000000 + Math.random() * 9000000)}`,
          cnic: '35202-0000000-1',
          city: 'Karachi',
          address: 'Other St',
          passwordHash: 'hash',
          status: 'active',
        },
      });

      const p = await prisma.payment.create({
        data: {
          customerId: testCustomerId,
          amount: 500,
          paidOn: new Date(),
        },
      });

      // Other shop trying to reverse testShopId's payment
      await expect(
        shopService.reversePayment(otherShop.id, p.id),
      ).rejects.toThrow(NotFoundException);

      await prisma.shop.delete({ where: { id: otherShop.id } });
    });
  });

  describe('5. Audit Trail Verification', () => {
    it('should have written audit logs for payment received and reversed', async () => {
      const logs = await prisma.auditLog.findMany({
        where: {
          actorType: 'shop',
          actorId: testShopId,
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(logs.length).toBeGreaterThan(0);
      const actions = logs.map((l) => l.action);
      expect(actions).toContain('PAYMENT_RECEIVED');
      expect(actions).toContain('PAYMENT_REVERSED');
    });
  });
});
