export type UserRole = "admin" | "manager" | "employee";

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
}

export interface User {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: UserRole;
  department: string | null;
  createdAt: string;
}
