import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class UpdateCustomerPurchasePaymentDto {
  @ApiProperty({ example: 2500 })
  @IsInt({ message: 'Mahine ki qist ki raqam sahi likhein' })
  @Min(1, { message: 'Mahine ki qist ki raqam kam az kam 1 honi chahiye' })
  @Max(2147483647, { message: 'Mahine ki qist ki raqam bohat zyada hai' })
  monthlyPayment: number;
}
