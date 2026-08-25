import { SignJWT, jwtVerify } from "jose";

export interface SessionClaims {
  jti: string;
  sub: string; // eth address
  chainId: number;
}

export async function signSessionToken(
  claims: SessionClaims,
  secret: string,
  expiresAtSeconds: number,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ chainId: claims.chainId })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(claims.jti)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAtSeconds)
    .sign(key);
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionClaims> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key);
  if (!payload.jti || !payload.sub || typeof payload.chainId !== "number") {
    throw new Error("Malformed session token");
  }
  return { jti: payload.jti, sub: payload.sub, chainId: payload.chainId };
}
