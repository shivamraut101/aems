import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { AuditLogService, RecordAuditEntryInput } from "./audit-log.service.js";

@Controller("audit-log")
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  list(@Query("orgId") orgId: string) {
    return this.auditLog.listByOrg(orgId);
  }

  @Post()
  record(@Body() body: RecordAuditEntryInput) {
    return this.auditLog.record(body);
  }
}
