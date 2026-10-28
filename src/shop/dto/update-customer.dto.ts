import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class UpdateCustomerDto {
  @ApiPropertyOptional({ example: 'Ahmed Khan' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Customer ka naam likhein' })
  name?: string;

  @ApiPropertyOptional({ example: 'Muhammad Ali' })
  @IsOptional()
  @IsString()
  fatherName?: string;

  @ApiPropertyOptional({ example: '0300-1234567' })
  @IsOptional()
  @Matches(/^[0-9+\-\s]{10,15}$/, { message: 'Mobile number sahi likhein' })
  phone?: string;

  @ApiPropertyOptional({ example: '35201-1234567-1' })
  @IsOptional()
  @IsString()
  cnic?: string;

  @ApiPropertyOptional({ example: 'Main Bazaar, Lahore' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: '2026-11-28' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Pehli qist ki tareekh sahi likhein',
  })
  firstDueDate?: string;

  @ApiPropertyOptional({ example: 'data:image/jpeg;base64,...' })
  @IsOptional()
  @IsString()
  photo?: string;
}
