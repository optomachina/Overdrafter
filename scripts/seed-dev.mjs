import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  QUOTED_SAMPLE_ASSETS,
  QUOTED_SAMPLE_LANES,
  QUOTED_SAMPLE_PART,
} from "../src/features/quotes/demo/quoted-sample.js";

const PASSWORD = "Overdrafter123!";
const FIXTURE_TIMESTAMP = "2026-03-10T17:00:00.000Z";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const ids = {
  organization: uuid(1),
  pricingPolicy: uuid(10),
  cleanupProject: uuid(20),
  quotedProject: uuid(21),
  publishedProject: uuid(22),
  cleanupJob: uuid(100),
  quotedJobA: uuid(101),
  quotedJobB: uuid(102),
  publishedJob: uuid(103),
  cleanupPart: uuid(200),
  quotedPartA: uuid(201),
  quotedPartB: uuid(202),
  publishedPart: uuid(203),
  projectMembershipClientCleanup: uuid(300),
  projectMembershipClientQuoted: uuid(301),
  projectMembershipClientPublished: uuid(302),
  projectMembershipEstimatorQuoted: uuid(303),
  projectMembershipAdminPublished: uuid(304),
  organizationMembershipClient: uuid(310),
  organizationMembershipEstimator: uuid(311),
  organizationMembershipAdmin: uuid(312),
  projectJobCleanup: uuid(400),
  projectJobQuotedA: uuid(401),
  projectJobQuotedB: uuid(402),
  projectJobPublished: uuid(403),
  cleanupCadFile: uuid(500),
  cleanupDrawingFile: uuid(501),
  quotedCadFileA: uuid(502),
  quotedDrawingFileA: uuid(503),
  quotedCadFileB: uuid(504),
  quotedDrawingFileB: uuid(505),
  publishedCadFile: uuid(506),
  publishedDrawingFile: uuid(507),
  cleanupPreview1: uuid(520),
  cleanupPreview2: uuid(521),
  quotedPreviewA1: uuid(522),
  quotedPreviewA2: uuid(523),
  quotedPreviewB1: uuid(524),
  quotedPreviewB2: uuid(525),
  publishedPreview1: uuid(526),
  publishedPreview2: uuid(527),
  cleanupExtraction: uuid(540),
  quotedExtractionA: uuid(541),
  quotedExtractionB: uuid(542),
  publishedExtraction: uuid(543),
  cleanupRequirement: uuid(550),
  quotedRequirementA: uuid(551),
  quotedRequirementB: uuid(552),
  publishedRequirement: uuid(553),
  quotedRunA: uuid(600),
  quotedRunB: uuid(601),
  publishedRun: uuid(602),
  quoteResultQuotedAXometry: uuid(700),
  quoteResultQuotedAProto: uuid(701),
  quoteResultQuotedBFictiv: uuid(702),
  quoteResultQuotedBSendCut: uuid(703),
  quoteResultPublishedXometry: uuid(704),
  quoteResultPublishedProto: uuid(705),
  offerQuotedAXometry: uuid(800),
  offerQuotedAProto: uuid(801),
  offerQuotedBFictiv: uuid(802),
  offerQuotedBSendCut: uuid(803),
  offerPublishedXometry: uuid(804),
  offerPublishedProto: uuid(805),
  publishedPackage: uuid(900),
  publishedOptionLowest: uuid(910),
  publishedOptionFastest: uuid(911),
  publishedOptionBalanced: uuid(912),
};

const userSpecs = [
  {
    email: "client.demo@overdrafter.local",
    name: "Demo Client",
    role: "client",
  },
  {
    email: "estimator.demo@overdrafter.local",
    name: "Demo Estimator",
    role: "internal_estimator",
  },
  {
    email: "admin.demo@overdrafter.local",
    name: "Demo Admin",
    role: "internal_admin",
  },
];

const assetSpecs = [
  {
    fileName: "demo-bracket.step",
    storagePath: "fixtures/demo-bracket.step",
    contentType: "model/step",
  },
  {
    fileName: "demo-bracket-drawing.pdf",
    storagePath: "fixtures/demo-bracket-drawing.pdf",
    contentType: "application/pdf",
  },
  {
    fileName: "demo-bracket-page-1.svg",
    storagePath: "fixtures/demo-bracket-page-1.svg",
    contentType: "image/svg+xml",
  },
  {
    fileName: "demo-bracket-page-2.svg",
    storagePath: "fixtures/demo-bracket-page-2.svg",
    contentType: "image/svg+xml",
  },
  {
    fileName: QUOTED_SAMPLE_ASSETS.cad.fileName,
    storagePath: QUOTED_SAMPLE_ASSETS.cad.storagePath,
    contentType: "model/step",
  },
  {
    fileName: QUOTED_SAMPLE_ASSETS.drawing.fileName,
    storagePath: QUOTED_SAMPLE_ASSETS.drawing.storagePath,
    contentType: "application/pdf",
  },
];

