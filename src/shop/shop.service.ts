import {
  BadRequestException,
  InternalServerErrorException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma } from '../generated/prisma/client';
import {
  currentMonth,
  dateOnly,
  formatMobile,
  monthLabel,
  shopCode,
} from '../admin/admin.utils';
import { AuditService } from '../common/audit/audit.service';
import {
  deletionRetentionCutoff,
  deletionRetentionDays,
} from '../common/deletion-retention';
import { StorageService } from '../common/storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChangeShopPasswordDto } from './dto/change-shop-password.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { CreateCustomerPurchaseDto } from './dto/create-customer-purchase.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { ReceivePaymentDto } from './dto/receive-payment.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { UpdateCustomerPurchasePaymentDto } from './dto/update-customer-purchase-payment.dto';
import { UpdateShopProfileDto } from './dto/update-shop-profile.dto';
import {
  activeMonthlyTotal,
  buildMultiPlanSchedulesWithAllocations,
  buildSchedule,
  combineInstallmentSchedules,
  addMonths,
  customerCode,
  isRealDate,
  isValidPlan,
  MAX_SCHEDULE_INSTALLMENTS,
  PlanInput,
  MultiPlanInput,
  summarizeCashInRange,
  timeLabel,
  todayIso,
  totalOf,
} from './shop.logic';

