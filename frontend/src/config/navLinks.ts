export type NavLinkItem = {
  id: string;
  label: string;
  to: string;
  end?: boolean;
};

export const navLinks: NavLinkItem[] = [
  { id: "sessions", label: "Session Explorer", to: "/", end: true },
  { id: "replayer", label: "Race Replayer", to: "/replayer" },
  { id: "garage", label: "Garage Portal", to: "/garage" },
  { id: "strategy", label: "Strategy Lab", to: "/strategy" }
];