async function main() {
  const allowRemote = process.argv.includes("--allow-remote");
  const { supabaseUrl, serviceRoleKey } = resolveCredentials();
  ensureLocalProject(supabaseUrl, allowRemote);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const users = {};

  for (const spec of userSpecs) {
    users[spec.role] = await upsertUser(admin, spec);
  }

  await ensureBucket(admin, "job-files");
  const assetFiles = await uploadFixtureAssets(admin);

  await cleanupExistingSeedData(admin);
  await insertSeedData(admin, users, assetFiles);

  console.log("Seeded local debug data.");
  console.log(`Client: ${userSpecs[0].email}`);
  console.log(`Estimator: ${userSpecs[1].email}`);
  console.log(`Admin: ${userSpecs[2].email}`);
  console.log(`Password: ${PASSWORD}`);
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function resolveCredentials() {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.API_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY;

  if (supabaseUrl && serviceRoleKey) {
    return { supabaseUrl, serviceRoleKey };
  }

  let output;

  try {
    output = execFileSync("supabase", ["status", "-o", "env"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch (error) {
    throw new Error(
      "Unable to resolve local Supabase credentials. Run `npm run db:start` first or set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      { cause: error },
    );
  }

  const parsed = {};

  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [rawKey, ...rest] = line.split("=");
      const rawValue = rest.join("=").trim();

      if (!rawKey || !rawValue) {
        return;
      }

      parsed[rawKey.trim()] = rawValue.replace(/^['"]|['"]$/g, "");
    });

  const resolvedUrl = parsed.API_URL ?? parsed.SUPABASE_URL;
  const resolvedServiceRoleKey = parsed.SERVICE_ROLE_KEY ?? parsed.SUPABASE_SERVICE_ROLE_KEY;

  if (!resolvedUrl || !resolvedServiceRoleKey) {
    throw new Error("Supabase status did not include API_URL and SERVICE_ROLE_KEY.");
  }

  return {
    supabaseUrl: resolvedUrl,
    serviceRoleKey: resolvedServiceRoleKey,
  };
}

function ensureLocalProject(supabaseUrl, allowRemote) {
  const hostname = new URL(supabaseUrl).hostname;

  if (!allowRemote && hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error(
      `Refusing to seed non-local Supabase project ${supabaseUrl}. Re-run with --allow-remote to override.`,
    );
  }
}

async function upsertUser(admin, spec) {
  const users = await listAllUsers(admin);
  const existingUser = users.find((user) => user.email?.toLowerCase() === spec.email.toLowerCase());

  if (existingUser) {
    const { data, error } = await admin.auth.admin.updateUserById(existingUser.id, {
      email: spec.email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: spec.name,
      },
      app_metadata: {
        provider: "email",
        providers: ["email"],
      },
    });

    if (error || !data.user) {
      throw error ?? new Error(`Unable to update ${spec.email}.`);
    }

    return data.user;
  }

  const { data, error } = await admin.auth.admin.createUser({
    email: spec.email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: {
      full_name: spec.name,
    },
    app_metadata: {
      provider: "email",
      providers: ["email"],
    },
  });

  if (error || !data.user) {
    throw error ?? new Error(`Unable to create ${spec.email}.`);
  }

  return data.user;
}

async function listAllUsers(admin) {
  const users = [];
  let page = 1;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });

    if (error) {
      throw error;
    }

    users.push(...data.users);

    if (!data.nextPage || data.nextPage === page) {
      break;
    }

    page = data.nextPage;
  }

  return users;
}

async function ensureBucket(admin, bucketId) {
  const { data, error } = await admin.storage.listBuckets();

  if (error) {
    throw error;
  }

  if (data.some((bucket) => bucket.id === bucketId)) {
    return;
  }

  const { error: createError } = await admin.storage.createBucket(bucketId, { public: false });

  if (createError && !/already exists/i.test(createError.message)) {
    throw createError;
  }
}

