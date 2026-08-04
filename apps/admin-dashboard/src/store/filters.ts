"use client";

import { create } from "zustand";

/**
 * Client-only view state: what the user is looking at, not what the server knows.
 *
 * Server data belongs to TanStack Query. Mirroring it here would give us two copies
 * that drift.
 */

export type DateRangePreset = "today" | "yesterday" | "7d" | "30d";

interface FilterState {
  range: DateRangePreset;
  department: string | null;
  search: string;
  setRange: (range: DateRangePreset) => void;
  setDepartment: (department: string | null) => void;
  setSearch: (search: string) => void;
}

export const useFilters = create<FilterState>((set) => ({
  range: "today",
  department: null,
  search: "",
  setRange: (range) => set({ range }),
  setDepartment: (department) => set({ department }),
  setSearch: (search) => set({ search }),
}));

/** Turns the active preset into the ISO window the API expects. */
export function resolveRange(preset: DateRangePreset): { from: string; to: string } {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  switch (preset) {
    case "today":
      return { from: startOfToday.toISOString(), to: now.toISOString() };
    case "yesterday": {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 1);
      return { from: start.toISOString(), to: startOfToday.toISOString() };
    }
    case "7d": {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 7);
      return { from: start.toISOString(), to: now.toISOString() };
    }
    case "30d": {
      const start = new Date(startOfToday);
      start.setDate(start.getDate() - 30);
      return { from: start.toISOString(), to: now.toISOString() };
    }
  }
}
