import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma } from '../generated/prisma/client';
import { AuditService } from '../common/audit/audit.service';
import {
  shopDeletionRetentionCutoff,
  shopDeletionRetentionDays,
} from '../common/deletion-retention';
import { PrismaService } from '../prisma/prisma.service';
import {
  currentMonth,
  dateOnly,
  formatMobile,
  monthLabel,
  nextMonth,
  shopCode,
} from './admin.utils';
import { ListShopsQueryDto } from './dto/list-shops-query.dto';
import { ResetShopPasswordDto } from './dto/reset-shop-password.dto';
import { SetShopFeeDto } from './dto/set-shop-fee.dto';
import { UpdateShopStatusDto } from './dto/update-shop-status.dto';

type ShopWithFees = Prisma.ShopGetPayload<{
  include: { feeRecords: true; feeRates: true };
}>;

type FeeRateValue = { amount: number; effectiveFromMonth: string };

function feeForMonth(
  rates: FeeRateValue[],
  month: string,
  fallback: number,
): number {
  return (
    rates
      .filter((rate) => rate.effectiveFromMonth <= month)
      .sort((left, right) =>
        right.effectiveFromMonth.localeCompare(left.effectiveFromMonth),
      )[0]?.amount ?? fallback
  );
}

export interface FeeMonth {
  month: string;
  amount: number;
  status: 'paid' | 'unpaid';
  paidOn?: string;
  method?: string;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /* ---------------- 1. DASHBOARD ---------------- */
  async dashboard() {
    const cur = currentMonth();

    const [grouped, activeShops] = await Promise.all([
      this.prisma.shop.groupBy({
        by: ['status'],
        where: { pendingDeletionAt: null },
        _count: { _all: true },
      }),
      this.prisma.shop.findMany({
        where: { status: 'active', pendingDeletionAt: null },
        select: {
          monthlyFee: true,
          feeRates: {
            where: { effectiveFromMonth: { lte: cur } },
            orderBy: { effectiveFromMonth: 'desc' },
            take: 1,
          },
          feeRecords: {
            where: { month: cur },
            select: { amount: true, status: true },
          },
        },
      }),
    ]);

    const count = { pending: 0, active: 0, inactive: 0, archived: 0 };
    for (const g of grouped) count[g.status] = g._count._all;

    const feeDetails = activeShops.map((shop) => ({
      amount: feeForMonth(shop.feeRates, cur, shop.monthlyFee),
      record: shop.feeRecords[0],
    }));
    const billableShops = feeDetails.filter((fee) => fee.amount > 0);
    const feePaidShops = billableShops.filter(
      (fee) => fee.record?.status === 'paid',
    ).length;
    const feeCollected = billableShops.reduce(
      (total, fee) =>
        total + (fee.record?.status === 'paid' ? fee.record.amount : 0),
      0,
    );
    const feeRemaining = billableShops.reduce(
      (total, fee) => total + (fee.record?.status === 'paid' ? 0 : fee.amount),
      0,
    );

    return {
      status: 'success',
      data: {
        totalShops:
          count.pending + count.active + count.inactive + count.archived,
        activeShops: count.active,
        pendingShops: count.pending,
        inactiveShops: count.inactive,
        archivedShops: count.archived,
        monthLabel: monthLabel(cur),
        feeCollected,
        feePaidShops,
        feeRemaining,
        feeUnpaidShops: billableShops.length - feePaidShops,
        feePercent: billableShops.length
          ? Math.round((feePaidShops / billableShops.length) * 100)
          : 0,
      },
    };
  }

