import GaragePortal from "../../src/pages/GaragePortal";

export const meta = () => [
  { title: "Garage Portal | F1 Telemetry" },
  {
    name: "description",
    content: "Analyze driver and team performance with telemetry overlays and comparisons."
  }
];

export default function GaragePortalRoute() {
  return <GaragePortal />;
}
