import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ReceivePaymentDto {
  @ApiProperty({ example: 'customer-id' })
  @IsString()
  @IsUUID('4', { message: 'Customer ID sahi nahi hai' })
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
  @Max(100_000_000, { message: 'Raqam 10 crore se zyada nahi ho sakti' })
  amount: number;

  @ApiPropertyOptional({ example: 'Beta de gaya' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Note 200 huroof se zyada nahi ho sakta' })
  note?: string;

  @ApiPropertyOptional({
    example: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    description: 'Retry aur double-payment se bachne ke liye unique key',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;
}
