import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AdminLoginDto {
  @ApiProperty({ example: 'admin@installmentpro.pk' })
  @IsEmail({}, { message: 'Enter a valid email' })
  email: string;

  @ApiProperty({ example: 'Admin@123', format: 'password' })
  @IsString() @IsNotEmpty({ message: 'Enter your password' })
  password: string;

  @ApiPropertyOptional({ example: false, description: 'If true the token lasts 7 days, otherwise 1 day' })
  @IsOptional() @IsBoolean()
  rememberMe?: boolean;
}