import { PageHeader } from "@/components/page-header";

import { SettingsTabs } from "./settings-tabs";

/**
 * The shell both settings routes share.
 *
 * A **server** component: it renders the heading and the tab strip in the first paint,
 * so navigating between the two settings routes never redraws the page furniture. Only
 * `SettingsTabs` is a client component, because it needs the current pathname to mark
 * the active tab.
 *
 * Route access is `NAV` in `lib/session.ts` — `/settings` is super-admin only and
 * `canAccessPath` judges `/settings/restrictions` by the same claim, so the refusal
 * panel covers both and there is no guard here. Each section still checks the role
 * before offering an action, because the screen must not offer what the API's
 * preHandler will refuse.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-7">
      <PageHeader
        title="Settings"
        subtitle="How this company is configured: what agents collect, how activity is classified, which websites are available, and who is being monitored."
      />
      <SettingsTabs />
      {children}
    </div>
  );
}
