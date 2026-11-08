export class DomainError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
export function invalid(message: string): never { throw new DomainError(400, message); }
export function conflict(message: string): never { throw new DomainError(409, message); }
export function missing(entity: string): never { throw new DomainError(404, `${entity} not found`); }
