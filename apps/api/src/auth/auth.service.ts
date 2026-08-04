import { Injectable, UnauthorizedException } from "@nestjs/common";
import { compare } from "bcryptjs";
import { sign } from "jsonwebtoken";
import { prisma } from "@aems/database";

export interface LoginInput {
  email: string;
  password: string;
}

/** Minimal email/password login issuing a JWT. Route guards & RBAC enforcement are Phase 2. */
@Injectable()
export class AuthService {
  async login({ email, password }: LoginInput) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await compare(password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const secret = process.env.JWT_SECRET ?? "change-me";
    const token = sign({ sub: user.id, orgId: user.orgId, role: user.role }, secret, {
      expiresIn: "12h",
    });

    return { token, user: { id: user.id, email: user.email, role: user.role, orgId: user.orgId } };
  }
}
