/** Only workspace reads are synthetic. Quote access, dispatch APIs and parsers stay real. */
export * from "../../src/features/quotes/api/workspace-access";
import { detail, ID } from "./data";
export const fetchAccessibleJobs = async () => [structuredClone(detail.job)];
export const fetchAccessibleProjects = async () => [];
export const fetchArchivedJobs = async () => [];
export const fetchArchivedProjects = async () => [];
export const fetchJobPartSummariesByJobIds = async () => [structuredClone(detail.summary)];
export const fetchProjectJobMembershipsByJobIds = async () => [];
export const fetchSidebarPins = async () => ({ projectIds: [], jobIds: [] });
export const fetchClientActivityEventsByJobIds = async () => [];
export const fetchVendorCapabilityProfiles = async () => [];
export const fetchPartDetailByJobId = async () => structuredClone(detail);
export const resolveClientPartDetailRoute = async () => ({ routeId: ID.job, jobId: ID.job, source: "job" });
