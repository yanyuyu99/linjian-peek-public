import crypto from "crypto";

export function validateBearerAuthorization(headerValue, expectedToken) {
  const expected = String(expectedToken || "").trim();
  if (!expected) return true;

  const header = String(headerValue || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;

  const supplied = match[1].trim();
  const expectedBuf = Buffer.from(expected, "utf8");
  const suppliedBuf = Buffer.from(supplied, "utf8");
  if (expectedBuf.length !== suppliedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, suppliedBuf);
}

export function createBearerAuthMiddleware(expectedToken) {
  const expected = String(expectedToken || "").trim();

  return (req, res, next) => {
    if (!expected) return next();

    if (!validateBearerAuthorization(req.headers?.authorization, expected)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="linjian-mcp"');
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    return next();
  };
}
