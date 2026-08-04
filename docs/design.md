# Design Direction — AI Workforce Intelligence Platform

> Source document as provided. Governs every user-facing surface: dashboard,
> desktop agent UI, Android app.

Based on a review of the employee monitoring SaaS category and enterprise dashboard
patterns rather than generic SaaS UI. The product must serve three user psychology
layers:

1. **Admin / Owner** → wants business visibility
2. **Manager** → wants team performance
3. **Employee** → wants transparency and trust

Products like Apploye, Hubstaff and ActivTrak are not built like normal dashboards;
they are closer to **analytics + observability platforms**, combining activity
streams, timelines, screenshots, reports and workforce intelligence. ([Apploye][1])

---

## Product Positioning

Do **not** position it as:

> "Employee Surveillance System"

The design language must communicate:

> **AI Workforce Intelligence Platform**

Modern tools in this category are moving toward productivity insights rather than
raw tracking — ActivTrak, for example, leads with activity dashboards and
productivity analytics. ([ActivTrak Help Center][2])

---

## Design Inspiration

**Datadog / Grafana** — the data shape matches ours: events, activity streams,
real-time status, analytics.
Take: dense information, filters, timeline visualisation, alert system.
Avoid: too many colourful charts.

**Linear** — clean typography, keyboard-first interactions, minimal cards,
professional feel.

**Stripe Dashboard** — enterprise trust, excellent spacing, clear hierarchy.

**Apploye / Hubstaff** — organise around employee activity, screenshots, app usage,
URLs and productivity reports rather than cramming everything into one
dashboard. ([Apploye][3])

---

## Navigation

No huge sidebar. Minimal:

```
Company Logo

Overview
People
Activity
Devices
Reports
AI Insights
Settings
```

---

## Dashboard Home

The first screen answers: *"How is my company doing today?"*

```
Good Morning, Admin
Tuesday, Aug 4

[ Employees ] [ Active Now ] [ Hours ] [ Productivity ]

Live Workforce
John    🟢 Active    VS Code
Sarah   🟡 Idle      Chrome
Mike    ⚫ Offline   Last seen 2h ago

Activity Intelligence
App Usage        Productivity Trend

AI Summary
"Your engineering team was highly productive today..."
```

### Do not make cards everywhere

Most SaaS dashboards fail because every metric becomes a card. Instead:

- **Cards** for KPIs
- **Tables** for operations
- **Timeline** for history
- **Charts** for trends

Dashboard research emphasises arranging views around user decisions, not around
every available metric. ([arXiv][4])

---

## Employee Page

Where managers spend most of their time.

```
Avatar
John Smith
Software Engineer

🟢 Active
Windows Device
Last Sync: 12 seconds ago
```

Tabs: Overview, Timeline, Screenshots, Apps, Websites, Reports, Device.

### Overview Tab

```
Today
Work Time     8h 20m
Active        7h 40m
Idle          40m
Productivity  86%
```

---

## Timeline Design

This should be the strongest UX in the product — think GitHub activity feed crossed
with Datadog logs.

```
09:00   🟢 Started Work
09:12   Chrome — github.com
10:20   VS Code — Project Alpha
11:30   📸 Screenshot
12:10   🟡 Idle
```

---

## Screenshot Experience

Not a plain gallery. Pair each screenshot with the activity it belongs to:

```
10:00 AM
Activity:   VS Code, 45 minutes
Screenshot: [ image preview ]

10:15 AM
Chrome — stackoverflow.com
[ image preview ]
```

This connects evidence with activity. Apploye likewise ties screenshot review to
employee activity, time periods and filters rather than treating screenshots as
isolated images. ([Apploye][3])

---

## Activity Analytics

**Replace the raw "Productivity Score."** A bare percentage feels invasive. Prefer
descriptive work patterns:

```
Work Pattern
Focused Time    7h 20m
Collaboration   1h
Idle            40m
```

---

## AI Insights

A premium feature, not a text box.

```
✨ AI Workforce Insight

Engineering team spent:
62% Development
21% Communication
17% Research

Observation:
"Team productivity increased 12% compared to last week"

Recommendation:
"Consider reducing meeting blocks between 2-4 PM"
```

---

## Device Inventory

Should feel like an IT product — reference Datadog infrastructure pages.

```
John Laptop
OS:             Windows 11
CPU:            Intel i7
RAM:            16GB
Status:         Online
Last heartbeat: 20 seconds ago
Apps:           VS Code, Chrome, Docker
```

---

## Android App

Must not read as "you are being watched." It is a **Company Work Companion**.

```
Good Morning John

Today's Work    06h 32m
Status          🟢 Working
Device Sync     Connected
Company Policy  Active
```

---

## Desktop Agent

Very minimal, system tray.

```
Company Monitor
Status:       🟢 Connected
Today's Time: 7h 12m
Last Sync:    10 seconds ago
```

---

## Color System

| Role       | Colour  | Hex       | Meaning |
| ---------- | ------- | --------- | ------- |
| Primary    | Navy    | `#0F172A` | Trust   |
| Accent     | Indigo  | `#6366F1` | AI      |
| Success    | Emerald | `#10B981` |         |
| Warning    | Amber   | `#F59E0B` |         |
| Background | Light   | `#F8FAFC` |         |
| Background | Dark    | `#020617` |         |

Avoid bright-blue SaaS styling.

---

## Typography

**Inter.** Weights: 600 headings, 400 body, 500 labels.

---

## Component Style

**Avoid:** huge rounded cards, glassmorphism, gradients everywhere, too many
animations.

**Use:** 8px radius, thin borders, dense tables, subtle hover, clear hierarchy.

---

## Final Design System

| Area          | Decision                  |
| ------------- | ------------------------- |
| Style         | Enterprise Analytics      |
| Inspiration   | Datadog + Linear + Stripe |
| Monitoring UI | Observability style       |
| Dashboard     | Dense analytics           |
| Navigation    | Minimal sidebar           |
| Font          | Inter                     |
| UI            | shadcn/ui                 |
| Icons         | Lucide                    |
| Theme         | Light/Dark                |
| Charts        | Recharts                  |
| Tables        | TanStack Table            |
| Timeline      | Custom event timeline     |
| AI Section    | Premium insight cards     |

---

## Recommendation

The killer design feature is the **Timeline + AI Insight experience**, not the
dashboard cards. The winning flow:

```
Admin opens dashboard
  ↓ sees workforce health
  ↓ clicks employee
  ↓ understands the complete day through the timeline
  ↓ AI explains patterns
  ↓ manager takes action
```

That is the difference between a basic monitoring tool and a premium workforce
intelligence platform.

[1]: https://apploye.com/employee-monitoring-software "Employee Monitoring Software to Detect Suspicious Activity"
[2]: https://support.activtrak.com/hc/en-us/articles/360032479552-Activity-Dashboard "Activity Dashboard – ActivTrak Help Center"
[3]: https://apploye.com/help/employee-activity-tracking-overview-screenshots-apps-urls/ "Activity Tracking Overview (Screenshots, APPs, URLs)"
[4]: https://arxiv.org/abs/2205.00757 "Dashboard Design Patterns"
