import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  currentMonth,
  dateOnly,
  formatMobile,
  monthLabel,
  shopCode,
} from './admin.utils';
import { ListShopsQueryDto } from './dto/list-shops-query.dto';
import { SetShopFeeDto } from './dto/set-shop-fee.dto';
import { UpdateShopStatusDto } from './dto/update-shop-status.dto';

type ShopWithFees = Prisma.ShopGetPayload<{ include: { feeRecords: true } }>;

export interface FeeMonth {
  month: string;
  status: 'paid' | 'unpaid';
  paidOn?: string;
  method?: string;
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  /* ---------------- 1. DASHBOARD ---------------- */
  async dashboard() {
    const cur = currentMonth();

    const [grouped, activeAgg, paidAgg] = await Promise.all([
      this.prisma.shop.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.shop.aggregate({
        where: { status: 'active' },
        _sum: { monthlyFee: true },
        _count: { _all: true },
      }),
      this.prisma.shop.aggregate({
        where: {
          status: 'active',
          feeRecords: { some: { month: cur, status: 'paid' } },
        },
        _sum: { monthlyFee: true },
        _count: { _all: true },
      }),
    ]);

    const count = { pending: 0, active: 0, inactive: 0, archived: 0 };
    for (const g of grouped) count[g.status] = g._count._all;

    const activeShops = activeAgg._count._all;
    const feePaidShops = paidAgg._count._all;
    const feeCollected = paidAgg._sum.monthlyFee ?? 0;
    const feeRemaining = (activeAgg._sum.monthlyFee ?? 0) - feeCollected;

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
        feeUnpaidShops: activeShops - feePaidShops,
        feePercent: activeShops
          ? Math.round((feePaidShops / activeShops) * 100)
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

    // Fee sirf active/inactive shops par lagti hai
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
      };
    }

    const where: Prisma.ShopWhereInput = {
      AND: [search, statusWhere, feeWhere],
    };

    const [items, total, grouped] = await Promise.all([
      this.prisma.shop.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { feeRecords: { where: { month: cur } } },
      }),
      this.prisma.shop.count({ where }),
      // counts par sirf search lagta hai, status/fee filter nahi
      this.prisma.shop.groupBy({
        by: ['status'],
        where: search,
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

  /* ---------------- 4. SHOP STATUS ---------------- */
  async setStatus(id: string, dto: UpdateShopStatusDto) {
    const exists = await this.prisma.shop.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Shop nahi mili');

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

      // active/inactive hone par is mahine ka fee record (unpaid) bana dete hain
      if (feeApplies) {
        await tx.feeRecord.upsert({
          where: { shopId_month: { shopId: id, month: cur } },
          update: {},
          create: { shopId: id, month: cur, status: 'unpaid' },
        });
      }
    });

    return { status: 'success', data: await this.loadDetail(id) };
  }

  /* ---------------- 5. SHOP FEE ---------------- */
  async setFee(id: string, dto: SetShopFeeDto) {
    const shop = await this.prisma.shop.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!shop) throw new NotFoundException('Shop nahi mili');

    const where = { shopId_month: { shopId: id, month: dto.month } };
    const existing = await this.prisma.feeRecord.findUnique({ where });

    // Purane mahine ka record na ho to nahi banta. Is mahine ka sirf active/inactive shop ka banta hai.
    const canCreate =
      dto.month === currentMonth() &&
      (shop.status === 'active' || shop.status === 'inactive');
    if (!existing && !canCreate) {
      throw new NotFoundException('Is mahine ka fee record nahi mila');
    }

    const data =
      dto.status === 'paid'
        ? { status: 'paid' as const, paidOn: new Date(), method: 'Cash' }
        : { status: 'unpaid' as const, paidOn: null, method: null };

    await this.prisma.feeRecord.upsert({
      where,
      update: data,
      create: { shopId: id, month: dto.month, ...data },
    });

    return { status: 'success', data: await this.loadDetail(id) };
  }

  /* ---------------- helpers ---------------- */
  private async loadDetail(id: string) {
    const shop = await this.prisma.shop.findUnique({
      where: { id },
      include: { feeRecords: { orderBy: { month: 'desc' }, take: 12 } },
    });
    if (!shop) throw new NotFoundException('Shop nahi mili');
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

    // "SH-101" jaisa Shop ID
    const code = /^sh-?(\d{1,9})$/i.exec(q);
    if (code) or.push({ shopNo: Number(code[1]) - 100 });

    return { OR: or };
  }

  private mapShop(shop: ShopWithFees, detail: boolean) {
    const cur = currentMonth();
    const feeApplies = shop.status === 'active' || shop.status === 'inactive';
    const currentRecord = shop.feeRecords.find((f) => f.month === cur);

    // Pending/archived shop par is mahine ki fee nahi lagti (null)
    const feeStatus = feeApplies ? (currentRecord?.status ?? 'unpaid') : null;

    const history: FeeMonth[] = shop.feeRecords.map((f) => ({
      month: f.month,
      status: f.status,
      ...(f.paidOn ? { paidOn: dateOnly(f.paidOn) } : {}),
      ...(f.method ? { method: f.method } : {}),
    }));
    // Naya mahina shuru ho gaya ho aur record abhi na bana ho to bhi row dikhe
    if (feeApplies && !currentRecord)
      history.unshift({ month: cur, status: 'unpaid' });

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
      monthlyFee: shop.monthlyFee,
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
