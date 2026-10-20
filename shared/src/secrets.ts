/**
 * Credentials from files, with the environment variable as the fallback.
 *
 * An environment variable is the easiest place to put a connection string and
 * the worst place to keep one: it is copied into every child process, shows up
 * in `/proc/<pid>/environ`, `docker inspect` and `kubectl describe`, and is the
 * first thing a crash reporter or a debug dump serialises. A file mounted from a
 * secret store has none of those exits.
 *
 * So every secret-bearing variable `NAME` also accepts `NAME_FILE`: a path whose
 * contents are the value. That is the convention the official Postgres image
 * uses for `POSTGRES_PASSWORD_FILE`, and it is the shape every secret delivery
 * mechanism already produces — Docker/Compose secrets (`/run/secrets/*`), a
 * Kubernetes Secret volume, the Secrets Store CSI driver (AWS Secrets Manager,
 * GCP Secret Manager, Azure Key Vault, Vault) and the Vault Agent injector all
 * write files. Supporting files rather than one vendor SDK is what lets any of
 * them work without this package depending on any of them.
 *
 * Setting both `NAME` and `NAME_FILE` is an error rather than a precedence rule:
 * a deployment that sets both has two answers to one question, and silently
 * picking one is how a rotated credential keeps being ignored.
 *
 * See docs/SECRETS.md.
 */
import { readFileSync } from 'fs';

type Env = Record<string, string | undefined>;

export class SecretConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretConfigError';
  }
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/**
 * Reads a file-delivered secret. Only trailing line breaks are removed: `echo`
 * and most editors add one, and a newline is never part of a real credential,
 * but leading or inner whitespace could be.
 */
function readSecretFile(variable: string, path: string): string {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SecretConfigError(`${variable} points at ${path}, which cannot be read: ${reason}`);
  }
  const value = contents.replace(/[\r\n]+$/, '');
  if (value === '') {
    throw new SecretConfigError(`${variable} points at ${path}, which is empty`);
  }
  return value;
}

/**
 * The value of `name`, read from the file named by `${name}_FILE` when that is
 * set, otherwise from `name` itself. Undefined when neither is set.
 */
export function readSecret(name: string, env: Env = process.env): string | undefined {
  const fileVariable = `${name}_FILE`;
  const direct = env[name];
  const path = env[fileVariable];
  if (isSet(direct) && isSet(path)) {
    throw new SecretConfigError(`${name} and ${fileVariable} are both set; set only one`);
  }
  if (isSet(path)) return readSecretFile(fileVariable, path);
  return isSet(direct) ? direct : undefined;
}

/**
 * Resolves a Postgres connection string from up to three sources:
 *
 * - `DATABASE_URL_FILE` — a file holding the whole URL, or
 * - `DATABASE_URL` — the URL itself (the original, still-supported form), plus
 * - `DATABASE_PASSWORD_FILE` — a file holding only the password, which replaces
 *   any password in the URL.
 *
 * The last one lets the URL — host, port, database, user — live in ordinary
 * configuration where it can be reviewed and diffed, with only the password
 * coming from the secret store. It is the form a secret manager that rotates
 * passwords (and only passwords) produces.
 *
 * `name` selects the family, so `READ_DATABASE_URL` reads
 * `READ_DATABASE_URL_FILE` and `READ_DATABASE_PASSWORD_FILE`. Returns
 * undefined when no URL is configured, so each caller keeps its own default.
 */
export function resolveDatabaseUrl(name = 'DATABASE_URL', env: Env = process.env): string | undefined {
  const url = readSecret(name, env);
  const passwordVariable = `${name.replace(/_URL$/, '')}_PASSWORD_FILE`;
  const passwordPath = env[passwordVariable];
  if (!isSet(passwordPath)) return url;
  if (url === undefined) {
    throw new SecretConfigError(`${passwordVariable} is set but neither ${name} nor ${name}_FILE is`);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SecretConfigError(`${passwordVariable} is set but ${name} is not a postgresql:// URL`);
  }
  // Encoded here because the URL setter alone leaves `@`, `#` and `%` as they
  // are for a non-special scheme like postgresql://, and pg then splits the
  // URL in the wrong place. The setter does not re-encode `%`, so this is not
  // double-encoded, and pg decodes it back to the exact file contents.
  parsed.password = encodeURIComponent(readSecretFile(passwordVariable, passwordPath));
  return parsed.toString();
}
