import { Test, TestingModule } from '@nestjs/testing';
import { StorageService } from './storage.service';
import { existsSync } from 'fs';
import { resolve } from 'path';

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

  it('should pass-through existing HTTP or /uploads URLs without re-saving', async () => {
    const url = 'https://example.com/photo.jpg';
    expect(await service.saveBase64(url)).toBe(url);

    const relative = '/uploads/customers/existing.jpg';
    expect(await service.saveBase64(relative)).toBe(relative);
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

  it('should prevent path traversal attacks when deleting files', async () => {
    // Should not throw and should reject paths attempting to escape /uploads/
    await expect(
      service.deleteFile('/uploads/../../etc/passwd'),
    ).resolves.not.toThrow();
  });
});
