# Finalized Scope — Employee Monitoring & Workforce Analytics Platform (MVP)

> Source document as provided. Locks *what* gets built; `docs/stack.md` locks *how*.
> Anything not listed here is Phase 2, after the client demo.

**Project goal:** an Apploye-style employee monitoring platform for a single
enterprise client — desktop monitoring (Windows + macOS), company Android device
monitoring, a web admin dashboard, and reports with AI insights.

---

## 1. Platform Scope

| Platform | Application         | Purpose                  |
| -------- | ------------------- | ------------------------ |
| Windows  | Desktop Agent       | Employee monitoring      |
| macOS    | Desktop Agent       | Employee monitoring      |
| Android  | Employee Device App | Company phone monitoring |
| Web      | Admin Dashboard     | Management & analytics   |
| Linux    | Not included        |                          |
| iOS      | Not included        |                          |

---

## 2. Desktop Agent (Windows + macOS) — Critical

### 2.1 Employee Authentication

Employee login, device registration, device binding, secure token management,
auto start with system, background operation.

### 2.2 Work Tracking

Work session start, work session end, total tracked time, active time, idle time,
break time.

```
Employee: John
Work Started: 09:05 AM
Total:  8h 20m
Active: 7h 30m
Idle:   50m
```

### 2.3 Screenshot Capture

Automatic screenshots, configurable interval, screenshot timeline, cloud storage
upload.

Interval options: 1 min, 5 min, 10 min, 15 min, 30 min.

Storage: Cloudflare R2 / S3 compatible storage.

### 2.4 Application Tracking

Active application, application name, usage duration.

```
VS Code   4h 30m
Chrome    2h
Slack     45m
Teams     30m
```

### 2.5 Website Tracking

Browser domain, time spent, visit history.

```
github.com          2h
stackoverflow.com   45m
youtube.com         20m
```

### 2.6 Idle Detection

Keyboard inactivity, mouse inactivity. Statuses: Active, Idle, Offline.

### 2.7 Activity Timeline

```
09:00 Login
09:15 Chrome Active
09:40 VS Code Active
10:00 Screenshot
10:30 Idle
10:45 Active Again
```

---

## 3. Android Employee Monitoring App — Critical

For company-owned Android phones: field employees, sales teams, remote workers.

### 3.1 Device Registration

Employee login, device linking, device identity, secure sync.

### 3.2 Mobile App Activity Tracking

Application usage, usage duration, frequently used apps.

```
CRM App    5h
Chrome     1h
WhatsApp   30m
Maps       20m
```

### 3.3 Mobile Device Activity

Device online/offline, screen active time, battery level, network status,
last synchronization.

### 3.4 Android Device Inventory

Device model, Android version, RAM, storage, battery.

### 3.5 Location Tracking (Optional)

Only if required by the client: current location, location history, geofence.

---

## 4. Admin Dashboard (Web) — Critical

### 4.1 Dashboard Overview

Total employees, active employees, working today, average productivity, total hours.

### 4.2 Employee Management

Add employee, remove employee, assign department, assign manager, assign devices,
enable/disable monitoring.

### 4.3 Live Employee Status

```
John   🟢 Active    Windows Laptop
Sarah  🟡 Idle      Android Device
Mike   ⚫ Offline
```

### 4.4 Employee Detail Page

Sections: Overview, Timeline, Screenshots, Applications, Websites, Reports, Devices.

---

## 5. Reports — High

**Employee reports:** total working hours, active hours, idle time, application
usage, website usage, screenshot history.

**Team reports:** employee comparison, productivity trends, working patterns.

**Export:** CSV, PDF.

---

## 6. AI Summary — Medium

Daily employee summary, weekly summary, productivity insights.

```
John worked 8h 15m.
Main activities: software development, documentation, communication.
Productivity: 86%
Idle: 35 minutes
```

---

## 7. Device Inventory — Medium

**Desktop devices:** device name, OS, OS version, CPU, RAM, installed applications,
last heartbeat.

**Android devices:** device model, Android version, battery, storage, network,
last sync.

---

## 8. Security — Later

Not part of MVP: remote control, file monitoring, USB control, software deployment,
MDM features, endpoint protection, SSO, advanced compliance.

---

## Final Priority Matrix

| Feature                       | Priority    |
| ----------------------------- | ----------- |
| Desktop Agent (Windows/macOS) | 🔥 Critical |
| Work Tracking                 | 🔥 Critical |
| Screenshot Capture            | 🔥 Critical |
| Application Tracking          | 🔥 Critical |
| Idle Detection                | 🔥 Critical |
| Timeline                      | 🔥 Critical |
| Admin Dashboard               | 🔥 Critical |
| Android Monitoring App        | 🔥 Critical |
| Reports                       | High        |
| Device Inventory              | Medium      |
| AI Summary                    | Medium      |
| Advanced Security             | Later       |

---

## Final Architecture Direction

```
                 Web Admin Dashboard
                         |
                  API + Auth Layer
                         |
        ---------------------------------
        |                               |
Desktop Monitoring Agent        Android Agent
Windows/macOS                   Company Phones
        |                               |
        ---------------------------------
                         |
                 Activity Engine
                         |
        ---------------------------------
        |
Database + Analytics + AI
        |
Storage (Screenshots)
```

This is the locked MVP scope. Any feature outside this list is Phase 2, after the
client demo and validation.
