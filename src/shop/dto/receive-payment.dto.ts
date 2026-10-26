import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class ReceivePaymentDto {
  @ApiProperty({ example: 'customer-id' })
  @IsString()
  @IsNotEmpty({ message: 'Customer chunein' })
  customerId: string;

  @ApiPropertyOptional({
    example: 4,
    description: 'Hisaab mein istemal nahi hota',
  })
  @IsOptional()
  @IsInt()
  installmentNo?: number;

  @ApiProperty({ example: 4000 })
  @IsInt({ message: 'Sahi raqam likhein' })
  @Min(1, { message: 'Sahi raqam likhein' })
  amount: number;

  @ApiPropertyOptional({ example: 'Beta de gaya' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Note 200 huroof se zyada nahi ho sakta' })
  note?: string;
}
