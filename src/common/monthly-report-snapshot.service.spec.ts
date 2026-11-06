import { jest } from '@jest/globals';
import { MonthlyReportSnapshotService } from './monthly-report-snapshot.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShopService } from '../shop/shop.service';

describe('MonthlyReportSnapshotService', () => {
  it('creates missing closed-month snapshots once per shop and month', async () => {
    const savedMonths = new Set<string>();
    const prisma = {
      shop: {
        findMany: jest
          .fn<() => Promise<{ id: string; createdAt: Date }[]>>()
          .mockResolvedValue([
            { id: 'shop-1', createdAt: new Date('2025-01-01T00:00:00.000Z') },
          ]),
      },
      monthlyReportSnapshot: {
        findUnique: jest.fn<
          (args: {
            where: { shopId_month: { month: string } };
          }) => Promise<{ id: string } | null>
        >(async ({ where }: { where: { shopId_month: { month: string } } }) =>
          savedMonths.has(where.shopId_month.month) ? { id: 'snapshot' } : null,
        ),
        upsert: jest.fn<
          (args: { where: { shopId_month: { month: string } } }) => Promise<{
            id: string;
          }>
        >(async ({ where }: { where: { shopId_month: { month: string } } }) => {
          savedMonths.add(where.shopId_month.month);
          return { id: 'snapshot' };
        }),
      },
    };
    const shop = {
      buildStatusData: jest.fn(async (_shopId: string, month: string) => ({
        month,
      })),
    };
    const service = new MonthlyReportSnapshotService(
      prisma as unknown as PrismaService,
      shop as unknown as ShopService,
    );

    await service.createMissingSnapshots();
    const savedCount = prisma.monthlyReportSnapshot.upsert.mock.calls.length;
    await service.createMissingSnapshots();

    expect(savedCount).toBeGreaterThan(0);
    expect(prisma.monthlyReportSnapshot.upsert).toHaveBeenCalledTimes(
      savedCount,
    );
    expect(shop.buildStatusData).toHaveBeenCalledTimes(savedCount);
  });
});
