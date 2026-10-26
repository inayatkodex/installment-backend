import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class UpdateDocumentDto {
  @ApiProperty({ description: 'Document ki photo (base64 data URL)' })
  @IsString()
  @IsNotEmpty({ message: 'Photo zaroori hai' })
  photo: string;
}
