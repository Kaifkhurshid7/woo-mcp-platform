/** Small HTTP helpers shared by the REST route modules. */

/** An error that maps directly to an HTTP status and a user-facing message. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 400 Bad Request. */
export const bad = (msg) => new HttpError(400, msg);

/** Wrap an async route handler so rejections reach the Express error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Turn a display name into a server slug: lowercase letters, digits and dashes, at most 24 chars. */
export const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
