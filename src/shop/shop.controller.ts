import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ShopId } from '../common/decorators/shop-id.decorator';
import { ShopGuard } from '../common/guards/shop.guard';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';
import { ReceivePaymentDto } from './dto/receive-payment.dto';
import { StatusQueryDto } from './dto/status-query.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { ShopService } from './shop.service';

@ApiTags('Shop')
@ApiBearerAuth()
@UseGuards(ShopGuard)
@Controller('shop')
export class ShopController {
  constructor(private readonly shop: ShopService) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'Dashboard: aaj ki wasooli, late aur mahine ka hisaab',
  })
  dashboard(@ShopId() shopId: string) {
    return this.shop.dashboard(shopId);
  }

  @Get('collection/today')
  @ApiOperation({ summary: 'Aaj jin ki qist due hai' })
  collectionToday(@ShopId() shopId: string) {
    return this.shop.collectionToday(shopId);
  }

  @Get('payments/today')
  @ApiOperation({ summary: 'Aaj jo payments mil gayin' })
  paymentsToday(@ShopId() shopId: string) {
    return this.shop.paymentsToday(shopId);
  }

  @Post('payments/receive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Customer se payment lena' })
  receive(@ShopId() shopId: string, @Body() dto: ReceivePaymentDto) {
    return this.shop.receivePayment(shopId, dto);
  }

  @Post('payments/:id/reverse')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aaj ki payment wapas karna' })
  reverse(@ShopId() shopId: string, @Param('id') id: string) {
    return this.shop.reversePayment(shopId, id);
  }

  @Get('customers')
  @ApiOperation({ summary: 'Customers ki list (search aur status filter)' })
  list(@ShopId() shopId: string, @Query() q: ListCustomersQueryDto) {
    return this.shop.listCustomers(shopId, q);
  }

  @Post('customers')
  @ApiOperation({ summary: 'Naya customer banana' })
  create(@ShopId() shopId: string, @Body() dto: CreateCustomerDto) {
    return this.shop.createCustomer(shopId, dto);
  }

  @Get('customers/:id')
  @ApiOperation({ summary: 'Customer ki detail aur qiston ka schedule' })
  detail(@ShopId() shopId: string, @Param('id') id: string) {
    return this.shop.getCustomer(shopId, id);
  }

  @Put('customers/:id')
  @ApiOperation({ summary: 'Customer ki maloomat badalna' })
  update(
    @ShopId() shopId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.shop.updateCustomer(shopId, id, dto);
  }

  @Delete('customers/:id')
  @ApiOperation({
    summary: 'Customer delete karna (sirf jis ki qistein poori hon)',
  })
  remove(@ShopId() shopId: string, @Param('id') id: string) {
    return this.shop.deleteCustomer(shopId, id);
  }

  @Put('customers/:id/documents/:docKey')
  @ApiOperation({
    summary:
      'Customer ka document badalna (docKey: cnicFront, cnicBack, other)',
  })
  setDocument(
    @ShopId() shopId: string,
    @Param('id') id: string,
    @Param('docKey') docKey: string,
    @Body() dto: UpdateDocumentDto,
  ) {
    return this.shop.setDocument(shopId, id, docKey, dto.photo);
  }

  @Delete('customers/:id/documents/:docKey')
  @ApiOperation({ summary: 'Customer ka document hataana' })
  removeDocument(
    @ShopId() shopId: string,
    @Param('id') id: string,
    @Param('docKey') docKey: string,
  ) {
    return this.shop.removeDocument(shopId, id, docKey);
  }

  @Get('late')
  @ApiOperation({ summary: 'Late customers ki list' })
  late(@ShopId() shopId: string) {
    return this.shop.late(shopId);
  }

  @Get('status')
  @ApiOperation({ summary: 'Mahine ki report (?month=YYYY-MM)' })
  status(@ShopId() shopId: string, @Query() q: StatusQueryDto) {
    return this.shop.status(shopId, q.month);
  }
}
