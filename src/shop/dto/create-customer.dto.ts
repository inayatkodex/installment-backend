import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

class CustomerItemDto {
  @ApiProperty({ example: 'LED TV 32"' })
  @IsString()
  @IsNotEmpty({ message: 'Cheez ka naam likhein' })
  name: string;

  @ApiProperty({ example: 25000 })
  @IsInt({ message: 'Cheez ki qeemat sahi likhein' })
  @Min(1, { message: 'Cheez ki qeemat sahi likhein' })
  price: number;

  @ApiPropertyOptional({ description: 'Cheez ki photo (base64 data URL)' })
  @IsOptional()
  @IsString()
  photo?: string;
}

class CustomerDocumentsDto {
  @ApiPropertyOptional({ description: 'CNIC front (base64 data URL)' })
  @IsOptional()
  @IsString()
  cnicFront?: string;

  @ApiPropertyOptional({ description: 'CNIC back (base64 data URL)' })
  @IsOptional()
  @IsString()
  cnicBack?: string;

  @ApiPropertyOptional({ description: 'Koi aur document (base64 data URL)' })
  @IsOptional()
  @IsString()
  other?: string;
}

export class CreateCustomerDto {
  @ApiProperty({ example: 'Ahmed Khan' })
  @IsString()
  @IsNotEmpty({ message: 'Customer ka naam likhein' })
  name: string;

  @ApiPropertyOptional({ description: 'Customer ki photo (base64 data URL)' })
  @IsOptional()
  @IsString()
  photo?: string;

  @ApiPropertyOptional({ example: 'Muhammad Ali' })
  @IsOptional()
  @IsString()
  fatherName?: string;

  @ApiProperty({ example: '0300-1234567' })
  @IsString()
  @Matches(/^[0-9+\-\s]{10,15}$/, { message: 'Mobile number sahi likhein' })
  mobile: string;

  @ApiPropertyOptional({ example: '35201-1234567-1' })
  @IsOptional()
  @IsString()
  cnic?: string;

  @ApiPropertyOptional({ example: 'Main Bazaar, Lahore' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ type: () => [CustomerItemDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'Kam az kam ek cheez likhein' })
  @ValidateNested({ each: true })
  @Type(() => CustomerItemDto)
  items: CustomerItemDto[];

  @ApiProperty({ example: 18000, description: 'Advance raqam' })
  @IsInt({ message: 'Advance raqam sahi likhein' })
  @Min(0, { message: 'Advance raqam sahi likhein' })
  downPayment: number;

  @ApiProperty({ example: 12, description: 'Qiston ki tadaad' })
  @IsInt({ message: 'Qiston ki tadaad sahi likhein' })
  @Min(1, { message: 'Qiston ki tadaad sahi likhein' })
  @Max(120, { message: 'Qiston ki tadaad 120 se zyada nahi ho sakti' })
  months: number;

  @ApiProperty({ example: '2026-11-25', description: 'YYYY-MM-DD' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Pehli qist ki tareekh sahi likhein',
  })
  firstDueDate: string;

  @ApiPropertyOptional({ type: () => CustomerDocumentsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerDocumentsDto)
  documents?: CustomerDocumentsDto;
}
