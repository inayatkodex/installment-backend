import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const SHOP_STATUSES = ['pending', 'active', 'inactive', 'archived'] as const;
export type ShopStatusValue = (typeof SHOP_STATUSES)[number];

export class UpdateShopStatusDto {
  @ApiProperty({ enum: SHOP_STATUSES, example: 'active' })
  @IsIn(SHOP_STATUSES, { message: 'Status sahi nahi hai' })
  status: ShopStatusValue;

  @ApiPropertyOptional({
    example: 'CNIC ki tasveer saaf nahi thi.',
    description: 'Sirf inactive ya archived par save hota hai',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: 'Wajah 300 huroof se zyada nahi ho sakti' })
  reason?: string;
}