import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'Shops ki ginti aur is mahine ki fee ka summary' })
  dashboard() {
    return this.admin.dashboard();
  }

  @Get('shops')
  @ApiOperation({ summary: 'Shops ki list (filter, search, pagination)' })
  list(@Query() query: ListShopsQueryDto) {
    return this.admin.listShops(query);
  }

  @Get('shops/:id')
  @ApiOperation({ summary: 'Ek shop ki detail aur fee history' })
  getShop(@Param('id') id: string) {
    return this.admin.getShop(id);
  }

  @Patch('shops/:id/status')
  @ApiOperation({
    summary: 'Shop ka status badalna (kisi bhi status se kisi bhi status par)',
  })
  setStatus(@Param('id') id: string, @Body() dto: UpdateShopStatusDto) {
    return this.admin.setStatus(id, dto);
  }

  @Patch('shops/:id/fee')
  @ApiOperation({ summary: 'Kisi mahine ki fee paid ya unpaid mark karna' })
  setFee(@Param('id') id: string, @Body() dto: SetShopFeeDto) {
    return this.admin.setFee(id, dto);
  }
}
