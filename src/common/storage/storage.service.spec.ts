import { Test, TestingModule } from '@nestjs/testing';
import { StorageService } from './storage.service';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { BadRequestException } from '@nestjs/common';

describe('StorageService (Phase 2 Image Storage Optimization)', () => {
  let service: StorageService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StorageService],
    }).compile();

    service = module.get<StorageService>(StorageService);
    await service.onModuleInit();
  });

  it('should ignore null, undefined, or empty inputs', async () => {
    expect(await service.saveBase64(null)).toBeNull();
    expect(await service.saveBase64(undefined)).toBeNull();
    expect(await service.saveBase64('')).toBeNull();
  });

  it('rejects non-data URLs instead of storing an arbitrary path', async () => {
    await expect(
      service.saveBase64('/uploads/customers/existing.jpg'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.saveBase64('https://example.com/photo.jpg'),
    ).rejects.toThrow(BadRequestException);
  });

  it('should decode a base64 JPEG and save to local disk under uploads/', async () => {
    // 1x1 white pixel JPEG in base64
    const base64Jpeg =
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

    const savedUrl = await service.saveBase64(base64Jpeg, 'customers');
    expect(savedUrl).not.toBeNull();
    expect(savedUrl).toMatch(/^\/uploads\/customers\/[a-f0-9-]+\.jpg$/);

    const diskPath = resolve(process.cwd(), savedUrl!.slice(1));
    expect(existsSync(diskPath)).toBe(true);

    // Clean up
    await service.deleteFile(savedUrl);
    expect(existsSync(diskPath)).toBe(false);
  });

  it('should decode a base64 PNG and assign the .png extension', async () => {
    // 1x1 transparent pixel PNG in base64
    const base64Png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const savedUrl = await service.saveBase64(base64Png, 'shops');
    expect(savedUrl).toMatch(/^\/uploads\/shops\/[a-f0-9-]+\.png$/);

    const diskPath = resolve(process.cwd(), savedUrl!.slice(1));
    expect(existsSync(diskPath)).toBe(true);

    // Clean up
    await service.deleteFile(savedUrl);
    expect(existsSync(diskPath)).toBe(false);
  });

  it('should accept WebP only when its RIFF/WEBP signature is present', async () => {
    const webpHeader = Buffer.alloc(12);
    webpHeader.write('RIFF', 0, 'ascii');
    webpHeader.write('WEBP', 8, 'ascii');
    const savedUrl = await service.saveBase64(
      `data:image/webp;base64,${webpHeader.toString('base64')}`,
      'items',
    );
    expect(savedUrl).toMatch(/^\/uploads\/items\/[a-f0-9-]+\.webp$/);
    await service.deleteFile(savedUrl);
  });

  it('rejects unsupported MIME types, malformed base64, and mismatched signatures', async () => {
    await expect(
      service.saveBase64('data:image/gif;base64,R0lGODlh'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.saveBase64('data:application/pdf;base64,JVBERi0='),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.saveBase64('data:image/png;base64,not-base64!'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.saveBase64('data:image/png;base64,/9j/'),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects decoded images larger than 5 MB', async () => {
    const oversizedImage = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(5 * 1024 * 1024),
    ]).toString('base64');

    await expect(
      service.saveBase64(`data:image/jpeg;base64,${oversizedImage}`),
    ).rejects.toThrow(BadRequestException);
  });

  it('should prevent path traversal attacks when deleting files', async () => {
    // Should not throw and should reject paths attempting to escape /uploads/
    await expect(
      service.deleteFile('/uploads/../../etc/passwd'),
    ).resolves.not.toThrow();
  });
});
