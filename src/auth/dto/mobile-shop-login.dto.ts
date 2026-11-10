import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class MobileShopLoginDto {
  @ApiProperty({ example: '0300-1234567' })
  @IsString()
  @IsNotEmpty({ message: 'Mobile number likhein' })
  mobile: string;

  @ApiProperty({ example: '123456', format: 'password' })
  @IsString()
  @IsNotEmpty({ message: 'Password likhein' })
  password: string;

  @ApiPropertyOptional({ example: 'Android phone', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;
}
