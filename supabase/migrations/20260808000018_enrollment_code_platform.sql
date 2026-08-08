-- An enrolment code says which kind of machine it is for.
--
-- Migration ...0017 chose a deny list for collection scope specifically BECAUSE a code
-- could not know what would redeem it: `/enroll-with-code` accepts windows, macos and
-- android on one route, so an allow list chosen in a desktop-shaped dialog would have
-- arrived at a phone as "collect only these four". That reasoning was correct and the
-- deny list stays. This fixes the premise instead.
--
-- What it was costing, in the dialog's own words:
--
--     "A machine only ever records what its platform can report — a laptop takes no
--      location, and a phone captures no screenshots or idle time. Ticking those here
--      does not make them happen."
--
-- That paragraph is a UI apologising for offering choices that do nothing. An admin
-- minting a code for a field phone was shown Screenshots and Idle time and allowed to
-- tick both, and neither would ever be collected. Asking which platform first turns
-- seven checkboxes into the three or four that are real.
--
-- Nullable, and that is the compatibility story. Codes minted before this have no
-- platform and keep behaving exactly as they do today: any device may redeem them and
-- nothing is refused. Only codes minted with one are checked at redemption.
--
-- The check at redemption matters beyond tidiness. Scope is chosen against a platform's
-- vocabulary, so a code minted for Android and redeemed by a laptop would apply a phone's
-- deny list to a machine with a different set of capabilities — quietly collecting things
-- the admin believed they had excluded.

alter table public.device_enrollment_codes
  add column platform text
    check (platform is null or platform in ('windows', 'macos', 'android'));

comment on column public.device_enrollment_codes.platform is
  'The kind of machine this code was minted for, which decides the data types the dialog offered. Null on codes minted before ...0018 — those accept any platform, as they always did. When set, redemption by a different platform is refused.';
