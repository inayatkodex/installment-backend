import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateShopProfileDto {
  @ApiPropertyOptional({ example: 'Ali Electronics' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Dukaan ka naam likhein' })
  shopName?: string;

  @ApiPropertyOptional({ example: 'Ali Khan' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Malik ka naam likhein' })
  ownerName?: string;

  @ApiPropertyOptional({ example: 'ali@example.com', nullable: true })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const email = value.trim().toLowerCase();
    return email || null;
  })
  @IsEmail({}, { message: 'Email sahi likhein' })
  email?: string | null;

  @ApiPropertyOptional({ example: 'Lahore' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Shehar likhein' })
  city?: string;

  @ApiPropertyOptional({ example: 'Shop 12, Main Market' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Dukaan ka pata likhein' })
  address?: string;

  @ApiPropertyOptional({
    description: 'Profile photo as a JPEG, PNG, or WebP base64 data URL',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10 * 1024 * 1024, { message: 'Tasveer bohat bari hai' })
  @Matches(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/, {
    message: 'Profile photo ka format sahi nahi hai',
  })
  profilePic?: string;
}
