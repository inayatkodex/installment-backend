import { ApiProperty } from '@nestjs/swagger';
import { IsIn, Matches } from 'class-validator';

export class SetShopFeeDto {
  @ApiProperty({ example: '2026-10', description: 'YYYY-MM' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Month must be in YYYY-MM format' })
  month: string;

  @ApiProperty({ enum: ['paid', 'unpaid'], example: 'paid' })
  @IsIn(['paid', 'unpaid'], { message: 'Fee status must be paid or unpaid' })
  status: 'paid' | 'unpaid';
}