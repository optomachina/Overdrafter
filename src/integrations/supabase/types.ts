export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type AppRole = "client" | "internal_estimator" | "internal_admin";
export type ProjectRole = "owner" | "editor";
export type ProjectInviteStatus = "pending" | "accepted" | "revoked" | "expired";
export type JobStatus =
  | "uploaded"
  | "extracting"
  | "needs_spec_review"
  | "ready_to_quote"
  | "quoting"
  | "awaiting_vendor_manual_review"
  | "internal_review"
  | "published"
  | "client_selected"
  | "closed";
export type VendorName =
  | "xometry"
  | "fictiv"
  | "protolabs"
  | "sendcutsend"
  | "partsbadger"
  | "fastdms";
export type VendorStatus =
  | "queued"
  | "running"
  | "instant_quote_received"
  | "official_quote_received"
  | "manual_review_pending"
  | "manual_vendor_followup"
  | "failed"
  | "stale";
export type ClientOptionKind = "lowest_cost" | "fastest_delivery" | "balanced";
export type JobFileKind = "cad" | "drawing" | "artifact" | "other";
export type ExtractionStatus = "needs_review" | "approved";
export type QuoteRunStatus = "queued" | "running" | "completed" | "failed" | "published";
export type QueueTaskType =
  | "extract_part"
  | "run_vendor_quote"
  | "poll_vendor_quote"
  | "publish_package"
  | "repair_adapter_candidate";
export type QueueTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