async function uploadFixtureAssets(admin) {
  const uploadedAssets = {};

  for (const spec of assetSpecs) {
    const absolutePath = path.join(repoRoot, "public", "fixtures", spec.fileName);
    const buffer = await readFile(absolutePath);
    const { error } = await admin.storage.from("job-files").upload(spec.storagePath, buffer, {
      upsert: true,
      contentType: spec.contentType,
    });

    if (error) {
      throw error;
    }

    uploadedAssets[spec.fileName] = {
      buffer,
      storagePath: spec.storagePath,
      sizeBytes: buffer.byteLength,
      contentSha256: createHash("sha256").update(buffer).digest("hex"),
      contentType: spec.contentType,
    };
  }

  return uploadedAssets;
}

async function cleanupExistingSeedData(admin) {
  await deleteRows(admin, "published_quote_options", "organization_id", ids.organization);
  await deleteRows(admin, "published_quote_packages", "organization_id", ids.organization);
  await deleteRows(admin, "vendor_quote_offers", "organization_id", ids.organization);
  await deleteRows(admin, "vendor_quote_results", "organization_id", ids.organization);
  await deleteRows(admin, "quote_runs", "organization_id", ids.organization);
  await deleteRows(admin, "approved_part_requirements", "organization_id", ids.organization);
  await deleteRows(admin, "drawing_preview_assets", "organization_id", ids.organization);
  await deleteRows(admin, "drawing_extractions", "organization_id", ids.organization);
  await deleteRows(admin, "parts", "organization_id", ids.organization);
  await deleteRows(admin, "job_files", "organization_id", ids.organization);
  await deleteRows(admin, "project_jobs", "project_id", [
    ids.cleanupProject,
    ids.quotedProject,
    ids.publishedProject,
  ]);
  await deleteRows(admin, "project_memberships", "project_id", [
    ids.cleanupProject,
    ids.quotedProject,
    ids.publishedProject,
  ]);
  await deleteRows(admin, "project_invites", "project_id", [
    ids.cleanupProject,
    ids.quotedProject,
    ids.publishedProject,
  ]);
  await deleteRows(admin, "jobs", "organization_id", ids.organization);
  await deleteRows(admin, "projects", "organization_id", ids.organization);
  await deleteRows(admin, "pricing_policies", "organization_id", ids.organization);
  await deleteRows(admin, "organization_memberships", "organization_id", ids.organization);
  await deleteRows(admin, "organizations", "id", ids.organization);
}

async function deleteRows(admin, table, column, value) {
  const query = admin.from(table).delete();
  const { error } = Array.isArray(value) ? await query.in(column, value) : await query.eq(column, value);

  if (error) {
    throw error;
  }
}