const FULL = {
  items: true,
  payments: { orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }] },
  rateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
  scheduleDateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
  purchases: {
    include: {
      items: true,
      rateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
      scheduleDateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.CustomerInclude;

// Lean projection that excludes heavy base64/blob document fields
const LEAN_SELECT = {
  id: true,
  customerNo: true,
  name: true,
  phone: true,
  photo: true,
  downPayment: true,
  initialMonthlyPayment: true,
  monthlyPayment: true,
  monthlyCollectionTarget: true,
  firstDueDate: true,
  createdAt: true,
  completedAt: true,
  archivedAt: true,
  rateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
  scheduleDateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
  items: {
    select: {
      id: true,
      name: true,
      price: true,
      boughtOn: true,
    },
  },
  payments: {
    select: {
      id: true,
      amount: true,
      paidOn: true,
      method: true,
      note: true,
      reversedAt: true,
      createdAt: true,
    },
    orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }],
  },
  purchases: {
    select: {
      id: true,
      downPayment: true,
      initialMonthlyPayment: true,
      monthlyPayment: true,
      firstDueDate: true,
      allocationStartInstallmentNo: true,
      createdAt: true,
      rateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
      scheduleDateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
      items: {
        select: {
          id: true,
          name: true,
          price: true,
          boughtOn: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.CustomerSelect;

type CustomerFull = Prisma.CustomerGetPayload<{
  include: {
    items: true;
    payments: true;
    rateChanges: true;
    scheduleDateChanges: true;
    purchases: {
      include: {
        items: true;
        rateChanges: true;
        scheduleDateChanges: true;
      };
    };
  };
}>;

type CustomerLean = Prisma.CustomerGetPayload<{
  select: typeof LEAN_SELECT;
}>;

type CustomerRecord = CustomerLean | CustomerFull;
type CustomerStatus = 'active' | 'overdue' | 'completed' | 'archived';

export interface StatusReportCustomerData extends Prisma.InputJsonObject {
  customerId: string;
  name: string;
  phone: string;
  expected: number;
  received: number;
  remaining: number;
  overdue: number;
  paidInstallments: number;
  lateInstallments: number;
  pendingInstallments: number;
  paidInstallmentDates: string[];
  lateInstallmentDates: string[];
  pendingInstallmentDates: string[];
}

export interface StatusReportData extends Prisma.InputJsonObject {
  month: string;
  label: string;
  expected: number;
  received: number;
  remaining: number;
  overdue: number;
  collectedPercent: number;
  totalCustomers: number;
  paidInstallments: number;
  pendingInstallments: number;
  lateInstallments: number;
  overdueCustomers: number;
  customers: StatusReportCustomerData[];
  cashCollected: number;
  cashBreakdown: { thisMonth: number; late: number; advance: number };
}

function isStatusReportData(value: unknown): value is StatusReportData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  const numericFields = [
    'expected',
    'received',
    'remaining',
    'overdue',
    'collectedPercent',
    'totalCustomers',
    'paidInstallments',
    'pendingInstallments',
    'lateInstallments',
    'overdueCustomers',
    'cashCollected',
  ];
  if (
    typeof report.month !== 'string' ||
    typeof report.label !== 'string' ||
    numericFields.some((field) => typeof report[field] !== 'number') ||
    !Array.isArray(report.customers) ||
    !report.cashBreakdown ||
    typeof report.cashBreakdown !== 'object' ||
    Array.isArray(report.cashBreakdown)
  ) {
    return false;
  }
  const cashBreakdown = report.cashBreakdown as Record<string, unknown>;
  if (
    ['thisMonth', 'late', 'advance'].some(
      (field) => typeof cashBreakdown[field] !== 'number',
    )
  ) {
    return false;
  }
  return report.customers.every((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const customer = value as Record<string, unknown>;
    return (
      typeof customer.customerId === 'string' &&
      typeof customer.name === 'string' &&
      typeof customer.phone === 'string' &&
      [
        'expected',
        'received',
        'remaining',
        'overdue',
        'paidInstallments',
        'lateInstallments',
        'pendingInstallments',
      ].every((field) => typeof customer[field] === 'number') &&
      [
        'paidInstallmentDates',
        'lateInstallmentDates',
        'pendingInstallmentDates',
      ].every(
        (field) =>
          Array.isArray(customer[field]) &&
          (customer[field] as unknown[]).every(
            (date) => typeof date === 'string',
          ),
      )
    );
  });
}

const ok = <T>(data: T): { status: 'success'; data: T } => ({
  status: 'success',
  data,
});
const clean = (v?: string) => v?.trim() || null;
const digits = (v: string) => v.replace(/\D/g, '');
const planLabel = (index: number) => {
  let number = index + 1;
  let label = '';
  while (number > 0) {
    number -= 1;
    label = String.fromCharCode(65 + (number % 26)) + label;
    number = Math.floor(number / 26);
  }
  return `Plan ${label}`;
};

const DOC_FIELDS = {
  cnicFront: 'docCnicFront',
  cnicBack: 'docCnicBack',
  other: 'docOther',
} as const;

@Injectable()
export class ShopService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async profile(shopId: string) {
    const shop = await this.prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        shopNo: true,
        shopName: true,
        ownerName: true,
        mobile: true,
        email: true,
        cnic: true,
        city: true,
        address: true,
        profilePic: true,
        status: true,
        monthlyFee: true,
        feeRates: {
          where: { effectiveFromMonth: { lte: currentMonth() } },
          orderBy: { effectiveFromMonth: 'desc' },
          take: 1,
        },
        createdAt: true,
      },
    });
    if (!shop) throw new NotFoundException('Shop nahi mili');
    const { shopNo, feeRates, ...details } = shop;
    return ok({
      ...details,
      monthlyFee: feeRates[0]?.amount ?? shop.monthlyFee,
      shopCode: shopCode(shopNo),
    });
  }

  async updateProfile(
    shopId: string,
    dto: UpdateShopProfileDto,
    meta?: { ip?: string; userAgent?: string },
  ) {
    const data = {
      ...(dto.shopName !== undefined && { shopName: dto.shopName }),
      ...(dto.ownerName !== undefined && { ownerName: dto.ownerName }),
      ...(dto.email !== undefined && { email: dto.email }),
      ...(dto.city !== undefined && { city: dto.city }),
      ...(dto.address !== undefined && { address: dto.address }),
      ...(dto.profilePic != null && {
        profilePic: await this.storage.saveBase64(dto.profilePic, 'shops'),
      }),
    };
    const changedFields = Object.keys(data);
    if (changedFields.length === 0) {
      throw new BadRequestException('Badalne ke liye profile details chunein');
    }

    const previousProfilePic = dto.profilePic
      ? await this.prisma.shop.findUnique({
          where: { id: shopId },
          select: { profilePic: true },
        })
      : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.shop.update({ where: { id: shopId }, data });
      await this.audit.recordWithTx(tx, {
        actorType: 'shop',
        actorId: shopId,
        action: 'SHOP_PROFILE_UPDATED',
        entityType: 'Shop',
        entityId: shopId,
        details: { changedFields },
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });
    });

    if (
      dto.profilePic &&
      previousProfilePic?.profilePic &&
      previousProfilePic.profilePic !== data.profilePic
    ) {
      await this.storage.deleteFile(previousProfilePic.profilePic);
    }

    return this.profile(shopId);
  }

  async changePassword(
    shopId: string,
    dto: ChangeShopPasswordDto,
    meta?: { ip?: string; userAgent?: string },
  ) {
    const shop = await this.prisma.shop.findUnique({
      where: { id: shopId },
      select: { passwordHash: true },
    });
    if (!shop) throw new NotFoundException('Shop nahi mili');
    if (!(await bcrypt.compare(dto.currentPassword, shop.passwordHash))) {
      throw new BadRequestException('Maujooda password sahi nahi hai');
    }
    if (Buffer.byteLength(dto.newPassword, 'utf8') > 72) {
      throw new BadRequestException(
        'Naya password 72 bytes se zyada nahi ho sakta',
      );
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'Naya password maujooda password se mukhtalif hona chahiye',
      );
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.$transaction(async (tx) => {
      await tx.shop.update({
        where: { id: shopId },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 },
        },
      });
      await this.audit.recordWithTx(tx, {
        actorType: 'shop',
        actorId: shopId,
        action: 'SHOP_PASSWORD_CHANGED',
        entityType: 'Shop',
        entityId: shopId,
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });
    });

    return ok({ ok: true });
  }

  /* ================= 1. DASHBOARD ================= */
  async dashboard(shopId: string) {
    const customers = await this.loadAll(shopId);
    const reportCustomers = await this.loadAll(shopId, undefined, true);
    const today = todayIso();

    const items = this.collectionOf(customers, today);
    const expected = items.reduce((s, i) => s + i.expected, 0);
    const received = items.reduce((s, i) => s + i.paid, 0);
    const late = this.lateOf(customers, today);
    const m = this.reportOf(reportCustomers, currentMonth(), today);
    const cashToday = await this.cashInRange(shopId, today, today);

    return ok({
      dueCount: items.filter((i) => i.status !== 'paid').length,
      expected,
      received,
      remaining: expected - received,
      cashToday,
      todayInstallments: {
        total: expected,
        paid: received,
        remaining: expected - received,
      },
      lateTotal: late.reduce((sum, item) => sum + item.lateAmount, 0),
      lateCount: late.length,
      lateAmount: late.reduce((s, l) => s + l.lateAmount, 0),
      month: { label: m.label, expected: m.expected, received: m.received },
    });
  }

  /* ================= 2. AAJ KI WASOOLI ================= */
  async collectionToday(shopId: string) {
    const customers = await this.loadAll(shopId);
    const today = todayIso();
    const items = this.collectionOf(customers, today);
    const cashToday = await this.cashInRange(shopId, today, today);
    return ok({ items, cashToday });
  }

  /* ================= 3. AAJ MIL GAYE ================= */
  async paymentsToday(shopId: string) {
    const today = todayIso();
    const from = new Date(`${today}T00:00:00+05:00`);
    const afterToday = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
    const rows = await this.prisma.payment.findMany({
      where: {
        reversedAt: null,
        paidOn: { gte: from, lt: new Date(`${afterToday}T00:00:00+05:00`) },
        customer: { shopId, deletedAt: null, archivedAt: null },
      },
      include: { customer: { select: { id: true, name: true } } },
      orderBy: { paidOn: 'desc' },
    });

    return ok(
      rows.map((p) => ({
        id: p.id,
        customerId: p.customer.id,
        name: p.customer.name,
        amount: p.amount,
        time: timeLabel(p.paidOn),
        installmentNo: 0,
      })),
    );
  }

  /* ================= 4. PAYMENT LENA ================= */
  async receivePayment(
    shopId: string,
    dto: ReceivePaymentDto,
    meta?: { ip?: string; userAgent?: string },
  ) {
    const trimmedKey = dto.idempotencyKey?.trim() || null;

    // Fast-path idempotency check before transaction:
    // If a payment already exists with this idempotencyKey for this customer & shop, return successful duplicate
    if (trimmedKey) {
      const existing = await this.prisma.payment.findFirst({
        where: {
          idempotencyKey: trimmedKey,
          customer: { shopId },
        },
      });
      if (existing) {
        const customer = await this.findFull(shopId, existing.customerId);
        return ok(this.paymentReceipt(customer, existing, todayIso()));
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // Re-check idempotency inside tx to handle parallel racing requests with the same key
      if (trimmedKey) {
        const existingTx = await tx.payment.findFirst({
          where: {
            idempotencyKey: trimmedKey,
            customer: { shopId },
          },
        });
        if (existingTx) {
          const customer = await tx.customer.findFirst({
            where: {
              id: existingTx.customerId,
              shopId,
              deletedAt: null,
              archivedAt: null,
            },
            include: FULL,
          });
          if (!customer) throw new NotFoundException('Customer nahi mila');
          return ok(this.paymentReceipt(customer, existingTx, todayIso()));
        }
      }

      // Row-level lock on the customer in PostgreSQL to serialize concurrent payments
      const lockedRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "customers"
        WHERE id = ${dto.customerId} AND "shopId" = ${shopId} AND "deletedAt" IS NULL
        FOR UPDATE
      `;

      if (!lockedRows || lockedRows.length === 0) {
        throw new NotFoundException('Customer nahi mila');
      }

      // Re-fetch customer state within the locked transaction
      const c = await tx.customer.findFirst({
        where: {
          id: dto.customerId,
          shopId,
          deletedAt: null,
          archivedAt: null,
        },
        include: FULL,
      });

      if (!c) throw new NotFoundException('Customer nahi mila');

      const threeSecondsAgo = new Date(Date.now() - 3000);
      const recentDuplicate = c.payments.find(
        (payment) =>
          !payment.reversedAt &&
          payment.amount === dto.amount &&
          payment.createdAt >= threeSecondsAgo &&
          (payment.note ?? null) === (dto.note?.trim() ?? null),
      );
      if (recentDuplicate) {
        throw new BadRequestException(
          'Yeh raqam abhi receive hui hai, thori dair baad dobara koshish karein',
        );
      }

      // Recalculate remaining balance inside the locked transaction
      const financial = this.financialOf(c, todayIso());
      if (dto.amount > financial.remaining) {
        throw new BadRequestException('Raqam baaki hisaab se zyada hai');
      }

      const payment = await tx.payment.create({
        data: {
          customerId: c.id,
          amount: dto.amount,
          method: 'Cash',
          note: dto.note?.trim() || null,
          idempotencyKey: trimmedKey,
        },
      });
      if (financial.remaining - dto.amount <= 0) {
        await tx.customer.update({
          where: { id: c.id },
          data: { completedAt: c.completedAt ?? new Date() },
        });
      }
      const receipt = this.paymentReceipt(c, payment, todayIso());

      // Write audit log inside the same transaction
      await this.audit.recordWithTx(tx, {
        actorType: 'shop',
        actorId: shopId,
        action: 'PAYMENT_RECEIVED',
        entityType: 'Payment',
        entityId: payment.id,
        details: {
          customerId: c.id,
          customerName: c.name,
          amount: dto.amount,
          remainingAfter: financial.remaining - dto.amount,
          allocations: receipt.allocations,
          idempotencyKey: trimmedKey,
        },
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });

      return ok(receipt);
    });
  }

  /* ================= 5. PAYMENT WAPAS ================= */
  async reversePayment(
    shopId: string,
    id: string,
    meta?: { ip?: string; userAgent?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.findFirst({
        where: { id, customer: { shopId, deletedAt: null, archivedAt: null } },
        include: {
          customer: { select: { id: true, name: true, shopId: true } },
        },
      });
      if (!p) throw new NotFoundException('Payment nahi mili');

      // Row-level lock on the customer in PostgreSQL to serialize with other payments/reversals
      await tx.$queryRaw`
        SELECT id FROM "customers"
        WHERE id = ${p.customerId} AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (dateOnly(p.paidOn) !== todayIso()) {
        throw new BadRequestException('Sirf aaj ki payment wapas ho sakti hai');
      }

      if (p.reversedAt) {
        throw new BadRequestException('Payment pehle hi wapas ho chuki hai');
      }

      await tx.payment.update({
        where: { id: p.id },
        data: { reversedAt: new Date() },
      });
      const updatedCustomer = await tx.customer.findUniqueOrThrow({
        where: { id: p.customerId },
        include: FULL,
      });
      const updatedFinancial = this.financialOf(updatedCustomer, todayIso());
      await tx.customer.update({
        where: { id: p.customerId },
        data: {
          completedAt:
            updatedFinancial.remaining <= 0
              ? (updatedCustomer.completedAt ?? new Date())
              : null,
        },
      });

      await this.audit.recordWithTx(tx, {
        actorType: 'shop',
        actorId: shopId,
        action: 'PAYMENT_REVERSED',
        entityType: 'Payment',
        entityId: p.id,
        details: {
          customerId: p.customerId,
          customerName: p.customer.name,
          amount: p.amount,
          originalPaidOn: p.paidOn,
        },
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });

      return ok({ ok: true });
    });
  }

  /* ================= 6. CUSTOMERS LIST ================= */
  async listCustomers(shopId: string, q: ListCustomersQueryDto) {
    const today = todayIso();
    const searchRaw = (q.search ?? '').trim();
    const limit = q.limit ?? 20;
    const page  = q.page  ?? 1;

    const customers = await this.loadAll(shopId, searchRaw || undefined);
    const filtered = customers
      .map((c) => this.toListItem(c, today))
      .filter((c) => !q.status || q.status === 'all' || c.status === q.status);

    const total  = filtered.length;
    const skip   = (page - 1) * limit;
    const items  = filtered.slice(skip, skip + limit);
    const hasMore = skip + items.length < total;

    return ok({ items, hasMore, total, page, limit });
  }

  async listArchivedCustomers(shopId: string) {
    const customers = await this.loadAll(shopId, undefined, true);
    return ok(
      customers
        .filter((customer) => customer.archivedAt !== null)
        .map((customer) => ({
          ...this.toListItem(customer, todayIso()),
          archivedAt: customer.archivedAt,
        })),
    );
  }

  async archiveCustomer(
    shopId: string,
    id: string,
    meta?: { ip?: string; userAgent?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id, shopId, deletedAt: null, archivedAt: null },
        select: LEAN_SELECT,
      });
      if (!customer) throw new NotFoundException('Customer nahi mila');
      if (this.toListItem(customer, todayIso()).status !== 'completed') {
        throw new BadRequestException(
          'Sirf mukammal customer archive ho sakta hai',
        );
      }
      const archivedAt = new Date();
      await tx.customer.update({
        where: { id },
        data: { archivedAt, completedAt: customer.completedAt ?? archivedAt },
      });
      await this.audit.recordWithTx(tx, {
        actorType: 'shop',
        actorId: shopId,
        action: 'CUSTOMER_ARCHIVED',
        entityType: 'Customer',
        entityId: id,
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });
      return ok({ ok: true });
    });
  }

  async restoreArchivedCustomer(
    shopId: string,
    id: string,
    meta?: { ip?: string; userAgent?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.customer.updateMany({
        where: { id, shopId, deletedAt: null, archivedAt: { not: null } },
        data: { archivedAt: null, completedAt: new Date() },
      });
      if (!result.count) throw new NotFoundException('Customer nahi mila');
      await this.audit.recordWithTx(tx, {
        actorType: 'shop',
        actorId: shopId,
        action: 'CUSTOMER_ARCHIVE_UNDONE',
        entityType: 'Customer',
        entityId: id,
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });
      return ok({ ok: true });
    });
  }

  async archiveCompletedCustomersBefore(cutoff: Date) {
    const customers = await this.prisma.customer.findMany({
      where: {
        deletedAt: null,
        archivedAt: null,
        completedAt: { lte: cutoff },
      },
      select: { ...LEAN_SELECT, shopId: true },
      take: 100,
      orderBy: { completedAt: 'asc' },
    });
    for (const customer of customers) {
      if (this.financialOf(customer, todayIso()).remaining > 0) continue;
      await this.prisma.$transaction(async (tx) => {
        const result = await tx.customer.updateMany({
          where: {
            id: customer.id,
            shopId: customer.shopId,
            deletedAt: null,
            archivedAt: null,
            completedAt: { lte: cutoff },
          },
          data: { archivedAt: new Date() },
        });
        if (!result.count) return;
        await this.audit.recordWithTx(tx, {
          actorType: 'system',
          actorId: 'customer-auto-archive',
          action: 'CUSTOMER_ARCHIVED',
          entityType: 'Customer',
          entityId: customer.id,
          details: { reason: 'completed_for_seven_days' },
        });
      });
    }
  }

  /* ================= 7. CUSTOMER BANANA ================= */
  async createCustomer(shopId: string, dto: CreateCustomerDto) {
    if (!isRealDate(dto.firstDueDate)) {
      throw new BadRequestException('Pehli qist ki tareekh sahi likhein');
    }

    const total = dto.items.reduce((s, i) => s + i.price, 0);
    if (dto.downPayment > total) {
      throw new BadRequestException(
        'Advance raqam kul raqam se zyada nahi ho sakti',
      );
    }
    if (!isValidPlan(total, dto.downPayment, dto.monthlyPayment)) {
      throw new BadRequestException(
        'Mahine ki qist ki raqam is plan ke liye sahi nahi hai',
      );
    }

    const today = todayIso();

    const [photo, docCnicFront, docCnicBack, docOther] = await Promise.all([
      this.storage.saveBase64(dto.photo, 'customers'),
      this.storage.saveBase64(dto.documents?.cnicFront, 'documents'),
      this.storage.saveBase64(dto.documents?.cnicBack, 'documents'),
      this.storage.saveBase64(dto.documents?.other, 'documents'),
    ]);

    const items = await Promise.all(
      dto.items.map(async (i) => ({
        name: i.name.trim(),
        price: i.price,
        photo: await this.storage.saveBase64(i.photo, 'items'),
        boughtOn: today,
      })),
    );

    const created = await this.prisma.$transaction(async (tx) => {
      // Har shop ka apna customer number (C-0001, C-0002, ...)
      const { customerSeq } = await tx.shop.update({
        where: { id: shopId },
        data: { customerSeq: { increment: 1 } },
        select: { customerSeq: true },
      });

      return tx.customer.create({
        data: {
          shopId,
          customerNo: customerSeq,
          name: dto.name.trim(),
          fatherName: clean(dto.fatherName),
          phone: digits(dto.mobile),
          cnic: clean(dto.cnic),
          address: clean(dto.address),
          photo,
          docCnicFront,
          docCnicBack,
          docOther,
          downPayment: dto.downPayment,
          initialMonthlyPayment: dto.monthlyPayment,
          monthlyPayment: dto.monthlyPayment,
          firstDueDate: dto.firstDueDate,
          completedAt: total <= dto.downPayment ? new Date() : null,
          items: {
            create: items,
          },
        },
        select: { id: true },
      });
    });

    return ok({ id: created.id });
  }

  /* ================= 8. CUSTOMER DETAIL ================= */
  async getCustomer(shopId: string, id: string) {
    return ok(await this.detailOf(await this.findFull(shopId, id, true)));
  }

  async listPendingDeletion(shopId: string) {
    const customers = await this.prisma.customer.findMany({
      where: {
        shopId,
        deletedAt: { not: null },
        deletionRequestedAt: { gt: deletionRetentionCutoff() },
      },
      select: {
        id: true,
        customerNo: true,
        name: true,
        deletionRequestedAt: true,
      },
      orderBy: { deletionRequestedAt: 'asc' },
    });
    return ok(
      customers.map((customer) => ({
        ...customer,
        customerCode: customerCode(customer.customerNo),
      })),
    );
  }

  async undoDeleteCustomer(shopId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "customers"
        WHERE id = ${id}
          AND "shopId" = ${shopId}
          AND "deletedAt" IS NOT NULL
        FOR UPDATE
      `;
      if (!locked.length) throw new NotFoundException('Customer nahi mila');

      const customer = await tx.customer.findFirst({
        where: { id, shopId, deletedAt: { not: null } },
        select: { id: true, deletionRequestedAt: true },
      });
      if (!customer?.deletionRequestedAt) {
        throw new NotFoundException('Customer nahi mila');
      }
      if (
        customer.deletionRequestedAt.getTime() <=
        deletionRetentionCutoff().getTime()
      ) {
        throw new BadRequestException(
          `Customer ko wapas lane ka ${deletionRetentionDays()} din ka waqt khatam ho gaya`,
        );
      }

      await tx.customer.update({
        where: { id },
        data: { deletedAt: null, deletionRequestedAt: null },
      });
      await this.audit.recordWithTx(tx, {
        actorType: 'shop',
        actorId: shopId,
        action: 'CUSTOMER_DELETION_UNDONE',
        entityType: 'Customer',
        entityId: id,
      });
      return ok({ ok: true });
    });
  }

  async addCustomerPurchase(
    shopId: string,
    id: string,
    dto: CreateCustomerPurchaseDto,
  ) {
    if (!isRealDate(dto.firstDueDate)) {
      throw new BadRequestException(
        'Plan B ki pehli qist ki tareekh sahi likhein',
      );
    }
    const total = dto.items.reduce((sum, item) => sum + item.price, 0);
    const downPayment = dto.downPayment ?? 0;
    if (!Number.isSafeInteger(total) || total > 2147483647) {
      throw new BadRequestException('Kul qeemat bohat zyada hai');
    }
    if (
      downPayment > total ||
      dto.monthlyPayment > total ||
      downPayment + dto.monthlyPayment > total
    ) {
      throw new BadRequestException(
        'Advance aur mahana qist alag alag bhi aur mila kar bhi kul qeemat se zyada nahi ho sakte',
      );
    }
    if (!isValidPlan(total, downPayment, dto.monthlyPayment)) {
      throw new BadRequestException(
        'Mahine ki qist ki raqam is khareedari ke liye sahi nahi hai',
      );
    }

    const today = todayIso();
    const items = await Promise.all(
      dto.items.map(async (item) => ({
        name: item.name.trim(),
        price: item.price,
        photo: await this.storage.saveBase64(item.photo, 'items'),
        boughtOn: today,
      })),
    );

    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "customers"
        WHERE id = ${id} AND "shopId" = ${shopId} AND "deletedAt" IS NULL AND "archivedAt" IS NULL
        FOR UPDATE
      `;
      if (!locked.length) throw new NotFoundException('Customer nahi mila');

      const customer = await tx.customer.findFirst({
        where: { id, shopId, deletedAt: null, archivedAt: null },
        include: FULL,
      });
      if (!customer) throw new NotFoundException('Customer nahi mila');
      const baseRows = this.financialOf(customer, today).plans[0].rows;
      const nextBaseRow = baseRows.find((row) => row.status !== 'paid');
      const allocationStartInstallmentNo =
        nextBaseRow?.no ?? baseRows.length + 1;
      const currentMonthlyTotal =
        customer.monthlyCollectionTarget ??
        customer.monthlyPayment +
          customer.purchases.reduce(
            (sum, purchase) => sum + purchase.monthlyPayment,
            0,
          );
      if (currentMonthlyTotal + dto.monthlyPayment > 2147483647) {
        throw new BadRequestException('Kul mahana qist bohat zyada hai');
      }

      await tx.customerPurchase.create({
        data: {
          customerId: id,
          downPayment,
          initialMonthlyPayment: dto.monthlyPayment,
          monthlyPayment: dto.monthlyPayment,
          firstDueDate: dto.firstDueDate,
          allocationStartInstallmentNo,
          items: { create: items },
        },
      });
      await tx.customer.update({
        where: { id },
        data: {
          monthlyCollectionTarget: currentMonthlyTotal + dto.monthlyPayment,
          completedAt: null,
        },
      });
    });

    return ok(await this.detailOf(await this.findFull(shopId, id)));
  }

  async updateCustomerPurchaseDate(
    shopId: string,
    customerId: string,
    purchaseId: string,
    firstDueDate: string,
  ) {
    if (!isRealDate(firstDueDate)) {
      throw new BadRequestException(
        'Plan ki agli baqi qist ki tareekh sahi likhein',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "customers"
        WHERE id = ${customerId} AND "shopId" = ${shopId} AND "deletedAt" IS NULL AND "archivedAt" IS NULL
        FOR UPDATE
      `;
      if (!locked.length) throw new NotFoundException('Customer nahi mila');

      const customer = await tx.customer.findFirst({
        where: { id: customerId, shopId, deletedAt: null, archivedAt: null },
        include: FULL,
      });
      if (!customer) throw new NotFoundException('Customer nahi mila');

      const plan = this.financialOf(customer, todayIso()).plans.find(
        (item) => item.id === purchaseId,
      );
      if (!plan) throw new NotFoundException('Plan nahi mila');

      const current = plan.rows.find((row) => row.status !== 'paid');
      if (!current) {
        const purchase = customer.purchases.find(
          (item) => item.id === purchaseId,
        );
        if (purchase?.firstDueDate === firstDueDate) return;
        throw new BadRequestException(
          'Mukammal plan ki qist ki tareekh tabdeel nahi ho sakti',
        );
      }
      if (current.dueDate === firstDueDate) return;

      await tx.customerPurchaseScheduleDateChange.upsert({
        where: {
          purchaseId_fromInstallmentNo: {
            purchaseId,
            fromInstallmentNo: current.no,
          },
        },
        create: {
          purchaseId,
          fromInstallmentNo: current.no,
          firstDueDate,
        },
        update: { firstDueDate },
      });
    });

    return ok(await this.detailOf(await this.findFull(shopId, customerId)));
  }

  async updateCustomerBasePayment(
    shopId: string,
    customerId: string,
    dto: UpdateCustomerPurchasePaymentDto,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "customers"
        WHERE id = ${customerId} AND "shopId" = ${shopId} AND "deletedAt" IS NULL AND "archivedAt" IS NULL
        FOR UPDATE
      `;
      if (!locked.length) throw new NotFoundException('Customer nahi mila');

      const customer = await tx.customer.findFirst({
        where: { id: customerId, shopId, deletedAt: null, archivedAt: null },
        include: FULL,
      });
      if (!customer) throw new NotFoundException('Customer nahi mila');

      const today = todayIso();
      const currentPlan = this.financialOf(customer, today).plans[0];
      const current = currentPlan?.rows.find((row) => row.status !== 'paid');
      if (!current) {
        throw new BadRequestException(
          'Mukammal plan ki qist ki raqam tabdeel nahi ho sakti',
        );
      }

      const fromInstallmentNo = current.paid > 0 ? current.no + 1 : current.no;
      if (fromInstallmentNo > currentPlan.rows.length) {
        throw new BadRequestException(
          'Current qist mukammal karein, phir nayi raqam set karein',
        );
      }

      const rateChanges = customer.rateChanges.map((change) => ({
        fromInstallmentNo: change.fromInstallmentNo,
        monthlyPayment: change.monthlyPayment,
      }));
      const existingChange = rateChanges.find(
        (change) => change.fromInstallmentNo === fromInstallmentNo,
      );
      if (existingChange) {
        existingChange.monthlyPayment = dto.monthlyPayment;
      } else {
        rateChanges.push({
          fromInstallmentNo,
          monthlyPayment: dto.monthlyPayment,
        });
      }
      rateChanges.sort(
        (left, right) => left.fromInstallmentNo - right.fromInstallmentNo,
      );

      const proposedPlan: PlanInput = {
        items: customer.items,
        downPayment: customer.downPayment,
        initialMonthlyPayment: customer.initialMonthlyPayment,
        firstDueDate: customer.firstDueDate,
        rateChanges,
        payments: [],
      };
      const proposedRows = buildSchedule(proposedPlan, today);
      if (
        proposedRows.length >= MAX_SCHEDULE_INSTALLMENTS &&
        proposedRows.reduce((sum, row) => sum + row.expected, 0) <
          totalOf(proposedPlan) - customer.downPayment
      ) {
        throw new BadRequestException('Qiston ka schedule bohat lamba hai');
      }

      const nextMonthlyTotal =
        customer.monthlyCollectionTarget === null
          ? null
          : customer.monthlyCollectionTarget +
            dto.monthlyPayment -
            customer.monthlyPayment;
      if (
        nextMonthlyTotal !== null &&
        (nextMonthlyTotal < 1 || nextMonthlyTotal > 2147483647)
      ) {
        throw new BadRequestException('Kul mahana qist ki raqam sahi likhein');
      }

      await tx.customerRateChange.upsert({
        where: {
          customerId_fromInstallmentNo: {
            customerId,
            fromInstallmentNo,
          },
        },
        create: {
          customerId,
          fromInstallmentNo,
          monthlyPayment: dto.monthlyPayment,
        },
        update: { monthlyPayment: dto.monthlyPayment },
      });
      await tx.customer.update({
        where: { id: customerId },
        data: {
          monthlyPayment: dto.monthlyPayment,
          ...(nextMonthlyTotal !== null && {
            monthlyCollectionTarget: nextMonthlyTotal,
          }),
        },
      });
    });

    return ok(await this.detailOf(await this.findFull(shopId, customerId)));
  }

  async updateCustomerPurchasePayment(
    shopId: string,
    customerId: string,
    purchaseId: string,
    dto: UpdateCustomerPurchasePaymentDto,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "customers"
        WHERE id = ${customerId} AND "shopId" = ${shopId} AND "deletedAt" IS NULL AND "archivedAt" IS NULL
        FOR UPDATE
      `;
      if (!locked.length) throw new NotFoundException('Customer nahi mila');

      const customer = await tx.customer.findFirst({
        where: { id: customerId, shopId, deletedAt: null, archivedAt: null },
        include: FULL,
      });
      if (!customer) throw new NotFoundException('Customer nahi mila');
      const purchase = customer.purchases.find(
        (item) => item.id === purchaseId,
      );
      if (!purchase) throw new NotFoundException('Plan nahi mila');
      if (purchase.firstDueDate === customer.firstDueDate) {
        throw new BadRequestException(
          'Alag tareekh wala plan hi alag se edit ho sakta hai',
        );
      }

      const today = todayIso();
      const currentPlan = this.financialOf(customer, today).plans.find(
        (plan) => plan.id === purchaseId,
      );
      if (!currentPlan) throw new NotFoundException('Plan nahi mila');
      const current = currentPlan.rows.find((row) => row.status !== 'paid');
      if (!current) {
        throw new BadRequestException(
          'Mukammal plan ki qist ki raqam tabdeel nahi ho sakti',
        );
      }
      const fromInstallmentNo = current.paid > 0 ? current.no + 1 : current.no;
      if (fromInstallmentNo > currentPlan.rows.length) {
        throw new BadRequestException(
          'Current qist mukammal karein, phir nayi raqam set karein',
        );
      }

      const rateChanges = purchase.rateChanges.map((change) => ({
        fromInstallmentNo: change.fromInstallmentNo,
        monthlyPayment: change.monthlyPayment,
      }));
      const existingChange = rateChanges.find(
        (change) => change.fromInstallmentNo === fromInstallmentNo,
      );
      if (existingChange) {
        existingChange.monthlyPayment = dto.monthlyPayment;
      } else {
        rateChanges.push({
          fromInstallmentNo,
          monthlyPayment: dto.monthlyPayment,
        });
      }
      rateChanges.sort(
        (left, right) => left.fromInstallmentNo - right.fromInstallmentNo,
      );

      const proposedPlan: PlanInput = {
        items: purchase.items,
        downPayment: purchase.downPayment,
        initialMonthlyPayment: purchase.initialMonthlyPayment,
        firstDueDate: purchase.firstDueDate ?? customer.firstDueDate,
        rateChanges,
        payments: [],
      };
      const proposedRows = buildSchedule(proposedPlan, today);
      if (
        proposedRows.length >= MAX_SCHEDULE_INSTALLMENTS &&
        proposedRows.reduce((sum, row) => sum + row.expected, 0) <
          totalOf(proposedPlan) - purchase.downPayment
      ) {
        throw new BadRequestException('Qiston ka schedule bohat lamba hai');
      }

      const currentMonthlyTotal =
        customer.monthlyCollectionTarget ??
        customer.monthlyPayment +
          customer.purchases.reduce(
            (sum, item) => sum + item.monthlyPayment,
            0,
          );
      const nextMonthlyTotal =
        currentMonthlyTotal + dto.monthlyPayment - purchase.monthlyPayment;
      if (nextMonthlyTotal < 1 || nextMonthlyTotal > 2147483647) {
        throw new BadRequestException('Kul mahana qist ki raqam sahi likhein');
      }

      await tx.customerPurchase.update({
        where: { id: purchaseId },
        data: { monthlyPayment: dto.monthlyPayment },
      });
      await tx.customerPurchaseRateChange.upsert({
        where: {
          purchaseId_fromInstallmentNo: {
            purchaseId,
            fromInstallmentNo,
          },
        },
        create: {
          purchaseId,
          fromInstallmentNo,
          monthlyPayment: dto.monthlyPayment,
        },
        update: { monthlyPayment: dto.monthlyPayment },
      });
      await tx.customer.update({
        where: { id: customerId },
        data: { monthlyCollectionTarget: nextMonthlyTotal },
      });
    });
    return ok(await this.detailOf(await this.findFull(shopId, customerId)));
  }

  /* ================= 9. CUSTOMER EDIT ================= */
  async updateCustomer(shopId: string, id: string, dto: UpdateCustomerDto) {
    if (dto.firstDueDate !== undefined && !isRealDate(dto.firstDueDate)) {
      throw new BadRequestException('Agli baqi qist ki tareekh sahi likhein');
    }

    const data: Prisma.CustomerUpdateManyMutationInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.fatherName !== undefined) data.fatherName = clean(dto.fatherName);
    if (dto.phone !== undefined) data.phone = digits(dto.phone);
    if (dto.cnic !== undefined) data.cnic = clean(dto.cnic);
    if (dto.address !== undefined) data.address = clean(dto.address);
    if (dto.photo !== undefined) {
      data.photo = await this.storage.saveBase64(dto.photo, 'customers');
    }

    if (dto.monthlyPayment !== undefined) {
      if (
        !Number.isSafeInteger(dto.monthlyPayment) ||
        dto.monthlyPayment < 1 ||
        dto.monthlyPayment > 2147483647
      ) {
        throw new BadRequestException('Mahine ki qist ki raqam sahi likhein');
      }
      const newMonthlyPayment = dto.monthlyPayment;
      const currentCustomer = await this.findFull(shopId, id);
      if (currentCustomer.purchases.length > 0) {
        await this.prisma.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "customers"
            WHERE id = ${id} AND "shopId" = ${shopId} AND "deletedAt" IS NULL
            FOR UPDATE
          `;
          if (!locked.length) throw new NotFoundException('Customer nahi mila');

          if (dto.firstDueDate !== undefined) {
            const customer = await tx.customer.findFirst({
              where: { id, shopId, deletedAt: null, archivedAt: null },
              include: FULL,
            });
            if (!customer) throw new NotFoundException('Customer nahi mila');
            await this.saveBaseScheduleDate(tx, customer, dto.firstDueDate);
          }

          const result = await tx.customer.updateMany({
            where: { id, shopId, deletedAt: null, archivedAt: null },
            data: {
              ...data,
              monthlyCollectionTarget: newMonthlyPayment,
            },
          });
          if (!result.count) throw new NotFoundException('Customer nahi mila');
        });
        return ok(await this.detailOf(await this.findFull(shopId, id)));
      }

      if (newMonthlyPayment !== currentCustomer.monthlyPayment) {
        await this.prisma.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "customers"
            WHERE id = ${id} AND "shopId" = ${shopId} AND "deletedAt" IS NULL
            FOR UPDATE
          `;
          if (!locked.length) throw new NotFoundException('Customer nahi mila');

          const customer = await tx.customer.findFirst({
            where: { id, shopId, deletedAt: null, archivedAt: null },
            include: FULL,
          });
          if (!customer) throw new NotFoundException('Customer nahi mila');
          if (newMonthlyPayment === customer.monthlyPayment) {
            await tx.customer.updateMany({
              where: { id, shopId, deletedAt: null, archivedAt: null },
              data,
            });
            return;
          }

          const schedule = this.financialOf(customer, todayIso()).plans[0].rows;
          const current = schedule.find((row) => row.status !== 'paid');
          if (!current) {
            throw new BadRequestException(
              'Mukammal customer ki qist ki raqam tabdeel nahi ho sakti',
            );
          }

          const fromInstallmentNo =
            current.paid > 0 ? current.no + 1 : current.no;
          if (fromInstallmentNo > schedule.length) {
            throw new BadRequestException(
              'Current qist mukammal karein, phir nayi raqam set karein',
            );
          }
          const rateChanges = customer.rateChanges.map((change) => ({
            fromInstallmentNo: change.fromInstallmentNo,
            monthlyPayment: change.monthlyPayment,
          }));
          const existingChange = rateChanges.find(
            (change) => change.fromInstallmentNo === fromInstallmentNo,
          );
          if (existingChange) {
            existingChange.monthlyPayment = newMonthlyPayment;
          } else {
            rateChanges.push({
              fromInstallmentNo,
              monthlyPayment: newMonthlyPayment,
            });
          }
          rateChanges.sort((a, b) => a.fromInstallmentNo - b.fromInstallmentNo);
          const plan = this.plan(customer);
          const proposedSchedule = this.financialOf(
            customer,
            todayIso(),
            rateChanges,
          ).plans[0].rows;
          const scheduledBalance = proposedSchedule.reduce(
            (sum, row) => sum + row.expected,
            0,
          );
          if (
            proposedSchedule.length >= MAX_SCHEDULE_INSTALLMENTS &&
            scheduledBalance < totalOf(plan) - customer.downPayment
          ) {
            throw new BadRequestException('Qiston ka schedule bohat lamba hai');
          }

          if (dto.firstDueDate !== undefined) {
            await this.saveBaseScheduleDate(tx, customer, dto.firstDueDate);
          }

          const result = await tx.customer.updateMany({
            where: { id, shopId, deletedAt: null, archivedAt: null },
            data: { ...data, monthlyPayment: newMonthlyPayment },
          });
          if (!result.count) throw new NotFoundException('Customer nahi mila');

          await tx.customerRateChange.upsert({
            where: {
              customerId_fromInstallmentNo: {
                customerId: id,
                fromInstallmentNo,
              },
            },
            create: {
              customerId: id,
              fromInstallmentNo,
              monthlyPayment: newMonthlyPayment,
            },
            update: { monthlyPayment: newMonthlyPayment },
          });
        });
        return ok(await this.detailOf(await this.findFull(shopId, id)));
      }
    }

    const firstDueDate = dto.firstDueDate;
    let result: Prisma.BatchPayload;
    if (firstDueDate !== undefined) {
      result = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "customers"
          WHERE id = ${id} AND "shopId" = ${shopId} AND "deletedAt" IS NULL
          FOR UPDATE
        `;
        if (!locked.length) throw new NotFoundException('Customer nahi mila');

        const customer = await tx.customer.findFirst({
          where: { id, shopId, deletedAt: null, archivedAt: null },
          include: FULL,
        });
        if (!customer) throw new NotFoundException('Customer nahi mila');
        await this.saveBaseScheduleDate(tx, customer, firstDueDate);

        return tx.customer.updateMany({
          where: { id, shopId, deletedAt: null, archivedAt: null },
          data,
        });
      });
    } else {
      result = await this.prisma.customer.updateMany({
        where: { id, shopId, deletedAt: null, archivedAt: null },
        data,
      });
    }
    if (!result.count) throw new NotFoundException('Customer nahi mila');

    return ok(await this.detailOf(await this.findFull(shopId, id)));
  }

  /* ================= 10. CUSTOMER DELETE ================= */
  async deleteCustomer(
    shopId: string,
    id: string,
    meta?: { ip?: string; userAgent?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Row-level lock on the customer in PostgreSQL
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "customers"
        WHERE id = ${id} AND "shopId" = ${shopId} AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      if (!locked || locked.length === 0) {
        throw new NotFoundException('Customer nahi mila');
      }

      const c = await tx.customer.findFirst({
        where: { id, shopId, deletedAt: null },
        select: { ...LEAN_SELECT, fatherName: true, cnic: true },
      });
      if (!c) throw new NotFoundException('Customer nahi mila');

      const financial = this.financialOf(c, todayIso());
      const requestedAt = new Date();
      await tx.customer.update({
        where: { id: c.id },
        data: { deletedAt: requestedAt, deletionRequestedAt: requestedAt },
      });
      await this.audit.recordWithTx(tx, {
        actorType: 'shop',
        actorId: shopId,
        action: 'CUSTOMER_DELETED',
        entityType: 'Customer',
        entityId: c.id,
        details: {
          snapshot: {
            code: customerCode(c.customerNo),
            name: c.name,
            fatherName: c.fatherName,
            phone: c.phone,
            cnicLast4: c.cnic ? digits(c.cnic).slice(-4) : null,
            totalPrice: financial.total,
            remaining: financial.remaining,
            totalPaid: financial.paid,
            paymentsCount: c.payments.length,
            itemNames: [
              ...c.items.map((item) => item.name),
              ...c.purchases.flatMap((purchase) =>
                purchase.items.map((item) => item.name),
              ),
            ],
            createdAt: c.createdAt,
            archived: c.archivedAt !== null,
            actor: { type: 'shop', id: shopId },
            ip: meta?.ip ?? null,
          },
        },
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });

      return ok({ ok: true });
    });
  }

  /* ================= 11. DOCUMENT BADALNA ================= */
  async setDocument(shopId: string, id: string, docKey: string, photo: string) {
    const field = this.docField(docKey);

    const existing = await this.prisma.customer.findFirst({
      where: { id, shopId, deletedAt: null, archivedAt: null },
      select: { [field]: true } as any,
    });
    if (!existing) throw new NotFoundException('Customer nahi mila');

    const photoUrl = await this.storage.saveBase64(photo, 'documents');
    const oldFile = (existing as any)[field];
    if (oldFile && oldFile !== photoUrl) {
      await this.storage.deleteFile(oldFile);
    }

    const data: Prisma.CustomerUpdateManyMutationInput = {};
    data[field] = photoUrl;

    const result = await this.prisma.customer.updateMany({
      where: { id, shopId, deletedAt: null, archivedAt: null },
      data,
    });
    if (!result.count) throw new NotFoundException('Customer nahi mila');
    return ok({ ok: true, url: photoUrl });
  }

  /* ================= 12. DOCUMENT HATANA ================= */
  async removeDocument(shopId: string, id: string, docKey: string) {
    const field = this.docField(docKey);

    const existing = await this.prisma.customer.findFirst({
      where: { id, shopId, deletedAt: null, archivedAt: null },
      select: { [field]: true } as any,
    });
    if (!existing) throw new NotFoundException('Customer nahi mila');

    const oldFile = (existing as any)[field];
    if (oldFile) {
      await this.storage.deleteFile(oldFile);
    }

    const data: Prisma.CustomerUpdateManyMutationInput = {};
    data[field] = null;

    const result = await this.prisma.customer.updateMany({
      where: { id, shopId, deletedAt: null, archivedAt: null },
      data,
    });
    if (!result.count) throw new NotFoundException('Customer nahi mila');
    return ok({ ok: true });
  }

  /* ================= 13. LATE ================= */
  async late(shopId: string) {
    const customers = await this.loadAll(shopId);
    return ok(this.lateOf(customers, todayIso()));
  }

  /* ================= 14. STATUS (MONTH REPORT) ================= */
  async status(
    shopId: string,
    month?: string,
  ): Promise<{ status: 'success'; data: StatusReportData }> {
    const reportMonth = month ?? currentMonth();
    if (reportMonth < currentMonth()) {
      const snapshot = await this.prisma.monthlyReportSnapshot.findUnique({
        where: { shopId_month: { shopId, month: reportMonth } },
      });
      if (snapshot) {
        if (!isStatusReportData(snapshot.data)) {
          throw new InternalServerErrorException(
            'Stored monthly report snapshot is invalid',
          );
        }
        return ok(snapshot.data);
      }
      const data = await this.buildStatusData(shopId, reportMonth);
      const saved = await this.prisma.monthlyReportSnapshot.upsert({
        where: { shopId_month: { shopId, month: reportMonth } },
        create: {
          shopId,
          month: reportMonth,
          data: data as Prisma.InputJsonValue,
        },
        update: {},
      });
      if (!isStatusReportData(saved.data)) {
        throw new InternalServerErrorException(
          'Stored monthly report snapshot is invalid',
        );
      }
      return ok(saved.data);
    }
    return ok(await this.buildStatusData(shopId, reportMonth));
  }

  async buildStatusData(
    shopId: string,
    reportMonth: string,
  ): Promise<StatusReportData> {
    const customers = await this.loadAll(shopId, undefined, true);
    const [year, monthNumber] = reportMonth.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const reportEnd = `${reportMonth}-${String(lastDay).padStart(2, '0')}`;
    const [report, cashBreakdown] = await Promise.all([
      this.reportOf(customers, reportMonth, todayIso()),
      this.cashInRange(shopId, `${reportMonth}-01`, reportEnd, true),
    ]);
    return {
      ...report,
      cashCollected: cashBreakdown.total,
      cashBreakdown: {
        thisMonth: cashBreakdown.forPeriod,
        late: cashBreakdown.late,
        advance: cashBreakdown.advance,
      },
    };
  }

  private async cashInRange(
    shopId: string,
    fromIso: string,
    toIso: string,
    includeArchived = false,
  ) {
    const customers = await this.loadAll(shopId, undefined, includeArchived);
    const from = new Date(`${fromIso}T00:00:00+05:00`);
    const afterToIso = new Date(
      Date.parse(`${toIso}T00:00:00Z`) + 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    const until = new Date(`${afterToIso}T00:00:00+05:00`);
    const payments = customers.flatMap((customer) =>
      customer.payments
        .filter(
          (payment) =>
            !payment.reversedAt &&
            payment.paidOn >= from &&
            payment.paidOn < until,
        )
        .map((payment) => ({ id: payment.id, amount: payment.amount })),
    );
    const paymentIds = new Set(payments.map((payment) => payment.id));
    const allocations = customers.flatMap((customer) =>
      this.financialOf(customer, todayIso()).allocations.filter((allocation) =>
        paymentIds.has(allocation.paymentId),
      ),
    );
    return summarizeCashInRange(payments, allocations, fromIso, toIso);
  }

  /* ================= helpers ================= */
  private loadAll(
    shopId: string,
    search?: string,
    includeArchived = false,
  ): Promise<CustomerLean[]> {
    const where: Prisma.CustomerWhereInput = {
      shopId,
      deletedAt: null,
      ...(includeArchived ? {} : { archivedAt: null }),
    };

    if (search) {
      const q = search.trim();
      const phoneDigits = digits(q);
      const codeMatch = /^c-?(\d{1,9})$/i.exec(q);

      const or: Prisma.CustomerWhereInput[] = [
        { name: { contains: q, mode: 'insensitive' } },
      ];
      if (phoneDigits) {
        or.push({ phone: { contains: phoneDigits } });
      }
      if (codeMatch) {
        or.push({ customerNo: Number(codeMatch[1]) });
      }
      where.OR = or;
    }

    return this.prisma.customer.findMany({
      where,
      select: LEAN_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findFull(
    shopId: string,
    id: string,
    includeArchived = false,
  ): Promise<CustomerFull> {
    const c = await this.prisma.customer.findFirst({
      where: {
        id,
        shopId,
        deletedAt: null,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: FULL,
    });
    if (!c) throw new NotFoundException('Customer nahi mila');
    return c;
  }

  private docField(key: string) {
    const field = DOC_FIELDS[key as keyof typeof DOC_FIELDS];
    if (!field) throw new BadRequestException('Document ka naam sahi nahi hai');
    return field;
  }

  private async saveBaseScheduleDate(
    tx: Prisma.TransactionClient,
    customer: CustomerFull,
    firstDueDate: string,
  ) {
    const currentPlan = this.financialOf(customer, todayIso()).plans[0];
    const current = currentPlan?.rows.find((row) => row.status !== 'paid');
    if (!current) {
      if (customer.firstDueDate === firstDueDate) return;
      throw new BadRequestException(
        'Mukammal plan ki qist ki tareekh tabdeel nahi ho sakti',
      );
    }
    if (current.dueDate === firstDueDate) return;

    await tx.customerScheduleDateChange.upsert({
      where: {
        customerId_fromInstallmentNo: {
          customerId: customer.id,
          fromInstallmentNo: current.no,
        },
      },
      create: {
        customerId: customer.id,
        fromInstallmentNo: current.no,
        firstDueDate,
      },
      update: { firstDueDate },
    });
  }

  private plan(c: CustomerRecord): PlanInput {
    return {
      items: c.items,
      downPayment: c.downPayment,
      initialMonthlyPayment: c.initialMonthlyPayment,
      firstDueDate: c.firstDueDate,
      scheduleDateChanges: c.scheduleDateChanges,
      rateChanges: c.rateChanges,
      payments: [],
    };
  }

  private financialOf(
    c: CustomerRecord,
    today: string,
    baseRateChanges: {
      fromInstallmentNo: number;
      monthlyPayment: number;
    }[] = c.rateChanges,
  ) {
    const definitions: MultiPlanInput[] = [
      {
        id: 'base',
        items: c.items,
        downPayment: c.downPayment,
        initialMonthlyPayment: c.initialMonthlyPayment,
        firstDueDate: c.firstDueDate,
        scheduleDateChanges: c.scheduleDateChanges,
        rateChanges: baseRateChanges,
        createdAt: c.createdAt,
      },
    ];
    const payments = c.payments
      .filter((payment) => !payment.reversedAt)
      .map((payment) => ({
        id: payment.id,
        amount: payment.amount,
        paidOn: payment.paidOn,
        createdAt: payment.createdAt,
        method: payment.method,
        note: payment.note,
      }));
    definitions.push(
      ...c.purchases.map((purchase) => ({
        id: purchase.id,
        items: purchase.items,
        downPayment: purchase.downPayment,
        initialMonthlyPayment: purchase.initialMonthlyPayment,
        firstDueDate: purchase.firstDueDate,
        scheduleStartDate: addMonths(
          c.firstDueDate,
          purchase.allocationStartInstallmentNo - 1,
        ),
        scheduleDateChanges: purchase.scheduleDateChanges,
        rateChanges: purchase.rateChanges,
        createdAt: purchase.createdAt,
      })),
    );
    const { schedules, allocations } = buildMultiPlanSchedulesWithAllocations(
      definitions,
      payments,
      c.firstDueDate,
      today,
    );
    const plans = definitions.map((definition, index) => {
      const rows = schedules[index];
      if (!definition.firstDueDate) {
        for (const row of rows) {
          row.daysLate = 0;
          if (row.status === 'overdue') row.status = 'pending';
        }
      }
      const total = totalOf(definition);
      const paid =
        definition.downPayment + rows.reduce((sum, row) => sum + row.paid, 0);
      return {
        id: definition.id,
        label: planLabel(index),
        total,
        paid,
        remaining: total - paid,
        downPayment: definition.downPayment,
        monthly:
          index === 0
            ? c.monthlyPayment
            : c.purchases[index - 1].monthlyPayment,
        firstDueDate: definition.firstDueDate,
        items: definition.items,
        rows,
      };
    });
    const total = plans.reduce((sum, plan) => sum + plan.total, 0);
    const paid = plans.reduce((sum, plan) => sum + plan.paid, 0);
    return {
      plans,
      total,
      paid,
      remaining: total - paid,
      monthlyTotal: activeMonthlyTotal(plans, c.monthlyCollectionTarget),
      allocations,
    };
  }

  private toListItem(c: CustomerRecord, today: string) {
    const financial = this.financialOf(c, today);
    const rows =
      financial.plans.length > 1
        ? combineInstallmentSchedules(financial.plans.map((plan) => plan.rows))
        : financial.plans.flatMap((plan) => plan.rows);
    const total = financial.total;
    const paid = financial.paid;
    const remaining = financial.remaining;
    const status: CustomerStatus = c.archivedAt
      ? 'archived'
      : remaining <= 0
        ? 'completed'
        : rows.some((row) => row.status !== 'paid' && row.daysLate > 0)
          ? 'overdue'
          : 'active';

    return {
      id: c.id,
      code: customerCode(c.customerNo),
      name: c.name,
      phone: formatMobile(c.phone),
      photo: c.photo ?? undefined,
      status,
      archivedAt: c.archivedAt,
      paid,
      hasPayments: c.payments.length > 0,
      remaining,
      paidCount: rows.filter((r) => r.status === 'paid').length,
      totalCount: rows.length,
      progress: total ? Math.round((paid / total) * 100) : 0,
    };
  }

  private detailOf(c: CustomerFull) {
    const today = todayIso();
    const financial = this.financialOf(c, today);
    const rows =
      financial.plans.length > 1
        ? combineInstallmentSchedules(
            financial.plans.map((plan) => plan.rows),
          ).map((row) => {
            const contributingPlans = financial.plans
              .map((plan, index) => ({
                plan,
                index,
                installment: plan.rows.find(
                  (planRow) => planRow.dueDate === row.dueDate,
                ),
              }))
              .filter(({ installment }) => installment);
            const onlyPlan = contributingPlans[0];
            return {
              ...row,
              no:
                contributingPlans.length === 1
                  ? (onlyPlan?.installment?.no ?? row.no)
                  : row.no,
              planId:
                contributingPlans.length === 1
                  ? (onlyPlan?.plan.id ?? 'combined')
                  : 'combined',
              planLabel:
                contributingPlans.length === 1
                  ? (onlyPlan?.plan.label ?? 'Tamam plans')
                  : 'Tamam plans',
            };
          })
        : financial.plans.flatMap((plan) =>
            plan.rows.map((row) => ({ ...row, planId: plan.id })),
          );
    const lateRows = rows.filter(
      (row) => row.status !== 'paid' && row.daysLate > 0,
    );
    const next =
      financial.plans.length === 1
        ? (rows.find(
            (row) =>
              row.status !== 'paid' &&
              row.daysLate === 0 &&
              row.dueDate >= today,
          ) ?? rows.find((row) => row.status !== 'paid'))
        : rows.find((row) => row.status !== 'paid');
    const listItem = this.toListItem(c, today);

    return {
      ...listItem,
      fatherName: c.fatherName ?? undefined,
      cnic: c.cnic ?? undefined,
      address: c.address ?? undefined,
      total: financial.total,
      paid: financial.paid,
      remaining: financial.remaining,
      downPayment: c.downPayment,
      monthly: c.monthlyPayment,
      monthlyTotal: financial.monthlyTotal,
      hasPayments: c.payments.length > 0,
      firstDueDate: c.firstDueDate,
      items: c.items.map((i) => ({
        name: i.name,
        price: i.price,
        boughtOn: i.boughtOn,
        photo: i.photo ?? undefined,
      })),
      plans: financial.plans.map((plan) => ({
        id: plan.id,
        label: financial.plans.length > 1 ? plan.label : undefined,
        total: plan.total,
        paid: plan.paid,
        remaining: plan.remaining,
        downPayment: plan.downPayment,
        monthly: plan.monthly,
        firstDueDate: plan.firstDueDate ?? undefined,
        receivedInstallments: plan.rows.filter((row) => row.status === 'paid')
          .length,
        totalInstallments: plan.rows.length,
        items: plan.items.map((item) => ({
          name: item.name,
          price: item.price,
          boughtOn: item.boughtOn,
          photo: item.photo ?? undefined,
        })),
        installments: plan.rows,
      })),
      installments: rows,
      documents: {
        cnicFront: c.docCnicFront ?? undefined,
        cnicBack: c.docCnicBack ?? undefined,
        other: c.docOther ?? undefined,
      },
      late: lateRows.length
        ? {
            amount: lateRows.reduce((s, r) => s + r.expected - r.paid, 0),
            days: lateRows[0].daysLate,
            installmentNo: lateRows[0].no,
          }
        : undefined,
      next: next
        ? {
            no: next.no,
            planId: next.planId,
            planLabel: financial.plans.length > 1 ? 'Tamam plans' : undefined,
            dueDate: next.dueDate,
            amount: next.expected - next.paid,
            daysLate: next.daysLate,
          }
        : undefined,
    };
  }

  private paymentReceipt(
    customer: CustomerFull,
    payment: CustomerFull['payments'][number],
    today: string,
  ) {
    const orderedPayments = [
      ...customer.payments.filter((item) => item.id !== payment.id),
      payment,
    ]
      .filter((item) => !item.reversedAt || item.id === payment.id)
      .sort(
        (left, right) =>
          left.paidOn.getTime() - right.paidOn.getTime() ||
          left.createdAt.getTime() - right.createdAt.getTime(),
      );
    const paymentIndex = orderedPayments.findIndex(
      (item) => item.id === payment.id,
    );
    const precedingPayments = orderedPayments.slice(0, paymentIndex);
    const paymentForAllocation = { ...payment, reversedAt: null };
    const after = this.financialOf(
      {
        ...customer,
        payments: [...precedingPayments, paymentForAllocation],
      },
      today,
    );
    const allocations = after.allocations
      .filter((allocation) => allocation.paymentId === payment.id)
      .map((allocation) => {
        const plan = after.plans.find((item) => item.id === allocation.planKey);
        return {
          ...(customer.purchases.length > 0 && plan
            ? { planLabel: plan.label }
            : {}),
          installmentNo: allocation.installmentNo,
          dueDate: allocation.dueDate,
          amount: allocation.amount,
        };
      });
    const remainingLateRows = combineInstallmentSchedules(
      after.plans.map((plan) => plan.rows),
    ).filter((row) => row.status !== 'paid' && row.daysLate > 0);

    return {
      ok: true,
      allocations,
      remainingLateCount: remainingLateRows.length,
      remainingLateAmount: remainingLateRows.reduce(
        (sum, row) => sum + row.expected - row.paid,
        0,
      ),
    };
  }

  private collectionOf(customers: CustomerRecord[], today: string) {
    const out: {
      id: string;
      customerId: string;
      name: string;
      phone: string;
      photo?: string;
      installmentNo: number;
      dueDate: string;
      expected: number;
      paid: number;
      status: 'paid' | 'pending' | 'partial';
      overdueInstallmentCount: number;
    }[] = [];

    for (const c of customers) {
      const plans = this.financialOf(c, today).plans;
      if (!plans[0]?.firstDueDate) continue;
      const rows = combineInstallmentSchedules(plans.map((plan) => plan.rows));
      const overdueInstallmentCount = rows.filter(
        (row) => row.status !== 'paid' && row.daysLate > 0,
      ).length;
      for (const row of rows) {
        if (row.dueDate !== today) continue;
        out.push({
          id: `${c.id}-${row.no}`,
          customerId: c.id,
          name: c.name,
          phone: formatMobile(c.phone),
          photo: c.photo ?? undefined,
          installmentNo: row.no,
          dueDate: row.dueDate,
          expected: row.expected,
          paid: row.paid,
          status: row.status === 'overdue' ? 'pending' : row.status,
          overdueInstallmentCount,
        });
      }
    }
    return out;
  }

  private lateOf(customers: CustomerRecord[], today: string) {
    const thisMonth = currentMonth();
    const out: {
      customerId: string;
      name: string;
      phone: string;
      photo?: string;
      lateAmount: number;
      lateThisMonthAmount: number;
      lateCount: number;
      daysLate: number;
      lastPayment: string;
      oldestInstallmentNo: number;
      oldestRemaining: number;
      oldestDueDate: string;
    }[] = [];

    for (const c of customers) {
      const plans = this.financialOf(c, today).plans;
      const rows = plans[0]?.firstDueDate
        ? combineInstallmentSchedules(plans.map((plan) => plan.rows)).filter(
            (r) => r.status !== 'paid' && r.daysLate > 0,
          )
        : [];
      if (!rows.length) continue;

      const live = c.payments.filter((p) => !p.reversedAt);
      const lastPayment = live.length
        ? dateOnly(live[live.length - 1].paidOn)
        : c.firstDueDate;

      out.push({
        customerId: c.id,
        name: c.name,
        phone: formatMobile(c.phone),
        photo: c.photo ?? undefined,
        lateAmount: rows.reduce((s, r) => s + r.expected - r.paid, 0),
        lateThisMonthAmount: rows
          .filter((row) => row.dueDate.startsWith(thisMonth))
          .reduce((sum, row) => sum + row.expected - row.paid, 0),
        lateCount: rows.length,
        daysLate: rows[0].daysLate,
        lastPayment,
        oldestInstallmentNo: rows[0].no,
        oldestRemaining: rows[0].expected - rows[0].paid,
        oldestDueDate: rows[0].dueDate,
      });
    }
    return out.sort((a, b) => b.daysLate - a.daysLate);
  }

  private reportOf(customers: CustomerRecord[], month: string, today: string) {
    const customerRows = customers
      .map((customer) => {
        const plans = this.financialOf(customer, today).plans;
        const rows = plans[0]?.firstDueDate
          ? combineInstallmentSchedules(plans.map((plan) => plan.rows)).filter(
              (row) => row.dueDate.startsWith(month),
            )
          : [];
        return { customer, rows };
      })
      .filter(({ rows }) => rows.length > 0);
    const rows = customerRows.flatMap(({ rows }) => rows);

    const expected = rows.reduce((s, r) => s + r.expected, 0);
    const received = rows.reduce((s, r) => s + r.paid, 0);

    return {
      month,
      label: monthLabel(month),
      expected,
      received,
      remaining: expected - received,
      overdue: rows
        .filter((r) => r.status !== 'paid' && r.daysLate > 0)
        .reduce((s, r) => s + r.expected - r.paid, 0),
      collectedPercent: expected ? Math.round((received / expected) * 100) : 0,
      totalCustomers: customers.length,
      paidInstallments: rows.filter((r) => r.status === 'paid').length,
      pendingInstallments: rows.filter((r) => r.status !== 'paid').length,
      lateInstallments: rows.filter(
        (row) => row.status !== 'paid' && row.daysLate > 0,
      ).length,
      overdueCustomers: this.lateOf(customers, today).length,
      customers: customerRows
        .map(({ customer, rows: customerMonthRows }) => {
          const customerExpected = customerMonthRows.reduce(
            (sum, row) => sum + row.expected,
            0,
          );
          const customerReceived = customerMonthRows.reduce(
            (sum, row) => sum + row.paid,
            0,
          );
          const lateRows = customerMonthRows.filter(
            (row) => row.status !== 'paid' && row.daysLate > 0,
          );
          const paidRows = customerMonthRows.filter(
            (row) => row.status === 'paid',
          );
          const pendingRows = customerMonthRows.filter(
            (row) => row.status !== 'paid' && row.daysLate === 0,
          );
          const paidInstallments = customerMonthRows.filter(
            (row) => row.status === 'paid',
          ).length;
          const lateInstallments = lateRows.length;
          return {
            customerId: customer.id,
            name: customer.name,
            phone: formatMobile(customer.phone),
            expected: customerExpected,
            received: customerReceived,
            remaining: customerExpected - customerReceived,
            overdue: lateRows.reduce(
              (sum, row) => sum + row.expected - row.paid,
              0,
            ),
            paidInstallments,
            lateInstallments,
            pendingInstallments: customerMonthRows.length - paidInstallments,
            paidInstallmentDates: paidRows.map((row) => row.dueDate),
            lateInstallmentDates: lateRows.map((row) => row.dueDate),
            pendingInstallmentDates: pendingRows.map((row) => row.dueDate),
          };
        })
        .sort((a, b) => b.overdue - a.overdue || a.name.localeCompare(b.name)),
    };
  }
}
