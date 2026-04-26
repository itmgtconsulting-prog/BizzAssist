/**
 * Domain Storage helpers — server-side only.
 *
 * BIZZ-700: Manages domain file uploads in Supabase Storage.
 * BIZZ-722 Lag 5: All objects are namespaced under {domain_id}/ as the first
 * path segment. Signed URLs are only generated after membership verification.
 *
 * Storage bucket: 'domain-files'
 *   - No anonymous read policy — all access via signed URLs
 *   - RLS: Only authenticated users with domain membership can upload
 *
 * @module app/lib/domainStorage
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { assertDomainMember, type DomainContext } from '@/app/lib/domainAuth';
import { resolveFileType, supportedLabels } from '@/app/lib/domainFileTypes';

/** Bucket name — matches Supabase Storage bucket configuration. */
const BUCKET = 'domain-files';

/** Signed URL expiry in seconds (15 minutes). */
const SIGNED_URL_EXPIRY = 900;

/** Maximum file size in bytes (50 MB). */
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Builds the storage path for a domain file.
 * Always prefixed with {domainId}/ to enforce namespace isolation.
 *
 * @param domainId - Domain UUID (already validated by assertDomainMember)
 * @param category - File category (templates, training, cases)
 * @param fileName - Original file name
 * @returns Namespaced storage path
 */
function buildStoragePath(
  domainId: string,
  category: 'templates' | 'training' | 'cases',
  fileName: string
): string {
  // Sanitise filename: remove path traversal and non-ASCII
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
  const ts = Date.now();
  return `${domainId}/${category}/${ts}_${safe}`;
}

/**
 * Uploads a file to domain storage after verifying membership.
 *
 * @param domainId - Domain UUID
 * @param category - File category
 * @param fileName - Original file name
 * @param fileBody - File content as Buffer or Blob
 * @param contentType - MIME type of the file
 * @returns Object with storage path and signed download URL
 * @throws Error if membership check fails, file too large, or invalid MIME type
 */
export async function uploadDomainFile(
  domainId: string,
  category: 'templates' | 'training' | 'cases',
  fileName: string,
  fileBody: Buffer | Blob,
  contentType: string
): Promise<{ path: string; signedUrl: string; ctx: DomainContext }> {
  // Membership check (throws Forbidden if not member)
  const ctx = await assertDomainMember(domainId);

  // BIZZ-788: Validate MIME/extension via shared resolver. Accepter alle
  // Claude-readable formater (docx/xlsx/pptx/pdf/txt/md/csv/json/.../.msg/.png).
  if (!resolveFileType(contentType, fileName)) {
    throw new Error(`Ugyldig filtype: ${contentType}. Tilladt: ${supportedLabels()}.`);
  }

  // Validate file size
  const size = fileBody instanceof Buffer ? fileBody.length : (fileBody as Blob).size;
  if (size > MAX_FILE_SIZE) {
    throw new Error(`Fil for stor: ${size} bytes (max ${MAX_FILE_SIZE})`);
  }

  const storagePath = buildStoragePath(domainId, category, fileName);
  const admin = createAdminClient();

  const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, fileBody, {
    contentType,
    upsert: false,
  });

  if (uploadError) {
    throw new Error(`Upload fejlede: ${uploadError.message}`);
  }

  // Generate signed URL for download
  const { data: signedData, error: signedError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY);

  if (signedError || !signedData?.signedUrl) {
    throw new Error('Kunne ikke generere download-URL');
  }

  return { path: storagePath, signedUrl: signedData.signedUrl, ctx };
}

/**
 * Generates a signed download URL for an existing domain file.
 * Verifies membership before generating the URL.
 *
 * @param domainId - Domain UUID
 * @param storagePath - Full storage path (must start with {domainId}/)
 * @returns Signed download URL
 * @throws Error if path doesn't match domain or membership check fails
 */
export async function getDomainFileUrl(domainId: string, storagePath: string): Promise<string> {
  // Membership check
  await assertDomainMember(domainId);

  // BIZZ-722 Lag 5: Verify path starts with the correct domain namespace
  if (!storagePath.startsWith(`${domainId}/`)) {
    throw new Error('Forbidden — path does not match domain namespace');
  }

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY);

  if (error || !data?.signedUrl) {
    throw new Error('Kunne ikke generere download-URL');
  }

  return data.signedUrl;
}

/**
 * Deletes a file from domain storage.
 * Requires domain admin role.
 *
 * @param domainId - Domain UUID
 * @param storagePath - Full storage path
 * @throws Error if path doesn't match domain or user is not admin
 */
export async function deleteDomainFile(domainId: string, storagePath: string): Promise<void> {
  // Path namespace check
  if (!storagePath.startsWith(`${domainId}/`)) {
    throw new Error('Forbidden — path does not match domain namespace');
  }

  const admin = createAdminClient();
  const { error } = await admin.storage.from(BUCKET).remove([storagePath]);

  if (error) {
    throw new Error(`Sletning fejlede: ${error.message}`);
  }
}
