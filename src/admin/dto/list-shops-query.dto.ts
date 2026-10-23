import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

const emptyToUndefined = ({ value }: TransformFnParams) => (value === '' ? undefined : value);
const toNumber = ({ value }: TransformFnParams) =>
  value === '' || value == null ? undefined : Number(value);

export class ListShopsQueryDto {
  @ApiPropertyOptional({ enum: ['all', 'pending', 'active', 'inactive', 'archived'] })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsIn(['all', 'pending', 'active', 'inactive', 'archived'], { message: 'Status sahi nahi hai' })
  status?: 'all' | 'pending' | 'active' | 'inactive' | 'archived';

  @ApiPropertyOptional({ enum: ['all', 'paid', 'unpaid'], description: 'Is mahine ki fee' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsIn(['all', 'paid', 'unpaid'], { message: 'Fee filter sahi nahi hai' })
  fee?: 'all' | 'paid' | 'unpaid';

  @ApiPropertyOptional({ description: 'Shop, owner, mobile ya Shop ID (SH-101)' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Transform(toNumber)
  @IsInt({ message: 'Page sahi nahi hai' })
  @Min(1, { message: 'Page sahi nahi hai' })
  page?: number;

  @ApiPropertyOptional({ example: 8, description: 'Default 8, zyada se zyada 100' })
  @IsOptional()
  @Transform(toNumber)
  @IsInt({ message: 'Page size sahi nahi hai' })
  @Min(1, { message: 'Page size sahi nahi hai' })
  @Max(100, { message: 'Page size 100 se zyada nahi ho sakta' })
  pageSize?: number;
}