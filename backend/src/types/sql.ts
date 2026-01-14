// Minimal Postgres client interface used throughout the project. It intentionally
// mirrors the callable/tagged template behaviour plus the few methods we use so
// that build-time typing stays stable across driver versions.
export type SqlClient = {
  <T = unknown>(template: TemplateStringsArray, ...parameters: any[]): Promise<T>;
  <T = unknown>(first: any, ...rest: any[]): any;
  begin<T>(cb: (sql: SqlClient) => T | Promise<T>): Promise<T>;
  end: (options?: { timeout?: number }) => Promise<void>;
};