  /* ---------------- 2. SHOPS LIST ---------------- */
  async listShops(q: ListShopsQueryDto) {
    const cur = currentMonth();
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 8;

    const search = this.searchWhere(q.search);
    const statusWhere: Prisma.ShopWhereInput =
      q.status && q.status !== 'all' ? { status: q.status } : {};

    // Fees apply only to active/inactive shops
    let feeWhere: Prisma.ShopWhereInput = {};
    if (q.fee === 'paid') {
      feeWhere = {
        status: { in: ['active', 'inactive'] },
        feeRecords: { some: { month: cur, status: 'paid' } },
      };
    } else if (q.fee === 'unpaid') {
      feeWhere = {
        status: { in: ['active', 'inactive'] },
        feeRecords: { none: { month: cur, status: 'paid' } },
        OR: [
          { monthlyFee: { gt: 0 } },
          {
            feeRates: {
              some: {
                amount: { gt: 0 },
                effectiveFromMonth: { lte: cur },
              },
            },
          },
        ],
      };
    }

    const where: Prisma.ShopWhereInput = {
      AND: [search, statusWhere, feeWhere, { pendingDeletionAt: null }],
    };

    const [items, total, grouped] = await Promise.all([
      this.prisma.shop.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          feeRecords: { where: { month: cur } },
          feeRates: { orderBy: { effectiveFromMonth: 'desc' }, take: 2 },
        },
      }),
      this.prisma.shop.count({ where }),
      // Counts use only the search filter, not the status/fee filters
      this.prisma.shop.groupBy({
        by: ['status'],
        where: { AND: [search, { pendingDeletionAt: null }] },
        _count: { _all: true },
      }),
    ]);

    const counts = { all: 0, pending: 0, active: 0, inactive: 0, archived: 0 };
    for (const g of grouped) {
      counts[g.status] = g._count._all;
      counts.all += g._count._all;
    }

    return {
      status: 'success',
      data: {
        items: items.map((s) => this.mapShop(s, false)),
        total,
        page,
        pageSize,
        counts,
      },
    };
  }

  /* ---------------- 3. SHOP DETAIL ---------------- */
  async getShop(id: string) {
    return { status: 'success', data: await this.loadDetail(id) };
  }

  async resetShopPassword(
    id: string,
    dto: ResetShopPasswordDto,
    adminId: string,
    meta?: { ip?: string; userAgent?: string },
  ) {
    if (Buffer.byteLength(dto.newPassword, 'utf8') > 72) {
      throw new BadRequestException('Password must be no more than 72 bytes.');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.shop.updateMany({
        where: { id, pendingDeletionAt: null },
        data: {
          passwordHash,
          tokenVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new NotFoundException('Shop not found');
      }

      const shop = await tx.shop.findUniqueOrThrow({
        where: { id },
        select: { shopName: true },
      });
      await this.audit.recordWithTx(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'SHOP_PASSWORD_RESET',
        entityType: 'Shop',
        entityId: id,
        details: { shopName: shop.shopName },
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });
    });

    return { status: 'success', data: { ok: true } };
  }

  async listPendingDeletion() {
    const shops = await this.prisma.shop.findMany({
      where: {
        pendingDeletionAt: { gt: shopDeletionRetentionCutoff() },
      },
      select: {
        id: true,
        shopNo: true,
        shopName: true,
        ownerName: true,
        pendingDeletionAt: true,
      },
      orderBy: { pendingDeletionAt: 'asc' },
    });
    return {
      status: 'success',
      data: shops.map((shop) => ({
        id: shop.id,
        shopCode: shopCode(shop.shopNo),
        shopName: shop.shopName,
        ownerName: shop.ownerName,
        requestedAt: shop.pendingDeletionAt,
      })),
    };
  }

  async undoDeleteShop(id: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({
        where: { id },
        select: {
          id: true,
          pendingDeletionAt: true,
          deletionPreviousStatus: true,
        },
      });
      if (!shop?.pendingDeletionAt || !shop.deletionPreviousStatus) {
        throw new NotFoundException('Pending shop deletion not found');
      }
      if (shop.pendingDeletionAt <= shopDeletionRetentionCutoff()) {
        throw new BadRequestException('The shop recovery period has expired');
      }

      await tx.shop.update({
        where: { id },
        data: {
          status: shop.deletionPreviousStatus,
          pendingDeletionAt: null,
          deletionPreviousStatus: null,
        },
      });
      await this.audit.recordWithTx(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'SHOP_DELETION_UNDONE',
        entityType: 'Shop',
        entityId: id,
      });
      return { status: 'success', data: { ok: true } };
    });
  }

  async deleteShop(
    id: string,
    adminId: string,
    meta?: { ip?: string; userAgent?: string },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          pendingDeletionAt: true,
        },
      });
      if (!shop) throw new NotFoundException('Shop not found');
      if (shop.pendingDeletionAt) {
        throw new BadRequestException('Shop deletion is already pending');
      }

      const requestedAt = new Date();
      await tx.shop.update({
        where: { id },
        data: {
          deletionPreviousStatus: shop.status,
          pendingDeletionAt: requestedAt,
          status: 'archived',
        },
      });
      await this.audit.recordWithTx(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'SHOP_DELETION_SCHEDULED',
        entityType: 'Shop',
        entityId: id,
        details: {
          scheduledFor: new Date(
            requestedAt.getTime() +
              shopDeletionRetentionDays() * 24 * 60 * 60 * 1000,
          ),
        },
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });
    });

    return { status: 'success', data: { ok: true } };
  }

  /* ---------------- 4. SHOP STATUS ---------------- */
  async setStatus(
    id: string,
    dto: UpdateShopStatusDto,
    adminId?: string,
    meta?: { ip?: string; userAgent?: string },
  ) {
    const exists = await this.prisma.shop.findUnique({
      where: { id },
      select: {
        id: true,
        shopName: true,
        status: true,
        monthlyFee: true,
        pendingDeletionAt: true,
      },
    });
    if (!exists) throw new NotFoundException('Shop not found');
    if (exists.pendingDeletionAt) {
      throw new BadRequestException(
        'Restore this shop before changing its status',
      );
    }

    const reason = dto.reason?.trim();
    const keepsNote = dto.status === 'inactive' || dto.status === 'archived';
    const feeApplies = dto.status === 'active' || dto.status === 'inactive';
    const cur = currentMonth();

    await this.prisma.$transaction(async (tx) => {
      await tx.shop.update({
        where: { id },
        data: {
          status: dto.status,
          statusNote: keepsNote ? reason || null : null,
        },
      });

      // Create an unpaid fee record for this month when the status is active/inactive
      if (feeApplies) {
        const rate = await tx.shopFeeRate.findFirst({
          where: { shopId: id, effectiveFromMonth: { lte: cur } },
          orderBy: { effectiveFromMonth: 'desc' },
        });
        const amount = rate?.amount ?? exists.monthlyFee;
        if (amount > 0) {
          await tx.feeRecord.upsert({
            where: { shopId_month: { shopId: id, month: cur } },
            update: {},
            create: { shopId: id, month: cur, amount, status: 'unpaid' },
          });
        }
      }

      await this.audit.recordWithTx(tx, {
        actorType: 'admin',
        actorId: adminId || 'admin',
        action: 'SHOP_STATUS_CHANGED',
        entityType: 'Shop',
        entityId: id,
        details: {
          shopName: exists.shopName,
          oldStatus: exists.status,
          newStatus: dto.status,
          reason: reason || null,
        },
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });
    });

    return { status: 'success', data: await this.loadDetail(id) };
  }

  /* ---------------- 5. SHOP FEE ---------------- */
  async setFee(
    id: string,
    dto: SetShopFeeDto,
    adminId?: string,
    meta?: { ip?: string; userAgent?: string },
  ) {
    const shop = await this.prisma.shop.findUnique({
      where: { id },
      select: {
        status: true,
        monthlyFee: true,
        pendingDeletionAt: true,
      },
    });
    if (!shop) throw new NotFoundException('Shop not found');
    if (shop.pendingDeletionAt) {
      throw new BadRequestException(
        'Restore this shop before changing its fee',
      );
    }

    const where = { shopId_month: { shopId: id, month: dto.month } };
    const existing = await this.prisma.feeRecord.findUnique({ where });
    const rate = await this.prisma.shopFeeRate.findFirst({
      where: { shopId: id, effectiveFromMonth: { lte: dto.month } },
      orderBy: { effectiveFromMonth: 'desc' },
    });
    const amount = rate?.amount ?? shop.monthlyFee;
    if (amount <= 0) {
      throw new BadRequestException(
        'Set a monthly fee amount before recording payment',
      );
    }

    // Fee records can be created for active or inactive shops
    const canCreate = shop.status === 'active' || shop.status === 'inactive';
    if (!existing && !canCreate) {
      throw new NotFoundException('Fee record cannot be created for this shop');
    }

    const method = dto.method?.trim() || 'Cash';
    const data =
      dto.status === 'paid'
        ? {
            status: 'paid' as const,
            amount: existing?.amount || amount,
            paidOn: new Date(),
            method,
          }
        : {
            status: 'unpaid' as const,
            amount: existing?.amount || amount,
            paidOn: null,
            method: null,
          };

    await this.prisma.$transaction(async (tx) => {
      await tx.feeRecord.upsert({
        where,
        update: data,
        create: { shopId: id, month: dto.month, ...data },
      });

      await this.audit.recordWithTx(tx, {
        actorType: 'admin',
        actorId: adminId || 'admin',
        action: 'SHOP_FEE_UPDATED',
        entityType: 'FeeRecord',
        entityId: `${id}-${dto.month}`,
        details: {
          shopId: id,
          month: dto.month,
          previousStatus: existing?.status ?? 'unpaid',
          newStatus: dto.status,
          amount: data.amount,
        },
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });
    });

    return { status: 'success', data: await this.loadDetail(id) };
  }

  async setMonthlyFee(
    id: string,
    amount: number,
    adminId: string,
    meta?: { ip?: string; userAgent?: string },
  ) {
    const shop = await this.prisma.shop.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        monthlyFee: true,
        pendingDeletionAt: true,
      },
    });
    if (!shop || shop.pendingDeletionAt) {
      throw new NotFoundException('Shop not found');
    }

    const cur = currentMonth();
    const currentRate = await this.prisma.shopFeeRate.findFirst({
      where: { shopId: id, effectiveFromMonth: { lte: cur } },
      orderBy: { effectiveFromMonth: 'desc' },
    });
    const currentAmount = currentRate?.amount ?? shop.monthlyFee;
    const effectiveFromMonth = currentAmount > 0 ? nextMonth(cur) : cur;
    const where = {
      shopId_effectiveFromMonth: { shopId: id, effectiveFromMonth },
    };
    const previousRate = await this.prisma.shopFeeRate.findUnique({ where });

    await this.prisma.$transaction(async (tx) => {
      await tx.shopFeeRate.upsert({
        where,
        create: { shopId: id, amount, effectiveFromMonth },
        update: { amount },
      });

      if (effectiveFromMonth === cur) {
        await tx.shop.update({ where: { id }, data: { monthlyFee: amount } });
        if (shop.status === 'active' || shop.status === 'inactive') {
          const currentRecord = await tx.feeRecord.findUnique({
            where: { shopId_month: { shopId: id, month: cur } },
          });
          if (currentRecord?.status !== 'paid') {
            await tx.feeRecord.upsert({
              where: { shopId_month: { shopId: id, month: cur } },
              create: {
                shopId: id,
                month: cur,
                amount,
                status: 'unpaid',
              },
              update: { amount },
            });
          }
        }
      }

      await this.audit.recordWithTx(tx, {
        actorType: 'admin',
        actorId: adminId,
        action: 'SHOP_MONTHLY_FEE_CHANGED',
        entityType: 'Shop',
        entityId: id,
        details: {
          previousAmount: previousRate?.amount ?? currentAmount,
          newAmount: amount,
          effectiveFromMonth,
        },
        ipAddress: meta?.ip,
        userAgent: meta?.userAgent,
      });
    });

    return { status: 'success', data: await this.loadDetail(id) };
  }

  /* ---------------- helpers ---------------- */
  private async loadDetail(id: string) {
    const shop = await this.prisma.shop.findUnique({
      where: { id },
      include: {
        feeRecords: { orderBy: { month: 'desc' }, take: 12 },
        feeRates: { orderBy: { effectiveFromMonth: 'desc' }, take: 2 },
      },
    });
    if (!shop || shop.pendingDeletionAt)
      throw new NotFoundException('Shop not found');
    return this.mapShop(shop, true);
  }

  private searchWhere(raw?: string): Prisma.ShopWhereInput {
    const q = raw?.trim();
    if (!q) return {};

    const or: Prisma.ShopWhereInput[] = [
      { shopName: { contains: q, mode: 'insensitive' } },
      { ownerName: { contains: q, mode: 'insensitive' } },
    ];

    const digits = q.replace(/\D/g, '');
    if (digits) or.push({ mobile: { contains: digits } });

    // Shop ID such as "SH-101"
    const code = /^sh-?(\d{1,9})$/i.exec(q);
    if (code) or.push({ shopNo: Number(code[1]) - 100 });

    return { OR: or };
  }

  private mapShop(shop: ShopWithFees, detail: boolean) {
    const cur = currentMonth();
    const feeApplies = shop.status === 'active' || shop.status === 'inactive';
    const currentRecord = shop.feeRecords.find((f) => f.month === cur);

    // Pending/archived shops do not have a fee for this month (null)
    const currentFee = feeForMonth(shop.feeRates, cur, shop.monthlyFee);
    const feeStatus =
      feeApplies && currentFee > 0 ? (currentRecord?.status ?? 'unpaid') : null;
    const nextMonthKey = nextMonth(cur);
    const nextFee = feeForMonth(shop.feeRates, nextMonthKey, currentFee);
    const hasCurrentRate = shop.feeRates.some(
      (rate) => rate.effectiveFromMonth <= cur,
    );

    const history: FeeMonth[] = shop.feeRecords.map((f) => ({
      month: f.month,
      status: f.status,
      amount: f.amount,
      ...(f.paidOn ? { paidOn: dateOnly(f.paidOn) } : {}),
      ...(f.method ? { method: f.method } : {}),
    }));
    // Show a row even if a new month has started and its record has not been created yet
    if (feeApplies && currentFee > 0 && !currentRecord)
      history.unshift({ month: cur, amount: currentFee, status: 'unpaid' });

    return {
      id: shop.id,
      shopCode: shopCode(shop.shopNo),
      shopName: shop.shopName,
      ownerName: shop.ownerName,
      mobile: formatMobile(shop.mobile),
      email: shop.email ?? undefined,
      cnic: shop.cnic,
      address: shop.address,
      city: shop.city,
      status: shop.status,
      registeredAt: dateOnly(shop.createdAt),
      monthlyFee: currentFee || null,
      nextMonthlyFee: nextFee || null,
      feeChangeEffectiveMonth: hasCurrentRate ? nextMonthKey : cur,
      feeStatus,
      feeHistory: detail ? history : [],
      statusNote: shop.statusNote ?? undefined,
      profilePic: shop.profilePic ?? undefined,
      documents:
        detail && shop.profilePic
          ? [
              {
                label: 'Profile Photo',
                fileName: 'profile.jpg',
                url: shop.profilePic,
              },
            ]
          : [],
    };
  }
}
