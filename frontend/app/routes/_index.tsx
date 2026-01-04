import SessionExplorer from "../../src/pages/SessionExplorer";

export const meta = () => [
  { title: "Session Explorer | F1 Telemetry" },
  {
    name: "description",
    content: "Explore race sessions with stint timelines, telemetry insights, and driver comparisons."
  }
];

export default function SessionExplorerRoute() {
  return <SessionExplorer />;
}