async function insertSeedData(admin, users, assetFiles) {
  const projects = [
    {
      id: ids.cleanupProject,
      organization_id: ids.organization,
      owner_user_id: users.client.id,
      name: "Request Cleanup",
      description: "Parts still being normalized before quote selection.",
      archived_at: null,
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.quotedProject,
      organization_id: ids.organization,
      owner_user_id: users.client.id,
      name: QUOTED_SAMPLE_PART.projectName,
      description: QUOTED_SAMPLE_PART.projectDescription,
      archived_at: null,
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.publishedProject,
      organization_id: ids.organization,
      owner_user_id: users.client.id,
      name: "Production Plates",
      description: "Published customer review package.",
      archived_at: null,
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
    },
  ];

  await upsertRows(admin, "organizations", [
    {
      id: ids.organization,
      name: "Fixture Machine Co.",
      slug: "fixture-machine-co",
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
    },
  ]);

  await upsertRows(admin, "pricing_policies", [
    {
      id: ids.pricingPolicy,
      organization_id: ids.organization,
      version: "fixture-2026-03-10",
      markup_percent: 12,
      currency_minor_unit: 100,
      is_active: true,
      notes: "Local debugging seed policy.",
      created_at: FIXTURE_TIMESTAMP,
    },
  ]);

  await upsertRows(admin, "organization_memberships", [
    {
      id: ids.organizationMembershipClient,
      organization_id: ids.organization,
      user_id: users.client.id,
      role: "client",
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.organizationMembershipEstimator,
      organization_id: ids.organization,
      user_id: users.internal_estimator.id,
      role: "internal_estimator",
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.organizationMembershipAdmin,
      organization_id: ids.organization,
      user_id: users.internal_admin.id,
      role: "internal_admin",
      created_at: FIXTURE_TIMESTAMP,
    },
  ]);

  await upsertRows(admin, "projects", projects);

  await upsertRows(admin, "project_memberships", [
    {
      id: ids.projectMembershipClientCleanup,
      project_id: ids.cleanupProject,
      user_id: users.client.id,
      role: "owner",
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.projectMembershipClientQuoted,
      project_id: ids.quotedProject,
      user_id: users.client.id,
      role: "owner",
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.projectMembershipClientPublished,
      project_id: ids.publishedProject,
      user_id: users.client.id,
      role: "owner",
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.projectMembershipEstimatorQuoted,
      project_id: ids.quotedProject,
      user_id: users.internal_estimator.id,
      role: "editor",
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.projectMembershipAdminPublished,
      project_id: ids.publishedProject,
      user_id: users.internal_admin.id,
      role: "owner",
      created_at: FIXTURE_TIMESTAMP,
    },
  ]);

  await upsertRows(admin, "jobs", [
    {
      id: ids.cleanupJob,
      organization_id: ids.organization,
      project_id: ids.cleanupProject,
      selected_vendor_quote_offer_id: null,
      created_by: users.client.id,
      title: "FX-100 Bracket",
      description: "Customer drawing is attached, but the material callout needs cleanup.",
      status: "needs_spec_review",
      source: "seed_dev",
      active_pricing_policy_id: ids.pricingPolicy,
      tags: ["fixture", "needs-attention"],
      requested_quote_quantities: [12, 24],
      requested_by_date: "2026-03-24",
      archived_at: null,
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.quotedJobA,
      organization_id: ids.organization,
      project_id: ids.quotedProject,
      selected_vendor_quote_offer_id: null,
      created_by: users.client.id,
      title: QUOTED_SAMPLE_PART.jobTitle,
      description: QUOTED_SAMPLE_PART.jobDescription,
      status: "quoting",
      source: "seed_dev",
      active_pricing_policy_id: ids.pricingPolicy,
      tags: ["fixture", "quoted"],
      requested_quote_quantities: [...QUOTED_SAMPLE_PART.requestedQuoteQuantities],
      requested_by_date: QUOTED_SAMPLE_PART.requestedByDate,
      archived_at: null,
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.publishedJob,
      organization_id: ids.organization,
      project_id: ids.publishedProject,
      selected_vendor_quote_offer_id: null,
      created_by: users.client.id,
      title: "FX-200 Production Plate",
      description: "Published part ready for checkout review.",
      status: "published",
      source: "seed_dev",
      active_pricing_policy_id: ids.pricingPolicy,
      tags: ["fixture", "published"],
      requested_quote_quantities: [25, 50],
      requested_by_date: "2026-04-02",
      archived_at: null,
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
    },
  ]);

  await upsertRows(admin, "project_jobs", [
    {
      id: ids.projectJobCleanup,
      project_id: ids.cleanupProject,
      job_id: ids.cleanupJob,
      created_by: users.client.id,
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.projectJobQuotedA,
      project_id: ids.quotedProject,
      job_id: ids.quotedJobA,
      created_by: users.client.id,
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.projectJobPublished,
      project_id: ids.publishedProject,
      job_id: ids.publishedJob,
      created_by: users.client.id,
      created_at: FIXTURE_TIMESTAMP,
    },
  ]);

  const stepAsset = assetFiles["demo-bracket.step"];
  const pdfAsset = assetFiles["demo-bracket-drawing.pdf"];
  const quotedCadAsset = assetFiles[QUOTED_SAMPLE_ASSETS.cad.fileName];
  const quotedDrawingAsset = assetFiles[QUOTED_SAMPLE_ASSETS.drawing.fileName];
  const quotedVendorQuoteResultRows = QUOTED_SAMPLE_LANES.map((lane, index) =>
    createQuotedSampleQuoteResultRow({
      id: uuid(720 + index),
      quoteRunId: ids.quotedRunA,
      partId: ids.quotedPartA,
      lane,
    }),
  );
  const quotedVendorQuoteOfferRows = QUOTED_SAMPLE_LANES.map((lane, index) =>
    createQuotedSampleOfferRow({
      id: uuid(820 + index),
      quoteResultId: quotedVendorQuoteResultRows[index].id,
      lane,
      sortRank: index,
    }),
  );
  const selectedQuotedOfferRow =
    quotedVendorQuoteOfferRows.find((offer) => offer.offer_key.endsWith(QUOTED_SAMPLE_PART.selectedLaneId)) ??
    quotedVendorQuoteOfferRows[0];

  await upsertRows(admin, "job_files", [
    createJobFileRow({
      id: ids.cleanupCadFile,
      jobId: ids.cleanupJob,
      originalName: "fx-100-bracket.step",
      normalizedName: "fx-100-bracket.step",
      fileKind: "cad",
      uploadedBy: users.client.id,
      storagePath: stepAsset.storagePath,
      matchedPartKey: "fx-100-bracket",
      asset: stepAsset,
    }),
    createJobFileRow({
      id: ids.cleanupDrawingFile,
      jobId: ids.cleanupJob,
      originalName: "fx-100-bracket-drawing.pdf",
      normalizedName: "fx-100-bracket-drawing.pdf",
      fileKind: "drawing",
      uploadedBy: users.client.id,
      storagePath: pdfAsset.storagePath,
      matchedPartKey: "fx-100-bracket",
      asset: pdfAsset,
    }),
    createJobFileRow({
      id: ids.quotedCadFileA,
      jobId: ids.quotedJobA,
      originalName: QUOTED_SAMPLE_ASSETS.cad.fileName,
      normalizedName: QUOTED_SAMPLE_ASSETS.cad.normalizedName,
      fileKind: "cad",
      uploadedBy: users.client.id,
      storagePath: quotedCadAsset.storagePath,
      matchedPartKey: "1093-05589-02",
      asset: quotedCadAsset,
    }),
    createJobFileRow({
      id: ids.quotedDrawingFileA,
      jobId: ids.quotedJobA,
      originalName: QUOTED_SAMPLE_ASSETS.drawing.fileName,
      normalizedName: QUOTED_SAMPLE_ASSETS.drawing.normalizedName,
      fileKind: "drawing",
      uploadedBy: users.client.id,
      storagePath: quotedDrawingAsset.storagePath,
      matchedPartKey: "1093-05589-02",
      asset: quotedDrawingAsset,
    }),
    createJobFileRow({
      id: ids.publishedCadFile,
      jobId: ids.publishedJob,
      originalName: "fx-200-production-plate.step",
      normalizedName: "fx-200-production-plate.step",
      fileKind: "cad",
      uploadedBy: users.client.id,
      storagePath: stepAsset.storagePath,
      matchedPartKey: "fx-200-production-plate",
      asset: stepAsset,
    }),
    createJobFileRow({
      id: ids.publishedDrawingFile,
      jobId: ids.publishedJob,
      originalName: "fx-200-production-plate-drawing.pdf",
      normalizedName: "fx-200-production-plate-drawing.pdf",
      fileKind: "drawing",
      uploadedBy: users.client.id,
      storagePath: pdfAsset.storagePath,
      matchedPartKey: "fx-200-production-plate",
      asset: pdfAsset,
    }),
  ]);

  await upsertRows(admin, "parts", [
    createPartRow({
      id: ids.cleanupPart,
      jobId: ids.cleanupJob,
      name: "FX-100",
      normalizedKey: "fx-100-bracket",
      cadFileId: ids.cleanupCadFile,
      drawingFileId: ids.cleanupDrawingFile,
      quantity: 12,
    }),
    createPartRow({
      id: ids.quotedPartA,
      jobId: ids.quotedJobA,
      name: QUOTED_SAMPLE_PART.partNumber,
      normalizedKey: "1093-05589-02",
      cadFileId: ids.quotedCadFileA,
      drawingFileId: ids.quotedDrawingFileA,
      quantity: QUOTED_SAMPLE_PART.quantity,
    }),
    createPartRow({
      id: ids.publishedPart,
      jobId: ids.publishedJob,
      name: "FX-200",
      normalizedKey: "fx-200-production-plate",
      cadFileId: ids.publishedCadFile,
      drawingFileId: ids.publishedDrawingFile,
      quantity: 25,
    }),
  ]);

  await upsertRows(admin, "drawing_extractions", [
    createExtractionRow(ids.cleanupExtraction, ids.cleanupPart, "FX-100", "A", "L-bracket with tapped holes"),
    createExtractionRow(
      ids.quotedExtractionA,
      ids.quotedPartA,
      QUOTED_SAMPLE_PART.partNumber,
      QUOTED_SAMPLE_PART.revision,
      QUOTED_SAMPLE_PART.description,
      QUOTED_SAMPLE_PART.material,
      QUOTED_SAMPLE_PART.finish,
    ),
    createExtractionRow(ids.publishedExtraction, ids.publishedPart, "FX-200", "B", "Production plate with finish callout"),
  ]);

  await upsertRows(admin, "drawing_preview_assets", [
    createPreviewAssetRow(ids.cleanupPreview1, ids.cleanupPart, 1, "fixtures/demo-bracket-page-1.svg"),
    createPreviewAssetRow(ids.cleanupPreview2, ids.cleanupPart, 2, "fixtures/demo-bracket-page-2.svg"),
    createPreviewAssetRow(ids.publishedPreview1, ids.publishedPart, 1, "fixtures/demo-bracket-page-1.svg"),
    createPreviewAssetRow(ids.publishedPreview2, ids.publishedPart, 2, "fixtures/demo-bracket-page-2.svg"),
  ]);

  await upsertRows(admin, "approved_part_requirements", [
    createRequirementRow(ids.cleanupRequirement, ids.cleanupPart, users.client.id, "FX-100", "A", "L-bracket with tapped holes", "6061-T6 aluminum", "As machined", 12, [12, 24], "2026-03-24"),
    createRequirementRow(
      ids.quotedRequirementA,
      ids.quotedPartA,
      users.client.id,
      QUOTED_SAMPLE_PART.partNumber,
      QUOTED_SAMPLE_PART.revision,
      QUOTED_SAMPLE_PART.description,
      QUOTED_SAMPLE_PART.material,
      QUOTED_SAMPLE_PART.finish,
      QUOTED_SAMPLE_PART.quantity,
      [...QUOTED_SAMPLE_PART.requestedQuoteQuantities],
      QUOTED_SAMPLE_PART.requestedByDate,
      ["xometry", "protolabs", "sendcutsend", "partsbadger", "fictiv"],
      {
        partNumber: QUOTED_SAMPLE_PART.partNumber,
        revision: QUOTED_SAMPLE_PART.revision,
        description: QUOTED_SAMPLE_PART.description,
        material: QUOTED_SAMPLE_PART.material,
        finish: QUOTED_SAMPLE_PART.finish,
        threadCallouts: QUOTED_SAMPLE_PART.threadCallouts,
        threadMatchNotes: QUOTED_SAMPLE_PART.threadMatchNotes,
      },
    ),
    createRequirementRow(ids.publishedRequirement, ids.publishedPart, users.client.id, "FX-200", "B", "Production plate with finish callout", "7075 aluminum", "Black anodize", 25, [25, 50], "2026-04-02"),
  ]);

  await upsertRows(admin, "quote_runs", [
    createQuoteRunRow(ids.quotedRunA, ids.quotedJobA, users.internal_estimator.id, "completed", false),
    createQuoteRunRow(ids.publishedRun, ids.publishedJob, users.internal_estimator.id, "published", true),
  ]);

  await upsertRows(admin, "vendor_quote_results", [
    ...quotedVendorQuoteResultRows,
    createQuoteResultRow(ids.quoteResultPublishedXometry, ids.publishedRun, ids.publishedPart, "xometry", 25, 14.4, 360, 9, true),
    createQuoteResultRow(ids.quoteResultPublishedProto, ids.publishedRun, ids.publishedPart, "protolabs", 25, 16.1, 402.5, 6, true),
  ]);

  await upsertRows(admin, "vendor_quote_offers", [
    ...quotedVendorQuoteOfferRows,
    createOfferRow(ids.offerPublishedXometry, ids.quoteResultPublishedXometry, "Xometry USA", "Balanced", "Domestic", 14.4, 360, 9),
    createOfferRow(ids.offerPublishedProto, ids.quoteResultPublishedProto, "Proto Labs", "Fastest", "Domestic", 16.1, 402.5, 6),
  ]);

  await upsertRows(admin, "jobs", [
    {
      id: ids.quotedJobA,
      selected_vendor_quote_offer_id: selectedQuotedOfferRow.id,
    },
    {
      id: ids.publishedJob,
      selected_vendor_quote_offer_id: ids.offerPublishedXometry,
    },
  ]);

  await upsertRows(admin, "published_quote_packages", [
    {
      id: ids.publishedPackage,
      job_id: ids.publishedJob,
      quote_run_id: ids.publishedRun,
      organization_id: ids.organization,
      published_by: users.internal_estimator.id,
      pricing_policy_id: ids.pricingPolicy,
      auto_published: true,
      client_summary: "Published for client review.",
      created_at: FIXTURE_TIMESTAMP,
      published_at: FIXTURE_TIMESTAMP,
    },
  ]);

  await upsertRows(admin, "published_quote_options", [
    {
      id: ids.publishedOptionLowest,
      package_id: ids.publishedPackage,
      organization_id: ids.organization,
      requested_quantity: 25,
      option_kind: "lowest_cost",
      label: "Lowest cost",
      published_price_usd: 360,
      lead_time_business_days: 9,
      comparison_summary: "Lowest landed cost.",
      source_vendor_quote_id: ids.quoteResultPublishedXometry,
      source_vendor_quote_offer_id: ids.offerPublishedXometry,
      markup_policy_version: "fixture-2026-03-10",
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.publishedOptionFastest,
      package_id: ids.publishedPackage,
      organization_id: ids.organization,
      requested_quantity: 25,
      option_kind: "fastest_delivery",
      label: "Fastest delivery",
      published_price_usd: 402.5,
      lead_time_business_days: 6,
      comparison_summary: "Fastest delivery lane.",
      source_vendor_quote_id: ids.quoteResultPublishedProto,
      source_vendor_quote_offer_id: ids.offerPublishedProto,
      markup_policy_version: "fixture-2026-03-10",
      created_at: FIXTURE_TIMESTAMP,
    },
    {
      id: ids.publishedOptionBalanced,
      package_id: ids.publishedPackage,
      organization_id: ids.organization,
      requested_quantity: 25,
      option_kind: "balanced",
      label: "Balanced",
      published_price_usd: 378,
      lead_time_business_days: 8,
      comparison_summary: "Balanced cost and lead time.",
      source_vendor_quote_id: ids.quoteResultPublishedXometry,
      source_vendor_quote_offer_id: ids.offerPublishedXometry,
      markup_policy_version: "fixture-2026-03-10",
      created_at: FIXTURE_TIMESTAMP,
    },
  ]);
}

