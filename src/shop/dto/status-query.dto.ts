import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsOptional, Matches } from 'class-validator';

const emptyToUndefined = ({ value }: TransformFnParams) =>
  value === '' ? undefined : value;

export class StatusQueryDto {
  @ApiPropertyOptional({
    example: '2026-10',
    description: 'YYYY-MM (na likhein to is mahine ka)',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Mahina sahi nahi hai' })
  month?: string;
}
