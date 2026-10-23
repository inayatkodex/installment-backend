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
  @IsIn(['all', 'pending', 'active', 'inactive', 'archived'], { message: 'Invalid status' })
  status?: 'all' | 'pending' | 'active' | 'inactive' | 'archived';

  @ApiPropertyOptional({ enum: ['all', 'paid', 'unpaid'], description: "This month's fee" })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsIn(['all', 'paid', 'unpaid'], { message: 'Invalid fee filter' })
  fee?: 'all' | 'paid' | 'unpaid';

  @ApiPropertyOptional({ description: 'Shop, owner, mobile or Shop ID (SH-101)' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Transform(toNumber)
  @IsInt({ message: 'Invalid page' })
  @Min(1, { message: 'Invalid page' })
  page?: number;

  @ApiPropertyOptional({ example: 8, description: 'Default 8, maximum 100' })
  @IsOptional()
  @Transform(toNumber)
  @IsInt({ message: 'Invalid page size' })
  @Min(1, { message: 'Invalid page size' })
  @Max(100, { message: 'Page size cannot be more than 100' })
  pageSize?: number;
}