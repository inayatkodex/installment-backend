import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

const emptyToUndefined = ({ value }: TransformFnParams) =>
  value === '' ? undefined : value;

export class ListCustomersQueryDto {
  @ApiPropertyOptional({ description: 'Naam, mobile ya customer code' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ['all', 'active', 'overdue', 'completed'] })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsIn(['all', 'active', 'overdue', 'completed'], {
    message: 'Status sahi nahi hai',
  })
  status?: 'all' | 'active' | 'overdue' | 'completed';

  @ApiPropertyOptional({ description: 'Page number (1 se shuru)', default: 1 })
  @IsOptional()
  @Transform(({ value }) => (value !== undefined ? Number(value) : undefined))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Ek page mein kitne customers', default: 20 })
  @IsOptional()
  @Transform(({ value }) => (value !== undefined ? Number(value) : undefined))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
