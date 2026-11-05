import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class UpdateCustomerPurchaseDateDto {
  @ApiProperty({
    example: '2027-04-23',
    description:
      'Agli unpaid qist ki tareekh; pehle se paid qiston ki tareekhein nahi badlengi',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Plan ki agli baqi qist ki tareekh sahi likhein',
  })
  firstDueDate: string;
}
