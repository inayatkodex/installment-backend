import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class SetShopMonthlyFeeDto {
  @ApiProperty({ example: 3000, minimum: 1, maximum: 2147483647 })
  @IsInt({ message: 'Monthly fee must be a whole number' })
  @Min(1, { message: 'Monthly fee must be greater than zero' })
  @Max(2147483647, { message: 'Monthly fee is too large' })
  amount: number;
}
