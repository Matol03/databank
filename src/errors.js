import { ObjectId } from 'mongodb';

export class AppError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function toObjectId(value, label = 'id') {
  if (typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value)) return new ObjectId(value);
  throw new AppError(400, `Invalid ${label}`, 'InvalidId');
}
