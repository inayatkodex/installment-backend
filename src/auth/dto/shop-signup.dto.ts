import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';

class ShopDocumentsDto {
  @ApiPropertyOptional({ description: 'Photo (base64 data URL)' })
  @IsOptional() @IsString() photo?: string;

  @ApiPropertyOptional({ description: 'CNIC front (base64 data URL)' })
  @IsOptional() @IsString() cnicFront?: string;

  @ApiPropertyOptional({ description: 'CNIC back (base64 data URL)' })
  @IsOptional() @IsString() cnicBack?: string;

  @ApiPropertyOptional({ description: 'Shop document (base64 data URL)' })
  @IsOptional() @IsString() shopDocument?: string;
}

export class ShopSignupDto {
  @ApiProperty({ example: 'Ali Electronics' })
  @IsString() @IsNotEmpty({ message: 'Dukaan ka naam likhein' })
  shopName: string;

  @ApiProperty({ example: 'Lahore' })
  @IsString() @IsNotEmpty({ message: 'Shehar likhein' })
  city: string;

  @ApiProperty({ example: 'Shop 12, Main Market' })
  @IsString() @IsNotEmpty({ message: 'Address likhein' })
  address: string;

  @ApiProperty({ example: 'Ali Khan' })
  @IsString() @IsNotEmpty({ message: 'Malik ka naam likhein' })
  ownerName: string;

  @ApiProperty({ example: '0300-1234567' })
  @IsString()
  @Matches(/^[0-9+\-\s]{10,15}$/, { message: 'Mobile number sahi likhein' })
  mobile: string;

  @ApiProperty({ example: '35202-1234567-1' })
  @IsString() @IsNotEmpty({ message: 'CNIC number likhein' })
  cnic: string;

  @ApiPropertyOptional({ example: 'ali@example.com' })
  @IsOptional() @IsEmail({}, { message: 'Email sahi likhein' })
  email?: string;

  @ApiProperty({ example: '123456', minLength: 6, format: 'password' })
  @IsString()
  @MinLength(6, { message: 'Password kam az kam 6 huroof ka hona chahiye' })
  password: string;

  @ApiPropertyOptional({ description: 'Profile photo (base64 data URL)' })
  @IsOptional() @IsString()
  profilePic?: string;

  @ApiPropertyOptional({ type: () => ShopDocumentsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShopDocumentsDto)
  documents?: ShopDocumentsDto;
}