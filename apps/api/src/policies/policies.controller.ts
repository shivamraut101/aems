import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { PoliciesService, CreatePolicyInput } from "./policies.service.js";

@Controller("policies")
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get()
  list(@Query("orgId") orgId: string) {
    return this.policies.listByOrg(orgId);
  }

  @Post()
  create(@Body() body: CreatePolicyInput) {
    return this.policies.create(body);
  }
}
