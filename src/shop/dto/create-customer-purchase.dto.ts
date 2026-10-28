import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

class PurchaseItemDto {
  @ApiProperty({ example: 'Mobile phone' })
  @IsString()
  @IsNotEmpty({ message: 'Cheez ka naam likhein' })
  name: string;

  @ApiProperty({ example: 25000 })
  @IsInt({ message: 'Cheez ki qeemat sahi likhein' })
  @Min(1, { message: 'Cheez ki qeemat sahi likhein' })
  @Max(2147483647, { message: 'Cheez ki qeemat bohat zyada hai' })
  price: number;

  @ApiProperty({ required: false, description: 'Cheez ki photo (base64 data URL)' })
  @IsOptional()
  @IsString()
  photo?: string;
}

export class CreateCustomerPurchaseDto {
  @ApiProperty({ type: () => [PurchaseItemDto], minItems: 1, maxItems: 2 })
  @IsArray()
  @ArrayMinSize(1, { message: 'Kam az kam ek cheez likhein' })
  @ArrayMaxSize(2, { message: 'Ek waqt mein zyada se zyada do cheezen add karein' })
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items: PurchaseItemDto[];

  @ApiProperty({
    required: false,
    example: 5000,
    description: 'Plan B ka advance',
  })
  @IsOptional()
  @IsInt({ message: 'Advance ki raqam sahi likhein' })
  @Min(0, { message: 'Advance zero ya us se zyada hona chahiye' })
  @Max(2147483647, { message: 'Advance ki raqam bohat zyada hai' })
  downPayment?: number;

  @ApiProperty({ example: 3000, description: 'Is khareedari ki mahana qist' })
  @IsInt({ message: 'Mahine ki qist ki raqam sahi likhein' })
  @Min(1, { message: 'Mahine ki qist kam az kam 1 honi chahiye' })
  @Max(2147483647, { message: 'Mahine ki qist ki raqam bohat zyada hai' })
  monthlyPayment: number;
}
