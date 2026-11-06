import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ShopGuard } from '../common/guards/shop.guard';
import { CustomerArchiveService } from '../common/customer-archive.service';
import { MonthlyReportSnapshotService } from '../common/monthly-report-snapshot.service';
import { ShopController } from './shop.controller';
import { ShopService } from './shop.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [ShopController],
  providers: [
    ShopService,
    ShopGuard,
    CustomerArchiveService,
    MonthlyReportSnapshotService,
  ],
})
export class ShopModule {}
