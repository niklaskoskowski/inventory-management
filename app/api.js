/**
 * API client.
 *
 * Every request goes through here so the CSRF token, the JSON content type
 * and the error envelope are handled in exactly one place.
 */

const ENDPOINT = 'api.php';

/**
 * The per-session CSRF token, off the meta tag admin.php renders.
 *
 * Exported because the sign-out form in AppShell posts it too: logout.php
 * refuses a request without it, and reading the tag twice would be two places
 * to change if the tag is ever renamed.
 */
export const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';

/** An error carrying the server's machine-readable code and details. */
export class ApiError extends Error {
  constructor(code, message, details, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details || null;
    this.status = status;
  }

  /** The client's revision was stale — someone else wrote first. */
  get isStale() {
    return this.code === 'STALE';
  }

  /** Specific items were unavailable; details.blocked says which. */
  get isBlocked() {
    return this.code === 'CONFLICT';
  }

  /**
   * The browser is already leaving for login.php or install.php.
   *
   * The rejection still happens — an awaiting caller has to stop — but nothing
   * should explain it to the operator: the page they would read the message on
   * is being replaced.
   */
  get isRedirecting() {
    return this.code === 'UNAUTHENTICATED' || this.code === 'INSTALL_REQUIRED';
  }
}

/**
 * The gate answers outside the normal envelope.
 *
 * trax_require_login() refuses before api.php has defined its error helpers, so
 * it emits a flat {"ok":false,"code":"unauthenticated"} rather than the nested
 * {"error":{...}} every other failure uses. Both shapes are read here.
 *
 * Returns the ApiError code to reject with, or '' when this is an ordinary
 * error that the caller should handle itself.
 */
function redirectFor(response, body) {
  const code = body.code || body.error?.code || '';

  if (response.status === 401 || code === 'unauthenticated') {
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `login.php?next=${next}`;
    return 'UNAUTHENTICATED';
  }

  if (response.status === 503 && code === 'install-required') {
    location.href = 'install.php';
    return 'INSTALL_REQUIRED';
  }

  return '';
}

async function unwrap(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      'SERVER',
      `The server returned an unreadable response (HTTP ${response.status}).`,
      null,
      response.status,
    );
  }

  if (!response.ok || body.ok === false) {
    // A dead session and a missing install are not errors this app can show:
    // both are answered by going somewhere else, which redirectFor() has
    // already started.
    const redirect = redirectFor(response, body);
    if (redirect === 'UNAUTHENTICATED') {
      throw new ApiError(redirect, 'Your session has ended. Signing in again…', null, response.status);
    }
    if (redirect === 'INSTALL_REQUIRED') {
      throw new ApiError(redirect, 'This install is not set up yet.', null, response.status);
    }

    const error = body.error || {};
    throw new ApiError(
      error.code || 'SERVER',
      error.message || `Request failed (HTTP ${response.status}).`,
      error.details,
      response.status,
    );
  }

  return body;
}

/** Read action. */
export async function get(action, params = {}) {
  const query = new URLSearchParams({ action, ...params });
  const response = await fetch(`${ENDPOINT}?${query}`, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  return unwrap(response);
}

/** Mutation. `rev` is the revision the client last saw. */
export async function post(action, payload = {}, rev = null) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Trax-Csrf': csrf,
      Accept: 'application/json',
    },
    body: JSON.stringify({ action, rev, csrf, payload }),
  });
  return unwrap(response);
}

/** Multipart upload — cannot use the JSON path. */
export async function upload(action, file, fields = {}) {
  const form = new FormData();
  form.append('action', action);
  form.append('csrf', csrf);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  form.append('photo', file);

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    body: form,
  });
  return unwrap(response);
}

/**
 * Multipart upload of a whole batch.
 *
 * `upload()` posts one file under `photo`; the condition-photo actions take a
 * list under `photos[]` and store it all-or-nothing, so the batch has to go out
 * as one request rather than N sequential ones.
 */
export async function uploadMany(action, files, fields = {}) {
  return uploadBatch(action, 'photos[]', files, fields);
}

/**
 * The same batch upload under a caller-named field.
 *
 * `photos[]` is not a universal name: documents arrive under `documents[]`,
 * and the server reads exactly one $_FILES key per action. uploadMany() above
 * keeps its signature and delegates here, so there is one copy of the form.
 */
export async function uploadBatch(action, field, files, fields = {}) {
  const form = new FormData();
  form.append('action', action);
  form.append('csrf', csrf);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  for (const file of files) {
    form.append(field, file);
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    body: form,
  });
  return unwrap(response);
}
