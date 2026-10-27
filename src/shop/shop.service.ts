import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  currentMonth,
  dateOnly,
  formatMobile,
  monthLabel,
} from '../admin/admin.utils';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { ReceivePaymentDto } from './dto/receive-payment.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import {
  buildSchedule,
  customerCode,
  isRealDate,
  isValidPlan,
  monthlyOf,
  paidTotalOf,
  PlanInput,
  startOfToday,
  timeLabel,
  todayIso,
  totalOf,
} from './shop.logic';

const FULL = {
  items: true,
  payments: { orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.CustomerInclude;

type CustomerFull = Prisma.CustomerGetPayload<{
  include: { items: true; payments: true };
}>;
type CustomerStatus = 'active' | 'overdue' | 'completed';

const ok = <T>(data: T) => ({ status: 'success', data });
const clean = (v?: string) => v?.trim() || null;
const digits = (v: string) => v.replace(/\D/g, '');

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
  ) {}

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

      // Double-click protection for legacy clients without an idempotency key:
      // If the exact same customer, amount, and note was created within the last 3 seconds, suppress duplicate
      if (!trimmedKey) {
        const threeSecondsAgo = new Date(Date.now() - 3000);
        const recentDuplicate = c.payments.find(
          (p) =>
            !p.reversedAt &&
            p.amount === dto.amount &&
            p.createdAt >= threeSecondsAgo &&
            (p.note ?? null) === (dto.note?.trim() ?? null),
        );
        if (recentDuplicate) {
          return ok({ ok: true });
        }
      }

      // Recalculate remaining balance inside the locked transaction
      const plan = this.plan(c);
      const left = totalOf(plan) - paidTotalOf(plan);
      if (dto.amount > left) {
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
          remainingAfter: left - dto.amount,
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
        include: { customer: { select: { id: true, name: true, shopId: true } } },
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
    const search = (q.search ?? '').trim().toLowerCase().replace(/-/g, '');

    const items = (await this.loadAll(shopId))
      .map((c) => this.toListItem(c, today))
      .filter((c) => !q.status || q.status === 'all' || c.status === q.status)
      .filter(
        (c) =>
          !search ||
          c.name.toLowerCase().includes(search) ||
          c.phone.replace(/-/g, '').includes(search) ||
          c.code.toLowerCase().replace(/-/g, '').includes(search),
      );

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
    if (!isValidPlan(total, dto.downPayment, dto.months)) {
      throw new BadRequestException(
        'Qiston ki tadaad is raqam ke hisaab se sahi nahi hai',
      );
    }

    const today = todayIso();

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
          photo: dto.photo || null,
          docCnicFront: dto.documents?.cnicFront || null,
          docCnicBack: dto.documents?.cnicBack || null,
          docOther: dto.documents?.other || null,
          downPayment: dto.downPayment,
          months: dto.months,
          firstDueDate: dto.firstDueDate,
          items: {
            create: dto.items.map((i) => ({
              name: i.name.trim(),
              price: i.price,
              photo: i.photo || null,
              boughtOn: today,
            })),
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

  /* ================= 9. CUSTOMER EDIT ================= */
  async updateCustomer(shopId: string, id: string, dto: UpdateCustomerDto) {
    const data: Prisma.CustomerUpdateManyMutationInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.fatherName !== undefined) data.fatherName = clean(dto.fatherName);
    if (dto.phone !== undefined) data.phone = digits(dto.phone);
    if (dto.cnic !== undefined) data.cnic = clean(dto.cnic);
    if (dto.address !== undefined) data.address = clean(dto.address);

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

      // Soft delete: scoped strictly to shopId
      await tx.customer.updateMany({
        where: { id, shopId, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      // Write audit log inside the transaction
      await this.audit.recordWithTx(tx, {
        actorType: 'shop',
        actorId: shopId,
        action: 'CUSTOMER_DELETED',
        entityType: 'Customer',
        entityId: c.id,
        details: {
          customerName: c.name,
          customerNo: c.customerNo,
          total: totalOf(this.plan(c)),
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
    const data: Prisma.CustomerUpdateManyMutationInput = {};
    data[field] = photo;

    const result = await this.prisma.customer.updateMany({
      where: { id, shopId, deletedAt: null },
      data,
    });
    if (!result.count) throw new NotFoundException('Customer nahi mila');
    return ok({ ok: true });
  }

  /* ================= 12. DOCUMENT HATANA ================= */
  async removeDocument(shopId: string, id: string, docKey: string) {
    const field = this.docField(docKey);
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
  private loadAll(shopId: string): Promise<CustomerFull[]> {
    return this.prisma.customer.findMany({
      where: { shopId, deletedAt: null },
      include: FULL,
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

  private plan(c: CustomerFull): PlanInput {
    return {
      items: c.items,
      downPayment: c.downPayment,
      months: c.months,
      firstDueDate: c.firstDueDate,
      payments: c.payments.filter((p) => !p.reversedAt),
    };
  }

  private toListItem(c: CustomerFull, today: string) {
    const plan = this.plan(c);
    const rows = buildSchedule(plan, today);
    const total = totalOf(plan);
    const paid = paidTotalOf(plan);
    const remaining = total - paid;
    const status: CustomerStatus =
      remaining <= 0
        ? 'completed'
        : rows.some((r) => r.daysLate > 0)
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
      totalCount: c.months,
      progress: total ? Math.round((paid / total) * 100) : 0,
    };
  }

  private detailOf(c: CustomerFull) {
    const today = todayIso();
    const plan = this.plan(c);
    const rows = buildSchedule(plan, today);
    const lateRows = rows.filter((r) => r.daysLate > 0);
    const next = rows.find(
      (r) => r.status !== 'paid' && r.daysLate === 0 && r.dueDate >= today,
    );

    return {
      ...this.toListItem(c, today),
      fatherName: c.fatherName ?? undefined,
      cnic: c.cnic ?? undefined,
      address: c.address ?? undefined,
      total: totalOf(plan),
      paid: paidTotalOf(plan),
      downPayment: c.downPayment,
      monthly: monthlyOf(plan),
      items: c.items.map((i) => ({
        name: i.name,
        price: i.price,
        boughtOn: i.boughtOn,
        photo: i.photo ?? undefined,
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
            dueDate: next.dueDate,
            amount: next.expected - next.paid,
          }
        : undefined,
    };
  }

  private collectionOf(customers: CustomerFull[], today: string) {
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
      for (const r of buildSchedule(this.plan(c), today)) {
        if (r.dueDate !== today) continue;
        out.push({
          id: `${c.id}-${r.no}`,
          customerId: c.id,
          name: c.name,
          phone: formatMobile(c.phone),
          photo: c.photo ?? undefined,
          installmentNo: r.no,
          dueDate: r.dueDate,
          expected: r.expected,
          paid: r.paid,
          status: r.status === 'overdue' ? 'pending' : r.status,
        });
      }
    }
    return out;
  }

  private lateOf(customers: CustomerFull[], today: string) {
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
      const rows = buildSchedule(this.plan(c), today).filter(
        (r) => r.daysLate > 0,
      );
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

  private reportOf(customers: CustomerFull[], month: string, today: string) {
    const rows = customers
      .flatMap((c) => buildSchedule(this.plan(c), today))
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
