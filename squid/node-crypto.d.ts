// Minimal `node:crypto` types for signV2's MD5 + HMAC-SHA1. We avoid `@types/node` here
// because its globals conflict with the Workers types (e.g. clearTimeout's signature).
// nodejs_compat provides the real module at runtime; this only types the bits we use.
declare module "node:crypto" {
  interface V2Hasher {
    update(data: string): V2Hasher
    digest(encoding: "hex" | "base64"): string
  }
  export function createHash(algorithm: string): V2Hasher
  export function createHmac(algorithm: string, key: string): V2Hasher
}
