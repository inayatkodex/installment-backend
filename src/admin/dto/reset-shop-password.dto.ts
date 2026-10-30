import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ResetShopPasswordDto {
  @ApiProperty({ minLength: 6, maxLength: 72, format: 'password' })
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters long.' })
  @MaxLength(72, { message: 'Password must be no more than 72 characters.' })
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'Password must include at least one letter and one number.',
  })
  newPassword: string;
}