type BaseRow = {
  id: string;
  created_at?: string;
  updated_at?: string;
};

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "13.0.5";
  };
  public: {
    Tables: {
      organizations: {
        Row: BaseRow & {
          name: string;
          slug: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["organizations"]["Insert"]>;
      };
      organization_memberships: {
        Row: BaseRow & {
          organization_id: string;
          user_id: string;
          role: AppRole;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          role: AppRole;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["organization_memberships"]["Insert"]>;
      };
      projects: {
        Row: BaseRow & {
          organization_id: string;
          owner_user_id: string;
          name: string;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          owner_user_id: string;
          name: string;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["projects"]["Insert"]>;
      };
      project_memberships: {
        Row: BaseRow & {
          project_id: string;
          user_id: string;
          role: ProjectRole;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          user_id: string;
          role?: ProjectRole;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["project_memberships"]["Insert"]>;
      };
      project_jobs: {
        Row: BaseRow & {
          project_id: string;
          job_id: string;
          created_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          job_id: string;
          created_by: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["project_jobs"]["Insert"]>;
      };
      project_invites: {
        Row: BaseRow & {
          project_id: string;
          email: string;
          role: ProjectRole;
          invited_by: string;
          accepted_by: string | null;
          token: string;
          status: ProjectInviteStatus;
          expires_at: string;
          accepted_at: string | null;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          email: string;
          role?: ProjectRole;
          invited_by: string;
          accepted_by?: string | null;
          token: string;
          status?: ProjectInviteStatus;
          expires_at?: string;
          accepted_at?: string | null;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["project_invites"]["Insert"]>;
      };
      user_pinned_projects: {
        Row: BaseRow & {
          user_id: string;
          project_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          project_id: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["user_pinned_projects"]["Insert"]>;
      };
      user_pinned_jobs: {
        Row: BaseRow & {
          user_id: string;
          job_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          job_id: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["user_pinned_jobs"]["Insert"]>;
      };
      pricing_policies: {
        Row: BaseRow & {
          organization_id: string | null;
          version: string;
          markup_percent: number;
          currency_minor_unit: number;
          is_active: boolean;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          version: string;
          markup_percent?: number;
          currency_minor_unit?: number;
          is_active?: boolean;
          notes?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["pricing_policies"]["Insert"]>;
      };
      jobs: {
        Row: BaseRow & {
          organization_id: string;
          project_id: string | null;
          selected_vendor_quote_offer_id: string | null;
          created_by: string;
          title: string;
          description: string | null;
          status: JobStatus;
          source: string;
          active_pricing_policy_id: string | null;
          tags: string[];
          requested_quote_quantities: number[];
          requested_by_date: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          project_id?: string | null;
          selected_vendor_quote_offer_id?: string | null;
          created_by: string;
          title: string;
          description?: string | null;
          status?: JobStatus;
          source?: string;
          active_pricing_policy_id?: string | null;
          tags?: string[];
          requested_quote_quantities?: number[];
          requested_by_date?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["jobs"]["Insert"]>;
      };
      job_files: {
        Row: BaseRow & {
          job_id: string;
          organization_id: string;
          uploaded_by: string;
          storage_bucket: string;
          storage_path: string;
          original_name: string;
          normalized_name: string;
          file_kind: JobFileKind;
          mime_type: string | null;
          size_bytes: number | null;
          matched_part_key: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          job_id: string;
          organization_id: string;
          uploaded_by: string;
          storage_bucket?: string;
          storage_path: string;
          original_name: string;
          normalized_name: string;
          file_kind: JobFileKind;
          mime_type?: string | null;
          size_bytes?: number | null;
          matched_part_key?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["job_files"]["Insert"]>;
      };
      parts: {
        Row: BaseRow & {
          job_id: string;
          organization_id: string;
          name: string;
          normalized_key: string;
          cad_file_id: string | null;
          drawing_file_id: string | null;
          quantity: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          job_id: string;
          organization_id: string;
          name: string;
          normalized_key: string;
          cad_file_id?: string | null;
          drawing_file_id?: string | null;
          quantity?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["parts"]["Insert"]>;
      };
      drawing_extractions: {
        Row: BaseRow & {
          part_id: string;
          organization_id: string;
          extractor_version: string;
          extraction: Json;
          confidence: number | null;
          warnings: Json;
          evidence: Json;
          status: ExtractionStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          part_id: string;
          organization_id: string;
          extractor_version?: string;
          extraction?: Json;
          confidence?: number | null;
          warnings?: Json;
          evidence?: Json;
          status?: ExtractionStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["drawing_extractions"]["Insert"]>;
      };
      drawing_preview_assets: {
        Row: BaseRow & {
          part_id: string;
          organization_id: string;
          page_number: number;
          kind: string;
          storage_bucket: string;
          storage_path: string;
          width: number | null;
          height: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          part_id: string;
          organization_id: string;
          page_number?: number;
          kind?: string;
          storage_bucket?: string;
          storage_path: string;
          width?: number | null;
          height?: number | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["drawing_preview_assets"]["Insert"]>;
      };
      approved_part_requirements: {
        Row: BaseRow & {
          part_id: string;
          organization_id: string;
          approved_by: string;
          description: string | null;
          part_number: string | null;
          revision: string | null;
          material: string;
          finish: string | null;
          tightest_tolerance_inch: number | null;
          quantity: number;
          quote_quantities: number[];
          requested_by_date: string | null;
          applicable_vendors: VendorName[];
          spec_snapshot: Json;
          approved_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          part_id: string;
          organization_id: string;
          approved_by: string;
          description?: string | null;
          part_number?: string | null;
          revision?: string | null;
          material: string;
          finish?: string | null;
          tightest_tolerance_inch?: number | null;
          quantity?: number;
          quote_quantities?: number[];
          requested_by_date?: string | null;
          applicable_vendors?: VendorName[];
          spec_snapshot?: Json;
          approved_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["approved_part_requirements"]["Insert"]>;
      };
      quote_runs: {
        Row: BaseRow & {
          job_id: string;
          organization_id: string;
          initiated_by: string;
          status: QuoteRunStatus;
          requested_auto_publish: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          job_id: string;
          organization_id: string;
          initiated_by: string;
          status?: QuoteRunStatus;
          requested_auto_publish?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["quote_runs"]["Insert"]>;
      };
      vendor_quote_results: {
        Row: BaseRow & {
          quote_run_id: string;
          part_id: string;
          organization_id: string;
          vendor: VendorName;
          requested_quantity: number;
          status: VendorStatus;
          unit_price_usd: number | null;
          total_price_usd: number | null;
          lead_time_business_days: number | null;
          quote_url: string | null;
          dfm_issues: Json;
          notes: Json;
          raw_payload: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          quote_run_id: string;
          part_id: string;
          organization_id: string;
          vendor: VendorName;
          requested_quantity?: number;
          status?: VendorStatus;
          unit_price_usd?: number | null;
          total_price_usd?: number | null;
          lead_time_business_days?: number | null;
          quote_url?: string | null;
          dfm_issues?: Json;
          notes?: Json;
          raw_payload?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["vendor_quote_results"]["Insert"]>;
      };
      vendor_quote_offers: {
        Row: BaseRow & {
          vendor_quote_result_id: string;
          organization_id: string;
          offer_key: string;
          supplier: string;
          lane_label: string;
          sourcing: string | null;
          tier: string | null;
          quote_ref: string | null;
          quote_date: string | null;
          unit_price_usd: number | null;
          total_price_usd: number | null;
          lead_time_business_days: number | null;
          ship_receive_by: string | null;
          due_date: string | null;
          process: string | null;
          material: string | null;
          finish: string | null;
          tightest_tolerance: string | null;
          tolerance_source: string | null;
          thread_callouts: string | null;
          thread_match_notes: string | null;
          notes: string | null;
          sort_rank: number;
          raw_payload: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          vendor_quote_result_id: string;
          organization_id: string;
          offer_key: string;
          supplier: string;
          lane_label: string;
          sourcing?: string | null;
          tier?: string | null;
          quote_ref?: string | null;
          quote_date?: string | null;
          unit_price_usd?: number | null;
          total_price_usd?: number | null;
          lead_time_business_days?: number | null;
          ship_receive_by?: string | null;
          due_date?: string | null;
          process?: string | null;
          material?: string | null;
          finish?: string | null;
          tightest_tolerance?: string | null;
          tolerance_source?: string | null;
          thread_callouts?: string | null;
          thread_match_notes?: string | null;
          notes?: string | null;
          sort_rank?: number;
          raw_payload?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["vendor_quote_offers"]["Insert"]>;
      };
      vendor_quote_artifacts: {
        Row: BaseRow & {
          vendor_quote_result_id: string;
          organization_id: string;
          artifact_type: string;
          storage_bucket: string;
          storage_path: string;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          vendor_quote_result_id: string;
          organization_id: string;
          artifact_type: string;
          storage_bucket?: string;
          storage_path: string;
          metadata?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["vendor_quote_artifacts"]["Insert"]>;
      };
      published_quote_packages: {
        Row: BaseRow & {
          job_id: string;
          quote_run_id: string;
          organization_id: string;
          published_by: string;
          pricing_policy_id: string;
          auto_published: boolean;
          client_summary: string | null;
          created_at: string;
          published_at: string;
        };
        Insert: {
          id?: string;
          job_id: string;
          quote_run_id: string;
          organization_id: string;
          published_by: string;
          pricing_policy_id: string;
          auto_published?: boolean;
          client_summary?: string | null;
          created_at?: string;
          published_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["published_quote_packages"]["Insert"]>;
      };
      published_quote_options: {
        Row: BaseRow & {
          package_id: string;
          organization_id: string;
          requested_quantity: number;
          option_kind: ClientOptionKind;
          label: string;
          published_price_usd: number;
          lead_time_business_days: number | null;
          comparison_summary: string | null;
          source_vendor_quote_id: string;
          source_vendor_quote_offer_id: string | null;
          markup_policy_version: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          package_id: string;
          organization_id: string;
          requested_quantity?: number;
          option_kind: ClientOptionKind;
          label: string;
          published_price_usd: number;
          lead_time_business_days?: number | null;
          comparison_summary?: string | null;
          source_vendor_quote_id: string;
          source_vendor_quote_offer_id?: string | null;
          markup_policy_version: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["published_quote_options"]["Insert"]>;
      };
      client_selections: {
        Row: BaseRow & {
          package_id: string;
          option_id: string;
          organization_id: string;
          selected_by: string;
          note: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          package_id: string;
          option_id: string;
          organization_id: string;
          selected_by: string;
          note?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["client_selections"]["Insert"]>;
      };
      audit_events: {
        Row: BaseRow & {
          organization_id: string;
          actor_user_id: string | null;
          job_id: string | null;
          package_id: string | null;
          event_type: string;
          payload: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          actor_user_id?: string | null;
          job_id?: string | null;
          package_id?: string | null;
          event_type: string;
          payload?: Json;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["audit_events"]["Insert"]>;
      };
      work_queue: {
        Row: BaseRow & {
          organization_id: string;
          job_id: string | null;
          part_id: string | null;
          quote_run_id: string | null;
          package_id: string | null;
          task_type: QueueTaskType;
          status: QueueTaskStatus;
          payload: Json;
          attempts: number;
          available_at: string;
          locked_at: string | null;
          locked_by: string | null;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          job_id?: string | null;
          part_id?: string | null;
          quote_run_id?: string | null;
          package_id?: string | null;
          task_type: QueueTaskType;
          status?: QueueTaskStatus;
          payload?: Json;
          attempts?: number;
          available_at?: string;
          locked_at?: string | null;
          locked_by?: string | null;
          last_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["work_queue"]["Insert"]>;
      };
    };
    Views: Record<string, never>;
    Functions: {
      api_list_organization_memberships: {
        Args: {
          p_organization_id: string;
        };
        Returns: Json;
      };
      api_update_organization_membership_role: {
        Args: {
          p_membership_id: string;
          p_role: AppRole;
        };
        Returns: string;
      };
      api_create_project: {
        Args: {
          p_name: string;
          p_description?: string | null;
        };
        Returns: string;
      };
      api_update_project: {
        Args: {
          p_project_id: string;
          p_name: string;
          p_description?: string | null;
        };
        Returns: string;
      };
      api_delete_project: {
        Args: {
          p_project_id: string;
        };
        Returns: string;
      };
      api_invite_project_member: {
        Args: {
          p_project_id: string;
          p_email: string;
          p_role?: ProjectRole | null;
        };
        Returns: Json;
      };
      api_accept_project_invite: {
        Args: {
          p_token: string;
        };
        Returns: string;
      };
      api_remove_project_member: {
        Args: {
          p_project_membership_id: string;
        };
        Returns: string;
      };
      api_create_self_service_organization: {
        Args: {
          p_organization_name: string;
        };
        Returns: string;
      };
      api_create_job: {
        Args: {
          p_organization_id: string;
          p_title: string;
          p_description?: string | null;
          p_source?: string | null;
          p_tags?: string[] | null;
          p_requested_quote_quantities?: number[] | null;
          p_requested_by_date?: string | null;
        };
        Returns: string;
      };
      api_create_client_draft: {
        Args: {
          p_title: string;
          p_description?: string | null;
          p_project_id?: string | null;
          p_tags?: string[] | null;
          p_requested_quote_quantities?: number[] | null;
          p_requested_by_date?: string | null;
        };
        Returns: string;
      };
      api_assign_job_to_project: {
        Args: {
          p_job_id: string;
          p_project_id: string;
        };
        Returns: string;
      };
      api_remove_job_from_project: {
        Args: {
          p_job_id: string;
          p_project_id: string;
        };
        Returns: string;
      };
      api_set_job_selected_vendor_quote_offer: {
        Args: {
          p_job_id: string;
          p_vendor_quote_offer_id: string;
        };
        Returns: string;
      };
      api_attach_job_file: {
        Args: {
          p_job_id: string;
          p_storage_bucket: string;
          p_storage_path: string;
          p_original_name: string;
          p_file_kind: JobFileKind;
          p_mime_type?: string | null;
          p_size_bytes?: number | null;
        };
        Returns: string;
      };
      api_reconcile_job_parts: {
        Args: {
          p_job_id: string;
        };
        Returns: Json;
      };
      api_request_extraction: {
        Args: {
          p_job_id: string;
        };
        Returns: number;
      };
      api_approve_job_requirements: {
        Args: {
          p_job_id: string;
          p_requirements: Json;
        };
        Returns: number;
      };
      api_start_quote_run: {
        Args: {
          p_job_id: string;
          p_auto_publish_requested?: boolean;
        };
        Returns: string;
      };
      api_get_quote_run_readiness: {
        Args: {
          p_quote_run_id: string;
        };
        Returns: Json;
      };
      api_publish_quote_package: {
        Args: {
          p_job_id: string;
          p_quote_run_id: string;
          p_client_summary?: string | null;
          p_force?: boolean;
        };
        Returns: string;
      };
      api_record_manual_vendor_quote: {
        Args: {
          p_job_id: string;
          p_part_id: string;
          p_vendor: VendorName;
          p_status?: VendorStatus;
          p_summary_note?: string | null;
          p_source_text?: string | null;
          p_quote_url?: string | null;
          p_offers?: Json;
          p_artifacts?: Json;
        };
        Returns: Json;
      };
      api_select_quote_option: {
        Args: {
          p_package_id: string;
          p_option_id: string;
          p_note?: string | null;
        };
        Returns: string;
      };
    };
    Enums: {
      app_role: AppRole;
      job_status: JobStatus;
      vendor_name: VendorName;
      vendor_status: VendorStatus;
      client_option_kind: ClientOptionKind;
      job_file_kind: JobFileKind;
      extraction_status: ExtractionStatus;
      quote_run_status: QuoteRunStatus;
      queue_task_type: QueueTaskType;
      queue_task_status: QueueTaskStatus;
    };
    CompositeTypes: Record<string, never>;
  };
};
