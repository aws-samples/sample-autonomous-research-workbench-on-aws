/**
 * SigV4 auth token manager for connecting neo4j-driver to Amazon Neptune
 * over Bolt+SSC (IAM-authenticated).
 *
 * SigV4 signatures are only valid for ~5 minutes, and Neptune reports an
 * expired one as a GENERIC server exception (BoltProtocol.unexpectedException),
 * not a security error — so the driver's `basic` token manager (which only
 * re-signs on security errors) never refreshes, and once the first token ages
 * out every new connection fails. Use the expiration-based `bearer` manager
 * instead: it proactively re-invokes the provider before the declared TTL.
 */
import { createHash, createHmac } from "node:crypto";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import neo4j, { type AuthTokenManager } from "neo4j-driver";

const SERVICE = "neptune-db";
const METHOD = "GET";
const CANONICAL_URI = "/opencypher";

// Re-sign well inside Neptune's ~5-minute signature validity window.
const TOKEN_TTL_MS = 240_000;

export function buildNeptuneAuthManager(
  endpoint: string,
  port: number,
  region: string,
): AuthTokenManager {
  const credentialProvider = fromNodeProviderChain();

  return neo4j.authTokenManagers.bearer({
    tokenProvider: async () => {
      const credentials = await credentialProvider();
      const token = neo4j.auth.basic(
        "username",
        signRequest(
          endpoint,
          port,
          region,
          credentials.accessKeyId,
          credentials.secretAccessKey,
          credentials.sessionToken,
          new Date(),
        ),
      );
      return {
        token,
        expiration: new Date(Date.now() + TOKEN_TTL_MS),
      } as Awaited<
        ReturnType<
          Parameters<typeof neo4j.authTokenManagers.bearer>[0]["tokenProvider"]
        >
      >;
    },
  });
}

function signRequest(
  host: string,
  port: number,
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken: string | undefined,
  now: Date,
): string {
  const dateStamp = formatDate(now);
  const amzDate = formatAmzDate(now);
  const hostHeader = `${host}:${port}`;

  const headers: Record<string, string> = {
    host: hostHeader,
    "x-amz-date": amzDate,
  };
  if (sessionToken) {
    headers["x-amz-security-token"] = sessionToken;
  }

  const signedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalHeaders = signedHeaderKeys
    .map((k) => `${k}:${headers[k]}\n`)
    .join("");

  const payloadHash = sha256("");

  const canonicalRequest = [
    METHOD,
    CANONICAL_URI,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, SERVICE);
  const signature = hmacHex(signingKey, stringToSign);

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const payload = {
    Authorization: authorization,
    HttpMethod: METHOD,
    Host: hostHeader,
    "X-Amz-Date": amzDate,
    ...(sessionToken ? { "X-Amz-Security-Token": sessionToken } : {}),
  };

  return JSON.stringify(payload);
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hmacHex(key: Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

function getSignatureKey(
  key: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${key}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}
