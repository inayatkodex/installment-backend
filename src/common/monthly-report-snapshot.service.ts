import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { dateOnly, currentMonth } from '../admin/admin.utils';
import { PrismaService } from '../prisma/prisma.service';
import { ShopService } from '../shop/shop.service';

const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
const SNAPSHOT_MONTH_LIMIT = 12;

function previousMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 - offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

@Injectable()
export class MonthlyReportSnapshotService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MonthlyReportSnapshotService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly shop: ShopService,
  ) {}

  onModuleInit() {
    void this.createMissingSnapshots();
    this.timer = setInterval(
      () => void this.createMissingSnapshots(),
      SNAPSHOT_INTERVAL_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async createMissingSnapshots() {
    if (this.running) return;
    this.running = true;
    try {
      const activeShops = await this.prisma.shop.findMany({
        where: { status: 'active' },
        select: { id: true, createdAt: true },
      });
      const current = currentMonth();

      for (const shop of activeShops) {
        const createdMonth = dateOnly(shop.createdAt).slice(0, 7);
        for (let offset = 1; offset <= SNAPSHOT_MONTH_LIMIT; offset += 1) {
          const month = previousMonth(current, offset);
          if (month < createdMonth) break;
          const existing = await this.prisma.monthlyReportSnapshot.findUnique({
            where: { shopId_month: { shopId: shop.id, month } },
            select: { id: true },
          });
          if (existing) continue;

          const data = await this.shop.buildStatusData(shop.id, month);
          await this.prisma.monthlyReportSnapshot.upsert({
            where: { shopId_month: { shopId: shop.id, month } },
            create: {
              shopId: shop.id,
              month,
              data: data as Prisma.InputJsonValue,
            },
            update: {},
          });
        }
      }
    } catch (error) {
      this.logger.error(
        'Monthly report snapshot job failed; it will retry on the next run.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
