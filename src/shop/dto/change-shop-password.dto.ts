import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ChangeShopPasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @IsNotEmpty({ message: 'Maujooda password likhein' })
  currentPassword: string;

  @ApiProperty({ minLength: 6, maxLength: 72, format: 'password' })
  @IsString()
  @MinLength(6, { message: 'Naya password kam az kam 6 huroof ka hona chahiye' })
  @MaxLength(72, { message: 'Naya password 72 huroof se zyada nahi ho sakta' })
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'Naye password mein kam az kam aik letter aur aik number zaroor ho',
  })
  newPassword: string;
}
