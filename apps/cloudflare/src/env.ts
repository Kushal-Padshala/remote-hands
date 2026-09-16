export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<{ success: boolean; results?: T[]; error?: string }>;
  all<T = unknown>(): Promise<{ success: boolean; results: T[] }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<Array<{ success: boolean; results: T[] }>>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
  name?: string;
}

export interface DurableObjectStub {
  fetch(request: Request | string, requestInit?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  idFromString(id: string): DurableObjectId;
  newUniqueId(): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface R2Bucket {
  get(key: string): Promise<unknown | null>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface Env {
  DB: D1Database;
  TASK_ROOM: DurableObjectNamespace;
  ARTIFACTS?: R2Bucket;
  OWNER_SECRET_HASH: string;
}
