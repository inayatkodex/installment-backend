import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ShopService } from '../shop/shop.service';

const ARCHIVE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class CustomerArchiveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CustomerArchiveService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly shop: ShopService) {}

  onModuleInit() {
    void this.archiveEligibleCustomers();
    this.timer = setInterval(
      () => void this.archiveEligibleCustomers(),
      ARCHIVE_INTERVAL_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async archiveEligibleCustomers() {
    if (this.running) return;
    this.running = true;
    try {
      await this.shop.archiveCompletedCustomersBefore(
        new Date(Date.now() - ARCHIVE_DELAY_MS),
      );
    } catch (error) {
      this.logger.error(
        'Customer auto-archive failed; it will retry on the next run.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
