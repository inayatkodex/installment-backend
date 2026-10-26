import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsIn, IsOptional, IsString } from 'class-validator';

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
}
