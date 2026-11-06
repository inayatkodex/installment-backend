import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { StorageService } from './storage/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { deletionRetentionCutoff } from './deletion-retention';

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
    await this.deleteExpiredCustomers(deletionRetentionCutoff());
    await this.deleteExpiredShops(new Date(Date.now() - 24 * 60 * 60 * 1000));
  }

  private async deleteExpiredCustomers(cutoff: Date) {
    const customers = await this.prisma.customer.findMany({
      where: {
        deletedAt: { not: null },
        deletionRequestedAt: { lte: cutoff },
        filesPurgedAt: null,
      },
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
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "customers"
          WHERE id = ${customer.id}
            AND "deletedAt" IS NOT NULL
            AND "deletionRequestedAt" <= ${cutoff}
            AND "filesPurgedAt" IS NULL
          FOR UPDATE
        `;
        if (!locked.length) return;

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
          ].map((file) => this.storage.deleteFile(file, true)),
        );
        await tx.customer.update({
          where: { id: customer.id },
          data: {
            photo: null,
            docCnicFront: null,
            docCnicBack: null,
            docOther: null,
            filesPurgedAt: new Date(),
          },
        });
        await tx.customerItem.updateMany({
          where: { customerId: customer.id },
          data: { photo: null },
        });
        await tx.customerPurchaseItem.updateMany({
          where: { purchase: { customerId: customer.id } },
          data: { photo: null },
        });
        if (customer.payments.length === 0) {
          await this.audit.recordWithTx(tx, {
            actorType: 'system',
            actorId: 'deletion-cleanup',
            action: 'CUSTOMER_PERMANENTLY_DELETED',
            entityType: 'Customer',
            entityId: customer.id,
          });
          await tx.customer.delete({ where: { id: customer.id } });
        }
      });
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
