import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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
import { ResetShopPasswordDto } from './dto/reset-shop-password.dto';
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

  @Get('shops/pending-deletion')
  @ApiOperation({
    summary: 'List shops in the 24-hour deletion recovery window',
  })
  pendingDeletion() {
    return this.admin.listPendingDeletion();
  }

  @Post('shops/:id/undo-delete')
  @ApiOperation({
    summary: 'Restore a shop before its 24-hour deletion deadline',
  })
  undoDelete(@Param('id') id: string, @AdminId() adminId: string) {
    return this.admin.undoDeleteShop(id, adminId);
  }

  @Get('shops/:id')
  @ApiOperation({ summary: 'Single shop detail and fee history' })
  getShop(@Param('id') id: string) {
    return this.admin.getShop(id);
  }

  @Patch('shops/:id/password')
  @ApiOperation({ summary: "Reset a shop's password and revoke existing sessions" })
  resetShopPassword(
    @Param('id') id: string,
    @Body() dto: ResetShopPasswordDto,
    @AdminId() adminId: string,
    @Req() req: Request,
  ) {
    return this.admin.resetShopPassword(id, dto, adminId, {
      ip: req?.ip,
      userAgent: req?.headers['user-agent'],
    });
  }

  @Delete('shops/:id')
  @ApiOperation({
    summary: 'Schedule shop deletion after a 24-hour recovery window',
  })
  deleteShop(
    @Param('id') id: string,
    @AdminId() adminId: string,
    @Req() req: Request,
  ) {
    return this.admin.deleteShop(id, adminId, {
      ip: req?.ip,
      userAgent: req?.headers['user-agent'],
    });
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
