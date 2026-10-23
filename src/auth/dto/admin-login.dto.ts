import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AdminLoginDto {
  @ApiProperty({ example: 'admin@installmentpro.pk' })
  @IsEmail({}, { message: 'Email sahi likhein' })
  email: string;

  @ApiProperty({ example: 'Admin@123', format: 'password' })
  @IsString() @IsNotEmpty({ message: 'Password likhein' })
  password: string;

  @ApiPropertyOptional({ example: false, description: 'true ho to token 7 din chalta hai, warna 1 din' })
  @IsOptional() @IsBoolean()
  rememberMe?: boolean;
}