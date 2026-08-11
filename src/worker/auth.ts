import type { AccessIdentity } from "@/shared/contracts";
import { createRemoteJWKSet, jwtVerify } from "jose";

interface AccessClaims {
  email?: unknown;
  sub?: unknown;
}

export async function authenticate(request: Request, env: Env): Promise<AccessIdentity> {
  const url = new URL(request.url);
  // Cloudflare 边缘无法收到以回环地址为 Host 的公网请求，因此该分支只服务本地开发与测试。
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return { email: "local-development@localhost", subject: "local-development" };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new AuthError("缺少 Cloudflare Access 身份凭据", 401);
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  try {
    const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: teamDomain,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    });
    const claims = payload as AccessClaims;
    if (typeof claims.email !== "string" || typeof claims.sub !== "string") {
      throw new Error("Access JWT 缺少 email 或 sub");
    }
    return { email: claims.email, subject: claims.sub };
  } catch {
    throw new AuthError("Cloudflare Access 身份凭据无效或已过期", 401);
  }
}

export function assertSameOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  if (!origin || origin !== expected) throw new AuthError("状态修改请求的 Origin 不匹配", 403);
}

export class AuthError extends Error {
  constructor(message: string, readonly status: 401 | 403) {
    super(message);
  }
}

function normalizeTeamDomain(value: string): string {
  return `https://${value.replace(/^https?:\/\//u, "").replace(/\/$/u, "")}`;
}
