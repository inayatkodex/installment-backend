import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { AuditService } from './audit/audit.service';
import { StorageService } from './storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';

const DELETION_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const CLEANUP_BATCH_SIZE = 50;

@Injectable()
export class DeletionCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeletionCleanupService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    void this.cleanupExpired();
    this.timer = setInterval(
      () => void this.cleanupExpired(),
      CLEANUP_INTERVAL_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async cleanupExpired() {
    if (this.running) return;
    this.running = true;
    try {
      await this.runCleanupNow();
    } catch (error) {
      this.logger.error(
        'Expired deletion cleanup failed; it will retry on the next run.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }

  async runCleanupNow() {
    const cutoff = new Date(Date.now() - DELETION_WINDOW_MS);
    await this.deleteExpiredCustomers(cutoff);
    await this.deleteExpiredShops(cutoff);
  }

  private async deleteExpiredCustomers(cutoff: Date) {
    const customers = await this.prisma.customer.findMany({
      where: { deletedAt: { not: null }, deletionRequestedAt: { lte: cutoff } },
      select: {
        id: true,
        photo: true,
        docCnicFront: true,
        docCnicBack: true,
        docOther: true,
        items: { select: { photo: true } },
        payments: { select: { id: true } },
        purchases: {
          select: { items: { select: { photo: true } } },
        },
      },
      take: CLEANUP_BATCH_SIZE,
      orderBy: { deletionRequestedAt: 'asc' },
    });

    for (const customer of customers) {
      await this.prisma.$transaction(async (tx) => {
        const auditFilters: Prisma.AuditLogWhereInput[] = [
          { entityType: 'Customer', entityId: customer.id },
        ];
        if (customer.payments.length) {
          auditFilters.push({
            entityType: 'Payment',
            entityId: { in: customer.payments.map((payment) => payment.id) },
          });
        }
        await tx.auditLog.deleteMany({
          where: { OR: auditFilters },
        });
        await this.audit.recordWithTx(tx, {
          actorType: 'system',
          actorId: 'deletion-cleanup',
          action: 'CUSTOMER_PERMANENTLY_DELETED',
          entityType: 'Customer',
          entityId: customer.id,
        });
        await tx.customer.delete({ where: { id: customer.id } });
      });
      await Promise.all(
        [
          customer.photo,
          customer.docCnicFront,
          customer.docCnicBack,
          customer.docOther,
          ...customer.items.map((item) => item.photo),
          ...customer.purchases.flatMap((purchase) =>
            purchase.items.map((item) => item.photo),
          ),
        ].map((file) => this.storage.deleteFile(file)),
      );
    }
  }

  private async deleteExpiredShops(cutoff: Date) {
    const shops = await this.prisma.shop.findMany({
      where: { pendingDeletionAt: { lte: cutoff } },
      select: {
        id: true,
        profilePic: true,
        docPhoto: true,
        docCnicFront: true,
        docCnicBack: true,
        docShopDocument: true,
        customers: {
          select: {
            id: true,
            photo: true,
            docCnicFront: true,
            docCnicBack: true,
            docOther: true,
            items: { select: { photo: true } },
            payments: { select: { id: true } },
            purchases: {
              select: { items: { select: { photo: true } } },
            },
          },
        },
      },
      take: CLEANUP_BATCH_SIZE,
      orderBy: { pendingDeletionAt: 'asc' },
    });

    for (const shop of shops) {
      await this.prisma.$transaction(async (tx) => {
        const customerIds = shop.customers.map((customer) => customer.id);
        const paymentIds = shop.customers.flatMap((customer) =>
          customer.payments.map((payment) => payment.id),
        );
        const auditFilters: Prisma.AuditLogWhereInput[] = [
          { entityType: 'Shop', entityId: shop.id },
          {
            entityType: 'FeeRecord',
            entityId: { startsWith: `${shop.id}-` },
          },
          { actorType: 'shop', actorId: shop.id },
        ];
        if (customerIds.length) {
          auditFilters.push({
            entityType: 'Customer',
            entityId: { in: customerIds },
          });
        }
        if (paymentIds.length) {
          auditFilters.push({
            entityType: 'Payment',
            entityId: { in: paymentIds },
          });
        }
        await tx.auditLog.deleteMany({ where: { OR: auditFilters } });
        await this.audit.recordWithTx(tx, {
          actorType: 'system',
          actorId: 'deletion-cleanup',
          action: 'SHOP_PERMANENTLY_DELETED',
          entityType: 'Shop',
          entityId: shop.id,
        });
        await tx.shop.delete({ where: { id: shop.id } });
      });
      await Promise.all(
        [
          shop.profilePic,
          shop.docPhoto,
          shop.docCnicFront,
          shop.docCnicBack,
          shop.docShopDocument,
          ...shop.customers.flatMap((customer) => [
            customer.photo,
            customer.docCnicFront,
            customer.docCnicBack,
            customer.docOther,
            ...customer.items.map((item) => item.photo),
            ...customer.purchases.flatMap((purchase) =>
              purchase.items.map((item) => item.photo),
            ),
          ]),
        ].map((file) => this.storage.deleteFile(file)),
      );
    }
  }
}
