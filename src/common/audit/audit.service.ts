import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  actorType: 'shop' | 'admin' | 'system';
  actorId: string;
  action: string;
  entityType: 'Payment' | 'Shop' | 'FeeRecord' | 'Customer';
  entityId: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordHash',
  'token',
  'access_token',
  'profilePic',
  'photo',
  'docPhoto',
  'docCnicFront',
  'docCnicBack',
  'docShopDocument',
  'docOther',
]);

export function sanitizeAuditDetails(
  details?: Record<string, any>,
): Record<string, any> | undefined {
  if (!details) return undefined;
  const sanitized: Record<string, any> = {};
  for (const [k, v] of Object.entries(details)) {
    if (SENSITIVE_KEYS.has(k)) continue;
    if (typeof v === 'string' && v.startsWith('data:image')) {
      sanitized[k] = '[BASE64_IMAGE_OMITTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      sanitized[k] = sanitizeAuditDetails(v);
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Write an audit record inside an active Prisma transaction to guarantee all-or-nothing rollback */
  async recordWithTx(tx: Prisma.TransactionClient, entry: AuditEntry) {
    const sanitizedDetails = sanitizeAuditDetails(entry.details);
    const log = await tx.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        details: sanitizedDetails
          ? (sanitizedDetails as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        ipAddress: entry.ipAddress || null,
        userAgent: entry.userAgent || null,
      },
    });
    this.logger.log(
      `[AUDIT] ${entry.action} by ${entry.actorType}:${entry.actorId} on ${entry.entityType}:${entry.entityId}`,
    );
    return log;
  }

  /** Write an audit record standalone (outside a larger transaction) */
  async record(entry: AuditEntry) {
    return this.recordWithTx(this.prisma, entry);
  }
}
