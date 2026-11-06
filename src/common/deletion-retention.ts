export function deletionRetentionDays(): number {
  const configured = Number(process.env.DELETED_CUSTOMER_RETENTION_DAYS ?? 7);
  if (!Number.isInteger(configured) || configured < 1) {
    throw new Error(
      'DELETED_CUSTOMER_RETENTION_DAYS must be a positive integer',
    );
  }
  return configured;
}

export function deletionRetentionCutoff(now = new Date()): Date {
  return new Date(
    now.getTime() - deletionRetentionDays() * 24 * 60 * 60 * 1000,
  );
}

export function shopDeletionRetentionDays(): number {
  const configured = Number(process.env.DELETED_SHOP_RETENTION_DAYS ?? 7);
  if (!Number.isInteger(configured) || configured < 1) {
    throw new Error(
      'DELETED_SHOP_RETENTION_DAYS must be a positive integer',
    );
  }
  return configured;
}

export function shopDeletionRetentionCutoff(now = new Date()): Date {
  return new Date(
    now.getTime() - shopDeletionRetentionDays() * 24 * 60 * 60 * 1000,
  );
}
