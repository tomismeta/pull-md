export const id = '001-marketplace-core';
export const description = 'Create marketplace tables and hard-cut legacy soul table names';

export async function up({ pool }) {
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('public.asset_marketplace_drafts') IS NULL
         AND to_regclass('public.soul_marketplace_drafts') IS NOT NULL THEN
        ALTER TABLE public.soul_marketplace_drafts RENAME TO asset_marketplace_drafts;
      END IF;

      IF to_regclass('public.asset_marketplace_audit') IS NULL
         AND to_regclass('public.soul_marketplace_audit') IS NOT NULL THEN
        ALTER TABLE public.soul_marketplace_audit RENAME TO asset_marketplace_audit;
      END IF;

      IF to_regclass('public.asset_catalog_entries') IS NULL
         AND to_regclass('public.soul_catalog_entries') IS NOT NULL THEN
        ALTER TABLE public.soul_catalog_entries RENAME TO asset_catalog_entries;
      END IF;

      IF to_regclass('public.idx_asset_marketplace_drafts_status_updated') IS NULL
         AND to_regclass('public.idx_soul_marketplace_drafts_status_updated') IS NOT NULL THEN
        ALTER INDEX public.idx_soul_marketplace_drafts_status_updated
          RENAME TO idx_asset_marketplace_drafts_status_updated;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.asset_marketplace_drafts (
      wallet_address TEXT NOT NULL,
      draft_id TEXT NOT NULL,
      status TEXT NOT NULL,
      moderation JSONB,
      normalized JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      published_at TIMESTAMPTZ,
      PRIMARY KEY (wallet_address, draft_id)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_asset_marketplace_drafts_status_updated
    ON public.asset_marketplace_drafts (status, updated_at DESC);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.asset_marketplace_audit (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL,
      event TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      draft_id TEXT,
      actor TEXT,
      decision TEXT,
      status_before TEXT,
      status_after TEXT,
      notes TEXT,
      payload JSONB
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.asset_catalog_entries (
      id TEXT PRIMARY KEY,
      entry JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
