import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RefreshShopSessionDto {
  @ApiProperty({ description: 'Opaque refresh token returned by mobile login' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken: string;
}
