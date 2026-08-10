-- What the managed browser extension has told the agent, so the dashboard can say it.
--
-- The gap this closes. On Windows there is no supported way to read a browser's address
-- bar from outside the browser, so the Websites tab for a Windows machine is empty by
-- design — and an empty Websites tab is indistinguishable from an employee who visited
-- no sites all day. Two opposite facts rendering as the same blank list is the failure
-- `docs/design.md` rules out; the agent has known which of the two it is since the
-- extension shipped, and until now it had nowhere to put the answer.
--
-- Why a count and not just a flag. The extension is not bound to anything — whichever
-- browser has it loaded reports, exactly as every other collector on this machine
-- attributes to the enrolled employee without asking which Windows user is at the
-- keyboard. The one question that leaves open is whether it was loaded twice, and a
-- number is the whole answer. All connected browsers are recorded the same way.
--
-- All four are nullable and nothing backfills them. Null means "this device has never
-- said", which is a real answer and a different one from false — an Android phone and an
-- agent older than this column both sit there, and neither is a machine whose extension
-- is missing.

-- Why a fifth column that is not about the extension. A connected extension is not the
-- same fact as a recorded address: withdrawn consent, a revoked device and a
-- switched-off `websites` scope all stop the recording without closing the channel. The
-- dashboard was reading the channel and saying "this list is complete", which is the
-- claim that has to be true. The agent is the process that makes the decision, so it
-- reports it rather than the dashboard rebuilding it out of `consent_records` and
-- `device_collection_settings` and drifting from the binary it describes.

alter table public.devices
  add column browser_extension_linked boolean,
  add column browser_extension_version text,
  add column browser_extension_seen_at timestamptz,
  add column browser_extension_count integer,
  add column website_addresses_recorded boolean;

comment on column public.devices.browser_extension_linked is
  'Whether a managed browser extension has opened a channel to this agent recently (the agent''s own 7-day window). Null means the device has never reported either way — an Android phone, or an agent older than this column. Null and false are different answers and the dashboard says so.';

comment on column public.devices.browser_extension_version is
  'Manifest version of the most recently connected extension, as it last introduced itself.';

comment on column public.devices.browser_extension_seen_at is
  'When an extension last opened the channel on this machine. The agent''s clock, not the browser''s.';

comment on column public.devices.browser_extension_count is
  'How many browsers on this machine have connected in the last day. All of them are recorded identically; the number exists so a duplicate install is visible rather than silent. A shorter window than browser_extension_linked on purpose — on the week-long one, an extension moved from Chrome to Edge reads as two browsers for seven days.';

comment on column public.devices.website_addresses_recorded is
  'The agent''s own answer to whether it is writing website addresses down right now — consent in force, device not revoked, and the websites collection scope on. Distinct from browser_extension_linked, which is only about the channel. Null means the device has never said.';
