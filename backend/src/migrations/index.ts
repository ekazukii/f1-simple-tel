import type { Migration } from "./types";
import initialSchema from "./001_initial_schema";
import dropSessionCache from "./002_drop_session_cache";
import expandMeetings from "./003_expand_meetings";
import addTelemetryLapNumber from "./004_add_telemetry_lap_number";
import addTelemetryOrderIndex from "./005_add_telemetry_order_index";
import expandTelemetryChunks from "./006_expand_telemetry_chunks";
import expandPitDuration from "./007_expand_pit_duration";
import addSessionStatus from "./008_add_session_status";
import addMeetingNames from "./009_add_meeting_names";
import createTeamRadio from "./010_create_team_radio";
import createWeatherSamples from "./011_create_weather_samples";

export const migrations: Migration[] = [
  initialSchema,
  dropSessionCache,
  expandMeetings,
  addTelemetryLapNumber,
  addTelemetryOrderIndex,
  expandTelemetryChunks,
  expandPitDuration,
  addSessionStatus,
  addMeetingNames,
  createTeamRadio,
  createWeatherSamples,
];
