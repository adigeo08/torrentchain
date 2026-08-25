import { sha256Hex } from "./crypto";

/** A "user" for quota/anti-abuse purposes is a (wallet address, User-Agent) pair. */
export async function computeIdentity(address: string, userAgent: string): Promise<string> {
  return sha256Hex(`${address.toLowerCase()}|${userAgent}`);
}
