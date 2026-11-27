// In-page stand-in for the fixture Supabase origin. Pausing that origin with
// page.route deadlocks the upload: the file change waits on the paused fetch,
// and the route cannot answer until that change command returns. A fetch
// resolved inside the page does not pause.
const drafts = [];
window.__assemblyUploadDrafts = drafts;

const originalClick = HTMLInputElement.prototype.click;
HTMLInputElement.prototype.click = function () {
  if (this.type === "file") return;
  return originalClick.call(this);
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  try {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const base = window.location.origin && window.location.origin !== "null"
      ? window.location.origin
      : "http://127.0.0.1:4173";
    const url = new URL(rawUrl, base);
    if (url.port !== "9") return originalFetch(input, init);

    const json = (status, body) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    const rpcMatch = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname);
    const rpc = rpcMatch ? rpcMatch[1] : null;
    if (!rpc) {
      return json(200, url.pathname.startsWith("/storage/") ? { Key: url.pathname } : []);
    }

    let body = null;
    try {
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
      body = typeof raw === "string" && raw.startsWith("{") ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }

    if (rpc === "api_get_founding_beta_access_state") {
      return json(200, {
        state: "eligible",
        policyRevision: "founding-beta-2026-08-15",
        termsPath: "/legal/beta-terms",
        privacyPath: "/legal/privacy",
      });
    }
    if (rpc === "api_create_client_draft") {
      const id = "00000000-0000-4000-8000-" + String(drafts.length + 1).padStart(12, "0");
      drafts.push({
        id,
        title: typeof body?.p_title === "string" ? body.p_title : "",
        projectId: typeof body?.p_project_id === "string" ? body.p_project_id : null,
      });
      return json(200, id);
    }
    // Assembly files are ordered first, so the second draft is the part that
    // fails. A later retry creates new draft ids and is not this one.
    if (rpc === "api_prepare_job_file_upload" && drafts[1] && body?.p_job_id === drafts[1].id) {
      return json(400, {
        code: "P0001",
        message: "synthetic_mid_batch_failure",
        details: null,
        hint: null,
      });
    }
    if (rpc === "api_declare_job_export_status") {
      return json(200, {
        declarationId: "declaration-1",
        answer: "not_controlled",
        termsVersion: "ovd-beta-export-control.v1",
        uploadAllowed: true,
        reasonCode: null,
      });
    }
    if (rpc === "api_prepare_job_file_upload") {
      return json(200, {
        status: "upload_required",
        storageBucket: "job-files",
        storagePath: "org/" + String(body?.p_original_name ?? "file"),
      });
    }
    if (rpc === "api_finalize_job_file_upload") return json(200, "file-1");
    if (rpc === "api_prepare_part_intake" || rpc === "api_reconcile_job_parts") return json(200, {});
    if (rpc === "api_request_extraction") return json(200, 1);
    return json(200, null);
  } catch (error) {
    console.error("fixture fetch stub", error);
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }
};
