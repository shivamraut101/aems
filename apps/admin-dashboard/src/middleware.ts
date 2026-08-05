import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isPublicPath, loginRedirectPath, safeNextPath } from "@/lib/session";

/** See the note in `lib/supabase-server.ts` — the library's union defeats inference. */
type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * The gate in front of every page.
 *
 * Two jobs, and they are not separable: it refreshes the Supabase session cookies
 * (a token lives an hour; without this a tab left open overnight silently loses
 * access), and it redirects anyone without a session to `/login`.
 *
 * This is a UX boundary, not the security one. It decides what renders. The API
 * verifies every token itself and RLS decides what any of it may read — a forged
 * cookie gets someone a sidebar and nothing behind it.
 */
export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // `response` is reassigned by `setAll` below so that rotated cookies survive.
  let response = NextResponse.next({ request });

  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];

  if (!url || !anonKey) {
    // Fail closed. A misconfigured deployment must not serve monitoring data to
    // anyone who asks; /login is public and reports the missing configuration.
    return isPublicPath(pathname) ? response : redirectTo(request, "/login", response);
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet: CookieToSet[]) => {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser(), not getSession(): this round-trips to Supabase Auth, so a revoked or
  // expired session is actually rejected rather than merely looking well-formed.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublicPath(pathname)) {
    return redirectTo(request, loginRedirectPath(pathname, search), response);
  }

  if (user && isPublicPath(pathname)) {
    const next = safeNextPath(request.nextUrl.searchParams.get("next"));
    return redirectTo(request, next, response);
  }

  return response;
}

/**
 * Redirects while carrying over any cookies the refresh just wrote.
 *
 * Dropping them costs the user their rotated session: the redirect lands, the old
 * token is still in the jar, and the next request bounces back to /login.
 */
function redirectTo(request: NextRequest, path: string, carrying: NextResponse): NextResponse {
  const target = new URL(path, request.url);
  const redirect = NextResponse.redirect(target);

  for (const cookie of carrying.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }

  return redirect;
}

export const config = {
  /*
   * Everything except Next's own assets and static files.
   *
   * Matching too widely is not just wasteful — every matched request costs a call
   * to Supabase Auth, and a page of thumbnails would make dozens.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
