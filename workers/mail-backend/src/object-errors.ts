// Distinguishes a stored object that is verifiably gone (S3 NoSuchKey) or
// invalid (declared empty or over the cap) from a transport or service failure.
export class ObjectMissingError extends Error {}
export class ObjectInvalidError extends Error {}
