package com.aems.agent.api

import retrofit2.http.Body
import retrofit2.http.POST

data class ActivityEventRequest(
    val userId: String,
    val deviceId: String,
    val appName: String,
    val startedAt: String,
    val endedAt: String?,
)

interface AemsApi {
    @POST("activity/events")
    suspend fun logActivityEvent(@Body body: ActivityEventRequest)
}
