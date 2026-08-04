import { PrismaService } from '../../../database/prisma.service';
import { PgIdempotencyStore } from './pg-idempotency.store';

describe('PgIdempotencyStore', () => {
  it('ignores expired keys in exists()', async () => {
    const prisma = {
      idempotencyKey: {
        findUnique: jest.fn().mockResolvedValue({
          expiresAt: new Date(Date.now() - 1000),
        }),
      },
    };
    const store = new PgIdempotencyStore(prisma as unknown as PrismaService);

    await expect(store.exists('expired')).resolves.toBe(false);
  });

  it('replaces expired keys atomically', async () => {
    const tx = {
      idempotencyKey: {
        findUnique: jest.fn().mockResolvedValue({
          expiresAt: new Date(Date.now() - 1000),
        }),
        upsert: jest.fn().mockResolvedValue({ key: 'k1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (fn: (value: typeof tx) => Promise<boolean>) => fn(tx),
      ),
    };
    const store = new PgIdempotencyStore(prisma as unknown as PrismaService);

    await expect(store.setIfNotExists('k1', 60)).resolves.toBe(true);
    expect(tx.idempotencyKey.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'k1' } }),
    );
  });

  it('rejects a non-expired key', async () => {
    const tx = {
      idempotencyKey: {
        findUnique: jest.fn().mockResolvedValue({
          expiresAt: new Date(Date.now() + 60_000),
        }),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (fn: (value: typeof tx) => Promise<boolean>) => fn(tx),
      ),
    };
    const store = new PgIdempotencyStore(prisma as unknown as PrismaService);

    await expect(store.setIfNotExists('k1', 60)).resolves.toBe(false);
    expect(tx.idempotencyKey.upsert).not.toHaveBeenCalled();
  });
});