function createJobFileRow(input) {
  return {
    id: input.id,
    job_id: input.jobId,
    organization_id: ids.organization,
    uploaded_by: input.uploadedBy,
    blob_id: null,
    content_sha256: input.asset.contentSha256,
    storage_bucket: "job-files",
    storage_path: input.storagePath,
    original_name: input.originalName,
    normalized_name: input.normalizedName,
    file_kind: input.fileKind,
    mime_type: input.asset.contentType,
    size_bytes: input.asset.sizeBytes,
    matched_part_key: input.matchedPartKey,
    created_at: FIXTURE_TIMESTAMP,
  };
}

function createPartRow(input) {
  return {
    id: input.id,
    job_id: input.jobId,
    organization_id: ids.organization,
    name: input.name,
    normalized_key: input.normalizedKey,
    cad_file_id: input.cadFileId,
    drawing_file_id: input.drawingFileId,
    quantity: input.quantity,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

function createExtractionRow(id, partId, partNumber, revision, description, material = "6061-T6 aluminum", finish = null) {
  return {
    id,
    part_id: partId,
    organization_id: ids.organization,
    extractor_version: "seed-dev",
    extraction: {
      partNumber,
      revision,
      description,
      material: {
        raw: material,
        normalized: material,
        confidence: 0.98,
      },
      finish: {
        raw: finish,
        normalized: finish,
        confidence: finish ? 0.98 : 0.25,
      },
    },
    confidence: 0.98,
    warnings: [],
    evidence: [],
    status: "approved",
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

function createPreviewAssetRow(id, partId, pageNumber, storagePath) {
  return {
    id,
    part_id: partId,
    organization_id: ids.organization,
    page_number: pageNumber,
    kind: "page_image",
    storage_bucket: "job-files",
    storage_path: storagePath,
    width: 1200,
    height: 900,
    created_at: FIXTURE_TIMESTAMP,
  };
}

function createRequirementRow(
  id,
  partId,
  approvedBy,
  partNumber,
  revision,
  description,
  material,
  finish,
  quantity,
  quoteQuantities,
  requestedByDate,
  applicableVendors = ["xometry", "protolabs", "fictiv"],
  specSnapshot = null,
) {
  return {
    id,
    part_id: partId,
    organization_id: ids.organization,
    approved_by: approvedBy,
    description,
    part_number: partNumber,
    revision,
    material,
    finish,
    tightest_tolerance_inch: 0.005,
    quantity,
    quote_quantities: quoteQuantities,
    requested_by_date: requestedByDate,
    applicable_vendors: applicableVendors,
    spec_snapshot: specSnapshot ?? {
      partNumber,
      revision,
      description,
      material,
      finish,
    },
    approved_at: FIXTURE_TIMESTAMP,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

function createQuoteRunRow(id, jobId, initiatedBy, status, requestedAutoPublish) {
  return {
    id,
    job_id: jobId,
    organization_id: ids.organization,
    initiated_by: initiatedBy,
    status,
    requested_auto_publish: requestedAutoPublish,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

function createQuoteResultRow(id, quoteRunId, partId, vendor, requestedQuantity, unitPriceUsd, totalPriceUsd, leadTimeBusinessDays, domestic) {
  return {
    id,
    quote_run_id: quoteRunId,
    part_id: partId,
    organization_id: ids.organization,
    vendor,
    requested_quantity: requestedQuantity,
    status: "instant_quote_received",
    unit_price_usd: unitPriceUsd,
    total_price_usd: totalPriceUsd,
    lead_time_business_days: leadTimeBusinessDays,
    quote_url: `https://example.test/${vendor}/${id}`,
    dfm_issues: [],
    notes: [],
    raw_payload: {
      domestic,
    },
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

function createOfferRow(id, quoteResultId, supplier, laneLabel, sourcing, unitPriceUsd, totalPriceUsd, leadTimeBusinessDays) {
  return {
    id,
    vendor_quote_result_id: quoteResultId,
    organization_id: ids.organization,
    offer_key: id,
    supplier,
    lane_label: laneLabel,
    sourcing,
    tier: "standard",
    quote_ref: `FX-${id.slice(-4).toUpperCase()}`,
    quote_date: FIXTURE_TIMESTAMP.slice(0, 10),
    unit_price_usd: unitPriceUsd,
    total_price_usd: totalPriceUsd,
    lead_time_business_days: leadTimeBusinessDays,
    ship_receive_by: null,
    due_date: null,
    process: "CNC mill",
    material: "6061-T6 aluminum",
    finish: "As machined",
    tightest_tolerance: "+/-0.005",
    tolerance_source: "seed-dev",
    thread_callouts: null,
    thread_match_notes: null,
    notes: laneLabel,
    sort_rank: 0,
    raw_payload: {
      sourcing,
    },
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

function createQuotedSampleQuoteResultRow({ id, quoteRunId, partId, lane }) {
  return {
    id,
    quote_run_id: quoteRunId,
    part_id: partId,
    organization_id: ids.organization,
    vendor: lane.vendor,
    requested_quantity: lane.requestedQuantity,
    status: "instant_quote_received",
    unit_price_usd: lane.unitPriceUsd,
    total_price_usd: lane.totalPriceUsd,
    lead_time_business_days: lane.leadTimeBusinessDays,
    quote_url: `https://example.test/${lane.vendor}/${lane.id}`,
    dfm_issues: [],
    notes: lane.notes ? [lane.notes] : [],
    raw_payload: {
      sourcing: lane.sourcing,
      laneId: lane.id,
    },
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

function createQuotedSampleOfferRow({ id, quoteResultId, lane, sortRank }) {
  return {
    id,
    vendor_quote_result_id: quoteResultId,
    organization_id: ids.organization,
    offer_key: `quoted-sample-${lane.id}`,
    supplier: lane.supplier,
    lane_label: lane.laneLabel,
    sourcing: lane.sourcing,
    tier: lane.tier,
    quote_ref: lane.quoteRef,
    quote_date: lane.quoteDate,
    unit_price_usd: lane.unitPriceUsd,
    total_price_usd: lane.totalPriceUsd,
    lead_time_business_days: lane.leadTimeBusinessDays,
    ship_receive_by: lane.shipReceiveBy,
    due_date: lane.dueDate,
    process: lane.process,
    material: lane.material,
    finish: lane.finish,
    tightest_tolerance: lane.tightestTolerance,
    tolerance_source: lane.toleranceSource,
    thread_callouts: lane.threadCallouts,
    thread_match_notes: lane.threadMatchNotes,
    notes: lane.notes,
    sort_rank: sortRank,
    raw_payload: {
      sourcing: lane.sourcing,
      laneId: lane.id,
    },
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

async function upsertRows(admin, table, rows) {
  const { error } = await admin.from(table).upsert(rows, { onConflict: "id" });

  if (error) {
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
