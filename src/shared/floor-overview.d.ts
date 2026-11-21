export interface FloorOverviewRow {
  id: string;
  label: string;
  status: string;
}

export interface FloorOverview {
  id: string;
  name: string;
  home: string;
  current: boolean;
  agents: FloorOverviewRow[];
  tasks: FloorOverviewRow[];
}
