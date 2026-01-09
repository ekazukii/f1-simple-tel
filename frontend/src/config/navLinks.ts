export type NavLinkItem = {
  id: string;
  label: string;
  to: string;
  end?: boolean;
};

export const navLinks: NavLinkItem[] = [
  { id: "sessions", label: "Session Explorer", to: "/", end: true },
  { id: "replayer", label: "Race Replayer", to: "/replayer" },
  { id: "strategy", label: "Strategy Lab", to: "/strategy" },
  { id: "about", label: "About", to: "/garage" }
];
