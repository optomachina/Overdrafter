# E2E Test Data

This document describes the seeded test data available for E2E tests.

## Test Users

Created by `scripts/seed-dev.mjs`:

### Client User
- **Email**: `client.demo@overdrafter.local`
- **Password**: `Overdrafter123!`
- **Role**: Client (regular user)
- **Organization**: Test organization (uuid 1)
- **Storage state**: `playwright/.auth/client.json`

### Estimator User
- **Email**: `estimator.demo@overdrafter.local`
- **Password**: `Overdrafter123!`
- **Role**: Internal estimator
- **Organization**: Test organization (uuid 1)
- **Storage state**: `playwright/.auth/internal.json`

### Admin User
- **Email**: `admin.demo@overdrafter.local`
- **Password**: `Overdrafter123!`
- **Role**: Internal admin
- **Organization**: Test organization (uuid 1)

## Test Projects

### Cleanup Project (uuid 20)
- Basic project for testing cleanup workflows
- Contains a simple part with CAD and drawing

### Quoted Project (uuid 21)
- **Purpose**: Pre-populated with quotes for comparison testing
- **Parts**: Two parts (A and B) with manufacturing requirements
- **Quotes**: Multiple vendor quotes including:
  - Xometry
  - Protolabs
  - Fictiv
  - SendCutSend
- **State**: Ready for quote comparison and procurement handoff

### Published Project (uuid 22)
- Contains a published quote package
- Ready for client review and selection

## Test Files

Located in `test-fixtures/quoted-sample/`:

- `1093-05589-02.STEP` - Sample bracket CAD file (~254KB)
- `1093-05589-02.pdf` - Sample bracket drawing (~40KB)

## Test-Only Authentication

The `test-login` Edge Function provides rapid authentication for E2E tests:

- **Location**: `supabase/functions/test-login/index.ts`
- **Usage**: Accepts an email and returns a magic link
- **Security**: Only works in non-production environments with localhost
- **Tests**: Comprehensive production-protection tests in `index.test.ts`

## Seeding Fresh Data

To reset and reseed the test database:

```bash
npm run db:reset
npm run seed:dev
npm run e2e:prepare  # Creates Playwright auth storage states
```

## Test Organization

- **ID**: uuid(1) = `00000000-0000-4000-8000-000000000001`
- **Members**: All three test users
- **Entitlements**: Founding Beta enabled
- **Automatic quotes**: Enabled for testing
