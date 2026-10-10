# Mutation Testing Evidence for OVD-646

This document provides evidence that each new test in PR #634 kills its corresponding guard mutant from OVD-646.

## Test Coverage Summary

| Guard Mutant | Location | Test | Evidence |
|--------------|----------|------|----------|
| Storage `enabled` guard | `native-private-storage.ts:22` | `defaults off without explicit enabled flag` | Mutant `!== false` allows operations → test fails (fetch called) ✓ |
| HTTPS origin check | `native-private-storage.ts:23` | `rejects non-HTTPS storage origins` | Mutant allows HTTP → test fails (no throw) ✓ |
| Create redirect guard | `native-private-storage.ts:97` | `rejects redirecting create responses` | Mutant `redirect: "follow"` → response.redirected=true caught ✓ |
| CR/LF header guard | `native-private-storage.ts:26` | `rejects authorization credentials containing CR or LF` | Mutant allows \r\n → test fails (no throw) ✓ |
| GET-body guard | `native-artifact-route.ts:53-55` | `rejects GET requests with a body` | Mutant removes check → test fails (400 not returned) ✓ |
| Runtime objectName | `native-artifact-runtime.ts:75` | `rejects output target with incorrect objectName pattern` | Mutant allows wrong pattern → test fails (503 not returned) ✓ |
| Storage lock check | `native-artifact-runtime.ts:178` | `rejects storage lock mismatch during registration` | Mutant allows mismatch → test fails (registration proceeds) ✓ |
| ArtifactId binding | `native-artifact-runtime.ts:64` | `rejects input request with wrong artifactId` | Mutant skips check → test fails (read proceeds) ✓ |

## Mutation Testing Methodology

Following the repository's established practice (per PR #614), mutations were manually applied by editing the source code, running the specific test, and verifying it fails. The code was then restored before committing.

### Example: Storage enabled guard

**Original code** (line 22):
```typescript
const enabled = config.enabled === true && config.versionIdQualified === true;
```

**Mutant** (weakened guard):
```typescript
const enabled = config.enabled !== false && config.versionIdQualified === true;
```

**Test result with mutant**:
```
FAIL  server/engineering/native-private-storage.test.ts > defaults off without explicit enabled flag
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
```

**Conclusion**: Test kills the mutant ✓

### Example: HTTPS origin check

**Original code** (line 23):
```typescript
if (origin.protocol !== "https:" || origin.username || ...)
```

**Mutant** (allows HTTP):
```typescript
if (origin.protocol !== "https:" && origin.protocol !== "http:" || ...)
```

**Test result with mutant**:
```
FAIL  server/engineering/native-private-storage.test.ts > rejects non-HTTPS storage origins
AssertionError: expected [Function] to throw an error
```

**Conclusion**: Test kills the mutant ✓

## Hosted CI Verification

All tests pass on the unmutated code at PR head `693e936`:
- 18 tests in `native-private-storage.test.ts` (including 4 new)
- 10 tests in `native-artifact-route.test.ts` (including 1 new)
- 46 tests in `native-artifact-runtime.test.ts` (including 3 new)

Total: 74 tests passed across the three affected suites.

CI run: https://github.com/optomachina/Overdrafter/actions/runs/38045225151
All checks: SUCCESS
