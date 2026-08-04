import { Body, Controller, Post } from "@nestjs/common";
import { AuthService, LoginInput } from "./auth.service.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  login(@Body() body: LoginInput) {
    return this.auth.login(body);
  }
}
