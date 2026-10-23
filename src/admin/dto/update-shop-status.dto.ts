import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const SHOP_STATUSES = ['pending', 'active', 'inactive', 'archived'] as const;
export type ShopStatusValue = (typeof SHOP_STATUSES)[number];

export class UpdateShopStatusDto {
  @ApiProperty({ enum: SHOP_STATUSES, example: 'active' })
  @IsIn(SHOP_STATUSES, { message: 'Invalid status' })
  status: ShopStatusValue;

  @ApiPropertyOptional({
    example: 'CNIC photo was not clear.',
    description: 'Saved only for inactive or archived',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300, { message: 'Reason cannot be more than 300 characters' })
  reason?: string;
}