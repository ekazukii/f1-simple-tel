import RaceReplayer from "../../src/pages/RaceReplayer";

export const meta = () => [
  { title: "Race Replayer | F1 Telemetry" },
  {
    name: "description",
    content: "Replay races with live positions, telemetry, and incident-aware tracking."
  }
];

export default function RaceReplayerRoute() {
  return <RaceReplayer />;
}
