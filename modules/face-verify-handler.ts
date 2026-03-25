import { ZuploContext, ZuploRequest, environment } from "@zuplo/runtime";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const FACE_API_URL = "https://faceapi.mxface.ai/api/v3/face/verify";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────
interface FaceVerifyRequest {
  encoded_image1: string;
  encoded_image2: string;
}

interface FaceVerifyResponse {
  score?: number;
  matched?: boolean;
  error?: string;
  [key: string]: unknown;
}

interface ErrorPayload {
  error: string;
  code: string;
  details?: unknown;
}

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────
class FaceApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly details: unknown
  ) {
    super("Face API request failed");
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function getApiKey(): string {
  const key = environment.FACE_API_KEY;

  if (!key) {
    throw new Error("Missing FACE_API_KEY in environment");
  }

  return key;
}

function validateBody(body: unknown): asserts body is FaceVerifyRequest {
  if (
    !body ||
    typeof body !== "object" ||
    !(body as FaceVerifyRequest).encoded_image1 ||
    !(body as FaceVerifyRequest).encoded_image2
  ) {
    throw new Error(
      "Invalid request. 'encoded_image1' and 'encoded_image2' are required."
    );
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: unknown
): Response {
  return jsonResponse(
    {
      error: message,
      code,
      ...(details && { details }),
    },
    status
  );
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────
export async function faceverify(
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  // ── API Key ────────────────────────────────
  let apiKey: string;
  try {
    apiKey = getApiKey();
  } catch (err: unknown) {
    context.log.error("Configuration error", {
      error: (err as Error).message,
    });
    return errorResponse("CONFIG_ERROR", "Service misconfigured", 500);
  }

  // ── Parse Body ─────────────────────────────
  let body: FaceVerifyRequest;
  try {
    body = await request.json();
    validateBody(body);
  } catch (err: unknown) {
    return errorResponse(
      "INVALID_REQUEST",
      (err as Error).message,
      400
    );
  }

  context.log.info("Face verification request received");

  // ── Call External API ──────────────────────
  let apiResponse: Response;

  try {
    apiResponse = await fetch(FACE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Subscriptionkey: apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    context.log.error("Network error", {
      error: (err as Error).message,
    });
    return errorResponse("NETWORK_ERROR", "Failed to reach Face API", 502);
  }

  // ── Handle Response ────────────────────────
  let data: FaceVerifyResponse | null = null;

  try {
    data = await apiResponse.json();
  } catch {
    // ignore parsing error
  }

  if (!apiResponse.ok) {
    context.log.error("Face API error", {
      status: apiResponse.status,
      response: data,
    });

    throw new FaceApiError(apiResponse.status, data);
  }

  // ── Success ────────────────────────────────
  return jsonResponse(data, 200);
}