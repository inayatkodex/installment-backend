import {
  BadRequestException,
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
  buildMultiPlanSchedules,
  buildSchedule,
  combineInstallmentSchedules,
  addMonths,
  customerCode,
  isRealDate,
  isValidPlan,
  MAX_SCHEDULE_INSTALLMENTS,
  PlanInput,
  MultiPlanInput,
  startOfToday,
  timeLabel,
  todayIso,
  totalOf,
} from './shop.logic';

const FULL = {
  items: true,
  payments: { orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }] },
  rateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
  purchases: {
    include: {
      items: true,
      rateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
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
  rateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
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
    purchases: { include: { items: true; rateChanges: true } };
  };
}>;

type CustomerLean = Prisma.CustomerGetPayload<{
  select: typeof LEAN_SELECT;
}>;

type CustomerRecord = CustomerLean | CustomerFull;
type CustomerStatus = 'active' | 'overdue' | 'completed';

const ok = <T>(data: T) => ({ status: 'success', data });
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
        createdAt: true,
      },
    });
    if (!shop) throw new NotFoundException('Shop nahi mili');
    const { shopNo, ...details } = shop;
    return ok({ ...details, shopCode: shopCode(shopNo) });
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
    const today = todayIso();

    const items = this.collectionOf(customers, today);
    const expected = items.reduce((s, i) => s + i.expected, 0);
    const received = items.reduce((s, i) => s + i.paid, 0);
    const late = this.lateOf(customers, today);
    const m = this.reportOf(customers, currentMonth(), today);

    return ok({
      dueCount: items.filter((i) => i.status !== 'paid').length,
      expected,
      received,
      remaining: expected - received,
      lateCount: late.length,
      lateAmount: late.reduce((s, l) => s + l.lateAmount, 0),
      month: { label: m.label, expected: m.expected, received: m.received },
    });
  }

  /* ================= 2. AAJ KI WASOOLI ================= */
  async collectionToday(shopId: string) {
    const customers = await this.loadAll(shopId);
    return ok(this.collectionOf(customers, todayIso()));
  }

  /* ================= 3. AAJ MIL GAYE ================= */
  async paymentsToday(shopId: string) {
    const rows = await this.prisma.payment.findMany({
      where: {
        reversedAt: null,
        paidOn: { gte: startOfToday() },
        customer: { shopId, deletedAt: null },
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
        return ok({ ok: true });
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
          return ok({ ok: true });
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
        where: { id: dto.customerId, shopId, deletedAt: null },
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
          idempotencyKey: trimmedKey,
        },
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });

      return ok({ ok: true });
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
        where: { id, customer: { shopId, deletedAt: null } },
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

    const customers = await this.loadAll(shopId, searchRaw || undefined);
    const items = customers
      .map((c) => this.toListItem(c, today))
      .filter((c) => !q.status || q.status === 'all' || c.status === q.status);

    return ok(items);
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
    return ok(await this.detailOf(await this.findFull(shopId, id)));
  }

  async listPendingDeletion(shopId: string) {
    const customers = await this.prisma.customer.findMany({
      where: {
        shopId,
        deletedAt: { not: null },
        deletionRequestedAt: {
          gt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
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
      const customer = await tx.customer.findFirst({
        where: { id, shopId, deletedAt: { not: null } },
        select: { id: true, deletionRequestedAt: true },
      });
      if (!customer?.deletionRequestedAt) {
        throw new NotFoundException('Customer nahi mila');
      }
      if (
        customer.deletionRequestedAt.getTime() <=
        Date.now() - 24 * 60 * 60 * 1000
      ) {
        throw new BadRequestException(
          'Customer ko wapas lane ka 24 ghantay ka waqt khatam ho gaya',
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
        WHERE id = ${id} AND "shopId" = ${shopId} AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      if (!locked.length) throw new NotFoundException('Customer nahi mila');

      const customer = await tx.customer.findFirst({
        where: { id, shopId, deletedAt: null },
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
        'Plan ki pehli qist ki tareekh sahi likhein',
      );
    }

    const result = await this.prisma.customerPurchase.updateMany({
      where: {
        id: purchaseId,
        customerId,
        customer: { shopId, deletedAt: null },
      },
      data: { firstDueDate },
    });
    if (!result.count) throw new NotFoundException('Plan nahi mila');

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
        WHERE id = ${customerId} AND "shopId" = ${shopId} AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      if (!locked.length) throw new NotFoundException('Customer nahi mila');

      const customer = await tx.customer.findFirst({
        where: { id: customerId, shopId, deletedAt: null },
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
        WHERE id = ${customerId} AND "shopId" = ${shopId} AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      if (!locked.length) throw new NotFoundException('Customer nahi mila');

      const customer = await tx.customer.findFirst({
        where: { id: customerId, shopId, deletedAt: null },
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
      throw new BadRequestException('Pehli qist ki tareekh sahi likhein');
    }

    const data: Prisma.CustomerUpdateManyMutationInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.fatherName !== undefined) data.fatherName = clean(dto.fatherName);
    if (dto.phone !== undefined) data.phone = digits(dto.phone);
    if (dto.cnic !== undefined) data.cnic = clean(dto.cnic);
    if (dto.address !== undefined) data.address = clean(dto.address);
    if (dto.firstDueDate !== undefined) data.firstDueDate = dto.firstDueDate;
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

          const result = await tx.customer.updateMany({
            where: { id, shopId, deletedAt: null },
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
            where: { id, shopId, deletedAt: null },
            include: FULL,
          });
          if (!customer) throw new NotFoundException('Customer nahi mila');
          if (newMonthlyPayment === customer.monthlyPayment) {
            await tx.customer.updateMany({
              where: { id, shopId, deletedAt: null },
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

          const result = await tx.customer.updateMany({
            where: { id, shopId, deletedAt: null },
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

    const result = await this.prisma.customer.updateMany({
      where: { id, shopId, deletedAt: null },
      data,
    });
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
        include: FULL,
      });
      if (!c) throw new NotFoundException('Customer nahi mila');

      if (this.toListItem(c, todayIso()).status !== 'completed') {
        throw new BadRequestException(
          'Sirf wahi customer delete ho sakta hai jis ki saari qistein poori ho chuki hon',
        );
      }

      const requestedAt = new Date();
      await tx.customer.update({
        where: { id: c.id },
        data: { deletedAt: requestedAt, deletionRequestedAt: requestedAt },
      });
      await this.audit.recordWithTx(tx, {
        actorType: 'shop',
        actorId: shopId,
        action: 'CUSTOMER_DELETION_SCHEDULED',
        entityType: 'Customer',
        entityId: c.id,
        details: {
          scheduledFor: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000),
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
      where: { id, shopId, deletedAt: null },
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
      where: { id, shopId, deletedAt: null },
      data,
    });
    if (!result.count) throw new NotFoundException('Customer nahi mila');
    return ok({ ok: true, url: photoUrl });
  }

  /* ================= 12. DOCUMENT HATANA ================= */
  async removeDocument(shopId: string, id: string, docKey: string) {
    const field = this.docField(docKey);

    const existing = await this.prisma.customer.findFirst({
      where: { id, shopId, deletedAt: null },
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
      where: { id, shopId, deletedAt: null },
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
  async status(shopId: string, month?: string) {
    const customers = await this.loadAll(shopId);
    return ok(this.reportOf(customers, month ?? currentMonth(), todayIso()));
  }

  /* ================= helpers ================= */
  private loadAll(shopId: string, search?: string): Promise<CustomerLean[]> {
    const where: Prisma.CustomerWhereInput = { shopId, deletedAt: null };

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

  private async findFull(shopId: string, id: string): Promise<CustomerFull> {
    const c = await this.prisma.customer.findFirst({
      where: { id, shopId, deletedAt: null },
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

  private plan(c: CustomerRecord): PlanInput {
    return {
      items: c.items,
      downPayment: c.downPayment,
      initialMonthlyPayment: c.initialMonthlyPayment,
      firstDueDate: c.firstDueDate,
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
        rateChanges: baseRateChanges,
        createdAt: c.createdAt,
      },
    ];
    const payments = c.payments
      .filter((payment) => !payment.reversedAt)
      .map((payment) => ({
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
        rateChanges: purchase.rateChanges,
        createdAt: purchase.createdAt,
      })),
    );
    const schedules = buildMultiPlanSchedules(
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
    const status: CustomerStatus =
      remaining <= 0
        ? 'completed'
        : rows.some((row) => row.daysLate > 0)
          ? 'overdue'
          : 'active';

    return {
      id: c.id,
      code: customerCode(c.customerNo),
      name: c.name,
      phone: formatMobile(c.phone),
      photo: c.photo ?? undefined,
      status,
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
    const lateRows = rows.filter((row) => row.daysLate > 0);
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
      firstDueDate: c.firstDueDate,
      items: c.items.map((i) => ({
        name: i.name,
        price: i.price,
        boughtOn: i.boughtOn,
        photo: i.photo ?? undefined,
      })),
      plans: financial.plans.map((plan) => ({
        id: plan.id,
        label: plan.label,
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
    }[] = [];

    for (const c of customers) {
      const plans = this.financialOf(c, today).plans;
      if (!plans[0]?.firstDueDate) continue;
      const rows = combineInstallmentSchedules(plans.map((plan) => plan.rows));
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
        });
      }
    }
    return out;
  }

  private lateOf(customers: CustomerRecord[], today: string) {
    const out: {
      customerId: string;
      name: string;
      phone: string;
      photo?: string;
      lateAmount: number;
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
            (r) => r.daysLate > 0,
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
    const rows = customers
      .flatMap((c) => {
        const plans = this.financialOf(c, today).plans;
        return plans[0]?.firstDueDate
          ? combineInstallmentSchedules(plans.map((plan) => plan.rows))
          : [];
      })
      .filter((r) => r.dueDate.startsWith(month));

    const expected = rows.reduce((s, r) => s + r.expected, 0);
    const received = rows.reduce((s, r) => s + r.paid, 0);

    return {
      month,
      label: monthLabel(month),
      expected,
      received,
      remaining: expected - received,
      overdue: rows
        .filter((r) => r.daysLate > 0)
        .reduce((s, r) => s + r.expected - r.paid, 0),
      collectedPercent: expected ? Math.round((received / expected) * 100) : 0,
      totalCustomers: customers.length,
      paidInstallments: rows.filter((r) => r.status === 'paid').length,
      pendingInstallments: rows.filter((r) => r.status !== 'paid').length,
      overdueCustomers: this.lateOf(customers, today).length,
    };
  }
}
