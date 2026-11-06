import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join, normalize, resolve } from 'path';

const MIME_EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const MAX_FILE_SIZE = 5 * 1024 * 1024;

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly uploadDir = resolve(process.cwd(), 'uploads');

  async onModuleInit() {
    await this.ensureDirectories();
  }

  private async ensureDirectories() {
    const folders = ['shops', 'customers', 'documents', 'items'];
    for (const folder of folders) {
      const dir = join(this.uploadDir, folder);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }
    this.logger.log(`Upload directories verified at: ${this.uploadDir}`);
  }

  /**
   * Saves a base64 Data URL to local disk and returns a relative URL path (e.g. `/uploads/customers/<uuid>.jpg`).
   */
  async saveBase64(
    input: string | null | undefined,
    subfolder = 'documents',
  ): Promise<string | null> {
    if (!input || typeof input !== 'string') return null;

    const trimmed = input.trim();
    if (!trimmed) return null;

    if (!/^data:/i.test(trimmed)) {
      throw new BadRequestException(
        'Upload must be a supported image data URL',
      );
    }

    // Match base64 Data URL format: data:<mime>;base64,<encoded>
    const match = trimmed.match(
      /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i,
    );
    if (!match) {
      throw new BadRequestException('Invalid image data URL');
    }

    const mime = match[1].toLowerCase();
    const base64Data = match[2];
    const extension = MIME_EXT_MAP[mime];
    if (!extension) {
      throw new BadRequestException(
        'Only JPEG, PNG, and WebP uploads are supported',
      );
    }
    const unpaddedData = base64Data.replace(/=+$/, '');
    const paddingLength = base64Data.length - unpaddedData.length;
    if (
      /[^A-Za-z0-9+/=]/.test(base64Data) ||
      unpaddedData.includes('=') ||
      paddingLength > 2 ||
      (paddingLength > 0 && base64Data.length % 4 !== 0) ||
      unpaddedData.length % 4 === 1
    ) {
      throw new BadRequestException('Invalid base64 image data');
    }

    const buffer = Buffer.from(base64Data, 'base64');
    if (
      buffer.length > MAX_FILE_SIZE ||
      buffer.toString('base64').replace(/=+$/, '') !== unpaddedData
    ) {
      throw new BadRequestException(
        'Image must be valid base64 and no larger than 5 MB',
      );
    }

    const hasValidSignature =
      mime === 'image/jpeg'
        ? buffer.length >= 3 &&
          buffer[0] === 0xff &&
          buffer[1] === 0xd8 &&
          buffer[2] === 0xff
        : mime === 'image/png'
          ? buffer.length >= 8 &&
            buffer
              .subarray(0, 8)
              .equals(
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
              )
          : buffer.length >= 12 &&
            buffer.toString('ascii', 0, 4) === 'RIFF' &&
            buffer.toString('ascii', 8, 12) === 'WEBP';
    if (!hasValidSignature) {
      throw new BadRequestException(
        'Image content does not match its declared file type',
      );
    }

    const fileName = `${randomUUID()}${extension}`;

    const targetDir = join(this.uploadDir, subfolder);
    if (!existsSync(targetDir)) {
      await mkdir(targetDir, { recursive: true });
    }

    const filePath = join(targetDir, fileName);
    await writeFile(filePath, buffer);

    return `/uploads/${subfolder}/${fileName}`;
  }

  /**
   * Batch processes a map of document fields (e.g. cnicFront, cnicBack, photo)
   */
  async saveDocuments<T extends Record<string, string | null | undefined>>(
    docs: T,
    subfolder: string,
  ): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(docs)) {
      result[key] = await this.saveBase64(value, subfolder);
    }
    return result;
  }

  /**
   * Safely deletes a file from disk if it starts with `/uploads/`
   */
  async deleteFile(
    fileUrl: string | null | undefined,
    throwOnError = false,
  ): Promise<void> {
    if (
      !fileUrl ||
      typeof fileUrl !== 'string' ||
      !fileUrl.startsWith('/uploads/')
    ) {
      return;
    }

    try {
      const relativePath = fileUrl.replace(/^\/uploads\//, '');
      const safePath = normalize(join(this.uploadDir, relativePath));

      // Security check: prevent path traversal attacks
      if (!safePath.startsWith(this.uploadDir)) {
        this.logger.warn(
          `Security warning: Path traversal attempt prevented: ${fileUrl}`,
        );
        return;
      }

      if (existsSync(safePath)) {
        await unlink(safePath);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to delete file ${fileUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (throwOnError) throw error;
    }
  }
}
