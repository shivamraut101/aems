/**
 * The two DOM helpers both pages share.
 *
 * `textContent` throughout, never `innerHTML`. Everything rendered here — a policy
 * name, an administrator's reason for a restriction, a contact address — arrives from
 * outside this extension, and a blocked page that interpreted markup from a policy
 * field would be a cross-site scripting hole on a page shown in response to visiting an
 * arbitrary website.
 */

import type { DetailRow } from "./pages.js";

export function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = value;
}

export function renderRows(container: Element, rows: readonly DetailRow[]): void {
  container.replaceChildren();

  for (const row of rows) {
    const wrapper = document.createElement("div");
    wrapper.className = "row";

    const label = document.createElement("dt");
    label.textContent = row.label;

    const value = document.createElement("dd");
    value.textContent = row.value;

    wrapper.append(label, value);
    container.append(wrapper);
  }
}
