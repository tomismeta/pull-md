export const id = '004-entitlements';
export const description = 'Create authoritative asset entitlement ledger';

export async function up({ pool }) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.asset_entitlements (
      wallet_address TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      transaction_ref TEXT,
      source TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (wallet_address, asset_id)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_asset_entitlements_asset
    ON public.asset_entitlements (asset_id, updated_at DESC);
  `);
}
