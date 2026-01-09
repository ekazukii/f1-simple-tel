import GaragePortal from "../../src/pages/GaragePortal";

export const meta = () => [
  { title: "About | F1 Telemetry" },
  {
    name: "description",
    content: "Learn about the F1 telemetry studio, race replay, and Monte Carlo strategy simulator."
  }
];

export default function GaragePortalRoute() {
  return <GaragePortal />;
}
