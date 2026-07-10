/**
 * Fetch JSON with a typed fallback; dashboards should stay usable when optional files are missing.
 */
export async function getJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

/**
 * POST JSON and return both transport success and parsed payload.
 */
export async function postJson<T>(url: string, payload: Record<string, unknown>, fallback: T): Promise<{ ok: boolean; data: T }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => fallback);
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: fallback };
  }
}
