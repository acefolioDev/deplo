export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const object = (x: unknown): Record<string, unknown> => {
  if (!x || typeof x !== "object" || Array.isArray(x))
    throw new HttpError(400, "Expected an object");
  return x as Record<string, unknown>;
};
export function str(x: unknown, label: string, max = 255) {
  if (typeof x !== "string" || x.trim().length === 0 || x.length > max)
    throw new HttpError(400, `Invalid ${label}`);
  return x.trim();
}
export function optional(x: unknown, label: string, max = 255) {
  return x == null || x === "" ? null : str(x, label, max);
}
export function uuid(x: unknown) {
  if (
    typeof x !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
  )
    throw new HttpError(400, "Invalid id");
  return x;
}
export function imageRef(x: unknown) {
  const value = str(x, "image reference", 512);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/.test(value) || value.includes(".."))
    throw new HttpError(400, "Invalid image reference");
  return value;
}
export function hostname(x: unknown) {
  const value = str(x, "hostname", 253).toLowerCase();
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      value,
    )
  )
    throw new HttpError(400, "Invalid hostname");
  return value;
}
