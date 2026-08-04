import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller.js";
import { AuthModule } from "./auth/auth.module.js";
import { DevicesModule } from "./devices/devices.module.js";
import { ConsentModule } from "./consent/consent.module.js";
import { PoliciesModule } from "./policies/policies.module.js";
import { ActivityModule } from "./activity/activity.module.js";
import { AuditLogModule } from "./audit-log/audit-log.module.js";

@Module({
  imports: [AuthModule, DevicesModule, ConsentModule, PoliciesModule, ActivityModule, AuditLogModule],
  controllers: [HealthController],
})
export class AppModule {}
