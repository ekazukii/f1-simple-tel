export interface LapSample {
  lap: number;
  duration: number;
  driver: number;
}

export interface StintSegment {
  start: number;
  end: number;
  compound: string;
  driver: number;
}

export interface TimelineRow {
  driver: number;
  stints: StintSegment[];
  sessionDate: string;
}

export interface LapCompoundPoint {
  lap: number;
  duration: number;
  compound: string;
}
