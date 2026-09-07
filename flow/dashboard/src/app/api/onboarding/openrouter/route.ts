import { NextRequest, NextResponse } from "next/server";
import { getSessionToken } from "@/lib/auth";
import { orcFetch } from "@/lib/orchestrator";
import { SESSION_COOKIE } from "@/lib/config";

// POST { key } — validate the OpenRouter key against the live API, then, only if
// it works, save it via the orchestrator settings. The key transits this server
// once at paste time; validating here avoids a round-trip and gives the user an
// instant, honest "it works / it doesn't" before we store anything.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { key } = (await req.json().catch(() => ({}))) as { key?: string };
  if (!key || key.trim().length < 8) {
    return NextResponse.json({ ok: false, error: "That doesn't look like a key." }, { status: 400 });
  }

  // Cheap validation call — list models with the key.
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key.trim()}` },
    });
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({ ok: false, error: "OpenRouter rejected that key. Check it and try again." }, { status: 400 });
    }
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Couldn't verify the key (OpenRouter returned ${res.status}).` }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ ok: false, error: "Couldn't reach OpenRouter to verify the key." }, { status: 502 });
  }

  // Valid → save it. The orchestrator can be briefly unreachable right after
  // `flow up` (services take a few seconds to become healthy); orcFetch throws
  // in that window, so catch it and tell the user to retry instead of 500ing
  // into a generic "couldn't reach the server".
  let save: Response;
  try {
    save = await orcFetch("/v1/settings", token, {
      method: "PUT",
      body: JSON.stringify({ OPENROUTER_API_KEY: key.trim() }),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "The key is valid, but this project is still starting up. Wait a few seconds and try again." },
      { status: 503 }
    );
  }
  // 401 from the orchestrator means this browser's login cookie belongs to a
  // different project (ports are reused across projects, but the cookie is tied
  // to host:port) or the token was rotated. Clear it so the next load bounces
  // to /login, and tell the user exactly what to do.
  if (save.status === 401 || save.status === 403) {
    const res = NextResponse.json(
      {
        ok: false,
        error: "The key is valid, but this browser is logged in to a different project (or the session expired). Sign out, then log in with this project's admin token and try again.",
      },
      { status: 401 }
    );
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }
  if (!save.ok) {
    const detail = await save.text().catch(() => "");
    return NextResponse.json(
      { ok: false, error: `The key is valid, but saving it failed${detail ? `: ${detail}` : "."} Try again in a moment.` },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
