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
import { StorageService } from '../common/storage/storage.service';
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
  MAX_SCHEDULE_INSTALLMENTS,
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
  rateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
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
  firstDueDate: true,
  rateChanges: { orderBy: { fromInstallmentNo: 'asc' } },
  items: {
    select: {
      id: true,
      name: true,
      price: true,
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
    },
    orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.CustomerSelect;

type CustomerFull = Prisma.CustomerGetPayload<{
  include: { items: true; payments: true; rateChanges: true };
}>;

type CustomerLean = Prisma.CustomerGetPayload<{
  select: typeof LEAN_SELECT;
}>;

type CustomerRecord = CustomerLean | CustomerFull;
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
    private readonly storage: StorageService,
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
      if (!Number.isSafeInteger(dto.monthlyPayment) || dto.monthlyPayment < 1) {
        throw new BadRequestException('Mahine ki qist ki raqam sahi likhein');
      }
      const newMonthlyPayment = dto.monthlyPayment;
      const currentCustomer = await this.findFull(shopId, id);
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

          const schedule = buildSchedule(this.plan(customer), todayIso());
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
          rateChanges.sort(
            (a, b) => a.fromInstallmentNo - b.fromInstallmentNo,
          );
          const plan = this.plan(customer);
          const proposedSchedule = buildSchedule(
            { ...plan, rateChanges },
            todayIso(),
          );
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
      payments: c.payments.filter((p) => !p.reversedAt),
    };
  }

  private toListItem(c: CustomerRecord, today: string) {
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
      totalCount: rows.length,
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
      monthly: c.monthlyPayment,
      firstDueDate: c.firstDueDate,
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

  private reportOf(customers: CustomerRecord[], month: string, today: string) {
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
