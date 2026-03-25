// modules/mathpix-pdf.ts
import { ZuploContext, ZuploRequest, environment } from "@zuplo/runtime";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const MATHPIX_API_BASE = "https://api.mathpix.com/v3";

const POLL_CONFIG = {
  MAX_RETRIES: 30,
  BASE_DELAY_MS: 2_000,
  MAX_DELAY_MS: 15_000,
  BACKOFF_MULTIPLIER: 1.5,
} as const;

const FILE_CONFIG = {
  MAX_SIZE_BYTES: 50 * 1024 * 1024, // 50 MB
  ALLOWED_MIME_TYPES: ["application/pdf"],
} as const;

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
interface MathpixCredentials {
  appId: string;
  appKey: string;
}

interface MathpixUploadResponse {
  pdf_id?: string;
  error?: string;
}

interface MathpixStatusResponse {
  status?: "loaded" | "split" | "completed" | "error";
  error?: string;
}

interface SuccessPayload {
  pdf_id: string;
  lines: unknown;
}

interface ErrorPayload {
  error: string;
  code: string;
  pdf_id?: string;
  details?: unknown;
}

// ─────────────────────────────────────────────
// Custom error classes
// ─────────────────────────────────────────────
class MathpixUploadError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly details: unknown
  ) {
    super("Mathpix upload failed");
    this.name = "MathpixUploadError";
  }
}

class MathpixProcessingError extends Error {
  constructor(public readonly details: unknown) {
    super("Mathpix processing failed");
    this.name = "MathpixProcessingError";
  }
}

class MathpixPollTimeoutError extends Error {
  constructor(public readonly pdfId: string) {
    super(`Timed out waiting for Mathpix to process PDF: ${pdfId}`);
    this.name = "MathpixPollTimeoutError";
  }
}

class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileValidationError";
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Resolves Mathpix credentials from environment variables.
 * Throws early if secrets are missing so misconfiguration is caught at startup.
 */
function getCredentials(): MathpixCredentials {
  const appId = environment.MATHPIX_APP_ID;
  const appKey = environment.MATHPIX_APP_KEY;

  if (!appId || !appKey) {
    throw new Error(
      "Missing required environment variables: MATHPIX_APP_ID, MATHPIX_APP_KEY"
    );
  }

  return { appId, appKey };
}

/** Returns the common Mathpix auth headers. */
function mathpixHeaders(credentials: MathpixCredentials): Record<string, string> {
  return {
    app_id: credentials.appId,
    app_key: credentials.appKey,
  };
}

/**
 * Validates the uploaded file for presence, MIME type, and size.
 * Throws `FileValidationError` on any violation.
 */
function validateFile(file: FormDataEntryValue | null): asserts file is File {
  if (!file || typeof file === "string") {
    throw new FileValidationError("No file provided — include a 'file' field in the multipart body.");
  }

  if (!FILE_CONFIG.ALLOWED_MIME_TYPES.includes(file.type as string)) {
    throw new FileValidationError(
      `Unsupported file type '${file.type}'. Only PDF files are accepted.`
    );
  }

  if (file.size > FILE_CONFIG.MAX_SIZE_BYTES) {
    const limitMb = FILE_CONFIG.MAX_SIZE_BYTES / (1024 * 1024);
    throw new FileValidationError(
      `File size ${(file.size / (1024 * 1024)).toFixed(1)} MB exceeds the ${limitMb} MB limit.`
    );
  }
}

/**
 * Computes exponential backoff delay (capped at MAX_DELAY_MS).
 */
function backoffDelay(attempt: number): number {
  return Math.min(
    POLL_CONFIG.BASE_DELAY_MS * Math.pow(POLL_CONFIG.BACKOFF_MULTIPLIER, attempt),
    POLL_CONFIG.MAX_DELAY_MS
  );
}

/**
 * Polls the Mathpix PDF status endpoint until processing completes.
 * Uses exponential backoff between attempts.
 */
async function pollUntilReady(
  pdfId: string,
  credentials: MathpixCredentials,
  context: ZuploContext
): Promise<void> {
  for (let attempt = 0; attempt < POLL_CONFIG.MAX_RETRIES; attempt++) {
    const response = await fetch(`${MATHPIX_API_BASE}/pdf/${pdfId}`, {
      method: "GET",
      headers: mathpixHeaders(credentials),
    });

    if (!response.ok) {
      context.log.warn("Mathpix status check returned non-OK", {
        pdfId,
        attempt,
        httpStatus: response.status,
      });
    } else {
      const status = (await response.json()) as MathpixStatusResponse;

      context.log.debug("Mathpix poll status", { pdfId, attempt, status: status.status });

      if (status.status === "completed") return;

      if (status.status === "error") {
        throw new MathpixProcessingError(status);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)));
  }

  throw new MathpixPollTimeoutError(pdfId);
}

/**
 * Uploads a PDF file to Mathpix and returns the assigned `pdf_id`.
 */
