import StrategySimulator from "../../src/pages/StrategySimulator";

export const meta = () => [
  { title: "Strategy Lab | F1 Telemetry" },
  {
    name: "description",
    content: "Compare pit strategies, tyre stints, and race outcomes with Monte Carlo simulations."
  }
];

export default function StrategySimulatorRoute() {
  return <StrategySimulator />;
}
