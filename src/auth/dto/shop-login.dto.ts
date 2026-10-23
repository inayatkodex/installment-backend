import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ShopLoginDto {
  @ApiProperty({ example: '0300-1234567' })
  @IsString() @IsNotEmpty({ message: 'Mobile number likhein' })
  mobile: string;

  @ApiProperty({ example: '123456', format: 'password' })
  @IsString() @IsNotEmpty({ message: 'Password likhein' })
  password: string;

  @ApiPropertyOptional({ example: false, description: 'true ho to token 7 din chalta hai, warna 1 din' })
  @IsOptional() @IsBoolean()
  rememberMe?: boolean;
}