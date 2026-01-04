import { index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("replayer", "routes/replayer.tsx"),
  route("garage", "routes/garage.tsx"),
  route("strategy", "routes/strategy.tsx")
];
