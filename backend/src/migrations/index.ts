import type { Migration } from "./types";
import initialSchema from "./001_initial_schema";
import dropSessionCache from "./002_drop_session_cache";
import expandMeetings from "./003_expand_meetings";
import addTelemetryLapNumber from "./004_add_telemetry_lap_number";
import addTelemetryOrderIndex from "./005_add_telemetry_order_index";
import expandTelemetryChunks from "./006_expand_telemetry_chunks";

export const migrations: Migration[] = [
  initialSchema,
  dropSessionCache,
  expandMeetings,
  addTelemetryLapNumber,
  addTelemetryOrderIndex,
  expandTelemetryChunks,
];
