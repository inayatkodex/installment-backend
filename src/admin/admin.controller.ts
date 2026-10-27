import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AdminId } from '../common/decorators/admin-id.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { AdminService } from './admin.service';
import { ListShopsQueryDto } from './dto/list-shops-query.dto';
import { SetShopFeeDto } from './dto/set-shop-fee.dto';
import { UpdateShopStatusDto } from './dto/update-shop-status.dto';

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('dashboard')
  @ApiOperation({ summary: "Shop counts and this month's fee summary" })
  dashboard() {
    return this.admin.dashboard();
  }

  @Get('shops')
  @ApiOperation({ summary: 'List of shops (filter, search, pagination)' })
  list(@Query() query: ListShopsQueryDto) {
    return this.admin.listShops(query);
  }

  @Get('shops/:id')
  @ApiOperation({ summary: 'Single shop detail and fee history' })
  getShop(@Param('id') id: string) {
    return this.admin.getShop(id);
  }

  @Patch('shops/:id/status')
  @ApiOperation({
    summary: 'Change shop status (any status to any status)',
  })
  setStatus(
    @Param('id') id: string,
    @Body() dto: UpdateShopStatusDto,
    @AdminId() adminId: string,
    @Req() req: Request,
  ) {
    return this.admin.setStatus(id, dto, adminId, {
      ip: req?.ip,
      userAgent: req?.headers['user-agent'],
    });
  }

  @Patch('shops/:id/fee')
  @ApiOperation({ summary: "Mark a month's fee as paid or unpaid" })
  setFee(
    @Param('id') id: string,
    @Body() dto: SetShopFeeDto,
    @AdminId() adminId: string,
    @Req() req: Request,
  ) {
    return this.admin.setFee(id, dto, adminId, {
      ip: req?.ip,
      userAgent: req?.headers['user-agent'],
    });
  }
}