async function uploadToMathpix(
  file: File,
  credentials: MathpixCredentials
): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append(
    "options_json",
    JSON.stringify({
      conversion_formats: {
        docx: true,
        "tex.zip": true,
      },
    })
  );

  const response = await fetch(`${MATHPIX_API_BASE}/pdf`, {
    method: "POST",
    headers: mathpixHeaders(credentials),
    body: form,
  });

  if (!response.ok) {
    const details = await response.json().catch(() => null);
    throw new MathpixUploadError(response.status, details);
  }

  const { pdf_id } = (await response.json()) as MathpixUploadResponse;

  if (!pdf_id) {
    throw new MathpixUploadError(500, { message: "No pdf_id in Mathpix response" });
  }

  return pdf_id;
}

/**
 * Fetches the processed line-by-line JSON result for a given `pdf_id`.
 */
async function fetchLines(
  pdfId: string,
  credentials: MathpixCredentials
): Promise<unknown> {
  const response = await fetch(`${MATHPIX_API_BASE}/pdf/${pdfId}.lines.json`, {
    method: "GET",
    headers: mathpixHeaders(credentials),
  });

  if (!response.ok) {
    const details = await response.json().catch(() => null);
    throw new MathpixUploadError(response.status, details);
  }

  return response.json();
}

// ─────────────────────────────────────────────
// Response factories
// ─────────────────────────────────────────────
function jsonResponse(body: SuccessPayload | ErrorPayload, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  extras?: Partial<ErrorPayload>
): Response {
  return jsonResponse({ error: message, code, ...extras }, status);
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

/**
 * POST /convert-pdf
 *
 * Accepts a multipart/form-data body with a single `file` field (PDF only).
 * Uploads it to Mathpix, waits for processing, and returns the structured
 * lines.json result alongside the assigned `pdf_id`.
 */
export async function documentocr(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  // ── Credentials ──────────────────────────────
  let credentials: MathpixCredentials;
  try {
    credentials = getCredentials();
  } catch (err: unknown) {
    context.log.error("Credential configuration error", { error: (err as Error).message });
    return errorResponse("CONFIGURATION_ERROR", "Service is misconfigured.", 500);
  }

  // ── Parse & validate file ────────────────────
  let file: File;
  try {
    const formData = await request.formData();
    const entry = formData.get("file");
    validateFile(entry);
    file = entry;
  } catch (err: unknown) {
    if (err instanceof FileValidationError) {
      return errorResponse("INVALID_FILE", err.message, 400);
    }
    context.log.error("Failed to parse form data", { error: (err as Error).message });
    return errorResponse("BAD_REQUEST", "Could not parse multipart form data.", 400);
  }

  context.log.info("PDF upload started", { fileName: file.name, fileSize: file.size });

  // ── Upload ───────────────────────────────────
  let pdfId: string;
  try {
    pdfId = await uploadToMathpix(file, credentials);
    context.log.info("PDF uploaded to Mathpix", { pdfId });
  } catch (err: unknown) {
    if (err instanceof MathpixUploadError) {
      context.log.error("Mathpix upload failed", { statusCode: err.statusCode, details: err.details });
      return errorResponse("UPLOAD_FAILED", "Failed to upload PDF to processing service.", err.statusCode, {
        details: err.details,
      });
    }
    context.log.error("Unexpected upload error", { error: (err as Error).message });
    return errorResponse("UPLOAD_FAILED", "An unexpected error occurred during upload.", 500);
  }

  // ── Poll ─────────────────────────────────────
  try {
    await pollUntilReady(pdfId, credentials, context);
    context.log.info("PDF processing completed", { pdfId });
  } catch (err: unknown) {
    if (err instanceof MathpixPollTimeoutError) {
      context.log.error("Mathpix poll timed out", { pdfId });
      return errorResponse("PROCESSING_TIMEOUT", "PDF processing timed out.", 504, { pdf_id: pdfId });
    }
    if (err instanceof MathpixProcessingError) {
      context.log.error("Mathpix processing error", { pdfId, details: err.details });
      return errorResponse("PROCESSING_FAILED", "PDF processing failed.", 422, {
        pdf_id: pdfId,
        details: err.details,
      });
    }
    context.log.error("Unexpected polling error", { pdfId, error: (err as Error).message });
    return errorResponse("PROCESSING_FAILED", "An unexpected error occurred during processing.", 500, { pdf_id: pdfId });
  }

  // ── Fetch lines ──────────────────────────────
  let lines: unknown;
  try {
    lines = await fetchLines(pdfId, credentials);
    context.log.info("Lines JSON fetched", { pdfId });
  } catch (err: unknown) {
    if (err instanceof MathpixUploadError) {
      context.log.error("Failed to fetch lines", { pdfId, statusCode: err.statusCode, details: err.details });
      return errorResponse("FETCH_FAILED", "Failed to retrieve processing results.", err.statusCode, {
        pdf_id: pdfId,
        details: err.details,
      });
    }
    context.log.error("Unexpected fetch error", { pdfId, error: (err as Error).message });
    return errorResponse("FETCH_FAILED", "An unexpected error occurred while fetching results.", 500, { pdf_id: pdfId });
  }

  // ── Success ──────────────────────────────────
  return jsonResponse({ pdf_id: pdfId, lines }, 200);
}