import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { extname, join, normalize, resolve } from 'path';

const MIME_EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
};

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
   * If the input is already a URL or path, it returns it unchanged.
   */
  async saveBase64(
    input: string | null | undefined,
    subfolder = 'documents',
  ): Promise<string | null> {
    if (!input || typeof input !== 'string') return null;

    const trimmed = input.trim();
    if (!trimmed) return null;

    // If it's already an existing relative URL or absolute URL, return as-is
    if (!trimmed.startsWith('data:')) {
      return trimmed;
    }

    // Match base64 Data URL format: data:<mime>;base64,<encoded>
    const match = trimmed.match(/^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      this.logger.warn('Invalid data URL format received, storing as-is');
      return trimmed;
    }

    const mime = match[1].toLowerCase();
    const base64Data = match[2];
    const extension = MIME_EXT_MAP[mime] || '.jpg';
    const fileName = `${randomUUID()}${extension}`;

    const targetDir = join(this.uploadDir, subfolder);
    if (!existsSync(targetDir)) {
      await mkdir(targetDir, { recursive: true });
    }

    const filePath = join(targetDir, fileName);
    const buffer = Buffer.from(base64Data, 'base64');
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
  async deleteFile(fileUrl: string | null | undefined): Promise<void> {
    if (!fileUrl || typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) {
      return;
    }

    try {
      const relativePath = fileUrl.replace(/^\/uploads\//, '');
      const safePath = normalize(join(this.uploadDir, relativePath));

      // Security check: prevent path traversal attacks
      if (!safePath.startsWith(this.uploadDir)) {
        this.logger.warn(`Security warning: Path traversal attempt prevented: ${fileUrl}`);
        return;
      }

      if (existsSync(safePath)) {
        await unlink(safePath);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to delete file ${fileUrl}: ${err?.message}`);
    }
  }
}
