// modules/mathpix-image.ts
import { ZuploContext, ZuploRequest, environment } from "@zuplo/runtime";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const MATHPIX_API_BASE = "https://api.mathpix.com/v3";

const FILE_CONFIG = {
  MAX_SIZE_BYTES: 10 * 1024 * 1024, // 10 MB
  ALLOWED_MIME_TYPES: [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
  ],
} as const;

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
interface MathpixCredentials {
  appId: string;
  appKey: string;
}

interface MathpixTextResponse {
  request_id?: string;
  version?: string;
  is_printed?: boolean;
  is_handwritten?: boolean;
  auto_rotate_confidence?: number;
  auto_rotate_degrees?: number;
  image_height?: number;
  image_width?: number;
  confidence?: number;
  confidence_rate?: number;
  text?: string;
  error?: string;
  error_info?: unknown;
}

interface SuccessPayload {
  request_id: string;
  text: string;
  is_handwritten: boolean;
  is_printed: boolean;
  confidence: number;
  confidence_rate: number;
  image_width: number;
  image_height: number;
}

interface ErrorPayload {
  error: string;
  code: string;
  details?: unknown;
}

// ─────────────────────────────────────────────
// Custom error classes
// ─────────────────────────────────────────────
class MathpixOcrError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly details: unknown
  ) {
    super("Mathpix OCR request failed");
    this.name = "MathpixOcrError";
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
function mathpixHeaders(
  credentials: MathpixCredentials
): Record<string, string> {
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
    throw new FileValidationError(
      "No file provided — include a 'file' field in the multipart body."
    );
  }

  if (!FILE_CONFIG.ALLOWED_MIME_TYPES.includes(file.type as never)) {
    throw new FileValidationError(
      `Unsupported file type '${file.type}'. Accepted types: ${FILE_CONFIG.ALLOWED_MIME_TYPES.join(", ")}.`
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
 * Sends the image to the Mathpix /v3/text endpoint and returns the parsed
 * response. This call is synchronous — no polling required.
 */
async function runOcr(
  file: File,
  credentials: MathpixCredentials
): Promise<MathpixTextResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append(
    "options_json",
    JSON.stringify({
      math_inline_delimiters: ["$", "$"],
      math_display_delimiters: ["$$", "$$"],
      rm_spaces: true,
      include_detected_alphabets: true,
    })
  );

  const response = await fetch(`${MATHPIX_API_BASE}/text`, {
    method: "POST",
    headers: mathpixHeaders(credentials),
    body: form,
  });

  if (!response.ok) {
    const details = await response.json().catch(() => null);
    throw new MathpixOcrError(response.status, details);
  }

  return response.json() as Promise<MathpixTextResponse>;
}

// ─────────────────────────────────────────────
// Response factories
// ─────────────────────────────────────────────
function jsonResponse(
  body: SuccessPayload | ErrorPayload,
  status: number
): Response {
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
 * POST /ocr-image
 *
 * Accepts a multipart/form-data body with a single `file` field (image only).
 * Sends it to the Mathpix /v3/text endpoint and returns the OCR result,
 * including extracted text, confidence scores, and image metadata.
 *
 * Supported formats: JPEG, PNG, GIF, WEBP, BMP, TIFF (max 10 MB).
 */
export async function imageocr(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  // ── Credentials ──────────────────────────────
  let credentials: MathpixCredentials;
  try {
    credentials = getCredentials();
  } catch (err: unknown) {
    context.log.error("Credential configuration error", {
      error: (err as Error).message,
    });
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
    context.log.error("Failed to parse form data", {
      error: (err as Error).message,
    });
    return errorResponse("BAD_REQUEST", "Could not parse multipart form data.", 400);
  }

  context.log.info("Image OCR started", {
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
  });

  // ── OCR ──────────────────────────────────────
  let result: MathpixTextResponse;
  try {
    result = await runOcr(file, credentials);
    context.log.info("Image OCR completed", { requestId: result.request_id });
  } catch (err: unknown) {
    if (err instanceof MathpixOcrError) {
      context.log.error("Mathpix OCR failed", {
        statusCode: err.statusCode,
        details: err.details,
      });
      return errorResponse(
        "OCR_FAILED",
        "Failed to process image with OCR service.",
        err.statusCode,
        { details: err.details }
      );
    }
    context.log.error("Unexpected OCR error", { error: (err as Error).message });
    return errorResponse(
      "OCR_FAILED",
      "An unexpected error occurred during OCR.",
      500
    );
  }

  // ── Check for Mathpix-level error in 200 body ─
  // Mathpix can return HTTP 200 with an `error` field for soft failures.
  if (result.error) {
    context.log.warn("Mathpix returned an error in response body", {
      error: result.error,
      errorInfo: result.error_info,
    });
    return errorResponse("OCR_FAILED", result.error, 422, {
      details: result.error_info,
    });
  }

  // ── Success ──────────────────────────────────
  return jsonResponse(
    {
      request_id: result.request_id ?? "",
      text: result.text ?? "",
      is_handwritten: result.is_handwritten ?? false,
      is_printed: result.is_printed ?? false,
      confidence: result.confidence ?? 0,
      confidence_rate: result.confidence_rate ?? 0,
      image_width: result.image_width ?? 0,
      image_height: result.image_height ?? 0,
    },
    200
  );
}