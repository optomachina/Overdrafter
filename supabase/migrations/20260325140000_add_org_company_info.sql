-- Add company info, billing address, and shipping address columns to organizations.
-- All new columns are nullable so existing rows are unaffected.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS company_name             text,
  ADD COLUMN IF NOT EXISTS logo_url                 text,
  ADD COLUMN IF NOT EXISTS phone                    text,
  ADD COLUMN IF NOT EXISTS billing_street           text,
  ADD COLUMN IF NOT EXISTS billing_city             text,
  ADD COLUMN IF NOT EXISTS billing_state            text,
  ADD COLUMN IF NOT EXISTS billing_zip              text,
  ADD COLUMN IF NOT EXISTS billing_country          text DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS shipping_same_as_billing boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS shipping_street          text,
  ADD COLUMN IF NOT EXISTS shipping_city            text,
  ADD COLUMN IF NOT EXISTS shipping_state           text,
  ADD COLUMN IF NOT EXISTS shipping_zip             text,
  ADD COLUMN IF NOT EXISTS shipping_country         text DEFAULT 'US';
